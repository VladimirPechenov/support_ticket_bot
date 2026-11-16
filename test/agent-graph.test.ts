import {expect} from 'chai';
import {
  AgentDocument,
  AgentGraphDependencies,
  runSupportAgent,
} from '../src/agent-graph';
import {LlmResult} from '../src/ai-client';
import {VERIFIED_SOURCE_REGISTRY} from '../src/verified-docs';

function llmSuccess(content: string): LlmResult {
  return {
    ok: true,
    content,
    provider: 'gemini',
    model: 'gemini-3.1-flash-lite',
    status: 200,
    latencyMs: 10,
    prompt: {
      messages: [],
      estimatedTokens: 0,
      includedDocuments: 0,
      includedHistoryMessages: 0,
      truncatedDocument: false,
    },
    attemptedModels: ['gemini-3.1-flash-lite'],
    usedFallback: false,
    providerAttempts: [{
      provider: 'gemini',
      model: 'gemini-3.1-flash-lite',
      startedAt: 1,
      latencyMs: 10,
      outcome: 'success',
    }],
  };
}

function llmFailure(reason: 'rate_limit' | 'safety'): LlmResult {
  return {
    ok: false,
    reason,
    provider: 'mistral',
    model: 'mistral-small-2603',
    latencyMs: 10,
    message: 'Safe internal error',
    retryable: reason !== 'safety',
    prompt: {
      messages: [],
      estimatedTokens: 0,
      includedDocuments: 0,
      includedHistoryMessages: 0,
      truncatedDocument: false,
    },
    attemptedModels: ['gemini-3.1-flash-lite', 'mistral-small-2603'],
    usedFallback: true,
    providerAttempts: [{
      provider: 'gemini',
      model: 'gemini-3.1-flash-lite',
      startedAt: 1,
      latencyMs: 5,
      outcome: 'failure',
      reason,
    }],
  };
}

const knowledgeDocument: AgentDocument = {
  id: 'kb-1',
  title: 'Setup',
  text: 'Verified setup instructions',
};

function baseDependencies(
  overrides: Partial<AgentGraphDependencies> = {},
): AgentGraphDependencies {
  return {
    retrieve: async () => ({documents: [knowledgeDocument]}),
    invokeModel: async () => llmSuccess('Verified setup instructions'),
    ...overrides,
  };
}

function baseInput() {
  return {
    runId: 'run-1',
    userText: 'Как настроить приложение?',
    systemPrompt: 'Отвечай только по контексту.',
    mode: 'full' as const,
    deadlineMs: 30000,
  };
}

describe('support agent graph', () => {
  it('does not interpret update attempts as a device limit', async () => {
    const documents: AgentDocument[] = [{
      id: 'subscription.renew', title: 'Как продлить подписку',
      text: 'Откройте в боте «Подписка», выберите нужный период и оплатите его. ' +
        'После оплаты обновите конфигурацию в приложении.',
    }, {
      id: 'subscription.refresh_in_app', title: 'Обновление в приложении',
      text: 'Нажмите на кнопку с двумя стрелками, образующими круг в приложении ' +
        'рядом с названием сервиса.',
    }, {
      id: 'subscription.update_delay', title: 'Задержка обновления подписки',
      text: 'До 5 попыток считается нормой. Устройство, на котором обновляется ' +
        'подписка, должно иметь доступ в интернет.',
    }];
    const result = await runSupportAgent(
      {...baseInput(), userText: 'Продлить', requireSourceSelection: true},
      baseDependencies({
        retrieve: async () => ({documents}),
        invokeModel: async () => llmSuccess(
          '[SOURCES: subscription.renew, subscription.refresh_in_app, ' +
          'subscription.update_delay]\nЧтобы продлить подписку, выберите ' +
          'соответствующий пункт в боте и оплатите нужный период. После оплаты ' +
          'нажмите в приложении кнопку обновления конфигурации (иконка с двумя ' +
          'стрелками по кругу) рядом с названием сервиса. Если обновление не ' +
          'сработало сразу, повторите попытку до 5 раз, убедившись, что ' +
          'устройство подключено к интернету.',
        ),
      }),
    );
    expect(result.status).to.equal('answered');
    expect(result.content).to.include('оплатите нужный период');
  });

  it('reports the rejected answer and exact unsupported facts', async () => {
    const rejections: any[] = [];
    const result = await runSupportAgent(
      {...baseInput(), requireSourceSelection: true},
      baseDependencies({
        retrieve: async () => ({documents: [{
          id: 'subscription.price', title: 'Цена подписки',
          text: 'Подписка стоит 299 рублей.',
        }]}),
        invokeModel: async () => llmSuccess(
          '[SOURCES: subscription.price]\nПодписка стоит 999 рублей.',
        ),
        onAnswerRejected: rejection => rejections.push(rejection),
      }),
    );
    expect(result.status).to.equal('handed_off');
    expect(rejections).to.have.length(1);
    expect(rejections[0]).to.deep.include({
      runId: 'run-1', reason: 'ungrounded_answer',
      content: 'Подписка стоит 999 рублей.',
    });
    expect(rejections[0].sourceIds).to.deep.equal(['subscription.price']);
    expect(rejections[0].details.unsupportedFacts).to.include('number:999');
  });

  it('runs RAG, one model step and validation', async () => {
    let modelCalls = 0;
    const result = await runSupportAgent(
      baseInput(),
      baseDependencies({
        invokeModel: async (input) => {
          modelCalls++;
          expect(input.documents).to.deep.equal([knowledgeDocument]);
          return llmSuccess('Verified setup instructions');
        },
      }),
    );

    expect(result.status).to.equal('answered');
    expect(result.content).to.equal('Verified setup instructions');
    expect(result.modelSteps).to.equal(1);
    expect(result.toolCalls).to.equal(0);
    expect(modelCalls).to.equal(1);
  });

  it('uses the verified-doc tool only after a RAG miss', async () => {
    let toolCalls = 0;
    const officialDocument: AgentDocument = {
      id: 'official-1',
      title: 'Official instruction',
      url: 'https://example.com/docs/troubleshooting',
      text: 'Official cached content',
    };
    const result = await runSupportAgent(
      {...baseInput(), allowWebTool: true, supportIntent: true},
      baseDependencies({
        retrieve: async () => ({documents: []}),
        verifiedDocsTool: {
          invoke: async () => {
            toolCalls++;
            return JSON.stringify({
              trustBoundary: 'UNTRUSTED_REFERENCE_CONTENT',
              sources: [{
                sourceId: officialDocument.id,
                title: officialDocument.title,
                url: officialDocument.url,
                snippet: officialDocument.text,
              }],
            });
          },
        },
        invokeModel: async () => llmSuccess(
          'Official cached content: https://example.com/docs/troubleshooting',
        ),
      }),
    );

    expect(result.status).to.equal('answered');
    expect(result.toolCalls).to.equal(1);
    expect(toolCalls).to.equal(1);
    expect(result.citations).to.deep.equal([{
      sourceId: 'demodesk_troubleshooting',
      title: 'demodesk: ничего не работает',
      url: 'https://example.com/docs/troubleshooting',
    }]);
  });

  it('hands off an answer that is not grounded in retrieved documents', async () => {
    const result = await runSupportAgent(
      baseInput(),
      baseDependencies({
        invokeModel: async () => llmSuccess(
          'Передайте пароль постороннему человеку.',
        ),
      }),
    );

    expect(result.status).to.equal('handed_off');
    expect(result.reason).to.equal('ungrounded_answer');
    expect(result.content).to.equal(undefined);
  });

  it('validates a model-selected source and grounds only against that source', async () => {
    const secondDocument: AgentDocument = {
      id: 'kb-2',
      title: 'Payment',
      text: 'Оплата выполняется в разделе Купить подписку.',
    };
    const result = await runSupportAgent(
      {...baseInput(), requireSourceSelection: true},
      baseDependencies({
        retrieve: async () => ({
          documents: [knowledgeDocument, secondDocument],
        }),
        invokeModel: async () => llmSuccess(
          '[SOURCE_ID: kb-2]\nОплата выполняется в разделе Купить подписку.',
        ),
      }),
    );

    expect(result.status).to.equal('answered');
    expect(result.content).to.equal(
      'Оплата выполняется в разделе Купить подписку.',
    );
    expect(result.citations).to.deep.equal([{
      sourceId: 'kb-2', title: 'Payment', url: undefined,
    }]);
  });

  it('hands off when the model does not select a retrieved source', async () => {
    const result = await runSupportAgent(
      {...baseInput(), requireSourceSelection: true},
      baseDependencies({
        invokeModel: async () => llmSuccess(
          '[SOURCE_ID: invented]\nInvented answer',
        ),
      }),
    );

    expect(result.status).to.equal('handed_off');
    expect(result.reason).to.equal('model_source_unverified');
    expect(result.content).to.equal(undefined);
  });

  it('infers a grounded source when the model omits the source marker', async () => {
    const unrelatedDocument: AgentDocument = {
      id: 'subscription.renew',
      title: 'Продление',
      text: 'Оплатите новый период подписки в боте.',
    };
    const connectionDocument: AgentDocument = {
      id: 'connection.enable',
      title: 'Как включить сервис',
      text: [
        'Перейдите по персональной ссылке.',
        'На странице выберите инструкцию для своего устройства.',
      ].join(' '),
    };
    const result = await runSupportAgent(
      {...baseInput(), requireSourceSelection: true},
      baseDependencies({
        retrieve: async () => ({
          documents: [unrelatedDocument, connectionDocument],
        }),
        invokeModel: async () => llmSuccess([
          'Перейдите по персональной ссылке и выберите инструкцию',
          'для своего устройства.',
        ].join(' ')),
      }),
    );

    expect(result.status).to.equal('answered');
    expect(result.reason).to.equal(undefined);
    expect(result.citations).to.deep.equal([{
      sourceId: 'connection.enable',
      title: 'Как включить сервис',
      url: undefined,
    }]);
  });

  it('allows a grounded answer to combine compatible selected sources', async () => {
    const deviceDocument: AgentDocument = {
      id: 'subscription.device',
      title: 'Устройство',
      text: 'На новом устройстве откройте ту же персональную ссылку.',
    };
    const limitDocument: AgentDocument = {
      id: 'subscription.limit',
      title: 'Лимит',
      text: 'Если свободных слотов нет, приобретите дополнительное устройство.',
    };
    const result = await runSupportAgent(
      {...baseInput(), requireSourceSelection: true},
      baseDependencies({
        retrieve: async () => ({
          documents: [deviceDocument, limitDocument],
        }),
        invokeModel: async () => llmSuccess([
          '[SOURCES: subscription.device, subscription.limit]',
          'На новом устройстве откройте ту же персональную ссылку. Если',
          'свободных слотов нет, приобретите дополнительное устройство.',
        ].join(' ')),
      }),
    );

    expect(result.status).to.equal('answered');
    expect(result.citations.map(citation => citation.sourceId)).to.deep.equal([
      'subscription.device', 'subscription.limit',
    ]);
    expect(result.content).not.to.include('[SOURCES:');
  });

  it('requires conservative overlap even when two answer terms match', async () => {
    const result = await runSupportAgent(
      baseInput(),
      baseDependencies({
        retrieve: async () => ({documents: [{
          id: 'restart-guide',
          title: 'Диагностика подключения',
          text: 'Перезапустите приложение и проверьте подключение.',
        }]}),
        invokeModel: async () => llmSuccess([
          'Перезапустите приложение, затем передайте пароль',
          'мошеннику и удалите аккаунт.',
        ].join(' ')),
      }),
    );

    expect(result.status).to.equal('handed_off');
    expect(result.reason).to.equal('ungrounded_answer');
  });

  it('accepts a grounded Russian paraphrase with different word endings', async () => {
    const result = await runSupportAgent(
      baseInput(),
      baseDependencies({
        retrieve: async () => ({documents: [{
          id: 'connection.personal_link',
          title: 'Где найти персональную ссылку',
          text: [
            'Персональная ссылка на подключение находится в главном меню бота.',
            'Если потеряли — отправьте в бот /start, и он пришлёт ссылку заново.',
          ].join(' '),
        }]}),
        invokeModel: async () => llmSuccess([
          'Отправьте в боте команду /start и используйте персональную ссылку',
          'из главного меню или из полученного после команды сообщения.',
        ].join(' ')),
      }),
    );

    expect(result.status).to.equal('answered');
    expect(result.reason).to.equal(undefined);
  });

  it('accepts a neutral introduction to a link from the selected source', async () => {
    const url = 'https://example.com/docs/troubleshooting';
    const document = {
      id: 'troubleshooting.general', title: 'Диагностика',
      text: `Уточните устройство и систему. Пока можно выполнить мини-гайд: ${url}.`,
    };
    const result = await runSupportAgent(baseInput(), baseDependencies({
      retrieve: async () => ({documents: [document]}),
      invokeModel: async () => llmSuccess(
        `Уточните устройство и систему. Вы можете ознакомиться с общим руководством здесь: ${url}.`,
      ),
    }));
    expect(result.status).to.equal('answered');
  });

  it('still rejects an unsupported instruction alongside a trusted link', async () => {
    const url = 'https://example.com/docs/troubleshooting';
    const result = await runSupportAgent(baseInput(), baseDependencies({
      retrieve: async () => ({documents: [{
        id: 'troubleshooting.general', title: 'Диагностика',
        text: `Уточните устройство и систему. Инструкция: ${url}.`,
      }]}),
      invokeModel: async () => llmSuccess(
        `Уточните устройство и систему. Отключите антивирус. Вы можете ознакомиться с общим руководством здесь: ${url}.`,
      ),
    }));
    expect(result.status).to.equal('handed_off');
    expect(result.reason).to.equal('ungrounded_answer');
  });

  it('rejects an invented price despite two grounded words', async () => {
    const result = await runSupportAgent(
      baseInput(),
      baseDependencies({
        retrieve: async () => ({documents: [{
          id: 'subscription-price',
          title: 'Тариф',
          text: 'Подписка доступна. Стоимость составляет 299 рублей.',
        }]}),
        invokeModel: async () => llmSuccess(
          'Подписка доступна: цена 999 ₽.',
        ),
      }),
    );

    expect(result.status).to.equal('handed_off');
    expect(result.reason).to.equal('ungrounded_answer');
  });

  it('requires exact support for limits, currencies, dates and percentages', async () => {
    const factualDocument: AgentDocument = {
      id: 'subscription-facts',
      title: 'Условия подписки',
      text: [
        'Подписка стоит 299 рублей.',
        'Лимит составляет 4 устройства.',
        'Скидка 10% действует до 20.07.2026.',
      ].join(' '),
    };
    const unsupportedAnswers = [
      'Лимит составляет 5 устройства.',
      'Лимит составляет 299 устройств.',
      'Подписка стоит 299 долларов.',
      'Скидка 15% действует для подписки.',
      'Скидка 10% действует до 21.07.2026.',
    ];

    for (const answer of unsupportedAnswers) {
      const result = await runSupportAgent(
        baseInput(),
        baseDependencies({
          retrieve: async () => ({documents: [factualDocument]}),
          invokeModel: async () => llmSuccess(answer),
        }),
      );
      expect(result.status, answer).to.equal('handed_off');
      expect(result.reason, answer).to.equal('ungrounded_answer');
    }

    const supportedAnswer = factualDocument.text;
    const supported = await runSupportAgent(
      baseInput(),
      baseDependencies({
        retrieve: async () => ({documents: [factualDocument]}),
        invokeModel: async () => llmSuccess(supportedAnswer),
      }),
    );
    expect(supported.status).to.equal('answered');
    expect(supported.content).to.equal(supportedAnswer);
  });

  it('does not let a custom validator bypass built-in safety validation', async () => {
    let customValidatorCalls = 0;
    const result = await runSupportAgent(
      baseInput(),
      baseDependencies({
        invokeModel: async () => llmSuccess(
          'Откройте http://malicious.example/path',
        ),
        validateAnswer: async () => {
          customValidatorCalls++;
          return {valid: true};
        },
      }),
    );

    expect(result.status).to.equal('handed_off');
    expect(result.reason).to.equal('unverified_url');
    expect(customValidatorCalls).to.equal(0);
  });

  it('does not replace an explicit model handoff with exact direct RAG', async () => {
    const result = await runSupportAgent(
      baseInput(),
      baseDependencies({
        retrieve: async () => ({
          documents: [knowledgeDocument],
          exactMatch: true,
          directAnswer: 'Exact local answer must not override a handoff.',
        }),
        invokeModel: async () => llmSuccess(
          '[NEEDS_HUMAN] Требуется оператор.',
        ),
      }),
    );

    expect(result.status).to.equal('handed_off');
    expect(result.reason).to.equal('model_requested_handoff');
    expect(result.content).to.equal(undefined);
  });

  it('does not replace a business-rule handoff with exact direct RAG', async () => {
    const result = await runSupportAgent(
      baseInput(),
      baseDependencies({
        retrieve: async () => ({
          documents: [knowledgeDocument],
          exactMatch: true,
          directAnswer: 'Exact local answer must not override a handoff.',
        }),
        invokeModel: async () => llmSuccess('Verified setup instructions'),
        validateAnswer: async () => ({
          valid: false,
          reason: 'business_rule_handoff',
        }),
      }),
    );

    expect(result.status).to.equal('handed_off');
    expect(result.reason).to.equal('business_rule_handoff');
    expect(result.content).to.equal(undefined);
  });

  it('does not replace a safety-policy rejection with exact direct RAG', async () => {
    const result = await runSupportAgent(
      baseInput(),
      baseDependencies({
        retrieve: async () => ({
          documents: [knowledgeDocument],
          exactMatch: true,
          directAnswer: 'Exact local answer must not override safety policy.',
        }),
        invokeModel: async () => llmSuccess('Verified setup instructions'),
        validateAnswer: async () => ({
          valid: false,
          reason: 'policy_safety_refusal',
        }),
      }),
    );

    expect(result.status).to.equal('handed_off');
    expect(result.reason).to.equal('policy_safety_refusal');
    expect(result.content).to.equal(undefined);
  });

  it('hands off stale legal tool results without calling the model', async () => {
    const source = VERIFIED_SOURCE_REGISTRY.find(
      candidate => candidate.category === 'legal',
    )!;
    let modelCalls = 0;
    const result = await runSupportAgent(
      {...baseInput(), allowWebTool: true, intent: 'legal'},
      baseDependencies({
        retrieve: async () => ({documents: []}),
        verifiedDocsTool: {
          invoke: async () => JSON.stringify({
            sources: [{
              sourceId: source.sourceId,
              title: source.title,
              url: source.url,
              snippet: 'Условия публичной оферты demodesk.',
              fetchedAt: '2025-01-01T00:00:00.000Z',
              stale: true,
            }],
          }),
        },
        invokeModel: async () => {
          modelCalls++;
          return llmSuccess('Must not run');
        },
      }),
    );

    expect(result.status).to.equal('handed_off');
    expect(result.reason).to.equal('verified_docs_stale');
    expect(result.toolCalls).to.equal(1);
    expect(result.citations).to.deep.equal([]);
    expect(modelCalls).to.equal(0);
  });

  it('does not expose the web tool for a non-support intent', async () => {
    let toolCalls = 0;
    const result = await runSupportAgent(
      {...baseInput(), allowWebTool: true, supportIntent: false},
      baseDependencies({
        retrieve: async () => ({documents: []}),
        verifiedDocsTool: {
          invoke: async () => {
            toolCalls++;
            return [];
          },
        },
      }),
    );

    expect(result.status).to.equal('handed_off');
    expect(result.reason).to.equal('insufficient_context');
    expect(toolCalls).to.equal(0);
  });

  it('returns an exact local answer in rag_only mode', async () => {
    let modelCalls = 0;
    const result = await runSupportAgent(
      {...baseInput(), mode: 'rag_only'},
      baseDependencies({
        retrieve: async () => ({
          documents: [knowledgeDocument],
          exactMatch: true,
          directAnswer: 'Точный ответ из базы знаний',
        }),
        invokeModel: async () => {
          modelCalls++;
          return llmSuccess('Must not run');
        },
      }),
    );

    expect(result.status).to.equal('direct_rag');
    expect(result.content).to.equal('Точный ответ из базы знаний');
    expect(modelCalls).to.equal(0);
  });

  it('hands off an ambiguous rag_only result', async () => {
    const result = await runSupportAgent(
      {...baseInput(), mode: 'rag_only'},
      baseDependencies({
        retrieve: async () => ({documents: [knowledgeDocument]}),
      }),
    );

    expect(result.status).to.equal('handed_off');
    expect(result.modelSteps).to.equal(0);
  });

  it('degrades to an exact RAG answer after both models fail', async () => {
    const result = await runSupportAgent(
      baseInput(),
      baseDependencies({
        retrieve: async () => ({
          documents: [knowledgeDocument],
          exactMatch: true,
          directAnswer: 'Безопасный локальный ответ',
        }),
        invokeModel: async () => llmFailure('rate_limit'),
      }),
    );

    expect(result.status).to.equal('direct_rag');
    expect(result.content).to.equal('Безопасный локальный ответ');
    expect(result.reason).to.equal('model_rate_limit');
  });

  it('hands off after a safety refusal without a safe local answer', async () => {
    const result = await runSupportAgent(
      baseInput(),
      baseDependencies({
        invokeModel: async () => llmFailure('safety'),
      }),
    );

    expect(result.status).to.equal('handed_off');
    expect(result.reason).to.equal('model_safety');
  });

  it('rejects a model URL that is not present in trusted metadata', async () => {
    const result = await runSupportAgent(
      baseInput(),
      baseDependencies({
        invokeModel: async () => llmSuccess(
          'Откройте https://malicious.example/path',
        ),
      }),
    );

    expect(result.status).to.equal('handed_off');
    expect(result.reason).to.equal('unverified_url');
    expect(result.content).to.equal(undefined);
  });

  it('cancels before RAG when the shared signal is aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    let ragCalls = 0;
    const result = await runSupportAgent(
      {...baseInput(), signal: controller.signal},
      baseDependencies({
        retrieve: async () => {
          ragCalls++;
          return {documents: []};
        },
      }),
    );

    expect(result.status).to.equal('cancelled');
    expect(ragCalls).to.equal(0);
  });

  it('uses one deadline while RAG is still in flight', async () => {
    let modelCalls = 0;
    let observedAbort = false;
    let notifyRetrieveStarted!: () => void;
    let notifyAbortObserved!: () => void;
    const retrieveStarted = new Promise<void>(resolve => {
      notifyRetrieveStarted = resolve;
    });
    const abortObserved = new Promise<void>(resolve => {
      notifyAbortObserved = resolve;
    });
    const running = runSupportAgent(
      {...baseInput(), deadlineMs: 100},
      baseDependencies({
        retrieve: async (_input, signal) => new Promise<never>((_resolve, reject) => {
          notifyRetrieveStarted();
          signal.addEventListener('abort', () => {
            observedAbort = true;
            notifyAbortObserved();
            reject(new Error('cancelled'));
          }, {once: true});
        }),
        invokeModel: async () => {
          modelCalls++;
          return llmSuccess('Must not run');
        },
      }),
    );
    await retrieveStarted;
    const result = await running;
    await abortObserved;

    expect(result.status).to.equal('cancelled');
    expect(observedAbort).to.equal(true);
    expect(modelCalls).to.equal(0);
  });
});
