import cache from './cache';
import { Context } from './interfaces';
import {recordDependencyStatus} from './operational-alerts';
import {logger} from './logger';
import {telegramErrorMetadata} from './telegram-errors';

// strict escape
const strictEscape = function (str: string | any[]) {
  if (cache.config.parse_mode == 'MarkdownV2') {
    let newStr = '';
    const chars = ['[', ']', '(', ')', '_', '*', '~', '`', '@'];
    for (let i = 0; i < str.length; i++) {
      // escape special characters
      if (chars.includes(str[i])) {
        newStr += '\\' + str[i];
      } else {
        newStr += str[i];
      }
    }
    return newStr;
  } else {
    return str.toString();
  }
};

// escape special characters
const escapeText = function (str: string | string[]) {
  if (!str) return '';

  const parseMode = (cache.config.parse_mode || 'none').toLowerCase();

  // If parse_mode is 'none', don't escape anything - return as is
  if (parseMode === 'none') {
    return str.toString();
  }

  if (parseMode === 'html') {
    return str
      .toString()
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  } else if (parseMode === 'markdownv2') {
    // '[', ']', '(', ')', are skipped as they are usually for urls
    // '_', '*', '~', '`', are used for actual markdown
    const chars = ['\\', '_', '*', '[', ']', '(', ')', '~', '`', '>', '#', '+', '-', '=', '|', '{', '}', '.', '!', '@'];
    let newStr = '';
    for (let i = 0; i < str.length; i++) {
      if (chars.includes(str[i])) {
        newStr += '\\' + str[i];
      } else {
        newStr += str[i];
      }
    }
    return newStr;
  }

  if (str == undefined) {
    return '';
  }
  return str.toString();
};

const msg = async function (
  id: string | number,
  msgText: string | string[],
  extra: any = {},
  throwOnError = false,
): Promise<any> {
  // Validate parameters
  if (!id) {
    logger.error('middleware.msg', 'Target chat is missing');
    return null;
  }

  // Merge defaults with provided extra
  const finalExtra: any = {
    ...extra  // Extra params override defaults
  };
  const alreadyFormatted = finalExtra.already_formatted === true;
  delete finalExtra.already_formatted;

  // Get parse_mode from extra or use default
  let parseMode = extra.parse_mode || cache.config.parse_mode || 'none';
  parseMode = parseMode.toLowerCase();

  // Only set parse_mode if it's not 'none' - Telegram shouldn't receive parse_mode='none'
  if (parseMode !== 'none') {
    finalExtra.parse_mode = extra.parse_mode || cache.config.parse_mode;
  } else {
    // Remove parse_mode if it was set to 'none'
    delete finalExtra.parse_mode;
  }

  msgText = alreadyFormatted ? msgText.toString() : escapeText(msgText);
  msgText = msgText.replace(/ {2}/g, '');
  try {
    const result = await cache.bot.sendMessage(id, msgText, finalExtra);
    void recordDependencyStatus('telegram', true);
    return result;
  } catch (_error) {
    void recordDependencyStatus('telegram', false);
    logger.error('middleware.msg', 'Telegram send failed',
      telegramErrorMetadata(_error));
    if (throwOnError) throw _error;
    return null;
  }
};

const reply = function (ctx: Context, msgtext: string | string[], extra: any = {}) {
  // Merge defaults with provided extra
  const finalExtra = {
    ...extra  // Extra params override defaults
  };
  // Don't set parse_mode if not provided in extra - let msg handle default
  if (!Object.prototype.hasOwnProperty.call(extra, 'parse_mode')) {
    finalExtra.parse_mode = cache.config.parse_mode;
  }
  return msg(ctx.message.chat.id, msgtext, finalExtra);
};

/**
 * Send message and return promise with message_id
 * @param {string|number} id Chat ID
 * @param {string|string[]} msgText Message text
 * @param {any} extra Extra options
 * @return {Promise<number>} Promise resolving to message_id
 */
const msgWithId = async function (id: string | number, msgText: string | string[], extra: any = {}): Promise<number | null> {
  // Merge defaults with provided extra
  const finalExtra: any = {
    ...extra  // Extra params override defaults
  };
  const alreadyFormatted = finalExtra.already_formatted === true;
  delete finalExtra.already_formatted;

  // Get parse_mode from extra or use default
  let parseMode = extra.parse_mode || cache.config.parse_mode || 'none';
  parseMode = parseMode.toLowerCase();

  // Only set parse_mode if it's not 'none'
  if (parseMode !== 'none') {
    finalExtra.parse_mode = extra.parse_mode || cache.config.parse_mode;
  } else {
    delete finalExtra.parse_mode;
  }

  msgText = alreadyFormatted ? msgText.toString() : escapeText(msgText);

  msgText = msgText.replace(/ {2}/g, '');
  try {
    const result = await cache.bot.api.sendMessage(id, msgText, finalExtra);
    void recordDependencyStatus('telegram', true);
    return result.message_id;
  } catch (err) {
    void recordDependencyStatus('telegram', false);
    logger.error('middleware.msgWithId', 'Telegram send failed',
      telegramErrorMetadata(err));
    return null;
  }
};

export { strictEscape, escapeText, msg, reply, msgWithId };
