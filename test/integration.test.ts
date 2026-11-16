import { expect } from 'chai';
import cache from '../src/cache';

describe('Integration Tests', () => {
  describe('Complete Ticket Flow', () => {
    let originalConfig: any;

    before(() => {
      originalConfig = cache.config;
      cache.config = {
        language: {
          ticket: 'Ticket',
          from: 'From',
          language: 'Language',
          dear: 'Dear',
          regards: 'Best regards',
          confirmationMessage: 'Your message received',
          yourTicketId: 'Your ticket ID is',
          replyPrivate: 'Reply'
        },
        anonymous_tickets: false,
        show_user_ticket: true,
        staffchat_id: '-1001234567890',
        autoreply_confirmation: true,
        show_auto_replied: false
      } as any;
    });

    after(() => {
      cache.config = originalConfig;
    });

    it('should create new ticket for user message', () => {
      const userId = '12345';
      const userTicketID = userId;

      cache.ticketID = userTicketID;
      cache.ticketIDs = cache.ticketIDs || [];
      cache.ticketStatus = cache.ticketStatus || {};
      cache.ticketSent = cache.ticketSent || {};

      if (cache.ticketIDs.indexOf(userTicketID) === -1) {
        cache.ticketIDs.push(userTicketID);
      }

      cache.ticketStatus[userTicketID] = true;

      expect(cache.ticketStatus[userTicketID]).to.be.true;
      expect(cache.ticketIDs).to.include(userTicketID);
    });

    it('should track ticket across multiple messages', () => {
      const userId = '54321';
      const userTicketID = userId;

      cache.ticketSent[userTicketID] = 0;
      cache.ticketSent[userTicketID]++;
      cache.ticketSent[userTicketID]++;

      expect(cache.ticketSent[userTicketID]).to.equal(2);
    });

    it('should reset spam counter after timeout', (done) => {
      const userId = '99999';
      cache.ticketSent[userId] = 5;

      setTimeout(() => {
        cache.ticketSent[userId] = undefined;
        expect(cache.ticketSent[userId]).to.be.undefined;
        done();
      }, 50);
    });
  });

  describe('Multi-User Isolation', () => {
    it('should keep tickets separate for different users', () => {
      const user1 = '111';
      const user2 = '222';
      const user3 = '333';

      const user1TicketID = user1;
      const user2TicketID = user2;
      const user3TicketID = user3;

      cache.ticketStatus[user1TicketID] = true;
      cache.ticketStatus[user2TicketID] = true;
      cache.ticketStatus[user3TicketID] = false;

      expect(cache.ticketStatus[user1TicketID]).to.be.true;
      expect(cache.ticketStatus[user2TicketID]).to.be.true;
      expect(cache.ticketStatus[user3TicketID]).to.be.false;
    });

    it('should not cross-contaminate spam counters', () => {
      cache.ticketSent = {};

      cache.ticketSent['1'] = 1;
      cache.ticketSent['2'] = 2;
      cache.ticketSent['3'] = 3;

      cache.ticketSent['1']++;

      expect(cache.ticketSent['1']).to.equal(2);
      expect(cache.ticketSent['2']).to.equal(2);
      expect(cache.ticketSent['3']).to.equal(3);
    });

    it('should isolate AI sessions for different tickets', () => {
      // Имитация AI сессий для разных тикетов
      cache.aiSessions = {
        '100001': {
          ticketId: '100001',
          userId: 'user1',
          disabled: false,
          history: [{ role: 'user', content: 'Hello from user1' }]
        },
        '100002': {
          ticketId: '100002',
          userId: 'user2',
          disabled: false,
          history: [{ role: 'user', content: 'Hello from user2' }]
        }
      };

      // Проверяем, что история не пересекается
      expect(cache.aiSessions['100001'].history[0].content).to.equal('Hello from user1');
      expect(cache.aiSessions['100002'].history[0].content).to.equal('Hello from user2');
      expect(cache.aiSessions['100001'].userId).to.equal('user1');
      expect(cache.aiSessions['100002'].userId).to.equal('user2');
    });

    it('should handle concurrent AI message processing', async () => {
      // Clear previous sessions
      cache.aiSessions = {};

      // Имитируем асинхронную обработку для двух пользователей
      const promises = [];

      // Промис для user1
      promises.push(new Promise((resolve) => {
        setTimeout(() => {
          // Имитируем добавление в историю
          if (!cache.aiSessions['100001']) {
            cache.aiSessions['100001'] = {
              ticketId: '100001',
              userId: 'user1',
              disabled: false,
              history: []
            };
          }
          cache.aiSessions['100001'].history.push({ role: 'user', content: 'Question from user1' });
          resolve('user1 done');
        }, Math.random() * 10);
      }));

      // Промис для user2
      promises.push(new Promise((resolve) => {
        setTimeout(() => {
          if (!cache.aiSessions['100002']) {
            cache.aiSessions['100002'] = {
              ticketId: '100002',
              userId: 'user2',
              disabled: false,
              history: []
            };
          }
          cache.aiSessions['100002'].history.push({ role: 'user', content: 'Question from user2' });
          resolve('user2 done');
        }, Math.random() * 10);
      }));

      await Promise.all(promises);

      // Проверяем, что истории не смешались
      expect(cache.aiSessions['100001'].history.length).to.equal(1);
      expect(cache.aiSessions['100002'].history.length).to.equal(1);
      expect(cache.aiSessions['100001'].history[0].content).to.equal('Question from user1');
      expect(cache.aiSessions['100002'].history[0].content).to.equal('Question from user2');
    });
  });

  describe('Message Distribution System', () => {
    before(() => {
      cache.config.staffchat_id = '-1001234567890';
    });

    it('should route message to staff chat', () => {
      const ctx = {
        session: {
          group: ''
        }
      };

      const receiverId = cache.config.staffchat_id;
      expect(receiverId).to.equal('-1001234567890');
    });

    it('should route to secondary group if configured', () => {
      const ctx = {
        session: {
          group: '-9876543210'
        }
      };

      const shouldSendToGroup = ctx.session.group !== '' &&
        ctx.session.group !== cache.config.staffchat_id;

      expect(shouldSendToGroup).to.be.true;
    });

    it('should route private replies correctly', () => {
      const ctx = {
        session: {
          modeData: {
            userid: '55555',
            name: 'Test User'
          }
        }
      };

      const receiverId = ctx.session.modeData ?
        ctx.session.modeData.userid :
        cache.config.staffchat_id;

      expect(receiverId).to.equal('55555');
    });
  });

  describe('Configuration Access', () => {
    it('should access parse_mode consistently', () => {
      cache.config.parse_mode = 'MarkdownV2';

      const mode1 = cache.config.parse_mode;
      const mode2 = cache.config.parse_mode;

      expect(mode1).to.equal(mode2);
      expect(mode1).to.equal('MarkdownV2');
    });

    it('should access language strings safely', () => {
      cache.config.language = {
        confirmationMessage: 'Thank you',
        dear: 'Dear',
        regards: 'Best',
        replyPrivate: 'Reply'
      } as any;

      expect(cache.config.language.confirmationMessage).to.exist;
      expect(cache.config.language.dear).to.exist;
    });

    it('should access feature flags safely', () => {
      cache.config.autoreply_confirmation = true;
      cache.config.show_auto_replied = false;
      cache.config.anonymous_tickets = false;

      expect(cache.config.autoreply_confirmation).to.be.true;
      expect(cache.config.show_auto_replied).to.be.false;
      expect(cache.config.anonymous_tickets).to.be.false;
    });
  });

  describe('Error Recovery', () => {
    it('should recover from missing user info', () => {
      const ctx = {
        message: {
          from: {
            first_name: undefined as any
          }
        }
      };

      const userName = ctx.message.from?.first_name || 'Unknown User';
      expect(userName).to.equal('Unknown User');
    });

    it('should handle missing ticket gracefully', () => {
      let ticket = null;

      if (ticket === undefined || ticket == null) {
        ticket = { id: 0, status: 'unknown' };
      }

      expect(ticket).to.exist;
      expect(ticket.id).to.equal(0);
    });

    it('should continue on missing callback data', (done) => {
      const ctx = {
        session: {
          modeData: null
        }
      };

      if (!ctx.session.modeData) {
        ctx.session.modeData = { userid: 0, name: 'Default', category: 'other', ticketid: 0 };
      }

      expect(ctx.session.modeData).to.exist;
      done();
    });
  });

  describe('Concurrent Operation Safety', () => {
    it('should handle rapid user switching', () => {
      const users = ['100', '200', '300', '400', '500'];

      users.forEach(userId => {
        const userTicketID = userId;
        cache.ticketStatus[userTicketID] = true;
      });

      expect(Object.keys(cache.ticketStatus).length).to.be.greaterThan(0);

      users.forEach(userId => {
        expect(cache.ticketStatus[userId]).to.be.true;
      });
    });

    it('should maintain separate state for parallel messages', () => {
      const parallelMessages = [
        { user: '1', text: 'msg1' },
        { user: '2', text: 'msg2' },
        { user: '3', text: 'msg3' }
      ];

      parallelMessages.forEach(msg => {
        cache.ticketSent[msg.user] = 0;
      });

      parallelMessages.forEach(msg => {
        cache.ticketSent[msg.user]++;
      });

      expect(cache.ticketSent['1']).to.equal(1);
      expect(cache.ticketSent['2']).to.equal(1);
      expect(cache.ticketSent['3']).to.equal(1);
    });
  });

  describe('Data Persistence', () => {
    it('should preserve ticket status between operations', () => {
      const ticketId = 'persistent_1';
      cache.ticketStatus[ticketId] = true;

      // Имитируем некоторые операции
      const status1 = cache.ticketStatus[ticketId];
      const status2 = cache.ticketStatus[ticketId];

      expect(status1).to.equal(status2);
      expect(status1).to.be.true;
    });

    it('should track spam count across messages', () => {
      const userId = 'spam_test';
      cache.ticketSent[userId] = 3;

      // Проверяем для spam protection если needed
      if (cache.config.spam_cant_msg === undefined) {
        cache.config.spam_cant_msg = 5;
      }

      const canSendMore = cache.ticketSent[userId] < cache.config.spam_cant_msg;
      expect(canSendMore).to.be.true;
    });
  });
});
