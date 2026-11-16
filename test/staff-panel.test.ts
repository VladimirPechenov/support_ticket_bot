import {expect} from 'chai';
import cache from '../src/cache';
import * as db from '../src/db';
import {callbackQuery} from '../src/inline';
import {findCommand, panelCommand, queueCommand, registerStaffCommands} from '../src/staff-panel';
import {staffButton, staffEmoji, stripCustomEmoji, withStaffEmojiFallback} from '../src/staff-ui';
import {checkRights} from '../src/permissions';

describe('Staff panel', () => {
  let originalConfig: any;
  let originalBot: any;
  let tickets: any[];
  let sent: Array<{chatId: any; text: string; options: any}>;

  beforeEach(() => {
    originalConfig = cache.config;
    originalBot = cache.bot;
    cache.config = {...originalConfig, staffchat_id: '-100-staff', owner_id: 'owner',
      anonymous_tickets: false, categories: [
        {name: 'billing', group_id: '-100-billing', subgroups: []},
        {name: 'technical', group_id: '-100-technical', subgroups: []},
      ]};
    sent = [];
    tickets = [];
    const send = async (chatId: any, text: string, options: any) => {
      sent.push({chatId, text, options});
      return {message_id: sent.length};
    };
    cache.bot = {sendMessage: send, api: {sendMessage: send}} as any;
  });

  afterEach(() => {
    for (const ticket of tickets) {
      delete cache.aiSessions[String(ticket.id)];
      db.closeTicketById(ticket.id, 'test_cleanup');
    }
    cache.config = originalConfig;
    cache.bot = originalBot;
  });

  function create(category: string | null = null, index = 0): any {
    const userId = `panel-${Date.now()}-${index}-${tickets.length}`;
    db.add(userId, 'open', category);
    const ticket = db.getOpenSync(userId, category);
    tickets.push(ticket);
    db.updateTicketUser(ticket.id, {first_name: 'Анна', username: 'anna'});
    db.appendAiConversationMessage(ticket.id, 'user', 'Не работает приложение');
    db.updateTicketState(ticket.id, {stage: 'waiting_operator', aiEnabled: false});
    db.recordTicketEvent(ticket.id, {eventType: 'handoff', createdAt: Date.now() - 420000});
    return ticket;
  }

  function context(chatId = '-100-staff', data?: string, admin = true): any {
    return {
      chat: {id: chatId, type: 'supergroup'}, from: {id: 'operator'},
      session: {admin}, message: {chat: {id: chatId}},
      ...(data ? {callbackQuery: {data, from: {id: 'operator'}}} : {}),
      answerCallbackQuery: async () => undefined,
      editMessageText: async (text: string, options: any) => {
        sent.push({chatId, text, options});
      },
    };
  }

  it('scopes counts, queue, search and direct callbacks to a category', async () => {
    const billing = create('billing');
    const technical = create('technical');
    expect(db.getStaffTicketCounts(['billing'], 'operator').all).to.equal(1);
    await queueCommand(context('-100-billing'));
    expect(sent[0].text).to.contain(`#T${String(billing.id).padStart(6, '0')}`);
    expect(sent[0].text).not.to.contain(`#T${String(technical.id).padStart(6, '0')}`);
    const search = context('-100-billing');
    search.match = `T${technical.id}`;
    await findCommand(search);
    expect(sent[1].text).to.contain('Тикеты не найдены');
    let alert: any;
    const callback = context('-100-billing', `STAFF_HISTORY---${technical.id}`);
    callback.answerCallbackQuery = async (options: any) => { alert = options; };
    await callbackQuery(callback);
    expect(alert.text).to.equal('Тикет недоступен');
    expect(sent).to.have.length(2);
  });

  it('confirms a scoped snapshot, aborts its AI runs and rejects foreign actors and replay', async () => {
    const billing = create('billing');
    const technical = create('technical');
    const controller = new AbortController();
    cache.aiSessions[String(billing.id)] = {ticketId: String(billing.id), userId: billing.userid,
      history: [], disabled: false, abortController: controller};
    await callbackQuery(context('-100-billing', 'STAFF_CLOSE_ALL'));
    expect(db.getTicketByIdSync(billing.id).status).to.equal('open');
    const confirmation = sent[0].options.reply_markup.inline_keyboard.flat()
      .find((button: any) => button.callback_data?.startsWith('STAFF_CLOSE_CONFIRM---')).callback_data;
    const newTicket = create('billing');
    const foreign = context('-100-billing', confirmation);
    foreign.callbackQuery.from.id = 'another-operator';
    await callbackQuery(foreign);
    expect(db.getTicketByIdSync(billing.id).status).to.equal('open');
    await callbackQuery(context('-100-billing', confirmation));
    expect(db.getTicketByIdSync(billing.id).status).to.equal('closed');
    expect(controller.signal.aborted).to.equal(true);
    expect(cache.aiSessions[String(billing.id)]).to.equal(undefined);
    expect(db.getTicketByIdSync(technical.id).status).to.equal('open');
    expect(db.getTicketByIdSync(newTicket.id).status).to.equal('open');
    expect(sent.filter(message => message.chatId === billing.userid)).to.have.length(1);
    await callbackQuery(context('-100-billing', confirmation));
    expect(sent.filter(message => message.chatId === billing.userid)).to.have.length(1);
  });

  it('preserves the helpful result when reopening a closed card from the panel', async () => {
    const ticket = create();
    db.closeTicketById(ticket.id, 'ai_helpful');
    await callbackQuery(context('-100-staff', `STAFF_TICKET---${ticket.id}`));
    expect(sent[0].text).to.contain('✅ Ответ помог');
    expect(sent[0].text).not.to.contain('Причина:');
  });

  it('paginates, sorts by handoff time and clamps stale page numbers', () => {
    for (let i = 0; i < 8; i++) {
      const ticket = create('panel-pagination', i);
      db.recordTicketEvent(ticket.id, {eventType: 'handoff', createdAt: Date.now() + i * 10000});
    }
    const first = db.getStaffQueue(['panel-pagination'], 'waiting', 'operator');
    expect(first.tickets).to.have.length(6);
    expect(first.tickets[0].id).to.equal(tickets[0].id);
    expect(first.pages).to.equal(2);
    const last = db.getStaffQueue(['panel-pagination'], 'waiting', 'operator', 999);
    expect(last.page).to.equal(1);
    expect(last.tickets).to.have.length(2);
    expect(db.getStaffQueue([], 'all', 'operator').total).to.equal(0);
  });

  it('filters assigned tickets and prevents a second simultaneous claim', () => {
    const ticket = create('claim-test');
    expect(db.claimStaffTicket(ticket.id, 'operator', 'Анна', null)).to.equal(true);
    expect(db.claimStaffTicket(ticket.id, 'other', 'Борис', null)).to.equal(false);
    expect(db.getStaffQueue(['claim-test'], 'mine', 'operator').total).to.equal(1);
    expect(db.getStaffQueue(['claim-test'], 'mine', 'other').total).to.equal(0);
    db.closeTicketById(ticket.id);
    expect(db.claimStaffTicket(ticket.id, 'other', 'Борис', 'operator')).to.equal(false);
  });

  it('rejects stale reassignment confirmation', async () => {
    const ticket = create();
    db.claimStaffTicket(ticket.id, 'current', 'Анна', null);
    let alert: any;
    const ctx = context('-100-staff', `AI_REASSIGN---${ticket.id}---previous`);
    ctx.answerCallbackQuery = async (options: any) => { alert = options; };
    await callbackQuery(ctx);
    expect(alert.text).to.contain('Ответственный изменился');
    expect(db.getTicketByIdSync(ticket.id).assignee_id).to.equal('current');
  });

  it('maps a card opened from the queue so replying reaches the right ticket', async () => {
    const ticket = create();
    await callbackQuery(context('-100-staff', `STAFF_TICKET---${ticket.id}`));
    expect(db.getTicketByTelegramMessage('-100-staff', 1).id).to.equal(ticket.id);
    expect(sent[0].text).to.contain('<code>');
    expect(sent[0].options.reply_markup.inline_keyboard.flat()
      .some((button: any) => button.copy_text?.text === ticket.userid)).to.equal(true);
  });

  it('searches closed tickets and hides identities and TG ID search in anonymous mode', async () => {
    const ticket = create();
    db.closeTicketById(ticket.id);
    const ctx = context();
    ctx.match = `T${ticket.id}`;
    await findCommand(ctx);
    expect(sent[0].text).to.contain('Закрыт');
    cache.config.anonymous_tickets = true;
    await findCommand(ctx);
    expect(sent[1].text).to.contain('Анонимный пользователь');
    expect(sent[1].text).not.to.contain('Анна');
    ctx.match = 'tg 123456789';
    await findCommand(ctx);
    expect(sent[2].text).not.to.contain('/find tg');
  });

  it('rejects user callbacks and does not expose owner data in unrelated groups', async () => {
    let alert: any;
    const ctx = context('-100-public', 'STAFF_HOME', false);
    ctx.answerCallbackQuery = async (options: any) => { alert = options; };
    await callbackQuery(ctx);
    expect(alert.text).to.equal('Недостаточно прав');
    ctx.callbackQuery.from.id = 'owner';
    await callbackQuery(ctx);
    expect(alert.text).to.equal('Недостаточно прав');
    expect(sent).to.have.length(0);
  });

  it('computes chat permissions for empty subgroups and clears stale category access', async () => {
    const ctx = context('-100-billing', undefined, false);
    expect(await checkRights(ctx, cache.config)).to.equal(true);
    ctx.chat.id = '-100-unrelated';
    expect(await checkRights(ctx, cache.config)).to.equal(false);
    ctx.session.groupAdmin = {};
    expect(await checkRights(ctx, cache.config)).to.equal(false);
    cache.config.staffchat_id = -1001;
    ctx.chat.id = '-1001';
    expect(await checkRights(ctx, cache.config)).to.equal(true);
  });

  it('keeps queue and history HTML bounded with malicious long input', async () => {
    for (let i = 0; i < 6; i++) {
      const ticket = create('hostile-html', i);
      db.updateTicketUser(ticket.id, {first_name: '<&>'.repeat(1000)});
      db.updateTicketState(ticket.id, {assigneeName: '<&>'.repeat(1000)});
      db.appendAiConversationMessage(ticket.id, 'user', '<script>&'.repeat(1000));
    }
    cache.config.categories.push({name: 'hostile-html', msg: '', group_id: '-100-hostile', subgroups: []});
    await queueCommand(context('-100-hostile'));
    expect(sent[0].text.length).to.be.lessThan(4096);
    expect(sent[0].text).not.to.contain('<script>');
    for (let i = 0; i < 12; i++) {
      db.appendAiConversationMessage(tickets[0].id, 'assistant', '<script>&'.repeat(1000));
    }
    await callbackQuery(context('-100-hostile', `STAFF_HISTORY---${tickets[0].id}`));
    expect(sent[1].text.length).to.be.lessThan(4096);
    expect(sent[1].text).not.to.contain('<script>');
  });

  it('opens the panel with functional navigation and registers only staff chat menus', async () => {
    create();
    await panelCommand(context());
    expect(sent[0].text).to.contain('Панель оператора');
    expect(sent[0].options.reply_markup.inline_keyboard.flat()
      .some((button: any) => button.callback_data === 'STAFF_QUEUE---waiting---0')).to.equal(true);
    const calls: any[] = [];
    cache.config.staffchat_id = '-1001';
    cache.config.categories = [{name: 'billing', msg: '', group_id: '-1002', subgroups: []}];
    await registerStaffCommands({api: {setMyCommands: async (_commands: any, options: any) => calls.push(options)}});
    expect(calls).to.have.length(4);
    expect(calls.every(call => call.scope.type === 'chat' && ['-1001', '-1002'].includes(call.scope.chat_id)))
      .to.equal(true);
  });
});

describe('Staff custom emoji', () => {
  it('renders optional custom emoji and supports opting out', () => {
    const original = cache.config.support;
    try {
      cache.config.support = {custom_emoji: true};
      expect(staffEmoji('menu')).to.contain('5237889385441037272');
      expect(staffButton('search', 'Поиск', {callback_data: 'STAFF_SEARCH'}).icon_custom_emoji_id)
        .to.equal('5429571366384842791');
      cache.config.support.custom_emoji = false;
      expect(staffEmoji('menu')).to.equal('🟥');
      expect(staffButton('search', 'Поиск', {callback_data: 'STAFF_SEARCH'}).icon_custom_emoji_id)
        .to.equal(undefined);
    } finally { cache.config.support = original; }
  });

  it('strips only emoji entities and retains code and links in fallback', () => {
    const payload = {text: '🟥 ID: 123', entities: [
      {type: 'custom_emoji', offset: 0, length: 2},
      {type: 'code', offset: 7, length: 3},
    ]};
    expect(stripCustomEmoji(payload).entities).to.deep.equal([payload.entities[1]]);
    expect(payload.entities).to.have.length(2);
  });

  it('retries an emoji permission error exactly once without custom emoji', async () => {
    let count = 0;
    const previous = async (_method: any, payload: any) => {
      count++;
      if (count === 1) return {ok: false, error_code: 400, description: 'CUSTOM_EMOJI_NOT_ALLOWED'};
      expect(payload.text).to.equal('🟥 Меню');
      expect(payload.reply_markup.inline_keyboard[0][0].icon_custom_emoji_id).to.equal(undefined);
      expect(payload.reply_markup.inline_keyboard[0][0].text).to.contain('🔎');
      return {ok: true};
    };
    await withStaffEmojiFallback(previous, 'sendMessage', {
      text: '<tg-emoji emoji-id="5237889385441037272">🟥</tg-emoji> Меню',
      reply_markup: {inline_keyboard: [[{text: 'Поиск', callback_data: 'STAFF_SEARCH',
        icon_custom_emoji_id: '5429571366384842791'}]]},
    }, undefined);
    expect(count).to.equal(2);
  });
});
