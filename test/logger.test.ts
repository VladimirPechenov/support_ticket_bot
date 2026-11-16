import {expect} from 'chai';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {Logger, sanitizeLogData} from '../src/logger';

describe('Structured logger', () => {
  let logDir: string;

  beforeEach(() => {
    logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'supportbot-log-'));
  });

  afterEach(() => {
    fs.rmSync(logDir, {recursive: true, force: true});
  });

  it('writes allowlisted JSONL fields and respects LOG_LEVEL', () => {
    const logger = new Logger({
      logDir,
      logLevel: 'WARN',
      stdout: false,
    });
    logger.info('agent', 'not emitted', {provider: 'google'});
    logger.error('agent', 'provider failed', {
      provider: 'google',
      status: 429,
      userId: 'telegram-user',
      prompt: 'private prompt',
      arguments: {query: 'private query'},
    });

    const lines = logger.getLastLines();
    expect(lines).to.have.length(1);
    const entry = JSON.parse(lines[0]);
    expect(entry.level).to.equal('ERROR');
    expect(entry.data).to.deep.equal({provider: 'google', status: 429});
    expect(lines[0]).not.to.contain('telegram-user');
    expect(lines[0]).not.to.contain('private prompt');
    expect(logger.getErrors()).to.have.length(1);
    expect(logger.getLastLines(0)).to.deep.equal([]);
    expect(logger.getErrors(0)).to.deep.equal([]);
  });

  it('deeply removes unknown/sensitive fields and handles cycles', () => {
    const data: any = {
      provider: 'google',
      model: 'api_key=very-secret',
      documents: [{
        sourceId: 'doc-1',
        denseScore: 0.9,
        title: 'sensitive title',
        text: 'sensitive body',
      }],
    };
    data.topCandidates = [data];
    const serialized = JSON.stringify(sanitizeLogData(data));
    expect(serialized).to.contain('google');
    expect(serialized).to.contain('[REDACTED]');
    expect(serialized).to.contain('[Circular]');
    expect(serialized).not.to.contain('sensitive title');
    expect(serialized).not.to.contain('sensitive body');
  });

  it('rotates during runtime and deletes files older than 14 days', () => {
    const oldFile = path.join(logDir, 'ai.old.log');
    fs.writeFileSync(oldFile, '{}\n');
    const old = new Date(Date.now() - 15 * 24 * 60 * 60 * 1000);
    fs.utimesSync(oldFile, old, old);
    const logger = new Logger({
      logDir,
      logLevel: 'INFO',
      maxBytes: 1024,
      retentionDays: 14,
      stdout: false,
    });
    expect(fs.existsSync(oldFile)).to.equal(false);

    for (let index = 0; index < 8; index++) {
      logger.info('rotation', 'x'.repeat(256), {
        count: index,
        provider: 'google',
      });
    }
    expect(fs.readdirSync(logDir).some(
      fileName => /^ai\..+\.log$/.test(fileName),
    )).to.equal(true);
  });

  it('rotates an old active ai.log even when it is below the size limit', () => {
    const active = path.join(logDir, 'ai.log');
    fs.writeFileSync(active, '{}\n');
    const now = Date.now();
    const old = new Date(now - 15 * 24 * 60 * 60 * 1000);
    fs.utimesSync(active, old, old);
    new Logger({
      logDir,
      retentionDays: 14,
      maxBytes: 1024 * 1024,
      stdout: false,
      now: () => now,
    });
    expect(fs.existsSync(active)).to.equal(false);
    expect(fs.readdirSync(logDir)).to.deep.equal([]);
  });
});
