import cache from './cache';
import * as middleware from './middleware';
import {logger} from './logger';

let initialized = false;
let lastAlertAt = 0;

async function alertStaff(): Promise<void> {
  if (Date.now() - lastAlertAt < 10 * 60 * 1000) return;
  lastAlertAt = Date.now();
  await middleware.msg(
    cache.config.staffchat_id,
    '⚠️ Внутренняя ошибка бота. Подробности записаны в технический лог.',
  );
}

function errorType(reason: unknown): string {
  return reason instanceof Error ? reason.name : typeof reason;
}

function init(enabled = true): void {
  if (!enabled || initialized) return;
  initialized = true;
  process.once('uncaughtException', reason => {
    logger.error('process', 'Uncaught exception', {errorType: errorType(reason)});
    void alertStaff().finally(() => process.exit(1));
  });
  process.on('unhandledRejection', reason => {
    logger.error('process', 'Unhandled rejection', {errorType: errorType(reason)});
    void alertStaff();
  });
}

export {init};
