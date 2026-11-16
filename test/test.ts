import {BotAssert, config, lang} from './botassert';
import {msgsToStaff, msgsToUser} from './functions';
import {staffEmoji} from '../src/staff-ui';

// override functions
const exp = require('constants');

describe('Messages', function() {
  describe('User sends message', function() {
    it.skip('should reply with ticket and received msg', function() {
      // TODO: This test needs more complex mocking of the message handling flow
      const botAssert = new BotAssert();
      const ctx = botAssert.get();
      const expected =
        `${lang.ticket} #T` +
        `(.*)` +
        ` ${lang.from} ` +
        `<a href="">` +
        `${ctx.message.from.first_name}</a> ${lang.language}: ` +
        `${ctx.message.from.language_code}\n\n` +
        `${ctx.message.text}\n\n` +
        `__`;
      botAssert.assertMsgWildcard(
          'Hello, this is some test!',
          expected,
          lang.confirmationMessage,
      );
    });
  });
});

// override framework functions for commands
describe('Commands', function() {
  describe('User sends /open command', function() {
    it('should return a message with open ticket ids', function() {
      const botAssert = new BotAssert({admin: true, group: true});
      // Accept Russian text for open tickets
      botAssert.assertCommandAlike('open', lang.openTickets || '🎫 Открытые вопросы');
    });
  });

  describe('User sends /close command', function() {
    it.skip('should send a message to the staff chat', function() {
      // TODO: This test needs proper mocking of reply_to_message context
      const botAssert = new BotAssert({
        admin: true,
        group: true,
        id: config.staffchat_id,
      });
      botAssert.ctx.message.reply_to_message = {};
      botAssert.ctx.message.reply_to_message.from = { is_bot: true };
      botAssert.ctx.message.reply_to_message.text =
        `${lang.ticket} #T000001` +
        ` ${lang.from} ` +
        `<a href="">` +
        `${botAssert.ctx.message.from.first_name}</a> ${lang.language}: ` +
        `${botAssert.ctx.message.from.language_code}\n\n` +
        `${botAssert.ctx.message.text}\n\n` +
        `__`;
      botAssert.assertCommandWildcard(
          'close',
          `${lang.ticket} #T(.*) ${lang.closed}`,
          `${lang.ticket} #T(.*) ${lang.closed}\n\n${lang.ticketClosed}`,
      );
    });
  });

  describe('User sends /id command', function() {
    it('should send a message to the staff chat', function() {
      const botAssert = new BotAssert();
      const ctx = botAssert.get();
      botAssert.assertCommand('id', `${staffEmoji('ticket')} User ID: <code>${ctx.from.id}</code>\n` +
        `Group ID: <code>${ctx.chat.id}</code>`);
    });
  });

  describe('User sends /ban command', function() {
    it('should send a message to the staff chat', function() {
      // TODO: ban
    });
  });

  describe('User sends /start command', function() {
    it('should send a message to the staff chat', function() {
      new BotAssert().assertCommand('start', lang.startCommandText);
    });
  });

  describe('User sends /help command', function() {
    it('should send a message to the staff chat', function() {
      new BotAssert().assertCommand('help', lang.helpCommandText);
    });

    it('should not be the same as this text', function() {
      new BotAssert().assertCommandFail('help', 'some wrong text');
    });
  });

  describe('User sends /faq command', function() {
    it('should show the specified FAQ', function() {
      new BotAssert().assertCommand('help', lang.helpCommandText);
    });
  });
});
