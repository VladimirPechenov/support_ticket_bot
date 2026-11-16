import cache from './cache';
import * as middleware from './middleware';
import * as db from './db';
import { Context } from './interfaces';
import * as ai from './ai';
import { logger } from './logger';
import {deliverStaffReply} from './ticket-delivery';

/** Message template helper
 * @param {String} name
 * @param {Object} message
 * @param {Boolean} anon
 * @return {String} text
 */
function ticketMsg(
  name: string,
  message: { text: any; from: { first_name: any } },
) {
  const esc: any = middleware.strictEscape;
  if (cache.config.clean_replies) {
    return esc(message.text)
  }
  if (cache.config.anonymous_replies) {
    return (
      `${cache.config.language.dear} ` +
      `${esc(name)},\n\n` +
      `${esc(message.text)}\n\n` +
      `${cache.config.language.regards}\n` +
      `${cache.config.language.regardsGroup}`
    );
  }
  return (
    `${cache.config.language.dear} ` +
    `${esc(name)},\n\n` +
    `${esc(message.text)}\n\n` +
    `${cache.config.language.regards}\n` +
    `${esc(message.from.first_name)}`
  );
}

/**
 * Forward message to staff group based on @ mention
 * @param {Context} ctx Bot context.
 * @return {boolean} True if message was forwarded
 */
function forwardToStaffGroup(ctx: Context): boolean {
  if (!ctx.message || !ctx.message.text) {
    return false;
  }

  const messageText = ctx.message.text;
  // Look for @groupname pattern at the beginning of message
  const atMatch = messageText.match(/^@(\S+)\s+(.*)/);

  if (!atMatch) {
    return false;
  }

  const groupName = atMatch[1];
  const messageToForward = atMatch[2] || messageText;

  // Find matching category/group
  if (!cache.config.categories) {
    return false;
  }

  for (const category of cache.config.categories) {
    // Check category name match
    if (category.name.toLowerCase().replace(/\s+/g, '') === groupName.toLowerCase()) {
      if (category.group_id) {
        // Send to category group
        middleware.msg(
          category.group_id,
          messageToForward,
          { parse_mode: cache.config.parse_mode },
        );
        logger.info('forwardToStaffGroup', `Message forwarded to group`, {
          groupName,
          staffId: ctx.from?.id,
        });
        // Confirm forward
        middleware.msg(
          ctx.chat.id,
          `✓ Сообщение переправлено в группу ${category.name}`,
          { parse_mode: cache.config.parse_mode },
        );
        return true;
      }
    }

    // Check subgroups
    if (category.subgroups) {
      for (const subgroup of category.subgroups) {
        const fullName = `${category.name}${subgroup.name}`.toLowerCase().replace(/\s+/g, '');
        const shortName = subgroup.name.toLowerCase().replace(/\s+/g, '');

        if (fullName === groupName.toLowerCase() || shortName === groupName.toLowerCase()) {
          if (subgroup.group_id) {
            // Send to subgroup
            middleware.msg(
              subgroup.group_id,
              messageToForward,
              { parse_mode: cache.config.parse_mode },
            );
            logger.info('forwardToStaffGroup', `Message forwarded to subgroup`, {
              groupName,
              staffId: ctx.from?.id,
            });
            // Confirm forward
            middleware.msg(
              ctx.chat.id,
              `✓ Сообщение переправлено в ${category.name} → ${subgroup.name}`,
              { parse_mode: cache.config.parse_mode },
            );
            return true;
          }
        }
      }
    }
  }

  return false;
}

/**
 * Private chat
 * @param {Object} ctx
 * @param {Object} msg
 */
async function privateReply(ctx: Context, msg: any = ctx.message) {
  const staffId = ctx.from?.id || 'unknown';
  const userId = ctx.session.modeData.userid;
  const ticketId = ctx.session.modeData.ticketid;

  logger.info('privateReply', `Staff private reply`, { staffId, userId, ticketId });

  const ticket = db.getTicketByIdSync(ticketId);
  if (!ticket || ticket.status !== 'open') {
    await middleware.reply(ctx, cache.config.language.ticketClosedError);
    return;
  }
  await ai.disableAiForTicket(ticketId, 'staff_private_reply');
  // Msg to other end
  const delivered = await deliverStaffReply(ticketId, () => middleware.msg(
    ticket.userid,
    ticketMsg(` ${ctx.session.modeData.name}`, msg),
    {
      parse_mode: cache.config.parse_mode,
      reply_markup: {
        inline_keyboard: [
          [
            cache.config.direct_reply ?
              {
                text: cache.config.language.replyPrivate,
                url: `https://t.me/${ctx.from.username}`,
              } :
              {
                text: cache.config.language.replyPrivate,
                callback_data:
                  ctx.from.id +
                  '---' +
                  ctx.message.from.first_name +
                  '---' +
                  ctx.session.modeData.category +
                  '---' +
                  ctx.session.modeData.ticketid,
              },
          ],
        ],
      },
    },
    true,
  ), 'private_reply');
  if (!delivered) {
    await middleware.reply(ctx, `⚠️ Ответ по тикету №${ticketId} не отправлен. Проверьте доставку.`,
      {parse_mode: 'none'});
    return;
  }
  if (msg.text) {
    db.appendAiConversationMessage(ticketId, 'assistant', msg.text,
      `staff:${ctx.chat.id}:${ctx.message.message_id}`);
    db.trimAiConversationHistory(ticketId, 40);
  }
  // Confirmation message
  logger.debug('privateReply', `Message sent to user`, { userId });
  await middleware.msg(ctx.chat.id, cache.config.language.msg_sent, {});
}

/**
 * Reply to tickets in staff chat.
 * @param {Context} ctx Bot context.
 */
async function chat(ctx: Context) {
  const staffId = ctx.from?.id || 'unknown';
  logger.debug('staff.chat', 'Staff message received');

  if (!ctx.session.admin) {
    logger.warn('staff.chat', 'Non-admin user attempted to reply');
    return;
  }

  if (forwardToStaffGroup(ctx)) {
    return;
  }

  try {
    if (!ctx.message?.reply_to_message) {
      logger.debug('staff.chat', 'No reply target found');
      return;
    }
    const repliedMessageId = ctx.message.reply_to_message.message_id;
    let ticket = repliedMessageId ?
      db.getTicketByTelegramMessage(ctx.chat.id, repliedMessageId) :
      undefined;
    const replyText =
      ctx.message.reply_to_message.text ||
      ctx.message.reply_to_message.caption ||
      '';

    // Compatibility for staff cards created before telegram_message_map.
    if (!ticket) {
      const legacyTicketId = replyText.match(/#T0*(\d+)/)?.[1];
      if (legacyTicketId) ticket = db.getTicketByIdSync(legacyTicketId);
    }
    if (!ticket) {
      logger.warn('staff.chat', 'Reply target is not mapped to a ticket');
      await middleware.reply(ctx,
        '⚠️ Не удалось определить тикет. Отправьте ответ в ответ на карточку тикета.',
        {parse_mode: 'none'});
      return;
    }
    if (ticket.status !== 'open') {
      await middleware.reply(ctx, cache.config.language.ticketClosedError);
      return;
    }

    logger.info('staff.chat', 'Staff reply to ticket', {
      ticketId: ticket.id,
    });
    await ai.disableAiForTicket(ticket.id, 'staff_reply', {
      assigneeId: staffId,
      assigneeName:
        ctx.message.from.first_name || ctx.from?.username || String(staffId),
    });
    const delivered = await deliverStaffReply(ticket.id, () => middleware.msg(
      ticket.userid,
      ticketMsg('пользователь', ctx.message),
      {parse_mode: cache.config.parse_mode},
      true,
    ));
    if (!delivered) return;
    if (ctx.message.text) {
      db.appendAiConversationMessage(ticket.id, 'assistant', ctx.message.text,
        `staff:${ctx.chat.id}:${ctx.message.message_id}`);
      db.trimAiConversationHistory(ticket.id, 40);
    }
    cache.ticketSent[ticket.userid] = null;
    if (cache.config.auto_close_tickets) {
      db.closeTicketById(ticket.id, 'staff_reply_auto_close');
      ai.clearAiSession(String(ticket.id), 'ticket_auto_closed');
    }
  } catch (_error) {
    logger.error('staff.chat', 'Failed to deliver staff reply');
    await middleware.msg(
      cache.config.staffchat_id,
      'Не удалось отправить ответ пользователю. Проверьте логи бота.',
      {parse_mode: cache.config.parse_mode},
    );
  }
}

export { privateReply, chat };
