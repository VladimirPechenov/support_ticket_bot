import {expect} from 'chai';
import cache from '../src/cache';
import * as db from '../src/db';
import {buildStaffHandoffMessage} from '../src/ai';
import {staffFileCaption} from '../src/files';
import {
  buildStaffCardKeyboard,
  formatAiRunDiagnostics,
  renderStaffTurnCard,
  StaffTurnCard,
  updateCallbackCardStatus,
} from '../src/staff-card';

function callbacks(keyboard: ReturnType<typeof buildStaffCardKeyboard>): string[] {
  return keyboard.reply_markup.inline_keyboard
    .flat()
    .map((button) => button.callback_data).filter(Boolean) as string[];
}

function card(): StaffTurnCard {
  return {
    chatId: '-100-staff',
    messageId: 1,
    ticketId: '42',
    runId: 'run-12345678',
    createdAt: Date.now() - 4200,
    question: 'Как настроить приложение?',
    user: {
      id: '123456',
      firstName: 'Иван',
      username: 'ivan_support',
    },
  };
}

describe('AI staff card', () => {
  it('shows helpful closure as a result rather than a handoff reason', () => {
    for (const status of ['answered', 'ai_active', 'closed'] as const) {
      expect(renderStaffTurnCard(card(), {status, reason: 'rag_hit'}))
        .not.to.contain('Причина:');
    }
    const helpful = renderStaffTurnCard(card(), {status: 'closed', reason: 'ai_helpful'});
    expect(helpful).to.contain('<b>Результат:</b> ✅ Ответ помог');
    expect(helpful).not.to.contain('Причина:');
    expect(renderStaffTurnCard(card(), {status: 'waiting_operator', reason: 'not_helpful'}))
      .to.contain('Ответ не помог пользователю');
  });

  it('removes the obsolete reason from closed callbacks without changing question text or entities', async () => {
    const userId = `closed-card-${Date.now()}`;
    db.add(userId, 'open', null);
    const ticket = db.getOpenSync(userId, null);
    db.closeTicketById(ticket.id, 'ai_helpful');
    expect(db.getStaffTicket(ticket.id).close_reason).to.equal('ai_helpful');
    const text = 'Тикет #T000042\nСтатус: ❗️ Ждёт оператора\nЖдёт с: вчера\n' +
      'Причина: Требуется помощь оператора\n\nВопрос: Ошибка\nПричина: текст пользователя';
    let updated: any;
    await updateCallbackCardStatus({
      callbackQuery: {message: {text, entities: [
        {type: 'bold', offset: text.indexOf('Причина:'), length: 8},
        {type: 'bold', offset: text.indexOf('Вопрос:'), length: 7},
      ]}},
      editMessageText: async (value: string, options: any) => { updated = {value, options}; },
    }, String(ticket.id), {status: 'in_progress'}, null);
    expect(updated.value).to.contain('Результат: ✅ Ответ помог');
    expect(updated.value).not.to.contain('Требуется помощь оператора');
    expect(updated.value).not.to.contain('Ждёт с:');
    expect(updated.value).to.contain('Причина: текст пользователя');
    expect(updated.options.entities).to.have.length(1);
    const entity = updated.options.entities[0];
    expect(updated.value.slice(entity.offset, entity.offset + entity.length)).to.equal('Вопрос:');
  });

  it('shows only actions valid for the current ticket state', () => {
    const active = callbacks(buildStaffCardKeyboard(
      '42',
      null,
      {status: 'ai_active'},
      'run-12345678',
    ));
    expect(active).to.include('AI_TAKE---42');
    expect(active).to.include('AI_CLOSE---42');
    expect(active).to.include('AI_DIAG---42---run-12345678');
    expect(active).not.to.include('AI_RESUME---42');

    const waiting = callbacks(buildStaffCardKeyboard(
      '42',
      null,
      {status: 'waiting_operator'},
      'run-12345678',
    ));
    expect(waiting).to.include('AI_TAKE---42');
    expect(waiting).to.include('AI_CLOSE---42');
    expect(waiting).to.include('AI_RESUME---42');

    const closed = callbacks(buildStaffCardKeyboard(
      '42',
      null,
      {status: 'closed'},
      'run-12345678',
    ));
    expect(closed).to.include('AI_DIAG---42---run-12345678');
    expect(closed).to.include('STAFF_HISTORY---42');
    expect(closed).not.to.include('AI_TAKE---42');
    expect(closed).not.to.include('AI_CLOSE---42');
  });

  it('does not render user identity for anonymous tickets', () => {
    const originalAnonymous = cache.config.anonymous_tickets;
    cache.config.anonymous_tickets = true;
    try {
      const rendered = renderStaffTurnCard(card(), {status: 'ai_active'});
      expect(rendered).to.contain('Анонимный пользователь');
      expect(rendered).not.to.contain('Иван');
      expect(rendered).not.to.contain('ivan_support');
      expect(rendered).not.to.contain('123456');
      expect(rendered).not.to.contain('tg://user');
    } finally {
      cache.config.anonymous_tickets = originalAnonymous;
    }
  });

  it('renders copyable identifiers and hides raw ranking data', () => {
    const original = cache.config.anonymous_tickets;
    cache.config.anonymous_tickets = false;
    try {
      const rendered = renderStaffTurnCard(card(), {
        status: 'waiting_operator', reason: 'no_context', denseScore: 0.4,
      });
      expect(rendered).to.contain('<code>#T000042</code>');
      expect(rendered).to.contain('<code>123456</code>');
      expect(rendered).to.contain('В базе знаний нет подходящего ответа');
      expect(rendered).not.to.contain('dense=');
      const buttons = buildStaffCardKeyboard('42', null, undefined, undefined, '123456')
        .reply_markup.inline_keyboard.flat();
      expect(buttons.some(button => button.copy_text?.text === '123456')).to.equal(true);
      cache.config.anonymous_tickets = true;
      const anonymousButtons = buildStaffCardKeyboard('42', null, undefined, undefined, '123456')
        .reply_markup.inline_keyboard.flat();
      expect(anonymousButtons.some(button => button.copy_text?.text === '123456')).to.equal(false);
    } finally {
      cache.config.anonymous_tickets = original;
    }
  });

  it('preserves code, links and UTF-16 entity offsets when taking a ticket', async () => {
    const userId = `formatting-${Date.now()}`;
    db.add(userId, 'open', null);
    const ticket = db.getOpenSync(userId, null);
    db.updateTicketState(ticket.id, {stage: 'in_progress', assigneeName: '👩 Анна'});
    const text = '🎫 Тикет #T000042\nСтатус: ❗️ Ждёт оператора\n' +
      'Ответственный: Не назначен\nПользователь: Иван\nTG ID: 123456';
    const entities = [
      {type: 'code', offset: text.indexOf('#T'), length: 8},
      {type: 'text_link', offset: text.indexOf('Иван'), length: 4, url: 'tg://user?id=123456'},
      {type: 'code', offset: text.indexOf('123456'), length: 6},
    ];
    let updated: any;
    await updateCallbackCardStatus({
      callbackQuery: {message: {text, entities}},
      editMessageText: async (value: string, options: any) => { updated = {value, options}; },
    }, String(ticket.id), {status: 'in_progress', assigneeName: '👩 Анна'}, null);
    expect(updated.options.parse_mode).to.equal(undefined);
    for (const entity of updated.options.entities) {
      const value = updated.value.slice(entity.offset, entity.offset + entity.length);
      expect(['#T000042', 'Иван', '123456']).to.include(value);
    }
    expect(updated.options.entities).to.have.length(3);
    expect(updated.value).to.contain('Ответственный: 👩 Анна');
    db.closeTicketById(ticket.id, 'test_cleanup');
  });

  it('updates a media caption after closure while preserving its copyable identifiers', async () => {
    const userId = `caption-card-${Date.now()}`;
    db.add(userId, 'open', null);
    const ticket = db.getOpenSync(userId, null);
    db.closeTicketById(ticket.id);
    const caption = 'Тикет #T000042\nСтатус: ❗️ Ждёт оператора\nTG ID: 123456';
    let updated: any;
    await updateCallbackCardStatus({
      callbackQuery: {message: {caption, caption_entities: [
        {type: 'code', offset: caption.indexOf('123456'), length: 6},
      ]}},
      editMessageCaption: async (options: any) => { updated = options; },
    }, String(ticket.id), {status: 'closed'}, null);
    expect(updated.caption).to.contain('Статус: ❌ Закрыт');
    const entity = updated.caption_entities[0];
    expect(updated.caption.slice(entity.offset, entity.offset + entity.length)).to.equal('123456');
    expect(updated.reply_markup.inline_keyboard.flat()
      .some((button: any) => button.callback_data?.startsWith('AI_CLOSE---'))).to.equal(false);
  });

  it('does not reveal user identity in anonymous media captions', () => {
    const originalAnonymous = cache.config.anonymous_tickets;
    cache.config.anonymous_tickets = true;
    try {
      const rendered = staffFileCaption({
        message: {
          from: {
            id: '123456',
            first_name: 'Секретное имя',
            username: 'secret_username',
          },
          caption: 'Не содержит персональные данные',
        },
      } as any, '42');
      expect(rendered).to.contain('Пользователь: анонимно');
      expect(rendered).not.to.contain('Секретное имя');
      expect(rendered).not.to.contain('secret_username');
      expect(rendered).not.to.contain('123456');
    } finally {
      cache.config.anonymous_tickets = originalAnonymous;
    }
  });

  it('truncates before HTML escaping and keeps markup valid', () => {
    const originalAnonymous = cache.config.anonymous_tickets;
    cache.config.anonymous_tickets = false;
    const unsafeCard = {
      ...card(),
      question: '<script>&'.repeat(2000),
      user: {
        id: '123456',
        firstName: '<b>name</b>'.repeat(100),
        username: 'bad&name'.repeat(100),
      },
    };
    try {
      const rendered = renderStaffTurnCard(unsafeCard, {
        status: 'in_progress',
        assigneeName: '<admin>'.repeat(100),
        answer: '<answer>&'.repeat(2000),
        providerRoute: 'Gemini → Mistral (квота)',
        latencyMs: 4200,
      });
      expect(rendered.length).to.be.lessThan(4096);
      expect(rendered).not.to.contain('<script>');
      expect(rendered).to.contain('&lt;script&gt;');
      expect((rendered.match(/<b>/g) || []).length)
        .to.equal((rendered.match(/<\/b>/g) || []).length);
      expect((rendered.match(/<a /g) || []).length)
        .to.equal((rendered.match(/<\/a>/g) || []).length);
    } finally {
      cache.config.anonymous_tickets = originalAnonymous;
    }
  });

  it('keeps fallback handoff messages within Telegram limits after escaping', () => {
    const originalAnonymous = cache.config.anonymous_tickets;
    cache.config.anonymous_tickets = false;
    try {
      const rendered = buildStaffHandoffMessage(
        '42',
        {first_name: '<Иван & команда>'},
        'llm_provider_error',
        '<script>&"'.repeat(4096),
        null,
      );
      expect(rendered.length).to.be.at.most(3900);
      expect(rendered).not.to.contain('<script>');
      expect(rendered).to.contain('&lt;script&gt;');
      expect(rendered).to.match(/…$/);
    } finally {
      cache.config.anonymous_tickets = originalAnonymous;
    }
  });

  it('formats short metadata-only diagnostics', () => {
    const text = formatAiRunDiagnostics({
      run: {
        runId: 'run-12345678',
        ticketId: '42',
        mode: 'full',
        status: 'answered',
        route: 'fallback',
        ragStatus: 'hit',
        sourceCount: 2,
        providerAttemptCount: 2,
        toolRunCount: 1,
        failureReason: null,
        latencyMs: 4200,
        startedAt: 1,
        completedAt: 2,
      },
      providerAttempts: [
        {
          provider: 'gemini',
          model: 'gemini-3.1-flash-lite',
          phase: 'answer',
          outcome: 'failure',
          isFallback: false,
          errorReason: 'rate_limit',
          statusCode: 429,
          latencyMs: 100,
          promptTokens: 10,
          completionTokens: 0,
          totalTokens: 10,
          createdAt: 1,
        },
        {
          provider: 'mistral',
          model: 'mistral-small-2603',
          phase: 'answer',
          outcome: 'success',
          isFallback: true,
          errorReason: null,
          statusCode: 200,
          latencyMs: 4000,
          promptTokens: 10,
          completionTokens: 20,
          totalTokens: 30,
          createdAt: 1,
        },
      ],
      toolRuns: [],
      answerRejections: [],
    });

    expect(text).to.contain('Gemini → Mistral (квота)');
    expect(text).to.contain('4,2 с');
    expect(text.length).to.be.at.most(190);
    expect(text).not.to.contain('gemini-3.1-flash-lite');
  });
});
