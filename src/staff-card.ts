import cache from './cache';
import * as db from './db';
import * as middleware from './middleware';
import {AiConfig, Context} from './interfaces';
import {logger} from './logger';
import {recordDependencyStatus} from './operational-alerts';
import {staffButton, staffEmoji, StaffButton} from './staff-ui';

export interface StaffTurnCard {
  chatId: string | number;
  messageId: number;
  ticketId: string;
  question: string;
  runId?: string;
  createdAt?: number;
  waitingSince?: number;
  user: {
    id: string | number;
    firstName: string;
    username?: string;
  };
}

export interface StaffCardResult {
  status: 'ai_active' | 'answered' | 'waiting_operator' | 'in_progress' | 'closed';
  answer?: string;
  mode?: 'llm' | 'direct_rag';
  sourceId?: string;
  sourceTitle?: string;
  denseScore?: number;
  lexicalScore?: number;
  fusedScore?: number;
  reason?: string;
  assigneeName?: string;
  providerRoute?: string;
  latencyMs?: number;
}

function escapeHtml(value: unknown): string {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escapeHtmlLimited(value: unknown, maximumLength: number): string {
  const text = String(value || '');
  let escaped = '';
  for (const character of text) {
    const encoded = escapeHtml(character);
    if (escaped.length + encoded.length > maximumLength - 1) {
      return `${escaped}…`;
    }
    escaped += encoded;
  }
  return escaped;
}

function truncatePlainText(value: unknown, maximumLength: number): string {
  const characters = Array.from(String(value || '').replace(/\r/g, ' '));
  return characters.length <= maximumLength ?
    characters.join('') : `${characters.slice(0, maximumLength - 1).join('')}…`;
}

function durationLabel(milliseconds: number): string {
  const safe = Math.max(0, milliseconds);
  if (safe < 1000) return `${Math.round(safe)} мс`;
  if (safe < 60000) return `${(safe / 1000).toFixed(1).replace('.', ',')} с`;
  return `${Math.floor(safe / 60000)} мин`;
}

function statusLabel(result?: StaffCardResult): string {
  if (!result) return '🤖 AI обрабатывает';
  if (result.status === 'ai_active') return '🤖 AI активен';
  if (result.status === 'answered') return `${staffEmoji('done')} AI ответил`;
  if (result.status === 'waiting_operator') return `${staffEmoji('waiting')} Ждёт оператора`;
  if (result.status === 'in_progress') {
    return result.assigneeName ?
      `${staffEmoji('take')} В работе · ${escapeHtmlLimited(result.assigneeName, 120)}` :
      `${staffEmoji('take')} В работе`;
  }
  return `${staffEmoji('close')} Закрыт`;
}

function plainStatusLabel(result: StaffCardResult): string {
  if (result.status === 'ai_active') return '🤖 AI активен';
  if (result.status === 'answered') return '✅ AI ответил';
  if (result.status === 'waiting_operator') return '❗️ Ждёт оператора';
  if (result.status === 'in_progress') {
    return result.assigneeName ?
      `⚡️ В работе · ${truncatePlainText(result.assigneeName, 80)}` :
      '⚡️ В работе';
  }
  return '❌ Закрыт';
}

export function handoffReasonLabel(reason?: string): string {
  const reasons: Record<string, string> = {
    user_request: 'Пользователь попросил оператора',
    feedback_operator: 'Пользователь попросил оператора',
    user_operator_button: 'Пользователь попросил оператора',
    feedback_not_helpful: 'Ответ не помог пользователю',
    not_helpful: 'Ответ не помог пользователю',
    no_context: 'В базе знаний нет подходящего ответа',
    low_confidence: 'Нужна проверка ответа специалистом',
    llm_uncertain: 'Ассистент не уверен в ответе',
    model_requested_handoff: 'Ассистент запросил помощь оператора',
    ai_disabled: 'Автоматические ответы отключены',
    media: 'Нужно проверить вложение',
    off_topic: 'Нужна помощь специалиста',
    deadline: 'Ассистент не успел ответить',
    empty: 'Ассистент не смог подготовить ответ',
    telegram_error: 'Не удалось доставить ответ',
    staff_take: 'Оператор подключился к диалогу',
    staff_reply: 'Оператор отвечает пользователю',
    staff_private_reply: 'Оператор подключился в личном чате',
  };
  if (!reason || reason === 'ai_resumed') return '';
  return reasons[reason] || 'Требуется помощь оператора';
}

function dateLabel(timestamp: number): string {
  return new Intl.DateTimeFormat('ru-RU', {
    timeZone: 'Europe/Moscow', day: '2-digit', month: '2-digit',
    hour: '2-digit', minute: '2-digit',
  }).format(new Date(timestamp)) + ' МСК';
}

export function buildStaffCardKeyboard(
  ticketId: string,
  cfg: AiConfig | null,
  result?: StaffCardResult,
  runId?: string,
  userId?: string | number,
) {
  const status = result?.status || 'ai_active';
  const rows: StaffButton[][] = [];
  if (status !== 'closed') {
    rows.push([
      staffButton('take', result?.status === 'in_progress' ? 'Переназначить' :
        (cfg?.staff_forward?.takeover_button_text || 'Взять'),
      {callback_data: `AI_TAKE---${ticketId}`}, 'primary'),
      staffButton('close', cfg?.staff_forward?.close_button_text || 'Закрыть',
        {callback_data: `AI_CLOSE---${ticketId}`}, 'danger'),
    ]);
  }
  const secondary: StaffButton[] = [];
  if (status === 'waiting_operator' || status === 'in_progress') {
    secondary.push(staffButton('take',
      cfg?.staff_forward?.resume_button_text || 'Вернуть AI',
      {callback_data: `AI_RESUME---${ticketId}`}));
  }
  if (runId && /^[A-Za-z0-9_.-]{8,64}$/.test(runId)) {
    const callbackData = `AI_DIAG---${ticketId}---${runId}`;
    if (Buffer.byteLength(callbackData, 'utf8') <= 64) {
      secondary.push(staffButton('settings', 'Диагностика',
        {callback_data: callbackData}));
    }
  }
  if (secondary.length > 0) rows.push(secondary);
  const details = [staffButton('list', 'История',
    {callback_data: `STAFF_HISTORY---${ticketId}`})];
  if (userId != null && !cache.config.anonymous_tickets) {
    details.push(staffButton('field', 'Копировать TG ID',
      {copy_text: {text: String(userId)}}));
  }
  rows.push(details);
  rows.push([
    staffButton('ticket', 'Копировать тикет',
      {copy_text: {text: `T${ticketId.padStart(6, '0')}`}}),
    staffButton('menu', 'Панель', {callback_data: 'STAFF_PANEL'}),
  ]);
  return {
    reply_markup: {
      inline_keyboard: rows,
    },
  };
}

function providerLabel(provider: string): string {
  if (provider === 'gemini') return 'Gemini';
  if (provider === 'mistral') return 'Mistral';
  return truncatePlainText(provider, 24);
}

function fallbackReasonLabel(reason?: string | null): string {
  if (!reason) return '';
  if (['credits', 'rate_limit', 'quota_cap'].includes(reason)) return 'квота';
  if (reason === 'timeout') return 'таймаут';
  if (reason === 'auth') return 'доступ';
  if (reason === 'model_unavailable') return 'модель недоступна';
  if (reason === 'provider_error') return 'сбой';
  return truncatePlainText(reason.replace(/_/g, ' '), 32);
}

function routeFromDiagnostics(diagnostics: db.AiRunDiagnostics): string {
  if (diagnostics.run.route === 'direct_rag') return 'Локальный RAG';
  const attempts = diagnostics.providerAttempts.filter(
    (attempt) => attempt.outcome !== 'skipped' ||
      attempt.errorReason === 'quota_cap' ||
      attempt.errorReason === 'circuit_open',
  );
  if (attempts.length === 0) return diagnostics.run.route;
  const labels: string[] = [];
  for (const attempt of attempts) {
    const label = providerLabel(attempt.provider);
    if (labels[labels.length - 1] !== label) labels.push(label);
  }
  const firstFailure = attempts.find((attempt) =>
    attempt.outcome === 'failure' || attempt.outcome === 'skipped',
  );
  const reason = fallbackReasonLabel(firstFailure?.errorReason);
  return labels.length > 1 && reason ?
    `${labels.join(' → ')} (${reason})` : labels.join(' → ');
}

function enrichResult(
  card: StaffTurnCard,
  result: StaffCardResult,
): StaffCardResult {
  if (!card.runId || (result.providerRoute && result.latencyMs != null)) {
    return result;
  }
  try {
    const diagnostics = db.getAiRunDiagnostics(card.runId);
    if (!diagnostics) return result;
    return {
      ...result,
      providerRoute: result.providerRoute || routeFromDiagnostics(diagnostics),
      latencyMs: result.latencyMs ?? diagnostics.run.latencyMs ?? undefined,
    };
  } catch (_error) {
    return result;
  }
}

export function formatAiRunDiagnostics(
  diagnostics: db.AiRunDiagnostics,
): string {
  const route = routeFromDiagnostics(diagnostics);
  const latency = diagnostics.run.latencyMs == null ?
    '—' : durationLabel(diagnostics.run.latencyMs);
  const statusLabels: Record<string, string> = {
    running: 'Выполняется',
    answered: 'Ответ отправлен',
    direct_rag: 'Ответ RAG',
    handed_off: 'Передан оператору',
    cancelled: 'Отменён',
    failed: 'Ошибка',
  };
  const ragLabels: Record<string, string> = {
    not_run: 'не запускался',
    hit: 'найдено',
    miss: 'нет данных',
    unavailable: 'недоступен',
  };
  const providerSummary = diagnostics.providerAttempts.map((attempt) => {
    const marker = attempt.outcome === 'success' ? '✓' :
      attempt.outcome === 'skipped' ? '↷' : '✕';
    const reason = attempt.errorReason ?
      `:${fallbackReasonLabel(attempt.errorReason)}` : '';
    return `${providerLabel(attempt.provider)}${marker}${reason}`;
  }).join(' → ') || 'нет попыток';
  return truncatePlainText([
    `${statusLabels[diagnostics.run.status] || diagnostics.run.status} · ` +
      `${route} · ${latency}`,
    providerSummary,
    `RAG: ${ragLabels[diagnostics.run.ragStatus] || diagnostics.run.ragStatus}; ` +
      `источники: ${diagnostics.run.sourceCount}; ` +
      `tools: ${diagnostics.run.toolRunCount}`,
  ].join('\n'), 190);
}

export function renderStaffTurnCard(
  card: StaffTurnCard,
  result?: StaffCardResult,
): string {
  const anonymous = cache.config.anonymous_tickets === true;
  const safeUserId = escapeHtmlLimited(card.user.id, 48);
  const userLine = anonymous ?
    '<b>Пользователь:</b> Анонимный пользователь' : (() => {
      const userLabel = (card.user.username ?
        `@${escapeHtmlLimited(card.user.username, 96)}` : '') +
        `\n<b>TG ID:</b> <code>${safeUserId}</code>`;
      return `<b>Пользователь:</b> ` +
        `<a href="tg://user?id=${safeUserId}">` +
        `${escapeHtmlLimited(card.user.firstName, 120)}</a> ${userLabel}`;
    })();
  const lines = [
    `${staffEmoji('ticket')} <b>Тикет</b> <code>#T${escapeHtml(card.ticketId.padStart(6, '0'))}</code>`,
    `<b>Статус:</b> ${statusLabel(result)}`,
    `<b>Ответственный:</b> ${escapeHtmlLimited(result?.assigneeName || 'Не назначен', 120)}`,
    `<b>Создан:</b> ${dateLabel(card.createdAt || Date.now())}`,
    ...(result?.status === 'waiting_operator' ?
      [`<b>Ждёт с:</b> ${dateLabel(card.waitingSince || card.createdAt || Date.now())}`] : []),
    userLine,
    '',
    `<b>Вопрос:</b> ${escapeHtmlLimited(card.question, 1000)}`,
  ];
  const reason = result?.status === 'waiting_operator' || result?.status === 'in_progress' ?
    handoffReasonLabel(result.reason) : '';
  if (reason) lines.splice(lines.length - 2, 0,
    `<b>Причина:</b> ${escapeHtmlLimited(reason, 240)}`);
  if (result?.status === 'closed' && result.reason === 'ai_helpful') {
    lines.splice(lines.length - 2, 0, '<b>Результат:</b> ✅ Ответ помог');
  }
  if (result?.answer) {
    lines.push('', `<b>Ответ:</b> ${escapeHtmlLimited(result.answer, 1300)}`);
  }
  if (result?.sourceTitle || result?.sourceId) {
    lines.push(
      `<b>Источник:</b> ${escapeHtmlLimited(
        result.sourceTitle || result.sourceId,
        240,
      )}`,
    );
  }
  return lines.join('\n');
}

export async function createStaffTurnCard(
  ctx: Context,
  ticket: any,
  question: string,
  cfg: AiConfig | null,
): Promise<StaffTurnCard | null> {
  if (
    cfg?.staff_forward?.enabled === false ||
    cache.config.support?.mirror_ai_dialogs === false ||
    !ctx.message?.from
  ) return null;
  const card: StaffTurnCard = {
    chatId: cache.config.staffchat_id,
    messageId: 0,
    ticketId: String(ticket.id),
    question,
    runId: cache.aiSessions?.[String(ticket.id)]?.runId,
    createdAt: ticket.created_at || Date.now(),
    waitingSince: db.getStaffTicket(ticket.id)?.waiting_since,
    user: {
      id: ctx.message.from.id,
      firstName: ctx.message.from.first_name || 'Пользователь',
      username: ctx.message.from.username,
    },
  };
  const messageId = await middleware.msgWithId(
    card.chatId,
    renderStaffTurnCard(card),
    {
      parse_mode: 'HTML',
      already_formatted: true,
      ...buildStaffCardKeyboard(card.ticketId, cfg, undefined, card.runId, card.user.id),
    },
  );
  if (!messageId) return null;
  card.messageId = messageId;
  db.mapTelegramMessage(card.chatId, messageId, card.ticketId, 'staff_turn');
  return card;
}

export async function updateStaffTurnCard(
  card: StaffTurnCard | null,
  result: StaffCardResult,
  cfg: AiConfig | null,
): Promise<void> {
  if (!card) return;
  try {
    const enriched = enrichResult(card, result);
    card.waitingSince = db.getStaffTicket(card.ticketId)?.waiting_since;
    await cache.bot.api.editMessageText(
      card.chatId,
      card.messageId,
      renderStaffTurnCard(card, enriched),
      {
        parse_mode: 'HTML',
        ...buildStaffCardKeyboard(card.ticketId, cfg, enriched, card.runId, card.user.id),
      },
    );
    void recordDependencyStatus('telegram', true);
  } catch (error) {
    void recordDependencyStatus('telegram', false);
    logger.warn('staffCard', 'Failed to edit staff card', {
      ticketId: card.ticketId,
      messageId: card.messageId,
    });
  }
}

export async function updateCallbackCardStatus(
  ctx: any,
  ticketId: string,
  status: StaffCardResult,
  cfg: AiConfig | null,
): Promise<void> {
  const current = String(
    ctx.callbackQuery?.message?.text || ctx.callbackQuery?.message?.caption || '',
  );
  const isCaption = !ctx.callbackQuery?.message?.text &&
    !!ctx.callbackQuery?.message?.caption;
  if (!current || typeof ctx[isCaption ? 'editMessageCaption' : 'editMessageText'] !== 'function') return;
  const keyboard = ctx.callbackQuery?.message?.reply_markup?.inline_keyboard;
  const diagnosticCallback = Array.isArray(keyboard) ?
    keyboard.flat().find((button: any) =>
      String(button?.callback_data || '').startsWith('AI_DIAG---'),
    )?.callback_data : undefined;
  const callbackRunId = typeof diagnosticCallback === 'string' ?
    diagnosticCallback.split('---')[2] :
    cache.aiSessions?.[ticketId]?.runId;
  // Telegram supplies plain text plus UTF-16 entities in callbacks. Rebase
  // their offsets when changing a line so links, code and custom emoji survive.
  let next = current;
  let entities = ctx.callbackQuery?.message?.entities ||
    ctx.callbackQuery?.message?.caption_entities || [];
  const replaceLine = (pattern: RegExp, value: string) => {
    const match = next.match(pattern);
    if (!match || match.index == null) return;
    const headerEnd = next.indexOf('\n\nВопрос:');
    if (headerEnd >= 0 && match.index >= headerEnd) return;
    const start = match.index + match[0].length - match[1].length;
    const end = start + match[1].length;
    const delta = value.length - (end - start);
    entities = entities.flatMap((entity: any) => {
      const entityEnd = entity.offset + entity.length;
      if (entityEnd <= start) return [entity];
      if (entity.offset >= end) return [{...entity, offset: entity.offset + delta}];
      if (entity.offset <= start && entityEnd >= end &&
        ['bold', 'italic', 'underline', 'blockquote', 'expandable_blockquote']
          .includes(entity.type)) {
        return [{...entity, length: entity.length + delta}];
      }
      return [];
    });
    next = next.slice(0, start) + value + next.slice(end);
  };
  const ticket = db.getStaffTicket(ticketId);
  const currentStatus: StaffCardResult = ticket ? {
    ...status,
    status: ticket.status === 'closed' ? 'closed' :
      ticket.stage === 'in_progress' ? 'in_progress' :
      ticket.stage === 'waiting_operator' ? 'waiting_operator' : 'ai_active',
    assigneeName: ticket.assignee_name || undefined,
    reason: ticket.status === 'closed' ? ticket.close_reason : ticket.handoff_reason,
  } : status;
  replaceLine(/^Статус: (.*)$/m, plainStatusLabel(currentStatus));
  replaceLine(/^Ответственный: (.*)$/m,
    truncatePlainText(currentStatus.assigneeName || 'Не назначен', 80));
  if (currentStatus.status !== 'waiting_operator') {
    replaceLine(/^(Ждёт с:.*\n)/m, '');
  }
  if (currentStatus.status === 'waiting_operator' || currentStatus.status === 'in_progress') {
    replaceLine(/^Причина: (.*)$/m, handoffReasonLabel(currentStatus.reason) || '—');
  } else {
    replaceLine(/^(Причина:.*\n)/m,
      currentStatus.reason === 'ai_helpful' ? 'Результат: ✅ Ответ помог\n' : '');
  }
  const copyButton = Array.isArray(keyboard) ?
    keyboard.flat().find((button: any) => button.copy_text &&
      /^\d+$/.test(button.copy_text.text)) : undefined;
  try {
    const options = {
      ...buildStaffCardKeyboard(ticketId, cfg, currentStatus, callbackRunId,
        ticket?.userid || copyButton?.copy_text.text),
    };
    if (isCaption) await ctx.editMessageCaption({caption: next, caption_entities: entities, ...options});
    else await ctx.editMessageText(next, {entities, ...options});
  } catch (error) {
    logger.debug('staffCard', 'Callback card status was not edited', {
      ticketId,
    });
  }
}
