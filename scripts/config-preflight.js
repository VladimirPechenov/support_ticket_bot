#!/usr/bin/env node

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

// Importing the production validator also imports the database module. Point
// that import at an isolated disposable database so config validation can
// never migrate or lock the live SQLite file.
const nonce = `${process.pid}-${Date.now()}`;
const preflightDb = path.join(os.tmpdir(), `supportbot-preflight-${nonce}.db`);
const preflightLogs = path.join(
  os.tmpdir(),
  `supportbot-preflight-logs-${nonce}`,
);
process.env.DB_PATH = preflightDb;
process.env.LOG_DIR = preflightLogs;
process.once('exit', () => {
  for (const suffix of ['', '-wal', '-shm']) {
    fs.rmSync(`${preflightDb}${suffix}`, {force: true});
  }
  fs.rmSync(preflightLogs, {recursive: true, force: true});
});

function hasRealSecret(name) {
  const value = String(process.env[name] || '').trim();
  return value.length >= 8 && !/^(replace|your_|changeme)/i.test(value);
}

function main() {
  const cacheModule = require('../build/cache');
  const {validateConfig} = require('../build/index');
  const config = cacheModule.default ? cacheModule.default.config : cacheModule.config;
  validateConfig(config);

  if (process.argv.includes('--require-ai-keys')) {
    const profiles = config.ai?.llm?.providers || {};
    const providers = [profiles.primary?.provider, profiles.fallback?.provider];
    if (config.ai?.mode !== 'full' && config.ai?.embeddings?.enabled !== false) {
      providers.push(config.ai?.embeddings?.provider);
    }
    const required = [...new Set(providers.filter(Boolean).map(provider =>
      provider === 'gemini' ? 'GOOGLE_API_KEY' : 'MISTRAL_API_KEY'))];
    const missing = required
      .filter(name => !hasRealSecret(name));
    if (missing.length > 0) {
      throw new Error(`Missing direct-provider secrets: ${missing.join(', ')}`);
    }
  }

  console.log(JSON.stringify({
    event: 'config_preflight',
    ok: true,
    aiMode: config.ai?.mode || 'off',
    directProviderSecretsRequired: process.argv.includes('--require-ai-keys'),
  }));
}

try {
  main();
} catch (error) {
  console.error(JSON.stringify({
    event: 'config_preflight',
    ok: false,
    errorType: error instanceof Error ? error.name : typeof error,
    reason: error instanceof Error ? error.message : 'validation_failed',
  }));
  process.exitCode = 1;
}
