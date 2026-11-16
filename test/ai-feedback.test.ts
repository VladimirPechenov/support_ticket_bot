import {expect} from 'chai';
import cache from '../src/cache';
import * as ai from '../src/ai';
import * as middleware from '../src/middleware';
import {
  getAiMetricsSnapshot,
  resetAiMetrics,
} from '../src/ai-metrics';
import * as db from '../src/db';

describe('AI feedback correlation', () => {
  let originalMsg: any;
  let originalBot: any;
  let originalSessions: any;
  let createdTicketIds: Array<string | number>;

  beforeEach(() => {
    originalMsg = (middleware as any).msg;
    originalBot = cache.bot;
    originalSessions = cache.aiSessions;
    createdTicketIds = [];
    (middleware as any).msg = async () => undefined;
    resetAiMetrics();
    cache.aiSessions = {} as any;
  });

  afterEach(() => {
    for (const ticketId of createdTicketIds) {
      delete cache.aiSessions[String(ticketId)];
      db.closeTicketById(ticketId, 'test_cleanup');
    }
    (middleware as any).msg = originalMsg;
    cache.bot = originalBot;
    cache.aiSessions = originalSessions;
  });

  it('aborts the active run and records only the first helpful feedback', async () => {
    const userId = `feedback-helpful-${Date.now()}`;
    db.add(userId, 'open', null);
    const ticket = db.getOpenSync(userId, null);
    createdTicketIds.push(ticket.id);
    db.recordTicketEvent(ticket.id, {
      eventType: 'ai_answered',
      actorType: 'ai',
      answerId: 'answer-a',
      answerMode: 'direct_rag',
      sourceId: 'subscription.extra_devices',
    });
    const controller = new AbortController();
    cache.aiSessions[String(ticket.id)] = {
      ticketId: String(ticket.id),
      userId,
      disabled: false,
      history: [],
      runId: 'active-helpful-run',
      abortController: controller,
      lastAnswer: {
        id: 'answer-a',
        mode: 'direct_rag',
        sourceTitle: 'Лимит устройств в подписке',
        denseScore: 0.5,
        lexicalScore: 1,
        hybridScore: 0.65,
      },
    } as any;

    const first = await ai.handleUserFeedback(
      ticket.id,
      userId,
      'helpful',
      'answer-a',
    );
    const duplicate = await ai.handleUserFeedback(
      ticket.id,
      userId,
      'not_helpful',
      'answer-a',
    );
    const stale = await ai.handleUserFeedback(
      ticket.id,
      userId,
      'helpful',
      'answer-old',
    );

    expect(first).to.equal(true);
    expect(duplicate).to.equal(false);
    expect(stale).to.equal(false);
    expect(controller.signal.aborted).to.equal(true);
    expect(controller.signal.reason).to.equal('feedback_helpful');
    expect(cache.aiSessions[String(ticket.id)].disabled).to.equal(true);
    expect(cache.aiSessions[String(ticket.id)].abortController)
      .to.equal(undefined);
    expect(db.getTicketByIdSync(ticket.id).status).to.equal('closed');
    const metrics = getAiMetricsSnapshot();
    expect(metrics.feedback.helpful).to.equal(1);
    expect(metrics.feedback.notHelpful).to.equal(0);
    expect(metrics.feedbackByMode.direct_rag.helpful).to.equal(1);
  });

  it('validates feedback from SQLite after an in-memory session is lost', async () => {
    const userId = `feedback-restart-${Date.now()}`;
    db.add(userId, 'open', null);
    const ticket = db.getOpenSync(userId, null);
    createdTicketIds.push(ticket.id);
    db.recordTicketEvent(ticket.id, {
      eventType: 'ai_answered',
      actorType: 'ai',
      answerId: 'persistent-answer',
      answerMode: 'llm',
      sourceId: 'subscription.extra_devices',
    });
    delete cache.aiSessions[String(ticket.id)];

    expect(await ai.handleUserFeedback(
      ticket.id,
      userId,
      'helpful',
      'persistent-answer',
    )).to.equal(true);
    expect(await ai.handleUserFeedback(
      ticket.id,
      userId,
      'operator',
      'persistent-answer',
    )).to.equal(false);
    expect(db.getTicketByIdSync(ticket.id).status).to.equal('closed');
  });

  it('edits the same live staff card when the user requests an operator', async () => {
    const edits: any[] = [];
    const userId = `feedback-card-${Date.now()}`;
    db.add(userId, 'open', null);
    const ticket = db.getOpenSync(userId, null);
    createdTicketIds.push(ticket.id);
    db.recordTicketEvent(ticket.id, {
      eventType: 'ai_answered',
      actorType: 'ai',
      answerId: 'answer-b',
      answerMode: 'llm',
    });
    cache.bot = {
      api: {
        editMessageText: async (...args: any[]) => edits.push(args),
      },
    } as any;
    const controller = new AbortController();
    cache.aiSessions[String(ticket.id)] = {
      ticketId: String(ticket.id),
      userId,
      disabled: false,
      history: [],
      runId: 'active-operator-run',
      abortController: controller,
      lastAnswer: {id: 'answer-b', mode: 'llm'},
      lastStaffCard: {
        chatId: '-100-staff',
        messageId: 501,
        ticketId: String(ticket.id),
        question: 'Вопрос',
        user: {id: userId, firstName: 'Иван'},
      },
      lastStaffCardResult: {
        status: 'answered',
        answer: 'Ответ',
        mode: 'llm',
        sourceTitle: 'Статья',
      },
    } as any;

    try {
      expect(await ai.handleUserFeedback(
        ticket.id,
        userId,
        'operator',
        'answer-b',
      )).to.equal(true);
      expect(edits).to.have.length(1);
      expect(edits[0][0]).to.equal('-100-staff');
      expect(edits[0][1]).to.equal(501);
      expect(edits[0][2]).to.contain('Ждёт оператора');
      expect(controller.signal.aborted).to.equal(true);
      expect(controller.signal.reason).to.equal('user_operator_button');
      expect(cache.aiSessions[String(ticket.id)].disabled).to.equal(true);
    } finally {
      db.closeTicketById(ticket.id, 'test_cleanup');
    }
  });

  it('rejects an old feedback callback after the ticket is closed', async () => {
    const userId = `feedback-closed-${Date.now()}`;
    db.add(userId, 'open', null);
    const ticket = db.getOpenSync(userId, null);
    createdTicketIds.push(ticket.id);
    db.recordTicketEvent(ticket.id, {
      eventType: 'ai_answered',
      actorType: 'ai',
      answerId: 'closed-answer',
      answerMode: 'llm',
    });
    db.closeTicketById(ticket.id, 'test_closed_before_feedback');

    expect(await ai.handleUserFeedback(
      ticket.id,
      userId,
      'operator',
      'closed-answer',
    )).to.equal(false);
    expect(db.getTicketByIdSync(ticket.id).status).to.equal('closed');
    expect(db.getTicketByIdSync(ticket.id).stage).to.equal('resolved');
  });
});

describe('AI response safety markers', () => {
  it('hands off explicit uncertainty markers and configured phrases', () => {
    expect(ai.isUncertainLlmAnswer('[NEEDS_HUMAN] Нет данных.', null))
      .to.equal(true);
    expect(ai.isUncertainLlmAnswer(
      'Точно не скажу без оператора.',
      {handoff: {uncertain_phrases: ['точно не скажу']}},
    )).to.equal(true);
    expect(ai.isUncertainLlmAnswer(
      'Откройте раздел «Управление подпиской».',
      {handoff: {uncertain_phrases: ['не знаю']}},
    )).to.equal(false);
  });

  it('prefilters obvious off-topic but preserves support questions', () => {
    expect(ai.isObviousOffTopic('Какая сегодня погода?', null))
      .to.equal(true);
    expect(ai.isObviousOffTopic('Расскажи короткий стишок', null))
      .to.equal(true);
    expect(ai.isObviousOffTopic('Дай рецепт супа', null))
      .to.equal(true);
    expect(ai.isObviousOffTopic('Погода мешает подключить сервис', null))
      .to.equal(false);
  });
});
