import * as ai from './ai';
import cache from './cache';
import * as db from './db';
import * as middleware from './middleware';
import TelegramAddon from './addons/telegram';
import {Context} from './interfaces';
import {buildStaffCardKeyboard} from './staff-card';
import {ensureOpenTicket} from './tickets';
import {logger} from './logger';
import {escapeStaffHtml, staffEmoji, staffHtmlSnippet} from './staff-ui';
import {deliverStaffReply} from './ticket-delivery';

type FileType = 'document' | 'photo' | 'video';

function legacyTicketFromReply(ctx: Context): any {
  const replied = ctx.message?.reply_to_message;
  if (!replied) return undefined;
  const body = replied.text || replied.caption || '';
  const ticketId = body.match(/#T0*(\d+)/)?.[1];
  return ticketId ? db.getTicketByIdSync(ticketId) : undefined;
}

function mappedTicketFromReply(ctx: Context): any {
  const replied = ctx.message?.reply_to_message;
  if (!replied) return undefined;
  return db.getTicketByTelegramMessage(ctx.chat.id, replied.message_id) ||
    legacyTicketFromReply(ctx);
}

async function sendFile(
  bot: TelegramAddon,
  type: FileType,
  receiverId: string | number,
  fileId: string,
  extra: any,
): Promise<any> {
  if (type === 'photo') return bot.sendPhoto(receiverId, fileId, extra);
  if (type === 'video') return bot.sendVideo(receiverId, fileId, extra);
  return bot.sendDocument(receiverId, fileId, extra);
}

async function handleStaffFile(
  type: FileType,
  bot: TelegramAddon,
  ctx: Context,
  fileId: string,
): Promise<void> {
  const ticket = mappedTicketFromReply(ctx);
  if (!ticket) return;
  if (ticket.status !== 'open') {
    await middleware.reply(ctx, cache.config.language.ticketClosedError);
    return;
  }
  const staffId = ctx.from?.id;
  const staffName = ctx.message?.from?.first_name || ctx.from?.username ||
    String(staffId || 'staff');
  await ai.disableAiForTicket(ticket.id, 'staff_file_reply', {
    assigneeId: staffId,
    assigneeName: staffName,
    stage: 'in_progress',
  });
  await deliverStaffReply(ticket.id, () => sendFile(bot, type, ticket.userid, fileId, {
    caption: ctx.message?.caption || undefined,
  }), `file_${type}`);
}

function staffFileCaption(ctx: Context, ticketId: string): string {
  const name = ctx.message?.from?.first_name || 'Пользователь';
  const username = ctx.message?.from?.username ?
    ` @${staffHtmlSnippet(ctx.message.from.username, 70)}` : '';
  const userLabel = cache.config.anonymous_tickets ?
    'Пользователь: анонимно' :
    `<b>Пользователь:</b> ${staffHtmlSnippet(name, 80)}${username}\n` +
    `<b>TG ID:</b> <code>${escapeStaffHtml(ctx.message?.from?.id, 24)}</code>`;
  const caption = String(ctx.message?.caption || '').trim();
  const ticket = db.getTicketByIdSync(ticketId);
  return [
    `${staffEmoji('ticket')} <b>Тикет</b> <code>#T${ticketId.padStart(6, '0')}</code>`,
    `<b>Статус:</b> ${ticket?.stage === 'in_progress' ? '⚡️ В работе' : '❗️ Ждёт оператора'}`,
    ...(ticket?.assignee_name ? [`<b>Ответственный:</b> ${staffHtmlSnippet(ticket.assignee_name, 80)}`] : []),
    userLabel,
    `<b>Сообщение:</b> ${staffHtmlSnippet(caption || 'Вложение без подписи', 350)}`,
  ].join('\n');
}

async function handleUserFile(
  type: FileType,
  bot: TelegramAddon,
  ctx: Context,
  fileId: string,
): Promise<void> {
  const ticket = await ensureOpenTicket(
    ctx.message.from.id,
    ctx.session.groupCategory,
  );
  if (!ticket) return;
  db.updateTicketUser(ticket.id, ctx.message.from);
  await ai.disableAiForTicket(ticket.id, 'media', {
    stage: ticket.stage === 'in_progress' ? 'in_progress' : 'waiting_operator',
  });
  const currentTicket = db.getTicketByIdSync(ticket.id);
  if (!currentTicket || currentTicket.status !== 'open') return;
  const attachmentLabel = {photo: 'Фото', video: 'Видео', document: 'Файл'}[type];
  db.appendAiConversationMessage(ticket.id, 'user',
    `${attachmentLabel}${ctx.message.caption ? `: ${ctx.message.caption}` : ' без подписи'}`,
    `media:${ctx.chat.id}:${ctx.message.message_id}`);
  db.trimAiConversationHistory(ticket.id, 40);
  db.touchTicket(ticket.id);
  db.recordTicketEvent(ticket.id, {
    eventType: 'user_message_received',
    actorType: 'user',
    reason: `file_${type}`,
  });
  const sent = await sendFile(
    bot,
    type,
    cache.config.staffchat_id,
    fileId,
    {
      caption: staffFileCaption(ctx, String(ticket.id)),
      parse_mode: 'HTML',
      ...buildStaffCardKeyboard(String(ticket.id), ai.getAiConfig(), {
        status: currentTicket.stage === 'in_progress' ? 'in_progress' : 'waiting_operator',
        assigneeName: currentTicket.assignee_name || undefined,
      }, undefined, ticket.userid),
    },
  );
  if (sent?.message_id) {
    db.mapTelegramMessage(
      cache.config.staffchat_id,
      sent.message_id,
      ticket.id,
      `staff_${type}`,
    );
    await middleware.msg(ctx.chat.id, '📎 Вложение передано специалисту.',
      {parse_mode: 'none', already_formatted: true});
  } else {
    throw new Error('Attachment was not delivered');
  }
}

async function fileHandler(
  type: FileType,
  bot: TelegramAddon,
  ctx: Context,
): Promise<void> {
  if (!ctx.message?.from) return;
  if (ai.isAiShutdownInProgress()) return;
  try {
    const fileId = type === 'photo' ? ctx.message.photo?.at(-1)?.file_id :
      ctx.message[type]?.file_id;
    if (!fileId) throw new Error('Attachment file ID is missing');
    const staffReply = ctx.session.admin && (ctx.chat.type !== 'private' ||
      !!mappedTicketFromReply(ctx));
    if (staffReply) {
      await handleStaffFile(type, bot, ctx, fileId);
      return;
    }
    if (ctx.chat.type !== 'private') return;
    await handleUserFile(type, bot, ctx, fileId);
  } catch (_error) {
    logger.error('fileHandler', 'File delivery failed', {
      fileType: type, errorType: _error instanceof Error ? _error.name : typeof _error,
    });
    await middleware.msg(
      ctx.chat.id,
      'Не удалось передать файл. Попробуйте ещё раз или отправьте текст.',
      {parse_mode: 'none', already_formatted: true},
    );
  }
}

export {fileHandler, staffFileCaption};
