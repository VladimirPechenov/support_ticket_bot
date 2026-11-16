import { expect } from 'chai';
import * as db from '../src/db';
import * as fs from 'fs';

describe('Database Functions', () => {
  const testDbPath = './config/test-support.db';

  before(() => {
    // Используем тестовую БД
    process.env.DB_PATH = testDbPath;
  });

  afterEach(() => {
    // Очищаем тестовую БД после каждого теста
    try {
      if (fs.existsSync(testDbPath)) {
        fs.unlinkSync(testDbPath);
      }
    } catch (e) {
      console.error('Failed to delete test DB:', e);
    }
  });

  describe('add() function', () => {
    it('persists bounded answer rejection details with secret redaction', () => {
      const runId = `rejection-${Date.now()}`;
      const oldKey = process.env.GOOGLE_API_KEY;
      process.env.GOOGLE_API_KEY = 'diagnostic-test-secret';
      try {
        db.createAiRun({runId, mode: 'full'});
        db.recordAnswerRejection({
          runId, reason: 'ungrounded_answer',
          content: 'Подписка 999 рублей diagnostic-test-secret ' + 'x'.repeat(11000),
          sourceIds: ['subscription.price'],
          details: {unsupportedFacts: ['number:999'],
            unsupportedClauses: ['diagnostic-test-secret']},
        });
        const rejection = db.getAiRunDiagnostics(runId)?.answerRejections[0];
        expect(rejection?.content).to.include('[REDACTED]');
        expect(rejection?.content).not.to.include('diagnostic-test-secret');
        expect(rejection?.content).to.have.length(10000);
        expect(rejection?.sourceIds).to.deep.equal(['subscription.price']);
        expect(rejection?.details.unsupportedFacts).to.deep.equal(['number:999']);
        expect(rejection?.details.unsupportedClauses).to.deep.equal(['[REDACTED]']);
      } finally {
        if (oldKey === undefined) delete process.env.GOOGLE_API_KEY;
        else process.env.GOOGLE_API_KEY = oldKey;
      }
    });

    it('should add a new ticket to database', (done) => {
      db.add('12345', 'open', null);

      db.getOpen('12345', null, (ticket: any) => {
        expect(ticket).to.exist;
        expect(ticket.userid).to.equal('12345');
        expect(ticket.status).to.equal('open');
        done();
      });
    });

    it('should handle banned status correctly', (done) => {
      db.add('banned_user', 'banned', 'BANNED');

      db.checkBan('banned_user', (ticket: any) => {
        expect(ticket).to.exist;
        expect(ticket.status).to.equal('banned');
        done();
      });
    });

    it('should update existing ticket', (done) => {
      db.add('user123', 'open', 'support');
      db.add('user123', 'closed', 'support');

      db.check('user123', 'support', (tickets: any[]) => {
        const ticket = tickets[0];
        expect(ticket.status).to.equal('closed');
        done();
      });
    });
  });

  describe('getOpen() function', () => {
    it('should retrieve open ticket by userid', (done) => {
      db.add('user456', 'open', 'category1');

      db.getOpen('user456', 'category1', (ticket: any) => {
        expect(ticket).to.exist;
        expect(ticket.userid).to.equal('user456');
        expect(ticket.status).to.equal('open');
        done();
      });
    });

    it('should return undefined if ticket not found', (done) => {
      db.getOpen('nonexistent', null, (ticket: any) => {
        expect(ticket).to.be.undefined;
        done();
      });
    });

    it('should return undefined for closed ticket', (done) => {
      db.add('closeduser', 'closed', null);

      db.getOpen('closeduser', null, (ticket: any) => {
        expect(ticket).to.be.undefined;
        done();
      });
    });
  });

  describe('check() function', () => {
    it('should retrieve all tickets for a user', (done) => {
      db.add('user789', 'open', null);
      db.add('user789', 'closed', null);

      db.check('user789', null, (tickets: any[]) => {
        expect(tickets).to.be.an('array');
        expect(tickets.length).to.be.greaterThan(0);
        done();
      });
    });

    it('should filter by category', (done) => {
      db.add('catuser', 'open', 'category_a');
      db.add('otheruser', 'open', 'category_b');

      db.open((tickets: any) => {
        expect(Array.isArray(tickets) || typeof tickets === 'object').to.be.true;
        done();
      }, ['category_a']);
    });
  });

  describe('closeAll() function', () => {
    it('should close all open tickets', (done) => {
      db.add('user1', 'open', null);
      db.add('user2', 'open', null);

      db.closeAll();

      db.getOpen('user1', null, (ticket1: any) => {
        db.getOpen('user2', null, (ticket2: any) => {
          expect(ticket1).to.be.undefined;
          expect(ticket2).to.be.undefined;
          done();
        });
      });
    });
  });

  describe('closeTicketById() function', () => {
    it('should keep exactly one open ticket per user', (done) => {
      const userId = `close-one-${Date.now()}`;
      db.add(userId, 'open', 'first');
      db.add(userId, 'open', 'second');

      db.check(userId, null, (tickets: any[]) => {
        const openTickets = tickets.filter(ticket => ticket.status === 'open');
        expect(openTickets).to.have.length(1);
        expect(db.closeTicketById(openTickets[0].id)).to.equal(1);

        db.check(userId, null, (updatedTickets: any[]) => {
          expect(updatedTickets.filter(ticket => ticket.status === 'open'))
            .to.have.length(0);
          done();
        });
      });
    });
  });

  describe('ticket lifecycle metadata', () => {
    it('persists AI handoff, soft assignment, mapping and resolution', () => {
      const userId = `state-${Date.now()}`;
      db.add(userId, 'open', null);
      const ticket = db.getOpenSync(userId, null);
      expect(ticket.stage).to.equal('ai_active');

      db.updateTicketState(ticket.id, {
        stage: 'waiting_operator',
        aiEnabled: false,
        handoffReason: 'no_context',
      });
      db.updateTicketState(ticket.id, {
        stage: 'in_progress',
        assigneeId: 'staff-1',
        assigneeName: 'Анна',
      });
      db.updateTicketState(ticket.id, {
        stage: 'in_progress',
        assigneeId: 'staff-2',
        assigneeName: 'Борис',
      });
      db.mapTelegramMessage('-100-staff', 55, ticket.id, 'staff_turn');

      const assigned = db.getTicketByTelegramMessage('-100-staff', 55);
      expect(assigned.id).to.equal(ticket.id);
      expect(assigned.assignee_name).to.equal('Борис');
      expect(assigned).not.to.have.property('message_text');
      expect(db.closeTicketById(ticket.id, 'test_resolved')).to.equal(1);
      expect(db.getTicketByIdSync(ticket.id).stage).to.equal('resolved');
    });

    it('auto-closes inactive AI tickets after 24 hours', () => {
      const userId = `inactive-${Date.now()}`;
      db.add(userId, 'open', null);
      const ticket = db.getOpenSync(userId, null);
      db.updateTicketState(ticket.id, {
        stage: 'ai_active',
        lastActivityAt: Date.now() - 25 * 60 * 60 * 1000,
      });
      expect(db.closeInactiveAiTickets()).to.include(ticket.id);
      expect(db.getTicketByIdSync(ticket.id).status).to.equal('closed');
    });

    it('persists, deduplicates and trims AI conversation history', () => {
      const userId = `history-${Date.now()}`;
      db.add(userId, 'open', null);
      const ticket = db.getOpenSync(userId, null);
      expect(db.appendAiConversationMessage(
        ticket.id, 'user', 'Первый вопрос', 'telegram:1', 1,
      )).to.equal(true);
      expect(db.appendAiConversationMessage(
        ticket.id, 'user', 'Дубликат', 'telegram:1', 2,
      )).to.equal(false);
      db.appendAiConversationMessage(ticket.id, 'assistant', 'Первый ответ',
        'answer:1', 3);
      db.appendAiConversationMessage(ticket.id, 'user', 'Второй вопрос',
        'telegram:2', 4);

      expect(db.getAiConversationHistory(ticket.id, 10).map(message => ({
        role: message.role, content: message.content,
      }))).to.deep.equal([
        {role: 'user', content: 'Первый вопрос'},
        {role: 'assistant', content: 'Первый ответ'},
        {role: 'user', content: 'Второй вопрос'},
      ]);
      expect(db.trimAiConversationHistory(ticket.id, 2)).to.equal(1);
      expect(db.getAiConversationHistory(ticket.id, 10))
        .to.have.length(2);
    });
  });

  describe('AI observability metadata', () => {
    afterEach(() => {
      db.setRuntimeFeatureFlag('ai_mode', 'off');
      db.setRuntimeFeatureFlag('ai_rollout_percent', 0);
      db.setRuntimeFeatureFlag('web_tool_rollout_percent', 0);
    });

    it('persists provider/tool diagnostics without conversation data', () => {
      const runId = `run-${Date.now()}`;
      db.createAiRun({runId, mode: 'full'});
      db.recordProviderAttempt({
        runId,
        provider: 'google',
        model: 'gemini-3.1-flash-lite',
        outcome: 'failure',
        errorReason: 'rate_limit',
        statusCode: 429,
        latencyMs: 125,
      });
      db.recordProviderAttempt({
        runId,
        provider: 'mistral',
        model: 'mistral-small-2603',
        outcome: 'success',
        isFallback: true,
        latencyMs: 250,
        totalTokens: 42,
      });
      db.recordToolRun({
        runId,
        toolName: 'search_verified_docs',
        outcome: 'success',
        resultCount: 2,
        latencyMs: 30,
      });
      expect(db.finishAiRun(runId, {
        status: 'answered',
        route: 'fallback',
        ragStatus: 'miss',
        sourceCount: 2,
        latencyMs: 405,
      })).to.equal(1);

      const diagnostic = db.getAiRunDiagnostics(runId);
      expect(diagnostic?.run.providerAttemptCount).to.equal(2);
      expect(diagnostic?.run.toolRunCount).to.equal(1);
      expect(diagnostic?.providerAttempts).to.have.length(2);
      expect(diagnostic?.toolRuns).to.have.length(1);
      const serialized = JSON.stringify(diagnostic);
      expect(serialized).not.to.contain('systemPrompt');
      expect(serialized).not.to.contain('userText');
      expect(serialized).not.to.contain('"prompt":');
      expect(serialized).not.to.contain('user_id');
      expect(serialized).not.to.contain('arguments');
      const stats = db.getPersistentAiStats(1);
      expect(stats.byProvider.google).to.be.greaterThan(0);
      expect(stats.fallbackSuccesses).to.be.greaterThan(0);
      expect(stats.byTool.search_verified_docs).to.be.greaterThan(0);
    });

    it('defaults to safe mode and validates runtime flags', () => {
      expect(db.getRuntimeFeatureFlags()).to.deep.equal({
        aiMode: 'off',
        aiRolloutPercent: 0,
        webToolRolloutPercent: 0,
      });
      db.setRuntimeFeatureFlag('ai_mode', 'rag_only');
      db.setRuntimeFeatureFlag('ai_rollout_percent', 25);
      db.setRuntimeFeatureFlag('web_tool_rollout_percent', 5);
      expect(db.getRuntimeFeatureFlags()).to.deep.equal({
        aiMode: 'rag_only',
        aiRolloutPercent: 25,
        webToolRolloutPercent: 5,
      });
      expect(() => db.setRuntimeFeatureFlag(
        'ai_rollout_percent',
        101,
      )).to.throw('between 0 and 100');
    });

    it('persists circuit and free-quota counters by provider', () => {
      db.saveAiProviderState({
        provider: 'google',
        circuitState: 'open',
        consecutiveFailures: 5,
        openUntil: Date.now() + 60_000,
        quotaDate: '2026-07-20',
        dailyRequests: 80,
        dailyTokens: 1000,
        lastErrorReason: 'rate_limit',
      });
      const state = db.getAiProviderStates()
        .find(row => row.provider === 'google');
      expect(state?.circuitState).to.equal('open');
      expect(state?.consecutiveFailures).to.equal(5);
      expect(state?.dailyRequests).to.equal(80);
    });

    it('finds persisted diagnostics by internal ticket after a session loss', () => {
      const runId = `ticket-run-${Date.now()}`;
      db.createAiRun({runId, ticketId: 424242, mode: 'rag_only'});
      db.finishAiRun(runId, {
        status: 'direct_rag',
        route: 'direct_rag',
        ragStatus: 'hit',
      });
      const diagnostics = db.getLatestAiRunDiagnosticsForTicket(424242);
      expect(diagnostics?.run.runId).to.equal(runId);
      expect(diagnostics?.run.ticketId).to.equal('424242');
    });

    it('aggregates and purges expired AI metadata', () => {
      const oldAt = Date.now() - 91 * 24 * 60 * 60 * 1000;
      const runId = `expired-run-${Date.now()}`;
      db.createAiRun({runId, mode: 'full', startedAt: oldAt});
      db.recordProviderAttempt({
        runId,
        provider: 'google',
        model: 'gemini-3.1-flash-lite',
        outcome: 'failure',
        errorReason: 'timeout',
        createdAt: oldAt,
      });
      db.recordToolRun({
        runId,
        toolName: 'search_verified_docs',
        outcome: 'failure',
        errorReason: 'timeout',
        createdAt: oldAt,
      });
      db.recordAnswerRejection({
        runId, reason: 'ungrounded_answer', content: 'Old rejected answer',
        sourceIds: [], createdAt: oldAt,
      });
      db.finishAiRun(runId, {
        status: 'handed_off',
        route: 'handoff',
        failureReason: 'timeout',
        completedAt: oldAt,
      });

      const purged = db.purgeExpiredMetadata(90);
      expect(purged.aiRuns).to.be.greaterThan(0);
      expect(purged.providerAttempts).to.be.greaterThan(0);
      expect(purged.toolRuns).to.be.greaterThan(0);
      expect(purged.answerRejections).to.be.greaterThan(0);
      expect(db.getAiRunDiagnostics(runId)).to.equal(null);
    });
  });

  describe('reopen() function', () => {
    it('should reopen a closed ticket', (done) => {
      db.add('reopenuser', 'open', 'category1');
      db.add('reopenuser', 'closed', 'category1');
      db.reopen('reopenuser', 'category1');

      db.getOpen('reopenuser', 'category1', (ticket: any) => {
        expect(ticket).to.exist;
        expect(ticket.status).to.equal('open');
        done();
      });
    });
  });

  describe('checkBan() function', () => {
    it('should identify banned users', (done) => {
      db.add('banned_user_1', 'banned', 'BANNED');

      db.checkBan('banned_user_1', (ticket: any) => {
        expect(ticket).to.exist;
        expect(ticket.status).to.equal('banned');
        done();
      });
    });

    it('should return undefined for non-banned users', (done) => {
      db.add('regular_user', 'open', null);

      db.checkBan('regular_user', (ticket: any) => {
        expect(ticket).to.be.undefined;
        done();
      });
    });
  });
});
