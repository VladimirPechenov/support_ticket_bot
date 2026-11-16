import {LlmFailure, LlmResult} from './ai-client';
import {AiAnswerMode} from './interfaces';

interface FeedbackCounters {
  helpful: number;
  notHelpful: number;
  operator: number;
}

export interface ProviderMetricCounters {
  attempts: number;
  successes: number;
  failures: number;
  fallbackAttempts: number;
  fallbackSuccesses: number;
  totalLatencyMs: number;
  maxLatencyMs: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  byFailure: Record<string, number>;
}

export interface ToolMetricCounters {
  calls: number;
  successes: number;
  failures: number;
  cancellations: number;
  totalLatencyMs: number;
  maxLatencyMs: number;
  byFailure: Record<string, number>;
}

export interface ProviderAttemptMetricInput {
  provider: string;
  ok: boolean;
  latencyMs?: number;
  isFallback?: boolean;
  failureReason?: string;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
}

export interface ToolMetricInput {
  toolName: string;
  outcome: 'success' | 'failure' | 'cancelled';
  latencyMs?: number;
  failureReason?: string;
}

export interface AiMetrics {
  requests: number;
  successes: number;
  failures: number;
  fallbackSuccesses: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  costUsd: number;
  totalLatencyMs: number;
  maxLatencyMs: number;
  byModel: Record<string, number>;
  byFailure: Record<string, number>;
  ragRequests: number;
  ragHits: number;
  answerModes: {llm: number; directRag: number};
  handoffs: number;
  byHandoff: Record<string, number>;
  feedback: FeedbackCounters;
  feedbackByMode: Record<string, FeedbackCounters>;
  providerAttempts: number;
  providerSuccesses: number;
  providerFailures: number;
  fallbackAttempts: number;
  fallbackAttemptSuccesses: number;
  byProvider: Record<string, ProviderMetricCounters>;
  toolCalls: number;
  toolSuccesses: number;
  toolFailures: number;
  toolCancellations: number;
  byTool: Record<string, ToolMetricCounters>;
}

function emptyFeedback(): FeedbackCounters {
  return {helpful: 0, notHelpful: 0, operator: 0};
}

function emptyProviderCounters(): ProviderMetricCounters {
  return {
    attempts: 0,
    successes: 0,
    failures: 0,
    fallbackAttempts: 0,
    fallbackSuccesses: 0,
    totalLatencyMs: 0,
    maxLatencyMs: 0,
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    byFailure: {},
  };
}

function emptyToolCounters(): ToolMetricCounters {
  return {
    calls: 0,
    successes: 0,
    failures: 0,
    cancellations: 0,
    totalLatencyMs: 0,
    maxLatencyMs: 0,
    byFailure: {},
  };
}

const metrics: AiMetrics = {
  requests: 0,
  successes: 0,
  failures: 0,
  fallbackSuccesses: 0,
  promptTokens: 0,
  completionTokens: 0,
  totalTokens: 0,
  costUsd: 0,
  totalLatencyMs: 0,
  maxLatencyMs: 0,
  byModel: {},
  byFailure: {},
  ragRequests: 0,
  ragHits: 0,
  answerModes: {llm: 0, directRag: 0},
  handoffs: 0,
  byHandoff: {},
  feedback: emptyFeedback(),
  feedbackByMode: {},
  providerAttempts: 0,
  providerSuccesses: 0,
  providerFailures: 0,
  fallbackAttempts: 0,
  fallbackAttemptSuccesses: 0,
  byProvider: {},
  toolCalls: 0,
  toolSuccesses: 0,
  toolFailures: 0,
  toolCancellations: 0,
  byTool: {},
};

export function recordLlmResult(result: LlmResult): void {
  metrics.requests++;
  metrics.totalLatencyMs += result.latencyMs;
  metrics.maxLatencyMs = Math.max(metrics.maxLatencyMs, result.latencyMs);
  metrics.byModel[result.model] = (metrics.byModel[result.model] || 0) + 1;

  if (result.ok) {
    metrics.successes++;
    if (result.usedFallback) metrics.fallbackSuccesses++;
    metrics.promptTokens += result.usage?.prompt_tokens || 0;
    metrics.completionTokens += result.usage?.completion_tokens || 0;
    metrics.totalTokens += result.usage?.total_tokens || 0;
    metrics.costUsd += result.usage?.cost || 0;
    return;
  }

  const failure = result as LlmFailure;
  metrics.failures++;
  metrics.byFailure[failure.reason] =
    (metrics.byFailure[failure.reason] || 0) + 1;
}

export function recordRagResult(hasContext: boolean): void {
  metrics.ragRequests++;
  if (hasContext) metrics.ragHits++;
}

export function recordAiAnswer(mode: AiAnswerMode): void {
  if (mode === 'llm') metrics.answerModes.llm++;
  if (mode === 'direct_rag') metrics.answerModes.directRag++;
}

export function recordAiHandoff(reason: string): void {
  metrics.handoffs++;
  metrics.byHandoff[reason] = (metrics.byHandoff[reason] || 0) + 1;
}

export function recordAiFeedback(
  feedback: 'helpful' | 'not_helpful' | 'operator',
  mode: AiAnswerMode | 'unknown' = 'unknown',
): void {
  const modeFeedback = metrics.feedbackByMode[mode] || emptyFeedback();
  metrics.feedbackByMode[mode] = modeFeedback;
  if (feedback === 'helpful') {
    metrics.feedback.helpful++;
    modeFeedback.helpful++;
  }
  if (feedback === 'not_helpful') {
    metrics.feedback.notHelpful++;
    modeFeedback.notHelpful++;
  }
  if (feedback === 'operator') {
    metrics.feedback.operator++;
    modeFeedback.operator++;
  }
}

export function recordProviderAttemptMetric(
  input: ProviderAttemptMetricInput,
): void {
  const provider = input.provider || 'unknown';
  const counters = metrics.byProvider[provider] || emptyProviderCounters();
  metrics.byProvider[provider] = counters;
  const latencyMs = Math.max(0, Number(input.latencyMs || 0));

  metrics.providerAttempts++;
  counters.attempts++;
  counters.totalLatencyMs += latencyMs;
  counters.maxLatencyMs = Math.max(counters.maxLatencyMs, latencyMs);
  counters.promptTokens += Math.max(0, Number(input.promptTokens || 0));
  counters.completionTokens += Math.max(
    0,
    Number(input.completionTokens || 0),
  );
  counters.totalTokens += Math.max(0, Number(input.totalTokens || 0));

  if (input.isFallback) {
    metrics.fallbackAttempts++;
    counters.fallbackAttempts++;
  }
  if (input.ok) {
    metrics.providerSuccesses++;
    counters.successes++;
    if (input.isFallback) {
      metrics.fallbackAttemptSuccesses++;
      counters.fallbackSuccesses++;
    }
    return;
  }

  metrics.providerFailures++;
  counters.failures++;
  const reason = input.failureReason || 'unknown';
  counters.byFailure[reason] = (counters.byFailure[reason] || 0) + 1;
}

export function recordToolMetric(input: ToolMetricInput): void {
  const toolName = input.toolName || 'unknown';
  const counters = metrics.byTool[toolName] || emptyToolCounters();
  metrics.byTool[toolName] = counters;
  const latencyMs = Math.max(0, Number(input.latencyMs || 0));

  metrics.toolCalls++;
  counters.calls++;
  counters.totalLatencyMs += latencyMs;
  counters.maxLatencyMs = Math.max(counters.maxLatencyMs, latencyMs);
  if (input.outcome === 'success') {
    metrics.toolSuccesses++;
    counters.successes++;
    return;
  }
  if (input.outcome === 'cancelled') {
    metrics.toolCancellations++;
    counters.cancellations++;
  } else {
    metrics.toolFailures++;
    counters.failures++;
  }
  const reason = input.failureReason || input.outcome;
  counters.byFailure[reason] = (counters.byFailure[reason] || 0) + 1;
}

export function getAiMetricsSnapshot(): AiMetrics & {
  averageLatencyMs: number;
  ragHitRate: number;
  helpfulRate: number;
  providerSuccessRate: number;
  toolSuccessRate: number;
} {
  const rated = metrics.feedback.helpful + metrics.feedback.notHelpful +
    metrics.feedback.operator;
  return {
    ...metrics,
    byModel: {...metrics.byModel},
    byFailure: {...metrics.byFailure},
    answerModes: {...metrics.answerModes},
    byHandoff: {...metrics.byHandoff},
    feedback: {...metrics.feedback},
    feedbackByMode: Object.fromEntries(
      Object.entries(metrics.feedbackByMode)
        .map(([mode, counters]) => [mode, {...counters}]),
    ),
    byProvider: Object.fromEntries(
      Object.entries(metrics.byProvider).map(([provider, counters]) => [
        provider,
        {...counters, byFailure: {...counters.byFailure}},
      ]),
    ),
    byTool: Object.fromEntries(
      Object.entries(metrics.byTool).map(([tool, counters]) => [
        tool,
        {...counters, byFailure: {...counters.byFailure}},
      ]),
    ),
    averageLatencyMs: metrics.requests > 0 ?
      Math.round(metrics.totalLatencyMs / metrics.requests) :
      0,
    ragHitRate: metrics.ragRequests > 0 ?
      metrics.ragHits / metrics.ragRequests :
      0,
    helpfulRate: rated > 0 ? metrics.feedback.helpful / rated : 0,
    providerSuccessRate: metrics.providerAttempts > 0 ?
      metrics.providerSuccesses / metrics.providerAttempts : 0,
    toolSuccessRate: metrics.toolCalls > 0 ?
      metrics.toolSuccesses / metrics.toolCalls : 0,
  };
}

function formatRecord(record: Record<string, number>): string {
  const entries = Object.entries(record);
  return entries.length > 0 ?
    entries.map(([key, value]) => `${key}=${value}`).join(', ') :
    'none';
}

function formatFeedbackByMode(
  record: Record<string, FeedbackCounters>,
): string {
  const entries = Object.entries(record);
  if (entries.length === 0) return 'none';
  return entries.map(([mode, counters]) => {
    const rated = counters.helpful + counters.notHelpful + counters.operator;
    const helpfulRate = rated > 0 ? counters.helpful / rated : 0;
    return `${mode}: helpful=${counters.helpful}, ` +
      `not_helpful=${counters.notHelpful}, operator=${counters.operator}, ` +
      `helpful_rate=${(helpfulRate * 100).toFixed(1)}%`;
  }).join('; ');
}

function formatFailuresByName(
  record: Record<string, {byFailure: Record<string, number>}>,
): string {
  const entries = Object.entries(record)
    .filter(([_name, counters]) =>
      Object.keys(counters.byFailure).length > 0,
    );
  return entries.length > 0 ?
    entries.map(([name, counters]) =>
      `${name}: ${formatRecord(counters.byFailure)}`,
    ).join('; ') : 'none';
}

export function formatAiMetrics(): string {
  const snapshot = getAiMetricsSnapshot();
  return [
    'AI metrics (since process start)',
    `LLM: requests=${snapshot.requests}, successes=${snapshot.successes}, ` +
      `failures=${snapshot.failures}, fallback=${snapshot.fallbackSuccesses}`,
    `LLM failures: ${formatRecord(snapshot.byFailure)}`,
    `Providers: attempts=${snapshot.providerAttempts}, ` +
      `successes=${snapshot.providerSuccesses}, ` +
      `failures=${snapshot.providerFailures}, ` +
      `success_rate=${(snapshot.providerSuccessRate * 100).toFixed(1)}%, ` +
      `fallback=${snapshot.fallbackAttemptSuccesses}/` +
      `${snapshot.fallbackAttempts}`,
    `Provider attempts: ${formatRecord(Object.fromEntries(
      Object.entries(snapshot.byProvider)
        .map(([provider, counters]) => [provider, counters.attempts]),
    ))}`,
    `Provider failures: ${formatFailuresByName(snapshot.byProvider)}`,
    `Tools: calls=${snapshot.toolCalls}, ` +
      `successes=${snapshot.toolSuccesses}, ` +
      `failures=${snapshot.toolFailures}, ` +
      `cancelled=${snapshot.toolCancellations}, ` +
      `success_rate=${(snapshot.toolSuccessRate * 100).toFixed(1)}%`,
    `Tool calls: ${formatRecord(Object.fromEntries(
      Object.entries(snapshot.byTool)
        .map(([tool, counters]) => [tool, counters.calls]),
    ))}`,
    `Tool failures: ${formatFailuresByName(snapshot.byTool)}`,
    `RAG: requests=${snapshot.ragRequests}, hits=${snapshot.ragHits}, ` +
      `hit_rate=${(snapshot.ragHitRate * 100).toFixed(1)}%`,
    `Answers: llm=${snapshot.answerModes.llm}, ` +
      `direct_rag=${snapshot.answerModes.directRag}, ` +
      `handoff=${snapshot.handoffs}`,
    `Handoffs: ${formatRecord(snapshot.byHandoff)}`,
    `Tokens: ${snapshot.totalTokens}; cost=$${snapshot.costUsd.toFixed(6)}`,
    `Latency: average=${snapshot.averageLatencyMs} ms, ` +
      `max=${snapshot.maxLatencyMs} ms`,
    `Feedback: helpful=${snapshot.feedback.helpful}, ` +
      `not_helpful=${snapshot.feedback.notHelpful}, ` +
      `operator=${snapshot.feedback.operator}, ` +
      `helpful_rate=${(snapshot.helpfulRate * 100).toFixed(1)}%`,
    `Feedback by mode: ${formatFeedbackByMode(snapshot.feedbackByMode)}`,
  ].join('\n');
}

export function resetAiMetrics(): void {
  metrics.requests = 0;
  metrics.successes = 0;
  metrics.failures = 0;
  metrics.fallbackSuccesses = 0;
  metrics.promptTokens = 0;
  metrics.completionTokens = 0;
  metrics.totalTokens = 0;
  metrics.costUsd = 0;
  metrics.totalLatencyMs = 0;
  metrics.maxLatencyMs = 0;
  metrics.byModel = {};
  metrics.byFailure = {};
  metrics.ragRequests = 0;
  metrics.ragHits = 0;
  metrics.answerModes.llm = 0;
  metrics.answerModes.directRag = 0;
  metrics.handoffs = 0;
  metrics.byHandoff = {};
  metrics.feedback = emptyFeedback();
  metrics.feedbackByMode = {};
  metrics.providerAttempts = 0;
  metrics.providerSuccesses = 0;
  metrics.providerFailures = 0;
  metrics.fallbackAttempts = 0;
  metrics.fallbackAttemptSuccesses = 0;
  metrics.byProvider = {};
  metrics.toolCalls = 0;
  metrics.toolSuccesses = 0;
  metrics.toolFailures = 0;
  metrics.toolCancellations = 0;
  metrics.byTool = {};
}
