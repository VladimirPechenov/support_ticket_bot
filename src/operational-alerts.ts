import {ProviderAttempt} from './ai-provider';
import {logger} from './logger';

export type MonitoredDependency =
  'embeddings' | 'qdrant' | 'telegram' | 'db';

export interface AiSloSnapshot {
  llmRuns: number;
  successfulRuns: number;
  fallbackRuns: number;
  latencyP95Ms: number;
}

type AlertSender = (message: string) => Promise<unknown>;

interface AlertState {
  active: boolean;
  lastSentAt: number;
  consecutiveFailures: number;
  pending?: boolean;
}

const DEDUPE_MS = 30 * 60 * 1000;
const DEPENDENCY_FAILURE_THRESHOLD = 3;
const MINIMUM_SLO_SAMPLE = 20;
const states = new Map<string, AlertState>();
let sender: AlertSender | undefined;
let now: () => number = Date.now;

function stateFor(key: string): AlertState {
  const existing = states.get(key);
  if (existing) return existing;
  const created = {active: false, lastSentAt: 0, consecutiveFailures: 0};
  states.set(key, created);
  return created;
}

async function send(message: string): Promise<boolean> {
  if (!sender) return false;
  try {
    await sender(message);
    return true;
  } catch (_error) {
    logger.warn('operationalAlerts', 'Operational alert delivery failed');
    return false;
  }
}

async function setCondition(
  key: string,
  active: boolean,
  message: string,
  recoveryMessage = message,
): Promise<void> {
  const state = stateFor(key);
  const timestamp = now();
  if (state.pending) return;
  if (active) {
    if (!state.active || timestamp - state.lastSentAt >= DEDUPE_MS) {
      state.pending = true;
      try {
        if (await send(`⚠️ ${message}`)) {
          state.active = true;
          state.lastSentAt = timestamp;
        }
      } finally {
        state.pending = false;
      }
    }
    return;
  }
  if (state.active) {
    state.pending = true;
    try {
      if (await send(`✅ Восстановление: ${recoveryMessage}`)) {
        state.active = false;
        state.lastSentAt = timestamp;
      }
    } finally {
      state.pending = false;
    }
  }
}

export function configureOperationalAlerts(
  alertSender: AlertSender,
): void {
  sender = alertSender;
}

export async function recordDependencyStatus(
  dependency: MonitoredDependency,
  healthy: boolean,
): Promise<void> {
  const key = `dependency_${dependency}`;
  const state = stateFor(key);
  if (healthy) {
    state.consecutiveFailures = 0;
    await setCondition(
      key,
      false,
      `${dependency}: три последовательных сбоя`,
      `${dependency} снова доступен`,
    );
    return;
  }
  state.consecutiveFailures++;
  await setCondition(
    key,
    state.consecutiveFailures >= DEPENDENCY_FAILURE_THRESHOLD,
    `${dependency}: три последовательных сбоя`,
  );
}

export async function recordProviderRun(
  attempts: ProviderAttempt[],
  ticketId?: string | number,
): Promise<void> {
  if (attempts.length === 0 || attempts.at(-1)?.reason === 'cancelled') return;
  const providers = new Set(attempts.map(attempt => attempt.provider));
  const hasSuccess = attempts.some(attempt => attempt.outcome === 'success');
  const actionableAttempts = attempts.filter(attempt =>
    attempt.outcome === 'success' || (attempt.reason && ![
      'cancelled', 'safety', 'prompt_limit',
    ].includes(attempt.reason)),
  );
  if (hasSuccess || (providers.has('gemini') && providers.has('mistral') &&
    actionableAttempts.length === attempts.length)) await setCondition(
    'both_providers_unavailable',
    providers.has('gemini') && providers.has('mistral') && !hasSuccess,
    'Gemini и Mistral одновременно недоступны',
    'хотя бы один LLM-провайдер снова доступен',
  );
  for (const provider of ['gemini', 'mistral'] as const) {
    const providerAttempts = attempts.filter(
      attempt => attempt.provider === provider,
    );
    if (providerAttempts.length === 0) continue;
    const providerSuccess = providerAttempts.some(attempt =>
      attempt.outcome === 'success',
    );
    const lastFailure = [...providerAttempts].reverse().find(attempt =>
      ['provider_error', 'timeout', 'model_unavailable', 'circuit_open']
        .includes(attempt.reason || ''),
    );
    if (providerSuccess || lastFailure) {
      if (!providerSuccess && lastFailure) logger.warn(
        'operationalAlerts', 'LLM provider request failed', {
          ticketId, provider, errorReason: lastFailure.reason,
          statusCode: lastFailure.status, count: providerAttempts.length,
        },
      );
      const cause = lastFailure?.reason === 'timeout' ? 'тайм-аут' :
        lastFailure?.status ? `HTTP ${lastFailure.status}` :
        lastFailure?.reason === 'circuit_open' ? 'защита от повторных сбоев' :
        'ошибка провайдера';
      const ticket = ticketId == null ? '' : `; тикет №${ticketId}`;
      await setCondition(
        `${provider}_unavailable`, !providerSuccess,
        `${provider}: запрос не выполнен (${cause}${ticket}). Проверьте очередь операторов.`,
        `${provider}: запрос успешно выполнен`,
      );
    }
    const authFailure = !providerSuccess && providerAttempts.some(
      attempt => attempt.reason === 'auth',
    );
    const quotaFailure = !providerSuccess && providerAttempts.some(attempt =>
      ['credits', 'rate_limit', 'quota_cap'].includes(attempt.reason || ''),
    );
    if (authFailure || providerSuccess) await setCondition(
      `${provider}_auth`,
      authFailure,
      `${provider}: ошибка авторизации`,
      `${provider}: доступ восстановлен`,
    );
    if (quotaFailure || providerSuccess) await setCondition(
      `${provider}_quota`,
      quotaFailure,
      `${provider}: бесплатная квота недоступна`,
      `${provider}: квота снова доступна`,
    );
  }
}

export async function recordTicketDeliveryFailure(
  ticketId: string | number,
  reason: string,
): Promise<void> {
  const causes: Record<string, string> = {
    bot_blocked: 'пользователь заблокировал бота',
    forbidden: 'Telegram запретил отправку',
    recipient_unavailable: 'получатель недоступен',
    rate_limit: 'ограничение частоты отправки',
    timeout: 'тайм-аут Telegram',
    bad_request: 'Telegram отклонил сообщение',
  };
  await setCondition(
    `ticket_delivery_${ticketId}`, true,
    `Тикет №${ticketId}: ответ оператора не отправлен (${causes[reason] || 'ошибка Telegram'}). ` +
      'Тикет не закрыт автоматически. Проверьте доставку перед повторной отправкой.',
  );
}

export async function recordTicketDeliverySuccess(
  ticketId: string | number,
): Promise<void> {
  await setCondition(
    `ticket_delivery_${ticketId}`, false, '',
    `ответ по тикету №${ticketId} успешно отправлен`,
  );
}

export async function recordQuotaRatio(
  provider: 'gemini' | 'mistral',
  ratio: number,
): Promise<void> {
  const normalized = Number.isFinite(ratio) ? Math.max(0, ratio) : 0;
  await setCondition(
    `${provider}_quota_80`,
    normalized >= 0.8,
    `${provider}: использовано не менее 80% дневной free-квоты`,
    `${provider}: счётчик дневной free-квоты ниже 80%`,
  );
  await setCondition(
    `${provider}_quota_95`,
    normalized >= 0.95,
    `${provider}: использовано не менее 95% дневной free-квоты`,
    `${provider}: счётчик дневной free-квоты ниже 95%`,
  );
}

export async function evaluateAiSlo(snapshot: AiSloSnapshot): Promise<void> {
  const enoughData = snapshot.llmRuns >= MINIMUM_SLO_SAMPLE;
  const successRate = snapshot.llmRuns > 0 ?
    snapshot.successfulRuns / snapshot.llmRuns : 1;
  const fallbackRate = snapshot.llmRuns > 0 ?
    snapshot.fallbackRuns / snapshot.llmRuns : 0;
  await setCondition(
    'llm_success_rate',
    enoughData && successRate < 0.95,
    'успешность LLM ниже 95%',
    'успешность LLM вернулась к 95% или выше',
  );
  await setCondition(
    'llm_latency_p95',
    enoughData && snapshot.latencyP95Ms > 15000,
    'p95 LLM выше 15 секунд',
    'p95 LLM вернулся к 15 секундам или ниже',
  );
  await setCondition(
    'llm_fallback_rate',
    enoughData && fallbackRate > 0.2,
    'доля fallback выше 20%',
    'доля fallback вернулась к 20% или ниже',
  );
}

export function resetOperationalAlertsForTests(
  options: {sender?: AlertSender; now?: () => number} = {},
): void {
  states.clear();
  sender = options.sender;
  now = options.now || Date.now;
}
