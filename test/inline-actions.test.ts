import {expect} from 'chai';
import cache from '../src/cache';
import * as db from '../src/db';
import {callbackQuery} from '../src/inline';

describe('Inline staff actions', () => {
  it('closes one ticket without a duplicate staff notification', async () => {
    const originalBot = cache.bot;
    const originalStaffChat = cache.config.staffchat_id;
    const originalTicketClosed = cache.config.language.ticketClosed;
    const sent: Array<{id: string | number; text: string}> = [];
    const userId = `inline-close-${Date.now()}`;

    cache.config.staffchat_id = '-100-admin';
    cache.config.language.ticketClosed = 'Ваш тикет закрыт';
    cache.bot = {
      sendMessage: async (id: string | number, text: string) => {
        sent.push({id, text});
        return {message_id: sent.length};
      },
    } as any;

    try {
      db.add(userId, 'open', 'inline-test');
      const tickets = await new Promise<any[]>((resolve) => {
        db.check(userId, null, resolve);
      });
      const ticket = tickets[tickets.length - 1];
      let callbackAnswer: any = null;
      const ctx = {
        chat: {id: cache.config.staffchat_id, type: 'supergroup'},
        callbackQuery: {
          data: `AI_CLOSE---${ticket.id}`,
          from: {id: 'staff-user'},
        },
        session: {admin: true},
        answerCallbackQuery: async (options: any) => {
          callbackAnswer = options;
        },
      } as any;

      await callbackQuery(ctx);

      expect(callbackAnswer.text).to.equal('Тикет закрыт');
      expect(sent.some(message => message.id === '-100-admin')).to.equal(false);
      expect(sent.some(message => message.id === userId)).to.equal(true);
      const updatedTicket = await new Promise<any>((resolve) => {
        db.getId(ticket.id, resolve);
      });
      expect(updatedTicket.status).to.equal('closed');
    } finally {
      cache.bot = originalBot;
      cache.config.staffchat_id = originalStaffChat;
      cache.config.language.ticketClosed = originalTicketClosed;
    }
  });

  it('requires confirmation to reassign a taken ticket and can return it to AI', async () => {
    const originalBot = cache.bot;
    const originalAi = cache.config.ai;
    const userId = `inline-take-${Date.now()}`;
    const sent: Array<string | number> = [];
    cache.config.ai = {
      enabled: true,
      handoff: {
        user_message_staff_stop: 'Оператор подключился.',
      },
    };
    cache.bot = {
      api: {sendMessage: async () => ({message_id: 100})},
      sendMessage: async (id: string | number) => {
        sent.push(id);
        return {message_id: sent.length};
      },
    } as any;
    db.add(userId, 'open', null);
    const ticket = db.getOpenSync(userId, null);
    cache.aiSessions[String(ticket.id)] = {
      ticketId: String(ticket.id),
      userId,
      disabled: false,
      history: [],
      runId: 'active-run',
    } as any;

    const invoke = async (action: string, staffId: string, name: string) => {
      let answer: any;
      await callbackQuery({
        chat: {id: cache.config.staffchat_id, type: 'supergroup'},
        callbackQuery: {
          data: `${action}---${ticket.id}`,
          from: {id: staffId, first_name: name},
        },
        session: {admin: true},
        answerCallbackQuery: async (value: any) => { answer = value; },
      } as any);
      return answer;
    };

    try {
      expect((await invoke('AI_TAKE', 'staff-1', 'Анна')).text)
        .to.equal('Тикет взят');
      expect((await invoke('AI_TAKE', 'staff-2', 'Борис')).text)
        .to.equal('Подтвердите переназначение');
      expect(db.getTicketByIdSync(ticket.id).assignee_name).to.equal('Анна');
      // Confirmation is bound to the assignee at the time of the prompt.
      const confirmed = await callbackQuery({
        chat: {id: cache.config.staffchat_id, type: 'supergroup'},
        callbackQuery: {
          data: `AI_REASSIGN---${ticket.id}---staff-1`,
          from: {id: 'staff-2', first_name: 'Борис'},
        },
        session: {admin: true},
        answerCallbackQuery: async () => undefined,
      } as any);
      expect(confirmed).to.equal(undefined);
      expect((await invoke('AI_TAKE', 'staff-3', 'Сергей')).text)
        .to.equal('Подтвердите переназначение');
      expect((await invoke('AI_TAKE', 'staff-2', 'Борис')).text)
        .to.equal('Тикет уже у вас');
      const assigned = db.getTicketByIdSync(ticket.id);
      expect(assigned.stage).to.equal('in_progress');
      expect(assigned.assignee_name).to.equal('Борис');
      expect(sent.filter(id => id === userId)).to.have.length(1);
      expect(cache.aiSessions[String(ticket.id)].runId)
        .not.to.equal('active-run');

      expect((await invoke('AI_RESUME', 'staff-2', 'Борис')).text)
        .to.equal('ИИ возвращён');
      const resumed = db.getTicketByIdSync(ticket.id);
      expect(resumed.stage).to.equal('ai_active');
      expect(resumed.ai_enabled).to.equal(1);
    } finally {
      delete cache.aiSessions[String(ticket.id)];
      db.closeTicketById(ticket.id, 'test_cleanup');
      cache.bot = originalBot;
      cache.config.ai = originalAi;
    }
  });

  it('shows metadata-only diagnostics to an admin', async () => {
    const runId = `diag-${Date.now()}`;
    db.createAiRun({runId, mode: 'full', startedAt: Date.now() - 5000});
    db.recordProviderAttempt({
      runId,
      provider: 'gemini',
      model: 'gemini-3.1-flash-lite',
      outcome: 'failure',
      errorReason: 'rate_limit',
      statusCode: 429,
      latencyMs: 100,
    });
    db.recordProviderAttempt({
      runId,
      provider: 'mistral',
      model: 'mistral-small-2603',
      outcome: 'success',
      isFallback: true,
      latencyMs: 4000,
    });
    db.finishAiRun(runId, {
      status: 'answered',
      route: 'fallback',
      ragStatus: 'hit',
      sourceCount: 1,
      latencyMs: 4200,
    });
    let answer: any;

    await callbackQuery({
      chat: {id: cache.config.staffchat_id, type: 'supergroup'},
      callbackQuery: {
        data: `AI_DIAG---42---${runId}`,
        from: {id: 'staff-admin'},
      },
      session: {admin: true},
      answerCallbackQuery: async (value: any) => { answer = value; },
    } as any);

    expect(answer.show_alert).to.equal(true);
    expect(answer.text).to.contain('Gemini → Mistral (квота)');
    expect(answer.text.length).to.be.at.most(190);
    expect(answer.text).not.to.contain('gemini-3.1-flash-lite');
  });

  it('protects diagnostics while allowing the configured owner', async () => {
    const originalOwner = cache.config.owner_id;
    const runId = `owner-${Date.now()}`;
    db.createAiRun({runId, mode: 'rag_only'});
    db.finishAiRun(runId, {
      status: 'direct_rag',
      route: 'direct_rag',
      ragStatus: 'hit',
    });

    const invoke = async (userId: string) => {
      let answer: any;
      await callbackQuery({
        chat: {id: cache.config.staffchat_id, type: 'supergroup'},
        callbackQuery: {
          data: `AI_DIAG---42---${runId}`,
          from: {id: userId},
        },
        session: {admin: false},
        answerCallbackQuery: async (value: any) => { answer = value; },
      } as any);
      return answer;
    };

    try {
      cache.config.owner_id = 'configured-owner';
      expect((await invoke('stranger')).text).to.equal('Недостаточно прав');
      expect((await invoke('configured-owner')).text)
        .to.contain('Локальный RAG');
    } finally {
      cache.config.owner_id = originalOwner;
    }
  });

  it('does not reopen a closed ticket through a stale resume callback', async () => {
    const userId = `inline-stale-${Date.now()}`;
    db.add(userId, 'open', null);
    const ticket = db.getOpenSync(userId, null);
    db.closeTicketById(ticket.id, 'test_closed');
    let answer: any;

    await callbackQuery({
      chat: {id: cache.config.staffchat_id, type: 'supergroup'},
      callbackQuery: {
        data: `AI_RESUME---${ticket.id}`,
        from: {id: 'staff-admin'},
      },
      session: {admin: true},
      answerCallbackQuery: async (value: any) => { answer = value; },
    } as any);

    expect(answer.text).to.equal('Тикет уже закрыт');
    expect(db.getTicketByIdSync(ticket.id).status).to.equal('closed');
  });
});
