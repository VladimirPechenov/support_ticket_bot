import {logger} from './logger';

const Database = require('better-sqlite3');
const dbPath = process.env.DB_PATH || './config/support.db';
const db = new Database(dbPath);

db.pragma('journal_mode = WAL');
db.pragma('synchronous = FULL');
db.pragma('foreign_keys = ON');

export type TicketStage =
  'ai_active' | 'waiting_operator' | 'in_progress' | 'resolved';

export interface TicketEventInput {
  eventType: string;
  actorType?: 'user' | 'ai' | 'staff' | 'system';
  answerId?: string;
  answerMode?: 'llm' | 'direct_rag';
  sourceId?: string;
  denseScore?: number;
  lexicalScore?: number;
  hybridScore?: number;
  denseRank?: number;
  lexicalRank?: number;
  model?: string;
  reason?: string;
  errorReason?: string;
  latencyMs?: number;
  createdAt?: number;
}

export interface TicketStateUpdate {
  status?: 'open' | 'closed';
  stage?: TicketStage;
  aiEnabled?: boolean;
  handoffReason?: string | null;
  assigneeId?: string | number | null;
  assigneeName?: string | null;
  lastActivityAt?: number;
  closedAt?: number | null;
}

export type AiRuntimeMode = 'off' | 'rag_only' | 'full';
export type AiRunStatus =
  'running' | 'answered' | 'direct_rag' | 'handed_off' | 'cancelled' | 'failed';
export type AiRunRoute =
  'none' | 'primary' | 'fallback' | 'direct_rag' | 'handoff';
export type AiRagStatus = 'not_run' | 'hit' | 'miss' | 'unavailable';
export type AttemptOutcome = 'success' | 'failure' | 'cancelled' | 'skipped';
export type ProviderCircuitState = 'closed' | 'open' | 'half_open';

export interface AiRunStartInput {
  runId: string;
  /** Internal support-ticket primary key; never a Telegram user/chat ID. */
  ticketId?: string | number;
  mode: AiRuntimeMode;
  startedAt?: number;
}

export interface AiRunFinishInput {
  status: Exclude<AiRunStatus, 'running'>;
  route: AiRunRoute;
  ragStatus?: AiRagStatus;
  sourceCount?: number;
  failureReason?: string;
  latencyMs?: number;
  completedAt?: number;
}

export interface ProviderAttemptInput {
  runId: string;
  provider: string;
  model: string;
  phase?: 'plan' | 'answer' | 'embedding' | 'validation';
  outcome: AttemptOutcome;
  isFallback?: boolean;
  errorReason?: string;
  statusCode?: number;
  latencyMs?: number;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  createdAt?: number;
}

export interface ToolRunInput {
  runId: string;
  toolName: string;
  outcome: AttemptOutcome;
  resultCount?: number;
  errorReason?: string;
  latencyMs?: number;
  createdAt?: number;
}

export interface AiProviderStateInput {
  provider: string;
  circuitState: ProviderCircuitState;
  consecutiveFailures?: number;
  openUntil?: number | null;
  quotaDate?: string | null;
  dailyRequests?: number;
  dailyTokens?: number;
  lastErrorReason?: string | null;
  updatedAt?: number;
}

export interface RuntimeFeatureFlags {
  aiMode: AiRuntimeMode;
  aiRolloutPercent: number;
  webToolRolloutPercent: number;
}

export interface AiConversationMessage {
  role: 'user' | 'assistant';
  content: string;
  createdAt: number;
}

export interface AiProviderStateRecord {
  provider: string;
  circuitState: ProviderCircuitState;
  consecutiveFailures: number;
  openUntil: number | null;
  quotaDate: string | null;
  dailyRequests: number;
  dailyTokens: number;
  lastErrorReason: string | null;
  updatedAt: number;
}

export interface AiRunDiagnostics {
  answerRejections: Array<{
    reason: string;
    content: string;
    sourceIds: string[];
    details: {unsupportedFacts?: string[]; unsupportedClauses?: string[]};
    createdAt: number;
  }>;
  run: {
    runId: string;
    ticketId: string | null;
    mode: AiRuntimeMode;
    status: AiRunStatus;
    route: AiRunRoute;
    ragStatus: AiRagStatus;
    sourceCount: number;
    providerAttemptCount: number;
    toolRunCount: number;
    failureReason: string | null;
    latencyMs: number | null;
    startedAt: number;
    completedAt: number | null;
  };
  providerAttempts: Array<{
    provider: string;
    model: string;
    phase: 'plan' | 'answer' | 'embedding' | 'validation';
    outcome: AttemptOutcome;
    isFallback: boolean;
    errorReason: string | null;
    statusCode: number | null;
    latencyMs: number | null;
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    createdAt: number;
  }>;
  toolRuns: Array<{
    toolName: string;
    outcome: AttemptOutcome;
    resultCount: number;
    errorReason: string | null;
    latencyMs: number | null;
    createdAt: number;
  }>;
}

export interface AnswerRejectionInput {
  runId: string;
  reason: string;
  content: string;
  sourceIds: string[];
  details?: {unsupportedFacts?: string[]; unsupportedClauses?: string[]};
  createdAt?: number;
}

export interface AiSloSnapshot {
  llmRuns: number;
  successfulRuns: number;
  fallbackRuns: number;
  latencyP95Ms: number;
}

export type RuntimeFeatureFlagKey =
  'ai_mode' | 'ai_rollout_percent' | 'web_tool_rollout_percent';

export type RuntimeFeatureFlagValue<K extends RuntimeFeatureFlagKey> =
  K extends 'ai_mode' ? AiRuntimeMode : number;

const now = () => Date.now();

function ensureColumn(name: string, definition: string): void {
  const columns = db.prepare('PRAGMA table_info(supportees)').all();
  if (!columns.some((column: any) => column.name === name)) {
    db.prepare(`ALTER TABLE supportees ADD COLUMN ${name} ${definition}`).run();
  }
}

function ensureAiRunColumn(name: string, definition: string): void {
  const columns = db.prepare('PRAGMA table_info(ai_runs)').all();
  if (!columns.some((column: any) => column.name === name)) {
    db.prepare(`ALTER TABLE ai_runs ADD COLUMN ${name} ${definition}`).run();
  }
}

function migrate(): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS supportees (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      userid TEXT,
      status TEXT,
      category TEXT
    );
  `);

  ensureColumn('created_at', 'INTEGER');
  ensureColumn('last_activity_at', 'INTEGER');
  ensureColumn('closed_at', 'INTEGER');
  ensureColumn('stage', "TEXT DEFAULT 'ai_active'");
  ensureColumn('ai_enabled', 'INTEGER DEFAULT 1');
  ensureColumn('handoff_reason', 'TEXT');
  ensureColumn('assignee_id', 'TEXT');
  ensureColumn('assignee_name', 'TEXT');
  ensureColumn('user_name', 'TEXT');
  ensureColumn('user_username', 'TEXT');

  db.exec(`
    CREATE TABLE IF NOT EXISTS ticket_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ticket_id INTEGER NOT NULL,
      event_type TEXT NOT NULL,
      actor_type TEXT NOT NULL DEFAULT 'system',
      answer_id TEXT,
      answer_mode TEXT,
      source_id TEXT,
      dense_score REAL,
      lexical_score REAL,
      hybrid_score REAL,
      dense_rank INTEGER,
      lexical_rank INTEGER,
      model TEXT,
      reason TEXT,
      error_reason TEXT,
      latency_ms INTEGER,
      created_at INTEGER NOT NULL,
      FOREIGN KEY(ticket_id) REFERENCES supportees(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_ticket_events_ticket_created
      ON ticket_events(ticket_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_ticket_events_type_created
      ON ticket_events(event_type, created_at);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_feedback_once_per_answer
      ON ticket_events(ticket_id, answer_id)
      WHERE answer_id IS NOT NULL AND event_type IN (
        'feedback_helpful', 'feedback_operator', 'feedback_not_helpful'
      );

    CREATE TABLE IF NOT EXISTS telegram_message_map (
      chat_id TEXT NOT NULL,
      message_id INTEGER NOT NULL,
      ticket_id INTEGER NOT NULL,
      kind TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY(chat_id, message_id),
      FOREIGN KEY(ticket_id) REFERENCES supportees(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_telegram_message_ticket
      ON telegram_message_map(ticket_id);

    CREATE TABLE IF NOT EXISTS blocked_users (
      userid TEXT PRIMARY KEY,
      blocked_at INTEGER NOT NULL,
      blocked_by TEXT
    );

    CREATE TABLE IF NOT EXISTS daily_support_metrics (
      metric_date TEXT NOT NULL,
      metric_key TEXT NOT NULL,
      metric_value INTEGER NOT NULL,
      PRIMARY KEY(metric_date, metric_key)
    );

    CREATE TABLE IF NOT EXISTS ai_runs (
      run_id TEXT PRIMARY KEY,
      ticket_id TEXT,
      mode TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'running',
      route TEXT NOT NULL DEFAULT 'none',
      rag_status TEXT NOT NULL DEFAULT 'not_run',
      source_count INTEGER NOT NULL DEFAULT 0,
      provider_attempt_count INTEGER NOT NULL DEFAULT 0,
      tool_run_count INTEGER NOT NULL DEFAULT 0,
      failure_reason TEXT,
      latency_ms INTEGER,
      started_at INTEGER NOT NULL,
      completed_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_ai_runs_started
      ON ai_runs(started_at);
    CREATE INDEX IF NOT EXISTS idx_ai_runs_status_started
      ON ai_runs(status, started_at);

    CREATE TABLE IF NOT EXISTS provider_attempts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT NOT NULL,
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      phase TEXT NOT NULL DEFAULT 'answer',
      outcome TEXT NOT NULL,
      is_fallback INTEGER NOT NULL DEFAULT 0,
      error_reason TEXT,
      status_code INTEGER,
      latency_ms INTEGER,
      prompt_tokens INTEGER NOT NULL DEFAULT 0,
      completion_tokens INTEGER NOT NULL DEFAULT 0,
      total_tokens INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      FOREIGN KEY(run_id) REFERENCES ai_runs(run_id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_provider_attempts_run
      ON provider_attempts(run_id, id);
    CREATE INDEX IF NOT EXISTS idx_provider_attempts_created
      ON provider_attempts(created_at);

    CREATE TABLE IF NOT EXISTS tool_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT NOT NULL,
      tool_name TEXT NOT NULL,
      outcome TEXT NOT NULL,
      result_count INTEGER NOT NULL DEFAULT 0,
      error_reason TEXT,
      latency_ms INTEGER,
      created_at INTEGER NOT NULL,
      FOREIGN KEY(run_id) REFERENCES ai_runs(run_id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_tool_runs_run
      ON tool_runs(run_id, id);
    CREATE INDEX IF NOT EXISTS idx_tool_runs_created
      ON tool_runs(created_at);

    CREATE TABLE IF NOT EXISTS answer_rejections (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT NOT NULL,
      reason TEXT NOT NULL,
      content TEXT NOT NULL,
      source_ids TEXT NOT NULL,
      details TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      FOREIGN KEY(run_id) REFERENCES ai_runs(run_id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_answer_rejections_run
      ON answer_rejections(run_id, id);
    CREATE INDEX IF NOT EXISTS idx_answer_rejections_created
      ON answer_rejections(created_at);

    CREATE TABLE IF NOT EXISTS ai_provider_state (
      provider TEXT PRIMARY KEY,
      circuit_state TEXT NOT NULL DEFAULT 'closed',
      consecutive_failures INTEGER NOT NULL DEFAULT 0,
      open_until INTEGER,
      quota_date TEXT,
      daily_requests INTEGER NOT NULL DEFAULT 0,
      daily_tokens INTEGER NOT NULL DEFAULT 0,
      last_error_reason TEXT,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS runtime_feature_flags (
      flag_key TEXT PRIMARY KEY,
      flag_value TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS ai_conversation_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ticket_id INTEGER NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('user', 'assistant')),
      content TEXT NOT NULL,
      dedupe_key TEXT,
      created_at INTEGER NOT NULL,
      FOREIGN KEY(ticket_id) REFERENCES supportees(id) ON DELETE CASCADE,
      UNIQUE(ticket_id, dedupe_key)
    );
    CREATE INDEX IF NOT EXISTS idx_ai_conversation_ticket_created
      ON ai_conversation_messages(ticket_id, created_at, id);
    CREATE INDEX IF NOT EXISTS idx_ai_conversation_created
      ON ai_conversation_messages(created_at);
  `);

  // Additive migration for installations created before per-ticket AI
  // diagnostics were persisted. ticket_id is an internal ticket key only.
  ensureAiRunColumn('ticket_id', 'TEXT');
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_ai_runs_ticket_started
      ON ai_runs(ticket_id, started_at DESC);
  `);

  const defaultsCreatedAt = now();
  const insertDefaultFlag = db.prepare(
    `INSERT OR IGNORE INTO runtime_feature_flags(
      flag_key, flag_value, updated_at
    ) VALUES (?, ?, ?)`,
  );
  insertDefaultFlag.run('ai_mode', 'off', defaultsCreatedAt);
  insertDefaultFlag.run('ai_rollout_percent', '0', defaultsCreatedAt);
  insertDefaultFlag.run('web_tool_rollout_percent', '0', defaultsCreatedAt);

  const migrationTime = now();
  db.prepare(`UPDATE supportees SET created_at = ? WHERE created_at IS NULL`)
    .run(migrationTime);
  db.prepare(
    `UPDATE supportees SET last_activity_at = created_at
     WHERE last_activity_at IS NULL`,
  ).run();
  db.prepare(
    `UPDATE supportees SET closed_at = ?, stage = 'resolved', ai_enabled = 0
     WHERE status = 'closed' AND closed_at IS NULL`,
  ).run(migrationTime);
  db.prepare(
    `UPDATE supportees SET stage = 'ai_active'
     WHERE status = 'open' AND (stage IS NULL OR stage = 'resolved')`,
  ).run();
  db.prepare(
    `INSERT OR IGNORE INTO blocked_users(userid, blocked_at)
     SELECT userid, ? FROM supportees WHERE status = 'banned'`,
  ).run(migrationTime);
  db.prepare(
    `UPDATE supportees SET status = 'closed', stage = 'resolved',
      ai_enabled = 0, closed_at = ?, last_activity_at = ?
     WHERE status = 'banned'`,
  ).run(migrationTime, migrationTime);

  db.exec('DROP INDEX IF EXISTS idx_one_open_ticket');
  db.prepare(
    `UPDATE supportees SET status = 'closed', stage = 'resolved',
      ai_enabled = 0, closed_at = ?, last_activity_at = ?
     WHERE status = 'open' AND id NOT IN (
       SELECT MAX(id) FROM supportees WHERE status = 'open' GROUP BY userid
     )`,
  ).run(migrationTime, migrationTime);
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_one_open_ticket_per_user
      ON supportees(userid) WHERE status = 'open';
  `);
}

function appendAiConversationMessage(
  ticketId: string | number,
  role: 'user' | 'assistant',
  content: string,
  dedupeKey?: string,
  createdAt: number = now(),
): boolean {
  const normalized = String(content || '').trim();
  if (!normalized) return false;
  const result = db.prepare(
    `INSERT OR IGNORE INTO ai_conversation_messages(
       ticket_id, role, content, dedupe_key, created_at
     ) VALUES (?, ?, ?, ?, ?)`,
  ).run(
    Number(ticketId),
    role,
    normalized.slice(0, 12000),
    dedupeKey || null,
    createdAt,
  );
  return result.changes > 0;
}

function getAiConversationHistory(
  ticketId: string | number,
  limit = 12,
): AiConversationMessage[] {
  const safeLimit = Math.max(1, Math.min(40, Math.floor(limit)));
  const rows = db.prepare(
    `SELECT role, content, created_at
     FROM (
       SELECT id, role, content, created_at
       FROM ai_conversation_messages
       WHERE ticket_id = ?
       ORDER BY created_at DESC, id DESC
       LIMIT ?
     )
     ORDER BY created_at ASC, id ASC`,
  ).all(Number(ticketId), safeLimit);
  return rows.map((row: any) => ({
    role: row.role,
    content: row.content,
    createdAt: row.created_at,
  }));
}

function trimAiConversationHistory(
  ticketId: string | number,
  keepMessages = 16,
): number {
  const safeKeep = Math.max(2, Math.min(40, Math.floor(keepMessages)));
  return db.prepare(
    `DELETE FROM ai_conversation_messages
     WHERE ticket_id = ? AND id NOT IN (
       SELECT id FROM ai_conversation_messages
       WHERE ticket_id = ?
       ORDER BY created_at DESC, id DESC
       LIMIT ?
     )`,
  ).run(Number(ticketId), Number(ticketId), safeKeep).changes;
}

migrate();

function normalizeUserId(userid: string | number): string {
  const value = String(userid);
  return value.includes('.') ? String(Math.floor(Number(value))) : value;
}

function getTicketByIdSync(ticketId: string | number): any {
  return db.prepare('SELECT * FROM supportees WHERE id = ?').get(ticketId);
}

function getOpenSync(userid: string | number, _category: string | null): any {
  const userId = normalizeUserId(userid);
  return db.prepare(
    `SELECT * FROM supportees
     WHERE userid = ? AND status = 'open'
     ORDER BY id DESC LIMIT 1`,
  ).get(userId);
}

const check = function(
  userid: string | number,
  category: string | null,
  callback: (tickets: any[]) => void,
): void {
  const userId = normalizeUserId(userid);
  const categoryClause = category ? 'AND category = ?' : '';
  const tickets = db.prepare(
    `SELECT * FROM supportees
     WHERE (userid = ? OR id = ?) ${categoryClause}
     ORDER BY id DESC`,
  ).all(...(category ? [userId, userid, category] : [userId, userid]));
  logger.debug('db.check', 'Ticket check', {
    category,
    found: tickets.length > 0,
  });
  callback(tickets);
};

const getOpen = function(
  userid: string | number,
  category: string | null,
  callback: (ticket: any) => void,
): void {
  const ticket = getOpenSync(userid, category);
  logger.debug('db.getOpen', 'Fetching open ticket', {
    category,
    found: !!ticket,
    ticketId: ticket?.id,
  });
  callback(ticket);
};

const getId = function(
  ticketId: string | number,
  callback: (ticket: any) => void,
): void {
  const ticket = getTicketByIdSync(ticketId);
  logger.debug('db.getId', 'Getting ticket by ID', {
    ticketId,
    found: !!ticket,
  });
  callback(ticket);
};

const checkBan = function(
  userid: string | number,
  callback: (ticket: any) => void,
): void {
  const userId = normalizeUserId(userid);
  const blocked = db.prepare(
    'SELECT userid, blocked_at FROM blocked_users WHERE userid = ?',
  ).get(userId);
  callback(blocked ? {...blocked, status: 'banned'} : undefined);
};

function recordTicketEvent(
  ticketId: string | number,
  event: TicketEventInput,
): number {
  const result = db.prepare(`
    INSERT INTO ticket_events (
      ticket_id, event_type, actor_type, answer_id, answer_mode, source_id,
      dense_score, lexical_score, hybrid_score, dense_rank, lexical_rank,
      model, reason, error_reason, latency_ms, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    ticketId,
    event.eventType,
    event.actorType || 'system',
    event.answerId || null,
    event.answerMode || null,
    event.sourceId || null,
    event.denseScore ?? null,
    event.lexicalScore ?? null,
    event.hybridScore ?? null,
    event.denseRank ?? null,
    event.lexicalRank ?? null,
    event.model || null,
    event.reason || null,
    event.errorReason || null,
    event.latencyMs ?? null,
    event.createdAt || now(),
  );
  return Number(result.lastInsertRowid);
}

function recordAnswerFeedback(
  ticketId: string | number,
  userId: string | number,
  answerId: string,
  feedback: 'helpful' | 'operator' | 'not_helpful',
): {mode?: 'llm' | 'direct_rag'; sourceId?: string} | null {
  return db.transaction(() => {
    const ticket = getTicketByIdSync(ticketId);
    if (
      !ticket ||
      ticket.status !== 'open' ||
      normalizeUserId(ticket.userid) !== normalizeUserId(userId)
    ) {
      return null;
    }
    const answer = db.prepare(
      `SELECT answer_mode, source_id FROM ticket_events
       WHERE ticket_id = ? AND event_type = 'ai_answered' AND answer_id = ?
       ORDER BY id DESC LIMIT 1`,
    ).get(ticketId, answerId);
    if (!answer) return null;
    const eventType = feedback === 'helpful' ?
      'feedback_helpful' :
      (feedback === 'operator' ? 'feedback_operator' : 'feedback_not_helpful');
    try {
      recordTicketEvent(ticketId, {
        eventType,
        actorType: 'user',
        answerId,
        answerMode: answer.answer_mode,
        sourceId: answer.source_id,
      });
    } catch (error: any) {
      if (String(error?.code).includes('SQLITE_CONSTRAINT')) return null;
      throw error;
    }
    return {
      mode: answer.answer_mode || undefined,
      sourceId: answer.source_id || undefined,
    };
  })();
}

function updateTicketState(
  ticketId: string | number,
  update: TicketStateUpdate,
): any {
  const assignments: string[] = [];
  const values: any[] = [];
  const add = (column: string, value: any) => {
    assignments.push(`${column} = ?`);
    values.push(value);
  };
  if (update.status != null) add('status', update.status);
  if (update.stage != null) add('stage', update.stage);
  if (update.aiEnabled != null) add('ai_enabled', update.aiEnabled ? 1 : 0);
  if (update.handoffReason !== undefined) {
    add('handoff_reason', update.handoffReason);
  }
  if (update.assigneeId !== undefined) add('assignee_id', update.assigneeId);
  if (update.assigneeName !== undefined) {
    add('assignee_name', update.assigneeName);
  }
  if (update.closedAt !== undefined) add('closed_at', update.closedAt);
  add('last_activity_at', update.lastActivityAt || now());
  values.push(ticketId);
  db.prepare(
    `UPDATE supportees SET ${assignments.join(', ')} WHERE id = ?`,
  ).run(...values);
  return getTicketByIdSync(ticketId);
}

function touchTicket(ticketId: string | number): void {
  db.prepare('UPDATE supportees SET last_activity_at = ? WHERE id = ?')
    .run(now(), ticketId);
}

const closeAll = function(): void {
  const closedAt = now();
  const tickets = db.prepare(
    "SELECT id FROM supportees WHERE status = 'open'",
  ).all();
  db.prepare(
    `UPDATE supportees SET status = 'closed', stage = 'resolved',
      ai_enabled = 0, closed_at = ?, last_activity_at = ?
     WHERE status = 'open'`,
  ).run(closedAt, closedAt);
  for (const ticket of tickets) {
    recordTicketEvent(ticket.id, {
      eventType: 'ticket_closed',
      actorType: 'staff',
      reason: 'close_all',
      createdAt: closedAt,
    });
  }
};

const closeTicketById = function(
  ticketId: string | number,
  reason = 'manual',
): number {
  const closedAt = now();
  const result = db.prepare(
    `UPDATE supportees SET status = 'closed', stage = 'resolved',
      ai_enabled = 0, closed_at = ?, last_activity_at = ?
     WHERE id = ? AND status != 'closed'`,
  ).run(closedAt, closedAt, ticketId);
  if (result.changes) {
    recordTicketEvent(ticketId, {
      eventType: 'ticket_closed',
      actorType: 'system',
      reason,
      createdAt: closedAt,
    });
  }
  logger.info('db.closeTicketById', 'Ticket closed', {
    ticketId,
    changes: result.changes,
  });
  return result.changes;
};

const reopen = function(userid: string | number, category: string | null): void {
  const ticket = db.prepare(
    `SELECT * FROM supportees
     WHERE (userid = ? OR id = ?) AND category IS ?
     ORDER BY id DESC LIMIT 1`,
  ).get(normalizeUserId(userid), userid, category || null);
  if (!ticket) return;
  const existing = getOpenSync(ticket.userid, null);
  if (existing && existing.id !== ticket.id) return;
  updateTicketState(ticket.id, {
    status: 'open',
    stage: 'ai_active',
    aiEnabled: true,
    handoffReason: null,
    assigneeId: null,
    assigneeName: null,
    closedAt: null,
  });
  recordTicketEvent(ticket.id, {
    eventType: 'ticket_reopened',
    actorType: 'staff',
  });
};

const add = function(
  userid: string | number,
  status: string,
  category: string | number | null,
): number {
  const userId = normalizeUserId(userid);
  const normalizedCategory = category ? String(category) : null;
  if (status === 'closed') {
    const ticket = getOpenSync(userId, normalizedCategory);
    return ticket ? closeTicketById(ticket.id) : 0;
  }
  if (status === 'banned') {
    const result = db.prepare(
      `INSERT INTO blocked_users(userid, blocked_at)
       VALUES (?, ?)
       ON CONFLICT(userid) DO UPDATE SET blocked_at = excluded.blocked_at`,
    ).run(userId, now());
    return result.changes;
  }
  if (status !== 'open') throw new Error(`Unsupported ticket status: ${status}`);

  const createTicket = db.transaction(() => {
    const existing = getOpenSync(userId, normalizedCategory);
    if (existing) {
      touchTicket(existing.id);
      return {changes: 0, ticketId: existing.id};
    }
    const createdAt = now();
    const result = db.prepare(
      `INSERT INTO supportees(
        userid, status, category, created_at, last_activity_at, stage, ai_enabled
      ) VALUES (?, 'open', ?, ?, ?, 'ai_active', 1)`,
    ).run(userId, normalizedCategory, createdAt, createdAt);
    const ticketId = Number(result.lastInsertRowid);
    recordTicketEvent(ticketId, {
      eventType: 'ticket_created',
      actorType: 'user',
      createdAt,
    });
    return {changes: result.changes, ticketId};
  });
  const result = createTicket();
  logger.info('db.add', 'Ticket ensured', {
    ticketId: result.ticketId,
    created: result.changes > 0,
  });
  return result.changes;
};

function unblockUser(userid: string | number): number {
  return db.prepare('DELETE FROM blocked_users WHERE userid = ?')
    .run(normalizeUserId(userid)).changes;
}

const open = function(
  callback: (tickets: any[]) => void,
  category: string | any[],
): void {
  let tickets: any[];
  if (Array.isArray(category) && category.length > 0) {
    const placeholders = category.map(() => '?').join(', ');
    tickets = db.prepare(
      `SELECT * FROM supportees
       WHERE status = 'open' AND category IN (${placeholders})
       ORDER BY last_activity_at ASC`,
    ).all(...category);
  } else {
    tickets = db.prepare(
      `SELECT * FROM supportees
       WHERE status = 'open' AND category IS NULL
       ORDER BY last_activity_at ASC`,
    ).all();
  }
  callback(tickets);
};

export function updateTicketUser(
  ticketId: string | number,
  user: {first_name?: string; username?: string},
): void {
  db.prepare('UPDATE supportees SET user_name = ?, user_username = ? WHERE id = ?')
    .run(user.first_name || null, user.username || null, ticketId);
}

export function claimStaffTicket(
  ticketId: string | number,
  staffId: string | number,
  staffName: string,
  expectedAssignee: string | null,
): boolean {
  return db.prepare(
    `UPDATE supportees SET assignee_id = ?, assignee_name = ?
     WHERE id = ? AND status = 'open' AND assignee_id IS ?`,
  ).run(String(staffId), staffName, ticketId, expectedAssignee).changes > 0;
}

function staffCategoryWhere(categories?: string[]): {sql: string; args: string[]} {
  if (categories === undefined) return {sql: '1 = 1', args: []};
  if (!categories.length) return {sql: '0 = 1', args: []};
  return {
    sql: `s.category IN (${categories.map(() => '?').join(', ')})`,
    args: categories,
  };
}

export function getOpenStaffTickets(categories?: string[]): any[] {
  const scope = staffCategoryWhere(categories);
  return db.prepare(`SELECT s.* FROM supportees s WHERE s.status = 'open' AND ${scope.sql}`)
    .all(...scope.args);
}

export function closeStaffTicketBatch(ticketIds: string[]): any[] {
  return db.transaction(() => {
    const closed: any[] = [];
    for (const ticketId of ticketIds) {
      const ticket = getTicketByIdSync(ticketId);
      if (ticket?.status === 'open' && closeTicketById(ticketId, 'staff_panel_close_all')) {
        closed.push(ticket);
      }
    }
    return closed;
  })();
}

const staffTicketColumns = `s.*,
  (SELECT content FROM ai_conversation_messages WHERE ticket_id = s.id
   AND role = 'user' ORDER BY created_at DESC, id DESC LIMIT 1) question,
  (SELECT MAX(created_at) FROM ticket_events WHERE ticket_id = s.id
   AND event_type = 'handoff') waiting_since,
  (SELECT reason FROM ticket_events WHERE ticket_id = s.id
   AND event_type = 'ticket_closed' ORDER BY created_at DESC, id DESC LIMIT 1) close_reason`;

export function getStaffTicket(ticketId: string | number): any {
  return db.prepare(`SELECT ${staffTicketColumns} FROM supportees s WHERE s.id = ?`)
    .get(ticketId);
}

export function getStaffQueue(
  categories: string[] | undefined,
  filter: 'all' | 'waiting' | 'mine',
  staffId: string | number,
  page = 0,
): {tickets: any[]; total: number; page: number; pages: number} {
  const scope = staffCategoryWhere(categories);
  const conditions = [`s.status = 'open'`, scope.sql];
  const args: any[] = [...scope.args];
  if (filter === 'waiting') conditions.push("s.stage = 'waiting_operator'");
  if (filter === 'mine') {
    conditions.push('s.assignee_id = ?');
    args.push(String(staffId));
  }
  const where = conditions.join(' AND ');
  const total = db.prepare(`SELECT COUNT(*) total FROM supportees s WHERE ${where}`)
    .get(...args).total;
  const pages = Math.max(1, Math.ceil(total / 6));
  const safePage = Math.min(pages - 1, Math.max(0, Math.floor(page) || 0));
  const tickets = db.prepare(
    `SELECT ${staffTicketColumns} FROM supportees s WHERE ${where}
     ORDER BY CASE s.stage WHEN 'waiting_operator' THEN 0
       WHEN 'in_progress' THEN 1 ELSE 2 END,
       COALESCE(waiting_since, s.created_at) ASC, s.id ASC LIMIT 6 OFFSET ?`,
  ).all(...args, safePage * 6);
  return {tickets, total, page: safePage, pages};
}

export function searchStaffTickets(
  categories: string[] | undefined,
  query: string,
  byUserId: boolean,
): any[] {
  const scope = staffCategoryWhere(categories);
  const field = byUserId ? 's.userid' : 's.id';
  return db.prepare(
    `SELECT ${staffTicketColumns} FROM supportees s
     WHERE ${scope.sql} AND ${field} = ? ORDER BY s.id DESC LIMIT 6`,
  ).all(...scope.args, query);
}

export function getStaffTicketCounts(
  categories: string[] | undefined,
  staffId: string | number,
): {all: number; waiting: number; mine: number} {
  const scope = staffCategoryWhere(categories);
  const result = db.prepare(
    `SELECT COUNT(*) total,
     SUM(CASE WHEN s.stage = 'waiting_operator' THEN 1 ELSE 0 END) waiting,
     SUM(CASE WHEN s.assignee_id = ? THEN 1 ELSE 0 END) mine
     FROM supportees s WHERE s.status = 'open' AND ${scope.sql}`,
  ).get(String(staffId), ...scope.args);
  return {all: result.total, waiting: result.waiting || 0, mine: result.mine || 0};
}

function mapTelegramMessage(
  chatId: string | number,
  messageId: number,
  ticketId: string | number,
  kind: string,
): void {
  db.prepare(
    `INSERT INTO telegram_message_map(
      chat_id, message_id, ticket_id, kind, created_at
    ) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(chat_id, message_id) DO UPDATE SET
      ticket_id = excluded.ticket_id, kind = excluded.kind`,
  ).run(String(chatId), messageId, ticketId, kind, now());
}

function getTicketByTelegramMessage(
  chatId: string | number,
  messageId: number,
): any {
  return db.prepare(
    `SELECT s.*, m.kind AS mapped_message_kind
     FROM telegram_message_map m
     JOIN supportees s ON s.id = m.ticket_id
     WHERE m.chat_id = ? AND m.message_id = ?`,
  ).get(String(chatId), messageId);
}

const METADATA_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/;

function safeMetadataToken(
  value: string | null | undefined,
  field: string,
  optional = false,
): string | null {
  if (value == null || value === '') {
    if (optional) return null;
    throw new Error(`${field} is required`);
  }
  const normalized = String(value);
  if (normalized.length > 128 || !METADATA_TOKEN.test(normalized)) {
    throw new Error(`${field} must be a non-sensitive metadata token`);
  }
  return normalized;
}

function nonNegativeInteger(value: number | undefined, fallback = 0): number {
  if (value == null || !Number.isFinite(value)) return fallback;
  return Math.max(0, Math.floor(value));
}

function assertOneOf<T extends string>(
  value: string,
  values: readonly T[],
  field: string,
): T {
  if (!values.includes(value as T)) {
    throw new Error(`Unsupported ${field}: ${value}`);
  }
  return value as T;
}

function createAiRun(input: AiRunStartInput): string {
  const runId = safeMetadataToken(input.runId, 'runId') as string;
  const ticketId = input.ticketId == null ? null : safeMetadataToken(
    String(input.ticketId),
    'ticketId',
  );
  const mode = assertOneOf(
    input.mode,
    ['off', 'rag_only', 'full'] as const,
    'AI runtime mode',
  );
  db.prepare(
    `INSERT OR IGNORE INTO ai_runs(
      run_id, ticket_id, mode, status, route, rag_status, started_at
    ) VALUES (?, ?, ?, 'running', 'none', 'not_run', ?)`,
  ).run(runId, ticketId, mode, input.startedAt || now());
  return runId;
}

function finishAiRun(runId: string, input: AiRunFinishInput): number {
  const safeRunId = safeMetadataToken(runId, 'runId') as string;
  const status = assertOneOf(
    input.status,
    ['answered', 'direct_rag', 'handed_off', 'cancelled', 'failed'] as const,
    'AI run status',
  );
  const route = assertOneOf(
    input.route,
    ['none', 'primary', 'fallback', 'direct_rag', 'handoff'] as const,
    'AI run route',
  );
  const ragStatus = assertOneOf(
    input.ragStatus || 'not_run',
    ['not_run', 'hit', 'miss', 'unavailable'] as const,
    'RAG status',
  );
  const completedAt = input.completedAt || now();
  const result = db.prepare(
    `UPDATE ai_runs SET
      status = ?, route = ?, rag_status = ?, source_count = ?,
      failure_reason = ?, latency_ms = ?, completed_at = ?
     WHERE run_id = ? AND status = 'running'`,
  ).run(
    status,
    route,
    ragStatus,
    nonNegativeInteger(input.sourceCount),
    safeMetadataToken(input.failureReason, 'failureReason', true),
    input.latencyMs == null ? null : nonNegativeInteger(input.latencyMs),
    completedAt,
    safeRunId,
  );
  return result.changes;
}

function recordProviderAttempt(input: ProviderAttemptInput): number {
  const phase = assertOneOf(
    input.phase || 'answer',
    ['plan', 'answer', 'embedding', 'validation'] as const,
    'provider attempt phase',
  );
  const outcome = assertOneOf(
    input.outcome,
    ['success', 'failure', 'cancelled', 'skipped'] as const,
    'provider attempt outcome',
  );
  return db.transaction(() => {
    const result = db.prepare(
      `INSERT INTO provider_attempts(
        run_id, provider, model, phase, outcome, is_fallback, error_reason,
        status_code, latency_ms, prompt_tokens, completion_tokens,
        total_tokens, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      safeMetadataToken(input.runId, 'runId'),
      safeMetadataToken(input.provider, 'provider'),
      safeMetadataToken(input.model, 'model'),
      phase,
      outcome,
      input.isFallback ? 1 : 0,
      safeMetadataToken(input.errorReason, 'errorReason', true),
      input.statusCode == null ? null : nonNegativeInteger(input.statusCode),
      input.latencyMs == null ? null : nonNegativeInteger(input.latencyMs),
      nonNegativeInteger(input.promptTokens),
      nonNegativeInteger(input.completionTokens),
      nonNegativeInteger(input.totalTokens),
      input.createdAt || now(),
    );
    db.prepare(
      `UPDATE ai_runs SET provider_attempt_count = provider_attempt_count + 1
       WHERE run_id = ?`,
    ).run(input.runId);
    return Number(result.lastInsertRowid);
  })();
}

function recordAnswerRejection(input: AnswerRejectionInput): number {
  const redact = (value: string, maximumLength: number): string => {
    let text = String(value);
    for (const name of ['BOT_TOKEN', 'GOOGLE_API_KEY', 'MISTRAL_API_KEY',
      'QDRANT_API_KEY']) {
      const secret = process.env[name];
      if (secret) text = text.split(secret).join('[REDACTED]');
    }
    return text.replace(/Bearer\s+[^\s,;]+/gi, 'Bearer [REDACTED]')
      .slice(0, maximumLength);
  };
  const details = {
    unsupportedFacts: input.details?.unsupportedFacts?.slice(0, 20)
      .map(value => redact(value, 120)),
    unsupportedClauses: input.details?.unsupportedClauses?.slice(0, 8)
      .map(value => redact(value, 1000)),
  };
  const result = db.prepare(
    `INSERT INTO answer_rejections(
      run_id, reason, content, source_ids, details, created_at
    ) VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    safeMetadataToken(input.runId, 'runId'),
    safeMetadataToken(input.reason, 'reason'),
    redact(input.content, 10000),
    JSON.stringify(input.sourceIds.slice(0, 8)
      .map(id => safeMetadataToken(id, 'sourceId'))),
    JSON.stringify(details),
    input.createdAt || now(),
  );
  return Number(result.lastInsertRowid);
}

function recordToolRun(input: ToolRunInput): number {
  const outcome = assertOneOf(
    input.outcome,
    ['success', 'failure', 'cancelled', 'skipped'] as const,
    'tool run outcome',
  );
  return db.transaction(() => {
    const result = db.prepare(
      `INSERT INTO tool_runs(
        run_id, tool_name, outcome, result_count, error_reason,
        latency_ms, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      safeMetadataToken(input.runId, 'runId'),
      safeMetadataToken(input.toolName, 'toolName'),
      outcome,
      nonNegativeInteger(input.resultCount),
      safeMetadataToken(input.errorReason, 'errorReason', true),
      input.latencyMs == null ? null : nonNegativeInteger(input.latencyMs),
      input.createdAt || now(),
    );
    db.prepare(
      `UPDATE ai_runs SET tool_run_count = tool_run_count + 1
       WHERE run_id = ?`,
    ).run(input.runId);
    return Number(result.lastInsertRowid);
  })();
}

function saveAiProviderState(input: AiProviderStateInput): void {
  const circuitState = assertOneOf(
    input.circuitState,
    ['closed', 'open', 'half_open'] as const,
    'provider circuit state',
  );
  const quotaDate = input.quotaDate == null ? null : String(input.quotaDate);
  if (quotaDate != null && !/^\d{4}-\d{2}-\d{2}$/.test(quotaDate)) {
    throw new Error('quotaDate must use YYYY-MM-DD');
  }
  db.prepare(
    `INSERT INTO ai_provider_state(
      provider, circuit_state, consecutive_failures, open_until, quota_date,
      daily_requests, daily_tokens, last_error_reason, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(provider) DO UPDATE SET
      circuit_state = excluded.circuit_state,
      consecutive_failures = excluded.consecutive_failures,
      open_until = excluded.open_until,
      quota_date = excluded.quota_date,
      daily_requests = excluded.daily_requests,
      daily_tokens = excluded.daily_tokens,
      last_error_reason = excluded.last_error_reason,
      updated_at = excluded.updated_at`,
  ).run(
    safeMetadataToken(input.provider, 'provider'),
    circuitState,
    nonNegativeInteger(input.consecutiveFailures),
    input.openUntil == null ? null : nonNegativeInteger(input.openUntil),
    quotaDate,
    nonNegativeInteger(input.dailyRequests),
    nonNegativeInteger(input.dailyTokens),
    safeMetadataToken(input.lastErrorReason, 'lastErrorReason', true),
    input.updatedAt || now(),
  );
}

function getAiProviderStates(): AiProviderStateRecord[] {
  const rows = db.prepare(
    `SELECT provider, circuit_state, consecutive_failures, open_until,
            quota_date, daily_requests, daily_tokens, last_error_reason,
            updated_at
     FROM ai_provider_state ORDER BY provider`,
  ).all();
  return rows.map((row: any) => ({
    provider: row.provider,
    circuitState: row.circuit_state,
    consecutiveFailures: row.consecutive_failures,
    openUntil: row.open_until,
    quotaDate: row.quota_date,
    dailyRequests: row.daily_requests,
    dailyTokens: row.daily_tokens,
    lastErrorReason: row.last_error_reason,
    updatedAt: row.updated_at,
  }));
}

function setRuntimeFeatureFlag<K extends RuntimeFeatureFlagKey>(
  key: K,
  value: RuntimeFeatureFlagValue<K>,
): void {
  let serialized: string;
  if (key === 'ai_mode') {
    serialized = assertOneOf(
      String(value),
      ['off', 'rag_only', 'full'] as const,
      'AI runtime mode',
    );
  } else {
    const percent = Number(value);
    if (!Number.isInteger(percent) || percent < 0 || percent > 100) {
      throw new Error(`${key} must be an integer between 0 and 100`);
    }
    serialized = String(percent);
  }
  db.prepare(
    `INSERT INTO runtime_feature_flags(flag_key, flag_value, updated_at)
     VALUES (?, ?, ?)
     ON CONFLICT(flag_key) DO UPDATE SET
       flag_value = excluded.flag_value, updated_at = excluded.updated_at`,
  ).run(key, serialized, now());
}

function getRuntimeFeatureFlags(): RuntimeFeatureFlags {
  const rows = db.prepare(
    `SELECT flag_key, flag_value FROM runtime_feature_flags
     WHERE flag_key IN (
       'ai_mode', 'ai_rollout_percent', 'web_tool_rollout_percent'
     )`,
  ).all();
  const values = Object.fromEntries(
    rows.map((row: any) => [row.flag_key, row.flag_value]),
  );
  const mode = ['off', 'rag_only', 'full'].includes(values.ai_mode) ?
    values.ai_mode as AiRuntimeMode : 'off';
  const readPercent = (value: any) => {
    const number = Number(value);
    return Number.isInteger(number) && number >= 0 && number <= 100 ?
      number : 0;
  };
  return {
    aiMode: mode,
    aiRolloutPercent: readPercent(values.ai_rollout_percent),
    webToolRolloutPercent: readPercent(values.web_tool_rollout_percent),
  };
}

function isDatabaseReady(): boolean {
  try {
    return db.prepare('SELECT 1 AS ready').get()?.ready === 1;
  } catch (_error) {
    return false;
  }
}

function getAiRunDiagnostics(runId: string): AiRunDiagnostics | null {
  const safeRunId = safeMetadataToken(runId, 'runId') as string;
  const run = db.prepare('SELECT * FROM ai_runs WHERE run_id = ?')
    .get(safeRunId);
  if (!run) return null;
  const providerAttempts = db.prepare(
    `SELECT provider, model, phase, outcome, is_fallback, error_reason,
            status_code, latency_ms, prompt_tokens, completion_tokens,
            total_tokens, created_at
     FROM provider_attempts WHERE run_id = ? ORDER BY id`,
  ).all(safeRunId);
  const toolRuns = db.prepare(
    `SELECT tool_name, outcome, result_count, error_reason, latency_ms,
            created_at
     FROM tool_runs WHERE run_id = ? ORDER BY id`,
  ).all(safeRunId);
  const answerRejections = db.prepare(
    `SELECT reason, content, source_ids, details, created_at
     FROM answer_rejections WHERE run_id = ? ORDER BY id`,
  ).all(safeRunId);
  return {
    answerRejections: answerRejections.map((rejection: any) => ({
      reason: rejection.reason,
      content: rejection.content,
      sourceIds: JSON.parse(rejection.source_ids),
      details: JSON.parse(rejection.details),
      createdAt: rejection.created_at,
    })),
    run: {
      runId: run.run_id,
      ticketId: run.ticket_id,
      mode: run.mode,
      status: run.status,
      route: run.route,
      ragStatus: run.rag_status,
      sourceCount: run.source_count,
      providerAttemptCount: run.provider_attempt_count,
      toolRunCount: run.tool_run_count,
      failureReason: run.failure_reason,
      latencyMs: run.latency_ms,
      startedAt: run.started_at,
      completedAt: run.completed_at,
    },
    providerAttempts: providerAttempts.map((attempt: any) => ({
      provider: attempt.provider,
      model: attempt.model,
      phase: attempt.phase,
      outcome: attempt.outcome,
      isFallback: attempt.is_fallback === 1,
      errorReason: attempt.error_reason,
      statusCode: attempt.status_code,
      latencyMs: attempt.latency_ms,
      promptTokens: attempt.prompt_tokens,
      completionTokens: attempt.completion_tokens,
      totalTokens: attempt.total_tokens,
      createdAt: attempt.created_at,
    })),
    toolRuns: toolRuns.map((toolRun: any) => ({
      toolName: toolRun.tool_name,
      outcome: toolRun.outcome,
      resultCount: toolRun.result_count,
      errorReason: toolRun.error_reason,
      latencyMs: toolRun.latency_ms,
      createdAt: toolRun.created_at,
    })),
  };
}

function getLatestAiRunDiagnosticsForTicket(
  ticketId: string | number,
): AiRunDiagnostics | null {
  const safeTicketId = safeMetadataToken(String(ticketId), 'ticketId') as string;
  const row = db.prepare(
    `SELECT run_id FROM ai_runs
     WHERE ticket_id = ? ORDER BY started_at DESC LIMIT 1`,
  ).get(safeTicketId);
  return row?.run_id ? getAiRunDiagnostics(row.run_id) : null;
}

function getAiSloSnapshot(
  windowMs = 30 * 60 * 1000,
): AiSloSnapshot {
  const safeWindowMs = Math.max(
    60 * 1000,
    Math.min(24 * 60 * 60 * 1000, nonNegativeInteger(windowMs)),
  );
  const rows = db.prepare(
    `SELECT r.run_id, r.latency_ms,
            MAX(CASE WHEN p.outcome = 'success' THEN 1 ELSE 0 END) success,
            MAX(CASE WHEN p.is_fallback = 1 AND p.outcome != 'skipped'
                     THEN 1 ELSE 0 END) fallback
     FROM ai_runs r
     JOIN provider_attempts p ON p.run_id = r.run_id AND p.phase = 'answer'
     WHERE r.started_at >= ?
     GROUP BY r.run_id, r.latency_ms`,
  ).all(now() - safeWindowMs);
  const latencies = rows
    .map((row: any) => Number(row.latency_ms))
    .filter((value: number) => Number.isFinite(value) && value >= 0);
  return {
    llmRuns: rows.length,
    successfulRuns: rows.filter((row: any) => row.success === 1).length,
    fallbackRuns: rows.filter((row: any) => row.fallback === 1).length,
    latencyP95Ms: percentile(latencies, 0.95),
  };
}

function closeInactiveAiTickets(inactivityMs = 24 * 60 * 60 * 1000): number[] {
  const cutoff = now() - inactivityMs;
  const tickets = db.prepare(
    `SELECT id FROM supportees
     WHERE status = 'open' AND stage = 'ai_active'
       AND last_activity_at < ?`,
  ).all(cutoff);
  for (const ticket of tickets) {
    closeTicketById(ticket.id, 'ai_inactivity');
  }
  return tickets.map((ticket: any) => Number(ticket.id));
}

function purgeExpiredMetadata(retentionDays = 90): {
  events: number;
  mappings: number;
  tickets: number;
  aiRuns: number;
  providerAttempts: number;
  toolRuns: number;
  answerRejections: number;
  conversationMessages: number;
} {
  const cutoff = now() - retentionDays * 24 * 60 * 60 * 1000;
  return db.transaction(() => {
    const aggregates = db.prepare(
      `SELECT strftime('%Y-%m-%d', created_at / 1000, 'unixepoch') day,
        event_type, COUNT(*) count
       FROM ticket_events WHERE created_at < ?
       GROUP BY day, event_type`,
    ).all(cutoff);
    const saveAggregate = db.prepare(
      `INSERT INTO daily_support_metrics(metric_date, metric_key, metric_value)
       VALUES (?, ?, ?)
       ON CONFLICT(metric_date, metric_key) DO UPDATE SET
         metric_value = metric_value + excluded.metric_value`,
    );
    for (const aggregate of aggregates) {
      saveAggregate.run(aggregate.day, aggregate.event_type, aggregate.count);
    }
    const aiAggregates = db.prepare(
      `SELECT strftime('%Y-%m-%d', started_at / 1000, 'unixepoch') day,
              'ai_run.' || status metric_key, COUNT(*) count
       FROM ai_runs WHERE started_at < ? GROUP BY day, status
       UNION ALL
       SELECT strftime('%Y-%m-%d', created_at / 1000, 'unixepoch') day,
              'provider.' || provider || '.' || outcome ||
                CASE WHEN is_fallback = 1 THEN '.fallback' ELSE '.primary' END,
              COUNT(*) count
       FROM provider_attempts WHERE created_at < ?
       GROUP BY day, provider, outcome, is_fallback
       UNION ALL
       SELECT strftime('%Y-%m-%d', created_at / 1000, 'unixepoch') day,
              'tool.' || tool_name || '.' || outcome metric_key,
              COUNT(*) count
       FROM tool_runs WHERE created_at < ?
       GROUP BY day, tool_name, outcome`,
    ).all(cutoff, cutoff, cutoff);
    for (const aggregate of aiAggregates) {
      saveAggregate.run(
        aggregate.day,
        aggregate.metric_key,
        aggregate.count,
      );
    }
    const mappings = db.prepare(
      'DELETE FROM telegram_message_map WHERE created_at < ?',
    ).run(cutoff).changes;
    const conversationMessages = db.prepare(
      'DELETE FROM ai_conversation_messages WHERE created_at < ?',
    ).run(cutoff).changes;
    const events = db.prepare(
      'DELETE FROM ticket_events WHERE created_at < ?',
    ).run(cutoff).changes;
    const providerAttempts = db.prepare(
      'DELETE FROM provider_attempts WHERE created_at < ?',
    ).run(cutoff).changes;
    const toolRuns = db.prepare(
      'DELETE FROM tool_runs WHERE created_at < ?',
    ).run(cutoff).changes;
    const answerRejections = db.prepare(
      'DELETE FROM answer_rejections WHERE created_at < ?',
    ).run(cutoff).changes;
    const aiRuns = db.prepare(
      'DELETE FROM ai_runs WHERE started_at < ?',
    ).run(cutoff).changes;
    const tickets = db.prepare(
      `DELETE FROM supportees
       WHERE status = 'closed' AND closed_at IS NOT NULL AND closed_at < ?`,
    ).run(cutoff).changes;
    const aggregatesCutoff = new Date(
      now() - 400 * 24 * 60 * 60 * 1000,
    ).toISOString().slice(0, 10);
    db.prepare('DELETE FROM daily_support_metrics WHERE metric_date < ?')
      .run(aggregatesCutoff);
    return {
      events,
      mappings,
      tickets,
      aiRuns,
      providerAttempts,
      toolRuns,
      answerRejections,
      conversationMessages,
    };
  })();
}

function percentile(values: number[], ratio: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * ratio))];
}

function getPersistentAiStats(days = 7): any {
  const safeDays = [1, 7, 30].includes(days) ? days : 7;
  const since = now() - safeDays * 24 * 60 * 60 * 1000;
  const events = db.prepare(
    `SELECT ticket_id, event_type, answer_id, answer_mode, source_id, reason,
            error_reason, latency_ms, created_at
     FROM ticket_events WHERE created_at >= ?`,
  ).all(since);
  const count = (type: string) =>
    events.filter((event: any) => event.event_type === type).length;
  const by = (field: string, type: string) => {
    const result: Record<string, number> = {};
    for (const event of events) {
      if (event.event_type !== type) continue;
      const key = event[field] || 'unknown';
      result[key] = (result[key] || 0) + 1;
    }
    return result;
  };
  const latencies = events
    .filter((event: any) => event.event_type === 'ai_answered')
    .map((event: any) => Number(event.latency_ms || 0));
  const ragResults = events.filter(
    (event: any) => event.event_type === 'rag_result',
  );
  const feedbackByMode: Record<string, {helpful: number; operator: number}> = {};
  for (const event of events) {
    if (!['feedback_helpful', 'feedback_operator', 'feedback_not_helpful']
      .includes(event.event_type)) continue;
    const mode = event.answer_mode || 'unknown';
    feedbackByMode[mode] ||= {helpful: 0, operator: 0};
    if (event.event_type === 'feedback_helpful') {
      feedbackByMode[mode].helpful++;
    } else {
      feedbackByMode[mode].operator++;
    }
  }
  const latestHandoff = new Map<number, number>();
  const ticketCreated = new Map<number, number>();
  const operatorWaitMs: number[] = [];
  const resolutionMs: number[] = [];
  for (const event of events) {
    if (event.event_type === 'ticket_created') {
      ticketCreated.set(event.ticket_id, event.created_at);
    }
    if (event.event_type === 'handoff') {
      latestHandoff.set(event.ticket_id, event.created_at);
    }
    if (event.event_type === 'staff_take' || event.event_type === 'staff_reply') {
      const handoffAt = latestHandoff.get(event.ticket_id);
      if (handoffAt != null && event.created_at >= handoffAt) {
        operatorWaitMs.push(event.created_at - handoffAt);
        latestHandoff.delete(event.ticket_id);
      }
    }
    if (event.event_type === 'ticket_closed') {
      const createdAt = ticketCreated.get(event.ticket_id);
      if (createdAt != null && event.created_at >= createdAt) {
        resolutionMs.push(event.created_at - createdAt);
      }
    }
  }
  const backlog = db.prepare(
    `SELECT stage, COUNT(*) count FROM supportees
     WHERE status = 'open' GROUP BY stage`,
  ).all();
  const providerAttempts = db.prepare(
    `SELECT provider, outcome, is_fallback, error_reason, latency_ms
     FROM provider_attempts WHERE created_at >= ?`,
  ).all(since);
  const toolRuns = db.prepare(
    `SELECT tool_name, outcome, error_reason, latency_ms
     FROM tool_runs WHERE created_at >= ?`,
  ).all(since);
  const aiRuns = db.prepare(
    `SELECT status FROM ai_runs WHERE started_at >= ?`,
  ).all(since);
  const countRowsBy = (rows: any[], field: string) => {
    const result: Record<string, number> = {};
    for (const row of rows) {
      const key = row[field] || 'unknown';
      result[key] = (result[key] || 0) + 1;
    }
    return result;
  };
  const providerFailures: Record<string, number> = {};
  for (const attempt of providerAttempts) {
    if (attempt.outcome === 'success') continue;
    const reason = attempt.error_reason || attempt.outcome;
    const key = `${attempt.provider}:${reason}`;
    providerFailures[key] = (providerFailures[key] || 0) + 1;
  }
  const toolFailures: Record<string, number> = {};
  for (const toolRun of toolRuns) {
    if (toolRun.outcome === 'success') continue;
    const reason = toolRun.error_reason || toolRun.outcome;
    const key = `${toolRun.tool_name}:${reason}`;
    toolFailures[key] = (toolFailures[key] || 0) + 1;
  }
  const providerLatencies = providerAttempts
    .filter((attempt: any) => attempt.latency_ms != null)
    .map((attempt: any) => Number(attempt.latency_ms));
  return {
    days: safeDays,
    created: count('ticket_created'),
    aiAnswered: count('ai_answered'),
    aiResolved: events.filter(
      (event: any) =>
        event.event_type === 'ticket_closed' &&
        ['ai_helpful', 'ai_inactivity'].includes(event.reason),
    ).length,
    handoffs: count('handoff'),
    closed: count('ticket_closed'),
    feedbackHelpful: count('feedback_helpful'),
    feedbackOperator: count('feedback_operator'),
    byMode: by('answer_mode', 'ai_answered'),
    byHandoff: by('reason', 'handoff'),
    byError: by('error_reason', 'llm_failure'),
    bySource: by('source_id', 'ai_answered'),
    ragRequests: ragResults.length,
    ragHits: ragResults.filter((event: any) => event.reason === 'hit').length,
    feedbackByMode,
    latencyP50Ms: percentile(latencies, 0.5),
    latencyP95Ms: percentile(latencies, 0.95),
    operatorWaitP50Ms: percentile(operatorWaitMs, 0.5),
    operatorWaitP95Ms: percentile(operatorWaitMs, 0.95),
    resolutionP50Ms: percentile(resolutionMs, 0.5),
    resolutionP95Ms: percentile(resolutionMs, 0.95),
    backlog: Object.fromEntries(
      backlog.map((row: any) => [row.stage || 'unknown', row.count]),
    ),
    aiRuns: aiRuns.length,
    aiRunsByStatus: countRowsBy(aiRuns, 'status'),
    providerAttempts: providerAttempts.length,
    providerSuccesses: providerAttempts.filter(
      (attempt: any) => attempt.outcome === 'success',
    ).length,
    fallbackAttempts: providerAttempts.filter(
      (attempt: any) => attempt.is_fallback === 1,
    ).length,
    fallbackSuccesses: providerAttempts.filter(
      (attempt: any) =>
        attempt.is_fallback === 1 && attempt.outcome === 'success',
    ).length,
    byProvider: countRowsBy(providerAttempts, 'provider'),
    byProviderFailure: providerFailures,
    providerLatencyP50Ms: percentile(providerLatencies, 0.5),
    providerLatencyP95Ms: percentile(providerLatencies, 0.95),
    toolRuns: toolRuns.length,
    toolSuccesses: toolRuns.filter(
      (toolRun: any) => toolRun.outcome === 'success',
    ).length,
    byTool: countRowsBy(toolRuns, 'tool_name'),
    byToolFailure: toolFailures,
  };
}

function formatPersistentAiStats(days = 7): string {
  const stats = getPersistentAiStats(days);
  const formatRecord = (record: Record<string, number>) => {
    const entries = Object.entries(record);
    return entries.length ?
      entries.map(([key, value]) => `${key}=${value}`).join(', ') : 'нет';
  };
  const feedback = Object.entries(stats.feedbackByMode)
    .map(([mode, value]: [string, any]) => {
      const total = value.helpful + value.operator;
      const rate = total ? Math.round(value.helpful / total * 100) : 0;
      return `${mode}: ${value.helpful}/${total} (${rate}%)`;
    }).join(', ') || 'нет';
  const ragRate = stats.ragRequests ?
    Math.round(stats.ragHits / stats.ragRequests * 100) : 0;
  return [
    `AI/support за ${stats.days} дн.`,
    `AI-resolved: ${stats.aiResolved}; handoff: ${stats.handoffs}; ` +
      `закрыто: ${stats.closed}`,
    `Backlog: ${formatRecord(stats.backlog)}`,
    `Режимы: ${formatRecord(stats.byMode)}`,
    `RAG: ${stats.ragHits}/${stats.ragRequests} (${ragRate}%); ` +
      `статьи: ${formatRecord(stats.bySource)}`,
    `Handoff: ${formatRecord(stats.byHandoff)}`,
    `Ошибки LLM: ${formatRecord(stats.byError)}`,
    `Провайдеры: ${stats.providerSuccesses}/${stats.providerAttempts}; ` +
      `fallback: ${stats.fallbackSuccesses}/${stats.fallbackAttempts}; ` +
      `${formatRecord(stats.byProvider)}`,
    `Ошибки провайдеров: ${formatRecord(stats.byProviderFailure)}`,
    `Tools: ${stats.toolSuccesses}/${stats.toolRuns}; ` +
      `${formatRecord(stats.byTool)}`,
    `Ошибки tools: ${formatRecord(stats.byToolFailure)}`,
    `Полезность: ${feedback}`,
    `AI latency p50/p95: ${stats.latencyP50Ms}/${stats.latencyP95Ms} мс`,
    `Provider latency p50/p95: ` +
      `${stats.providerLatencyP50Ms}/${stats.providerLatencyP95Ms} мс`,
    `Ожидание оператора p50/p95: ` +
      `${stats.operatorWaitP50Ms}/${stats.operatorWaitP95Ms} мс`,
    `Решение p50/p95: ${stats.resolutionP50Ms}/${stats.resolutionP95Ms} мс`,
  ].join('\n');
}

export {
  open,
  add,
  check,
  getOpen,
  getOpenSync,
  checkBan,
  getId,
  getTicketByIdSync,
  closeAll,
  closeTicketById,
  reopen,
  unblockUser,
  touchTicket,
  updateTicketState,
  recordTicketEvent,
  appendAiConversationMessage,
  getAiConversationHistory,
  trimAiConversationHistory,
  recordAnswerFeedback,
  mapTelegramMessage,
  getTicketByTelegramMessage,
  createAiRun,
  finishAiRun,
  recordProviderAttempt,
  recordToolRun,
  recordAnswerRejection,
  saveAiProviderState,
  getAiProviderStates,
  setRuntimeFeatureFlag,
  getRuntimeFeatureFlags,
  isDatabaseReady,
  getAiRunDiagnostics,
  getLatestAiRunDiagnosticsForTicket,
  getAiSloSnapshot,
  closeInactiveAiTickets,
  purgeExpiredMetadata,
  getPersistentAiStats,
  formatPersistentAiStats,
};
