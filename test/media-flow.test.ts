import {expect} from 'chai';
import cache from '../src/cache';
import * as db from '../src/db';
import {clearAiSession, setAiShutdownState} from '../src/ai';
import TelegramAddon from '../src/addons/telegram';
import {main} from '../src/index';

describe('Telegram private attachment pipeline', () => {
  for (const type of ['photo', 'video', 'document'] as const) {
    it(`creates and mirrors a ${type} from an owner without a getFile download`, async () => {
      const originalConfig = cache.config;
      const originalBot = cache.bot;
      const userId = 8800000 + ['photo', 'video', 'document'].indexOf(type);
      const calls: Array<{method: string; payload: any}> = [];
      cache.config = {...originalConfig, owner_id: String(userId), owner_ids: [],
        staffchat_id: '-1008800000', categories: [], anonymous_tickets: false,
        dev_mode: false, ai: {...originalConfig.ai, enabled: false},
        support: {...originalConfig.support, custom_emoji: false}};
      setAiShutdownState(false);
      const bot = new TelegramAddon('123456:TEST_TOKEN');
      bot.api.config.use(async (_previous: any, method: string, payload: any) => {
        calls.push({method, payload});
        if (method === 'getFile') throw new Error('getFile must not be needed to forward media');
        if (method === 'getMe') return {ok: true, result: {
          id: 123456, is_bot: true, first_name: 'Test', username: 'test_support_bot',
        }};
        return {ok: true, result: {message_id: 900 + calls.length, date: 1791280000,
          chat: {id: Number(payload.chat_id), type: Number(payload.chat_id) < 0 ? 'supergroup' : 'private'},
          text: payload.text, caption: payload.caption}};
      });
      try {
        await bot.init();
        main(bot, false);
        const attachment = {file_id: `${type}-id`, file_unique_id: `${type}-unique`,
          width: 100, height: 100, duration: 1};
        await bot.bot.handleUpdate({update_id: userId, message: {
          message_id: userId, date: 1791280000,
          chat: {id: userId, type: 'private', first_name: 'Tester'},
          from: {id: userId, is_bot: false, first_name: 'Tester'},
          [type]: type === 'photo' ? [attachment] : attachment,
        }} as any);
        const ticket = db.getOpenSync(userId, null);
        expect(ticket).to.exist;
        expect(ticket.stage).to.equal('waiting_operator');
        const forwarded = calls.find(call => call.method === `send${type[0].toUpperCase()}${type.slice(1)}`);
        expect(forwarded).to.exist;
        expect(forwarded!.payload.chat_id).to.equal('-1008800000');
        expect(forwarded!.payload[type]).to.equal(`${type}-id`);
        expect(forwarded!.payload.caption).to.contain(`<code>${userId}</code>`);
        expect(db.getStaffTicket(ticket.id).question).to.contain('без подписи');
        const messageId = 900 + calls.indexOf(forwarded!) + 1;
        expect(db.getTicketByTelegramMessage('-1008800000', messageId).id).to.equal(ticket.id);
        expect(calls.some(call => call.method === 'getFile')).to.equal(false);
        expect(calls.some(call => call.method === 'sendMessage' &&
          call.payload.text === '📎 Вложение передано специалисту.')).to.equal(true);
      } finally {
        const ticket = db.getOpenSync(userId, null);
        if (ticket) {
          db.closeTicketById(ticket.id, 'test_cleanup');
          clearAiSession(String(ticket.id));
        }
        cache.config = originalConfig;
        cache.bot = originalBot;
      }
    });
  }
});
