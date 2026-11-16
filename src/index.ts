import { Context, Config } from './interfaces';
import cache from './cache';

import * as middleware from './middleware';
import * as commands from './commands';
import * as permissions from './permissions';
import * as inline from './inline';
import * as text from './text';
import * as files from './files';
import * as error from './error';
import * as db from './db';
import * as users from './users';
import * as staff from './staff';
import * as ai from './ai';
import TelegramAddon from './addons/telegram';
import {logger} from './logger';
import {
  setTelegramReady,
  startHealthServer,
  stopHealthServer,
} from './health-server';
import {
  aiControlCommand,
  aiHealthCommand,
  ticketDiagnosticsCommand,
} from './ai-admin';
import {configureOperationalAlerts} from './operational-alerts';
import {findCommand, panelCommand, registerStaffCommands} from './staff-panel';
import {escapeStaffHtml, staffEmoji} from './staff-ui';

let defaultBot: TelegramAddon;
let maintenanceTimer: NodeJS.Timeout | undefined;

function validateConfig(config: Config): void {
  const errors: string[] = [];
  const finiteInRange = (
    value: unknown,
    minimum: number,
    maximum: number,
    field: string,
    integer = false,
  ) => {
    if (value === undefined) return;
    if (
      typeof value !== 'number' ||
      !Number.isFinite(value) ||
      value < minimum ||
      value > maximum ||
      (integer && !Number.isInteger(value))
    ) errors.push(`${field} must be ${integer ? 'an integer ' : ''}between ${minimum} and ${maximum}`);
  };
  if (!config.bot_token) errors.push('BOT_TOKEN is required');
  if (!config.staffchat_id) errors.push('staffchat_id is required');
  if (config.owner_ids !== undefined &&
    (!Array.isArray(config.owner_ids) || config.owner_ids.some(id =>
      !/^\d{1,20}$/.test(String(id)),
    ))) errors.push('owner_ids must contain only Telegram numeric IDs');
  finiteInRange(
    config.support?.ai_inactivity_close_ms,
    60_000,
    365 * 24 * 60 * 60 * 1000,
    'support.ai_inactivity_close_ms',
    true,
  );
  finiteInRange(
    config.support?.metadata_retention_days,
    1,
    90,
    'support.metadata_retention_days',
    true,
  );
  finiteInRange(
    config.support?.maintenance_interval_ms,
    60_000,
    24 * 60 * 60 * 1000,
    'support.maintenance_interval_ms',
    true,
  );
  finiteInRange(
    config.support?.health_port,
    1,
    65_535,
    'support.health_port',
    true,
  );
  if (config.ai) {
    const rawLlm = config.ai.llm as any;
    const rawEmbeddings = config.ai.embeddings as any;
    const rawPrimary = rawLlm?.providers?.primary;
    const rawFallback = rawLlm?.providers?.fallback;
    const rawQdrant = config.ai.rag?.qdrant as any;
    if (
      rawLlm?.endpoint !== undefined ||
      rawLlm?.api_key !== undefined ||
      rawLlm?.apiKey !== undefined ||
      rawLlm?.base_url !== undefined ||
      rawLlm?.baseURL !== undefined ||
      rawLlm?.fallback_models !== undefined ||
      rawPrimary?.endpoint !== undefined ||
      rawPrimary?.api_key !== undefined ||
      rawPrimary?.apiKey !== undefined ||
      rawPrimary?.base_url !== undefined ||
      rawPrimary?.baseURL !== undefined ||
      rawFallback?.endpoint !== undefined ||
      rawFallback?.api_key !== undefined ||
      rawFallback?.apiKey !== undefined ||
      rawFallback?.base_url !== undefined ||
      rawFallback?.baseURL !== undefined ||
      rawEmbeddings?.endpoint !== undefined ||
      rawEmbeddings?.api_key !== undefined ||
      rawEmbeddings?.apiKey !== undefined ||
      rawEmbeddings?.base_url !== undefined ||
      rawEmbeddings?.baseURL !== undefined
    ) errors.push('legacy proxy/API-key fields are not supported');
    if (
      rawQdrant?.api_key !== undefined ||
      rawQdrant?.apiKey !== undefined
    ) {
      errors.push('Qdrant API key must be supplied through QDRANT_API_KEY');
    }
    const primary = config.ai.llm?.providers?.primary;
    const fallback = config.ai.llm?.providers?.fallback;
    const fullKnowledge = config.ai.mode === 'full';
    const fullKnowledgeModels = ['gemini-3.1-flash-lite', 'gemini-3.5-flash-lite', 'gemini-3.8-flash'];
    const fullKnowledgeGemini = fullKnowledge &&
      primary?.provider === 'gemini' && fullKnowledgeModels.includes(primary.model) &&
      (!fallback || (fallback.provider === 'gemini' &&
        fullKnowledgeModels.includes(fallback.model)));
    const geminiOnly = primary?.provider === 'gemini' &&
      primary?.model === 'gemini-3.1-flash-lite' &&
      !fallback &&
      (fullKnowledge || config.ai.embeddings?.enabled === false);
    if (
      !geminiOnly && !fullKnowledgeGemini && (
      primary?.provider !== 'mistral' ||
      primary?.model !== 'mistral-small-2603'
      )
    ) {
      errors.push(
        'ai.llm.providers.primary must be mistral/mistral-small-2603',
      );
    }
    if (
      !geminiOnly && !fullKnowledgeGemini && (
      fallback?.provider !== 'gemini' ||
      fallback?.model !== 'gemini-3.1-flash-lite'
      )
    ) {
      errors.push(
        'ai.llm.providers.fallback must be gemini/gemini-3.1-flash-lite',
      );
    }
    if (/latest/i.test(primary?.model || '') ||
      /latest/i.test(fallback?.model || '')) {
      errors.push('AI model IDs must be pinned and must not use latest');
    }
    if (!fullKnowledge && (
      config.ai.embeddings?.provider !== 'mistral' ||
      config.ai.embeddings?.model !== 'mistral-embed' ||
      config.ai.embeddings?.dimensions !== 1024
    )) {
      errors.push(
        'ai.embeddings must be mistral/mistral-embed with 1024 dimensions',
      );
    }
    if (
      config.ai.embeddings?.enabled !== undefined &&
      typeof config.ai.embeddings.enabled !== 'boolean'
    ) errors.push('ai.embeddings.enabled must be boolean');
    if (!fullKnowledge && (!config.ai.rag?.qdrant?.url || !config.ai.rag?.qdrant?.collection)) {
      errors.push('ai.rag.qdrant url/collection are required');
    }
    finiteInRange(
      config.ai.max_history_messages, 1, 20,
      'ai.max_history_messages', true,
    );
    finiteInRange(
      rawQdrant?.candidate_k, 1, 1000, 'ai.rag.qdrant.candidate_k', true,
    );
    finiteInRange(
      rawQdrant?.max_context_docs, 1, 8,
      'ai.rag.qdrant.max_context_docs', true,
    );
    finiteInRange(
      rawQdrant?.dense_weight, 0, 1, 'ai.rag.qdrant.dense_weight',
    );
    finiteInRange(
      rawQdrant?.dense_context_threshold, 0, 1,
      'ai.rag.qdrant.dense_context_threshold',
    );
    finiteInRange(
      rawQdrant?.lexical_context_threshold, 0, 100,
      'ai.rag.qdrant.lexical_context_threshold',
    );
    finiteInRange(
      rawQdrant?.minimum_query_coverage, 0, 1,
      'ai.rag.qdrant.minimum_query_coverage',
    );
    finiteInRange(
      rawQdrant?.confidence_threshold, 0, 1,
      'ai.rag.qdrant.confidence_threshold',
    );
    finiteInRange(
      rawQdrant?.history_query_messages, 1, 4,
      'ai.rag.qdrant.history_query_messages', true,
    );
    if (
      rawQdrant?.direct_answer_on_llm_error !== undefined &&
      typeof rawQdrant.direct_answer_on_llm_error !== 'boolean'
    ) {
      errors.push('ai.rag.qdrant.direct_answer_on_llm_error must be boolean');
    }
    if (config.ai.mode && !['off', 'rag_only', 'full'].includes(config.ai.mode)) {
      errors.push('ai.mode must be off, rag_only or full');
    }
    finiteInRange(
      config.ai.ai_rollout_percent,
      0,
      100,
      'ai.ai_rollout_percent',
      true,
    );
    finiteInRange(
      config.ai.web_tool_rollout_percent,
      0,
      100,
      'ai.web_tool_rollout_percent',
      true,
    );
    if (
      config.ai.staff_allowlist !== undefined &&
      (!Array.isArray(config.ai.staff_allowlist) ||
        config.ai.staff_allowlist.some(value =>
          !/^\d{1,20}$/.test(String(value)),
        ))
    ) errors.push('ai.staff_allowlist must contain only Telegram numeric IDs');
    const deadlineMs = config.ai.llm?.deadline_ms ?? 30_000;
    finiteInRange(deadlineMs, 1_000, 30_000, 'ai.llm.deadline_ms', true);
    finiteInRange(
      config.ai.llm?.max_attempts,
      1,
      3,
      'ai.llm.max_attempts',
      true,
    );
    finiteInRange(
      config.ai.llm?.max_input_tokens,
      128,
      1_000_000,
      'ai.llm.max_input_tokens',
      true,
    );
    for (const [name, provider] of [
      ['primary', primary],
      ['fallback', fallback],
    ] as const) {
      if (name === 'fallback' && !fallback && (geminiOnly || fullKnowledgeGemini)) continue;
      if (
        provider?.daily_request_limit === undefined &&
        provider?.daily_token_limit === undefined
      ) {
        errors.push(
          `ai.llm.providers.${name} requires daily_request_limit or daily_token_limit`,
        );
      }
      if (provider?.quota_stop_percent === undefined) {
        errors.push(
          `ai.llm.providers.${name}.quota_stop_percent is required and must not exceed 0.8`,
        );
      }
      finiteInRange(
        provider?.timeout_ms,
        100,
        deadlineMs,
        `ai.llm.providers.${name}.timeout_ms`,
        true,
      );
      finiteInRange(
        provider?.daily_request_limit,
        1,
        100_000_000,
        `ai.llm.providers.${name}.daily_request_limit`,
        true,
      );
      finiteInRange(
        provider?.daily_token_limit,
        1,
        10_000_000_000,
        `ai.llm.providers.${name}.daily_token_limit`,
        true,
      );
      finiteInRange(
        provider?.quota_stop_percent,
        0.01,
        0.8,
        `ai.llm.providers.${name}.quota_stop_percent`,
      );
      finiteInRange(
        provider?.circuit_breaker?.failure_threshold,
        1,
        100,
        `ai.llm.providers.${name}.circuit_breaker.failure_threshold`,
        true,
      );
      finiteInRange(
        provider?.circuit_breaker?.failure_window_ms,
        1_000,
        60 * 60 * 1000,
        `ai.llm.providers.${name}.circuit_breaker.failure_window_ms`,
        true,
      );
      finiteInRange(
        provider?.circuit_breaker?.cooldown_ms,
        1_000,
        24 * 60 * 60 * 1000,
        `ai.llm.providers.${name}.circuit_breaker.cooldown_ms`,
        true,
      );
    }
    finiteInRange(
      config.ai.embeddings?.timeout_ms,
      100,
      30_000,
      'ai.embeddings.timeout_ms',
      true,
    );
    finiteInRange(
      config.ai.tools?.verified_docs?.sync_interval_ms,
      5 * 60 * 1000,
      7 * 24 * 60 * 60 * 1000,
      'ai.tools.verified_docs.sync_interval_ms',
      true,
    );
  }
  if (errors.length) throw new Error(`Invalid configuration: ${errors.join('; ')}`);
}

/**
 * Create Bot
 * @return {Bot}
 */
function createBot() {
  if (cache.config.bot_token === 'YOUR_BOT_TOKEN') {
    throw new Error('BOT_TOKEN must be configured through the environment');
  }
  const token = cache.config.bot_token ||
    (process.env.NODE_ENV === 'test' ? '123456:TEST_TOKEN' : '');
  defaultBot = new TelegramAddon(token);
  cache.config.autoreply_confirmation = cache.config.autoreply_confirmation === undefined ? true : cache.config.autoreply_confirmation
  cache.config.language.confirmationMessage = cache.config.language.confirmationMessage || cache.config.language.contactMessage // left for backward compatibility
  cache.config.clean_replies = cache.config.clean_replies === undefined ? false : cache.config.clean_replies // left for backward compatibility
  cache.config.pass_start = cache.config.pass_start === undefined ? false : cache.config.pass_start // left for backward compatibility


  return defaultBot;
}

/**
 * Main function
 * @param {TelegramAddon} bot
 * @param {boolean} logs
 */
function main(
  bot: TelegramAddon = defaultBot,
  logs = true,
): Promise<unknown> | undefined {
  cache.bot = bot;

  // Init error handling
  error.init(logs);

  // Use session and check for permissions on message
  bot.use(bot.initSession());

  bot.use((ctx: Context, next: () => any) => {
    // Check dev mode
    if (cache.config.dev_mode) {
      middleware.reply(
        ctx,
        `_Dev mode is on: You might notice
      some delay in messages, no replies or other errors._`,
        { parse_mode: cache.config.parse_mode },
      );
    }
    return permissions.checkPermissions(ctx, next, cache.config);
  });

  // Init category keys
  const keys = inline.initInline(bot);

  // Set bots username
  // bot..getMe().then((botInfo) => bot.options.username = botInfo.username);

  // Bot commands
  bot.command('panel', (ctx: Context) => panelCommand(ctx));
  bot.command('find', (ctx: Context) => findCommand(ctx));
  bot.command('open', (ctx: Context) => commands.openCommand(ctx));
  bot.command('close', (ctx: Context) => commands.closeCommand(ctx));
  bot.command('ban', (ctx: Context) => commands.banCommand(ctx));
  bot.command('reopen', (ctx: Context) => commands.reopenCommand(ctx));
  bot.command('unban', (ctx: Context) => commands.unbanCommand(ctx));
  bot.command('clear', (ctx: Context) => commands.clearCommand(ctx));
  bot.command('aistats', (ctx: Context) => {
    if (!ctx.session?.admin) {
      return middleware.reply(ctx, 'Недостаточно прав.');
    }
    const requested = Number(String((ctx as any).match || '').trim() || 7);
    if (![1, 7, 30].includes(requested)) {
      return middleware.reply(ctx, 'Использование: /aistats 1, 7 или 30');
    }
    return middleware.reply(
      ctx,
      db.formatPersistentAiStats(requested),
      {parse_mode: 'none'},
    );
  });
  bot.command('aihealth', (ctx: Context) => aiHealthCommand(ctx));
  bot.command('aictl', (ctx: Context) => aiControlCommand(ctx));
  bot.command('ticket', (ctx: Context) => ticketDiagnosticsCommand(ctx));
  bot.command('id', (ctx: Context) =>
    middleware.reply(ctx, `${staffEmoji('ticket')} User ID: <code>${escapeStaffHtml(ctx.from.id, 24)}</code>\n` +
      `Group ID: <code>${escapeStaffHtml(ctx.chat.id, 24)}</code>`, {
      parse_mode: 'HTML', already_formatted: true,
    }),
  );
  bot.command('faq', (ctx: Context) =>
    middleware.reply(ctx, cache.config.language.faqCommandText, {
      parse_mode: cache.config.parse_mode,
    }),
  );
  bot.command('help', (ctx: Context) => commands.helpCommand(ctx));
  bot.command('links', (ctx: Context) => {
    let links = '';
    const subcategories = [];
    for (const i in cache.config.categories) {
      if (i !== undefined) {
        for (const j in cache.config.categories[i].subgroups) {
          if (j !== undefined) {
            const catName = cache.config.categories[i].subgroups[j].name;
            const id = (
              cache.config.categories[i].name +
              cache.config.categories[i].subgroups[j].name
            )
              .replace(/\[|\]|:| |"/g, '')
              .substr(0, 63);
            if (subcategories.indexOf(id) == -1) {
              subcategories.push(id);
              if (bot.botInfo != null) {
                links += `${catName} - https://t.me/${bot.botInfo.username}?start=${id}\n`;
              }
            }
          }
        }
      }
    }
    middleware.reply(ctx, `${cache.config.language.links}:\n${links}`, {
      parse_mode: cache.config.parse_mode,
    });
  });

  if (cache.config.pass_start == false) {
    bot.command('start', (ctx: Context) => {
      if (ctx.chat.type == 'private') {
        middleware.reply(ctx, cache.config.language.startCommandText);
        if (cache.config.categories && cache.config.categories.length > 0) {
          setTimeout(
            () =>
              middleware.reply(
                ctx,
                cache.config.language.services,
                inline.replyKeyboard(keys),
              ),
            500,
          );
        }
      } else middleware.reply(ctx, cache.config.language.prvChatOnly);
    });
  }

  // Bot ons
  bot.on('callback_query', (ctx: Context) => inline.callbackQuery(ctx));
  bot.on([':photo'], (ctx: Context) => files.fileHandler('photo', bot, ctx));
  bot.on([':video'], (ctx: Context) => files.fileHandler('video', bot, ctx));
  bot.on([':document'], (ctx: Context) =>
    files.fileHandler('document', bot, ctx),
  );
  // Handle non-text messages using standard chat handler
  bot.on([':sticker'], (ctx: Context) => {
    if (!ctx.message || !ctx.message.from) {
      return; // Ignore if no message or from field
    }
    if (ctx.chat.type === 'private') {
      return users.chat(ctx, ctx.message.chat);
    } else {
      return staff.chat(ctx);
    }
  });

  // Bot regex
  bot.hears(cache.config.language.back, (ctx: Context) =>
    middleware.reply(
      ctx,
      cache.config.language.services,
      inline.replyKeyboard(keys),
    ),
  );
  bot.hears(/(.+)/, (ctx: Context) => {
    return text.handleText(bot, ctx, keys);
  });

  // Catch bot errors
  bot.catch((err: any, ctx: Context) => {
    logger.error('telegram', 'Update handler failed', {
      errorType: err instanceof Error ? err.name : typeof err,
    });
    // Catch bot blocked by user
    try {
      middleware.reply(ctx, 'Message is not sent due to an error.');
    } catch (e) {
      logger.warn('telegram', 'Could not send generic error message');
    }
  });

  if (logs) {
    const support = cache.config.support || {};
    const runMaintenance = () => {
      const closed = db.closeInactiveAiTickets(
        support.ai_inactivity_close_ms ?? 24 * 60 * 60 * 1000,
      );
      for (const ticketId of closed) {
        ai.clearAiSession(String(ticketId), 'ticket_inactivity_closed');
      }
      db.purgeExpiredMetadata(support.metadata_retention_days ?? 90);
    };
    runMaintenance();
    maintenanceTimer = setInterval(
      runMaintenance,
      support.maintenance_interval_ms ?? 60 * 60 * 1000,
    );
    maintenanceTimer.unref();
    return bot.start();
  }
}

async function bootstrap(): Promise<void> {
  validateConfig(cache.config);
  const bot = createBot();
  configureOperationalAlerts(async (message) => {
    const chatId = cache.config.support?.ops_chat_id ||
      cache.config.staffchat_id;
    const sent = await bot.sendMessage(chatId, message, {parse_mode: undefined});
    if (!sent?.message_id) throw new Error('Operational alert was not delivered');
  });
  startHealthServer();
  ai.setAiShutdownState(false);
  let shutdownPromise: Promise<void> | undefined;
  const shutdown = () => {
    if (shutdownPromise) return shutdownPromise;
    shutdownPromise = shutdownBot(bot);
    return shutdownPromise;
  };
  process.once('SIGINT', () => void shutdown());
  process.once('SIGTERM', () => void shutdown());
  try {
    await bot.init();
    await registerStaffCommands(bot);
    const polling = main(bot);
    setTelegramReady(true);
    void polling?.catch(async () => {
      setTelegramReady(false);
      logger.error('telegram', 'Telegram polling stopped unexpectedly');
      await stopHealthServer().catch(() => undefined);
      process.exitCode = 1;
    });
  } catch (_error) {
    setTelegramReady(false);
    logger.error('telegram', 'Telegram initialization failed');
    await stopHealthServer().catch(() => undefined);
    throw _error;
  }
}

async function shutdownBot(bot: TelegramAddon): Promise<void> {
  setTelegramReady(false);
  // Close the AI admission gate synchronously before stopping polling. This
  // covers updates already queued by grammY as well as new long-poll results.
  ai.setAiShutdownState(true);
  if (maintenanceTimer) clearInterval(maintenanceTimer);
  await bot.stop();
  await ai.waitForActiveAiRuns(15000);
  await stopHealthServer();
}

if (require.main === module) {
  void bootstrap().catch(() => {
    process.exitCode = 1;
  });
}

export {createBot, main, bootstrap, shutdownBot, validateConfig};
