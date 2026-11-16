import {expect} from 'chai';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const {
  BASELINE_KIND,
  compareCandidateMetrics,
  createBaselineArtifact,
  loadBaselineArtifact,
  parseEvaluationArguments,
  validateBaselineArtifact,
  writeBaselineArtifact,
} = require('../scripts/evaluate-rag');

const fingerprint = (character: string): string => character.repeat(64);
const approvedBaselineFingerprint = fingerprint('f');

function validArtifact(metrics = {
  hitAtOne: 0.64,
  contextRecall: 0.99,
  conversationRecall: 1,
  negativeHandoff: 1,
  directPrecision: 1,
}) {
  return createBaselineArtifact({
    collection: 'support_kb_previous',
    createdAt: '2026-07-20T12:00:00.000Z',
    evaluationFingerprint: fingerprint('a'),
    gateFingerprint: fingerprint('b'),
    kbFingerprint: fingerprint('c'),
    metrics,
  });
}

describe('RAG evaluation baseline release gate', () => {
  it('keeps local evaluation baseline-free and requires one in production', () => {
    expect(parseEvaluationArguments([], {}, '/bot')).to.deep.equal({
      mode: 'evaluateLocal',
    });
    expect(() => parseEvaluationArguments(
      ['--production'],
      {},
      '/bot',
    )).to.throw('production baseline artifact is required');
    expect(parseEvaluationArguments(
      ['--production', '--baseline', 'config/approved.json'],
      {RAG_EVAL_BASELINE_SHA256: approvedBaselineFingerprint},
      '/bot',
    )).to.deep.equal({
      mode: 'evaluateProduction',
      baselinePath: path.resolve('/bot/config/approved.json'),
      expectedBaselineFingerprint: approvedBaselineFingerprint,
    });
    expect(parseEvaluationArguments(
      [],
      {
        RAG_EVAL_PRODUCTION: 'true',
        RAG_EVAL_BASELINE_FILE: '/release/rag-baseline.json',
        RAG_EVAL_BASELINE_SHA256: approvedBaselineFingerprint,
      },
      '/bot',
    )).to.deep.equal({
      mode: 'evaluateProduction',
      baselinePath: path.resolve('/release/rag-baseline.json'),
      expectedBaselineFingerprint: approvedBaselineFingerprint,
    });
    expect(() => parseEvaluationArguments(
      ['--baseline', 'config/approved.json'],
      {},
      '/bot',
    )).to.throw('only be used with --production');
  });

  it('keeps baseline bootstrap mutually exclusive and explicit', () => {
    expect(parseEvaluationArguments(
      ['--write-baseline=artifacts/rag-baseline.json'],
      {},
      '/bot',
    )).to.deep.equal({
      mode: 'writeBaseline',
      writeBaselinePath: path.resolve('/bot/artifacts/rag-baseline.json'),
    });
    expect(() => parseEvaluationArguments(
      ['--write-baseline', 'new.json'],
      {RAG_EVAL_BASELINE_FILE: 'approved.json'},
      '/bot',
    )).to.throw('mutually exclusive');
    expect(() => parseEvaluationArguments(
      ['--write-baseline', 'config/rag-evaluation-baseline-candidate-test.json'],
      {},
      '/bot',
    )).to.throw('outside config');
    expect(() => parseEvaluationArguments(
      ['--baseline', 'cli.json'],
      {
        RAG_EVAL_PRODUCTION: 'true',
        RAG_EVAL_BASELINE_FILE: 'env.json',
        RAG_EVAL_BASELINE_SHA256: approvedBaselineFingerprint,
      },
      '/bot',
    )).to.throw('resolve to different files');
    expect(() => parseEvaluationArguments(
      ['--production', '--baseline', 'approved.json'],
      {},
      '/bot',
    )).to.throw('RAG_EVAL_BASELINE_SHA256');
  });

  it('validates artifact schema, provenance, eval set and every metric', () => {
    const artifact = validArtifact();
    expect(artifact.kind).to.equal(BASELINE_KIND);
    expect(validateBaselineArtifact(artifact, fingerprint('a')).metrics)
      .to.deep.equal(artifact.metrics);

    expect(() => validateBaselineArtifact(
      {...artifact, evaluationSetFingerprint: fingerprint('d')},
      fingerprint('a'),
    )).to.throw('different RAG evaluation set');
    expect(() => validateBaselineArtifact({
      ...artifact,
      metrics: {...artifact.metrics, contextRecall: undefined},
    }, fingerprint('a'))).to.throw('metrics.contextRecall');
    expect(() => validateBaselineArtifact({
      ...artifact,
      gateFingerprint: 'not-a-sha256',
    }, fingerprint('a'))).to.throw('gateFingerprint');
  });

  it('reports no-regression failures for all five release metrics', () => {
    const comparison = compareCandidateMetrics({
      hitAtOne: 0.99,
      contextRecall: 0.99,
      conversationRecall: 0.99,
      negativeHandoff: 0.99,
      directPrecision: 0.99,
    }, {
      hitAtOne: 1,
      contextRecall: 1,
      conversationRecall: 1,
      negativeHandoff: 1,
      directPrecision: 1,
    });

    expect(comparison.passed).to.equal(false);
    expect(comparison.regressions.map((entry: {metric: string}) => entry.metric))
      .to.have.members([
        'hitAtOne',
        'contextRecall',
        'conversationRecall',
        'negativeHandoff',
        'directPrecision',
      ]);
  });

  it('accepts equality with a baseline when all absolute gates pass', () => {
    const metrics = {
      hitAtOne: 0.64,
      contextRecall: 0.99,
      conversationRecall: 1,
      negativeHandoff: 1,
      directPrecision: 1,
    };
    expect(compareCandidateMetrics(metrics, metrics)).to.deep.equal({
      passed: true,
      gateFailures: [],
      regressions: [],
    });
  });

  it('enforces every absolute release gate independently of baseline', () => {
    const comparison = compareCandidateMetrics({
      hitAtOne: 0.59,
      contextRecall: 0.96,
      conversationRecall: 0.99,
      negativeHandoff: 0.99,
      directPrecision: 0.99,
    }, {
      hitAtOne: 0,
      contextRecall: 0,
      conversationRecall: 0,
      negativeHandoff: 0,
      directPrecision: 0,
    });

    expect(comparison.gateFailures.map(
      (entry: {metric: string}) => entry.metric,
    )).to.have.members([
      'hitAtOne',
      'contextRecall',
      'conversationRecall',
      'negativeHandoff',
      'directPrecision',
    ]);
    expect(comparison.regressions).to.deep.equal([]);
  });

  it('writes a mode-0600 immutable artifact and verifies its digest', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'rag-baseline-'));
    const artifactPath = path.join(directory, 'approved.json');
    try {
      const artifact = validArtifact();
      writeBaselineArtifact(artifactPath, artifact);
      if (process.platform !== 'win32') {
        expect(fs.statSync(artifactPath).mode & 0o777).to.equal(0o600);
      }
      const loaded = loadBaselineArtifact(artifactPath, fingerprint('a'));
      expect(loaded.artifact).to.deep.equal(artifact);
      expect(loaded.fingerprint).to.match(/^[a-f0-9]{64}$/);
      expect(() => writeBaselineArtifact(artifactPath, artifact)).to.throw();
    } finally {
      fs.rmSync(directory, {recursive: true, force: true});
    }
  });
});
