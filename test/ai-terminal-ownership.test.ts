import {expect} from 'chai';
import cache from '../src/cache';
import * as ai from '../src/ai';
import * as db from '../src/db';
import * as middleware from '../src/middleware';
import * as commands from '../src/commands';
import {
  getAiMetricsSnapshot,
  resetAiMetrics,
} from '../src/ai-metrics';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return {promise, resolve};
}

function context(userId: string, text: string): any {
  return {
    chat: {id: userId, type: 'private'},
    message: {
      text,
      chat: {id: userId, type: 'private'},
      from: {id: userId, first_name: 'Тест'},
    },
  };
}

describe('AI terminal ownership', () => {
  let originalAi: any;
  let originalBot: any;
  let originalMsg: any;
  let originalMsgWithId: any;
  let originalParseMode: any;
  let originalStaffChat: any;
  let originalSupport: any;
  let originalSessions: any;

  beforeEach(() => {
    originalAi = cache.config.ai;
    originalBot = cache.bot;
    originalMsg = (middleware as any).msg;
    originalMsgWithId = (middleware as any).msgWithId;
    originalParseMode = cache.config.parse_mode;
    originalStaffChat = cache.config.staffchat_id;
    originalSupport = cache.config.support;
    originalSessions = cache.aiSessions;
    cache.aiSessions = {} as any;
    cache.config.parse_mode = 'none';
    cache.config.staffchat_id = '-100-terminal-owner-test';
    ai.setAiShutdownState(false);
    resetAiMetrics();
  });

  afterEach(() => {
    cache.config.ai = originalAi;
    cache.bot = originalBot;
    (middleware as any).msg = originalMsg;
    (middleware as any).msgWithId = originalMsgWithId;
    cache.config.parse_mode = originalParseMode;
    cache.config.staffchat_id = originalStaffChat;
    cache.config.support = originalSupport;
    cache.aiSessions = originalSessions;
    ai.setAiShutdownState(false);
  });

  it('does not commit a direct answer when a newer run takes ownership during Telegram edit', async () => {
    const userId = `terminal-answer-${Date.now()}`;
    db.add(userId, 'open', null);
    const ticket = db.getOpenSync(userId, null);
    const finalEditStarted = deferred<void>();
    const releaseFinalEdit = deferred<void>();
    const edits: Array<{messageId: number; text: string}> = [];
    let firstEdit = true;

    cache.config.ai = {
      enabled: true,
      mode: 'rag_only',
      user_parse_mode: 'none',
      off_topic: {enabled: false},
      rag: {
        enabled: true,
        vector_db: 'qdrant',
        qdrant: {max_context_docs: 3},
      },
    } as any;
    cache.config.support = {
      ...(originalSupport || {}),
      mirror_ai_dialogs: false,
    };
    (middleware as any).msgWithId = async () => 700;
    (middleware as any).msg = async () => ({message_id: 701});
    cache.bot = {
      api: {
        editMessageText: async (
          _chatId: string | number,
          messageId: number,
          text: string,
        ) => {
          edits.push({messageId, text});
          if (firstEdit) {
            firstEdit = false;
            finalEditStarted.resolve();
            await releaseFinalEdit.promise;
          }
          return true;
        },
        deleteMessage: async () => true,
      },
    } as any;

    try {
      const handling = ai.handleUserMessage(
        context(userId, 'Как восстановить пароль?'),
        ticket,
      );
      await finalEditStarted.promise;

      const session = cache.aiSessions[String(ticket.id)];
      const oldRunId = session.runId as string;
      const oldController = session.abortController as AbortController;
      const newController = new AbortController();
      oldController.abort('superseded_by_new_message');
      session.runId = 'newer-run-owner';
      session.abortController = newController;
      session.processingMessageId = 702;
      releaseFinalEdit.resolve();

      await handling;

      expect(session.runId).to.equal('newer-run-owner');
      expect(session.abortController).to.equal(newController);
      expect(newController.signal.aborted).to.equal(false);
      expect(session.history).to.deep.equal([{
        role: 'user', content: 'Как восстановить пароль?',
      }]);
      expect(session.lastAnswer).to.equal(undefined);
      expect(getAiMetricsSnapshot().answerModes.directRag).to.equal(0);
      expect(db.getAiRunDiagnostics(oldRunId)?.run.status)
        .to.equal('cancelled');
      expect(edits.some(edit =>
        edit.messageId === 700 &&
        edit.text === 'Обрабатываю ваше более новое сообщение.',
      )).to.equal(true);
    } finally {
      delete cache.aiSessions[String(ticket.id)];
      db.closeTicketById(ticket.id, 'test_cleanup');
    }
  });

  it('does not let a stale pre-handoff run abort the newer controller', async () => {
    const userId = `terminal-handoff-${Date.now()}`;
    db.add(userId, 'open', null);
    const ticket = db.getOpenSync(userId, null);
    const staffSendStarted = deferred<void>();
    const releaseStaffSend = deferred<number>();
    const userMessages: string[] = [];

    cache.config.ai = {
      enabled: true,
      mode: 'rag_only',
      handoff: {keywords: ['оператор']},
      off_topic: {enabled: false},
    } as any;
    cache.config.support = {
      ...(originalSupport || {}),
      mirror_ai_dialogs: true,
    };
    (middleware as any).msgWithId = async () => {
      staffSendStarted.resolve();
      return releaseStaffSend.promise;
    };
    (middleware as any).msg = async (
      _chatId: string | number,
      text: string,
    ) => {
      userMessages.push(text);
      return {message_id: 801};
    };
    cache.bot = {
      api: {
        editMessageText: async () => true,
      },
    } as any;

    try {
      const handling = ai.handleUserMessage(
        context(userId, 'Позовите оператора'),
        ticket,
      );
      await staffSendStarted.promise;

      const session = cache.aiSessions[String(ticket.id)];
      const oldController = session.abortController as AbortController;
      const newController = new AbortController();
      oldController.abort('superseded_by_new_message');
      session.runId = 'newer-handoff-owner';
      session.abortController = newController;
      releaseStaffSend.resolve(800);

      await handling;

      expect(session.runId).to.equal('newer-handoff-owner');
      expect(session.abortController).to.equal(newController);
      expect(newController.signal.aborted).to.equal(false);
      expect(session.disabled).to.equal(false);
      expect(session.lastHandoff).to.equal(undefined);
      expect(userMessages).to.deep.equal([]);
      expect(db.getTicketByIdSync(ticket.id).stage)
        .not.to.equal('waiting_operator');
    } finally {
      delete cache.aiSessions[String(ticket.id)];
      db.closeTicketById(ticket.id, 'test_cleanup');
    }
  });

  it('invalidates the owned run synchronously before handoff Telegram awaits', async () => {
    const userId = `terminal-current-handoff-${Date.now()}`;
    db.add(userId, 'open', null);
    const ticket = db.getOpenSync(userId, null);
    const handoffSendStarted = deferred<void>();
    const releaseHandoffSend = deferred<void>();
    let sendCalls = 0;

    cache.config.ai = {
      enabled: true,
      mode: 'rag_only',
      handoff: {keywords: ['оператор']},
      off_topic: {enabled: false},
    } as any;
    cache.config.support = {
      ...(originalSupport || {}),
      mirror_ai_dialogs: false,
    };
    (middleware as any).msg = async () => {
      sendCalls++;
      if (sendCalls === 1) handoffSendStarted.resolve();
      await releaseHandoffSend.promise;
      return {message_id: 901 + sendCalls};
    };
    cache.bot = {api: {}} as any;

    try {
      const handling = ai.handleUserMessage(
        context(userId, 'Позовите оператора'),
        ticket,
      );
      const session = cache.aiSessions[String(ticket.id)];
      const activeRunId = session.runId;
      const activeController = session.abortController as AbortController;

      await handoffSendStarted.promise;

      expect(activeController.signal.aborted).to.equal(true);
      expect(session.abortController).to.equal(undefined);
      expect(session.runId).not.to.equal(activeRunId);
      expect(session.disabled).to.equal(true);
      expect(session.lastHandoff).to.equal('user_request');
      expect(db.getTicketByIdSync(ticket.id).stage)
        .to.equal('waiting_operator');

      releaseHandoffSend.resolve();
      await handling;
    } finally {
      releaseHandoffSend.resolve();
      delete cache.aiSessions[String(ticket.id)];
      db.closeTicketById(ticket.id, 'test_cleanup');
    }
  });

  it('cancels an older run even when the newer message is outside AI rollout', async () => {
    const userId = `terminal-runtime-off-${Date.now()}`;
    db.add(userId, 'open', null);
    const ticket = db.getOpenSync(userId, null);
    const controller = new AbortController();
    cache.config.ai = {enabled: true, mode: 'off'} as any;
    cache.aiSessions[String(ticket.id)] = {
      ticketId: String(ticket.id),
      userId,
      disabled: false,
      history: [],
      runId: 'older-run',
      abortController: controller,
    };

    try {
      const handled = await ai.handleUserMessage(
        context(userId, 'Новое сообщение для оператора'),
        ticket,
      );

      const session = cache.aiSessions[String(ticket.id)];
      expect(handled).to.equal(false);
      expect(controller.signal.aborted).to.equal(true);
      expect(session.abortController).to.equal(undefined);
      expect(session.runId).not.to.equal('older-run');
    } finally {
      delete cache.aiSessions[String(ticket.id)];
      db.closeTicketById(ticket.id, 'test_cleanup');
    }
  });

  it('aborts and removes an active session when it is cleared', () => {
    const controller = new AbortController();
    cache.aiSessions['clear-session-ticket'] = {
      ticketId: 'clear-session-ticket',
      userId: 'clear-session-user',
      disabled: false,
      history: [],
      runId: 'clear-session-run',
      abortController: controller,
    };

    ai.clearAiSession('clear-session-ticket', 'test_session_cleared');

    expect(controller.signal.aborted).to.equal(true);
    expect(controller.signal.reason).to.equal('test_session_cleared');
    expect(cache.aiSessions['clear-session-ticket']).to.equal(undefined);
  });

  it('rejects a stale open snapshot after staff already closed the ticket', async () => {
    const userId = `terminal-stale-ticket-${Date.now()}`;
    db.add(userId, 'open', null);
    const staleTicket = {...db.getOpenSync(userId, null)};
    db.closeTicketById(staleTicket.id, 'staff_closed');
    cache.config.ai = {
      enabled: true,
      mode: 'full',
      off_topic: {enabled: false},
    } as any;
    let deliveries = 0;
    (middleware as any).msg = async () => {
      deliveries++;
      return {message_id: 1100};
    };
    (middleware as any).msgWithId = async () => {
      deliveries++;
      return 1101;
    };

    const handled = await ai.handleUserMessage(
      context(userId, 'Ответьте после закрытия'),
      staleTicket,
    );

    expect(handled).to.equal(false);
    expect(cache.aiSessions[String(staleTicket.id)]).to.equal(undefined);
    expect(db.getTicketByIdSync(staleTicket.id).status).to.equal('closed');
    expect(deliveries).to.equal(0);
  });

  it('does not resume persisted operator ownership when full mode returns', async () => {
    const userId = `terminal-persisted-handoff-${Date.now()}`;
    db.add(userId, 'open', null);
    const ticket = db.getOpenSync(userId, null);
    db.updateTicketState(ticket.id, {
      stage: 'waiting_operator',
      aiEnabled: false,
      handoffReason: 'ai_disabled',
    });
    cache.config.ai = {
      enabled: true,
      mode: 'full',
      off_topic: {enabled: false},
    } as any;
    cache.aiSessions[String(ticket.id)] = {
      ticketId: String(ticket.id),
      userId,
      disabled: false,
      history: [],
    } as any;
    let deliveries = 0;
    (middleware as any).msg = async () => {
      deliveries++;
      return {message_id: 1150};
    };

    try {
      const handled = await ai.handleUserMessage(
        context(userId, 'Не возобновляйте ИИ автоматически'),
        ticket,
      );

      expect(handled).to.equal(false);
      expect(cache.aiSessions[String(ticket.id)].disabled).to.equal(true);
      expect(deliveries).to.equal(0);
    } finally {
      delete cache.aiSessions[String(ticket.id)];
      db.closeTicketById(ticket.id, 'test_cleanup');
    }
  });

  it('aborts and drains a turn on shutdown without compensating messages', async () => {
    const userId = `terminal-shutdown-${Date.now()}`;
    db.add(userId, 'open', null);
    const ticket = db.getOpenSync(userId, null);
    const queuedUserId = `terminal-shutdown-queued-${Date.now()}`;
    db.add(queuedUserId, 'open', null);
    const queuedTicket = db.getOpenSync(queuedUserId, null);
    const processingStarted = deferred<void>();
    const releaseProcessing = deferred<void>();
    const userMessages: string[] = [];
    cache.config.ai = {
      enabled: true,
      mode: 'rag_only',
      user_parse_mode: 'none',
      off_topic: {enabled: false},
      rag: {
        enabled: true,
        vector_db: 'qdrant',
        qdrant: {max_context_docs: 3},
      },
    } as any;
    cache.config.support = {
      ...(originalSupport || {}),
      mirror_ai_dialogs: false,
    };
    (middleware as any).msgWithId = async () => {
      processingStarted.resolve();
      await releaseProcessing.promise;
      return 1200;
    };
    (middleware as any).msg = async (
      _chatId: string | number,
      text: string,
    ) => {
      userMessages.push(text);
      return {message_id: 1201};
    };
    cache.bot = {api: {editMessageText: async () => true}} as any;

    try {
      const handling = ai.handleUserMessage(
        context(userId, 'Как восстановить пароль?'),
        ticket,
      );
      await processingStarted.promise;
      const session = cache.aiSessions[String(ticket.id)];
      const controller = session.abortController as AbortController;

      expect(ai.setAiShutdownState(true)).to.equal(1);
      expect(controller.signal.aborted).to.equal(true);
      expect(controller.signal.reason).to.equal('shutdown');
      expect(session.abortController).to.equal(undefined);
      const draining = ai.waitForActiveAiRuns(1000);
      const queuedHandled = await ai.handleUserMessage(
        context(queuedUserId, 'Сообщение уже в очереди polling'),
        queuedTicket,
      );
      expect(queuedHandled).to.equal(true);
      expect(cache.aiSessions[String(queuedTicket.id)]).to.equal(undefined);
      releaseProcessing.resolve();

      expect(await draining).to.equal(true);
      await handling;
      expect(userMessages).to.deep.equal([]);
    } finally {
      releaseProcessing.resolve();
      delete cache.aiSessions[String(ticket.id)];
      db.closeTicketById(ticket.id, 'test_cleanup');
      db.closeTicketById(queuedTicket.id, 'test_cleanup');
      ai.setAiShutdownState(false);
    }
  });

  it('turns a runtime-policy cancellation into an operator handoff', async () => {
    const userId = `terminal-policy-off-${Date.now()}`;
    db.add(userId, 'open', null);
    const ticket = db.getOpenSync(userId, null);
    const finalEditStarted = deferred<void>();
    const releaseFinalEdit = deferred<void>();
    const edits: string[] = [];
    let blockFirstEdit = true;

    cache.config.ai = {
      enabled: true,
      mode: 'rag_only',
      user_parse_mode: 'none',
      off_topic: {enabled: false},
      rag: {
        enabled: true,
        vector_db: 'qdrant',
        qdrant: {max_context_docs: 3},
      },
      handoff: {user_message: 'Вопрос передан специалисту.'},
    } as any;
    cache.config.support = {
      ...(originalSupport || {}),
      mirror_ai_dialogs: false,
    };
    (middleware as any).msgWithId = async () => 1050;
    (middleware as any).msg = async () => ({message_id: 1051});
    cache.bot = {
      api: {
        editMessageText: async (
          _chatId: string | number,
          _messageId: number,
          text: string,
        ) => {
          edits.push(text);
          if (blockFirstEdit) {
            blockFirstEdit = false;
            finalEditStarted.resolve();
            await releaseFinalEdit.promise;
          }
          return true;
        },
        deleteMessage: async () => true,
      },
    } as any;

    try {
      const handling = ai.handleUserMessage(
        context(userId, 'Как восстановить пароль?'),
        ticket,
      );
      await finalEditStarted.promise;
      const runId = cache.aiSessions[String(ticket.id)].runId as string;

      expect(ai.cancelActiveAiRuns('runtime_mode_changed')).to.equal(1);
      releaseFinalEdit.resolve();
      await handling;

      const session = cache.aiSessions[String(ticket.id)];
      expect(session.disabled).to.equal(true);
      expect(session.history).to.deep.equal([{
        role: 'user', content: 'Как восстановить пароль?',
      }]);
      expect(session.lastAnswer).to.equal(undefined);
      expect(db.getTicketByIdSync(ticket.id).stage)
        .to.equal('waiting_operator');
      expect(db.getAiRunDiagnostics(runId)?.run.status).to.equal('cancelled');
      expect(edits).to.include('Вопрос передан специалисту.');
      expect(getAiMetricsSnapshot().answerModes.directRag).to.equal(0);
    } finally {
      releaseFinalEdit.resolve();
      delete cache.aiSessions[String(ticket.id)];
      db.closeTicketById(ticket.id, 'test_cleanup');
    }
  });

  it('serializes an in-flight slow progress edit before the final answer', async () => {
    const userId = `terminal-progress-${Date.now()}`;
    db.add(userId, 'open', null);
    const ticket = db.getOpenSync(userId, null);
    const slowEditStarted = deferred<void>();
    const releaseSlowEdit = deferred<void>();
    const completedEdits: string[] = [];
    const previousSlowDelay = process.env.AI_TEST_SLOW_MESSAGE_DELAY_MS;

    cache.config.ai = {
      enabled: true,
      mode: 'rag_only',
      user_parse_mode: 'none',
      off_topic: {enabled: false},
      rag: {
        enabled: true,
        vector_db: 'qdrant',
        qdrant: {max_context_docs: 3},
      },
    } as any;
    cache.config.support = {
      ...(originalSupport || {}),
      mirror_ai_dialogs: false,
    };
    (middleware as any).msgWithId = async () => 1000;
    (middleware as any).msg = async () => ({message_id: 1001});
    cache.bot = {
      api: {
        editMessageText: async (
          _chatId: string | number,
          _messageId: number,
          text: string,
        ) => {
          if (text === 'Проверяю официальные инструкции…') {
            slowEditStarted.resolve();
            await releaseSlowEdit.promise;
            completedEdits.push('slow');
          } else {
            completedEdits.push(text);
          }
          return true;
        },
        deleteMessage: async () => true,
      },
    } as any;
    process.env.AI_TEST_SLOW_MESSAGE_DELAY_MS = '0';

    try {
      const handling = ai.handleUserMessage(
        context(userId, 'Как восстановить пароль?'),
        ticket,
      );
      await slowEditStarted.promise;
      await new Promise(resolve => setTimeout(resolve, 10));

      expect(completedEdits).to.deep.equal([]);
      releaseSlowEdit.resolve();
      await handling;

      expect(completedEdits[0]).to.equal('slow');
      expect(completedEdits).to.have.length(2);
      expect(completedEdits[1]).not.to.equal(
        'Проверяю официальные инструкции…',
      );
    } finally {
      if (previousSlowDelay === undefined) {
        delete process.env.AI_TEST_SLOW_MESSAGE_DELAY_MS;
      } else {
        process.env.AI_TEST_SLOW_MESSAGE_DELAY_MS = previousSlowDelay;
      }
      releaseSlowEdit.resolve();
      delete cache.aiSessions[String(ticket.id)];
      db.closeTicketById(ticket.id, 'test_cleanup');
    }
  });
});

function staffReplyContext(ticketId: string | number): any {
  return {
    session: {admin: true},
    chat: {id: '-100-command-cancellation'},
    message: {
      reply_to_message: {
        message_id: 500,
        from: {is_bot: true},
        text: `#T${String(ticketId).padStart(6, '0')}`,
      },
    },
  };
}

describe('Staff command AI cancellation', () => {
  let originalSessions: any;
  let originalMsg: any;
  let originalReply: any;
  let cleanup: Array<{ticketId: string | number; userId: string}>;

  beforeEach(() => {
    originalSessions = cache.aiSessions;
    originalMsg = (middleware as any).msg;
    originalReply = (middleware as any).reply;
    cache.aiSessions = {} as any;
    cleanup = [];
    (middleware as any).msg = async () => undefined;
    (middleware as any).reply = async () => undefined;
  });

  afterEach(() => {
    for (const item of cleanup) {
      db.closeTicketById(item.ticketId, 'test_cleanup');
      db.unblockUser(item.userId);
    }
    cache.aiSessions = originalSessions;
    (middleware as any).msg = originalMsg;
    (middleware as any).reply = originalReply;
  });

  function activeTicket(label: string) {
    const userId = `${label}-${Date.now()}-${cleanup.length}`;
    db.add(userId, 'open', null);
    const ticket = db.getOpenSync(userId, null);
    cleanup.push({ticketId: ticket.id, userId});
    const controller = new AbortController();
    cache.aiSessions[String(ticket.id)] = {
      ticketId: String(ticket.id),
      userId,
      disabled: false,
      history: [],
      runId: `${label}-run`,
      abortController: controller,
    };
    return {ticket, userId, controller};
  }

  it('/close aborts and removes the ticket AI session', () => {
    const {ticket, controller} = activeTicket('command-close');

    commands.closeCommand(staffReplyContext(ticket.id));

    expect(controller.signal.aborted).to.equal(true);
    expect(controller.signal.reason).to.equal('ticket_closed');
    expect(cache.aiSessions[String(ticket.id)]).to.equal(undefined);
    expect(db.getTicketByIdSync(ticket.id).status).to.equal('closed');
  });

  it('/ban aborts and removes the ticket AI session', () => {
    const {ticket, userId, controller} = activeTicket('command-ban');

    commands.banCommand(staffReplyContext(ticket.id));

    expect(controller.signal.aborted).to.equal(true);
    expect(controller.signal.reason).to.equal('ticket_banned');
    expect(cache.aiSessions[String(ticket.id)]).to.equal(undefined);
    db.checkBan(userId, blocked => expect(blocked).not.to.equal(undefined));
  });

  it('/clear aborts and removes every cached AI session', () => {
    const first = activeTicket('command-clear-first');
    const second = activeTicket('command-clear-second');

    commands.clearCommand({
      session: {admin: true},
      chat: {id: '-100-command-cancellation'},
      message: {},
    } as any);

    expect(first.controller.signal.aborted).to.equal(true);
    expect(first.controller.signal.reason).to.equal('tickets_cleared');
    expect(second.controller.signal.aborted).to.equal(true);
    expect(second.controller.signal.reason).to.equal('tickets_cleared');
    expect(cache.aiSessions).to.deep.equal({});
    expect(db.getTicketByIdSync(first.ticket.id).status).to.equal('closed');
    expect(db.getTicketByIdSync(second.ticket.id).status).to.equal('closed');
  });
});
