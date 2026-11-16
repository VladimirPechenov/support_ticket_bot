import {expect} from 'chai';
import cache from '../src/cache';
import * as db from '../src/db';
import {
  recordProviderAttemptMetric,
  recordToolMetric,
  resetAiMetrics,
} from '../src/ai-metrics';
import {
  prometheusMetrics,
  readiness,
  setTelegramReady,
} from '../src/health-server';

describe('internal health server security', () => {
  const originalAi = cache.config.ai;
  const originalGoogleKey = process.env.GOOGLE_API_KEY;
  const originalMistralKey = process.env.MISTRAL_API_KEY;
  const originalHealthPort = process.env.HEALTH_PORT;
  const originalHealthHost = process.env.HEALTH_HOST;
  let originalFlags: db.RuntimeFeatureFlags;

  beforeEach(() => {
    originalFlags = db.getRuntimeFeatureFlags();
    db.setRuntimeFeatureFlag('ai_mode', 'off');
    db.setRuntimeFeatureFlag('ai_rollout_percent', 0);
    db.setRuntimeFeatureFlag('web_tool_rollout_percent', 0);
    cache.config.ai = {rag: {qdrant: {}}};
    delete process.env.GOOGLE_API_KEY;
    delete process.env.MISTRAL_API_KEY;
    process.env.HEALTH_PORT = '0';
    process.env.HEALTH_HOST = '127.0.0.1';
    setTelegramReady(true);
    resetAiMetrics();
  });

  it('does not become ready before Telegram initialization', () => {
    setTelegramReady(false);
    const state = readiness();
    expect(state.ready).to.equal(false);
    expect(state.checks.telegram).to.equal(false);
  });

  afterEach(() => {
    db.setRuntimeFeatureFlag('ai_mode', originalFlags.aiMode);
    db.setRuntimeFeatureFlag(
      'ai_rollout_percent',
      originalFlags.aiRolloutPercent,
    );
    db.setRuntimeFeatureFlag(
      'web_tool_rollout_percent',
      originalFlags.webToolRolloutPercent,
    );
    cache.config.ai = originalAi;
    restoreEnvironment('GOOGLE_API_KEY', originalGoogleKey);
    restoreEnvironment('MISTRAL_API_KEY', originalMistralKey);
    restoreEnvironment('HEALTH_PORT', originalHealthPort);
    restoreEnvironment('HEALTH_HOST', originalHealthHost);
    setTelegramReady(false);
    resetAiMetrics();
  });

  it('keeps safe-mode readiness independent from LLM calls', () => {
    const state = readiness();
    expect(state).to.deep.include({
      ready: true,
      aiRequired: false,
      mode: 'off',
    });
    expect(state.checks.googleKey).to.equal(false);
    expect(state.checks.mistralKey).to.equal(false);

  });

  it('is not ready when AI rollout requires an incomplete direct stack', () => {
    db.setRuntimeFeatureFlag('ai_mode', 'full');
    db.setRuntimeFeatureFlag('ai_rollout_percent', 5);
    let state = readiness();
    expect(state.ready).to.equal(false);
    expect(state.checks).to.deep.include({
      qdrantConfigured: false,
      googleKey: false,
      mistralKey: false,
    });

    cache.config.ai = {
      llm: {providers: {primary: {
        provider: 'gemini', model: 'gemini-3.1-flash-lite',
      }}},
      rag: {qdrant: {url: 'http://qdrant:6333', collection: 'support_kb_active'}},
    };
    process.env.GOOGLE_API_KEY = 'health-google-secret';
    process.env.MISTRAL_API_KEY = 'health-mistral-secret';
    state = readiness();
    expect(state.ready).to.equal(true);
    expect(JSON.stringify(state)).not.to.include('health-google-secret');
    expect(JSON.stringify(state)).not.to.include('health-mistral-secret');
  });

  it('exports sanitized Prometheus labels, counters and rollout gauges', () => {
    db.setRuntimeFeatureFlag('ai_rollout_percent', 25);
    db.setRuntimeFeatureFlag('web_tool_rollout_percent', 5);
    recordProviderAttemptMetric({
      provider: 'gemini"}\nattack_metric{label="x',
      ok: false,
      failureReason: 'timeout',
      latencyMs: 10,
    });
    recordToolMetric({
      toolName: 'search_verified_docs',
      outcome: 'success',
      latencyMs: 5,
    });

    const rendered = prometheusMetrics();
    expect(rendered).to.include('supportbot_ai_provider_attempts_total 1');
    expect(rendered).to.include('supportbot_ai_provider_failures_total 1');
    expect(rendered).to.include('supportbot_ai_tool_calls_total 1');
    expect(rendered).to.include('supportbot_ai_rollout_percent 25');
    expect(rendered).to.include('supportbot_ai_web_rollout_percent 5');
    expect(rendered).not.to.include('\nattack_metric{');
  });

  it('is ready with Gemini and the full local knowledge base without Qdrant', () => {
    db.setRuntimeFeatureFlag('ai_mode', 'full');
    db.setRuntimeFeatureFlag('ai_rollout_percent', 100);
    cache.config.ai = {
      llm: {
        max_attempts: 1,
        providers: {primary: {
          provider: 'gemini', model: 'gemini-3.1-flash-lite',
        }},
      },
      embeddings: {enabled: false},
      rag: {qdrant: {}},
    };
    process.env.GOOGLE_API_KEY = 'health-google-secret';
    expect(readiness().ready).to.equal(true);
    expect(readiness().checks.knowledgeBase).to.equal(true);
    expect(readiness().checks.qdrantConfigured).to.equal(false);
    cache.config.ai!.llm!.max_attempts = 3;
    expect(readiness().ready).to.equal(true);
    delete process.env.GOOGLE_API_KEY;
    expect(readiness().ready).to.equal(false);
  });
});

function restoreEnvironment(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
