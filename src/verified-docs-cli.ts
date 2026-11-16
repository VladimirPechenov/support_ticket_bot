import {VerifiedDocsService} from './verified-docs';
import * as fs from 'fs';
import * as path from 'path';
import * as YAML from 'yaml';

const DEFAULT_INTERVAL_MS = 6 * 60 * 60 * 1000;

function configuredIntervalMs(): number {
  const environmentValue = Number(process.env.VERIFIED_DOCS_SYNC_INTERVAL_MS);
  let configured = Number.isFinite(environmentValue) && environmentValue > 0 ?
    environmentValue : DEFAULT_INTERVAL_MS;
  if (!(Number.isFinite(environmentValue) && environmentValue > 0)) {
    try {
      const config = YAML.parse(fs.readFileSync(
        path.join(process.cwd(), 'config', 'config.yaml'),
        'utf8',
      ));
      const yamlValue = Number(
        config?.ai?.tools?.verified_docs?.sync_interval_ms,
      );
      if (Number.isFinite(yamlValue) && yamlValue > 0) configured = yamlValue;
    } catch (_error) {
      // The six-hour safe default remains available to the standalone job.
    }
  }
  return Math.max(
    5 * 60 * 1000,
    Math.min(7 * 24 * 60 * 60 * 1000, configured),
  );
}

async function syncOnce(service: VerifiedDocsService): Promise<boolean> {
  const result = await service.sync();
  console.log(JSON.stringify({
    event: 'verified_docs_sync',
    changed: result.changed,
    documentsAvailable: result.documentsAvailable,
    statuses: result.statuses.map((status) => ({
      sourceId: status.sourceId,
      status: status.status,
      usedLastGoodSnapshot: status.usedLastGoodSnapshot,
      errorCode: status.errorCode,
    })),
  }));
  return result.documentsAvailable > 0;
}

async function main(): Promise<void> {
  const service = new VerifiedDocsService();
  const watch = process.argv.includes('--watch');
  const available = await syncOnce(service);
  if (!available && !watch) process.exitCode = 1;
  if (!watch) return;

  const intervalMs = configuredIntervalMs();
  const timer = setInterval(() => {
    void syncOnce(service).catch(() => {
      console.error(JSON.stringify({
        event: 'verified_docs_sync',
        status: 'failed',
      }));
    });
  }, intervalMs);
  const shutdown = () => {
    clearInterval(timer);
    process.exit(0);
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

if (require.main === module) {
  void main().catch(() => {
    console.error(JSON.stringify({
      event: 'verified_docs_sync',
      status: 'failed',
    }));
    process.exitCode = 1;
  });
}

export {configuredIntervalMs, main, syncOnce};
