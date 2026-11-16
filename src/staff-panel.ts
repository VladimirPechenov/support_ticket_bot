import cache from './cache';
import {Context} from './interfaces';
import * as db from './db';
import * as middleware from './middleware';
import {
  buildStaffCardKeyboard, renderStaffTurnCard, StaffCardResult, StaffTurnCard,
} from './staff-card';
import {escapeStaffHtml as html, staffButton as button, staffEmoji as emoji, staffHtmlSnippet} from './staff-ui';
import {logger} from './logger';
import {randomBytes} from 'crypto';
import {clearAiSession} from './ai';

type QueueFilter = 'all' | 'waiting' | 'mine';

const closeConfirmations = new Map<string, {
  actorId: string; chatId: string; ticketIds: string[]; expiresAt: number;
}>();

function actorId(ctx: Context): string {
  return String(ctx.callbackQuery?.from?.id || ctx.from?.id || ctx.message?.from?.id || '');
}

function isOwner(ctx: Context): boolean {
  return [cache.config.owner_id, ...(cache.config.owner_ids || [])]
    .some(id => id != null && String(id) === actorId(ctx));
}

export function canUseStaffPanel(ctx: Context): boolean {
  return !!ctx.session?.admin || (isOwner(ctx) &&
    (ctx.chat?.type === 'private' || String(ctx.chat?.id) === String(cache.config.staffchat_id)));
}

export function staffCategories(ctx: Context): string[] | undefined {
  if (isOwner(ctx) || String(ctx.chat?.id) === String(cache.config.staffchat_id)) {
    return undefined;
  }
  const categories: string[] = [];
  for (const category of cache.config.categories || []) {
    if (!category.subgroups?.length && String(category.group_id) === String(ctx.chat?.id)) {
      categories.push(category.name);
    }
    for (const subgroup of category.subgroups || []) {
      if (String(subgroup.group_id) === String(ctx.chat?.id)) categories.push(subgroup.name);
    }
  }
  return categories;
}

export function canAccessStaffTicket(ctx: Context, ticket: any): boolean {
  if (!canUseStaffPanel(ctx) || !ticket) return false;
  const categories = staffCategories(ctx);
  return categories === undefined || categories.includes(ticket.category);
}

async function acknowledge(ctx: Context, text?: string): Promise<void> {
  if (ctx.callbackQuery && typeof ctx.answerCallbackQuery === 'function') {
    await ctx.answerCallbackQuery(text ? {text, show_alert: true} : {});
  }
}

async function show(
  ctx: Context, text: string, keyboard: any[][] = [], edit = false,
): Promise<void> {
  const options = {parse_mode: 'HTML', reply_markup: {inline_keyboard: keyboard}};
  if (edit && typeof (ctx as any).editMessageText === 'function') {
    try {
      await (ctx as any).editMessageText(text, options);
    } catch (error) {
      if (!/message is not modified/i.test(String((error as any)?.description || error))) throw error;
    }
    return;
  }
  await middleware.msg(ctx.chat.id, text, {...options, already_formatted: true});
}

function backRow() {
  return [button('back', 'В меню', {callback_data: 'STAFF_HOME'})];
}

async function showHome(ctx: Context, edit = false): Promise<void> {
  const counts = db.getStaffTicketCounts(staffCategories(ctx), actorId(ctx));
  await show(ctx, [
    `${emoji('menu')} <b>Панель оператора</b>`,
    '',
    `${emoji('waiting')} Ждут оператора: <b>${counts.waiting}</b>`,
    `${emoji('take')} Мои тикеты: <b>${counts.mine}</b>`,
    `${emoji('folder')} Все открытые: <b>${counts.all}</b>`,
    '',
    'Выберите раздел. Счётчики обновляются при открытии меню.',
  ].join('\n'), [
    [button('waiting', `Ждут оператора · ${counts.waiting}`,
      {callback_data: 'STAFF_QUEUE---waiting---0'})],
    [button('take', `Мои тикеты · ${counts.mine}`, {callback_data: 'STAFF_QUEUE---mine---0'}),
      button('folder', `Все открытые · ${counts.all}`, {callback_data: 'STAFF_QUEUE---all---0'})],
    [button('search', 'Поиск', {callback_data: 'STAFF_SEARCH'}),
      button('list', 'Шаблоны ответов', {callback_data: 'STAFF_TEMPLATES'})],
    [button('settings', 'Статистика', {callback_data: 'STAFF_STATS'}),
      button('field', 'Как отвечать', {callback_data: 'STAFF_HELP'})],
    [button('menu', 'Обновить', {callback_data: 'STAFF_HOME'})],
    [button('close', 'Закрыть все вопросы', {callback_data: 'STAFF_CLOSE_ALL'}, 'danger')],
  ], edit);
}

function ticketLabel(ticket: any): string {
  return `#T${String(ticket.id).padStart(6, '0')}`;
}

function elapsed(timestamp: number): string {
  const minutes = Math.max(0, Math.floor((Date.now() - timestamp) / 60000));
  if (minutes < 60) return `${minutes} мин`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)} ч ${minutes % 60} мин`;
  return `${Math.floor(minutes / 1440)} дн`;
}

function queueLine(ticket: any): string {
  const status = ticket.status === 'closed' ? 'Закрыт' :
    ticket.stage === 'waiting_operator' ? 'Ждёт оператора' :
    ticket.stage === 'in_progress' ? 'В работе' : 'AI активен';
  const mark = ticket.status === 'closed' ? 'close' :
    ticket.stage === 'waiting_operator' ? 'waiting' :
    ticket.stage === 'in_progress' ? 'take' : 'field';
  const user = cache.config.anonymous_tickets ? 'Анонимный пользователь' :
    (ticket.user_name || (ticket.user_username ? `@${ticket.user_username}` : 'Пользователь'));
  const wait = ticket.stage === 'waiting_operator' ?
    ` · ${elapsed(ticket.waiting_since || ticket.created_at)}` : '';
  return `${emoji(mark)} <code>${ticketLabel(ticket)}</code> · ${status}${wait}\n` +
    `${staffHtmlSnippet(user, 100)}${ticket.assignee_name ? ` · Оператор: ${staffHtmlSnippet(ticket.assignee_name, 80)}` : ''}\n` +
    staffHtmlSnippet(String(ticket.question || 'Сообщение без текста').replace(/\s+/g, ' '), 200);
}

async function showQueue(ctx: Context, filter: QueueFilter, page = 0, edit = false): Promise<void> {
  const queue = db.getStaffQueue(staffCategories(ctx), filter, actorId(ctx), page);
  const heading = filter === 'waiting' ? 'Ждут оператора' :
    filter === 'mine' ? 'Мои тикеты' : (cache.config.language.openTickets || 'Открытые тикеты');
  const rows = queue.tickets.map(ticket => [
    button('ticket', `${ticketLabel(ticket)} · Открыть`,
      {callback_data: `STAFF_TICKET---${ticket.id}`}),
  ]);
  const navigation = [];
  if (queue.page > 0) navigation.push(button('back', 'Назад',
    {callback_data: `STAFF_QUEUE---${filter}---${queue.page - 1}`}));
  navigation.push(button('list', 'Обновить',
    {callback_data: `STAFF_QUEUE---${filter}---${queue.page}`}));
  if (queue.page + 1 < queue.pages) navigation.push(button('folder', 'Далее',
    {callback_data: `STAFF_QUEUE---${filter}---${queue.page + 1}`}));
  rows.push(navigation, backRow());
  await show(ctx, [
    `${emoji('list')} <b>${html(heading, 100)}</b> · ${queue.total}`,
    `Страница ${queue.page + 1} из ${queue.pages}`,
    filter === 'waiting' ? 'Сначала самые долгие ожидания.' : 'Сначала ожидающие оператора, затем обращения в работе.',
    '',
    queue.tickets.length ? queue.tickets.map(queueLine).join('\n\n') : 'Тикетов пока нет.',
  ].join('\n'), rows, edit);
}

export async function showStaffTicket(ctx: Context, ticket: any): Promise<void> {
  if (!canAccessStaffTicket(ctx, ticket)) return;
  const history = db.getAiConversationHistory(ticket.id, 12);
  const diagnostics = db.getLatestAiRunDiagnosticsForTicket(ticket.id);
  const latestAnswer = [...history].reverse().find(message => message.role === 'assistant');
  const card: StaffTurnCard = {
    chatId: ctx.chat.id, messageId: 0, ticketId: String(ticket.id),
    createdAt: ticket.created_at, waitingSince: ticket.waiting_since,
    runId: diagnostics?.run.runId,
    question: ticket.question || 'Сообщение без текста',
    user: {id: ticket.userid, firstName: ticket.user_name || 'Пользователь',
      username: ticket.user_username || undefined},
  };
  const result: StaffCardResult = {
    status: ticket.status === 'closed' ? 'closed' : ticket.stage === 'in_progress' ?
      'in_progress' : ticket.stage === 'waiting_operator' ? 'waiting_operator' : 'ai_active',
    assigneeName: ticket.assignee_name || undefined,
    reason: (ticket.status === 'closed' ? ticket.close_reason : ticket.handoff_reason) || undefined,
    answer: latestAnswer?.content,
  };
  const messageId = await middleware.msgWithId(ctx.chat.id, renderStaffTurnCard(card, result), {
    parse_mode: 'HTML', already_formatted: true,
    ...buildStaffCardKeyboard(card.ticketId, cache.config.ai || null,
      result, card.runId, ticket.userid),
  });
  if (messageId) db.mapTelegramMessage(ctx.chat.id, messageId, ticket.id, 'staff_panel_card');
}

export async function panelCommand(ctx: Context): Promise<void> {
  if (!canUseStaffPanel(ctx)) return show(ctx, '🚫 Недостаточно прав.');
  await showHome(ctx);
}

export async function queueCommand(ctx: Context): Promise<void> {
  if (!canUseStaffPanel(ctx)) return;
  await showQueue(ctx, 'all');
}

export async function findCommand(ctx: Context): Promise<void> {
  if (!canUseStaffPanel(ctx)) return show(ctx, '🚫 Недостаточно прав.');
  const query = String((ctx as any).match || '').trim();
  const userMatch = query.match(/^tg\s+(\d{1,20})$/i);
  const ticketMatch = query.match(/^#?T?0*(\d{1,15})$/i);
  if ((!userMatch && !ticketMatch) || (userMatch && cache.config.anonymous_tickets)) {
    await show(ctx, `${emoji('search')} <b>Поиск обращения</b>\n\n` +
      'По номеру: <code>/find T000142</code>\n' +
      (cache.config.anonymous_tickets ? '' : 'По Telegram ID: <code>/find tg 123456789</code>\n') +
      '\nПоиск включает закрытые тикеты.', [backRow()]);
    return;
  }
  const tickets = db.searchStaffTickets(staffCategories(ctx),
    userMatch ? userMatch[1] : ticketMatch![1], !!userMatch);
  await show(ctx, `${emoji('search')} <b>Результаты поиска</b>\n\n` +
    (tickets.length ? tickets.map(queueLine).join('\n\n') : 'Тикеты не найдены.'), [
    ...tickets.map(ticket => [button('ticket', `${ticketLabel(ticket)} · Открыть`,
      {callback_data: `STAFF_TICKET---${ticket.id}`})]), backRow(),
  ]);
}

export async function handleStaffPanelCallback(ctx: Context): Promise<boolean> {
  const [action, id, page] = String(ctx.callbackQuery?.data || '').split('---');
  if (!action.startsWith('STAFF_')) return false;
  if (!canUseStaffPanel(ctx)) {
    await acknowledge(ctx, 'Недостаточно прав');
    return true;
  }
  if (action === 'STAFF_CLOSE_ALL') {
    await acknowledge(ctx);
    const tickets = db.getOpenStaffTickets(staffCategories(ctx));
    for (const [token, confirmation] of closeConfirmations) {
      if (confirmation.expiresAt < Date.now()) closeConfirmations.delete(token);
    }
    if (!tickets.length) {
      await show(ctx, `${emoji('done')} Все вопросы уже закрыты.`, [backRow()], true);
      return true;
    }
    const token = randomBytes(8).toString('hex');
    closeConfirmations.set(token, {
      actorId: actorId(ctx), chatId: String(ctx.chat.id),
      ticketIds: tickets.map(ticket => String(ticket.id)),
      expiresAt: Date.now() + 2 * 60 * 1000,
    });
    if (closeConfirmations.size > 1000) {
      closeConfirmations.delete(closeConfirmations.keys().next().value);
    }
    await show(ctx, `${emoji('close')} <b>Закрыть все вопросы?</b>\n\n` +
      `Будет закрыто вопросов: <b>${tickets.length}</b>.\n` +
      (staffCategories(ctx) === undefined ? 'Все открытые обращения поддержки.' :
        'Только обращения категорий этой группы.') +
      '\nПользователи получат уведомление. Новые обращения после этого подтверждения останутся открытыми.', [
      [button('close', `Закрыть ${tickets.length} вопросов`,
        {callback_data: `STAFF_CLOSE_CONFIRM---${token}`}, 'danger')],
      [button('back', 'Отмена', {callback_data: 'STAFF_HOME'})],
    ], true);
    return true;
  }
  if (action === 'STAFF_CLOSE_CONFIRM') {
    const confirmation = closeConfirmations.get(id);
    if (!confirmation || confirmation.expiresAt < Date.now()) {
      if (confirmation) closeConfirmations.delete(id);
      await acknowledge(ctx, 'Подтверждение устарело. Откройте панель заново.');
      return true;
    }
    if (confirmation.actorId !== actorId(ctx) || confirmation.chatId !== String(ctx.chat.id)) {
      await acknowledge(ctx, 'Подтверждение доступно оператору, который его открыл.');
      return true;
    }
    closeConfirmations.delete(id);
    const ticketIds = confirmation.ticketIds.filter(ticketId =>
      canAccessStaffTicket(ctx, db.getTicketByIdSync(ticketId)),
    );
    const closed = db.closeStaffTicketBatch(ticketIds);
    // Invalidate all active AI owners before awaiting any Telegram requests.
    for (const ticket of closed) clearAiSession(String(ticket.id), 'tickets_cleared');
    await acknowledge(ctx);
    await show(ctx, `${emoji('done')} Закрыто вопросов: <b>${closed.length}</b>.`, [backRow()], true);
    for (const ticket of closed) {
      await middleware.msg(ticket.userid, cache.config.language.ticketClosed,
        {parse_mode: cache.config.parse_mode});
    }
    return true;
  }
  if (action === 'STAFF_TICKET' || action === 'STAFF_HISTORY') {
    const ticket = /^\d{1,15}$/.test(id || '') ? db.getStaffTicket(id) : undefined;
    if (!canAccessStaffTicket(ctx, ticket)) {
      await acknowledge(ctx, 'Тикет недоступен');
      return true;
    }
    await acknowledge(ctx);
    if (action === 'STAFF_TICKET') await showStaffTicket(ctx, ticket);
    else {
      const history = db.getAiConversationHistory(id, 12);
      // Bounded escaped HTML keeps even hostile inputs below Telegram's limit.
      const text = `${emoji('list')} <b>История</b> <code>${ticketLabel(ticket)}</code>\n` +
        'Последние сохранённые текстовые сообщения (до 12).\n\n' +
        (history.length ? history.map(message =>
          `<b>${message.role === 'user' ? 'Пользователь' : 'Ответ поддержки'}:</b> ` +
          staffHtmlSnippet(message.content, 260),
        ).join('\n\n') : 'Сохранённых сообщений пока нет.');
      await show(ctx, text, [[button('ticket', 'Открыть карточку',
        {callback_data: `STAFF_TICKET---${id}`})], backRow()]);
    }
    return true;
  }
  await acknowledge(ctx);
  if (action === 'STAFF_PANEL' || action === 'STAFF_HOME') await showHome(ctx, action === 'STAFF_HOME');
  else if (action === 'STAFF_QUEUE' && ['all', 'waiting', 'mine'].includes(id) && /^\d{1,6}$/.test(page || '')) {
    await showQueue(ctx, id as QueueFilter, Number(page), true);
  } else if (action === 'STAFF_SEARCH') {
    await show(ctx, `${emoji('search')} <b>Поиск обращения</b>\n\n` +
      'Отправьте команду: <code>/find T000142</code>' +
      (cache.config.anonymous_tickets ? '' : '\nИли: <code>/find tg 123456789</code>'), [backRow()], true);
  } else if (action === 'STAFF_STATS') {
    const counts = db.getStaffTicketCounts(staffCategories(ctx), actorId(ctx));
    await show(ctx, `${emoji('settings')} <b>Текущая нагрузка</b>\n\n` +
      `Ждут оператора: <b>${counts.waiting}</b>\nМои тикеты: <b>${counts.mine}</b>\n` +
      `Все открытые: <b>${counts.all}</b>`, [backRow()], true);
  } else if (action === 'STAFF_TEMPLATES') {
    const templates = cache.config.autoreply || cache.config.language.autoreply || [];
    await show(ctx, `${emoji('list')} <b>Шаблоны ответов</b>\n\n` +
      (templates.length ? 'Выберите шаблон и скопируйте ответ.' : 'Шаблоны пока не настроены.'), [
      ...templates.slice(0, 12).map((template, index) => [
        button('field', Array.from(template.question).slice(0, 60).join(''),
          {callback_data: `STAFF_TEMPLATE---${index}`}),
      ]), backRow(),
    ], true);
  } else if (action === 'STAFF_TEMPLATE' && /^\d{1,2}$/.test(id || '')) {
    const template = (cache.config.autoreply || cache.config.language.autoreply || [])[Number(id)];
    await show(ctx, template ? `${emoji('field')} <b>${html(template.question, 100)}</b>\n\n` +
      html(template.answer, 500) + '\n\nСкопируйте ответ и отправьте его ответом на карточку тикета.' :
      'Шаблон недоступен.', [backRow()], true);
  } else if (action === 'STAFF_HELP') {
    await show(ctx, `${emoji('field')} <b>Как работать с обращением</b>\n\n` +
      '1. Откройте тикет и нажмите «Взять».\n' +
      '2. Ответьте на карточку средствами Telegram — бот отправит текст пользователю.\n' +
      '3. Завершите обращение кнопкой «Закрыть» или верните диалог AI.\n\n' +
      '/panel — меню оператора\n/open — очередь\n/find — поиск', [backRow()], true);
  } else await showHome(ctx, true);
  return true;
}

export async function registerStaffCommands(bot: any): Promise<void> {
  const commands = [
    {command: 'panel', description: '🟥 Панель оператора'},
    {command: 'open', description: '🗂 Очередь открытых тикетов'},
    {command: 'find', description: '🔎 Поиск по тикету или Telegram ID'},
    {command: 'close', description: '❌ Закрыть тикет ответом на карточку'},
    {command: 'reopen', description: '⚡️ Открыть тикет заново'},
    {command: 'ban', description: '🚫 Заблокировать пользователя тикета'},
    {command: 'unban', description: '◻️ Разблокировать пользователя тикета'},
    {command: 'aistats', description: '⚙️ Статистика поддержки и AI'},
    {command: 'id', description: '🏷 Telegram ID пользователя и чата'},
    {command: 'help', description: '◻️ Помощь'},
  ];
  const chats = new Set<string>([String(cache.config.staffchat_id)]);
  for (const category of cache.config.categories || []) {
    if (!category.subgroups?.length) chats.add(String(category.group_id));
    for (const subgroup of category.subgroups || []) chats.add(String(subgroup.group_id));
  }
  for (const chatId of chats) {
    if (!/^-?\d+$/.test(chatId)) continue;
    try {
      await bot.api.setMyCommands(commands,
        {scope: {type: 'chat', chat_id: chatId}, language_code: 'ru'});
      await bot.api.setMyCommands(commands, {scope: {type: 'chat', chat_id: chatId}});
    } catch (_error) {
      logger.warn('staffPanel', 'Could not register staff command menu', {chatId});
    }
  }
}
