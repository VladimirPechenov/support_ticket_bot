if (process.env.EVAL_USE_BUILD !== 'true') require('ts-node/register');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const YAML = require('yaml');
const moduleRoot = process.env.EVAL_USE_BUILD === 'true' ? '../build' : '../src';
const {normalizeRagText, rankRagDocuments} = require(
  `${moduleRoot}/rag-ranking`,
);
const {selectDirectRagAnswer} = require(`${moduleRoot}/rag-fallback`);
const {buildRetrievalQuery} = require(`${moduleRoot}/conversation-context`);
const {
  RAG_RELEASE_GATE,
  evaluationGateFingerprint,
  knowledgeBaseFingerprint,
} = require('../setup_qdrant');

const root = path.join(__dirname, '..');
const evaluationFile = path.join(root, 'config', '.kb-evaluation-v3.json');
const config = YAML.parse(
  fs.readFileSync(process.env.SUPPORTBOT_CONFIG_PATH || path.join(root, 'config', 'config.yaml'), 'utf8'),
);
const cases = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'fixtures', 'rag-eval.json'), 'utf8'),
);
const conversationCases = JSON.parse(fs.readFileSync(
  path.join(__dirname, 'fixtures', 'rag-conversation-eval.json'),
  'utf8',
));
const kb = fs.readFileSync(
  process.env.SUPPORT_KB_PATH || path.join(root, 'config', 'knowledge-base.jsonl'),
  'utf8',
).trim().split('\n').map(line => JSON.parse(line));
const embeddings = config.ai.embeddings;
const embeddingProvider = process.env.EMBEDDING_PROVIDER ||
  embeddings.provider || 'mistral';
const key = embeddingProvider === 'mistral' ?
  process.env.MISTRAL_API_KEY : process.env.GOOGLE_API_KEY;
const qdrant = config.ai.rag.qdrant;
const qdrantApiKey = process.env.QDRANT_API_KEY || '';
const httpTimeoutMs = Number(process.env.EVAL_HTTP_TIMEOUT_MS || 15000);
qdrant.url = process.env.QDRANT_URL || qdrant.url;
qdrant.collection = process.env.QDRANT_COLLECTION || qdrant.collection;

const BASELINE_SCHEMA_VERSION = 3;
const BASELINE_KIND = 'rag-evaluation-baseline';
const EVALUATION_RESULT_KIND = 'rag-evaluation-result';
const METRIC_NAMES = Object.freeze([
  'hitAtOne',
  'contextRecall',
  'conversationRecall',
  'negativeHandoff',
  'directPrecision',
]);
const USAGE =
  'Usage: node scripts/evaluate-rag.js ' +
  '[--production --baseline FILE | --write-baseline FILE]\n' +
  '  RAG_EVAL_PRODUCTION=true enables the production no-regression gate.\n' +
  '  RAG_EVAL_BASELINE_FILE may be used instead of --baseline.\n' +
  '  RAG_EVAL_BASELINE_SHA256 is required in production mode.';

function resolveArtifactPath(value, baseDirectory = process.cwd()) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error('Baseline artifact path must not be empty');
  }
  return path.resolve(baseDirectory, value.trim());
}

function rejectTemporaryConfigArtifact(artifactPath, baseDirectory) {
  const configDirectory = path.resolve(baseDirectory, 'config');
  const relative = path.relative(configDirectory, artifactPath);
  const insideConfig = relative && !relative.startsWith('..') &&
    !path.isAbsolute(relative);
  if (
    insideConfig &&
    /^rag-evaluation-baseline-candidate.*\.json$/i.test(path.basename(artifactPath))
  ) {
    throw new Error(
      'Temporary candidate baselines must be written outside config/; ' +
      'use /tmp or a release-artifacts directory',
    );
  }
}

function optionValue(argument, name) {
  const prefix = `${name}=`;
  return argument.startsWith(prefix) ? argument.slice(prefix.length) : null;
}

function parseEvaluationArguments(
  argv = process.argv.slice(2),
  env = process.env,
  baseDirectory = process.cwd(),
) {
  let cliBaseline;
  let writeBaseline;
  let production = false;
  let help = false;
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    const inlineBaseline = optionValue(argument, '--baseline');
    const inlineWrite = optionValue(argument, '--write-baseline');
    if (argument === '--help' || argument === '-h') {
      help = true;
    } else if (argument === '--production') {
      if (production) throw new Error('--production may only be specified once');
      production = true;
    } else if (argument === '--baseline' || inlineBaseline !== null) {
      if (cliBaseline !== undefined) {
        throw new Error('--baseline may only be specified once');
      }
      cliBaseline = inlineBaseline === null ? argv[++index] : inlineBaseline;
      if (cliBaseline === undefined) {
        throw new Error('--baseline requires a file path');
      }
    } else if (
      argument === '--write-baseline' || inlineWrite !== null
    ) {
      if (writeBaseline !== undefined) {
        throw new Error('--write-baseline may only be specified once');
      }
      writeBaseline = inlineWrite === null ? argv[++index] : inlineWrite;
      if (writeBaseline === undefined) {
        throw new Error('--write-baseline requires a file path');
      }
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }

  if (help) {
    if (argv.length !== 1) throw new Error('--help cannot be combined with options');
    return {mode: 'help'};
  }

  const envBaseline = typeof env.RAG_EVAL_BASELINE_FILE === 'string' ?
    env.RAG_EVAL_BASELINE_FILE.trim() : '';
  const expectedBaselineFingerprint = String(
    env.RAG_EVAL_BASELINE_SHA256 || '',
  ).trim().toLowerCase();
  const productionEnvironment = String(
    env.RAG_EVAL_PRODUCTION || '',
  ).trim().toLowerCase();
  if (
    productionEnvironment &&
    productionEnvironment !== 'true' &&
    productionEnvironment !== 'false'
  ) {
    throw new Error('RAG_EVAL_PRODUCTION must be true or false');
  }
  production ||= productionEnvironment === 'true';
  if (
    writeBaseline !== undefined &&
    (
      production ||
      cliBaseline !== undefined ||
      envBaseline ||
      expectedBaselineFingerprint
    )
  ) {
    throw new Error(
      '--write-baseline is mutually exclusive with production evaluation ' +
      'and baseline input',
    );
  }
  if (writeBaseline !== undefined) {
    const writeBaselinePath = resolveArtifactPath(writeBaseline, baseDirectory);
    rejectTemporaryConfigArtifact(writeBaselinePath, baseDirectory);
    return {
      mode: 'writeBaseline',
      writeBaselinePath,
    };
  }

  if (
    !production &&
    (cliBaseline !== undefined || envBaseline || expectedBaselineFingerprint)
  ) {
    throw new Error('A baseline may only be used with --production');
  }
  if (!production) return {mode: 'evaluateLocal'};

  if (cliBaseline === undefined && !envBaseline) {
    throw new Error(
      'A production baseline artifact is required: pass --baseline FILE or set ' +
      'RAG_EVAL_BASELINE_FILE',
    );
  }
  const cliPath = cliBaseline === undefined ? null :
    resolveArtifactPath(cliBaseline, baseDirectory);
  const envPath = envBaseline ? resolveArtifactPath(envBaseline, baseDirectory) :
    null;
  if (cliPath && envPath && cliPath !== envPath) {
    throw new Error(
      '--baseline and RAG_EVAL_BASELINE_FILE resolve to different files',
    );
  }
  requireSha256(
    expectedBaselineFingerprint,
    'RAG_EVAL_BASELINE_SHA256',
  );
  return {
    mode: 'evaluateProduction',
    baselinePath: cliPath || envPath,
    expectedBaselineFingerprint,
  };
}

function evaluationSetFingerprint(evaluationCases) {
  return crypto.createHash('sha256')
    .update(JSON.stringify(evaluationCases))
    .digest('hex');
}

function validateMetricSet(metrics, label) {
  if (!metrics || typeof metrics !== 'object' || Array.isArray(metrics)) {
    throw new Error(`${label} must be an object`);
  }
  const validated = {};
  for (const metric of METRIC_NAMES) {
    const value = metrics[metric];
    if (!Number.isFinite(value) || value < 0 || value > 1) {
      throw new Error(`${label}.${metric} must be a finite number from 0 to 1`);
    }
    validated[metric] = value;
  }
  return validated;
}

function requireSha256(value, label) {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) {
    throw new Error(`${label} must be a lowercase SHA-256 hex digest`);
  }
  return value;
}

function createBaselineArtifact({
  collection,
  createdAt = new Date().toISOString(),
  evaluationFingerprint,
  gateFingerprint,
  kbFingerprint,
  metrics,
}) {
  const artifact = {
    schemaVersion: BASELINE_SCHEMA_VERSION,
    kind: BASELINE_KIND,
    collection,
    createdAt,
    evaluationSetFingerprint: evaluationFingerprint,
    gateFingerprint,
    knowledgeBaseFingerprint: kbFingerprint,
    releaseGate: {...RAG_RELEASE_GATE},
    metrics: validateMetricSet(metrics, 'Baseline metrics'),
  };
  return validateBaselineArtifact(artifact, evaluationFingerprint);
}

function validateBaselineArtifact(artifact, expectedEvaluationFingerprint) {
  if (!artifact || typeof artifact !== 'object' || Array.isArray(artifact)) {
    throw new Error('Baseline artifact must be a JSON object');
  }
  if (artifact.schemaVersion !== BASELINE_SCHEMA_VERSION) {
    throw new Error(
      `Baseline artifact schemaVersion must be ${BASELINE_SCHEMA_VERSION}`,
    );
  }
  if (artifact.kind !== BASELINE_KIND) {
    throw new Error(`Baseline artifact kind must be ${BASELINE_KIND}`);
  }
  if (
    typeof artifact.collection !== 'string' ||
    artifact.collection.trim() === ''
  ) throw new Error('Baseline artifact collection must not be empty');
  const createdAt = typeof artifact.createdAt === 'string' ?
    Date.parse(artifact.createdAt) : NaN;
  if (
    !Number.isFinite(createdAt) ||
    new Date(createdAt).toISOString() !== artifact.createdAt
  ) {
    throw new Error(
      'Baseline artifact createdAt must be a canonical ISO timestamp',
    );
  }
  requireSha256(
    artifact.evaluationSetFingerprint,
    'Baseline artifact evaluationSetFingerprint',
  );
  requireSha256(
    artifact.gateFingerprint,
    'Baseline artifact gateFingerprint',
  );
  requireSha256(
    artifact.knowledgeBaseFingerprint,
    'Baseline artifact knowledgeBaseFingerprint',
  );
  if (artifact.evaluationSetFingerprint !== expectedEvaluationFingerprint) {
    throw new Error(
      'Baseline artifact was produced from a different RAG evaluation set',
    );
  }
  validateMetricSet(artifact.releaseGate, 'Baseline releaseGate');
  const metrics = validateMetricSet(artifact.metrics, 'Baseline metrics');
  return {...artifact, metrics};
}

function loadBaselineArtifact(filePath, expectedEvaluationFingerprint) {
  let stats;
  try {
    stats = fs.lstatSync(filePath);
  } catch (_error) {
    throw new Error(`Baseline artifact does not exist: ${filePath}`);
  }
  if (stats.isSymbolicLink() || !stats.isFile()) {
    throw new Error('Baseline artifact must be a regular file, not a symlink');
  }
  // Windows reports POSIX mode bits without reflecting NTFS ACLs.
  // On Windows the installation owner must restrict the baseline directory ACL.
  if (process.platform !== 'win32' && (stats.mode & 0o022) !== 0) {
    throw new Error('Baseline artifact must not be group/world writable');
  }
  if (stats.size > 64 * 1024) {
    throw new Error('Baseline artifact exceeds the 64 KiB size limit');
  }
  const raw = fs.readFileSync(filePath, 'utf8');
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (_error) {
    throw new Error('Baseline artifact is not valid JSON');
  }
  return {
    artifact: validateBaselineArtifact(parsed, expectedEvaluationFingerprint),
    fingerprint: crypto.createHash('sha256').update(raw).digest('hex'),
  };
}

function compareCandidateMetrics(
  candidateMetrics,
  baselineMetrics,
  releaseGate = RAG_RELEASE_GATE,
) {
  const candidate = validateMetricSet(candidateMetrics, 'Candidate metrics');
  const baseline = validateMetricSet(baselineMetrics, 'Baseline metrics');
  const gate = validateMetricSet(releaseGate, 'Release gate');
  const gateFailures = [];
  const regressions = [];
  for (const metric of METRIC_NAMES) {
    if (candidate[metric] < gate[metric]) {
      gateFailures.push({
        metric,
        actual: candidate[metric],
        required: gate[metric],
      });
    }
    if (candidate[metric] < baseline[metric]) {
      regressions.push({
        metric,
        actual: candidate[metric],
        baseline: baseline[metric],
      });
    }
  }
  return {
    passed: gateFailures.length === 0 && regressions.length === 0,
    gateFailures,
    regressions,
  };
}

function assertBaselineOutputAvailable(filePath) {
  if (fs.existsSync(filePath)) {
    throw new Error(`Refusing to overwrite baseline artifact: ${filePath}`);
  }
  const parent = path.dirname(filePath);
  if (!fs.existsSync(parent) || !fs.statSync(parent).isDirectory()) {
    throw new Error(`Baseline artifact directory does not exist: ${parent}`);
  }
}

function writeBaselineArtifact(filePath, artifact) {
  validateBaselineArtifact(artifact, artifact?.evaluationSetFingerprint);
  fs.writeFileSync(filePath, `${JSON.stringify(artifact, null, 2)}\n`, {
    encoding: 'utf8',
    flag: 'wx',
    mode: 0o600,
  });
  fs.chmodSync(filePath, 0o600);
}

async function fetchWithTimeout(url, options = {}) {
  const controller = new AbortController();
  const parentSignal = options.signal;
  const abortFromParent = () => controller.abort(parentSignal?.reason);
  if (parentSignal?.aborted) abortFromParent();
  else parentSignal?.addEventListener('abort', abortFromParent, {once: true});
  const timeout = setTimeout(() => controller.abort(), httpTimeoutMs);
  try {
    return await fetch(url, {...options, signal: controller.signal});
  } finally {
    clearTimeout(timeout);
    parentSignal?.removeEventListener('abort', abortFromParent);
  }
}

function validateHoldout() {
  if (cases.length < 50) throw new Error('RAG eval must contain at least 50 cases');
  const trainingPhrases = new Set(kb.flatMap(document => [
    document.title,
    ...document.aliases,
  ]).map(normalizeRagText));
  for (const testCase of cases) {
    if (trainingPhrases.has(normalizeRagText(testCase.question))) {
      throw new Error(`Eval question leaks a title/alias: ${testCase.question}`);
    }
  }
}

async function embedMany(texts) {
  if (!key) throw new Error(`${embeddingProvider.toUpperCase()} API key required`);
  const model = String(
    process.env.EMBEDDING_MODEL || embeddings.model || 'mistral-embed',
  ).replace(/^models\//, '');
  const dimensions = Number(
    process.env.EMBEDDING_DIMENSIONS || embeddings.dimensions || 1024,
  );
  if (embeddingProvider === 'mistral') {
    const response = await fetchWithTimeout(
      'https://api.mistral.ai/v1/embeddings',
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${key}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({model, input: texts}),
      },
    );
    const body = await response.json();
    const rows = Array.isArray(body?.data) ? [...body.data] : [];
    rows.sort((left, right) => Number(left.index) - Number(right.index));
    const vectors = rows.map(row => row.embedding);
    if (!response.ok || vectors.length !== texts.length || vectors.some(
      vector => !Array.isArray(vector) || vector.length !== dimensions,
    )) {
      throw new Error(`Embedding failed: ${response.status}`);
    }
    return vectors;
  }
  if (texts.length !== 1) {
    return Promise.all(texts.map(text => embedMany([text]).then(row => row[0])));
  }
  const text = texts[0];
  const response = await fetchWithTimeout(
    `https://generativelanguage.googleapis.com/v1beta/models/${
      encodeURIComponent(model)
    }:embedContent`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': key,
      },
      body: JSON.stringify({
        model: `models/${model}`,
        content: {parts: [{text}]},
        taskType: 'RETRIEVAL_QUERY',
        outputDimensionality: dimensions,
      }),
    },
  );
  const body = await response.json();
  if (!response.ok || body.error) {
    throw new Error(
      `Embedding failed: ${body.error?.code || response.status}`,
    );
  }
  const vector = body.embedding?.values;
  if (!Array.isArray(vector) || vector.length !== dimensions) {
    throw new Error('Embedding returned an invalid vector');
  }
  return [vector];
}

async function retrieveCandidates(queryVector) {
  const response = await fetchWithTimeout(
    `${qdrant.url}/collections/${qdrant.collection}/points/search`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(qdrantApiKey ? {'api-key': qdrantApiKey} : {}),
      },
      body: JSON.stringify({
        vector: queryVector,
        limit: qdrant.candidate_k || 53,
        with_payload: true,
      }),
    },
  );
  if (!response.ok) throw new Error(`Qdrant search failed: ${response.status}`);
  const body = await response.json();
  return (body.result || []).map(point => ({
    id: point.payload?.id,
    intent: point.payload?.intent,
    text: String(point.payload?.answer || point.payload?.text || ''),
    title: point.payload?.title,
    source: point.payload?.source,
    aliases: point.payload?.aliases || point.payload?.questions || [],
    tags: point.payload?.tags || [],
    denseScore: point.score,
  }));
}

async function search(question, queryVector, denseWeight) {
  return rankRagDocuments(
    question,
    await retrieveCandidates(queryVector || (await embedMany([question]))[0]),
    {
      rrfK: qdrant.rrf_k ?? 60,
      denseWeight: denseWeight ?? qdrant.dense_weight ?? 0.5,
      denseContextThreshold: qdrant.dense_context_threshold ?? 0.52,
      minimumQueryCoverage: qdrant.minimum_query_coverage ?? 0,
      maxDocuments: qdrant.max_context_docs || 4,
    },
  );
}

function safeDirectAnswer(documents) {
  if (qdrant.direct_answer_on_llm_error === false) return null;
  return selectDirectRagAnswer(documents, {
    minimumMargin: qdrant.direct_answer_min_margin ?? 0.05,
  });
}

function invalidateEvaluationMarker(force = false) {
  try {
    const existing = JSON.parse(fs.readFileSync(evaluationFile, 'utf8'));
    if (force || existing.collection === qdrant.collection) {
      fs.unlinkSync(evaluationFile);
    }
  } catch (_error) {
    // A missing or invalid marker is already a closed promotion gate.
  }
}

function reportComparisonFailures(comparison) {
  for (const failure of comparison.gateFailures) {
    console.error(
      `RAG release gate failed for ${failure.metric}: ` +
      `${failure.actual} < ${failure.required}`,
    );
  }
  for (const regression of comparison.regressions) {
    console.error(
      `RAG baseline regression for ${regression.metric}: ` +
      `${regression.actual} < ${regression.baseline}`,
    );
  }
}

async function main(
  argv = process.argv.slice(2),
  env = process.env,
) {
  const options = parseEvaluationArguments(argv, env);
  if (options.mode === 'help') {
    console.log(USAGE);
    return;
  }
  invalidateEvaluationMarker(options.mode === 'writeBaseline');
  validateHoldout();
  const evaluationCases = {standalone: cases, conversation: conversationCases};
  const evalFingerprint = evaluationSetFingerprint(evaluationCases);
  let baseline = null;
  if (options.mode === 'evaluateProduction') {
    baseline = loadBaselineArtifact(options.baselinePath, evalFingerprint);
    if (baseline.fingerprint !== options.expectedBaselineFingerprint) {
      throw new Error('Baseline artifact SHA-256 does not match approval');
    }
  } else if (options.mode === 'writeBaseline') {
    assertBaselineOutputAvailable(options.writeBaselinePath);
  }
  let positives = 0;
  let hitAtOne = 0;
  let contextHits = 0;
  let negatives = 0;
  let negativeHandoffs = 0;
  let directAnswers = 0;
  let correctDirectAnswers = 0;
  const conversationQueries = conversationCases.map(testCase =>
    buildRetrievalQuery(
      testCase.question,
      testCase.history.map(content => ({role: 'user', content})),
      qdrant.history_query_messages || 2,
    ),
  );
  const queryVectors = await embedMany(cases.map(testCase => testCase.question));
  const conversationVectors = await embedMany(conversationQueries);

  const tuneWeights = String(process.env.RAG_TUNE_WEIGHTS || '')
    .split(',').map(value => value.trim()).filter(Boolean)
    .map(Number).filter(Number.isFinite);
  if (tuneWeights.length > 0) {
    const candidates = [];
    for (const vector of queryVectors) candidates.push(await retrieveCandidates(vector));
    for (const denseWeight of tuneWeights) {
      let tuneHits = 0;
      let tuneRecall3 = 0;
      let tuneRecall8 = 0;
      let tuneContextHits = 0;
      let tunePositives = 0;
      let tuneNegatives = 0;
      let tuneNegativeHandoffs = 0;
      let tuneDirect = 0;
      let tuneDirectCorrect = 0;
      for (const [index, testCase] of cases.entries()) {
        const documents = rankRagDocuments(testCase.question, candidates[index], {
          rrfK: qdrant.rrf_k ?? 60,
          denseWeight,
          denseContextThreshold: qdrant.dense_context_threshold ?? 0.52,
          minimumQueryCoverage: qdrant.minimum_query_coverage ?? 0,
          maxDocuments: qdrant.max_context_docs || 4,
        });
        const negative = testCase.expected_action === 'handoff';
        const direct = safeDirectAnswer(documents);
        if (negative) {
          tuneNegatives++;
          if (!direct) tuneNegativeHandoffs++;
        } else {
          tunePositives++;
          const expectedIndex = documents.findIndex(document =>
            document.title === testCase.expected_title,
          );
          if (expectedIndex === 0) tuneHits++;
          if (expectedIndex >= 0 && expectedIndex < 3) tuneRecall3++;
          if (expectedIndex >= 0 && expectedIndex < 8) tuneRecall8++;
          if (expectedIndex >= 0) tuneContextHits++;
        }
        if (direct) {
          tuneDirect++;
          if (!negative && documents[0]?.title === testCase.expected_title) {
            tuneDirectCorrect++;
          }
        }
      }
      console.log(JSON.stringify({
        event: 'rag_weight_tuning', denseWeight,
        hitAtOne: tuneHits / tunePositives,
        contextRecall: tuneContextHits / tunePositives,
        recallAtThree: tuneRecall3 / tunePositives,
        recallAtEight: tuneRecall8 / tunePositives,
        negativeHandoff: tuneNegativeHandoffs / tuneNegatives,
        directPrecision: tuneDirect ? tuneDirectCorrect / tuneDirect : 1,
        directCoverage: tuneDirectCorrect / tunePositives,
      }));
    }
    return;
  }

  for (const [caseIndex, testCase] of cases.entries()) {
    const documents = await search(testCase.question, queryVectors[caseIndex]);
    const top = documents[0];
    const direct = safeDirectAnswer(documents);
    const negative = testCase.expected_action === 'handoff';
    const hit = !negative && top?.title === testCase.expected_title;
    const contextHit = !negative && documents.some(document =>
      document.title === testCase.expected_title,
    );
    const directCorrect = !!direct && hit;
    if (negative) {
      negatives++;
      if (!direct) negativeHandoffs++;
    } else {
      positives++;
      if (hit) hitAtOne++;
      if (contextHit) contextHits++;
    }
    if (direct) {
      directAnswers++;
      if (directCorrect) correctDirectAnswers++;
    }
    console.log(JSON.stringify({
      question: testCase.question,
      expectedTitle: testCase.expected_title || null,
      topTitle: top?.title || null,
      direct: !!direct,
      hitAtOne: hit,
      contextHit,
      topScores: documents.slice(0, 3).map(document => ({
        id: document.id,
        dense: Number(document.denseScore.toFixed(3)),
        lexical: Number(document.lexicalScore.toFixed(3)),
        fused: Number(document.fusedScore.toFixed(3)),
        denseRank: document.denseRank,
        lexicalRank: document.lexicalRank,
      })),
    }));
  }

  let conversationHits = 0;
  for (const [caseIndex, testCase] of conversationCases.entries()) {
    const retrievalQuery = conversationQueries[caseIndex];
    const documents = await search(
      retrievalQuery,
      conversationVectors[caseIndex],
    );
    const contextHit = documents.some(document =>
      document.title === testCase.expected_title,
    );
    if (contextHit) conversationHits++;
    console.log(JSON.stringify({
      question: testCase.question,
      historyMessages: testCase.history.length,
      expectedTitle: testCase.expected_title,
      topTitle: documents[0]?.title || null,
      conversationContextHit: contextHit,
    }));
  }

  const hitRate = positives ? hitAtOne / positives : 1;
  const handoffRate = negatives ? negativeHandoffs / negatives : 1;
  const contextRecall = positives ? contextHits / positives : 1;
  const directPrecision = directAnswers ?
    correctDirectAnswers / directAnswers : 1;
  const conversationRecall = conversationCases.length ?
    conversationHits / conversationCases.length : 1;
  const metrics = {
    hitAtOne: hitRate,
    contextRecall,
    conversationRecall,
    negativeHandoff: handoffRate,
    directPrecision,
  };
  console.log(
    `RAG evaluation: Hit@1=${hitAtOne}/${positives} ` +
    `(${(hitRate * 100).toFixed(1)}%); context recall=` +
    `${contextHits}/${positives} ` +
    `(${(contextRecall * 100).toFixed(1)}%); negative handoff=` +
    `${negativeHandoffs}/${negatives}; conversation recall=` +
    `${conversationHits}/${conversationCases.length}; direct precision=` +
    `${correctDirectAnswers}/${directAnswers}`,
  );

  const kbFingerprint = knowledgeBaseFingerprint(kb);
  const gateFingerprint = evaluationGateFingerprint(kb, evaluationCases);
  if (options.mode === 'writeBaseline') {
    const artifact = createBaselineArtifact({
      collection: qdrant.collection,
      evaluationFingerprint: evalFingerprint,
      gateFingerprint,
      kbFingerprint,
      metrics,
    });
    writeBaselineArtifact(options.writeBaselinePath, artifact);
    console.log(JSON.stringify({
      event: 'rag_evaluation_baseline_written',
      collection: qdrant.collection,
      path: options.writeBaselinePath,
      evaluationSetFingerprint: evalFingerprint,
      metrics,
    }));
    return;
  }

  const comparison = compareCandidateMetrics(
    metrics,
    baseline?.artifact.metrics || metrics,
  );
  if (!comparison.passed) {
    reportComparisonFailures(comparison);
    process.exitCode = 1;
    return;
  }
  if (options.mode === 'evaluateLocal') {
    console.log(JSON.stringify({
      event: 'rag_evaluation_local_passed',
      collection: qdrant.collection,
      metrics,
      promotionMarkerWritten: false,
    }));
    return;
  }
  fs.writeFileSync(evaluationFile, `${JSON.stringify({
    schemaVersion: BASELINE_SCHEMA_VERSION,
    kind: EVALUATION_RESULT_KIND,
    passed: true,
    passedAt: new Date().toISOString(),
    collection: qdrant.collection,
    fingerprint: kbFingerprint,
    gateFingerprint,
    evaluationSetFingerprint: evalFingerprint,
    baselineFingerprint: baseline.fingerprint,
    baselineCollection: baseline.artifact.collection,
    baselineCreatedAt: baseline.artifact.createdAt,
    baselineMetrics: baseline.artifact.metrics,
    metrics,
    ...metrics,
  }, null, 2)}\n`, {mode: 0o600});
  fs.chmodSync(evaluationFile, 0o600);
}

if (require.main === module) {
  main().catch(error => {
    invalidateEvaluationMarker();
    console.error(error.message);
    console.error(USAGE);
    process.exit(1);
  });
}

module.exports = {
  BASELINE_KIND,
  BASELINE_SCHEMA_VERSION,
  EVALUATION_RESULT_KIND,
  METRIC_NAMES,
  USAGE,
  compareCandidateMetrics,
  createBaselineArtifact,
  evaluationSetFingerprint,
  loadBaselineArtifact,
  main,
  parseEvaluationArguments,
  validateBaselineArtifact,
  validateMetricSet,
  writeBaselineArtifact,
};
