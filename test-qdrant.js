#!/usr/bin/env node

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
const googleApiKey = process.env.GOOGLE_API_KEY || '';
const qdrantUrl = String(
  process.env.QDRANT_URL || qdrant.url || 'http://localhost:6333',
).replace(/\/$/, '');
const qdrantApiKey = process.env.QDRANT_API_KEY || '';
const collectionAlias = process.env.QDRANT_COLLECTION || qdrant.collection ||
  'support_kb_active';
const embeddingModel = process.env.EMBEDDING_MODEL || embeddings.model ||
  'gemini-embedding-001';
const embeddingDimensions = Number(
  process.env.EMBEDDING_DIMENSIONS || embeddings.dimensions || 768,
);
const requestTimeoutMs = Number(process.env.REQUEST_TIMEOUT_MS || 10000);
const scoreThreshold = Number(process.env.QDRANT_SCORE_THRESHOLD || 0.30);

function qdrantHeaders(json = false) {
  return {
    ...(json ? {'Content-Type': 'application/json'} : {}),
    ...(qdrantApiKey ? {'api-key': qdrantApiKey} : {}),
  };
}

async function fetchWithTimeout(url, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), requestTimeoutMs);
  try {
    return await fetch(url, {...options, signal: controller.signal});
  } finally {
    clearTimeout(timeout);
  }
}

async function requestJson(label, url, options = {}) {
  const response = await fetchWithTimeout(url, options);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`${label} returned HTTP ${response.status}`);
  }
  return body;
}

async function embedQuery(text) {
  const model = String(embeddingModel).replace(/^models\//, '');
  const body = await requestJson(
    'Google embedding API',
    `https://generativelanguage.googleapis.com/v1beta/models/${
      encodeURIComponent(model)
    }:embedContent`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': googleApiKey,
      },
      body: JSON.stringify({
        model: `models/${model}`,
        content: {parts: [{text}]},
        taskType: 'RETRIEVAL_QUERY',
        outputDimensionality: embeddingDimensions,
      }),
    },
  );
  const vector = body.embedding?.values;
  if (!Array.isArray(vector) || vector.length !== embeddingDimensions) {
    throw new Error('Google embedding API returned an invalid vector');
  }
  return vector;
}

async function resolveCollection(name) {
  const body = await requestJson(
    'Qdrant alias listing',
    `${qdrantUrl}/aliases`,
    {headers: qdrantHeaders()},
  );
  const aliases = body.result?.aliases || [];
  const match = aliases.find(alias => alias.alias_name === name);
  return {
    requested: name,
    target: match?.collection_name || name,
    isAlias: !!match,
  };
}

function vectorSize(collection) {
  const vectors = collection.result?.config?.params?.vectors;
  if (Number.isInteger(vectors?.size)) return vectors.size;
  if (vectors && typeof vectors === 'object') {
    const first = Object.values(vectors)[0];
    if (Number.isInteger(first?.size)) return first.size;
  }
  return undefined;
}

async function search(query, vector) {
  const body = await requestJson(
    'Qdrant search',
    `${qdrantUrl}/collections/${
      encodeURIComponent(collectionAlias)
    }/points/search`,
    {
      method: 'POST',
      headers: qdrantHeaders(true),
      body: JSON.stringify({
        vector,
        limit: 5,
        with_payload: true,
        score_threshold: scoreThreshold,
      }),
    },
  );
  const points = Array.isArray(body.result) ? body.result :
    body.result?.points || [];
  console.log(JSON.stringify({
    check: 'qdrant_query',
    query,
    results: points.map(point => ({
      score: Number(Number(point.score || 0).toFixed(3)),
      sourceId: point.payload?.id || point.payload?.source || 'unknown',
      title: point.payload?.title || 'N/A',
    })),
  }));
}

async function main() {
  if (!googleApiKey) throw new Error('GOOGLE_API_KEY is required');
  if (!Number.isInteger(embeddingDimensions) || embeddingDimensions <= 0) {
    throw new Error('EMBEDDING_DIMENSIONS must be a positive integer');
  }
  if (!Number.isFinite(scoreThreshold) || scoreThreshold < 0) {
    throw new Error('QDRANT_SCORE_THRESHOLD must be a non-negative number');
  }

  const resolved = await resolveCollection(collectionAlias);
  const collection = await requestJson(
    'Qdrant collection check',
    `${qdrantUrl}/collections/${encodeURIComponent(resolved.target)}`,
    {headers: qdrantHeaders()},
  );
  const size = vectorSize(collection);
  if (size !== embeddingDimensions) {
    throw new Error(
      `Qdrant vector size ${size || 'unknown'} does not match ` +
      `${embeddingDimensions}`,
    );
  }
  console.log(JSON.stringify({
    check: 'qdrant_collection',
    alias: resolved.requested,
    target: resolved.target,
    aliasResolved: resolved.isAlias,
    points: collection.result?.points_count || 0,
    vectorSize: size,
    embeddingModel,
  }));

  for (const query of [
    'как установить сервис',
    'сервис не работает',
    'персональная ссылка',
    'Как докупить слот?',
  ]) {
    await search(query, await embedQuery(query));
  }
}

if (require.main === module) {
  main().catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

module.exports = {embedQuery, resolveCollection, vectorSize};
