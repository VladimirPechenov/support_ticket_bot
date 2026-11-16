import { Cache, Config } from './interfaces';
import TelegramAddon from './addons/telegram';
import * as YAML from 'yaml';
import * as fs from 'fs';
import {logger} from './logger';

const cache: Cache = {
  ticketID: '',
  ticketIDs: [],
  ticketStatus: {},
  ticketSent: [],
  html: '',
  noSound: '',
  markdown: '',
  bot: {} as TelegramAddon,
  config: {} as Config,
  aiSessions: {},
};

try {
  const configPath = process.env.SUPPORTBOT_CONFIG_PATH ||
    './config/config.yaml';
  const configContent = fs.readFileSync(configPath, 'utf8');
  cache.config = YAML.parse(configContent);
  if (process.env.BOT_TOKEN) {
    cache.config.bot_token = process.env.BOT_TOKEN;
  }
  logger.info('cache', 'Configuration loaded', {
    configExists: true,
    aiExists: !!cache.config.ai,
    aiEnabled: !!cache.config.ai?.enabled,
    mode: cache.config.ai?.mode || 'off',
  });
} catch (error) {
  logger.error('cache', 'Configuration loading failed', {
    errorType: error instanceof Error ? error.name : typeof error,
  });
  process.exit(1);
}

export default cache;
