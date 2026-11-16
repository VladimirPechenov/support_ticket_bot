import { Context } from './interfaces';
import cache from './cache';
import * as middleware from './middleware';
import * as ai from './ai';
import { ensureOpenTicket } from './tickets';
import { logger } from './logger';
import * as db from './db';
import {createStaffTurnCard, updateStaffTurnCard} from './staff-card';

/**
 * Ticket handling and spam protection.
 * @param {context} ctx Bot context.
 * @param {chat} chat Bot chat.
 */
async function chat(ctx: Context, chat: { id: string }) {
  if (!ctx.message || !ctx.message.from) {
    logger.warn('chat', 'Message metadata is missing');
    return;
  }
  if (ai.isAiShutdownInProgress()) return;
  const userTicketID = Math.floor(Number(ctx.message.from.id));  // Convert to integer, remove any .0
  logger.info('chat', 'User message received');

  const ticket = await ensureOpenTicket(userTicketID, ctx.session.groupCategory);
  if (!ticket) {
    logger.error('chat', 'No ticket found or created');
    return;
  }
  if (ai.isAiShutdownInProgress()) return;

  logger.debug('chat', 'Ticket ensured', {ticketId: ticket.id});
  db.updateTicketUser(ticket.id, ctx.message.from);

  // Handle emoji, stickers, and non-text messages
  if (!ctx.message.text) {
    await ai.disableAiForTicket(ticket.id, 'media', {
      stage: 'waiting_operator',
    });
    await middleware.msg(
      ctx.chat.id,
      'Вопрос передан специалисту.',
      {parse_mode: cache.config.parse_mode},
    );
    return;
  }

  const aiHandled = await ai.handleUserMessage(ctx, ticket);
  logger.debug('chat', 'AI handler result', {
    ticketId: ticket.id,
    handled: aiHandled,
  });
  if (aiHandled) {
    return;
  }
  // AI may reject a stale ticket after staff closed/banned it in the
  // ensureOpenTicket -> handleUserMessage gap. Do not emit a fallback message
  // or resurrect ownership for a terminal ticket.
  const currentTicket = db.getTicketByIdSync(ticket.id);
  if (!currentTicket || currentTicket.status !== 'open') return;
  const wasWaiting = currentTicket.stage === 'waiting_operator' ||
    currentTicket.stage === 'in_progress';
  if (!wasWaiting) {
    await ai.disableAiForTicket(currentTicket.id, 'ai_disabled', {
      stage: 'waiting_operator',
    });
    await middleware.msg(
      chat.id,
      'Вопрос передан специалисту.',
      {parse_mode: cache.config.parse_mode},
    );
  }
  db.touchTicket(currentTicket.id);
  db.appendAiConversationMessage(currentTicket.id, 'user', ctx.message.text,
    `telegram-user-${ctx.chat.id}-${ctx.message.message_id}`);
  db.trimAiConversationHistory(currentTicket.id, 40);
  db.recordTicketEvent(currentTicket.id, {
    eventType: 'user_message_received',
    actorType: 'user',
  });
  const card = await createStaffTurnCard(
    ctx,
    currentTicket,
    ctx.message.text.toString(),
    ai.getAiConfig(),
  );
  await updateStaffTurnCard(card, {
    status: currentTicket.stage === 'in_progress' ?
      'in_progress' : 'waiting_operator',
    assigneeName: currentTicket.assignee_name || undefined,
    reason: currentTicket.handoff_reason || 'ai_disabled',
  }, ai.getAiConfig());
}

export { chat };
