'use strict';

const fs = require('fs');
const path = require('path');
const {execFileSync} = require('child_process');
const root = path.resolve(__dirname, '..');
const files = execFileSync('git', ['ls-files', '-z'], {cwd: root, encoding: 'utf8'})
  .split('\0').filter(Boolean);
const failures = [];
const forbiddenPath = name => name === '.env' ||
  (name.startsWith('.env.') && name !== '.env.example') ||
  /^(build|logs|node_modules)\//.test(name) ||
  /\.(?:db|sqlite|sqlite3|log)(?:-(?:wal|shm))?$/.test(name) ||
  (name.startsWith('config/') && !['config/config.example.yaml', 'config/.gitkeep'].includes(name));
const secretPatterns = [
  /\b\d{7,12}:[A-Za-z0-9_-]{30,}\b/,
  /\bAIza[A-Za-z0-9_-]{30,}\b/,
  /\b(?:ghp|github_pat)_[A-Za-z0-9_]{20,}\b/,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
];
for (const name of files) {
  if (forbiddenPath(name)) failures.push(`${name}: runtime/generated file`);
  const text = fs.readFileSync(path.join(root, name), 'utf8');
  if (secretPatterns.some(pattern => pattern.test(text))) {
    // Deliberately report paths only. A scanner must never print credentials.
    failures.push(`${name}: credential-shaped value`);
  }
}
if (failures.length) {
  console.error(failures.join('\n'));
  process.exitCode = 1;
} else {
  console.log(`Checked ${files.length} tracked files: no runtime data or credential-shaped values.`);
}
