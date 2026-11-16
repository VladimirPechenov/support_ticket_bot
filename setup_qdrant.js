const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const YAML = require('yaml');

function loadConfig() {
  const configPath = process.env.SUPPORTBOT_CONFIG_PATH || path.join(__dirname, 'config', 'config.yaml');
  if (!fs.existsSync(configPath)) return {};
  return YAML.parse(fs.readFileSync(configPath, 'utf8')) || {};
}

const config = loadConfig();
const embeddings = config.ai?.embeddings || {};
const qdrant = config.ai?.rag?.qdrant || {};
const embeddingProvider = process.env.EMBEDDING_PROVIDER ||
  embeddings.provider || 'mistral';
const embeddingApiKey = embeddingProvider === 'mistral' ?
  process.env.MISTRAL_API_KEY || '' : process.env.GOOGLE_API_KEY || '';
const embeddingModel = process.env.EMBEDDING_MODEL || embeddings.model ||
  'mistral-embed';
const embeddingDimensions = Number(
  process.env.EMBEDDING_DIMENSIONS || embeddings.dimensions || 1024,
);
const embeddingTimeoutMs = Number(
  process.env.EMBEDDING_TIMEOUT_MS || embeddings.timeout_ms || 10000,
);
const qdrantTimeoutMs = Number(process.env.QDRANT_TIMEOUT_MS || 15000);
const qdrantUrl = String(process.env.QDRANT_URL || qdrant.url ||
  'http://localhost:6333').replace(/\/$/, '');
const qdrantApiKey = process.env.QDRANT_API_KEY || '';
const collectionAlias = process.env.QDRANT_COLLECTION_ALIAS ||
  qdrant.collection || 'support_kb_active';
const fingerprintFile = path.join(__dirname, 'config', '.kb-fingerprint-v3');
const evaluationFile = path.join(__dirname, 'config', '.kb-evaluation-v3.json');
const evaluationBaselineFile = process.env.RAG_EVAL_BASELINE_FILE ||
  path.join(__dirname, 'config', 'rag-evaluation-baseline.json');
const approvedBaselineFingerprint = String(
  process.env.RAG_EVAL_BASELINE_SHA256 || '',
).trim().toLowerCase();
const evaluationCasesFile = path.join(
  __dirname,
  'scripts',
  'fixtures',
  'rag-eval.json',
);
const conversationEvaluationCasesFile = path.join(
  __dirname,
  'scripts',
  'fixtures',
  'rag-conversation-eval.json',
);
const RAG_RELEASE_GATE = Object.freeze({
  hitAtOne: 0.6,
  contextRecall: 0.97,
  conversationRecall: 1,
  negativeHandoff: 1,
  directPrecision: 1,
});
const RAG_EVALUATION_SCHEMA_VERSION = 3;
const RAG_METRIC_NAMES = Object.freeze(Object.keys(RAG_RELEASE_GATE));
const requiredFields = [
  'id', 'title', 'answer', 'aliases', 'tags', 'source', 'updated_at',
];

function qdrantHeaders(json = false) {
  return {
    ...(json ? {'Content-Type': 'application/json'} : {}),
    ...(qdrantApiKey ? {'api-key': qdrantApiKey} : {}),
  };
}

function normalize(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[^a-zа-я0-9]+/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function validateDocuments(documents) {
  const ids = new Set();
  const aliases = new Set();
  for (const [index, document] of documents.entries()) {
    const missing = requiredFields.filter(field => !(field in document));
    if (missing.length > 0) {
      throw new Error(`KB line ${index + 1} misses: ${missing.join(', ')}`);
    }
    if (
      typeof document.id !== 'string' ||
      typeof document.title !== 'string' ||
      typeof document.answer !== 'string' ||
      typeof document.source !== 'string' ||
      typeof document.updated_at !== 'string' ||
      !Array.isArray(document.aliases) ||
      !Array.isArray(document.tags)
    ) throw new Error(`KB line ${index + 1} has invalid field types`);
    if (!document.id || !document.title.trim() || !document.answer.trim()) {
      throw new Error(`KB line ${index + 1} has an empty required value`);
    }
    if (ids.has(document.id)) throw new Error(`Duplicate KB id: ${document.id}`);
    ids.add(document.id);
    for (const alias of document.aliases) {
      const key = normalize(alias);
      if (!key) throw new Error(`Empty alias in ${document.id}`);
      if (aliases.has(key)) throw new Error(`Duplicate KB alias: ${alias}`);
      aliases.add(key);
    }
  }
  return documents;
}

function loadDocuments() {
  const filePath = process.env.SUPPORT_KB_PATH || path.join(__dirname, 'config', 'knowledge-base.jsonl');
  if (!fs.existsSync(filePath)) return [];
  return validateDocuments(fs.readFileSync(filePath, 'utf8')
    .split('\n')
    .filter(line => line.trim())
    .map(line => JSON.parse(line)));
}

function buildEmbeddingText(document) {
  return [
    document.title,
    document.intent || '',
    ...(document.aliases || []),
    ...(document.tags || []),
    document.answer,
  ].join('\n').trim();
}

function knowledgeBaseFingerprint(documents) {
  return crypto.createHash('sha256').update(JSON.stringify({
    embeddingModel,
    embeddingDimensions,
    documents,
  })).digest('hex');
}

function ragEvaluationPolicy() {
  return {
    candidateK: qdrant.candidate_k || 53,
    rrfK: qdrant.rrf_k ?? 60,
    denseWeight: qdrant.dense_weight ?? 0.5,
    denseContextThreshold: qdrant.dense_context_threshold ?? 0.52,
    lexicalContextThreshold: qdrant.lexical_context_threshold ?? 1.2,
    minimumQueryCoverage: qdrant.minimum_query_coverage ?? 0,
    maxContextDocuments: qdrant.max_context_docs || 4,
    confidenceThreshold: qdrant.confidence_threshold ?? 0,
    historyQueryMessages: qdrant.history_query_messages ?? 2,
    handoffOnLowConfidence: config.ai?.handoff?.on_low_confidence === true,
    directAnswerMinimumMargin: qdrant.direct_answer_min_margin ?? 0.05,
    directAnswerEnabled: qdrant.direct_answer_on_llm_error !== false,
    acceptance: RAG_RELEASE_GATE,
  };
}

function loadEvaluationCases() {
  return {
    standalone: JSON.parse(fs.readFileSync(evaluationCasesFile, 'utf8')),
    conversation: JSON.parse(
      fs.readFileSync(conversationEvaluationCasesFile, 'utf8'),
    ),
  };
}

function evaluationGateFingerprint(
  documents,
  evaluationCases = loadEvaluationCases(),
  policy = ragEvaluationPolicy(),
) {
  return crypto.createHash('sha256').update(JSON.stringify({
    version: 1,
    knowledgeBase: knowledgeBaseFingerprint(documents),
    evaluationCases,
    policy,
  })).digest('hex');
}

function versionedCollectionName(fingerprint) {
  const model = embeddingModel.replace(/[^a-z0-9]+/gi, '_').toLowerCase();
  const forceSuffix = process.env.FORCE_REINDEX === 'true' ?
    `_${Date.now()}` : '';
  return `support_kb_${fingerprint.slice(0, 12)}_${model}_${
    embeddingDimensions
  }${forceSuffix}`.slice(0, 120);
}

async function fetchWithTimeout(url, options = {}, timeoutMs = embeddingTimeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {...options, signal: controller.signal});
  } finally {
    clearTimeout(timeout);
  }
}

async function waitForQdrant() {
  for (let attempt = 1; attempt <= 10; attempt++) {
    try {
      const response = await fetchWithTimeout(`${qdrantUrl}/readyz`, {
        headers: qdrantHeaders(),
      }, qdrantTimeoutMs);
      if (response.ok) return;
    } catch (error) {
      if (attempt === 10) throw error;
    }
    await new Promise(resolve => setTimeout(resolve, 3000));
  }
  throw new Error('Qdrant failed to start');
}

async function embedGeminiText(text, attempt = 1) {
  const model = String(embeddingModel).replace(/^models\//, '');
  const response = await fetchWithTimeout(
    `https://generativelanguage.googleapis.com/v1beta/models/${
      encodeURIComponent(model)
    }:embedContent`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': embeddingApiKey,
      },
      body: JSON.stringify({
        model: `models/${model}`,
        content: {parts: [{text}]},
        taskType: 'RETRIEVAL_DOCUMENT',
        outputDimensionality: embeddingDimensions,
      }),
    },
  );
  if (!response.ok) {
    if (attempt < 3 && (response.status === 429 || response.status >= 500)) {
      await new Promise(resolve => setTimeout(resolve, attempt * 2000));
      return embedGeminiText(text, attempt + 1);
    }
    throw new Error(`Embedding API returned ${response.status}`);
  }
  const body = await response.json();
  const vector = body.embedding?.values;
  if (!Array.isArray(vector) || vector.length !== embeddingDimensions) {
    throw new Error('Embedding API returned an invalid vector');
  }
  return vector;
}

async function embedMistralTexts(texts, attempt = 1) {
  const response = await fetchWithTimeout(
    'https://api.mistral.ai/v1/embeddings',
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${embeddingApiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({model: embeddingModel, input: texts}),
    },
  );
  if (!response.ok) {
    if (attempt < 3 && (response.status === 429 || response.status >= 500)) {
      await new Promise(resolve => setTimeout(resolve, attempt * 2000));
      return embedMistralTexts(texts, attempt + 1);
    }
    throw new Error(`Embedding API returned ${response.status}`);
  }
  const body = await response.json();
  const rows = Array.isArray(body.data) ? [...body.data] : [];
  rows.sort((left, right) => Number(left.index) - Number(right.index));
  const vectors = rows.map(row => row.embedding);
  if (
    vectors.length !== texts.length ||
    vectors.some(vector => !Array.isArray(vector) ||
      vector.length !== embeddingDimensions)
  ) throw new Error('Embedding API returned invalid vectors');
  return vectors;
}

async function embedTexts(texts) {
  if (!embeddingApiKey) {
    throw new Error(`${embeddingProvider.toUpperCase()} API key is required`);
  }
  if (embeddingProvider === 'mistral') return embedMistralTexts(texts);
  if (embeddingProvider === 'gemini') {
    return Promise.all(texts.map(text => embedGeminiText(text)));
  }
  throw new Error(`Unsupported embedding provider: ${embeddingProvider}`);
}

async function preparePoints(documents = loadDocuments()) {
  try {
    const vectors = await embedTexts(documents.map(buildEmbeddingText));
    return documents.map((document, index) => ({
      id: index + 1,
      vector: vectors[index],
      payload: document,
    }));
  } catch (error) {
    throw new Error(`Knowledge-base embedding failed: ${error.message}`);
  }
}

async function collectionInfo(name) {
  const response = await fetchWithTimeout(`${qdrantUrl}/collections/${name}`, {
    headers: qdrantHeaders(),
  }, qdrantTimeoutMs);
  if (!response.ok) return null;
  return (await response.json()).result || null;
}

async function aliases() {
  const response = await fetchWithTimeout(`${qdrantUrl}/aliases`, {
    headers: qdrantHeaders(),
  }, qdrantTimeoutMs);
  if (!response.ok) throw new Error(`Alias listing failed: ${response.status}`);
  return (await response.json()).result?.aliases || [];
}

async function createAndUploadCollection(name, points) {
  const existing = await collectionInfo(name);
  if (existing) {
    if (
      existing.points_count === points.length &&
      existing.config?.params?.vectors?.size === embeddingDimensions
    ) return;
    throw new Error(`Versioned collection ${name} exists but is inconsistent`);
  }
  const created = await fetchWithTimeout(`${qdrantUrl}/collections/${name}`, {
    method: 'PUT',
    headers: qdrantHeaders(true),
    body: JSON.stringify({
      vectors: {size: embeddingDimensions, distance: 'Cosine'},
    }),
  }, qdrantTimeoutMs);
  if (!created.ok) throw new Error(`Collection creation failed: ${created.status}`);
  const uploaded = await fetchWithTimeout(
    `${qdrantUrl}/collections/${name}/points?wait=true`,
    {
      method: 'PUT',
      headers: qdrantHeaders(true),
      body: JSON.stringify({points}),
    },
    qdrantTimeoutMs,
  );
  if (!uploaded.ok) throw new Error(`Point upload failed: ${uploaded.status}`);
  const verified = await collectionInfo(name);
  if (verified?.points_count !== points.length) {
    throw new Error('Collection verification failed');
  }
}

async function switchAlias(targetCollection) {
  const current = await aliases();
  const existing = current.find(alias => alias.alias_name === collectionAlias);
  if (existing?.collection_name === targetCollection) return;
  const actions = [];
  if (existing) actions.push({delete_alias: {alias_name: collectionAlias}});
  actions.push({
    create_alias: {
      collection_name: targetCollection,
      alias_name: collectionAlias,
    },
  });
  const response = await fetchWithTimeout(`${qdrantUrl}/collections/aliases`, {
    method: 'POST',
    headers: qdrantHeaders(true),
    body: JSON.stringify({actions}),
  }, qdrantTimeoutMs);
  if (!response.ok) throw new Error(`Alias switch failed: ${response.status}`);
}

function readJsonFile(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (_error) {
    return null;
  }
}

function evaluationSetFingerprint(evaluationCases) {
  return crypto.createHash('sha256')
    .update(JSON.stringify(evaluationCases))
    .digest('hex');
}

function readEvaluationBaseline(filePath) {
  const stats = fs.lstatSync(filePath);
  if (
    stats.isSymbolicLink() ||
    !stats.isFile() ||
    stats.size > 64 * 1024 ||
    (stats.mode & 0o022) !== 0
  ) {
    throw new Error(
      'RAG evaluation baseline must be a protected regular file <= 64 KiB',
    );
  }
  const raw = fs.readFileSync(filePath, 'utf8');
  return {
    artifact: JSON.parse(raw),
    fingerprint: crypto.createHash('sha256').update(raw).digest('hex'),
  };
}

function isMetricSet(metrics) {
  return !!metrics && typeof metrics === 'object' &&
    RAG_METRIC_NAMES.every(name =>
      Number.isFinite(metrics[name]) &&
      metrics[name] >= 0 &&
      metrics[name] <= 1,
    );
}

function metricSetAtLeast(metrics, minimum) {
  return isMetricSet(metrics) && isMetricSet(minimum) &&
    RAG_METRIC_NAMES.every(name => metrics[name] >= minimum[name]);
}

function promotionEvaluationMatches({
  evaluation,
  baseline,
  baselineFingerprint,
  expectedBaselineFingerprint,
  targetCollection,
  fingerprint,
  gateFingerprint,
  expectedEvaluationSetFingerprint,
  currentTime = Date.now(),
}) {
  const passedAt = Date.parse(evaluation?.passedAt || '');
  const baselineCreatedAt = Date.parse(baseline?.createdAt || '');
  const baselineReleaseGateMatches = isMetricSet(baseline?.releaseGate) &&
    RAG_METRIC_NAMES.every(name =>
      baseline.releaseGate[name] === RAG_RELEASE_GATE[name],
    );
  const markerBaselineMatches = isMetricSet(evaluation?.baselineMetrics) &&
    isMetricSet(baseline?.metrics) &&
    RAG_METRIC_NAMES.every(name =>
      evaluation.baselineMetrics[name] === baseline.metrics[name],
    );
  return evaluation?.schemaVersion === RAG_EVALUATION_SCHEMA_VERSION &&
    evaluation?.kind === 'rag-evaluation-result' &&
    evaluation?.passed === true &&
    evaluation?.collection === targetCollection &&
    evaluation?.fingerprint === fingerprint &&
    evaluation?.gateFingerprint === gateFingerprint &&
    evaluation?.evaluationSetFingerprint ===
      expectedEvaluationSetFingerprint &&
    evaluation?.baselineFingerprint === baselineFingerprint &&
    baselineFingerprint === expectedBaselineFingerprint &&
    evaluation?.baselineCollection === baseline?.collection &&
    evaluation?.baselineCreatedAt === baseline?.createdAt &&
    baseline?.schemaVersion === RAG_EVALUATION_SCHEMA_VERSION &&
    baseline?.kind === 'rag-evaluation-baseline' &&
    baseline?.evaluationSetFingerprint ===
      expectedEvaluationSetFingerprint &&
    Number.isFinite(baselineCreatedAt) &&
    baselineReleaseGateMatches &&
    markerBaselineMatches &&
    metricSetAtLeast(evaluation?.metrics, RAG_RELEASE_GATE) &&
    metricSetAtLeast(evaluation?.metrics, baseline.metrics) &&
    RAG_METRIC_NAMES.every(name =>
      evaluation[name] === evaluation.metrics[name],
    ) &&
    Number.isFinite(passedAt) &&
    currentTime >= passedAt &&
    currentTime - passedAt <= 24 * 60 * 60 * 1000;
}

function collectionMatches(info, expectedPoints) {
  return !!info &&
    info.points_count === expectedPoints &&
    info.config?.params?.vectors?.size === embeddingDimensions;
}

function assertRecentEvaluation(
  targetCollection,
  fingerprint,
  gateFingerprint,
) {
  const evaluation = readJsonFile(evaluationFile);
  let baseline = null;
  try {
    baseline = readEvaluationBaseline(evaluationBaselineFile);
  } catch (_error) {
    // A missing, malformed or unsafe baseline keeps promotion fail-closed.
  }
  if (!baseline || !promotionEvaluationMatches({
    evaluation,
    baseline: baseline.artifact,
    baselineFingerprint: baseline.fingerprint,
    expectedBaselineFingerprint: approvedBaselineFingerprint,
    targetCollection,
    fingerprint,
    gateFingerprint,
    expectedEvaluationSetFingerprint: evaluationSetFingerprint(
      loadEvaluationCases(),
    ),
  })) {
    throw new Error(
      'Alias promotion requires a baseline-bound RAG evaluation from the last 24h',
    );
  }
}

async function main() {
  try {
    if (embeddings.enabled === false) {
      throw new Error('Dense embeddings are disabled in configuration');
    }
    if (!embeddingApiKey) {
      throw new Error(`${embeddingProvider.toUpperCase()} API key is required`);
    }
    if (!Number.isInteger(embeddingDimensions) || embeddingDimensions <= 0) {
      throw new Error('Embedding dimensions must be a positive integer');
    }
    const documents = loadDocuments();
    if (documents.length === 0) throw new Error('Knowledge base is empty');
    await waitForQdrant();
    const fingerprint = knowledgeBaseFingerprint(documents);
    const gateFingerprint = evaluationGateFingerprint(documents);
    const previousManifest = readJsonFile(fingerprintFile);
    const promote = process.env.PROMOTE_QDRANT_ALIAS === 'true';
    const targetCollection = promote &&
      previousManifest?.fingerprint === fingerprint &&
      typeof previousManifest?.collection === 'string' ?
      previousManifest.collection : versionedCollectionName(fingerprint);
    let targetInfo = await collectionInfo(targetCollection);
    if (targetInfo && !collectionMatches(targetInfo, documents.length)) {
      throw new Error(
        `Versioned collection ${targetCollection} is inconsistent`,
      );
    }
    if (!targetInfo) {
      const points = await preparePoints(documents);
      await createAndUploadCollection(targetCollection, points);
      targetInfo = await collectionInfo(targetCollection);
    }
    if (!collectionMatches(targetInfo, documents.length)) {
      throw new Error('Versioned collection verification failed');
    }
    if (promote) {
      assertRecentEvaluation(targetCollection, fingerprint, gateFingerprint);
      await switchAlias(targetCollection);
    }
    fs.writeFileSync(fingerprintFile, JSON.stringify({
      fingerprint,
      gateFingerprint,
      alias: collectionAlias,
      collection: targetCollection,
      model: embeddingModel,
      dimensions: embeddingDimensions,
      points: documents.length,
      promoted: promote,
      builtAt: new Date().toISOString(),
    }), {mode: 0o600});
    fs.chmodSync(fingerprintFile, 0o600);
    console.log(JSON.stringify({
      event: promote ? 'qdrant_alias_promoted' : 'qdrant_index_ready',
      alias: collectionAlias,
      collection: targetCollection,
      points: documents.length,
      fingerprint,
    }));
  } catch (error) {
    console.error(`Setup failed: ${error.message}`);
    process.exitCode = 1;
  }
}

if (require.main === module) main();

module.exports = {
  RAG_RELEASE_GATE,
  RAG_EVALUATION_SCHEMA_VERSION,
  RAG_METRIC_NAMES,
  buildEmbeddingText,
  evaluationGateFingerprint,
  evaluationSetFingerprint,
  knowledgeBaseFingerprint,
  loadEvaluationCases,
  loadDocuments,
  normalize,
  promotionEvaluationMatches,
  preparePoints,
  ragEvaluationPolicy,
  validateDocuments,
  versionedCollectionName,
};
