#!/usr/bin/env node

'use strict';

try {
  const flags = require('../build/db').getRuntimeFeatureFlags();
  if (
    flags.aiMode !== 'off' ||
    flags.aiRolloutPercent !== 0 ||
    flags.webToolRolloutPercent !== 0
  ) {
    throw new Error('runtime flags must be mode=off, ai=0 and web=0');
  }
  console.log(JSON.stringify({
    event: 'runtime_safe_mode_check',
    ok: true,
    mode: flags.aiMode,
  }));
} catch (error) {
  console.error(JSON.stringify({
    event: 'runtime_safe_mode_check',
    ok: false,
    reason: error instanceof Error ? error.message : 'check_failed',
  }));
  process.exitCode = 1;
}
