'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const {spawnSync} = require('child_process');
const root = path.resolve(__dirname, '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'supportbot-tests-'));
const configPath = path.join(temp, 'config.yaml');
let config = fs.readFileSync(path.join(root, 'config/config.example.yaml'), 'utf8');
config = config.replace('bot_token: ""', 'bot_token: "123456:TEST_TOKEN"')
  .replace('staffchat_id: ""', 'staffchat_id: "-1001"')
  .replace('owner_id: ""', 'owner_id: "101"');
fs.writeFileSync(configPath, config);
const patterns = process.argv.slice(2);
const testFiles = patterns.length ? patterns.map(name => path.join(root, 'test', name)) : [path.join(root, 'test', '**', '*.ts')];
let result;
try {
  const env = {...process.env, NODE_ENV: 'test',
    DB_PATH: path.join(temp, 'support.db'), LOG_DIR: path.join(temp, 'logs'),
    SUPPORTBOT_CONFIG_PATH: configPath,
    SUPPORT_KB_PATH: path.join(root, 'test/fixtures/knowledge-base.jsonl')};
  for (const key of ['BOT_TOKEN', 'GOOGLE_API_KEY', 'MISTRAL_API_KEY', 'QDRANT_API_KEY', 'GEMINI_PROXY_URL']) delete env[key];
  result = spawnSync(process.execPath, ['--no-experimental-strip-types', path.join(root, 'node_modules/mocha/bin/mocha.js'), '-r', 'ts-node/register', ...testFiles, '--timeout', '15000', '--exit'], {cwd: root, env, stdio: 'inherit'});
} finally {
  fs.rmSync(temp, {recursive: true, force: true});
}
process.exit(result.status === null ? 1 : result.status);
