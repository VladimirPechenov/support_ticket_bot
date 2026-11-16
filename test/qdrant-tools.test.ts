import {expect} from 'chai';

const qdrantSmoke = require('../test-qdrant');
const qdrantSnapshot = require('../scripts/qdrant-snapshot');
const qdrantSetup = require('../setup_qdrant');

describe('Direct embeddings/Qdrant operational tools', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('reads scalar and named-vector collection dimensions', () => {
    expect(qdrantSmoke.vectorSize({
      result: {config: {params: {vectors: {size: 768}}}},
    })).to.equal(768);
    expect(qdrantSmoke.vectorSize({
      result: {
        config: {params: {vectors: {support: {size: 1536}}}},
      },
    })).to.equal(1536);
  });

  it('resolves an active alias without changing it', async () => {
    global.fetch = (async () => ({
      ok: true,
      json: async () => ({
        result: {
          aliases: [{
            alias_name: 'support_kb_active',
            collection_name: 'support_kb_versioned',
          }],
        },
      }),
    })) as any;

    expect(await qdrantSmoke.resolveCollection('support_kb_active'))
      .to.deep.equal({
        requested: 'support_kb_active',
        target: 'support_kb_versioned',
        isAlias: true,
      });
    expect(await qdrantSnapshot.resolveCollection('support_kb_active'))
      .to.equal('support_kb_versioned');
  });

  it('binds an alias promotion gate to its eval set and policy', () => {
    const documents = [{id: 'kb-1', title: 'A', answer: 'B'}];
    const evaluationCases = [{question: 'Q', expected_title: 'A'}];
    const policy = {
      candidateK: 53,
      denseContextThreshold: 0.6,
      acceptance: qdrantSetup.RAG_RELEASE_GATE,
    };
    const original = qdrantSetup.evaluationGateFingerprint(
      documents,
      evaluationCases,
      policy,
    );
    expect(qdrantSetup.evaluationGateFingerprint(
      documents,
      [{question: 'Changed', expected_title: 'A'}],
      policy,
    )).not.to.equal(original);
    expect(qdrantSetup.evaluationGateFingerprint(
      documents,
      evaluationCases,
      {...policy, denseContextThreshold: 0.7},
    )).not.to.equal(original);
  });

  it('rejects legacy or regressed promotion markers without a baseline bind', () => {
    const currentTime = Date.now();
    const baselineFingerprint = 'b'.repeat(64);
    const expected = {
      targetCollection: 'support_kb_candidate',
      fingerprint: 'c'.repeat(64),
      gateFingerprint: 'd'.repeat(64),
      expectedEvaluationSetFingerprint: 'e'.repeat(64),
      currentTime,
    };
    const baseline = {
      schemaVersion: qdrantSetup.RAG_EVALUATION_SCHEMA_VERSION,
      kind: 'rag-evaluation-baseline',
      collection: 'support_kb_previous',
      createdAt: new Date(currentTime - 86_400_000).toISOString(),
      evaluationSetFingerprint: expected.expectedEvaluationSetFingerprint,
      releaseGate: {...qdrantSetup.RAG_RELEASE_GATE},
      metrics: {
        hitAtOne: 0.62,
        contextRecall: 0.98,
        conversationRecall: 1,
        negativeHandoff: 1,
        directPrecision: 1,
      },
    };
    const metrics = {
      hitAtOne: 0.64,
      contextRecall: 0.99,
      conversationRecall: 1,
      negativeHandoff: 1,
      directPrecision: 1,
    };
    const evaluation = {
      schemaVersion: qdrantSetup.RAG_EVALUATION_SCHEMA_VERSION,
      kind: 'rag-evaluation-result',
      passed: true,
      passedAt: new Date(currentTime - 60_000).toISOString(),
      collection: expected.targetCollection,
      fingerprint: expected.fingerprint,
      gateFingerprint: expected.gateFingerprint,
      evaluationSetFingerprint: expected.expectedEvaluationSetFingerprint,
      baselineFingerprint,
      baselineCollection: baseline.collection,
      baselineCreatedAt: baseline.createdAt,
      baselineMetrics: {...baseline.metrics},
      metrics,
      ...metrics,
    };
    const matches = (candidate: any, artifact = baseline, hash =
      baselineFingerprint) => qdrantSetup.promotionEvaluationMatches({
      evaluation: candidate,
      baseline: artifact,
      baselineFingerprint: hash,
      expectedBaselineFingerprint: baselineFingerprint,
      ...expected,
    });

    expect(matches(evaluation)).to.equal(true);
    expect(matches({...evaluation, kind: undefined})).to.equal(false);
    expect(matches({...evaluation, baselineFingerprint: 'f'.repeat(64)}))
      .to.equal(false);
    expect(matches({
      ...evaluation,
      metrics: {...metrics, contextRecall: 0.96},
      contextRecall: 0.96,
    })).to.equal(false);
  });
});
