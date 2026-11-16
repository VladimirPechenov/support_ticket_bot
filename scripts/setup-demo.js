'use strict';
const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '..');
for (const [from, to] of [
  ['config/config.example.yaml', 'config/config.yaml'],
  ['.env.example', '.env'],
  ['test/fixtures/knowledge-base.jsonl', 'config/knowledge-base.jsonl'],
]) {
  const target = path.join(root, to);
  if (!fs.existsSync(target)) fs.copyFileSync(path.join(root, from), target);
}
console.log('Local demo files are ready. Set your own bot token, owner ID and staff chat ID. AI remains off until enabled explicitly.');
