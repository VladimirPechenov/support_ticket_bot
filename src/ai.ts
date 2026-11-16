import {createHash, randomBytes} from 'crypto';
import cache from './cache';
import * as middleware from './middleware';
import {
  Context,
  AiConfig,
  AiSession,
  AiAnswerMode,
  AiRuntimeMode,
} from './interfaces';
import { getTicketById } from './tickets';
import { logger } from './logger';
import {requestLlm, LlmResult} from './ai-client';
import {
  recordAiAnswer,
  recordAiFeedback,
  recordAiHandoff,
  recordLlmResult,
  recordProviderAttemptMetric,
  recordRagResult,
  recordToolMetric,
} from './ai-metrics';
import {selectDirectRagAnswer} from './rag-fallback';
import {rankRagDocuments} from './rag-ranking';
import {
  buildRetrievalQuery,
  selectRelevantHistory,
} from './conversation-context';
import {embedGeminiText, GeminiEmbeddingError} from './gemini-embeddings';
import {embedMistralText, MistralEmbeddingError} from './mistral-embeddings';
import {
  createLocalLexicalRetriever,
  LexicalRetriever,
} from './lexical-retriever';
import {runSupportAgent, AgentDocument} from './agent-graph';
import {
  FULL_KNOWLEDGE_INPUT_TOKENS,
  FULL_KNOWLEDGE_RESPONSE_SCHEMA,
  loadFullKnowledgeBase,
  runFullKnowledgeAgent,
} from './full-knowledge-agent';
import {
  FileVerifiedDocsStore,
  VerifiedDocsService,
} from './verified-docs';
import {ToolRegistry} from './tool-registry';
import {normalizeSupportLinks} from './support-links';
import {
  DirectProviderName,
  getProviderRuntimeState,
  restoreProviderRuntimeState,
} from './ai-provider';
import {
  evaluateAiSlo,
  recordDependencyStatus,
  recordProviderRun,
  recordQuotaRatio,
} from './operational-alerts';
import * as db from './db';
import {
  buildStaffCardKeyboard,
  createStaffTurnCard,
  StaffTurnCard,
  updateStaffTurnCard,
} from './staff-card';

const DEFAULT_HANDOFF_KEYWORDS = [
  'operator',
  'human',
  'support',
  'agent',
  '/operator',
  '/human',
  '/support',
];

const DEFAULT_SYSTEM_PROMPT =
  "Вы — ассистент поддержки. Отвечайте только по предоставленным фактам. При недостатке данных задайте уточняющий вопрос или передайте обращение оператору. Не выдумывайте цены, функции, сроки или действия с аккаунтом. Для поискового режима укажите источники в первой строке [SOURCES: id1, id2]. Если нужен оператор, верните [NEEDS_HUMAN].";

const DEFAULT_HANDOFF_USER_MESSAGE =
  'Вопрос передан специалисту.';
const DEFAULT_HANDOFF_STAFF_MESSAGE = 'Требуется специалист';
const DEFAULT_STAFF_STOP_USER_MESSAGE =
  'Вопрос передан специалисту.';
const SLOW_PROCESSING_MESSAGE_MS = 10000;
const activeAiHandlers = new Set<Promise<boolean>>();
let aiShutdownInProgress = false;

const DEFAULT_PROCESSING_MESSAGES = [
  '⏳ Читаем ваш вопрос...',
  '🔍 Ищем ответ в базе знаний...',
  '💭 Команда demodesk сейчас поможет вам...',
  '🚀 Уже обрабатываем запрос...',
  '⚡ Один момент, проверяем информацию...',
  '🤔 Секунду, думаем над ответом...',
];

const DEFAULT_OFF_TOPIC_WARNING =
  'Похоже, вопрос не относится к нашему сервису demodesk. ' +
  'Пожалуйста, задавайте вопросы, связанные с сервис и нашим сервисом.';

interface RagDoc {
  id?: string;
  text: string;
  source?: string;
  title?: string;
  url?: string;
  aliases?: string[];
  tags?: string[];
  score?: number;
  denseScore?: number;
  lexicalScore?: number;
  hybridScore?: number;
  fusedScore?: number;
  denseRank?: number;
  lexicalRank?: number;
  exactAlias?: boolean;
  lexicalEvidence?: boolean;
}

interface RagResult {
  context: string;
  docs: RagDoc[];
  hasContext: boolean;
  confidence: number;
  exactMatch?: boolean;
  retrievalMode?: 'hybrid' | 'lexical';
  backendError?: string;
}

interface ActiveTurnOwner {
  runId: string;
  controller: AbortController;
}

interface UserMessageDelivery {
  delivered: boolean;
  editedMessageId?: number;
  sentMessageIds: number[];
}

type OwnedDeliveryResult = 'delivered' | 'stale' | 'failed';

function ownsActiveTurn(
  session: AiSession,
  owner: ActiveTurnOwner,
): boolean {
  return !session.disabled &&
    !owner.controller.signal.aborted &&
    session.runId === owner.runId &&
    session.abortController === owner.controller;
}

function invalidateActiveTurn(session: AiSession, reason: string): boolean {
  const controller = session.abortController;
  if (!controller) return false;
  controller.abort(reason);
  if (session.abortController === controller) {
    session.abortController = undefined;
    // Ownership is the run ID plus the controller. Rotate both so even code
    // that is already returning from an uncancellable Telegram request cannot
    // commit a terminal result for the old run.
    session.runId = randomBytes(8).toString('hex');
  }
  return true;
}

function cancelActiveAiRuns(reason = 'runtime_policy_changed'): number {
  let cancelled = 0;
  for (const session of Object.values(cache.aiSessions || {})) {
    const controller = session.abortController;
    if (!controller || controller.signal.aborted) continue;
    // Keep the ownership tuple long enough for runtime-policy changes to turn
    // the current question into an operator handoff. Shutdown is different:
    // invalidate ownership immediately because the process must not begin any
    // compensating Telegram delivery while it is being replaced.
    controller.abort(reason);
    if (reason === 'shutdown' && session.abortController === controller) {
      session.abortController = undefined;
      session.runId = randomBytes(8).toString('hex');
    }
    cancelled++;
  }
  if (cancelled > 0) {
    logger.info('cancelActiveAiRuns', 'Active AI runs cancelled', {
      reason,
      count: cancelled,
    });
  }
  return cancelled;
}

function setAiShutdownState(shuttingDown: boolean): number {
  aiShutdownInProgress = shuttingDown;
  return shuttingDown ? cancelActiveAiRuns('shutdown') : 0;
}

function isAiShutdownInProgress(): boolean {
  return aiShutdownInProgress;
}

let lexicalRetriever: LexicalRetriever | undefined;
let verifiedDocsService: VerifiedDocsService | undefined;
let providerStateHydrated = false;

function getLexicalRetriever(): LexicalRetriever {
  if (!lexicalRetriever) lexicalRetriever = createLocalLexicalRetriever();
  return lexicalRetriever;
}

function getVerifiedDocsService(cfg: AiConfig | null): VerifiedDocsService {
  if (!verifiedDocsService) {
    verifiedDocsService = new VerifiedDocsService({
      store: new FileVerifiedDocsStore(
        cfg?.tools?.verified_docs?.cache_path ||
          process.env.VERIFIED_DOCS_CACHE_PATH,
      ),
    });
  }
  return verifiedDocsService;
}

function hydrateProviderState(): void {
  if (providerStateHydrated) return;
  providerStateHydrated = true;
  for (const state of db.getAiProviderStates()) {
    if (state.provider !== 'gemini' && state.provider !== 'mistral') continue;
    restoreProviderRuntimeState({
      provider: state.provider,
      circuitState: state.circuitState,
      consecutiveFailures: state.consecutiveFailures,
      openUntil: state.openUntil || undefined,
      quotaDate: state.quotaDate || new Date().toISOString().slice(0, 10),
      dailyRequests: state.dailyRequests,
      dailyTokens: state.dailyTokens,
    });
  }
}

function persistProviderState(lastErrors: Map<string, string>): void {
  for (const provider of ['gemini', 'mistral'] as DirectProviderName[]) {
    const state = getProviderRuntimeState(provider);
    db.saveAiProviderState({
      ...state,
      openUntil: state.openUntil || null,
      lastErrorReason: lastErrors.get(provider) || null,
    });
  }
}

function rolloutBucket(ticketId: string | number): number {
  const digest = createHash('sha256')
    .update(String(ticketId))
    .digest();
  // Map a full 32-bit hash uniformly to [0, 100). Using one byte modulo 100
  // over-admits the 5/25/50 canary cohorts because 256 is not divisible by 100.
  return Math.floor(digest.readUInt32BE(0) / 0x1_0000_0000 * 100);
}

function runtimeModeForTicket(
  ticketId: string | number,
  cfg: AiConfig,
  userId?: string | number,
): {mode: AiRuntimeMode; allowWebTool: boolean} {
  if (process.env.NODE_ENV === 'test') {
    return {
      mode: cfg.mode || 'full',
      allowWebTool: !!cfg.tools?.verified_docs?.enabled,
    };
  }
  const flags = db.getRuntimeFeatureFlags();
  const configuredMode = flags.aiMode;
  const aiRollout = flags.aiRolloutPercent;
  const webRollout = flags.webToolRolloutPercent;
  const bucket = rolloutBucket(ticketId);
  const staffAllowed = userId !== undefined &&
    (cfg.staff_allowlist || []).some(id => String(id) === String(userId));
  const admittedToAi = staffAllowed || bucket < aiRollout;
  // `web 0` is an absolute kill switch, including for the staff allowlist.
  // Above zero, staff remain an explicit pre-canary cohort.
  const admittedToWeb = webRollout > 0 &&
    (staffAllowed || bucket < webRollout);
  return {
    mode: admittedToAi ? configuredMode : 'off',
    allowWebTool:
      admittedToAi &&
      configuredMode === 'full' &&
      cfg.tools?.verified_docs?.enabled === true &&
      admittedToWeb,
  };
}

function getAiConfig(): AiConfig | null {
  const configExists = !!cache.config;
  const aiExists = configExists && !!cache.config.ai;
  const aiEnabled = aiExists && cache.config.ai.enabled;
  logger.debug('getAiConfig', 'AI configuration checked', {
    configExists,
    aiExists,
    aiEnabled,
  });
  return cache.config && cache.config.ai ? cache.config.ai : null;
}

function isAiEnabled(): boolean {
  const cfg = getAiConfig();
  return !!(cfg && cfg.enabled);
}

function ensureSession(ticket: any): AiSession {
  if (!cache.aiSessions) {
    cache.aiSessions = {} as any;
  }
  const ticketId = ticket.id.toString();
  let session = cache.aiSessions[ticketId];
  // Parse userId properly - handle both numbers and strings with .0 artifact
  const parsedUserId = typeof ticket.userid === 'number'
    ? ticket.userid
    : (String(ticket.userid).includes('.')
        ? Math.floor(Number(ticket.userid))
        : Number(ticket.userid));
  const persistedDisabled =
    ticket.ai_enabled === 0 ||
    ticket.stage === 'waiting_operator' ||
    ticket.stage === 'in_progress' ||
    ticket.status === 'closed';

  if (!session) {
    const maxPairs = cache.config.ai?.max_history_messages ?? 6;
    const persistedHistory = db.getAiConversationHistory(ticketId, maxPairs * 2)
      .map(message => ({role: message.role, content: message.content}));
    session = {
      ticketId,
      userId: parsedUserId,
      disabled: persistedDisabled,
      history: persistedHistory,
    };
    cache.aiSessions[ticketId] = session;
  } else {
    session.userId = parsedUserId;
    // Persisted operator ownership always wins over stale process memory.
    // Explicit resume updates SQLite before it clears this flag.
    if (persistedDisabled) session.disabled = true;
  }
  return session;
}

function getSession(ticketId: string): AiSession | undefined {
  if (!cache.aiSessions) return undefined;
  return cache.aiSessions[ticketId];
}

function escapeTelegramMarkdown(text: string, characters: string): string {
  const special = new Set(Array.from(characters));
  return Array.from(text, character =>
    special.has(character) ? `\\${character}` : character,
  ).join('');
}

function sanitizeTextForParseMode(text: string, parseMode?: string): string {
  if (!parseMode || parseMode.toLowerCase() === 'none') {
    return text;
  }

  const mode = parseMode.toLowerCase();

  // For HTML mode - escape HTML special characters
  if (mode === 'html') {
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  // Escaping must never delete or rewrite characters after the graph has
  // validated URLs. In particular, deleting `_` could turn `tg_://...` into
  // an actionable `tg://...` link after the allowlist check.
  if (mode === 'markdownv2') {
    return escapeTelegramMarkdown(text, '_-*[]()~`>#+=|{}.!\\');
  }
  if (mode === 'markdown') {
    return escapeTelegramMarkdown(text, '_*[]`\\');
  }

  return text;
}

function splitMessage(text: string, maxLen = 3500): string[] {
  // Just split by length, don't remove greeting templates
  // Greetings should be shown to user to appear friendly
  const parts: string[] = [];
  let remaining = text.trim();

  while (remaining.length > maxLen) {
    let slice = remaining.slice(0, maxLen);
    const lastBreak = Math.max(slice.lastIndexOf('\n'), slice.lastIndexOf(' '));
    if (lastBreak > 200) {
      slice = slice.slice(0, lastBreak);
    }
    parts.push(slice);
    remaining = remaining.slice(slice.length).replace(/^\s+/, '');
  }
  if (remaining.length > 0) {
    parts.push(remaining);
  }
  return parts;
}

function buildUserFeedbackKeyboard(
  ticketId: string,
  answerId: string,
  cfg: AiConfig | null,
) {
  if (cfg?.user_feedback?.enabled === false) return {};
  return {
    reply_markup: {
      inline_keyboard: [
        [
          {
            text:
              cfg?.user_feedback?.helpful_button_text || 'Помогло',
            callback_data: `AI_HELPFUL---${ticketId}---${answerId}`,
          },
          {
            text:
              cfg?.user_feedback?.operator_button_text || '👤 Нужен оператор',
            callback_data: `AI_OPERATOR---${ticketId}---${answerId}`,
          },
        ],
      ],
    },
  };
}

async function editOrSendUserMessage(
  chatId: string | number,
  messageId: number | null,
  text: string,
  cfg: AiConfig | null,
  ticketId?: string,
  answerId?: string,
  guard?: () => boolean,
): Promise<UserMessageDelivery> {
  const delivery: UserMessageDelivery = {
    delivered: false,
    sentMessageIds: [],
  };
  if (guard && !guard()) return delivery;
  const parseMode = cfg?.user_parse_mode;
  const sanitized = sanitizeTextForParseMode(
    normalizeSupportLinks(text),
    parseMode,
  );
  const extra: any = parseMode && parseMode.toLowerCase() !== 'none' ?
    {parse_mode: parseMode} : {};
  if (ticketId && answerId) {
    Object.assign(extra, buildUserFeedbackKeyboard(ticketId, answerId, cfg));
  }
  if (messageId) {
    try {
      await cache.bot.api.editMessageText(chatId, messageId, sanitized, extra);
      void recordDependencyStatus('telegram', true);
      delivery.delivered = true;
      delivery.editedMessageId = messageId;
      return delivery;
    } catch (error) {
      void recordDependencyStatus('telegram', false);
      logger.debug('editOrSendUserMessage', 'Processing message edit failed', {
        ticketId,
        messageId,
      });
    }
  }
  if (guard && !guard()) return delivery;
  return sendUserMessage(chatId, text, cfg, ticketId, answerId, guard);
}

async function sendUserMessage(
  chatId: string | number,
  text: string,
  cfg: AiConfig | null,
  ticketId?: string,
  answerId?: string,
  guard?: () => boolean,
): Promise<UserMessageDelivery> {
  const delivery: UserMessageDelivery = {
    delivered: false,
    sentMessageIds: [],
  };
  const parseMode = cfg?.user_parse_mode;
  const sanitized = sanitizeTextForParseMode(
    normalizeSupportLinks(text),
    parseMode,
  );
  const extra =
    parseMode && parseMode.toLowerCase() !== 'none' ?
      { parse_mode: parseMode } :
      { parse_mode: 'none' }; // Explicitly set to 'none' to avoid default parsing
  const chunks = splitMessage(sanitized);
  for (let i = 0; i < chunks.length; i++) {
    if (guard && !guard()) return delivery;
    const chunk = chunks[i];
    const finalExtra =
      ticketId && answerId && i === chunks.length - 1 ?
        {...extra, ...buildUserFeedbackKeyboard(ticketId, answerId, cfg)} :
        extra;
    const sent = await middleware.msg(chatId, chunk, finalExtra);
    if (sent === null) return delivery;
    if (Number.isInteger(sent?.message_id)) {
      delivery.sentMessageIds.push(sent.message_id);
    }
    delivery.delivered = true;
  }
  return delivery;
}

async function retractStaleUserDelivery(
  chatId: string | number,
  delivery: UserMessageDelivery,
  session: AiSession,
  cfg: AiConfig | null,
  replacementOverride?: string,
): Promise<void> {
  const replacement = replacementOverride || (
    session.disabled ?
      (cfg?.handoff?.user_message_staff_stop ||
        DEFAULT_STAFF_STOP_USER_MESSAGE) :
      'Обрабатываю ваше более новое сообщение.'
  );
  const parseMode = cfg?.user_parse_mode;
  const sanitized = sanitizeTextForParseMode(replacement, parseMode);
  const extra: any = parseMode && parseMode.toLowerCase() !== 'none' ?
    {parse_mode: parseMode} : {};
  const api = cache.bot?.api as any;

  if (delivery.editedMessageId && api?.editMessageText) {
    try {
      await api.editMessageText(
        chatId,
        delivery.editedMessageId,
        sanitized,
        extra,
      );
    } catch (_error) {
      logger.debug('retractStaleUserDelivery', 'Stale edited answer remained', {
        messageId: delivery.editedMessageId,
      });
    }
  }

  for (const messageId of delivery.sentMessageIds) {
    let removed = false;
    if (api?.deleteMessage) {
      try {
        await api.deleteMessage(chatId, messageId);
        removed = true;
      } catch (_error) {
        // Fall back to replacing the stale text when deletion is unavailable.
      }
    }
    if (!removed && api?.editMessageText) {
      try {
        await api.editMessageText(chatId, messageId, sanitized, extra);
      } catch (_error) {
        logger.debug('retractStaleUserDelivery', 'Stale sent answer remained', {
          messageId,
        });
      }
    }
  }
}

async function deliverOwnedUserMessage(
  session: AiSession,
  owner: ActiveTurnOwner,
  chatId: string | number,
  messageId: number | null,
  text: string,
  cfg: AiConfig | null,
  ticketId?: string,
  answerId?: string,
): Promise<OwnedDeliveryResult> {
  const guard = () => ownsActiveTurn(session, owner);
  if (!guard()) return 'stale';
  const delivery = await editOrSendUserMessage(
    chatId,
    messageId,
    text,
    cfg,
    ticketId,
    answerId,
    guard,
  );
  if (!guard()) {
    await retractStaleUserDelivery(chatId, delivery, session, cfg);
    return 'stale';
  }
  return delivery.delivered ? 'delivered' : 'failed';
}

function hasKeyword(text: string, keywords: string[]) {
  const normalized = text.toLowerCase();
  return keywords.some((keyword) => normalized.includes(keyword.toLowerCase()));
}

function shouldHandoffByUserRequest(text: string, cfg: AiConfig | null) {
  const keywords = cfg?.handoff?.keywords || DEFAULT_HANDOFF_KEYWORDS;
  return hasKeyword(text, keywords);
}

function getRandomProcessingMessage(cfg: AiConfig | null): string {
  const messages = cfg?.processing_messages || DEFAULT_PROCESSING_MESSAGES;
  return messages[Math.floor(Math.random() * messages.length)];
}

function slowProcessingMessageDelayMs(): number {
  if (process.env.NODE_ENV !== 'test') return SLOW_PROCESSING_MESSAGE_MS;
  const testDelay = Number(process.env.AI_TEST_SLOW_MESSAGE_DELAY_MS);
  return Number.isFinite(testDelay) && testDelay >= 0 ?
    testDelay : SLOW_PROCESSING_MESSAGE_MS;
}

function isObviousOffTopic(text: string, cfg: AiConfig | null): boolean {
  const offTopicCfg = cfg?.off_topic;
  const supportKeywords = [
    'аккаунт', 'подпис', 'оплат', 'вход', 'парол', 'ссылк', 'ошибк', 'сервис', 'подключ',
  ];
  if (hasKeyword(text, supportKeywords)) return false;
  const offTopicKeywords = offTopicCfg?.keywords || [
    'день рождения', 'погода', 'рецепт', 'готовка', 'кто президент',
    'расскажи анекдот', 'расскажи шутку', 'стихотворение', 'стишок',
    'результат матча',
  ];
  return hasKeyword(text, offTopicKeywords);
}

export async function fetchJsonWithTimeout(
  url: string,
  options: any,
  timeoutMs: number,
  parentSignal?: AbortSignal,
): Promise<{response: any; body?: any}> {
  const controller = new AbortController();
  const abort = () => controller.abort(parentSignal?.reason);
  if (parentSignal?.aborted) abort();
  else parentSignal?.addEventListener('abort', abort, {once: true});
  const id = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
    });
    if (!response.ok) {
      // The caller needs only the status for failures. Explicitly close the
      // body while the linked signal is still active so the connection cannot
      // linger after a takeover or deadline.
      await response.body?.cancel?.().catch(() => undefined);
      return {response};
    }
    // Keep the timeout and parent abort listener until the complete response
    // body has been consumed. `fetch()` resolves at headers, not at EOF.
    return {response, body: await response.json()};
  } finally {
    clearTimeout(id);
    parentSignal?.removeEventListener('abort', abort);
  }
}

function joinUrl(endpoint: string, path: string) {
  let base = endpoint || '';
  if (base.endsWith('/')) {
    base = base.slice(0, -1);
  }
  if (!path.startsWith('/')) {
    return base + '/' + path;
  }
  return base + path;
}

async function embedText(
  text: string,
  cfg: AiConfig | null,
  signal?: AbortSignal,
): Promise<number[] | null> {
  const emb = cfg?.embeddings || {};
  const provider = emb.provider || 'mistral';
  if (!['gemini', 'mistral'].includes(provider) || !emb.model) {
    logger.error('embedText', 'Direct embeddings are not configured');
    void recordDependencyStatus('embeddings', false);
    return null;
  }
  const startedAt = Date.now();
  try {
    const embeddingConfig = {
      model: emb.model,
      dimensions: emb.dimensions,
      timeoutMs: emb.timeout_ms || 10000,
    };
    const result = provider === 'mistral' ?
      await embedMistralText(text, embeddingConfig, signal) :
      await embedGeminiText(
        text, embeddingConfig, 'RETRIEVAL_QUERY', signal,
      );
    logger.debug('embedText', 'Embedding request completed', {
      provider,
      model: emb.model,
      vectorLength: result.length,
      latencyMs: Date.now() - startedAt,
    });
    void recordDependencyStatus('embeddings', true);
    return result;
  } catch (error) {
    logger.warn('embedText', 'Embedding request failed', {
      provider,
      model: emb.model,
      status: error instanceof GeminiEmbeddingError ||
        error instanceof MistralEmbeddingError ? error.status : undefined,
      latencyMs: Date.now() - startedAt,
      reason: signal?.aborted ? 'cancelled' : 'provider_error',
    });
    void recordDependencyStatus('embeddings', false);
    return null;
  }
}

function retrieveLexicalRagContext(
  query: string,
  cfg: AiConfig | null,
  backendError?: string,
): RagResult {
  try {
    const qdrant = cfg?.rag?.qdrant || {};
    const results = getLexicalRetriever().search(query, {
      limit: qdrant.max_context_docs || qdrant.top_k || 3,
      minimumScore: qdrant.lexical_context_threshold ?? 1.2,
      snippetLength: qdrant.max_doc_chars || 1600,
      kinds: ['knowledge_base'],
    });
    const minimumCoverage = qdrant.minimum_query_coverage ?? 0.34;
    const docs: RagDoc[] = results
      .filter(result => result.exactMatch || result.coverage >= minimumCoverage)
      .map((result, index) => {
        const lexicalConfidence = result.exactMatch ? 1 : Math.min(0.95,
          result.coverage * 0.65 +
          (1 - Math.exp(-result.score / 4)) * 0.35,
        );
        return {
          id: result.id,
          text: result.text,
          source: result.source,
          title: result.title,
          aliases: result.aliases,
          tags: result.tags,
          score: lexicalConfidence,
          fusedScore: lexicalConfidence,
          hybridScore: lexicalConfidence,
          lexicalScore: lexicalConfidence,
          lexicalRank: index + 1,
          exactAlias: result.exactMatch,
          lexicalEvidence: true,
        };
      });
    return {
      context: docs.map((doc, index) =>
        `Document ${index + 1}:\n${doc.text}\n` +
        `Title: ${doc.title || ''}\nSource ID: ${doc.id || ''}`,
      ).join('\n\n'),
      docs,
      hasContext: docs.length > 0,
      confidence: docs[0]?.score || 0,
      exactMatch: !!docs[0]?.exactAlias,
      retrievalMode: 'lexical',
      backendError,
    };
  } catch (_error) {
    return {
      context: '',
      docs: [],
      hasContext: false,
      confidence: 0,
      retrievalMode: 'lexical',
      backendError: backendError || 'lexical_unavailable',
    };
  }
}

async function retrieveRagContext(
  query: string,
  cfg: AiConfig | null,
  signal?: AbortSignal,
): Promise<RagResult> {
  const rag = cfg?.rag || {};
  if (!rag.enabled) {
    return { context: '', docs: [], hasContext: false, confidence: 0 };
  }
  if ((rag.vector_db || 'qdrant').toLowerCase() !== 'qdrant') {
    logger.warn('retrieveRagContext', 'Unsupported vector database');
    void recordDependencyStatus('qdrant', false);
    return retrieveLexicalRagContext(query, cfg, 'qdrant_unsupported');
  }

  const qdrant = rag.qdrant || {};
  if (!qdrant.url || !qdrant.collection) {
    logger.warn('retrieveRagContext', 'Qdrant is not configured');
    void recordDependencyStatus('qdrant', false);
    return retrieveLexicalRagContext(query, cfg, 'qdrant_not_configured');
  }

  if (cfg?.embeddings?.enabled === false) {
    return retrieveLexicalRagContext(query, cfg, 'dense_disabled');
  }

  const vector = await embedText(query, cfg, signal);
  if (!vector) {
    logger.warn('retrieveRagContext', 'Query embedding is unavailable');
    return retrieveLexicalRagContext(query, cfg, 'embedding_unavailable');
  }

  const url = joinUrl(
    qdrant.url,
    `/collections/${qdrant.collection}/points/search`,
  );

  const headers: any = { 'Content-Type': 'application/json' };
  const qdrantApiKey = process.env.QDRANT_API_KEY;
  if (qdrantApiKey) {
    headers['api-key'] = qdrantApiKey;
  }

  const body: any = {
    vector,
    limit: qdrant.candidate_k || 53,
    with_payload: true,
  };

  try {
    const startedAt = Date.now();
    const {response, body: data} = await fetchJsonWithTimeout(
      url,
      {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      },
      15000,
      signal,
    );

    if (!response.ok) {
      logger.warn('retrieveRagContext', 'Qdrant search failed', {
        status: response.status,
        latencyMs: Date.now() - startedAt,
      });
      void recordDependencyStatus('qdrant', false);
      return retrieveLexicalRagContext(query, cfg, 'qdrant_unavailable');
    }

    void recordDependencyStatus('qdrant', true);

    const points = data.result || data.results || [];

    const textKey = qdrant.payload_text_key || 'answer';
    const sourceKey = qdrant.payload_source_key || 'source';
    const titleKey = qdrant.payload_title_key || 'title';

    const maxDocChars = qdrant.max_doc_chars || 1600;
    const maxContextDocs = qdrant.max_context_docs || qdrant.top_k || 4;
    const candidates: RagDoc[] = points
      .map((point: any) => {
        const payload = point.payload || {};
        return {
          id: payload.id ? String(payload.id) : undefined,
          intent: payload.intent ? String(payload.intent) : undefined,
          // `text`/`questions` keep the previous collection readable during
          // rollback. New indexes always use `answer`/`aliases`.
          text: String(
            payload[textKey] || payload.answer || payload.text || '',
          ).slice(0, maxDocChars),
          source: payload[sourceKey],
          title: payload[titleKey],
          aliases: Array.isArray(payload.aliases) ?
            payload.aliases.map((alias: any) => String(alias)) :
            (Array.isArray(payload.questions) ?
              payload.questions.map((question: any) => String(question)) :
              []),
          tags: Array.isArray(payload.tags) ?
            payload.tags.map((tag: any) => String(tag)) : [],
          denseScore: point.score,
        };
      })
      .filter((doc: RagDoc) => doc.text);
    const docs: RagDoc[] = rankRagDocuments(query, candidates, {
      rrfK: qdrant.rrf_k ?? 60,
      denseWeight: qdrant.dense_weight ?? 0.5,
      denseContextThreshold: qdrant.dense_context_threshold ?? 0.52,
      minimumQueryCoverage: qdrant.minimum_query_coverage ?? 0,
      maxDocuments: maxContextDocs,
    });

    logger.debug('retrieveRagContext', 'Qdrant search completed', {
      returnedPoints: points.length,
      acceptedDocuments: docs.length,
      topCandidates: docs.map((doc) => ({
        title: doc.title,
        denseScore: doc.denseScore,
        lexicalScore: doc.lexicalScore,
        fusedScore: doc.fusedScore,
        denseRank: doc.denseRank,
        lexicalRank: doc.lexicalRank,
      })),
      latencyMs: Date.now() - startedAt,
    });

    const context = docs
      .map((doc, index) => {
        const source = doc.id ? `Source ID: ${doc.id}` : '';
        const title = doc.title ? `Title: ${doc.title}` : '';
        const meta = [title, source].filter(Boolean).join('\n');
        return `Document ${index + 1}:\n${doc.text}` +
          (meta ? `\n${meta}` : '');
      })
      .join('\n\n');

    const confidence = docs[0]?.fusedScore || docs[0]?.score || 0;
    return {
      context,
      docs,
      hasContext: docs.length > 0,
      confidence,
      exactMatch: !!docs[0]?.exactAlias,
      retrievalMode: 'hybrid',
    };
  } catch (error) {
    logger.warn('retrieveRagContext', 'Qdrant request failed', {
      reason: signal?.aborted ? 'cancelled' : 'provider_error',
    });
    void recordDependencyStatus('qdrant', false);
    if (signal?.aborted) {
      return {
        context: '', docs: [], hasContext: false, confidence: 0,
        backendError: 'cancelled',
      };
    }
    return retrieveLexicalRagContext(query, cfg, 'qdrant_unavailable');
  }
}

function updateHistory(
  session: AiSession,
  userText: string,
  aiText: string,
  cfg: AiConfig | null,
  answerId?: string,
) {
  const last = session.history[session.history.length - 1];
  if (last?.role !== 'user' || last.content !== userText) {
    session.history.push({ role: 'user', content: userText });
    db.appendAiConversationMessage(session.ticketId, 'user', userText);
  }
  session.history.push({ role: 'assistant', content: aiText });
  db.appendAiConversationMessage(
    session.ticketId,
    'assistant',
    aiText,
    answerId ? `answer:${answerId}` : undefined,
  );
  const maxPairs = cfg?.max_history_messages ?? 6;
  const maxMessages = maxPairs * 2;
  if (session.history.length > maxMessages) {
    session.history = session.history.slice(-maxMessages);
  }
  db.trimAiConversationHistory(session.ticketId, maxMessages);
}

function rememberUserMessage(
  session: AiSession,
  userText: string,
  messageId: string | number | undefined,
  cfg: AiConfig | null,
): void {
  const inserted = db.appendAiConversationMessage(
    session.ticketId,
    'user',
    userText,
    messageId === undefined ? undefined : `telegram:${messageId}`,
  );
  const last = session.history[session.history.length - 1];
  if (inserted || last?.role !== 'user' || last.content !== userText) {
    session.history.push({role: 'user', content: userText});
  }
  const maxMessages = (cfg?.max_history_messages ?? 6) * 2;
  if (session.history.length > maxMessages) {
    session.history = session.history.slice(-maxMessages);
  }
  db.trimAiConversationHistory(session.ticketId, maxMessages);
}

function rememberAnswer(
  session: AiSession,
  mode: AiAnswerMode,
  rag: RagResult,
  model?: string,
  existingAnswerId?: string,
): string {
  const topDocument = rag.docs[0];
  const answerId = existingAnswerId || randomBytes(5).toString('hex');
  session.lastAnswer = {
    id: answerId,
    mode,
    sourceId: topDocument?.id,
    sourceTitle: topDocument?.title,
    denseScore: topDocument?.denseScore,
    lexicalScore: topDocument?.lexicalScore,
    hybridScore: topDocument?.hybridScore ?? topDocument?.score,
    model,
  };
  recordAiAnswer(mode);
  logger.info('handleUserMessage', 'AI answer selected', {
    ticketId: session.ticketId,
    answerId,
    mode,
    model,
    sourceTitle: session.lastAnswer.sourceTitle,
    sourceId: session.lastAnswer.sourceId,
    denseScore: session.lastAnswer.denseScore,
    lexicalScore: session.lastAnswer.lexicalScore,
    hybridScore: session.lastAnswer.hybridScore,
  });
  return answerId;
}

function isUncertainLlmAnswer(text: string, cfg: AiConfig | null): boolean {
  if (/^\[NEEDS_HUMAN\]/i.test(text.trim())) return true;
  const uncertainPhrases = cfg?.handoff?.uncertain_phrases || [];
  return uncertainPhrases.length > 0 && hasKeyword(text, uncertainPhrases);
}

export function appendVerifiedCitations(
  content: string,
  citations: Array<{title?: string; url?: string}>,
): string {
  const seen = new Set<string>();
  const sources = citations.filter(
    (citation): citation is {title?: string; url: string} => {
      if (!citation.url || seen.has(citation.url)) return false;
      seen.add(citation.url);
      return true;
    },
  ).slice(0, 3);
  if (sources.length === 0) return content.trim();
  const missing = sources.filter((source) => !content.includes(source.url));
  if (missing.length === 0) return content.trim();
  return `${content.trim()}\n\nПолезные ссылки:\n` +
    missing.map((source) =>
      `• ${source.title || 'Инструкция'} — ${source.url}`,
    ).join('\n');
}

function truncateEscapedHtml(value: string, maximumLength: number): string {
  const characters = Array.from(String(value || ''));
  const escapePrefix = (length: number) => sanitizeTextForParseMode(
    characters.slice(0, length).join(''),
    'HTML',
  );
  const complete = escapePrefix(characters.length);
  if (complete.length <= maximumLength) return complete;
  if (maximumLength <= 1) return '';
  let low = 0;
  let high = characters.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (escapePrefix(middle).length <= maximumLength - 1) low = middle;
    else high = middle - 1;
  }
  return `${escapePrefix(low)}…`;
}

export function buildStaffHandoffMessage(
  ticketId: string,
  user: { first_name: string },
  reason: string,
  userText: string,
  cfg: AiConfig | null,
) {
  const base = cfg?.handoff?.staff_message || DEFAULT_HANDOFF_STAFF_MESSAGE;
  const displayName = cache.config.anonymous_tickets ?
    'Анонимный пользователь' : user.first_name;
  let reasonText = '';
  if (reason === 'user_request') reasonText = 'пользователь запросил оператора';
  if (reason === 'no_context') reasonText = 'нет подходящей статьи';
  if (reason === 'low_confidence') reasonText = 'низкая уверенность';
  if (reason === 'llm_error') reasonText = 'ошибка модели';
  if (reason.startsWith('llm_')) {
    reasonText = `ошибка модели: ${reason.slice(4).replace(/_/g, ' ')}`;
  }
  if (reason === 'empty') reasonText = 'пустой ответ модели';
  if (reason === 'off_topic') reasonText = 'вопрос не по теме сервиса';

  const prefix = (
    `${truncateEscapedHtml(base, 512)}: ` +
    `#T${ticketId.toString().padStart(6, '0')} ` +
    `(${truncateEscapedHtml(displayName, 256)})\n` +
    (reasonText ?
      `Причина: ${truncateEscapedHtml(reasonText, 256)}\n` : '') +
    'Вопрос: '
  );
  // Stay below Telegram's 4096-character limit after escaping, without ever
  // cutting an HTML entity or a UTF-16 surrogate pair.
  return prefix + truncateEscapedHtml(userText, Math.max(0, 3900 - prefix.length));
}

async function handoffToHuman(
  ctx: Context,
  ticket: any,
  session: AiSession,
  cfg: AiConfig | null,
  userText: string,
  reason: string,
  owner: ActiveTurnOwner,
  staffCard: StaffTurnCard | null = null,
  processingMessageId: number | null = null,
  commitRun?: () => void,
  allowRuntimePolicyCancellation = false,
): Promise<boolean> {
  const runtimePolicyOwnership = allowRuntimePolicyCancellation &&
    session.runId === owner.runId &&
    session.abortController === owner.controller &&
    owner.controller.signal.aborted &&
    String(owner.controller.signal.reason || '').startsWith('runtime_');
  if (!ownsActiveTurn(session, owner) && !runtimePolicyOwnership) return false;

  const handoffRunId = randomBytes(8).toString('hex');
  owner.controller.abort(reason);
  if (session.abortController === owner.controller) {
    session.abortController = undefined;
  }
  session.disabled = true;
  session.lastHandoff = reason;
  session.runId = handoffRunId;
  commitRun?.();
  recordAiHandoff(reason);
  db.updateTicketState(ticket.id, {
    stage: 'waiting_operator',
    aiEnabled: false,
    handoffReason: reason,
  });
  db.recordTicketEvent(ticket.id, {
    eventType: 'handoff',
    actorType: 'system',
    reason,
  });

  const userMessage =
    cfg?.handoff?.user_message || DEFAULT_HANDOFF_USER_MESSAGE;
  const ownsHandoff = () => session.disabled &&
    session.runId === handoffRunId &&
    session.lastHandoff === reason;
  const delivery = await editOrSendUserMessage(
    ctx.chat.id,
    processingMessageId,
    userMessage,
    cfg,
    undefined,
    undefined,
    ownsHandoff,
  );
  if (!ownsHandoff()) {
    await retractStaleUserDelivery(ctx.chat.id, delivery, session, cfg);
    return true;
  }
  if (session.processingMessageId === processingMessageId) {
    session.processingMessageId = undefined;
  }
  await updateStaffTurnCard(staffCard, {
    status: 'waiting_operator',
    reason,
  }, cfg);

  if (!ownsHandoff()) return true;

  if (!staffCard) {
    const staffMessage = buildStaffHandoffMessage(
      ticket.id.toString(),
      ctx.message.from,
      reason,
      userText,
      cfg,
    );
    const sent = await middleware.msg(cache.config.staffchat_id, staffMessage, {
      parse_mode: 'HTML',
      already_formatted: true,
      ...buildStaffCardKeyboard(String(ticket.id), cfg),
    });
    if (ownsHandoff() && sent?.message_id) {
      db.mapTelegramMessage(
        cache.config.staffchat_id,
        sent.message_id,
        ticket.id,
        'staff_handoff_fallback',
      );
    }
  }
  return true;
}

async function deliverDirectRagAnswer(
  ctx: Context,
  ticket: any,
  session: AiSession,
  cfg: AiConfig,
  userText: string,
  rag: RagResult,
  answer: string,
  reason: string,
  owner: ActiveTurnOwner,
  staffCard: StaffTurnCard | null,
  processingMessageId: number | null,
  turnStartedAt: number,
  commitRun: () => void,
): Promise<OwnedDeliveryResult> {
  if (!ownsActiveTurn(session, owner)) return 'stale';
  const answerId = randomBytes(5).toString('hex');
  const delivery = await deliverOwnedUserMessage(
    session,
    owner,
    ctx.chat.id,
    processingMessageId,
    answer,
    cfg,
    ticket.id.toString(),
    answerId,
  );
  if (delivery !== 'delivered') return delivery;
  commitRun();
  rememberAnswer(session, 'direct_rag', rag, undefined, answerId);
  if (session.processingMessageId === processingMessageId) {
    session.processingMessageId = undefined;
  }
  const topDocument = rag.docs[0];
  const staffResult = {
    status: 'answered',
    answer,
    mode: 'direct_rag' as const,
    sourceId: topDocument?.id,
    sourceTitle: topDocument?.title,
    denseScore: topDocument?.denseScore,
    lexicalScore: topDocument?.lexicalScore,
    fusedScore: topDocument?.hybridScore ?? topDocument?.score,
    reason,
  } as const;
  session.lastStaffCard = staffCard || undefined;
  session.lastStaffCardResult = staffResult;
  db.recordTicketEvent(ticket.id, {
    eventType: 'ai_answered',
    actorType: 'ai',
    answerId,
    answerMode: 'direct_rag',
    sourceId: topDocument?.id,
    denseScore: topDocument?.denseScore,
    lexicalScore: topDocument?.lexicalScore,
    hybridScore: topDocument?.hybridScore ?? topDocument?.score,
    latencyMs: Date.now() - turnStartedAt,
    reason,
  });
  updateHistory(session, userText, answer, cfg, answerId);
  if (session.abortController === owner.controller) {
    session.abortController = undefined;
  }
  await updateStaffTurnCard(staffCard, staffResult, cfg);
  return 'delivered';
}

async function handleUserMessageInternal(
  ctx: Context,
  ticket: any,
): Promise<boolean> {
  if (!ctx || !ctx.message || !ctx.message.text) {
    logger.warn('handleUserMessage', 'ABORT - no message text');
    return false;
  }
  if (ctx.chat && ctx.chat.type !== 'private') {
    logger.warn('handleUserMessage', 'ABORT - not private chat');
    return false;
  }

  // Every newer user message supersedes an older AI turn, even when the new
  // message is routed to an operator because AI was disabled or the ticket is
  // outside the current rollout cohort.
  const existingSession = getSession(String(ticket.id));
  if (existingSession) {
    invalidateActiveTurn(existingSession, 'superseded_by_new_message');
  }

  // `ensureOpenTicket()` is async, so a staff close/ban can commit between its
  // return and this handler. Re-read the authoritative row synchronously before
  // creating a session/controller; from this point through ownership creation
  // there is no event-loop yield, so terminal commands can always see and abort
  // the new controller.
  const persistedTicket = db.getTicketByIdSync(ticket.id);
  if (!persistedTicket || persistedTicket.status !== 'open') {
    logger.info('handleUserMessage', 'Ticket is no longer open', {
      ticketId: ticket.id,
    });
    return false;
  }
  ticket = persistedTicket;

  const cfg = getAiConfig();
  if (!cfg || !cfg.enabled) {
    logger.warn('handleUserMessage', 'ABORT - AI not enabled');
    return false;
  }

  const session = ensureSession(ticket);
  if (session.disabled) {
    logger.debug('handleUserMessage', 'AI session is disabled', {
      ticketId: ticket.id,
    });
    return false;
  }

  const userText = ctx.message.text.toString().trim();
  if (userText.length === 0) {
    logger.warn('handleUserMessage', 'ABORT - empty text');
    return false;
  }

  const runtime = runtimeModeForTicket(ticket.id, cfg, ticket.userid);
  if (runtime.mode === 'off') {
    logger.info('handleUserMessage', 'AI runtime is disabled for ticket', {
      ticketId: ticket.id,
      mode: runtime.mode,
    });
    return false;
  }

  const historyForTurn = [...session.history];
  rememberUserMessage(session, userText, ctx.message.message_id, cfg);
  const fullKnowledge = runtime.mode === 'full';
  const retrievalQuery = fullKnowledge ? userText : buildRetrievalQuery(
    userText,
    historyForTurn,
    cfg.rag?.qdrant?.history_query_messages ?? 2,
  );
  const promptHistory = fullKnowledge ? historyForTurn :
    selectRelevantHistory(userText, historyForTurn);

  const turnController = new AbortController();
  session.abortController = turnController;
  const turnStartedAt = Date.now();
  const runId = randomBytes(8).toString('hex');
  session.runId = runId;
  const owner: ActiveTurnOwner = {runId, controller: turnController};
  const runtimePolicyCancellationReason = () => {
    if (
      session.runId !== owner.runId ||
      session.abortController !== owner.controller ||
      !owner.controller.signal.aborted
    ) return undefined;
    const reason = String(owner.controller.signal.reason || '');
    return reason.startsWith('runtime_') ? reason : undefined;
  };
  hydrateProviderState();

  if (session.processingMessageId) {
    const previousProcessingMessageId = session.processingMessageId;
    await editOrSendUserMessage(
      ctx.chat.id,
      previousProcessingMessageId,
      'Обрабатываю ваше более новое сообщение.',
      cfg,
    );
    if (!ownsActiveTurn(session, owner)) {
      const policyReason = runtimePolicyCancellationReason();
      if (policyReason) {
        await handoffToHuman(
          ctx,
          ticket,
          session,
          cfg,
          userText,
          policyReason,
          owner,
          null,
          previousProcessingMessageId,
          undefined,
          true,
        );
      }
      return true;
    }
    if (session.processingMessageId === previousProcessingMessageId) {
      session.processingMessageId = undefined;
    }
  }
  db.touchTicket(ticket.id);
  db.recordTicketEvent(ticket.id, {
    eventType: 'user_message_received',
    actorType: 'user',
  });
  logger.info('handleUserMessage', 'AI turn started', {ticketId: ticket.id});
  const staffCard = await createStaffTurnCard(ctx, ticket, userText, cfg);
  const isCancelled = () => !ownsActiveTurn(session, owner);
  const finishCancelledTurn = async (processingMessageId?: number | null) => {
    const policyReason = runtimePolicyCancellationReason();
    if (policyReason) {
      const handedOff = await handoffToHuman(
        ctx,
        ticket,
        session,
        cfg,
        userText,
        policyReason,
        owner,
        staffCard,
        processingMessageId || null,
        undefined,
        true,
      );
      if (handedOff) return;
    }
    const cancellationReason = String(owner.controller.signal.reason || '');
    if (cancellationReason === 'shutdown') {
      if (session.abortController === turnController) {
        session.abortController = undefined;
      }
      db.recordTicketEvent(ticket.id, {
        eventType: 'ai_run_cancelled',
        actorType: 'system',
        reason: 'shutdown',
      });
      return;
    }
    const terminalCancellation = [
      'session_cleared',
      'ticket_closed',
      'tickets_cleared',
      'ticket_banned',
      'ticket_auto_closed',
      'ticket_inactivity_closed',
      'feedback_helpful',
    ].includes(cancellationReason);
    const takenByStaff = session.disabled && !terminalCancellation;
    await updateStaffTurnCard(staffCard, {
      status: takenByStaff ? 'in_progress' : 'closed',
      reason: terminalCancellation ? cancellationReason :
        (takenByStaff ? 'staff_takeover' : 'superseded_by_new_message'),
    }, cfg);
    if (
      processingMessageId &&
      session.processingMessageId === processingMessageId
    ) {
      if (terminalCancellation) {
        await retractStaleUserDelivery(
          ctx.chat.id,
          {delivered: true, sentMessageIds: [processingMessageId]},
          session,
          cfg,
          cache.config.language.ticketClosed || 'Тикет закрыт.',
        );
      } else {
        await editOrSendUserMessage(
          ctx.chat.id,
          processingMessageId,
          takenByStaff ?
            (cfg?.handoff?.user_message_staff_stop ||
              DEFAULT_STAFF_STOP_USER_MESSAGE) :
            'Обрабатываю ваше более новое сообщение.',
          cfg,
        );
      }
      session.processingMessageId = undefined;
    }
    if (session.abortController === turnController) {
      session.abortController = undefined;
    }
    db.recordTicketEvent(ticket.id, {
      eventType: 'ai_run_cancelled',
      actorType: 'system',
      reason: terminalCancellation ? cancellationReason :
        (takenByStaff ? 'staff_takeover' : 'superseded'),
    });
  };

  if (isCancelled()) {
    await finishCancelledTurn();
    return true;
  }

  if (!fullKnowledge && shouldHandoffByUserRequest(userText, cfg)) {
    logger.info('handleUserMessage', 'handoff_user_request', {
      ticketId: ticket.id,
    });
    const committed = await handoffToHuman(
      ctx,
      ticket,
      session,
      cfg,
      userText,
      'user_request',
      owner,
      staffCard,
    );
    if (!committed) await finishCancelledTurn();
    return true;
  }

  // Conservative keyword prefilter runs before RAG in every detection mode.
  const offTopicCfg = cfg?.off_topic;
  if (!fullKnowledge && offTopicCfg?.enabled !== false) {
    if (!session.offTopicWarnings) {
      session.offTopicWarnings = 0;
    }
    const maxWarnings = offTopicCfg?.max_warnings ?? 1;

    if (isObviousOffTopic(userText, cfg)) {
      const nextWarningCount = session.offTopicWarnings + 1;
      logger.debug('handleUserMessage', 'Off-topic request detected', {
        ticketId: ticket.id,
        warnings: nextWarningCount,
      });

      if (nextWarningCount <= maxWarnings) {
        const warningMsg = offTopicCfg?.warning_message || DEFAULT_OFF_TOPIC_WARNING;
        const delivery = await deliverOwnedUserMessage(
          session,
          owner,
          ctx.chat.id,
          null,
          warningMsg,
          cfg,
        );
        if (delivery === 'stale') {
          await finishCancelledTurn();
          return true;
        }
        if (delivery === 'failed') {
          const committed = await handoffToHuman(
            ctx, ticket, session, cfg, userText, 'telegram_error', owner,
            staffCard,
          );
          if (!committed) await finishCancelledTurn();
          return true;
        }
        session.offTopicWarnings = nextWarningCount;
        if (session.abortController === owner.controller) {
          session.abortController = undefined;
        }
        db.recordTicketEvent(ticket.id, {
          eventType: 'off_topic_warning',
          actorType: 'system',
          reason: 'keyword_prefilter',
        });
        await updateStaffTurnCard(staffCard, {
          status: 'answered',
          answer: warningMsg,
          reason: 'off_topic_warning',
        }, cfg);
        return true;
      } else {
        session.offTopicWarnings = nextWarningCount;
        logger.info('handleUserMessage', 'off_topic_handoff', {
          ticketId: ticket.id,
          warnings: nextWarningCount,
        });
        const committed = await handoffToHuman(
          ctx,
          ticket,
          session,
          cfg,
          userText,
          'off_topic',
          owner,
          staffCard,
        );
        if (!committed) await finishCancelledTurn();
        return true;
      }
    }
  }

  // One deadline covers retrieval, tools and every provider attempt. Manual
  // takeover/new-message cancellation remains separately observable.
  const totalDeadlineMs = Math.min(
    30000,
    Math.max(1, cfg.llm?.deadline_ms || 30000),
  );
  const deadlineSignal = AbortSignal.timeout(totalDeadlineMs);
  const runSignal = AbortSignal.any([
    turnController.signal,
    deadlineSignal,
  ]);
  const runDeadlineAt = Date.now() + totalDeadlineMs;
  let rag: RagResult = {
    context: '',
    docs: [],
    hasContext: false,
    confidence: 0,
  };
  let ragLowConfidence = false;

  logger.debug('handleUserMessage', 'AI graph started', {ticketId: ticket.id});
  const processingMsg = getRandomProcessingMessage(cfg);
  let processingMsgId: number | null = null;
  try {
    processingMsgId = await (middleware as any).msgWithId(ctx.chat.id, processingMsg, {
      parse_mode: cfg?.user_parse_mode || cache.config.parse_mode,
    });
    if (isCancelled()) {
      if (processingMsgId) {
        await retractStaleUserDelivery(
          ctx.chat.id,
          {delivered: true, sentMessageIds: [processingMsgId]},
          session,
          cfg,
        );
      }
      await finishCancelledTurn();
      return true;
    }
    if (processingMsgId) session.processingMessageId = processingMsgId;
  } catch (err) {
    logger.warn('handleUserMessage', 'Processing message could not be sent', {
      ticketId: ticket.id,
    });
  }
  if (isCancelled()) {
    await finishCancelledTurn(processingMsgId);
    return true;
  }

  db.createAiRun({
    runId,
    ticketId: String(ticket.id),
    mode: runtime.mode,
    startedAt: turnStartedAt,
  });
  const currentRagStatus = () =>
    rag.backendError && !rag.hasContext ? 'unavailable' as const :
      rag.hasContext ? 'hit' as const : 'miss' as const;
  const finishRun = (
    input: Parameters<typeof db.finishAiRun>[1],
  ): void => {
    if (db.finishAiRun(runId, input) > 0) {
      void evaluateAiSlo(db.getAiSloSnapshot());
    }
  };
  const finishCancelledRun = () => finishRun({
    status: 'cancelled',
    route: 'none',
    ragStatus: currentRagStatus(),
    failureReason: 'cancelled',
    latencyMs: Date.now() - turnStartedAt,
  });
  const intent = fullKnowledge ? undefined : /политик|оферт|договор|конфиденц/i.test(userText) ?
    'legal' as const : 'support' as const;
  const tool = fullKnowledge ? undefined : new ToolRegistry(getVerifiedDocsService(cfg)).getAllowedTool(
    'search_verified_docs',
    {
      enabled: runtime.allowWebTool,
      // LangGraph performs the definitive RAG-miss gate before invocation.
      ragMiss: true,
      intent,
    },
  );
  let toolDocuments: AgentDocument[] = [];
  const instrumentedTool = tool ? {
    invoke: async (input: {query: string}, options?: {signal?: AbortSignal}) => {
      const startedAt = Date.now();
      try {
        const value = await tool.invoke(input, options as any);
        let parsed: any = value;
        if (typeof parsed === 'string') parsed = JSON.parse(parsed);
        toolDocuments = Array.isArray(parsed?.sources) ?
          parsed.sources.map((source: any) => ({
            id: source.sourceId,
            source: source.sourceId,
            title: source.title,
            url: source.url,
            text: source.snippet,
          })) : [];
        const latencyMs = Date.now() - startedAt;
        db.recordToolRun({
          runId,
          toolName: 'search_verified_docs',
          outcome: 'success',
          resultCount: toolDocuments.length,
          latencyMs,
        });
        recordToolMetric({
          toolName: 'search_verified_docs',
          outcome: 'success',
          latencyMs,
        });
        return value;
      } catch (error) {
        const cancelled = !!options?.signal?.aborted;
        const latencyMs = Date.now() - startedAt;
        db.recordToolRun({
          runId,
          toolName: 'search_verified_docs',
          outcome: cancelled ? 'cancelled' : 'failure',
          errorReason: cancelled ? 'cancelled' : 'tool_unavailable',
          latencyMs,
        });
        recordToolMetric({
          toolName: 'search_verified_docs',
          outcome: cancelled ? 'cancelled' : 'failure',
          failureReason: cancelled ? 'cancelled' : 'tool_unavailable',
          latencyMs,
        });
        throw error;
      }
    },
  } : undefined;
  let lastLlmResult: LlmResult | undefined;
  let slowMessagePromise: Promise<OwnedDeliveryResult | undefined> | undefined;
  const startSlowMessage = () => {
    slowMessagePromise = (
      processingMsgId &&
      session.processingMessageId === processingMsgId &&
      !runSignal.aborted &&
      !isCancelled()
    ) ? deliverOwnedUserMessage(
        session,
        owner,
        ctx.chat.id,
        processingMsgId,
        'Проверяю официальные инструкции…',
        cfg,
      ) : Promise.resolve(undefined);
  };
  const slowMessageDelay = slowProcessingMessageDelayMs();
  const slowMessageTimer = slowMessageDelay === 0 ? undefined :
    setTimeout(startSlowMessage, slowMessageDelay);
  if (slowMessageTimer) slowMessageTimer.unref();
  else queueMicrotask(startSlowMessage);
  const settleSlowMessage = async () => {
    if (slowMessageTimer) clearTimeout(slowMessageTimer);
    // If the timer callback already started, serialize the terminal edit after
    // it. Otherwise a late progress edit could overwrite the final answer.
    if (slowMessagePromise) await slowMessagePromise;
  };
  let agentResult: Awaited<ReturnType<typeof runSupportAgent>>;
  try {
    const input = {
      runId,
      ticketId: String(ticket.id),
      userText,
      retrievalQuery,
      systemPrompt: cfg.system_prompt || DEFAULT_SYSTEM_PROMPT,
      history: promptHistory,
      mode: runtime.mode,
      allowWebTool: runtime.allowWebTool,
      intent,
      requireSourceSelection: true,
      deadlineMs: Math.max(1, runDeadlineAt - Date.now()),
      signal: runSignal,
    };
    if (fullKnowledge) {
      const documents = loadFullKnowledgeBase();
      rag = {
        context: documents.map(document => document.text).join('\n\n'),
        docs: documents,
        hasContext: documents.length > 0,
        confidence: 0,
      };
      logger.info('handleUserMessage', 'Full knowledge base supplied to model', {
        ticketId: ticket.id, documentCount: documents.length,
        historyMessages: promptHistory.length,
      });
      agentResult = await runFullKnowledgeAgent(input, documents,
        async (modelInput, signal) => {
          lastLlmResult = await requestLlm({
            ...modelInput, requireCompleteDocuments: true,
          }, {
            ...cfg.llm,
            response_schema: FULL_KNOWLEDGE_RESPONSE_SCHEMA,
            max_input_tokens: cfg.llm?.max_input_tokens ||
              FULL_KNOWLEDGE_INPUT_TOKENS,
          }, {signal});
          return lastLlmResult;
        });
    } else {
      agentResult = await runSupportAgent(input, {
        retrieve: async (_input, signal) => {
          rag = await retrieveRagContext(retrievalQuery, cfg, signal);
          recordRagResult(rag.hasContext);
          db.recordTicketEvent(ticket.id, {
            eventType: 'rag_result',
            actorType: 'ai',
            sourceId: rag.docs[0]?.id,
            denseScore: rag.docs[0]?.denseScore,
            lexicalScore: rag.docs[0]?.lexicalScore,
            hybridScore: rag.docs[0]?.fusedScore ?? rag.docs[0]?.score,
            denseRank: rag.docs[0]?.denseRank,
            lexicalRank: rag.docs[0]?.lexicalRank,
            reason: rag.hasContext ? 'hit' : 'miss',
          });
          logger.debug('handleUserMessage', 'RAG completed', {
            ticketId: ticket.id,
            hasContext: rag.hasContext,
            documents: rag.docs.map((doc) => ({
              title: doc.title,
              denseScore: doc.denseScore,
              lexicalScore: doc.lexicalScore,
              hybridScore: doc.hybridScore,
            })),
          });
          const confidenceThreshold =
            cfg.rag?.qdrant?.confidence_threshold ?? 0;
          ragLowConfidence = !!(
            cfg.handoff?.on_low_confidence &&
            rag.hasContext &&
            rag.confidence < confidenceThreshold
          );
          if (ragLowConfidence) {
            logger.info(
              'handleUserMessage',
              'RAG context rejected by confidence policy',
              {ticketId: ticket.id, confidence: rag.confidence,
                confidenceThreshold},
            );
          }
          const directAnswer =
            cfg.rag?.qdrant?.direct_answer_on_llm_error !== false &&
            !ragLowConfidence ?
            selectDirectRagAnswer(rag.docs, {
              minimumMargin:
                cfg.rag?.qdrant?.direct_answer_min_margin ?? 0.05,
            }) || undefined : undefined;
          return {
            documents: ragLowConfidence ? [] : rag.docs.map((doc) => ({
              ...doc,
              score: doc.fusedScore ?? doc.score,
            })),
            directAnswer,
            // The graph uses this flag as the permission to serve directAnswer.
            // selectDirectRagAnswer also approves strong lexical+dense matches,
            // so do not discard those safe non-alias matches here.
            exactMatch: !!directAnswer,
            confidence: rag.confidence,
          };
        },
        invokeModel: async (input, signal) => {
          const remainingMs = Math.max(1, runDeadlineAt - Date.now());
          lastLlmResult = await requestLlm(input, {
            ...(cfg.llm || {}),
            deadline_ms: Math.min(
              cfg.llm?.deadline_ms || 30000,
              remainingMs,
            ),
          }, {signal});
          return lastLlmResult;
        },
        verifiedDocsTool: instrumentedTool,
        onAnswerRejected: rejection => {
          try {
            db.recordAnswerRejection(rejection);
            logger.warn('handleUserMessage', 'AI answer rejected', {
              ticketId: ticket.id,
              runId,
              reason: rejection.reason,
              responseLength: rejection.content.length,
            });
          } catch (_error) {
            logger.error('handleUserMessage', 'Answer diagnostics storage failed', {
              ticketId: ticket.id, runId,
            });
          }
        },
      });
    }
  } catch (_error) {
    await settleSlowMessage();
    const cancelled = runSignal.aborted || isCancelled();
    const finishFailure = () => finishRun({
      status: cancelled ? 'cancelled' : 'failed',
      route: cancelled ? 'none' : 'handoff',
      ragStatus: currentRagStatus(),
      failureReason: cancelled ? 'cancelled' : 'agent_error',
      latencyMs: Date.now() - turnStartedAt,
    });
    if (isCancelled()) {
      finishCancelledRun();
      await finishCancelledTurn(processingMsgId);
    } else {
      const committed = await handoffToHuman(
        ctx, ticket, session, cfg, userText,
        deadlineSignal.aborted ? 'deadline' : 'agent_error',
        owner, staffCard, processingMsgId, finishFailure,
      );
      if (!committed) {
        finishCancelledRun();
        await finishCancelledTurn(processingMsgId);
      }
    }
    return true;
  }
  await settleSlowMessage();
  if (toolDocuments.length > 0) {
    rag = {
      context: toolDocuments.map((document) => document.text).join('\n\n'),
      docs: toolDocuments.map((document) => ({
        id: document.id,
        source: document.source,
        title: document.title,
        url: document.url,
        text: document.text,
      })),
      hasContext: true,
      confidence: 1,
      retrievalMode: 'lexical',
    };
  }
  const selectedSourceIds = new Set(agentResult.citations
    .map(citation => citation.sourceId)
    .filter((sourceId): sourceId is string => !!sourceId));
  const selectedDocuments = rag.docs.filter(document =>
    !!document.id && selectedSourceIds.has(document.id),
  );
  const answerRag: RagResult = selectedDocuments.length > 0 ? {
    ...rag,
    docs: selectedDocuments,
    context: selectedDocuments.map(document => document.text).join('\n\n'),
  } : fullKnowledge ? {...rag, docs: [], context: ''} : rag;
  if (lastLlmResult) recordLlmResult(lastLlmResult);
  const primaryProvider = cfg.llm?.providers?.primary?.provider || 'gemini';
  const primaryModel = cfg.llm?.providers?.primary?.model;
  const isFallbackAttempt = (attempt: {provider: string; model?: string}) =>
    attempt.provider !== primaryProvider ||
    (!!primaryModel && attempt.model !== primaryModel);
  const lastErrors = new Map<string, string>();
  for (const attempt of agentResult.providerAttempts) {
    const cancelled = attempt.reason === 'cancelled';
    db.recordProviderAttempt({
      runId,
      provider: attempt.provider,
      model: attempt.model,
      phase: 'answer',
      outcome: cancelled ? 'cancelled' : attempt.outcome,
      isFallback: isFallbackAttempt(attempt),
      errorReason: attempt.reason,
      statusCode: attempt.status,
      latencyMs: attempt.latencyMs,
      promptTokens: attempt.usage?.inputTokens,
      completionTokens: attempt.usage?.outputTokens,
      totalTokens: attempt.usage?.totalTokens,
      createdAt: attempt.startedAt,
    });
    if (attempt.reason) lastErrors.set(attempt.provider, attempt.reason);
    if (attempt.outcome !== 'skipped') {
      recordProviderAttemptMetric({
        provider: attempt.provider,
        ok: attempt.outcome === 'success',
        latencyMs: attempt.latencyMs,
        isFallback: isFallbackAttempt(attempt),
        failureReason: attempt.reason,
        promptTokens: attempt.usage?.inputTokens,
        completionTokens: attempt.usage?.outputTokens,
        totalTokens: attempt.usage?.totalTokens,
      });
    }
  }
  persistProviderState(lastErrors);
  void recordProviderRun(agentResult.providerAttempts, ticket.id);
  for (const profile of [
    cfg.llm?.providers?.primary,
    cfg.llm?.providers?.fallback,
  ]) {
    if (!profile) continue;
    const state = getProviderRuntimeState(profile.provider);
    const requestRatio = profile.daily_request_limit ?
      state.dailyRequests / profile.daily_request_limit : 0;
    const tokenRatio = profile.daily_token_limit ?
      state.dailyTokens / profile.daily_token_limit : 0;
    void recordQuotaRatio(
      profile.provider,
      Math.max(requestRatio, tokenRatio),
    );
  }
  const successfulAttempt = [...agentResult.providerAttempts]
    .reverse()
    .find((attempt) => attempt.outcome === 'success');
  const route = agentResult.status === 'direct_rag' ? 'direct_rag' :
    agentResult.status === 'handed_off' ? 'handoff' :
    successfulAttempt && isFallbackAttempt(successfulAttempt) ?
      'fallback' : successfulAttempt ? 'primary' : 'none';
  const agentFailureReason = ragLowConfidence &&
    agentResult.status === 'handed_off' ?
    'low_confidence' : agentResult.reason;
  const finishOutcome = (
    status: 'answered' | 'direct_rag' | 'handed_off' | 'cancelled' | 'failed',
    outcomeRoute: 'none' | 'primary' | 'fallback' | 'direct_rag' | 'handoff',
    failureReason?: string,
  ) => () => finishRun({
    status,
    route: outcomeRoute,
    ragStatus: currentRagStatus(),
    sourceCount: agentResult.citations.length,
    failureReason,
    latencyMs: Date.now() - turnStartedAt,
  });
  const finishHandoff = (reason: string) => finishOutcome(
    'handed_off',
    'handoff',
    reason,
  );
  if (isCancelled()) {
    finishCancelledRun();
    await finishCancelledTurn(processingMsgId);
    return true;
  }
  if (agentResult.status === 'cancelled' || deadlineSignal.aborted) {
    const committed = await handoffToHuman(
      ctx, ticket, session, cfg, userText, 'deadline', owner, staffCard,
      processingMsgId,
      finishOutcome('cancelled', 'none', 'deadline'),
    );
    if (!committed) {
      finishCancelledRun();
      await finishCancelledTurn(processingMsgId);
    }
    return true;
  }

  if (agentResult.status === 'direct_rag' && agentResult.content) {
    const delivery = await deliverDirectRagAnswer(
      ctx, ticket, session, cfg, userText, rag, agentResult.content,
      agentResult.reason || 'rag_only', owner, staffCard, processingMsgId,
      turnStartedAt,
      finishOutcome('direct_rag', 'direct_rag'),
    );
    if (delivery === 'stale') {
      finishCancelledRun();
      await finishCancelledTurn(processingMsgId);
    } else if (delivery === 'failed') {
      const committed = await handoffToHuman(
        ctx, ticket, session, cfg, userText, 'telegram_error', owner,
        staffCard, processingMsgId, finishHandoff('telegram_error'),
      );
      if (!committed) {
        finishCancelledRun();
        await finishCancelledTurn(processingMsgId);
      }
    }
    return true;
  }
  if (agentResult.status === 'handed_off') {
    const reason = agentFailureReason || 'no_context';
    const committed = await handoffToHuman(
      ctx,
      ticket,
      session,
      cfg,
      userText,
      reason,
      owner,
      staffCard,
      processingMsgId,
      finishHandoff(reason),
    );
    if (!committed) {
      finishCancelledRun();
      await finishCancelledTurn(processingMsgId);
    }
    return true;
  }
  if (!lastLlmResult || lastLlmResult.ok !== true || !agentResult.content) {
    const committed = await handoffToHuman(
      ctx, ticket, session, cfg, userText, 'agent_invalid_result', owner,
      staffCard, processingMsgId, finishHandoff('agent_invalid_result'),
    );
    if (!committed) {
      finishCancelledRun();
      await finishCancelledTurn(processingMsgId);
    }
    return true;
  }
  const llmResult = {...lastLlmResult, content: agentResult.content};

  logger.info('handleUserMessage', 'LLM request completed', {
    ticketId: ticket.id,
    model: llmResult.model,
    status: llmResult.status,
    latencyMs: Date.now() - turnStartedAt,
    usage: llmResult.usage,
    estimatedPromptTokens: llmResult.prompt.estimatedTokens,
    includedDocuments: llmResult.prompt.includedDocuments,
    includedHistoryMessages: llmResult.prompt.includedHistoryMessages,
    attemptedModels: llmResult.attemptedModels,
    usedFallback: llmResult.usedFallback,
  });
  const cleaned = normalizeSupportLinks(appendVerifiedCitations(
    llmResult.content,
    agentResult.citations,
  ));
  if (cleaned.length === 0) {
    logger.warn('handleUserMessage', 'Empty response from LLM', {
      ticketId: ticket.id,
    });
    const committed = await handoffToHuman(
      ctx, ticket, session, cfg, userText, 'empty', owner, staffCard,
      processingMsgId, finishHandoff('empty'),
    );
    if (!committed) {
      finishCancelledRun();
      await finishCancelledTurn(processingMsgId);
    }
    return true;
  }

  if (!fullKnowledge && isUncertainLlmAnswer(cleaned, cfg)) {
    logger.info('handleUserMessage', 'handoff_llm_uncertain', {
      ticketId: ticket.id,
    });
    const committed = await handoffToHuman(
      ctx,
      ticket,
      session,
      cfg,
      userText,
      'llm_uncertain',
      owner,
      staffCard,
      processingMsgId,
      finishHandoff('llm_uncertain'),
    );
    if (!committed) {
      finishCancelledRun();
      await finishCancelledTurn(processingMsgId);
    }
    return true;
  }

  // Check if response has [OFF_TOPIC] marker (LLM-based detection)
  if (!fullKnowledge && offTopicCfg?.enabled !== false && offTopicCfg?.detection_mode === 'llm' && cleaned.startsWith('[OFF_TOPIC]')) {
    logger.debug('handleUserMessage', 'LLM detected off-topic', {
      ticketId: ticket.id,
    });

    if (!session.offTopicWarnings) {
      session.offTopicWarnings = 0;
    }
    const maxWarnings = offTopicCfg?.max_warnings ?? 1;
    const nextWarningCount = session.offTopicWarnings + 1;

    if (nextWarningCount <= maxWarnings) {
      const warningMsg = offTopicCfg?.warning_message || DEFAULT_OFF_TOPIC_WARNING;
      const delivery = await deliverOwnedUserMessage(
        session,
        owner,
        ctx.chat.id,
        processingMsgId,
        warningMsg,
        cfg,
      );
      if (delivery === 'stale') {
        finishCancelledRun();
        await finishCancelledTurn(processingMsgId);
        return true;
      }
      if (delivery === 'failed') {
        const committed = await handoffToHuman(
          ctx, ticket, session, cfg, userText, 'telegram_error', owner,
          staffCard, processingMsgId, finishHandoff('telegram_error'),
        );
        if (!committed) {
          finishCancelledRun();
          await finishCancelledTurn(processingMsgId);
        }
        return true;
      }
      session.offTopicWarnings = nextWarningCount;
      finishOutcome('answered', route)();
      if (session.processingMessageId === processingMsgId) {
        session.processingMessageId = undefined;
      }
      if (session.abortController === owner.controller) {
        session.abortController = undefined;
      }
      await updateStaffTurnCard(staffCard, {
        status: 'answered',
        answer: warningMsg,
        reason: 'off_topic_warning',
      }, cfg);
      return true;
    } else {
      session.offTopicWarnings = nextWarningCount;
      logger.info('handleUserMessage', 'LLM off-topic handoff', {
        ticketId: ticket.id,
        warnings: nextWarningCount,
      });
      const committed = await handoffToHuman(
        ctx, ticket, session, cfg, userText, 'off_topic', owner, staffCard,
        processingMsgId, finishHandoff('off_topic'),
      );
      if (!committed) {
        finishCancelledRun();
        await finishCancelledTurn(processingMsgId);
      }
      return true;
    }
  }

  const answerId = randomBytes(5).toString('hex');
  const delivery = await deliverOwnedUserMessage(
    session,
    owner,
    ctx.chat.id,
    processingMsgId,
    cleaned,
    cfg,
    ticket.id.toString(),
    answerId,
  );
  if (delivery === 'stale') {
    finishCancelledRun();
    await finishCancelledTurn(processingMsgId);
    return true;
  }
  if (delivery === 'failed') {
    const committed = await handoffToHuman(
      ctx, ticket, session, cfg, userText, 'telegram_error', owner,
      staffCard, processingMsgId, finishHandoff('telegram_error'),
    );
    if (!committed) {
      finishCancelledRun();
      await finishCancelledTurn(processingMsgId);
    }
    return true;
  }
  finishOutcome('answered', route)();
  rememberAnswer(session, 'llm', answerRag, llmResult.model, answerId);
  if (session.processingMessageId === processingMsgId) {
    session.processingMessageId = undefined;
  }
  const topDocument = answerRag.docs[0];
  const staffResult = {
    status: 'answered',
    answer: cleaned,
    mode: 'llm' as const,
    sourceId: topDocument?.id,
    sourceTitle: topDocument?.title,
    denseScore: topDocument?.denseScore,
    lexicalScore: topDocument?.lexicalScore,
    fusedScore: topDocument?.hybridScore ?? topDocument?.score,
  } as const;
  session.lastStaffCard = staffCard || undefined;
  session.lastStaffCardResult = staffResult;
  db.recordTicketEvent(ticket.id, {
    eventType: 'ai_answered',
    actorType: 'ai',
    answerId,
    answerMode: 'llm',
    sourceId: topDocument?.id,
    denseScore: topDocument?.denseScore,
    lexicalScore: topDocument?.lexicalScore,
    hybridScore: topDocument?.hybridScore ?? topDocument?.score,
    model: llmResult.model,
    latencyMs: Date.now() - turnStartedAt,
  });

  updateHistory(session, userText, cleaned, cfg, answerId);
  if (session.abortController === owner.controller) {
    session.abortController = undefined;
  }
  await updateStaffTurnCard(staffCard, staffResult, cfg);
  logger.info('handleUserMessage', 'AI response sent', {
    ticketId: ticket.id,
    responseLength: cleaned.length,
  });
  return true;
}

async function handleUserMessage(ctx: Context, ticket: any): Promise<boolean> {
  // Returning `true` suppresses users.chat's operator fallback while polling
  // is shutting down. No provider, DB ownership or Telegram work starts.
  if (aiShutdownInProgress) return true;
  const operation = handleUserMessageInternal(ctx, ticket);
  activeAiHandlers.add(operation);
  try {
    return await operation;
  } finally {
    activeAiHandlers.delete(operation);
  }
}

async function waitForActiveAiRuns(timeoutMs = 15000): Promise<boolean> {
  const operations = Array.from(activeAiHandlers);
  if (operations.length === 0) return true;
  let timer: NodeJS.Timeout | undefined;
  const timedOut = new Promise<false>(resolve => {
    timer = setTimeout(() => resolve(false), Math.max(1, timeoutMs));
  });
  const drained = Promise.allSettled(operations).then(() => true as const);
  const completed = await Promise.race([drained, timedOut]);
  if (timer) clearTimeout(timer);
  if (!completed) {
    logger.warn('waitForActiveAiRuns', 'AI shutdown drain timed out', {
      activeRuns: activeAiHandlers.size,
    });
  }
  return completed;
}

async function disableAiForTicket(
  ticketId: string | number,
  reason: string,
  options: {
    notifyUser?: boolean;
    userMessage?: string;
    assigneeId?: string | number;
    assigneeName?: string;
    stage?: 'waiting_operator' | 'in_progress';
  } = {},
): Promise<boolean> {
  const cfg = getAiConfig();
  const id = ticketId.toString();
  let session = getSession(id);

  if (!session) {
    const ticket = await getTicketById(ticketId);
    if (ticket) {
      session = ensureSession(ticket);
    }
  }

  if (!session) {
    logger.warn('disableAiForTicket', `Session not found for ticket ${id}`);
    return false;
  }
  if (db.getTicketByIdSync(ticketId)?.status !== 'open') return false;

  const wasAlreadyDisabled = session.disabled;
  session.abortController?.abort(reason);
  session.abortController = undefined;
  session.disabled = true;
  session.lastHandoff = reason;
  session.runId = randomBytes(8).toString('hex');
  db.updateTicketState(ticketId, {
    stage: options.stage || 'in_progress',
    aiEnabled: false,
    handoffReason: reason,
    assigneeId: options.assigneeId,
    assigneeName: options.assigneeName,
  });
  if (!wasAlreadyDisabled || options.assigneeId != null) {
    db.recordTicketEvent(ticketId, {
      eventType: options.stage === 'waiting_operator' ?
        'handoff' : 'staff_take',
      actorType: options.stage === 'waiting_operator' ? 'user' : 'staff',
      reason,
    });
  }
  logger.info('disableAiForTicket', `AI disabled`, { ticketId: id, reason });

  if (options.notifyUser && !wasAlreadyDisabled && session.userId != null) {
    const message =
      options.userMessage ||
      cfg?.handoff?.user_message_staff_stop ||
      DEFAULT_STAFF_STOP_USER_MESSAGE;
    if (session.processingMessageId) {
      await editOrSendUserMessage(
        session.userId,
        session.processingMessageId,
        message,
        cfg,
      );
      session.processingMessageId = undefined;
    } else {
      await sendUserMessage(session.userId, message, cfg);
    }
    logger.debug('disableAiForTicket', 'User notified about staff takeover', {
      ticketId: id,
    });
  }
  return true;
}

async function resumeAiForTicket(
  ticketId: string | number,
  notifyUser = true,
): Promise<boolean> {
  const cfg = getAiConfig();
  const id = ticketId.toString();
  let session = getSession(id);
  if (!session) {
    const ticket = await getTicketById(ticketId);
    if (ticket) session = ensureSession(ticket);
  }
  if (!session) return false;

  session.disabled = false;
  session.lastHandoff = undefined;
  session.runId = randomBytes(8).toString('hex');
  db.updateTicketState(ticketId, {
    stage: 'ai_active',
    aiEnabled: true,
    handoffReason: null,
    assigneeId: null,
    assigneeName: null,
  });
  db.recordTicketEvent(ticketId, {
    eventType: 'ai_resumed',
    actorType: 'staff',
  });
  if (notifyUser) {
    await sendUserMessage(
      session.userId,
      'ИИ-ассистент снова подключён к диалогу.',
      cfg,
    );
  }
  logger.info('resumeAiForTicket', 'AI resumed', {ticketId: id});
  return true;
}

async function handleUserFeedback(
  ticketId: string | number,
  userId: string | number,
  feedback: 'helpful' | 'not_helpful' | 'operator',
  answerId?: string,
): Promise<boolean> {
  const cfg = getAiConfig();
  const id = ticketId.toString();
  const session = getSession(id);
  if (!answerId) return false;
  const persisted = db.recordAnswerFeedback(
    ticketId,
    userId,
    answerId,
    feedback,
  );
  // SQLite is the authoritative idempotency/state gate. Memory correlation
  // alone must never revive a closed ticket through an old inline button.
  if (!persisted) return false;

  if (session?.lastAnswer?.id === answerId) {
    session.lastAnswer.feedback = feedback;
  }
  const mode = persisted?.mode || session?.lastAnswer?.mode || 'llm';
  recordAiFeedback(feedback, mode);
  logger.info('handleUserFeedback', 'AI feedback recorded', {
    ticketId: id,
    answerId,
    feedback,
    mode,
    sourceTitle: session?.lastAnswer?.sourceTitle,
    denseScore: session?.lastAnswer?.denseScore,
    lexicalScore: session?.lastAnswer?.lexicalScore,
    hybridScore: session?.lastAnswer?.hybridScore,
  });
  if (feedback === 'helpful') {
    db.closeTicketById(ticketId, 'ai_helpful');
    if (session) {
      invalidateActiveTurn(session, 'feedback_helpful');
      session.disabled = true;
      session.runId = randomBytes(8).toString('hex');
      await updateStaffTurnCard(
        session.lastStaffCard || null,
        {
          ...session.lastStaffCardResult,
          status: 'closed',
          reason: 'ai_helpful',
        },
        cfg,
      );
    }
    return true;
  }

  const reason =
    feedback === 'operator' ? 'user_operator_button' : 'not_helpful';
  if (session) {
    invalidateActiveTurn(session, reason);
    session.disabled = true;
    session.lastHandoff = reason;
    session.runId = randomBytes(8).toString('hex');
  }
  recordAiHandoff(reason);
  db.updateTicketState(ticketId, {
    stage: 'waiting_operator',
    aiEnabled: false,
    handoffReason: reason,
  });
  db.recordTicketEvent(ticketId, {
    eventType: 'handoff',
    actorType: 'user',
    reason,
  });
  if (session) {
    await updateStaffTurnCard(
      session.lastStaffCard || null,
      {
        ...session.lastStaffCardResult,
        status: 'waiting_operator',
        reason,
      },
      cfg,
    );
  }
  const ticket = db.getTicketByIdSync(ticketId);
  if (!ticket) return true;
  await sendUserMessage(
    ticket.userid,
    cfg?.handoff?.user_message || DEFAULT_HANDOFF_USER_MESSAGE,
    cfg,
  );
  return true;
}

function clearAiSession(
  ticketId: string,
  reason = 'session_cleared',
): void {
  if (cache.aiSessions && cache.aiSessions[ticketId]) {
    const session = cache.aiSessions[ticketId];
    // Deleting the cache entry is not sufficient: an in-flight handler keeps
    // its object reference. Abort the physical work and invalidate ownership
    // before removal so a closed/banned ticket cannot receive a late answer.
    invalidateActiveTurn(session, reason);
    session.disabled = true;
    session.runId = randomBytes(8).toString('hex');
    logger.debug('clearAiSession', `Clearing session for ticket ${ticketId}`);
    delete cache.aiSessions[ticketId];
  }
}

export {
  handleUserMessage,
  disableAiForTicket,
  resumeAiForTicket,
  handleUserFeedback,
  isAiEnabled,
  clearAiSession,
  getAiConfig,
  isUncertainLlmAnswer,
  isObviousOffTopic,
  rolloutBucket,
  runtimeModeForTicket,
  cancelActiveAiRuns,
  sanitizeTextForParseMode,
  waitForActiveAiRuns,
  setAiShutdownState,
  isAiShutdownInProgress,
};
