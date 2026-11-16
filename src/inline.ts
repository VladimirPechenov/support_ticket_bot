import { Context, ModeData } from './interfaces';
import TelegramAddon from './addons/telegram';
import cache from './cache';
import * as middleware from './middleware';
import * as ai from './ai';
import * as db from './db';
import { logger } from './logger';
import {
  formatAiRunDiagnostics,
  updateCallbackCardStatus,
} from './staff-card';
import {canAccessStaffTicket, canUseStaffPanel, handleStaffPanelCallback, showStaffTicket} from './staff-panel';
import {escapeStaffHtml, staffButton} from './staff-ui';

async function answerCallback(
  ctx: Context,
  text: string,
  showAlert = true,
): Promise<void> {
  if (typeof ctx.answerCallbackQuery === 'function') {
    await ctx.answerCallbackQuery({text, show_alert: showAlert});
    return;
  }
  if (typeof ctx.answerCbQuery === 'function') {
    ctx.answerCbQuery(text, showAlert);
  }
}

function canManageAiCard(ctx: Context): boolean {
  return canUseStaffPanel(ctx);
}

/**
 * Helper function for reply keyboard
 * @param {Array} keys
 * @return {Object} reply_markup
 */
function replyKeyboard(keys: any[]) {
  return {
    parse_mode: cache.config.parse_mode,
    reply_markup: {
      keyboard: keys,
    },
  };
}

/**
 * Helper function to remove keyboard
 * @return {Object} reply_markup
 */
function removeKeyboard() {
  return {
    parse_mode: cache.config.parse_mode,
    reply_markup: {
      remove_keyboard: true,
    },
  };
}

/**
 * Initialize categories from config
 * @param {Object} bot
 * @param {Object} config
 * @return {Array} keys
 */
function initInline(bot: TelegramAddon) {
  const keys = [];
  // Get categories from config file
  for (const i in cache.config.categories) {
    if (i !== undefined) {
      keys.push([cache.config.categories[i].name]);
      const subKeys: any = [];
      // Check if it has no subcategory
      if (cache.config.categories[i].subgroups == undefined) {
        // Create category button events for start with parameter
        // Full category name to 64 Byte without special chars
        const startStr =
          '/start ' +
          cache.config.categories[i].name
            .replace(/\[|\]|:| |"/g, '')
            .substr(0, 63);
        bot.hears(startStr, (ctx: Context) => {
          ctx.session.mode = '';
          ctx.session.modeData = {} as ModeData;
          // Info text
          if (cache.config.categories[i].msg != undefined) {
            middleware.reply(ctx, cache.config.categories[i].msg);
          } else {
            middleware.reply(
              ctx,
              cache.config.language.msgForwarding +
              '\n' +
              `*${cache.config.categories[i].name}*`,
              removeKeyboard(),
            );
            ctx.session.group = cache.config.categories[i].group_id;
            ctx.session.groupCategory = cache.config.categories[i].name;
          }
        });
        // Create subcategory button events
        bot.hears(cache.config.categories[i].name, (ctx: Context) => {
          ctx.session.mode = '';
          ctx.session.modeData = {} as ModeData;
          // Info text
          if (cache.config.categories[i].msg != undefined) {
            middleware.reply(ctx, cache.config.categories[i].msg);
          } else {
            middleware.reply(
              ctx,
              cache.config.language.msgForwarding +
              '\n' +
              `*${cache.config.categories[i].name}*`,
              removeKeyboard(),
            );
            ctx.session.group = cache.config.categories[i].group_id;
            ctx.session.groupCategory = cache.config.categories[i].name;
          }
        });
        continue;
      }
      // Get subcategories
      for (const j in cache.config.categories[i].subgroups) {
        if (j !== undefined) {
          const categoryFullId = [
            cache.config.categories[i].name +
            ': ' +
            cache.config.categories[i].subgroups[j].name,
          ];
          subKeys.push(categoryFullId);

          // Create subcategory button events for start with parameter
          // Full category name to 64 Byte without special chars
          const startStr =
            '/start ' +
            JSON.stringify(categoryFullId)
              .replace(/\[|\]|:| |"/g, '')
              .substr(0, 63);
          bot.hears(startStr, (ctx: Context) => {
            ctx.session.mode = '';
            ctx.session.modeData = {} as ModeData;
            middleware.reply(
              ctx,
              cache.config.language.msgForwarding +
              '\n' +
              `*${categoryFullId}*`,
              removeKeyboard(),
            );
            // Set subgroup
            ctx.session.group =
              cache.config.categories[i].subgroups[j].group_id;
            ctx.session.groupCategory =
              cache.config.categories[i].subgroups[j].name;
          });

          // Create subcategory button events
          bot.hears(categoryFullId, (ctx: Context) => {
            ctx.session.mode = '';
            ctx.session.modeData = {} as ModeData;
            middleware.reply(
              ctx,
              cache.config.language.msgForwarding +
              '\n' +
              `*${categoryFullId}*`,
              removeKeyboard(),
            );
            // Set subgroup
            ctx.session.group =
              cache.config.categories[i].subgroups[j].group_id;
            ctx.session.groupCategory =
              cache.config.categories[i].subgroups[j].name;
          });
        }
      }
      subKeys.push([cache.config.language.back]);
      // Create subcategory buttons
      bot.hears(cache.config.categories[i].name, (ctx: Context) => {
        ctx.session.mode = '';
        ctx.session.modeData = {} as ModeData;
        middleware.reply(
          ctx,
          cache.config.language.whatSubCategory,
          replyKeyboard(subKeys),
        );
      });
    }
  }
  return keys;
}

/**
 * Callback query handler
 * @param {Object} ctx
 */
async function callbackQuery(ctx: Context) {
  if (await handleStaffPanelCallback(ctx)) return;
  const staffId = ctx.callbackQuery.from.id;
  const data = ctx.callbackQuery.data || '';
  const userFeedbackActions: Record<
    string,
    'helpful' | 'not_helpful' | 'operator'
  > = {
    AI_HELPFUL: 'helpful',
    AI_NOT_HELPFUL: 'not_helpful',
    AI_OPERATOR: 'operator',
  };
  const callbackParts = data.split('---');
  const action = callbackParts[0];
  const ticketId = callbackParts[1];
  const answerId = callbackParts[2];
  logger.debug('callbackQuery', 'Callback received', {
    staffId,
    action,
    ticketId,
  });

  if (userFeedbackActions[action] && ticketId) {
    const ok = await ai.handleUserFeedback(
      ticketId,
      ctx.callbackQuery.from.id,
      userFeedbackActions[action],
      answerId,
    );
    if (ok && typeof (ctx as any).editMessageReplyMarkup === 'function') {
      try {
        await (ctx as any).editMessageReplyMarkup({inline_keyboard: []});
      } catch (error) {
        logger.debug('callbackQuery', 'Feedback keyboard already removed', {
          ticketId,
          answerId,
        });
      }
    }
    await answerCallback(
      ctx,
      ok ?
        (action === 'AI_HELPFUL' ?
          'Спасибо за оценку' :
          'Передаём оператору') :
        'Эта кнопка недоступна',
    );
    return;
  }

  const staffActions = [
    'AI_STOP',
    'AI_TAKE',
    'AI_CLOSE',
    'AI_RESUME',
    'AI_DIAG',
    'AI_REASSIGN',
  ];
  if (staffActions.includes(action) && ticketId) {
    if (!canManageAiCard(ctx)) {
      await answerCallback(ctx, 'Недостаточно прав');
      return;
    }

    if (action === 'AI_DIAG') {
      const runId = answerId;
      if (!runId || !/^[A-Za-z0-9_.-]{8,64}$/.test(runId)) {
        await answerCallback(ctx, 'Диагностика недоступна');
        return;
      }
      try {
        const diagnostics = db.getAiRunDiagnostics(runId);
        await answerCallback(
          ctx,
          diagnostics ?
            formatAiRunDiagnostics(diagnostics) :
            'Диагностика ещё не готова',
        );
      } catch (_error) {
        await answerCallback(ctx, 'Диагностика временно недоступна');
      }
      return;
    }

    const ticket = db.getTicketByIdSync(ticketId);
    if (!ticket) {
      await answerCallback(ctx, 'Тикет не найден');
      return;
    }
    if (!canAccessStaffTicket(ctx, ticket)) {
      await answerCallback(ctx, 'Тикет недоступен');
      return;
    }

    if (action === 'AI_CLOSE') {
      const closed = db.closeTicketById(ticketId);
      if (!closed) {
        await answerCallback(ctx, 'Тикет уже закрыт');
        return;
      }
      ai.clearAiSession(ticketId, 'ticket_closed');
      await middleware.msg(
        ticket.userid,
        cache.config.language.ticketClosed,
        {parse_mode: cache.config.parse_mode},
      );
      await updateCallbackCardStatus(
        ctx,
        ticketId,
        {status: 'closed'},
        ai.getAiConfig(),
      );
      await answerCallback(ctx, 'Тикет закрыт');
      return;
    }

    if (action === 'AI_RESUME') {
      if (ticket.status === 'closed') {
        await answerCallback(ctx, 'Тикет уже закрыт');
        return;
      }
      if (ticket.stage === 'ai_active' && ticket.ai_enabled === 1) {
        await answerCallback(ctx, 'ИИ уже активен');
        return;
      }
      const ok = await ai.resumeAiForTicket(ticketId, true);
      if (ok) {
        await updateCallbackCardStatus(
          ctx,
          ticketId,
          {status: 'ai_active', reason: 'ai_resumed'},
          ai.getAiConfig(),
        );
      }
      await answerCallback(
        ctx,
        ok ? 'ИИ возвращён' : 'Тикет не найден',
      );
      return;
    }

    if (ticket.status === 'closed') {
      await answerCallback(ctx, 'Тикет уже закрыт');
      return;
    }
    if (
      ticket.stage === 'in_progress' &&
      ticket.assignee_id != null &&
      String(ticket.assignee_id) === String(ctx.callbackQuery.from.id)
    ) {
      await answerCallback(ctx, 'Тикет уже у вас');
      return;
    }

    const assigneeName = ctx.callbackQuery.from.first_name ||
      ctx.callbackQuery.from.username || String(staffId);
    if (ticket.assignee_id != null && action !== 'AI_REASSIGN') {
      await middleware.msg(ctx.chat.id,
        `Тикет уже у оператора <b>${escapeStaffHtml(ticket.assignee_name || ticket.assignee_id, 80)}</b>.\n` +
        'Переназначить его на вас?', {
          parse_mode: 'HTML', already_formatted: true,
          reply_markup: {inline_keyboard: [[
            staffButton('take', 'Переназначить на меня', {
              callback_data: `AI_REASSIGN---${ticketId}---${ticket.assignee_id}`,
            }),
            staffButton('back', 'Открыть карточку', {callback_data: `STAFF_TICKET---${ticketId}`}),
          ]]},
        });
      await answerCallback(ctx, 'Подтвердите переназначение', false);
      return;
    }
    if (action === 'AI_REASSIGN' && String(ticket.assignee_id) !== answerId) {
      await answerCallback(ctx, 'Ответственный изменился. Откройте карточку заново.');
      return;
    }
    if (!db.claimStaffTicket(ticketId, staffId, assigneeName,
      ticket.assignee_id == null ? null : String(ticket.assignee_id))) {
      await answerCallback(ctx, 'Тикет изменился. Откройте карточку заново.');
      return;
    }

    logger.info('callbackQuery', `${action} button clicked`, {
      staffId,
      ticketId,
    });
    const ok = await ai.disableAiForTicket(ticketId, 'staff_take', {
      notifyUser: true,
      assigneeId: ctx.callbackQuery.from.id,
      assigneeName,
    });
    if (ok && action === 'AI_REASSIGN') {
      if (typeof (ctx as any).editMessageText === 'function') {
        await (ctx as any).editMessageText('✅ Тикет переназначен на вас.',
          {reply_markup: {inline_keyboard: []}});
      }
      await showStaffTicket(ctx, db.getStaffTicket(ticketId));
    } else if (ok) {
      await updateCallbackCardStatus(
        ctx,
        ticketId,
        {
          status: 'in_progress',
          assigneeName,
        },
        ai.getAiConfig(),
      );
    }
    await answerCallback(
      ctx,
      ok ? 'Тикет взят' : 'Не удалось взять тикет',
    );
    return;
  }
  // Check whether to end callback session
  if (ctx.callbackQuery.data === 'R') {
    logger.debug('callbackQuery', `Ending private chat session`, { staffId });
    ctx.session.mode = '';
    ctx.session.modeData = {} as ModeData;
    middleware.reply(ctx, cache.config.language.prvChatEnded);
    return;
  }
  // Get Ticket ID from DB
  const id = ctx.callbackQuery.data.split('---')[0];
  const name = ctx.callbackQuery.data.split('---')[1];
  const category = ctx.callbackQuery.data.split('---')[2];
  const ticketid = ctx.callbackQuery.data.split('---')[3];
  logger.info('callbackQuery', `Opening private chat`, { staffId, userId: id, ticketId: ticketid });
  void ai.disableAiForTicket(ticketid, 'staff_private_reply');
  ctx.session.mode = 'private_reply';
  ctx.session.modeData = {
    ticketid: ticketid,
    userid: id,
    name: name,
    category: category,
  };
  middleware.msg(
    ctx.callbackQuery.from.id,
    ctx.chat.type !== 'private' ?
      `${cache.config.language.ticket} ` +
      `#T${ticketid.toString().padStart(6, '0')}` +
      `\n\n` +
      cache.config.language.prvChatOpened :
      cache.config.language.prvChatOpenedCustomer,
    {
      parse_mode: cache.config.parse_mode,
      reply_markup: {
        html: '',
        inline_keyboard: [
          [
            {
              text: cache.config.language.prvChatEnd,
              callback_data: 'R',
            },
          ],
        ],
      },
    },
  );

  // TODO: forward to bot? not possible without triggering start command
  // var t = ('https://t.me/' + bot.options.username + '?start=X');
  await answerCallback(
    ctx,
    cache.config.language.instructionsSent,
  );
}

export {
  answerCallback,
  callbackQuery,
  initInline,
  replyKeyboard,
  removeKeyboard,
};
