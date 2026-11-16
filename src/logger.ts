import * as fs from 'fs';
import * as path from 'path';

// Runtime-created logs, SQLite files and caches must not inherit permissive
// host defaults. This is process-wide and runs before the database module is
// evaluated during normal bootstrap.
process.umask(0o077);

export enum LogLevel {
  ERROR = 'ERROR',
  WARN = 'WARN',
  INFO = 'INFO',
  DEBUG = 'DEBUG',
}

export interface LogEntry {
  timestamp: string;
  level: LogLevel;
  component: string;
  message: string;
  data?: unknown;
}

export interface LoggerOptions {
  logDir?: string;
  logLevel?: LogLevel | string;
  maxBytes?: number;
  retentionDays?: number;
  stdout?: boolean;
  now?: () => number;
}

const LEVEL_WEIGHT: Record<LogLevel, number> = {
  [LogLevel.DEBUG]: 10,
  [LogLevel.INFO]: 20,
  [LogLevel.WARN]: 30,
  [LogLevel.ERROR]: 40,
};

const MAX_STRING_LENGTH = 256;
const MAX_ARRAY_LENGTH = 20;
const MAX_DATA_DEPTH = 5;
const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;
const DEFAULT_RETENTION_DAYS = 14;
const RETENTION_CHECK_INTERVAL_MS = 60 * 60 * 1000;

function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, '');
}

const BLOCKED_DATA_KEYS = new Set([
  'userid',
  'staffid',
  'chatid',
  'telegramid',
  'username',
  'text',
  'usertext',
  'question',
  'answer',
  'content',
  'prompt',
  'messages',
  'history',
  'query',
  'input',
  'args',
  'arguments',
  'toolargs',
  'toolarguments',
  'toolresult',
  'headers',
  'authorization',
  'apikey',
  'secret',
  'accesstoken',
]);

// Log call sites may only emit operational metadata from this list. Unknown
// future fields are dropped, which prevents a new provider payload from being
// logged accidentally.
const ALLOWED_DATA_KEYS = new Set([
  'accepteddocuments',
  'action',
  'aienabled',
  'aiexists',
  'answerid',
  'answermode',
  'attemptedmodels',
  'category',
  'changes',
  'circuitstate',
  'completed',
  'completiontokens',
  'confidence',
  'confidencethreshold',
  'configexists',
  'count',
  'created',
  'dailyrequests',
  'dailytokens',
  'denserank',
  'densescore',
  'documents',
  'documentcount',
  'errorreason',
  'errortype',
  'estimatedprompttokens',
  'fallback',
  'feedback',
  'filetype',
  'found',
  'handled',
  'hascontext',
  'hybridscore',
  'historymessages',
  'includeddocuments',
  'includedhistorymessages',
  'isfallback',
  'latencyms',
  'lexicalrank',
  'lexicalscore',
  'llmfailurereason',
  'mode',
  'model',
  'openuntil',
  'outcome',
  'phase',
  'prompttokens',
  'provider',
  'providerattemptcount',
  'ragstatus',
  'reason',
  'responselength',
  'resultcount',
  'retrievalscore',
  'returnedpoints',
  'route',
  'runid',
  'sourceid',
  'sourcecount',
  'status',
  'statuscode',
  'ticketid',
  'tool',
  'toolname',
  'toolruncount',
  'topcandidates',
  'totaltokens',
  'vectorlength',
  'warnings',
]);

function redactSecrets(value: string): string {
  return value
    .replace(/Bearer\s+[^\s,;]+/gi, 'Bearer [REDACTED]')
    .replace(
      /\b(api[_ -]?key|key|authorization|secret|access[_ -]?token)\s*[:=]\s*[^\s,;]+/gi,
      '$1=[REDACTED]',
    );
}

function safeString(value: string): string {
  return redactSecrets(value)
    .replace(/[\r\n\t]+/g, ' ')
    .slice(0, MAX_STRING_LENGTH);
}

function sanitizeValue(
  value: unknown,
  depth: number,
  seen: WeakSet<object>,
  contextKey = '',
): unknown {
  if (value == null || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : String(value);
  }
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'string') return safeString(value);
  if (typeof value !== 'object' || depth >= MAX_DATA_DEPTH) return undefined;
  if (value instanceof Date) return value.toISOString();
  if (seen.has(value)) return '[Circular]';
  seen.add(value);

  if (Array.isArray(value)) {
    return value.slice(0, MAX_ARRAY_LENGTH)
      .map(item => {
        if (typeof item === 'string' && contextKey !== 'attemptedmodels') {
          return undefined;
        }
        return sanitizeValue(item, depth + 1, seen);
      })
      .filter(item => item !== undefined);
  }

  const sanitized: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    const normalized = normalizeKey(key);
    if (
      BLOCKED_DATA_KEYS.has(normalized) ||
      !ALLOWED_DATA_KEYS.has(normalized)
    ) continue;
    try {
      const safeValue = sanitizeValue(item, depth + 1, seen, normalized);
      if (safeValue !== undefined) sanitized[key] = safeValue;
    } catch (_error) {
      // A getter/proxy must never break logging or expose its exception text.
    }
  }
  return sanitized;
}

export function sanitizeLogData(data: unknown): unknown {
  if (
    data == null ||
    typeof data !== 'object' ||
    Array.isArray(data) ||
    data instanceof Date
  ) return undefined;
  try {
    return sanitizeValue(data, 0, new WeakSet<object>());
  } catch (_error) {
    return undefined;
  }
}

function parseLogLevel(value: string | undefined): LogLevel {
  const normalized = String(value || LogLevel.INFO).toUpperCase();
  return Object.values(LogLevel).includes(normalized as LogLevel) ?
    normalized as LogLevel : LogLevel.INFO;
}

export class Logger {
  private readonly logDir: string;
  private readonly logFile: string;
  private readonly level: LogLevel;
  private readonly maxBytes: number;
  private readonly retentionDays: number;
  private readonly writeStdout: boolean;
  private readonly now: () => number;
  private lastRetentionCheckAt = 0;

  constructor(options: LoggerOptions = {}) {
    this.logDir = options.logDir ||
      process.env.LOG_DIR || path.join(__dirname, '..', 'logs');
    this.logFile = path.join(this.logDir, 'ai.log');
    const configuredLevel = options.logLevel == null ?
      process.env.LOG_LEVEL : String(options.logLevel);
    this.level = parseLogLevel(configuredLevel);
    this.maxBytes = Math.max(1024, options.maxBytes || DEFAULT_MAX_BYTES);
    this.retentionDays = Math.max(
      1,
      options.retentionDays || DEFAULT_RETENTION_DAYS,
    );
    this.writeStdout = options.stdout !== false;
    this.now = options.now || Date.now;

    try {
      fs.mkdirSync(this.logDir, {recursive: true, mode: 0o700});
      this.rotateLegacyIfNeeded();
      this.performMaintenance(true);
    } catch (_error) {
      console.error(JSON.stringify({
        timestamp: new Date(this.now()).toISOString(),
        level: LogLevel.ERROR,
        component: 'logger',
        message: 'Logger file initialization failed',
      }));
    }
  }

  private isEnabled(level: LogLevel): boolean {
    return LEVEL_WEIGHT[level] >= LEVEL_WEIGHT[this.level];
  }

  private rotatedFileName(): string {
    const timestamp = new Date(this.now()).toISOString().replace(/[:.]/g, '-');
    let candidate = path.join(this.logDir, `ai.${timestamp}.log`);
    let suffix = 1;
    while (fs.existsSync(candidate)) {
      candidate = path.join(this.logDir, `ai.${timestamp}.${suffix}.log`);
      suffix++;
    }
    return candidate;
  }

  private rotateIfNeeded(): void {
    if (!fs.existsSync(this.logFile)) return;
    const stat = fs.statSync(this.logFile);
    const maximumAge = this.retentionDays * 24 * 60 * 60 * 1000;
    if (
      stat.size >= this.maxBytes ||
      (stat.size > 0 && stat.mtimeMs < this.now() - maximumAge)
    ) {
      fs.renameSync(this.logFile, this.rotatedFileName());
    }
  }

  private rotateLegacyIfNeeded(): void {
    if (!fs.existsSync(this.logFile)) return;
    const firstLine = fs.readFileSync(this.logFile, 'utf8')
      .split('\n', 1)[0]
      .trim();
    if (!firstLine || firstLine.startsWith('{')) return;
    fs.renameSync(this.logFile, this.rotatedFileName());
  }

  private removeExpiredFiles(): void {
    const cutoff = this.now() - this.retentionDays * 24 * 60 * 60 * 1000;
    for (const fileName of fs.readdirSync(this.logDir)) {
      if (!/^ai\..+\.log$/.test(fileName)) continue;
      const filePath = path.join(this.logDir, fileName);
      try {
        if (fs.statSync(filePath).mtimeMs < cutoff) fs.unlinkSync(filePath);
      } catch (_error) {
        // Rotation/retention is best effort; logging must remain available.
      }
    }
  }

  private performMaintenance(forceRetention = false): void {
    this.rotateIfNeeded();
    const current = this.now();
    if (
      forceRetention ||
      current - this.lastRetentionCheckAt >= RETENTION_CHECK_INTERVAL_MS
    ) {
      this.removeExpiredFiles();
      this.lastRetentionCheckAt = current;
    }
  }

  private formatLog(entry: LogEntry): string {
    return JSON.stringify(entry);
  }

  private log(
    level: LogLevel,
    component: string,
    message: string,
    data?: unknown,
  ): void {
    if (!this.isEnabled(level)) return;
    const safeData = sanitizeLogData(data);
    const entry: LogEntry = {
      timestamp: new Date(this.now()).toISOString(),
      level,
      component: safeString(component).replace(/[^A-Za-z0-9._-]/g, '_'),
      message: safeString(message),
      ...(safeData && Object.keys(safeData as object).length > 0 ?
        {data: safeData} : {}),
    };
    const formatted = this.formatLog(entry);

    try {
      this.performMaintenance();
      fs.appendFileSync(this.logFile, formatted + '\n', {encoding: 'utf8'});
    } catch (_error) {
      console.error(JSON.stringify({
        timestamp: new Date(this.now()).toISOString(),
        level: LogLevel.ERROR,
        component: 'logger',
        message: 'Logger file write failed',
      }));
    }

    if (this.writeStdout) console.log(formatted);
  }

  error(component: string, message: string, data?: unknown): void {
    this.log(LogLevel.ERROR, component, message, data);
  }

  warn(component: string, message: string, data?: unknown): void {
    this.log(LogLevel.WARN, component, message, data);
  }

  info(component: string, message: string, data?: unknown): void {
    this.log(LogLevel.INFO, component, message, data);
  }

  debug(component: string, message: string, data?: unknown): void {
    this.log(LogLevel.DEBUG, component, message, data);
  }

  getLastLines(count: number = 50): string[] {
    try {
      if (!fs.existsSync(this.logFile)) return [];
      const requested = Number.isFinite(count) ?
        Math.max(0, Math.floor(count)) : 50;
      if (requested === 0) return [];
      const content = fs.readFileSync(this.logFile, 'utf8');
      const lines = content.split('\n').filter(line => line.trim());
      return lines.slice(-requested);
    } catch (_error) {
      return [];
    }
  }

  getErrors(count: number = 50): string[] {
    const requested = Number.isFinite(count) ?
      Math.max(0, Math.floor(count)) : 50;
    if (requested === 0) return [];
    return this.getLastLines(requested * 4)
      .filter(line => {
        try {
          return JSON.parse(line).level === LogLevel.ERROR;
        } catch (_error) {
          return line.includes('[ERROR]');
        }
      })
      .slice(-requested);
  }
}

export const logger = new Logger();
