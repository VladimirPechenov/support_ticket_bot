import {createServer, IncomingMessage, Server, ServerResponse} from 'http';
import cache from './cache';
import * as db from './db';
import {getAiMetricsSnapshot} from './ai-metrics';
import {logger} from './logger';
import {recordDependencyStatus} from './operational-alerts';
import {loadFullKnowledgeBase} from './full-knowledge-agent';

let server: Server | undefined;
let telegramReady = false;

export function setTelegramReady(ready: boolean): void {
  telegramReady = ready;
  void recordDependencyStatus('telegram', ready);
}

function sendJson(response: ServerResponse, status: number, body: unknown) {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  response.end(JSON.stringify(body));
}

function readiness() {
  let databaseReady = db.isDatabaseReady();
  let flags: db.RuntimeFeatureFlags = {
    aiMode: 'off',
    aiRolloutPercent: 0,
    webToolRolloutPercent: 0,
  };
  if (databaseReady) {
    try {
      flags = db.getRuntimeFeatureFlags();
    } catch (_error) {
      databaseReady = false;
    }
  }
  void recordDependencyStatus('db', databaseReady);
  const checks: Record<string, boolean> = {
    database: databaseReady,
    telegram: telegramReady,
    qdrantConfigured: !!(
      cache.config.ai?.rag?.qdrant?.url &&
      cache.config.ai?.rag?.qdrant?.collection
    ),
    googleKey: !!process.env.GOOGLE_API_KEY,
    mistralKey: !!process.env.MISTRAL_API_KEY,
  };
  const aiRequired = flags.aiMode !== 'off' && flags.aiRolloutPercent > 0;
  const geminiOnly = cache.config.ai?.llm?.providers?.primary?.provider ===
    'gemini' && !cache.config.ai.llm.providers.fallback &&
    cache.config.ai.embeddings?.enabled === false;
  let aiReady = checks.qdrantConfigured && checks.googleKey &&
    (geminiOnly || flags.aiMode !== 'full' || checks.mistralKey);
  if (flags.aiMode === 'full') {
    try {
      checks.knowledgeBase = loadFullKnowledgeBase().length > 0;
    } catch (_error) {
      checks.knowledgeBase = false;
    }
    const profiles = cache.config.ai?.llm?.providers;
    const providers = [profiles?.primary, profiles?.fallback].filter(Boolean);
    aiReady = checks.knowledgeBase && providers.length > 0 &&
      providers.every(profile => profile?.provider === 'gemini' ?
        checks.googleKey : checks.mistralKey);
  }
  const ready = checks.database && checks.telegram && (!aiRequired || aiReady);
  return {ready, aiRequired, mode: flags.aiMode, checks};
}

function prometheusMetrics(): string {
  const metrics = getAiMetricsSnapshot();
  const flags = db.getRuntimeFeatureFlags();
  const slo = db.getAiSloSnapshot();
  const llmSuccessRate = slo.llmRuns > 0 ?
    slo.successfulRuns / slo.llmRuns : 1;
  const fallbackRate = slo.llmRuns > 0 ?
    slo.fallbackRuns / slo.llmRuns : 0;
  const lines = [
    '# HELP supportbot_ai_requests_total AI turns handled in this process.',
    '# TYPE supportbot_ai_requests_total counter',
    `supportbot_ai_requests_total ${metrics.requests}`,
    '# TYPE supportbot_ai_successes_total counter',
    `supportbot_ai_successes_total ${metrics.successes}`,
    '# TYPE supportbot_ai_failures_total counter',
    `supportbot_ai_failures_total ${metrics.failures}`,
    '# TYPE supportbot_ai_provider_attempts_total counter',
    `supportbot_ai_provider_attempts_total ${metrics.providerAttempts}`,
    '# TYPE supportbot_ai_provider_failures_total counter',
    `supportbot_ai_provider_failures_total ${metrics.providerFailures}`,
    '# TYPE supportbot_ai_fallback_attempts_total counter',
    `supportbot_ai_fallback_attempts_total ${metrics.fallbackAttempts}`,
    '# TYPE supportbot_ai_tool_calls_total counter',
    `supportbot_ai_tool_calls_total ${metrics.toolCalls}`,
    '# TYPE supportbot_ai_rag_hits_total counter',
    `supportbot_ai_rag_hits_total ${metrics.ragHits}`,
    '# TYPE supportbot_ai_rollout_percent gauge',
    `supportbot_ai_rollout_percent ${flags.aiRolloutPercent}`,
    '# TYPE supportbot_ai_web_rollout_percent gauge',
    `supportbot_ai_web_rollout_percent ${flags.webToolRolloutPercent}`,
    '# TYPE supportbot_ai_llm_success_ratio gauge',
    `supportbot_ai_llm_success_ratio ${llmSuccessRate}`,
    '# TYPE supportbot_ai_fallback_ratio gauge',
    `supportbot_ai_fallback_ratio ${fallbackRate}`,
    '# TYPE supportbot_ai_latency_p95_ms gauge',
    `supportbot_ai_latency_p95_ms ${slo.latencyP95Ms}`,
  ];
  for (const [provider, counters] of Object.entries(metrics.byProvider)) {
    const safeProvider = provider.replace(/[^A-Za-z0-9_-]/g, '_');
    lines.push(
      `supportbot_ai_provider_attempts_by_provider_total{provider="${
        safeProvider
      }"} ${counters.attempts}`,
    );
  }
  for (const state of db.getAiProviderStates()) {
    const safeProvider = state.provider.replace(/[^A-Za-z0-9_-]/g, '_');
    lines.push(
      `supportbot_ai_provider_daily_requests{provider="${
        safeProvider
      }"} ${state.dailyRequests}`,
      `supportbot_ai_provider_daily_tokens{provider="${
        safeProvider
      }"} ${state.dailyTokens}`,
      `supportbot_ai_provider_circuit_open{provider="${
        safeProvider
      }"} ${state.circuitState === 'open' ? 1 : 0}`,
    );
  }
  return `${lines.join('\n')}\n`;
}

function handler(request: IncomingMessage, response: ServerResponse): void {
  try {
    const path = new URL(request.url || '/', 'http://localhost').pathname;
    if (request.method !== 'GET') {
      sendJson(response, 405, {error: 'method_not_allowed'});
      return;
    }
    if (path === '/healthz') {
      sendJson(response, 200, {status: 'ok'});
      return;
    }
    if (path === '/readyz') {
      const state = readiness();
      sendJson(response, state.ready ? 200 : 503, state);
      return;
    }
    if (path === '/metrics') {
      const body = prometheusMetrics();
      response.writeHead(200, {
        'Content-Type': 'text/plain; version=0.0.4; charset=utf-8',
        'Cache-Control': 'no-store',
      });
      response.end(body);
      return;
    }
    sendJson(response, 404, {error: 'not_found'});
  } catch (_error) {
    // Scrapes and readiness probes must never turn an SQLite fault into an
    // uncaught exception in the Telegram process.
    logger.error('healthServer', 'Health probe dependency failed');
    void recordDependencyStatus('db', false);
    if (!response.headersSent) {
      sendJson(response, 503, {status: 'unavailable'});
    } else {
      response.end();
    }
  }
}

export function startHealthServer(): Server {
  if (server) return server;
  const port = Number(
    process.env.HEALTH_PORT || cache.config.support?.health_port || 3001,
  );
  const host = process.env.HEALTH_HOST || '127.0.0.1';
  server = createServer(handler);
  server.on('error', () => {
    logger.error('healthServer', 'Health server failed');
  });
  server.listen(port, host, () => {
    logger.info('healthServer', 'Health server started', {status: 'ready'});
  });
  return server;
}

export async function stopHealthServer(): Promise<void> {
  if (!server) return;
  const current = server;
  server = undefined;
  await new Promise<void>((resolve, reject) => {
    current.close((error) => error ? reject(error) : resolve());
  });
}

export {readiness, prometheusMetrics};
