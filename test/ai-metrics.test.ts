import {expect} from 'chai';
import {
  formatAiMetrics,
  getAiMetricsSnapshot,
  recordAiAnswer,
  recordAiFeedback,
  recordAiHandoff,
  recordProviderAttemptMetric,
  recordRagResult,
  recordToolMetric,
  resetAiMetrics,
} from '../src/ai-metrics';

describe('AI runtime metrics', () => {
  beforeEach(() => resetAiMetrics());
  afterEach(() => resetAiMetrics());

  it('reports RAG, answer, handoff and feedback metrics by mode', () => {
    recordRagResult(true);
    recordRagResult(false);
    recordAiAnswer('llm');
    recordAiAnswer('direct_rag');
    recordAiHandoff('no_context');
    recordAiFeedback('helpful', 'direct_rag');
    recordAiFeedback('not_helpful', 'llm');

    const snapshot = getAiMetricsSnapshot();
    const report = formatAiMetrics();

    expect(snapshot.ragHitRate).to.equal(0.5);
    expect(snapshot.answerModes).to.deep.equal({llm: 1, directRag: 1});
    expect(snapshot.byHandoff.no_context).to.equal(1);
    expect(report).to.contain('Feedback by mode:');
    expect(report).to.contain('direct_rag: helpful=1');
    expect(report).to.contain('llm: helpful=0, not_helpful=1');
  });

  it('aggregates provider fallback and tool attempts', () => {
    recordProviderAttemptMetric({
      provider: 'google',
      ok: false,
      latencyMs: 100,
      failureReason: 'rate_limit',
    });
    recordProviderAttemptMetric({
      provider: 'mistral',
      ok: true,
      latencyMs: 200,
      isFallback: true,
      totalTokens: 50,
    });
    recordToolMetric({
      toolName: 'search_verified_docs',
      outcome: 'success',
      latencyMs: 25,
    });
    recordToolMetric({
      toolName: 'search_verified_docs',
      outcome: 'cancelled',
      failureReason: 'deadline',
    });

    const snapshot = getAiMetricsSnapshot();
    expect(snapshot.providerAttempts).to.equal(2);
    expect(snapshot.providerSuccessRate).to.equal(0.5);
    expect(snapshot.fallbackAttempts).to.equal(1);
    expect(snapshot.fallbackAttemptSuccesses).to.equal(1);
    expect(snapshot.byProvider.google.byFailure.rate_limit).to.equal(1);
    expect(snapshot.toolCalls).to.equal(2);
    expect(snapshot.toolCancellations).to.equal(1);
    expect(snapshot.byTool.search_verified_docs.byFailure.deadline).to.equal(1);
    const report = formatAiMetrics();
    expect(report).to.contain('fallback=1/1');
    expect(report).to.contain('google: rate_limit=1');
    expect(report).to.contain('search_verified_docs: deadline=1');
  });
});
