import { expect } from 'chai';
import * as middleware from '../src/middleware';
import cache from '../src/cache';

describe('Middleware Functions', () => {
  describe('strictEscape() function', () => {
    before(() => {
      cache.config.parse_mode = 'MarkdownV2';
    });

    it('should escape special characters for MarkdownV2', () => {
      const input = 'Text [with] _special_ chars!';
      const result = middleware.strictEscape(input);

      expect(result).to.include('\\[');
      expect(result).to.include('\\]');
      expect(result).to.include('\\_');
    });

    it('should not escape if parse_mode is not MarkdownV2', () => {
      cache.config.parse_mode = 'HTML';
      const input = 'Text [with] chars';
      const result = middleware.strictEscape(input);

      expect(result).to.equal('Text [with] chars');
    });
  });

  describe('escapeText() function', () => {
    it('should escape HTML special characters', () => {
      cache.config.parse_mode = 'HTML';
      const input = '<script>alert("xss")</script>';
      const result = middleware.escapeText(input);

      expect(result).to.include('&lt;');
      expect(result).to.include('&gt;');
      expect(result).to.include('&quot;');
    });

    it('should escape Markdown special characters', () => {
      cache.config.parse_mode = 'MarkdownV2';
      const input = 'Text with # hash = equals';
      const result = middleware.escapeText(input);

      expect(result).to.include('\\#');
      expect(result).to.include('\\=');
    });

    it('should safely escape MarkdownV2 characters in URLs', () => {
      cache.config.parse_mode = 'MarkdownV2';
      const input = 'Check (https://example.com?id=123&name=test)';
      const result = middleware.escapeText(input);

      expect(result).to.include('example\\.com?id\\=123&name\\=test');
    });

    it('should handle empty strings', () => {
      const result = middleware.escapeText('');
      expect(result).to.equal('');
    });

    it('should handle undefined input', () => {
      const result = middleware.escapeText(undefined as any);
      expect(result).to.equal('');
    });
  });

  describe('msg() function', () => {
    it('should not throw error when sending message', () => {
      cache.bot = {
        sendMessage: (id: any, msg: any, extra: any) => {
          return Promise.resolve();
        }
      } as any;

      expect(() => {
        middleware.msg('123456', 'Test message');
      }).to.not.throw();
    });

    it('should apply parse_mode from config', () => {
      cache.config.parse_mode = 'HTML';
      cache.bot = {
        sendMessage: (id: any, msg: any, extra: any) => {
          expect(extra.parse_mode).to.equal('HTML');
          return Promise.resolve();
        }
      } as any;

      middleware.msg('123456', 'Test with parse mode');
    });

    it('preserves trusted HTML without leaking the internal option', async () => {
      cache.config.parse_mode = 'HTML';
      let sentText = '';
      let sentExtra: any;
      cache.bot = {
        sendMessage: async (_id: any, text: string, extra: any) => {
          sentText = text;
          sentExtra = extra;
        },
      } as any;

      await middleware.msg('123456', '<b>Безопасная карточка</b>', {
        parse_mode: 'HTML',
        already_formatted: true,
      });

      expect(sentText).to.equal('<b>Безопасная карточка</b>');
      expect(sentExtra).to.deep.equal({parse_mode: 'HTML'});
    });
  });

  describe('reply() function', () => {
    it('should call msg with chat id from context', () => {
      const ctx = {
        message: {
          chat: {
            id: '999888'
          }
        }
      };

      cache.bot = {
        sendMessage: (id: any) => {
          expect(id).to.equal('999888');
          return Promise.resolve();
        }
      } as any;

      middleware.reply(ctx as any, 'Reply message');
    });

    it('should apply custom extra parameters', () => {
      const ctx = {
        message: {
          chat: {
            id: '111222'
          }
        }
      };

      const extra = { parse_mode: 'MarkdownV2' };

      cache.bot = {
        sendMessage: (id: any, msg: any, sentExtra: any) => {
          expect(sentExtra.parse_mode).to.equal('MarkdownV2');
          return Promise.resolve();
        }
      } as any;

      middleware.reply(ctx as any, 'Message', extra);
    });
  });
});
