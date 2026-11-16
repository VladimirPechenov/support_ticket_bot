import {expect} from 'chai';
import {
  FULL_KNOWLEDGE_INPUT_TOKENS,
  FULL_KNOWLEDGE_RESPONSE_SCHEMA,
  fullKnowledgeSystemPrompt,
  loadFullKnowledgeBase,
  runFullKnowledgeAgent,
} from '../src/full-knowledge-agent';
import * as aiClient from '../src/ai-client';
import * as ai from '../src/ai';
import cache from '../src/cache';
import * as db from '../src/db';
import * as middleware from '../src/middleware';

function success(content: string, sources: string[] = []): aiClient.LlmResult {
  return {
    ok: true, content: JSON.stringify({
      action: content === '[NEEDS_HUMAN]' ? 'handoff' : 'reply',
      answer: content, sources,
    }), provider: 'gemini', model: 'gemini-3.1-flash-lite',
    status: 200, latencyMs: 1,
    prompt: {
      messages: [], estimatedTokens: 100, includedDocuments: 6,
      includedHistoryMessages: 0, truncatedDocument: false,
    },
    attemptedModels: ['gemini-3.1-flash-lite'], usedFallback: false,
    providerAttempts: [{provider: 'gemini', model: 'gemini-3.1-flash-lite',
      startedAt: Date.now(), latencyMs: 1, outcome: 'success'}],
  };
}

const input = {
  runId: 'full-knowledge-test', mode: 'full' as const,
  systemPrompt: 'Отвечай по базе знаний.', userText: 'Здравствуйте, сервис сломался',
};

describe('full knowledge agent', () => {
  it('asks the real Gemini adapter for a structured conversational decision', async () => {
    const originalFetch = global.fetch;
    const originalProxy = process.env.GEMINI_PROXY_URL;
    const originalKey = process.env.GOOGLE_API_KEY;
    let body: any;
    delete process.env.GEMINI_PROXY_URL;
    process.env.GOOGLE_API_KEY = 'test-only-key';
    aiClient.resetLlmCircuitBreakers();
    global.fetch = (async (input: any, init?: RequestInit) => {
      body = JSON.parse(await new Request(input, init).text());
      return new Response(JSON.stringify({candidates: [{
        content: {role: 'model', parts: [{text: JSON.stringify({
          action: 'handoff', answer: 'Подключаю оператора.', sources: [],
        })}]}, finishReason: 'STOP',
      }]}), {status: 200, headers: {'Content-Type': 'application/json'}});
    }) as typeof fetch;
    try {
      const result = await aiClient.requestLlm({
        systemPrompt: 'Return a support decision.', userText: 'Нужен человек',
      }, {primary: {provider: 'gemini', model: 'gemini-3.8-flash'},
        response_schema: FULL_KNOWLEDGE_RESPONSE_SCHEMA, max_attempts: 1,
      });
      expect(result.ok).to.equal(true);
      expect(body.generationConfig.responseMimeType).to.equal('application/json');
      expect(body.generationConfig.responseJsonSchema).to.deep.equal(FULL_KNOWLEDGE_RESPONSE_SCHEMA);
    } finally {
      global.fetch = originalFetch;
      if (originalProxy === undefined) delete process.env.GEMINI_PROXY_URL;
      else process.env.GEMINI_PROXY_URL = originalProxy;
      if (originalKey === undefined) delete process.env.GOOGLE_API_KEY;
      else process.env.GOOGLE_API_KEY = originalKey;
      aiClient.resetLlmCircuitBreakers();
    }
  });

  it('puts every article, including the final one, into the model prompt', () => {
    const documents = loadFullKnowledgeBase();
    const history = [{role: 'user', content: 'Раньше работало на телефоне.'}];
    const prompt = aiClient.buildPrompt({
      systemPrompt: fullKnowledgeSystemPrompt(input.systemPrompt),
      userText: input.userText, documents, history,
      maxInputTokens: FULL_KNOWLEDGE_INPUT_TOKENS,
      requireCompleteDocuments: true,
    });
    expect(documents.length).to.be.greaterThan(5);
    expect(prompt.includedDocuments).to.equal(documents.length);
    expect(prompt.includedHistoryMessages).to.equal(1);
    expect(prompt.truncatedDocument).to.equal(false);
    const context = prompt.messages.map(message => message.content).join('\n');
    for (const document of documents) {
      expect(context).to.include(`Source ID: ${document.id}`);
      expect(context).to.include(document.text);
    }
  });

  it('fails explicitly rather than silently dropping articles over budget', async () => {
    let invoked = false;
    const result = await aiClient.requestLlm({
      systemPrompt: 'Rules', userText: 'Question',
      documents: loadFullKnowledgeBase(), requireCompleteDocuments: true,
    }, {
      primary: {provider: 'gemini', model: 'gemini-3.1-flash-lite'},
      max_input_tokens: 128,
    }, {modelFactory: () => {
      invoked = true;
      return {invoke: async () => ({content: 'Should not be called'})};
    }});
    expect(result.ok).to.equal(false);
    if (result.ok === false) expect(result.reason).to.equal('prompt_limit');
    expect(invoked).to.equal(false);
    expect(result.prompt.includedDocuments).to.equal(loadFullKnowledgeBase().length);
  });

  it('accepts the production clarification that was rejected for its greeting', async () => {
    const content = 'Здравствуйте! Уточните модель телефона, приложение и ' +
      'тип сети. сервис не подключается или сайты не открываются?';
    const result = await runFullKnowledgeAgent(input, loadFullKnowledgeBase(),
      async () => success(content));
    expect(result.status).to.equal('answered');
    expect(result.content).to.equal(content);
    expect(result.citations).to.deep.equal([]);
  });

  it('uses model-selected sources as metadata without lexical validation', async () => {
    const result = await runFullKnowledgeAgent(input, loadFullKnowledgeBase(),
      async () => success('Здравствуйте! Выберите период подписки в меню бота.',
        ['subscription.renew', 'unknown-id']));
    expect(result.status).to.equal('answered');
    expect(result.content).not.to.include('[SOURCES:');
    expect(result.citations.map(citation => citation.sourceId))
      .to.deep.equal(['subscription.renew']);
  });

  it('lets the model choose a human and handles an empty API response', async () => {
    for (const [content, reason] of [
      ['[NEEDS_HUMAN]', 'model_requested_handoff'], ['', 'empty_answer'],
    ]) {
      const result = await runFullKnowledgeAgent(input, loadFullKnowledgeBase(),
        async () => success(content));
      expect(result.status).to.equal('handed_off');
      expect(result.reason).to.equal(reason);
    }
  });

  it('does not deliver a late model response after operator cancellation', async () => {
    const controller = new AbortController();
    const result = await runFullKnowledgeAgent({...input, signal: controller.signal},
      loadFullKnowledgeBase(), async () => {
        controller.abort('staff_takeover');
        return success('Late response');
      });
    expect(result.status).to.equal('cancelled');
    expect(result.content).to.equal(undefined);
  });
});

describe('full knowledge Telegram integration', () => {
  let originalConfig: any;
  let originalBot: any;
  let originalSessions: any;
  let originalRequest: typeof aiClient.requestLlm;
  let originalMsg: any;
  let originalMsgWithId: any;
  let ticket: any;
  let userId: string;
  let deliveries: string[];
  let captured: any[];
  let modelContent: string;

  beforeEach(() => {
    originalConfig = cache.config;
    originalBot = cache.bot;
    originalSessions = cache.aiSessions;
    originalRequest = aiClient.requestLlm;
    originalMsg = (middleware as any).msg;
    originalMsgWithId = (middleware as any).msgWithId;
    deliveries = [];
    captured = [];
    modelContent = 'Здравствуйте! Какое приложение вы используете?';
    cache.config = {...originalConfig, parse_mode: 'none',
      support: {...originalConfig.support, mirror_ai_dialogs: false},
      ai: {enabled: true, mode: 'full', user_parse_mode: 'none',
        off_topic: {enabled: true, keywords: ['сервис'], max_warnings: 0},
        handoff: {keywords: ['оператор'], uncertain_phrases: ['не могу']},
        rag: {enabled: false, qdrant: {confidence_threshold: 1, max_context_docs: 1}},
      },
    };
    cache.aiSessions = {};
    (middleware as any).msgWithId = async () => 101;
    (middleware as any).msg = async (_chat: any, text: string) => {
      deliveries.push(text);
      return {message_id: 102};
    };
    cache.bot = {api: {
      editMessageText: async (_chat: any, _id: any, text: string) => {
        deliveries.push(text);
        return true;
      },
    }} as any;
    (aiClient as any).requestLlm = async (prompt: any, config: any) => {
      captured.push({prompt, config});
      return success(modelContent);
    };
    userId = `full-kb-${Date.now()}-${Math.random()}`;
    db.add(userId, 'open', null);
    ticket = db.getOpenSync(userId, null);
  });

  afterEach(() => {
    db.closeTicketById(ticket.id, 'test_cleanup');
    cache.config = originalConfig;
    cache.bot = originalBot;
    cache.aiSessions = originalSessions;
    (aiClient as any).requestLlm = originalRequest;
    (middleware as any).msg = originalMsg;
    (middleware as any).msgWithId = originalMsgWithId;
  });

  function handle(text: string) {
    return ai.handleUserMessage({chat: {id: userId, type: 'private'},
      message: {text, message_id: 100, from: {id: userId, first_name: 'Тест'}},
    } as any, ticket);
  }

  it('always calls the model with all articles despite keyword and RAG settings', async () => {
    modelContent = 'Здравствуйте! Не могу проверить оплату без данных. ' +
      'Подскажите, какой вопрос возник?';
    await handle('Здравствуйте! Нужен ли оператор чтобы подключить сервис?');
    expect(captured).to.have.length(1);
    expect(captured[0].prompt.documents).to.have.length(loadFullKnowledgeBase().length);
    expect(captured[0].prompt.requireCompleteDocuments).to.equal(true);
    expect(captured[0].config.max_input_tokens).to.equal(FULL_KNOWLEDGE_INPUT_TOKENS);
    expect(captured[0].config.response_schema).to.deep.equal(FULL_KNOWLEDGE_RESPONSE_SCHEMA);
    expect(deliveries).to.include(modelContent);
    expect(db.getTicketByIdSync(ticket.id).ai_enabled).to.equal(1);
    expect(db.getLatestAiRunDiagnosticsForTicket(ticket.id)?.run.status)
      .to.equal('answered');
  });

  it('passes the complete conversation without guessing relevance from words', async () => {
    const history = [
      {role: 'user', content: 'Мне нужна подписка на второй телефон'},
      {role: 'assistant', content: 'Какое устройство вы используете?'},
      {role: 'user', content: 'Samsung'},
      {role: 'assistant', content: 'Какое приложение установлено?'},
    ];
    cache.aiSessions[String(ticket.id)] = {
      ticketId: String(ticket.id), userId, disabled: false, history: [...history],
    };
    await handle('ExampleClient');
    expect(captured[0].prompt.history).to.deep.equal(history);
  });

  it('hands off only after the model returns its explicit decision', async () => {
    modelContent = '[NEEDS_HUMAN]';
    await handle('Хочу поговорить с человеком');
    expect(captured).to.have.length(1);
    expect(db.getTicketByIdSync(ticket.id)).to.include({
      ai_enabled: 0, stage: 'waiting_operator',
      handoff_reason: 'model_requested_handoff',
    });
  });
});
