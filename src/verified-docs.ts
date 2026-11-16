import {promises as dns} from 'dns';
import {promises as fs} from 'fs';
import {IncomingMessage} from 'http';
import {request as httpsRequest} from 'https';
import * as net from 'net';
import * as path from 'path';
import {
  LexicalRetriever,
  verifiedDocumentsToLexical,
} from './lexical-retriever';

export interface VerifiedSource {
  sourceId: string;
  title: string;
  url: string;
  category: 'support' | 'legal';
  maxAgeMs: number;
}

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

export const VERIFIED_SOURCE_REGISTRY: readonly VerifiedSource[] = Object.freeze([
  Object.freeze({
    sourceId: 'demodesk_troubleshooting',
    title: 'demodesk: ничего не работает',
    url: 'https://example.com/docs/troubleshooting',
    category: 'support' as const,
    maxAgeMs: 48 * HOUR_MS,
  }),
  Object.freeze({
    sourceId: 'demodesk_gift_activation',
    title: 'demodesk: активация подарка',
    url: 'https://example.com/docs/gifts',
    category: 'support' as const,
    maxAgeMs: 48 * HOUR_MS,
  }),
  Object.freeze({
    sourceId: 'demodesk_privacy_policy',
    title: 'Политика конфиденциальности demodesk',
    url: 'https://example.com/legal/privacy',
    category: 'legal' as const,
    maxAgeMs: 30 * DAY_MS,
  }),
  Object.freeze({
    sourceId: 'demodesk_public_offer',
    title: 'Договор публичной оферты demodesk',
    url: 'https://example.com/legal/terms',
    category: 'legal' as const,
    maxAgeMs: 30 * DAY_MS,
  }),
]);

const SOURCES_BY_ID = new Map(
  VERIFIED_SOURCE_REGISTRY.map(source => [source.sourceId, source]),
);
const SOURCES_BY_URL = new Map(
  VERIFIED_SOURCE_REGISTRY.map(source => [source.url, source]),
);

export function isVerifiedSourceUrl(url: string): boolean {
  try {
    return !!sourceForExactUrl(url);
  } catch (_error) {
    return false;
  }
}

export function getVerifiedSource(sourceId: string): VerifiedSource | undefined {
  const source = SOURCES_BY_ID.get(sourceId);
  return source ? {...source} : undefined;
}

export function getVerifiedSourceByUrl(url: string): VerifiedSource | undefined {
  try {
    return {...sourceForExactUrl(url)};
  } catch (_error) {
    return undefined;
  }
}

export interface VerifiedDocumentSnapshot {
  sourceId: string;
  title: string;
  url: string;
  text: string;
  fetchedAt: string;
  etag?: string;
  lastModified?: string;
}

export interface VerifiedDocsSnapshot {
  version: 1;
  updatedAt: string;
  documents: Record<string, VerifiedDocumentSnapshot>;
}

export interface VerifiedDocsStore {
  load(): Promise<VerifiedDocsSnapshot>;
  save(snapshot: VerifiedDocsSnapshot): Promise<void>;
}

export interface FetchHeadersLike {
  get(name: string): string | null;
}

interface ReadableBodyLike {
  getReader(): {
    read(): Promise<{done: boolean; value?: Uint8Array}>;
    cancel?(reason?: unknown): Promise<void>;
  };
}

export interface FetchResponseLike {
  status: number;
  headers: FetchHeadersLike;
  body?: ReadableBodyLike | null;
  arrayBuffer?(): Promise<ArrayBuffer>;
  text?(): Promise<string>;
}

export interface SafeFetchInit {
  method: 'GET';
  headers: Record<string, string>;
  redirect: 'manual';
  signal: AbortSignal;
  resolvedAddresses?: string[];
}

export type VerifiedDocsFetch = (
  url: string,
  init: SafeFetchInit,
) => Promise<FetchResponseLike>;

export type ResolveHost = (
  hostname: string,
  signal?: AbortSignal,
) => Promise<string[]>;

export interface VerifiedDocsServiceOptions {
  store?: VerifiedDocsStore;
  fetchImpl?: VerifiedDocsFetch;
  resolveHost?: ResolveHost;
  now?: () => Date;
  timeoutMs?: number;
  maximumResponseBytes?: number;
  maximumSanitizedChars?: number;
  maximumRedirects?: number;
}

export interface VerifiedDocumentSyncStatus {
  sourceId: string;
  status: 'updated' | 'not_modified' | 'failed';
  usedLastGoodSnapshot: boolean;
  errorCode?: string;
}

export interface VerifiedDocsSyncResult {
  changed: boolean;
  documentsAvailable: number;
  statuses: VerifiedDocumentSyncStatus[];
}

export interface VerifiedDocsSearchResult {
  sourceId: string;
  title: string;
  url: string;
  snippet: string;
  score: number;
  fetchedAt: string;
  stale: boolean;
}

export interface VerifiedDocsSearchResponse {
  query: string;
  results: VerifiedDocsSearchResult[];
  totalSnippetBytes: number;
}

export class VerifiedDocsSecurityError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.name = 'VerifiedDocsSecurityError';
    this.code = code;
  }
}

function emptySnapshot(now: Date = new Date(0)): VerifiedDocsSnapshot {
  return {version: 1, updatedAt: now.toISOString(), documents: {}};
}

function cleanOptionalHeader(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const clean = Array.from(value)
    .filter(character => ![0, 10, 13].includes(character.charCodeAt(0)))
    .join('')
    .trim();
  return clean ? clean.slice(0, 512) : undefined;
}

function canonicalizeSnapshot(value: unknown): VerifiedDocsSnapshot {
  if (!value || typeof value !== 'object') return emptySnapshot();
  const raw = value as Partial<VerifiedDocsSnapshot>;
  const rawDocuments = raw.documents && typeof raw.documents === 'object' ?
    raw.documents : {};
  const documents: Record<string, VerifiedDocumentSnapshot> = {};
  for (const source of VERIFIED_SOURCE_REGISTRY) {
    const candidate = (rawDocuments as Record<string, unknown>)[source.sourceId];
    if (!candidate || typeof candidate !== 'object') continue;
    const item = candidate as Partial<VerifiedDocumentSnapshot>;
    if (typeof item.text !== 'string' || !item.text.trim()) continue;
    if (typeof item.fetchedAt !== 'string' || !Number.isFinite(
      Date.parse(item.fetchedAt),
    )) continue;
    documents[source.sourceId] = {
      sourceId: source.sourceId,
      title: source.title,
      url: source.url,
      text: sanitizePlainText(item.text).slice(0, 262144),
      fetchedAt: new Date(item.fetchedAt).toISOString(),
      etag: cleanOptionalHeader(item.etag),
      lastModified: cleanOptionalHeader(item.lastModified),
    };
  }
  const updatedAt = typeof raw.updatedAt === 'string' && Number.isFinite(
    Date.parse(raw.updatedAt),
  ) ? new Date(raw.updatedAt).toISOString() : new Date(0).toISOString();
  return {version: 1, updatedAt, documents};
}

export class InMemoryVerifiedDocsStore implements VerifiedDocsStore {
  private snapshot: VerifiedDocsSnapshot;

  constructor(snapshot: VerifiedDocsSnapshot = emptySnapshot()) {
    this.snapshot = canonicalizeSnapshot(snapshot);
  }

  async load(): Promise<VerifiedDocsSnapshot> {
    return JSON.parse(JSON.stringify(this.snapshot)) as VerifiedDocsSnapshot;
  }

  async save(snapshot: VerifiedDocsSnapshot): Promise<void> {
    this.snapshot = canonicalizeSnapshot(snapshot);
  }
}

export class FileVerifiedDocsStore implements VerifiedDocsStore {
  readonly filePath: string;

  constructor(filePath: string = process.env.VERIFIED_DOCS_CACHE_PATH ||
    path.join(process.cwd(), 'config', '.verified-docs-cache.json')) {
    this.filePath = filePath;
  }

  async load(): Promise<VerifiedDocsSnapshot> {
    try {
      const contents = await fs.readFile(this.filePath, 'utf8');
      return canonicalizeSnapshot(JSON.parse(contents));
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') return emptySnapshot();
      throw error;
    }
  }

  async save(snapshot: VerifiedDocsSnapshot): Promise<void> {
    const directory = path.dirname(this.filePath);
    await fs.mkdir(directory, {recursive: true, mode: 0o700});
    const temporary = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
    try {
      await fs.writeFile(
        temporary,
        `${JSON.stringify(canonicalizeSnapshot(snapshot), null, 2)}\n`,
        {encoding: 'utf8', mode: 0o600},
      );
      await fs.rename(temporary, this.filePath);
      await fs.chmod(this.filePath, 0o600);
    } catch (error) {
      await fs.unlink(temporary).catch(() => undefined);
      throw error;
    }
  }
}

async function defaultFetch(
  url: string,
  init: SafeFetchInit,
): Promise<FetchResponseLike> {
  const addresses = init.resolvedAddresses || [];
  if (
    addresses.length === 0 ||
    addresses.some(address => !isPublicNetworkAddress(address))
  ) throw new VerifiedDocsSecurityError('unvalidated_network_target');
  return new Promise<FetchResponseLike>((resolve, reject) => {
    const lookup = (
      _hostname: string,
      options: any,
      callback: (...args: any[]) => void,
    ) => {
      const requestedFamily = typeof options === 'number' ?
        options : Number(options?.family || 0);
      const candidates = addresses
        .map(address => ({address, family: net.isIP(address)}))
        .filter(candidate =>
          candidate.family > 0 &&
          (!requestedFamily || candidate.family === requestedFamily),
        );
      if (candidates.length === 0) {
        callback(new Error('No validated address for requested family'));
        return;
      }
      if (options?.all) callback(null, candidates);
      else callback(null, candidates[0].address, candidates[0].family);
    };
    const request = httpsRequest(url, {
      method: init.method,
      headers: init.headers,
      signal: init.signal,
      lookup,
    }, (response: IncomingMessage) => {
      const iterator = response[Symbol.asyncIterator]();
      resolve({
        status: response.statusCode || 0,
        headers: {
          get(name: string): string | null {
            const value = response.headers[name.toLowerCase()];
            if (Array.isArray(value)) return value.join(', ');
            return value == null ? null : String(value);
          },
        },
        body: {
          getReader() {
            return {
              async read() {
                const chunk = await iterator.next();
                return {
                  done: !!chunk.done,
                  value: chunk.done ? undefined : new Uint8Array(chunk.value),
                };
              },
              async cancel() {
                response.destroy();
              },
            };
          },
        },
      });
    });
    request.once('error', reject);
    request.end();
  });
}

async function defaultResolveHost(
  hostname: string,
  signal?: AbortSignal,
): Promise<string[]> {
  if (net.isIP(hostname)) return [hostname];
  const resolver = new dns.Resolver();
  const cancel = () => resolver.cancel();
  if (signal?.aborted) throw new Error('DNS lookup cancelled');
  signal?.addEventListener('abort', cancel, {once: true});
  try {
    const [ipv4, ipv6] = await Promise.allSettled([
      resolver.resolve4(hostname),
      resolver.resolve6(hostname),
    ]);
    if (signal?.aborted) throw new Error('DNS lookup cancelled');
    return [
      ...(ipv4.status === 'fulfilled' ? ipv4.value : []),
      ...(ipv6.status === 'fulfilled' ? ipv6.value : []),
    ];
  } finally {
    signal?.removeEventListener('abort', cancel);
  }
}

function parseIpv4(address: string): number[] | undefined {
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(address)) return undefined;
  const octets = address.split('.').map(Number);
  return octets.every(octet => octet >= 0 && octet <= 255) ?
    octets : undefined;
}

function isPublicIpv4(octets: number[]): boolean {
  const [a, b, c] = octets;
  if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
  if (a === 100 && b >= 64 && b <= 127) return false;
  if (a === 169 && b === 254) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 168) return false;
  if (a === 192 && b === 0) return false;
  if (a === 192 && b === 88 && c === 99) return false;
  if (a === 192 && b === 0 && c === 2) return false;
  if (a === 198 && (b === 18 || b === 19)) return false;
  if (a === 198 && b === 51 && c === 100) return false;
  if (a === 203 && b === 0 && c === 113) return false;
  return true;
}

function parseIpv6Words(address: string): number[] | undefined {
  if (net.isIP(address) !== 6 || address.includes('%')) return undefined;
  let normalized = address.toLowerCase();
  if (normalized.includes('.')) {
    const separator = normalized.lastIndexOf(':');
    if (separator < 0) return undefined;
    const ipv4 = parseIpv4(normalized.slice(separator + 1));
    if (!ipv4) return undefined;
    normalized = `${normalized.slice(0, separator)}:` +
      `${((ipv4[0] << 8) | ipv4[1]).toString(16)}:` +
      `${((ipv4[2] << 8) | ipv4[3]).toString(16)}`;
  }
  const compression = normalized.indexOf('::');
  if (compression !== -1 && compression !== normalized.lastIndexOf('::')) {
    return undefined;
  }
  const left = (compression === -1 ? normalized :
    normalized.slice(0, compression)).split(':').filter(Boolean);
  const right = (compression === -1 ? '' :
    normalized.slice(compression + 2)).split(':').filter(Boolean);
  const missing = 8 - left.length - right.length;
  if (
    (compression === -1 && missing !== 0) ||
    (compression !== -1 && missing < 1)
  ) return undefined;
  const groups = [
    ...left,
    ...Array(missing).fill('0'),
    ...right,
  ];
  if (
    groups.length !== 8 ||
    groups.some(group => !/^[0-9a-f]{1,4}$/.test(group))
  ) return undefined;
  return groups.map(group => parseInt(group, 16));
}

function embeddedIpv4(words: number[]): number[] | undefined {
  const fromLastWords = () => [
    words[6] >> 8,
    words[6] & 0xff,
    words[7] >> 8,
    words[7] & 0xff,
  ];
  const first = (end: number) => words.slice(0, end).every(word => word === 0);
  // IPv4-compatible, mapped and translated forms. Matching expanded binary
  // words avoids bypasses through alternate IPv6 text compression.
  if (first(6)) return fromLastWords();
  if (first(5) && words[5] === 0xffff) return fromLastWords();
  if (
    first(4) && words[4] === 0xffff && words[5] === 0
  ) return fromLastWords();
  // RFC 6052 well-known NAT64 /96 prefix.
  if (
    words[0] === 0x64 && words[1] === 0xff9b &&
    words.slice(2, 6).every(word => word === 0)
  ) return fromLastWords();
  // 6to4 embeds an IPv4 address immediately after 2002::/16.
  if (words[0] === 0x2002) {
    return [
      words[1] >> 8,
      words[1] & 0xff,
      words[2] >> 8,
      words[2] & 0xff,
    ];
  }
  // ISATAP interface identifiers contain 0000:5efe or 0200:5efe.
  if ((words[4] === 0 || words[4] === 0x0200) && words[5] === 0x5efe) {
    return fromLastWords();
  }
  return undefined;
}

export function isPublicNetworkAddress(address: string): boolean {
  const normalized = String(address || '').trim().toLowerCase();
  const ipv4 = parseIpv4(normalized);
  if (ipv4) return isPublicIpv4(ipv4);
  const words = parseIpv6Words(normalized);
  if (!words) return false;
  if (words.every(word => word === 0)) return false;
  if (words.slice(0, 7).every(word => word === 0) && words[7] === 1) {
    return false;
  }
  if ((words[0] & 0xfe00) === 0xfc00) return false;
  if ((words[0] & 0xffc0) === 0xfe80) return false;
  if ((words[0] & 0xffc0) === 0xfec0) return false;
  if ((words[0] & 0xff00) === 0xff00) return false;
  if (words[0] === 0x2001 && words[1] === 0x0db8) return false;
  if (words[0] === 0x2001 && words[1] === 0x0002) return false;
  if (
    words[0] === 0x2001 &&
    ((words[1] & 0xfff0) === 0x0010 ||
      (words[1] & 0xfff0) === 0x0020)
  ) return false;
  // Teredo and the local-use NAT64 prefix are transition mechanisms whose
  // effective IPv4 destination cannot be validated from a plain string.
  if (words[0] === 0x2001 && words[1] === 0) return false;
  if (
    words[0] === 0x64 && words[1] === 0xff9b && words[2] === 1
  ) return false;
  const embedded = embeddedIpv4(words);
  if (embedded && !isPublicIpv4(embedded)) return false;
  return true;
}

function sourceForExactUrl(value: string): VerifiedSource {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch (_error) {
    throw new VerifiedDocsSecurityError('invalid_url');
  }
  if (
    parsed.protocol !== 'https:' ||
    parsed.username ||
    parsed.password ||
    parsed.port
  ) throw new VerifiedDocsSecurityError('unsafe_url');
  const source = SOURCES_BY_URL.get(parsed.href);
  if (!source) throw new VerifiedDocsSecurityError('url_not_allowlisted');
  return source;
}

async function validateResolvedTarget(
  url: string,
  resolveHost: ResolveHost,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<string[]> {
  const source = sourceForExactUrl(url);
  const hostname = new URL(source.url).hostname;
  const addresses = await runWithDeadline(
    operationSignal => resolveHost(hostname, operationSignal),
    timeoutMs,
    signal,
    'dns_timeout',
  );
  if (!Array.isArray(addresses) || addresses.length === 0) {
    throw new VerifiedDocsSecurityError('dns_no_addresses');
  }
  if (addresses.some(address => !isPublicNetworkAddress(address))) {
    throw new VerifiedDocsSecurityError('dns_private_address');
  }
  return addresses;
}

function runWithDeadline<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  signal: AbortSignal | undefined,
  timeoutCode: string,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const operationController = new AbortController();
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      signal?.removeEventListener('abort', abort);
      callback();
    };
    const abort = () => {
      operationController.abort(signal?.reason);
      finish(() => reject(
        signal?.reason instanceof Error ?
          signal.reason : new Error('Verified document operation cancelled'),
      ));
    };
    const timeout = setTimeout(() => {
      operationController.abort(new VerifiedDocsSecurityError(timeoutCode));
      finish(() => reject(new VerifiedDocsSecurityError(timeoutCode)));
    }, timeoutMs);
    if (signal?.aborted) {
      abort();
      return;
    }
    signal?.addEventListener('abort', abort, {once: true});
    operation(operationController.signal).then(
      value => finish(() => resolve(value)),
      error => finish(() => reject(error)),
    );
  });
}

async function discardResponseBody(response: FetchResponseLike): Promise<void> {
  try {
    await response.body?.getReader().cancel?.('response_not_consumed');
  } catch (_error) {
    // Closing a response is best effort; the validation outcome is unchanged.
  }
}

function headerValue(headers: FetchHeadersLike, name: string): string | undefined {
  return cleanOptionalHeader(headers.get(name));
}

async function readLimitedBody(
  response: FetchResponseLike,
  maximumBytes: number,
): Promise<string> {
  const declaredLength = Number(headerValue(response.headers, 'content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) {
    throw new VerifiedDocsSecurityError('response_too_large');
  }
  if (response.body?.getReader) {
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    let complete = false;
    while (!complete) {
      const {done, value} = await reader.read();
      if (done) {
        complete = true;
        continue;
      }
      if (!value) continue;
      total += value.byteLength;
      if (total > maximumBytes) {
        await reader.cancel?.('response_too_large').catch(() => undefined);
        throw new VerifiedDocsSecurityError('response_too_large');
      }
      chunks.push(value);
    }
    return Buffer.concat(chunks.map(chunk => Buffer.from(chunk))).toString('utf8');
  }
  if (response.arrayBuffer) {
    const body = Buffer.from(await response.arrayBuffer());
    if (body.byteLength > maximumBytes) {
      throw new VerifiedDocsSecurityError('response_too_large');
    }
    return body.toString('utf8');
  }
  if (response.text) {
    const body = await response.text();
    if (Buffer.byteLength(body, 'utf8') > maximumBytes) {
      throw new VerifiedDocsSecurityError('response_too_large');
    }
    return body;
  }
  throw new VerifiedDocsSecurityError('response_body_unavailable');
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&', apos: "'", gt: '>', hellip: '\u2026', laquo: '\u00ab',
  ldquo: '\u201c', lt: '<', nbsp: ' ', ndash: '\u2013', quot: '"',
  raquo: '\u00bb', rdquo: '\u201d', mdash: '\u2014',
};

function decodeHtmlEntities(value: string): string {
  return value.replace(
    /&(#x[0-9a-f]+|#\d+|[a-z]+);/gi,
    (_entity, code: string) => {
      if (code[0] === '#') {
        const hex = code[1].toLowerCase() === 'x';
        const valueToParse = code.slice(hex ? 2 : 1);
        const numeric = Number.parseInt(valueToParse, hex ? 16 : 10);
        if (!Number.isFinite(numeric) || numeric <= 0 || numeric > 0x10ffff) {
          return ' ';
        }
        try {
          return String.fromCodePoint(numeric);
        } catch (_error) {
          return ' ';
        }
      }
      return NAMED_ENTITIES[code.toLowerCase()] ?? ' ';
    },
  );
}

export function sanitizePlainText(value: string): string {
  const withoutControls = Array.from(String(value || ''), character => {
    const code = character.charCodeAt(0);
    return (code <= 8 || code === 11 || code === 12 ||
      (code >= 14 && code <= 31) || code === 127) ? ' ' : character;
  }).join('');
  return withoutControls
    .replace(/[\u202a-\u202e\u2066-\u2069]/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function sanitizeVerifiedHtml(html: string): string {
  const withoutDangerousBlocks = String(html || '')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(
      /<(script|style|noscript|iframe|object|embed|svg|canvas|template|form)\b[\s\S]*?<\/\1\s*>/gi,
      ' ',
    )
    .replace(
      /<(script|style|noscript|iframe|object|embed|svg|canvas|template|form)\b[^>]*>[\s\S]*$/gi,
      ' ',
    )
    .replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/section|\/article|\/tr)\b[^>]*>/gi, '\n')
    .replace(/<li\b[^>]*>/gi, '\n- ')
    .replace(/<[^>]+>/g, ' ');
  return sanitizePlainText(decodeHtmlEntities(withoutDangerousBlocks));
}

function truncateUtf8(value: string, maximumBytes: number): string {
  if (Buffer.byteLength(value, 'utf8') <= maximumBytes) return value;
  let low = 0;
  let high = value.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(value.slice(0, middle), 'utf8') <= maximumBytes) {
      low = middle;
    } else {
      high = middle - 1;
    }
  }
  return value.slice(0, low).replace(/\s+$/, '');
}

interface FetchDocumentResult {
  notModified: boolean;
  document?: VerifiedDocumentSnapshot;
}

export class VerifiedDocsService {
  private readonly store: VerifiedDocsStore;
  private readonly fetchImpl: VerifiedDocsFetch;
  private readonly resolveHost: ResolveHost;
  private readonly now: () => Date;
  private readonly timeoutMs: number;
  private readonly maximumResponseBytes: number;
  private readonly maximumSanitizedChars: number;
  private readonly maximumRedirects: number;

  constructor(options: VerifiedDocsServiceOptions = {}) {
    this.store = options.store || new FileVerifiedDocsStore();
    this.fetchImpl = options.fetchImpl || defaultFetch;
    this.resolveHost = options.resolveHost || defaultResolveHost;
    this.now = options.now || (() => new Date());
    this.timeoutMs = Math.max(100, Math.min(60000, options.timeoutMs ?? 10000));
    this.maximumResponseBytes = Math.max(
      1024,
      Math.min(5 * 1024 * 1024, options.maximumResponseBytes ?? 1024 * 1024),
    );
    this.maximumSanitizedChars = Math.max(
      1024,
      Math.min(1024 * 1024, options.maximumSanitizedChars ?? 262144),
    );
    this.maximumRedirects = Math.max(
      0,
      Math.min(3, options.maximumRedirects ?? 2),
    );
  }

  private async fetchWithDeadline(
    url: string,
    headers: Record<string, string>,
    resolvedAddresses: string[],
    upstreamSignal?: AbortSignal,
  ): Promise<{response: FetchResponseLike; release: () => void}> {
    const controller = new AbortController();
    const abortFromParent = () => controller.abort(upstreamSignal?.reason);
    if (upstreamSignal?.aborted) abortFromParent();
    upstreamSignal?.addEventListener('abort', abortFromParent, {once: true});
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      clearTimeout(timeout);
      upstreamSignal?.removeEventListener('abort', abortFromParent);
    };
    try {
      const response = await this.fetchImpl(url, {
        method: 'GET',
        headers,
        redirect: 'manual',
        signal: controller.signal,
        resolvedAddresses,
      });
      return {response, release};
    } catch (error) {
      release();
      throw error;
    }
  }

  private async fetchDocument(
    source: VerifiedSource,
    previous: VerifiedDocumentSnapshot | undefined,
    upstreamSignal?: AbortSignal,
  ): Promise<FetchDocumentResult> {
    let currentUrl = source.url;
    const visited = new Set<string>();
    for (let redirectCount = 0; redirectCount <= this.maximumRedirects;
      redirectCount++) {
      if (visited.has(currentUrl)) {
        throw new VerifiedDocsSecurityError('redirect_loop');
      }
      visited.add(currentUrl);
      sourceForExactUrl(currentUrl);
      const resolvedAddresses = await validateResolvedTarget(
        currentUrl,
        this.resolveHost,
        this.timeoutMs,
        upstreamSignal,
      );
      const headers: Record<string, string> = {
        Accept: 'text/html, text/plain;q=0.9',
        'User-Agent': 'demodesk-SupportBot-VerifiedDocs/1.0',
      };
      if (previous?.etag) headers['If-None-Match'] = previous.etag;
      if (previous?.lastModified) {
        headers['If-Modified-Since'] = previous.lastModified;
      }
      const {response, release} = await this.fetchWithDeadline(
        currentUrl,
        headers,
        resolvedAddresses,
        upstreamSignal,
      );
      try {
        if (response.status === 304) {
          await discardResponseBody(response);
          if (!previous) throw new VerifiedDocsSecurityError('unexpected_304');
          return {
            notModified: true,
            document: {
              ...previous,
              // A successful conditional request proves that the cached copy
              // is still current; otherwise an unchanged page becomes stale
              // forever even though it is checked every six hours.
              fetchedAt: this.now().toISOString(),
            },
          };
        }
        if ([301, 302, 303, 307, 308].includes(response.status)) {
          await discardResponseBody(response);
          if (redirectCount >= this.maximumRedirects) {
            throw new VerifiedDocsSecurityError('too_many_redirects');
          }
          const location = headerValue(response.headers, 'location');
          if (!location) {
            throw new VerifiedDocsSecurityError('redirect_without_location');
          }
          const destination = new URL(location, currentUrl).href;
          const redirectedSource = sourceForExactUrl(destination);
          if (redirectedSource.sourceId !== source.sourceId) {
            throw new VerifiedDocsSecurityError('cross_source_redirect');
          }
          currentUrl = destination;
          continue;
        }
        if (response.status !== 200) {
          await discardResponseBody(response);
          throw new VerifiedDocsSecurityError(`http_${response.status}`);
        }
        const contentType = (
          headerValue(response.headers, 'content-type') || ''
        ).split(';', 1)[0].trim().toLowerCase();
        if (contentType !== 'text/html' && contentType !== 'text/plain') {
          await discardResponseBody(response);
          throw new VerifiedDocsSecurityError('unsupported_content_type');
        }
        const body = await readLimitedBody(response, this.maximumResponseBytes);
        const sanitized = contentType === 'text/html' ?
          sanitizeVerifiedHtml(body) : sanitizePlainText(body);
        if (!sanitized) throw new VerifiedDocsSecurityError('empty_document');
        return {
          notModified: false,
          document: {
            sourceId: source.sourceId,
            title: source.title,
            url: source.url,
            text: sanitized.slice(0, this.maximumSanitizedChars),
            fetchedAt: this.now().toISOString(),
            etag: headerValue(response.headers, 'etag'),
            lastModified: headerValue(response.headers, 'last-modified'),
          },
        };
      } finally {
        release();
      }
    }
    throw new VerifiedDocsSecurityError('too_many_redirects');
  }

  async sync(signal?: AbortSignal): Promise<VerifiedDocsSyncResult> {
    const snapshot = canonicalizeSnapshot(await this.store.load());
    const statuses: VerifiedDocumentSyncStatus[] = [];
    let changed = false;
    let snapshotTouched = false;
    for (const source of VERIFIED_SOURCE_REGISTRY) {
      if (signal?.aborted) {
        throw signal.reason instanceof Error ?
          signal.reason : new Error('Verified document sync cancelled');
      }
      const previous = snapshot.documents[source.sourceId];
      try {
        const result = await this.fetchDocument(source, previous, signal);
        if (result.notModified) {
          if (result.document) {
            snapshot.documents[source.sourceId] = result.document;
            snapshotTouched = true;
          }
          statuses.push({
            sourceId: source.sourceId,
            status: 'not_modified',
            usedLastGoodSnapshot: true,
          });
        } else if (result.document) {
          snapshot.documents[source.sourceId] = result.document;
          changed = true;
          snapshotTouched = true;
          statuses.push({
            sourceId: source.sourceId,
            status: 'updated',
            usedLastGoodSnapshot: false,
          });
        }
      } catch (error) {
        if (signal?.aborted) {
          throw signal.reason instanceof Error ?
            signal.reason : new Error('Verified document sync cancelled');
        }
        statuses.push({
          sourceId: source.sourceId,
          status: 'failed',
          usedLastGoodSnapshot: !!previous,
          errorCode: error instanceof VerifiedDocsSecurityError ?
            error.code : 'fetch_failed',
        });
      }
    }
    if (snapshotTouched) {
      snapshot.updatedAt = this.now().toISOString();
      await this.store.save(snapshot);
    }
    return {
      changed,
      documentsAvailable: Object.keys(snapshot.documents).length,
      statuses,
    };
  }

  async search(
    query: string,
    options: {
      limit?: number;
      maximumSnippetBytes?: number;
      categories?: Array<'support' | 'legal'>;
    } = {},
    signal?: AbortSignal,
  ): Promise<VerifiedDocsSearchResponse> {
    if (signal?.aborted) {
      throw signal.reason instanceof Error ?
        signal.reason : new Error('Verified document search cancelled');
    }
    const cleanQuery = sanitizePlainText(query).slice(0, 500);
    if (!cleanQuery) return {query: '', results: [], totalSnippetBytes: 0};
    const snapshot = canonicalizeSnapshot(await this.store.load());
    if (signal?.aborted) {
      throw signal.reason instanceof Error ?
        signal.reason : new Error('Verified document search cancelled');
    }
    const allowedCategories = options.categories ?
      new Set(options.categories) : undefined;
    const documents = Object.values(snapshot.documents).filter(document => {
      const source = SOURCES_BY_ID.get(document.sourceId);
      return !!source && (
        !allowedCategories || allowedCategories.has(source.category)
      );
    });
    if (documents.length === 0) {
      return {query: cleanQuery, results: [], totalSnippetBytes: 0};
    }
    const limit = Math.max(1, Math.min(3, options.limit ?? 3));
    const byteLimit = Math.max(
      256,
      Math.min(16 * 1024, options.maximumSnippetBytes ?? 16 * 1024),
    );
    const retriever = new LexicalRetriever(verifiedDocumentsToLexical(documents));
    const ranked = retriever.search(cleanQuery, {
      limit,
      minimumScore: 0.05,
      snippetLength: Math.min(4096, byteLimit),
      kinds: ['verified_document'],
    });
    let remainingBytes = byteLimit;
    const nowMs = this.now().getTime();
    const results: VerifiedDocsSearchResult[] = [];
    for (const result of ranked) {
      if (remainingBytes <= 0) break;
      const snapshotDocument = snapshot.documents[result.source];
      const source = SOURCES_BY_ID.get(result.source);
      if (!snapshotDocument || !source) continue;
      const snippet = truncateUtf8(result.snippet, remainingBytes);
      if (!snippet) continue;
      const snippetBytes = Buffer.byteLength(snippet, 'utf8');
      remainingBytes -= snippetBytes;
      results.push({
        sourceId: source.sourceId,
        title: source.title,
        url: source.url,
        snippet,
        score: result.score,
        fetchedAt: snapshotDocument.fetchedAt,
        stale: nowMs - Date.parse(snapshotDocument.fetchedAt) > source.maxAgeMs,
      });
    }
    return {
      query: cleanQuery,
      results,
      totalSnippetBytes: byteLimit - remainingBytes,
    };
  }
}
