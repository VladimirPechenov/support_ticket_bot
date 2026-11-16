import * as db from './db';
import cache from './cache';
import * as middleware from './middleware';
import { Context } from './interfaces';
import * as ai from './ai';
import {queueCommand} from './staff-panel';

function ticketFromReply(ctx: Context): any {
  const replied = ctx.message?.reply_to_message;
  if (!replied?.from?.is_bot) return undefined;
  const mapped = db.getTicketByTelegramMessage(ctx.chat.id, replied.message_id);
  if (mapped) return mapped;
  const text = replied.text || replied.caption || '';
  const ticketId = text.match(/#T0*(\d+)/)?.[1];
  return ticketId ? db.getTicketByIdSync(ticketId) : undefined;
}

/**
 * Display help depending on the group
 * @param {Object} ctx
 */
function helpCommand(ctx: Context) {
  if (!ctx.session.admin) {
    middleware.reply(ctx, cache.config.language.helpCommandText, {
      parse_mode: cache.config.parse_mode,
    });
  } else {
    middleware.reply(ctx, cache.config.language.helpCommandStaffText, {
      parse_mode: cache.config.parse_mode,
    });
  }
}

/**
 * Close all open tickets
 * @param {Object} ctx
 */
function clearCommand(ctx: Context) {
  if (!ctx.session.admin) return;
  const activeAiTicketIds = Object.keys(cache.aiSessions || {});
  db.closeAll();
  for (const ticketId of activeAiTicketIds) {
    ai.clearAiSession(ticketId, 'tickets_cleared');
  }
  middleware.reply(
    ctx,
    '❌ Все вопросы закрыты.',
    { parse_mode: cache.config.parse_mode }, /* .notifications(false) */
  );
}

/**
 * Display open tickets
 * @param {Object} ctx
 */
function openCommand(ctx: Context) {
  return queueCommand(ctx);
}

/**
 * Close ticket
 * @param {Object} ctx
 */
function closeCommand(ctx: Context) {
  if (!ctx.session.admin) return;
  const ticket = ticketFromReply(ctx);
  if (!ticket || !db.closeTicketById(ticket.id, 'staff_command')) {
    middleware.reply(ctx, cache.config.language.ticketClosedError);
    return;
  }
  ai.clearAiSession(String(ticket.id), 'ticket_closed');
  middleware.reply(
    ctx,
    `${cache.config.language.ticket} #T${String(ticket.id).padStart(6, '0')} ` +
      cache.config.language.closed,
    {parse_mode: cache.config.parse_mode},
  );
  middleware.msg(
    ticket.userid,
    cache.config.language.ticketClosed,
    {parse_mode: cache.config.parse_mode},
  );
}

/**
 * Ban user
 * @param {Object} ctx
 */
function banCommand(ctx: Context) {
  if (!ctx.session.admin) return;
  const ticket = ticketFromReply(ctx);
  if (!ticket) return;
  db.add(ticket.userid, 'banned', '');
  ai.clearAiSession(String(ticket.id), 'ticket_banned');
  middleware.msg(
    ctx.chat.id,
    `${cache.config.language.usr_with_ticket} ` +
      `#T${String(ticket.id).padStart(6, '0')} ` +
      cache.config.language.banned,
    {parse_mode: cache.config.parse_mode},
  );
}

/**
 * Reopen ticket
 * @param {Object} ctx
 */
function reopenCommand(ctx: Context) {
  if (!ctx.session.admin) return;
  const ticket = ticketFromReply(ctx);
  if (!ticket) return;
  db.reopen(ticket.userid, ticket.category);
  middleware.msg(
    ctx.chat.id,
    `${cache.config.language.usr_with_ticket} ` +
      `#T${String(ticket.id).padStart(6, '0')} ` +
      cache.config.language.ticketReopened,
    {parse_mode: cache.config.parse_mode},
  );
}

/**
 * Unban user
 * @param {Object} ctx
 */
function unbanCommand(ctx: Context) {
  if (!ctx.session.admin) return;
  const ticket = ticketFromReply(ctx);
  if (!ticket) return;
  db.unblockUser(ticket.userid);
  middleware.msg(
    ctx.chat.id,
    `${cache.config.language.usr_with_ticket} ` +
      `#T${String(ticket.id).padStart(6, '0')} разблокирован`,
    {parse_mode: cache.config.parse_mode},
  );
}

export {
  banCommand,
  openCommand,
  closeCommand,
  unbanCommand,
  clearCommand,
  reopenCommand,
  helpCommand,
};
