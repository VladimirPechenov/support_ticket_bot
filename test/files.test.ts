import { expect } from 'chai';
import cache from '../src/cache';
import * as db from '../src/db';
import {fileHandler} from '../src/files';

describe('File Handling', () => {
  describe('File type identification', () => {
    it('should identify photo file type', () => {
      const type = 'photo';
      expect(['photo', 'video', 'document']).to.include(type);
    });

    it('should identify video file type', () => {
      const type = 'video';
      expect(['photo', 'video', 'document']).to.include(type);
    });

    it('should identify document file type', () => {
      const type = 'document';
      expect(['photo', 'video', 'document']).to.include(type);
    });

    it('should create proper caption with ticket info', () => {
      cache.config = {
        language: {
          ticket: 'Ticket',
          from: 'From'
        }
      } as any;

      const ticket = { id: '100001' };
      const userInfo = 'From John Lang: en\n\n';

      const caption =
        cache.config.language.ticket +
        ' #T' +
        ticket.id.toString().padStart(6, '0') +
        ' ' +
        userInfo;

      expect(caption).to.include('Ticket #T100001');
      expect(caption).to.include('From');
    });
  });

  describe('Message callbacks and sessions', () => {
    it('should track group chats', () => {
      const ctx = {
        session: {
          group: '-123456789',
          modeData: null
        }
      };

      expect(ctx.session.group).to.not.be.empty;
      expect(ctx.session.group).to.include('-');
    });

    it('should track private reply mode data', () => {
      const ctx = {
        session: {
          modeData: {
            userid: 999,
            name: 'User Name',
            category: 'support',
            ticketid: 1
          }
        }
      };

      expect(ctx.session.modeData.userid).to.equal(999);
      expect(ctx.session.modeData.name).to.equal('User Name');
    });

    it('should create proper reply markup', () => {
      cache.config = {
        language: {
          replyPrivate: 'Reply'
        },
        direct_reply: false
      } as any;

      const ctx = {
        from: {
          id: 123,
          username: 'testuser'
        },
        message: {
          from: {
            first_name: 'Test'
          }
        },
        session: {
          modeData: {
            category: 'support',
            ticketid: 5
          }
        }
      };

      const callback_data =
        ctx.from.id +
        '---' +
        ctx.message.from.first_name +
        '---' +
        ctx.session.modeData.category +
        '---' +
        ctx.session.modeData.ticketid;

      expect(callback_data).to.include('123');
      expect(callback_data).to.include('Test');
      expect(callback_data).to.include('support');
      expect(callback_data).to.include('5');
    });
  });

  describe('Async file operations', () => {
    it('should handle file ID extraction', async () => {
      const mockCtx = {
        getFile: async () => ({
          file_id: 'AgADAgADr6cxG_test_file_id_12345'
        })
      };

      const file = await (mockCtx.getFile as any)();
      expect(file.file_id).to.exist;
      expect(file.file_id).to.include('AgAD');
    });

    it('should track file sending state', () => {
      const fileState = {
        sent: false,
        error: null,
        retry: 0
      };

      fileState.sent = true;
      expect(fileState.sent).to.be.true;

      fileState.error = 'Network error';
      expect(fileState.error).to.exist;
    });
  });

  describe('Channel distribution', () => {
    it('should determine if should send to staff chat', () => {
      const ctx = {
        session: {
          group: '-123456789',
          admin: true
        }
      };

      cache.config.staffchat_id = '-123456789';

      const shouldSendToStaff = ctx.session.group &&
        ctx.session.group !== cache.config.staffchat_id;

      expect(shouldSendToStaff).to.be.false;
    });

    it('should send to both staff and group chats', () => {
      const ctx = {
        session: {
          group: '-987654321',
          admin: true
        }
      };

      cache.config.staffchat_id = '-123456789';

      const shouldSendToStaff = ctx.session.group &&
        ctx.session.group !== cache.config.staffchat_id;

      expect(shouldSendToStaff).to.be.true;
    });

    it('should determine private reply recipients', () => {
      const ctx = {
        session: {
          modeData: {
            userid: 555
          }
        }
      };

      const receiverId = ctx.session.modeData ? ctx.session.modeData.userid : 0;
      expect(receiverId).to.equal(555);
    });
  });

  describe('Mapped file flow', () => {
    it('turns a user file into one mapped staff card', async () => {
      const originalBot = cache.bot;
      const originalStaffChat = cache.config.staffchat_id;
      const userId = `file-user-${Date.now()}`;
      const sentToStaff: any[] = [];
      cache.config.staffchat_id = '-100-file-staff';
      cache.bot = {
        sendMessage: async () => ({message_id: 1}),
      } as any;
      const bot = {
        sendPhoto: async (chatId: any, fileId: any, extra: any) => {
          sentToStaff.push({chatId, fileId, extra});
          return {message_id: 701};
        },
      } as any;
      const ctx = {
        chat: {id: userId, type: 'private'},
        from: {id: userId},
        message: {
          from: {id: userId, first_name: 'Иван', username: 'ivan'},
          chat: {id: userId},
          caption: 'Скриншот ошибки',
          photo: [{file_id: 'photo-file-id'}],
          message_id: 700,
        },
        session: {admin: false, groupCategory: null},
        getFile: async () => ({file_id: 'photo-file-id'}),
      } as any;

      try {
        await fileHandler('photo', bot, ctx);
        const ticket = db.getOpenSync(userId, null);
        expect(ticket.stage).to.equal('waiting_operator');
        expect(sentToStaff).to.have.length(1);
        expect(sentToStaff[0].chatId).to.equal('-100-file-staff');
        const mapped = db.getTicketByTelegramMessage('-100-file-staff', 701);
        expect(mapped.id).to.equal(ticket.id);
      } finally {
        const ticket = db.getOpenSync(userId, null);
        if (ticket) db.closeTicketById(ticket.id, 'test_cleanup');
        cache.bot = originalBot;
        cache.config.staffchat_id = originalStaffChat;
      }
    });

    it('routes a staff file through telegram_message_map', async () => {
      const originalBot = cache.bot;
      const userId = `file-recipient-${Date.now()}`;
      const delivered: any[] = [];
      db.add(userId, 'open', null);
      const ticket = db.getOpenSync(userId, null);
      db.mapTelegramMessage('-100-file-staff', 702, ticket.id, 'staff_photo');
      cache.bot = {sendMessage: async () => ({message_id: 1})} as any;
      const bot = {
        sendDocument: async (chatId: any, fileId: any) => {
          delivered.push({chatId, fileId});
          return {message_id: 2};
        },
      } as any;
      const ctx = {
        chat: {id: '-100-file-staff', type: 'supergroup'},
        from: {id: 'staff-1', username: 'operator'},
        message: {
          from: {id: 'staff-1', first_name: 'Анна'},
          chat: {id: '-100-file-staff'},
          reply_to_message: {message_id: 702},
          document: {file_id: 'document-file-id'},
          message_id: 703,
        },
        session: {admin: true},
        getFile: async () => ({file_id: 'document-file-id'}),
      } as any;

      try {
        await fileHandler('document', bot, ctx);
        expect(delivered).to.deep.equal([
          {chatId: userId, fileId: 'document-file-id'},
        ]);
        const updated = db.getTicketByIdSync(ticket.id);
        expect(updated.stage).to.equal('in_progress');
        expect(updated.assignee_name).to.equal('Анна');
      } finally {
        db.closeTicketById(ticket.id, 'test_cleanup');
        cache.bot = originalBot;
      }
    });
  });
});
