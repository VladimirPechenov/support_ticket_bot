import cache from './cache';
import * as staff from './staff';
import * as users from './users';
import * as middleware from './middleware';
import TelegramAddon from './addons/telegram';
import {Context} from './interfaces';
import {logger} from './logger';

/**
 * Text handler
 * @param {Object} bot
 * @param {Object} ctx
 * @param {Array} keys
 */
function handleText(bot: TelegramAddon, ctx: any, keys: any[]) {
  if (ctx.session.mode == 'private_reply') {
    return staff.privateReply(ctx);
  } else if (
    cache.config.categories &&
    cache.config.categories.length > 0 &&
    !(JSON.stringify(cache.config.categories).indexOf(ctx.message.text) > -1)
  ) {
    if (!ctx.session.admin && cache.config.categories && !ctx.session.group) {
      return middleware.reply(ctx, cache.config.language.services, {
        reply_markup: {
          keyboard: keys,
        },
      });
    } else {
      return ticketHandler(bot, ctx);
    }
  } else {
    return ticketHandler(bot, ctx);
  }
}

/**
 * Decide whether to forward or stop the message.
 * @param {Bot} bot Bot object.
 * @param {Context} ctx Bot context.
 */
function ticketHandler(bot: TelegramAddon, ctx: Context) {
  if (!ctx.message || !ctx.message.from) {
    logger.warn('ticketHandler', 'Message metadata is missing');
    return; // Ignore if no message or from field
  }
  if (ctx.session.admin && ctx.message.reply_to_message) {
    return staff.chat(ctx);
  } else if (ctx.chat.type === 'private') {
    return users.chat(ctx, ctx.message.chat);
  } else {
    return staff.chat(ctx);
  }
}

export {handleText, ticketHandler};
