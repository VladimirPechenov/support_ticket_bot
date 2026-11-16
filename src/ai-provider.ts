import {ChatGoogle} from '@langchain/google';
import {logger} from './logger';
import {createGeminiApiClient} from './gemini-http';
import {setTimeout as delay} from 'timers/promises';

export type DirectProviderName = 'gemini' | 'mistral';

export type ProviderFailureReason =
  | 'auth'
  | 'credits'
  | 'prompt_limit'
  | 'model_unavailable'
  | 'rate_limit'
  | 'timeout'
  | 'provider_error'
  | 'safety'
  | 'forbidden'
  | 'cancelled';

export interface DirectProviderConfig {
  provider: DirectProviderName;
  model: string;
  temperature?: number;
  maxTokens?: number;
  timeoutMs?: number;
  apiKey?: string;
  responseSchema?: Record<string, unknown>;
  dailyRequestLimit?: number;
  dailyTokenLimit?: number;
  quotaStopPercent?: number;
  circuitBreaker?: {
    failureThreshold?: number;
    failureWindowMs?: number;
    cooldownMs?: number;
  };
}

export interface ProviderRouterConfig {
  primary: DirectProviderConfig;
  fallback?: DirectProviderConfig;
  deadlineMs?: number;
  maxAttempts?: number;
}

export interface ProviderUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
}

export interface ProviderAttempt {
  provider: DirectProviderName;
  model: string;
  startedAt: number;
  latencyMs: number;
  outcome: 'success' | 'failure' | 'skipped';
  reason?: ProviderFailureReason | 'circuit_open' | 'quota_cap';
  status?: number;
  usage?: ProviderUsage;
}

export interface ProviderSuccess {
  ok: true;
  content: string;
  provider: DirectProviderName;
  model: string;
  usage?: ProviderUsage;
  attempts: ProviderAttempt[];
}

export interface ProviderFailure {
  ok: false;
  reason: ProviderFailureReason;
  provider: DirectProviderName;
  model: string;
  status?: number;
  retryable: boolean;
  message: string;
  attempts: ProviderAttempt[];
}

export type ProviderRouterResult = ProviderSuccess | ProviderFailure;

export interface InvokableChatModel {
  invoke(input: unknown, options?: {
    signal?: AbortSignal;
    callbacks?: unknown[];
  }): Promise<unknown>;
}

export type ProviderModelFactory = (
  config: DirectProviderConfig,
  signal?: AbortSignal,
) => InvokableChatModel | Promise<InvokableChatModel>;

export interface ProviderRouterDependencies {
  modelFactory?: ProviderModelFactory;
  now?: () => number;
  signal?: AbortSignal;
}

interface CircuitState {
  failureTimes: number[];
  openUntil: number;
  halfOpenInFlight: boolean;
}

interface QuotaState {
  day: string;
  requests: number;
  tokens: number;
}

interface QuotaReservation {
  day: string;
  tokens: number;
}

export interface ProviderRuntimeSnapshot {
  provider: DirectProviderName;
  circuitState: 'closed' | 'open' | 'half_open';
  consecutiveFailures: number;
  openUntil?: number;
  quotaDate: string;
  dailyRequests: number;
  dailyTokens: number;
}

interface ClassifiedError {
  reason: ProviderFailureReason;
  status?: number;
  retryable: boolean;
}

const DEFAULT_DEADLINE_MS = 30000;
const DEFAULT_PROVIDER_TIMEOUT_MS = 20000;
const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_FAILURE_THRESHOLD = 5;
const DEFAULT_FAILURE_WINDOW_MS = 120000;
const DEFAULT_CIRCUIT_COOLDOWN_MS = 300000;
const DEFAULT_QUOTA_STOP_PERCENT = 0.8;

const circuitStates = new Map<string, CircuitState>();
const quotaStates = new Map<string, QuotaState>();

export function resetProviderRuntimeState(): void {
  circuitStates.clear();
  quotaStates.clear();
}

function providerKey(config: DirectProviderConfig): string {
  return config.provider;
}

export function restoreProviderRuntimeState(
  snapshot: ProviderRuntimeSnapshot,
  now: number = Date.now(),
): void {
  const key = snapshot.provider;
  const wasOpen = snapshot.circuitState !== 'closed';
  circuitStates.set(key, {
    // Do not resurrect old failures into a fresh two-minute window after a
    // restart. Only a persisted open/half-open breaker keeps its state.
    failureTimes: wasOpen ?
      Array(Math.max(0, snapshot.consecutiveFailures)).fill(now) : [],
    openUntil: wasOpen ? Math.max(now, snapshot.openUntil || now) : 0,
    halfOpenInFlight: false,
  });
  quotaStates.set(key, {
    day: snapshot.quotaDate,
    requests: Math.max(0, snapshot.dailyRequests),
    tokens: Math.max(0, snapshot.dailyTokens),
  });
}

export function getProviderRuntimeState(
  provider: DirectProviderName,
  now: number = Date.now(),
): ProviderRuntimeSnapshot {
  const circuit = circuitStates.get(provider);
  const quota = quotaStates.get(provider);
  const day = utcDay(now);
  return {
    provider,
    circuitState: circuit?.openUntil && circuit.openUntil > now ?
      'open' : circuit?.halfOpenInFlight ? 'half_open' : 'closed',
    consecutiveFailures: circuit?.failureTimes.length || 0,
    openUntil: circuit?.openUntil || undefined,
    quotaDate: quota?.day === day ? quota.day : day,
    dailyRequests: quota?.day === day ? quota.requests : 0,
    dailyTokens: quota?.day === day ? quota.tokens : 0,
  };
}

function utcDay(timestamp: number): string {
  return new Date(timestamp).toISOString().slice(0, 10);
}

function quotaState(config: DirectProviderConfig, now: number): QuotaState {
  const key = providerKey(config);
  const day = utcDay(now);
  const existing = quotaStates.get(key);
  if (existing && existing.day === day) return existing;
  const created = {day, requests: 0, tokens: 0};
  quotaStates.set(key, created);
  return created;
}

function quotaReached(
  config: DirectProviderConfig,
  now: number,
  expectedTokens: number,
): boolean {
  const state = quotaState(config, now);
  const stopPercent = Math.min(
    DEFAULT_QUOTA_STOP_PERCENT,
    Math.max(0, config.quotaStopPercent ?? DEFAULT_QUOTA_STOP_PERCENT),
  );
  const requestCap = config.dailyRequestLimit ?
    config.dailyRequestLimit * stopPercent : undefined;
  const tokenCap = config.dailyTokenLimit ?
    config.dailyTokenLimit * stopPercent : undefined;
  return (
    requestCap !== undefined && state.requests + 1 > requestCap
  ) || (
    tokenCap !== undefined && state.tokens + expectedTokens > tokenCap
  );
}

function reserveQuotaUsage(
  config: DirectProviderConfig,
  now: number,
  expectedTokens: number,
): QuotaReservation {
  const state = quotaState(config, now);
  state.requests++;
  state.tokens += expectedTokens;
  return {day: state.day, tokens: expectedTokens};
}

function reconcileQuotaUsage(
  config: DirectProviderConfig,
  now: number,
  reservation: QuotaReservation,
  usage?: ProviderUsage,
): void {
  const state = quotaState(config, now);
  if (state.day !== reservation.day) return;
  // Many SDK/provider responses omit usage. Keep the conservative reservation
  // in that case so a free-tier cap cannot silently reset to zero.
  if (usage?.totalTokens === undefined) return;
  state.tokens = Math.max(
    0,
    state.tokens - reservation.tokens + usage.totalTokens,
  );
}

function circuitAvailable(config: DirectProviderConfig, now: number): boolean {
  const state = circuitStates.get(providerKey(config));
  if (!state) return true;
  if (state.openUntil > now) return false;
  if (state.openUntil > 0) {
    if (state.halfOpenInFlight) return false;
    state.halfOpenInFlight = true;
  }
  return true;
}

function recordProviderSuccess(config: DirectProviderConfig): void {
  circuitStates.delete(providerKey(config));
}

function releaseHalfOpenProbe(config: DirectProviderConfig): void {
  const state = circuitStates.get(providerKey(config));
  if (state?.halfOpenInFlight) state.halfOpenInFlight = false;
}

function recordProviderFailure(
  config: DirectProviderConfig,
  reason: ProviderFailureReason,
  now: number,
): void {
  if (
    reason === 'safety' ||
    reason === 'forbidden' ||
    reason === 'cancelled' ||
    reason === 'prompt_limit'
  ) {
    releaseHalfOpenProbe(config);
    return;
  }
  const key = providerKey(config);
  const windowMs = config.circuitBreaker?.failureWindowMs ||
    DEFAULT_FAILURE_WINDOW_MS;
  const threshold = config.circuitBreaker?.failureThreshold ||
    DEFAULT_FAILURE_THRESHOLD;
  const previous = circuitStates.get(key) || {
    failureTimes: [],
    openUntil: 0,
    halfOpenInFlight: false,
  };
  const failureTimes = previous.failureTimes
    .filter((timestamp) => now - timestamp <= windowMs);
  failureTimes.push(now);
  const shouldOpen = previous.halfOpenInFlight ||
    failureTimes.length >= threshold;
  circuitStates.set(key, {
    failureTimes,
    openUntil: shouldOpen ?
      now + (
        config.circuitBreaker?.cooldownMs || DEFAULT_CIRCUIT_COOLDOWN_MS
      ) : 0,
    halfOpenInFlight: false,
  });
}

async function defaultModelFactory(
  config: DirectProviderConfig,
  signal?: AbortSignal,
): Promise<InvokableChatModel> {
  if (config.provider === 'gemini') {
    const apiKey = config.apiKey || process.env.GOOGLE_API_KEY;
    return new ChatGoogle({
      apiKey,
      apiClient: createGeminiApiClient(apiKey),
      model: config.model,
      temperature: config.temperature ?? 0.2,
      maxOutputTokens: config.maxTokens ?? 512,
      maxRetries: 0,
      responseSchema: config.responseSchema,
    } as any) as unknown as InvokableChatModel;
  }
  // The Mistral SDK is ESM-only. With TypeScript's Node16 module mode this
  // remains a native dynamic import while the rest of the project stays CJS.
  const {ChatMistralAI} = await import('@langchain/mistralai');
  const httpClient = await createAbortAwareMistralHttpClient(signal);
  return new ChatMistralAI({
    apiKey: config.apiKey || process.env.MISTRAL_API_KEY,
    model: config.model,
    temperature: config.temperature ?? 0.2,
    maxTokens: config.maxTokens ?? 512,
    maxRetries: 0,
    httpClient,
  } as any) as unknown as InvokableChatModel;
}

export async function createAbortAwareMistralHttpClient(
  invocationSignal?: AbortSignal,
  fetcher: typeof fetch = globalThis.fetch,
): Promise<any> {
  const {HTTPClient} = await import('@mistralai/mistralai/lib/http.js');
  return new HTTPClient({
    fetcher: async (input: RequestInfo | URL, init?: RequestInit) => {
      const requestSignal = input instanceof Request ?
        input.signal : init?.signal;
      const signals = [invocationSignal, requestSignal]
        .filter((candidate): candidate is AbortSignal => !!candidate);
      const signal = signals.length > 1 ? AbortSignal.any(signals) : signals[0];
      if (input instanceof Request) {
        return fetcher(new Request(input, {...init, signal}));
      }
      return fetcher(input, {...init, signal});
    },
  });
}

function extractStatus(error: any): number | undefined {
  for (const candidate of [
    error?.status,
    error?.statusCode,
    error?.response?.status,
    error?.cause?.status,
    error?.error?.code,
    error?.code,
  ]) {
    const numeric = Number(candidate);
    if (Number.isInteger(numeric) && numeric >= 100 && numeric <= 599) {
      return numeric;
    }
  }
  const match = String(error?.message || error || '').match(
    /\b(401|402|403|404|408|429|5\d\d)\b/i,
  );
  return match ? Number(match[1]) : undefined;
}

function isSafetyFailure(value: any): boolean {
  const metadata = value?.response_metadata || value?.responseMetadata || {};
  const additional = value?.additional_kwargs || value?.additionalKwargs || {};
  const structuredBlockReasons = [
    metadata.blockReason,
    metadata.block_reason,
    metadata?.promptFeedback?.blockReason,
    metadata?.prompt_feedback?.block_reason,
    additional?.promptFeedback?.blockReason,
    additional?.prompt_feedback?.block_reason,
  ];
  const structuredRefusals = [
    metadata.refusal,
    additional.refusal,
    value?.refusal,
  ];
  if ([...structuredBlockReasons, ...structuredRefusals].some(candidate =>
    candidate !== undefined &&
    candidate !== null &&
    String(candidate).trim().length > 0,
  )) return true;
  const text = [
    metadata.finishReason,
    metadata.finish_reason,
    metadata.blockReason,
    metadata.block_reason,
    metadata.refusal,
    additional?.promptFeedback?.blockReason,
    additional?.prompt_feedback?.block_reason,
    additional?.refusal,
    value?.refusal,
    value?.name,
    value?.message,
  ].filter(Boolean).join(' ').toLowerCase();
  return /\b(safety|blocked|blocklist|spii|recitation|content[_ -]?filter|prohibited(?:[_ -]?content)?|refusal|refused)\b/.test(text);
}

function classifyError(error: any, signal: AbortSignal): ClassifiedError {
  if (signal.aborted) {
    return {reason: 'timeout', retryable: true};
  }
  if (isSafetyFailure(error)) {
    return {reason: 'safety', retryable: false};
  }
  const status = extractStatus(error);
  if (status === 401) {
    return {reason: 'auth', status, retryable: false};
  }
  if (status === 403) {
    return {reason: 'forbidden', status, retryable: false};
  }
  if (status === 402) {
    return {reason: 'credits', status, retryable: false};
  }
  if (status === 404) {
    return {reason: 'model_unavailable', status, retryable: true};
  }
  if (status === 429) {
    return {reason: 'rate_limit', status, retryable: true};
  }
  if (status === 408) {
    return {reason: 'timeout', status, retryable: true};
  }
  const message = String(error?.message || error || '').toLowerCase();
  if (/context|prompt|token.{0,12}limit|too large/.test(message)) {
    return {reason: 'prompt_limit', status, retryable: false};
  }
  if (
    error?.name === 'AbortError' ||
    /timeout|timed out|deadline/.test(message)
  ) {
    return {reason: 'timeout', status, retryable: true};
  }
  return {
    reason: 'provider_error',
    status,
    retryable: !status || status >= 500,
  };
}

function safeFailureMessage(reason: ProviderFailureReason): string {
  switch (reason) {
    case 'auth': return 'Provider authentication failed';
    case 'credits': return 'Provider free quota is unavailable';
    case 'prompt_limit': return 'Provider prompt limit was exceeded';
    case 'model_unavailable': return 'Configured model is unavailable';
    case 'rate_limit': return 'Provider rate limit was exceeded';
    case 'timeout': return 'Provider request timed out';
    case 'safety': return 'Provider rejected the request for safety reasons';
    case 'forbidden': return 'Provider rejected the request';
    case 'cancelled': return 'Provider request was cancelled';
    default: return 'Provider request failed';
  }
}

function extractContent(response: any): string {
  if (typeof response === 'string') return response.trim();
  if (typeof response?.content === 'string') return response.content.trim();
  if (Array.isArray(response?.content)) {
    return response.content
      .map((part: any) => typeof part === 'string' ? part : part?.text || '')
      .join('')
      .trim();
  }
  return '';
}

function numeric(value: unknown): number | undefined {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

function extractUsage(response: any): ProviderUsage | undefined {
  const usage = response?.usage_metadata || response?.usageMetadata ||
    response?.response_metadata?.tokenUsage ||
    response?.responseMetadata?.tokenUsage;
  if (!usage) return undefined;
  const inputTokens = numeric(
    usage.input_tokens ?? usage.inputTokens ?? usage.promptTokens,
  );
  const outputTokens = numeric(
    usage.output_tokens ?? usage.outputTokens ?? usage.completionTokens,
  );
  const totalTokens = numeric(
    usage.total_tokens ?? usage.totalTokens,
  ) ?? (
    inputTokens !== undefined || outputTokens !== undefined ?
      (inputTokens || 0) + (outputTokens || 0) : undefined
  );
  return inputTokens !== undefined ||
    outputTokens !== undefined ||
    totalTokens !== undefined ?
    {inputTokens, outputTokens, totalTokens} : undefined;
}

function estimateMessageTokens(messages: unknown): number {
  const visit = (value: any): string[] => {
    if (typeof value === 'string') return [value];
    if (Array.isArray(value)) return value.flatMap(visit);
    if (!value || typeof value !== 'object') return [];
    if (typeof value.content === 'string') return [value.content];
    if (Array.isArray(value.content)) return value.content.flatMap(visit);
    return [];
  };
  return Math.max(
    1,
    Math.ceil(Buffer.byteLength(visit(messages).join('\n'), 'utf8') / 4),
  );
}

function configTokenReservation(
  config: DirectProviderConfig,
  estimatedInputTokens: number,
): number {
  if (!config.dailyTokenLimit) return 0;
  return Math.max(1, estimatedInputTokens + (config.maxTokens || 512));
}

function localLangChainCallbacks(config: DirectProviderConfig): unknown[] {
  // Callback payloads may contain prompts, generations and provider metadata.
  // Deliberately ignore every callback argument and emit only an allowlisted
  // lifecycle event; detailed attempts are recorded separately after routing.
  return [{
    name: 'supportbot-local-observability',
    handleLLMStart: async () => logger.debug(
      'langchain',
      'LLM callback started',
      {provider: config.provider, model: config.model, status: 'started'},
    ),
    handleLLMEnd: async () => logger.debug(
      'langchain',
      'LLM callback completed',
      {provider: config.provider, model: config.model, status: 'completed'},
    ),
    handleLLMError: async () => logger.debug(
      'langchain',
      'LLM callback failed',
      {provider: config.provider, model: config.model, status: 'failed'},
    ),
  }];
}

function raceWithAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    const error = new Error('Provider operation aborted');
    error.name = 'AbortError';
    return Promise.reject(error);
  }
  return new Promise<T>((resolve, reject) => {
    const abort = () => {
      const error = new Error('Provider operation aborted');
      error.name = 'AbortError';
      reject(error);
    };
    signal.addEventListener('abort', abort, {once: true});
    promise.then(resolve, reject).finally(() => {
      signal.removeEventListener('abort', abort);
    });
  });
}

function linkedAbortController(
  parent: AbortSignal | undefined,
  timeoutMs: number,
): {controller: AbortController; cleanup: () => void; parentAborted: () => boolean} {
  const controller = new AbortController();
  let wasParentAborted = !!parent?.aborted;
  const abortFromParent = () => {
    wasParentAborted = true;
    controller.abort(parent?.reason);
  };
  if (parent?.aborted) abortFromParent();
  else parent?.addEventListener('abort', abortFromParent, {once: true});
  const timer = setTimeout(() => controller.abort(), Math.max(1, timeoutMs));
  return {
    controller,
    parentAborted: () => wasParentAborted,
    cleanup: () => {
      clearTimeout(timer);
      parent?.removeEventListener('abort', abortFromParent);
    },
  };
}

function fallbackAllowed(failure: ClassifiedError): boolean {
  if (
    failure.reason === 'safety' ||
    failure.reason === 'forbidden' ||
    failure.reason === 'cancelled' ||
    failure.reason === 'prompt_limit'
  ) return false;
  if (failure.reason === 'provider_error') return failure.retryable;
  return [
    'auth',
    'credits',
    'model_unavailable',
    'rate_limit',
    'timeout',
  ].includes(failure.reason);
}

export class ProviderRouter {
  private readonly config: ProviderRouterConfig;
  private readonly dependencies: ProviderRouterDependencies;

  constructor(
    config: ProviderRouterConfig,
    dependencies: ProviderRouterDependencies = {},
  ) {
    this.config = config;
    this.dependencies = dependencies;
  }

  async invoke(messages: unknown, signal?: AbortSignal): Promise<ProviderRouterResult> {
    const now = this.dependencies.now || Date.now;
    const startedAt = now();
    const deadlineMs = Math.max(1, this.config.deadlineMs || DEFAULT_DEADLINE_MS);
    const candidates = [this.config.primary, this.config.fallback]
      .filter(Boolean) as DirectProviderConfig[];
    const maxAttempts = Math.max(1, Math.min(
      DEFAULT_MAX_ATTEMPTS, this.config.maxAttempts || DEFAULT_MAX_ATTEMPTS,
    ));
    const uniqueCandidates = candidates.filter((candidate, index, all) =>
      all.findIndex((other) => other.provider === candidate.provider &&
        other.model === candidate.model) === index,
    ).slice(0, maxAttempts);
    const singleProvider = !this.config.fallback;
    if (singleProvider) {
      while (uniqueCandidates.length < maxAttempts) {
        uniqueCandidates.push(this.config.primary);
      }
    }
    const attempts: ProviderAttempt[] = [];
    const sharedSignal = signal || this.dependencies.signal;
    let lastFailure: ProviderFailure | undefined;

    const estimatedInputTokens = estimateMessageTokens(messages);
    for (const [candidateIndex, providerConfig] of uniqueCandidates.entries()) {
      if (singleProvider && candidateIndex > 0 && lastFailure) {
        const transient = lastFailure.retryable && (
          lastFailure.reason === 'provider_error' ||
          lastFailure.reason === 'timeout' ||
          lastFailure.reason === 'rate_limit'
        );
        if (!transient) return lastFailure;
        const retryDelayMs = 500 * (2 ** (candidateIndex - 1));
        if (deadlineMs - (now() - startedAt) <= retryDelayMs) {
          return lastFailure;
        }
        try {
          await delay(retryDelayMs, undefined, {signal: sharedSignal});
        } catch (_error) {
          return {...lastFailure, reason: 'cancelled', retryable: false,
            message: safeFailureMessage('cancelled')};
        }
      }
      const attemptStartedAt = now();
      if (sharedSignal?.aborted) {
        return {
          ok: false,
          reason: 'cancelled',
          provider: providerConfig.provider,
          model: providerConfig.model,
          retryable: false,
          message: safeFailureMessage('cancelled'),
          attempts,
        };
      }
      const remainingMs = deadlineMs - (attemptStartedAt - startedAt);
      if (remainingMs <= 0) {
        return {
          ok: false,
          reason: 'timeout',
          provider: providerConfig.provider,
          model: providerConfig.model,
          retryable: true,
          message: safeFailureMessage('timeout'),
          attempts,
        };
      }
      const expectedTokens = configTokenReservation(
        providerConfig,
        estimatedInputTokens,
      );
      if (quotaReached(providerConfig, attemptStartedAt, expectedTokens)) {
        attempts.push({
          provider: providerConfig.provider,
          model: providerConfig.model,
          startedAt: attemptStartedAt,
          latencyMs: 0,
          outcome: 'skipped',
          reason: 'quota_cap',
        });
        continue;
      }
      // A failure of the primary model must not prevent the configured model
      // fallback in this same turn. Quotas remain shared by provider; if both
      // models fail, the provider circuit still protects subsequent turns.
      const sameProviderFallback = providerConfig.provider ===
        this.config.primary.provider &&
        providerConfig.model !== this.config.primary.model &&
        attempts.some(attempt => attempt.model === this.config.primary.model &&
          attempt.provider === providerConfig.provider && attempt.outcome === 'failure');
      if (!circuitAvailable(providerConfig, attemptStartedAt) && !sameProviderFallback) {
        attempts.push({
          provider: providerConfig.provider,
          model: providerConfig.model,
          startedAt: attemptStartedAt,
          latencyMs: 0,
          outcome: 'skipped',
          reason: 'circuit_open',
        });
        continue;
      }

      const quotaReservation = reserveQuotaUsage(
        providerConfig,
        attemptStartedAt,
        expectedTokens,
      );

      const laterProvider = uniqueCandidates[candidateIndex + 1];
      const fallbackReserveMs = laterProvider ? Math.min(
        laterProvider.timeoutMs || DEFAULT_PROVIDER_TIMEOUT_MS,
        Math.max(1000, Math.floor(remainingMs * 0.35)),
      ) : 0;
      const timeoutMs = Math.min(
        Math.max(1, remainingMs - fallbackReserveMs),
        providerConfig.timeoutMs || DEFAULT_PROVIDER_TIMEOUT_MS,
      );
      const linked = linkedAbortController(sharedSignal, timeoutMs);
      try {
        const factory = this.dependencies.modelFactory || defaultModelFactory;
        const model = await raceWithAbort(
          Promise.resolve(factory(providerConfig, linked.controller.signal)),
          linked.controller.signal,
        );
        if (linked.controller.signal.aborted) {
          const abortError = new Error('Provider initialization aborted');
          abortError.name = 'AbortError';
          throw abortError;
        }
        const response = await raceWithAbort(
          model.invoke(messages, {
            signal: linked.controller.signal,
            callbacks: localLangChainCallbacks(providerConfig),
          }),
          linked.controller.signal,
        );
        if (linked.controller.signal.aborted) {
          const abortError = new Error('Provider invocation aborted');
          abortError.name = 'AbortError';
          throw abortError;
        }
        const latencyMs = now() - attemptStartedAt;
        if (isSafetyFailure(response)) {
          const attempt: ProviderAttempt = {
            provider: providerConfig.provider,
            model: providerConfig.model,
            startedAt: attemptStartedAt,
            latencyMs,
            outcome: 'failure',
            reason: 'safety',
          };
          attempts.push(attempt);
          reconcileQuotaUsage(
            providerConfig,
            now(),
            quotaReservation,
          );
          recordProviderSuccess(providerConfig);
          return {
            ok: false,
            reason: 'safety',
            provider: providerConfig.provider,
            model: providerConfig.model,
            retryable: false,
            message: safeFailureMessage('safety'),
            attempts,
          };
        }
        const content = extractContent(response);
        if (!content) {
          throw new Error('Provider returned an empty response');
        }
        const usage = extractUsage(response);
        attempts.push({
          provider: providerConfig.provider,
          model: providerConfig.model,
          startedAt: attemptStartedAt,
          latencyMs,
          outcome: 'success',
          usage,
        });
        reconcileQuotaUsage(
          providerConfig,
          now(),
          quotaReservation,
          usage,
        );
        recordProviderSuccess(providerConfig);
        return {
          ok: true,
          content,
          provider: providerConfig.provider,
          model: providerConfig.model,
          usage,
          attempts,
        };
      } catch (error) {
        const parentCancelled = linked.parentAborted();
        const classified = parentCancelled ? {
          reason: 'cancelled' as ProviderFailureReason,
          retryable: false,
        } : classifyError(error, linked.controller.signal);
        const latencyMs = now() - attemptStartedAt;
        attempts.push({
          provider: providerConfig.provider,
          model: providerConfig.model,
          startedAt: attemptStartedAt,
          latencyMs,
          outcome: 'failure',
          reason: classified.reason,
          status: classified.status,
        });
        reconcileQuotaUsage(
          providerConfig,
          now(),
          quotaReservation,
        );
        if (
          classified.reason === 'cancelled' ||
          classified.reason === 'prompt_limit' ||
          (classified.reason === 'provider_error' && !classified.retryable)
        ) {
          releaseHalfOpenProbe(providerConfig);
        } else {
          recordProviderFailure(providerConfig, classified.reason, now());
        }
        lastFailure = {
          ok: false,
          reason: classified.reason,
          provider: providerConfig.provider,
          model: providerConfig.model,
          status: classified.status,
          retryable: classified.retryable,
          message: safeFailureMessage(classified.reason),
          attempts: [...attempts],
        };
        if (!fallbackAllowed(classified)) return lastFailure;
      } finally {
        linked.cleanup();
      }
    }

    if (lastFailure) return {...lastFailure, attempts};
    return {
      ok: false,
      reason: 'model_unavailable',
      provider: this.config.primary.provider,
      model: this.config.primary.model,
      retryable: true,
      message: 'All direct provider routes are unavailable',
      attempts,
    };
  }
}
