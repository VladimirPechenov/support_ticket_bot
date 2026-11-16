#!/usr/bin/env node

const fs = require('fs');

const qdrantUrl = String(
  process.env.QDRANT_URL || 'http://qdrant:6333',
).replace(/\/$/, '');
const qdrantApiKey = process.env.QDRANT_API_KEY || '';
const collection = process.env.QDRANT_COLLECTION || 'support_kb_active';
const outputPath = process.env.SNAPSHOT_OUTPUT || '';
const timeoutMs = Number(process.env.QDRANT_TIMEOUT_MS || 15000);

function headers() {
  return qdrantApiKey ? {'api-key': qdrantApiKey} : {};
}

async function checkedFetch(label, url, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    response = await fetch(url, {...options, signal: controller.signal});
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error(`${label} timed out after ${timeoutMs} ms`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
  if (!response.ok) {
    throw new Error(`${label} returned HTTP ${response.status}`);
  }
  return response;
}

async function resolveCollection(name) {
  const response = await checkedFetch(
    'Qdrant alias listing',
    `${qdrantUrl}/aliases`,
    {headers: headers()},
  );
  const body = await response.json();
  const alias = (body.result?.aliases || [])
    .find(item => item.alias_name === name);
  return alias?.collection_name || name;
}

async function main() {
  if (!outputPath) throw new Error('SNAPSHOT_OUTPUT is required');
  const target = await resolveCollection(collection);
  const created = await checkedFetch(
    'Qdrant snapshot creation',
    `${qdrantUrl}/collections/${encodeURIComponent(target)}/snapshots`,
    {method: 'POST', headers: headers()},
  );
  const metadata = await created.json();
  const snapshotName = metadata.result?.name;
  if (!snapshotName) throw new Error('Qdrant returned no snapshot name');
  const downloaded = await checkedFetch(
    'Qdrant snapshot download',
    `${qdrantUrl}/collections/${encodeURIComponent(target)}/snapshots/${
      encodeURIComponent(snapshotName)
    }`,
    {headers: headers()},
  );
  fs.writeFileSync(outputPath, Buffer.from(await downloaded.arrayBuffer()), {
    mode: 0o600,
  });
  console.log(JSON.stringify({
    event: 'qdrant_snapshot_saved',
    alias: collection,
    collection: target,
    snapshotName,
    outputPath,
  }));
}

if (require.main === module) {
  main().catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

module.exports = {resolveCollection};
