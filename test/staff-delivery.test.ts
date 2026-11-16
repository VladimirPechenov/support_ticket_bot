import {expect} from 'chai';
import cache from '../src/cache';
import * as db from '../src/db';
import {chat, privateReply} from '../src/staff';
import {fileHandler} from '../src/files';
import {resetOperationalAlertsForTests} from '../src/operational-alerts';
import {setAiShutdownState} from '../src/ai';

const Database = require('better-sqlite3');
// Another legacy suite changes DB_PATH after the db module has opened it.
const testDbPath = process.env.DB_PATH;

describe('Staff delivery confirmation', () => {
  let originalConfig: any;
  let originalBot: any;
  let ticket: any;
  let ctx: any;
  let alerts: string[];
  let sent: Array<{id: string | number; text: string}>;
  let database: any;

  beforeEach(() => {
    originalConfig = cache.config;
    originalBot = cache.bot;
    setAiShutdownState(false);
    alerts = [];
    sent = [];
    resetOperationalAlertsForTests({sender: async message => alerts.push(message)});
    cache.config = {...originalConfig, clean_replies: true, parse_mode: 'none',
      auto_close_tickets: true, categories: [], staffchat_id: '-100-delivery',
      language: {...originalConfig.language, msg_sent: 'Отправлено', replyPrivate: 'Ответить'}};
    db.add(`delivery-${Date.now()}-${Math.random()}`, 'open', null);
    database = new Database(testDbPath);
    ticket = database.prepare('SELECT * FROM supportees ORDER BY id DESC LIMIT 1').get();
    ctx = {chat: {id: '-100-delivery', type: 'supergroup'},
      from: {id: 123, first_name: 'Оператор', username: 'staff'},
      session: {admin: true, modeData: {ticketid: ticket.id, userid: ticket.userid,
        name: 'Пользователь', category: 'support'}},
      message: {message_id: 123, chat: {id: '-100-delivery'}, text: 'Ответ',
        from: {id: 123, first_name: 'Оператор'},
        reply_to_message: {message_id: 50, text: `#T${ticket.id}`}}};
    cache.bot = {sendMessage: async (id: any, text: string) => {
      sent.push({id, text});
      return {message_id: sent.length};
    }} as any;
  });

  afterEach(() => {
    database.close();
    db.closeTicketById(ticket.id, 'test_cleanup');
    delete cache.aiSessions[String(ticket.id)];
    resetOperationalAlertsForTests();
    cache.config = originalConfig;
    cache.bot = originalBot;
  });

  function events(type: string): any[] {
    return database.prepare('SELECT * FROM ticket_events WHERE ticket_id=? AND event_type=?')
      .all(ticket.id, type);
  }

  it('does not mark a rejected Telegram reply as sent or close its ticket', async () => {
    (cache.bot as any).sendMessage = async () => {
      throw {error_code: 403, description: 'Forbidden: bot was blocked by the user'};
    };
    await chat(ctx);
    expect(events('staff_reply')).to.have.length(0);
    expect(events('staff_reply_failed')[0].error_reason).to.equal('bot_blocked');
    expect(db.getTicketByIdSync(ticket.id).status).to.equal('open');
    expect(db.getAiConversationHistory(ticket.id)).to.have.length(0);
    expect(alerts[0]).to.contain(`Тикет №${ticket.id}`);
    expect(alerts[0]).to.contain('заблокировал');
  });

  it('records success and auto-closes only after Telegram returns a message ID', async () => {
    (cache.bot as any).sendMessage = async () => {
      expect(events('staff_reply')).to.have.length(0);
      expect(db.getTicketByIdSync(ticket.id).status).to.equal('open');
      return {message_id: 700};
    };
    await chat(ctx);
    expect(events('staff_reply')).to.have.length(1);
    expect(db.getTicketByIdSync(ticket.id).status).to.equal('closed');
    expect(alerts).to.have.length(0);
  });

  it('rejects a missing Telegram message ID without a false private confirmation', async () => {
    ctx.chat = {id: 123, type: 'private'};
    ctx.message.chat = ctx.chat;
    (cache.bot as any).sendMessage = async (id: any, text: string) => {
      sent.push({id, text});
      return id === ticket.userid ? null : {message_id: 1};
    };
    await privateReply(ctx);
    expect(events('staff_reply')).to.have.length(0);
    expect(events('staff_reply_failed')).to.have.length(1);
    expect(sent.some(message => message.text === 'Отправлено')).to.equal(false);
    expect(sent.some(message => message.text.includes('не отправлен'))).to.equal(true);
  });

  it('uses the incoming message in private reply mode and confirms accepted delivery', async () => {
    await privateReply(ctx);
    expect(sent[0]).to.deep.equal({id: ticket.userid, text: 'Ответ'});
    expect(sent.at(-1)!.text).to.equal('Отправлено');
    expect(events('staff_reply')).to.have.length(1);
  });

  it('records a failed attachment and alerts the operators', async () => {
    ctx.message.photo = [{file_id: 'file-id'}];
    await fileHandler('photo', {sendPhoto: async () => {
      throw {error_code: 429, description: 'Too many requests'};
    }} as any, ctx);
    expect(events('staff_reply')).to.have.length(0);
    expect(events('staff_reply_failed')[0]).to.include({reason: 'file_photo', error_reason: 'rate_limit'});
    expect(alerts[0]).to.contain('ограничение частоты');
  });

  it('warns when a reply cannot be associated with a ticket', async () => {
    ctx.message.reply_to_message.text = 'Стороннее сообщение';
    await chat(ctx);
    expect(sent[0].text).to.contain('Не удалось определить тикет');
    expect(events('staff_reply')).to.have.length(0);
  });
});
