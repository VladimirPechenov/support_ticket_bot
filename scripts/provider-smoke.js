#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const YAML = require('yaml');
const {requestLlm} = require('../build/ai-client');

const PINNED_MODELS = Object.freeze({
  gemini: 'gemini-3.1-flash-lite',
  mistral: 'mistral-small-2603',
});

function validateProviderProfiles(profiles, mode) {
  const selected = [profiles.primary, profiles.fallback].filter(Boolean);
  if (mode === 'full' && profiles.primary && selected.every(profile =>
    profile.provider === 'gemini' &&
      ['gemini-3.1-flash-lite', 'gemini-3.5-flash-lite', 'gemini-3.8-flash']
        .includes(profile.model))) return selected;
  if (
    profiles.primary?.provider !== 'mistral' ||
    profiles.fallback?.provider !== 'gemini' ||
    profiles.primary.model !== PINNED_MODELS.mistral ||
    profiles.fallback.model !== PINNED_MODELS.gemini
  ) throw new Error('Pinned Mistral/Gemini provider profiles are required');
  return [profiles.primary, profiles.fallback];
}

function configuredProviders() {
  const configPath = process.env.SUPPORTBOT_CONFIG_PATH || path.join(
    __dirname,
    '..',
    'config',
    'config.yaml',
  );
  const config = YAML.parse(fs.readFileSync(
    configPath,
    'utf8',
  ));
  return validateProviderProfiles(config?.ai?.llm?.providers || {}, config?.ai?.mode);
}

async function check(provider, model, keyName) {
  if (!process.env[keyName]) {
    return {provider, model, ok: false, reason: 'missing_key'};
  }
  const result = await requestLlm({
    systemPrompt: 'Return exactly OK.',
    userText: 'health check',
    history: [],
    documents: [],
  }, {
    primary: {provider, model, max_tokens: 8, timeout_ms: 9000},
    max_attempts: 1,
    deadline_ms: 10000,
    max_input_tokens: 128,
  });
  return {
    provider,
    model,
    ok: result.ok,
    reason: result.ok ? undefined : result.reason,
    latencyMs: result.latencyMs,
  };
}

async function main() {
  const results = [];
  const profiles = configuredProviders();
  const selected = process.argv.includes('--primary-only') ?
    profiles.slice(0, 1) : profiles;
  for (const profile of selected) {
    results.push(await check(
      profile.provider,
      profile.model,
      profile.provider === 'gemini' ? 'GOOGLE_API_KEY' : 'MISTRAL_API_KEY',
    ));
  }
  for (const result of results) console.log(JSON.stringify(result));
  if (results.some((result) => !result.ok)) process.exitCode = 1;
}

if (require.main === module) {
  main().catch(() => {
    console.error(JSON.stringify({event: 'provider_smoke', ok: false}));
    process.exitCode = 1;
  });
}

module.exports = {
  check,
  configuredProviders,
  PINNED_MODELS,
  validateProviderProfiles,
};
