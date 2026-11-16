import {expect} from 'chai';
import {
  evaluateAiSlo,
  recordDependencyStatus,
  recordProviderRun,
  recordTicketDeliveryFailure,
  recordTicketDeliverySuccess,
  resetOperationalAlertsForTests,
} from '../src/operational-alerts';

describe('Operational AI alerts', () => {
  let timestamp: number;
  let messages: string[];

  beforeEach(() => {
    timestamp = 1_700_000_000_000;
    messages = [];
    resetOperationalAlertsForTests({
      now: () => timestamp,
      sender: async message => messages.push(message),
    });
  });

  it('alerts after three dependency errors, deduplicates and recovers', async () => {
    await recordDependencyStatus('qdrant', false);
    await recordDependencyStatus('qdrant', false);
    expect(messages).to.deep.equal([]);
    await recordDependencyStatus('qdrant', false);
    await recordDependencyStatus('qdrant', false);
    expect(messages).to.have.length(1);
    expect(messages[0]).to.contain('три последовательных сбоя');

    timestamp += 30 * 60 * 1000;
    await recordDependencyStatus('qdrant', false);
    expect(messages).to.have.length(2);
    await recordDependencyStatus('qdrant', true);
    expect(messages).to.have.length(3);
    expect(messages[2]).to.contain('Восстановление');
  });

  it('alerts only when both direct providers are unavailable', async () => {
    await recordProviderRun([{
      provider: 'gemini',
      model: 'gemini-model',
      startedAt: timestamp,
      latencyMs: 1,
      outcome: 'failure',
      reason: 'rate_limit',
    }, {
      provider: 'mistral',
      model: 'mistral-model',
      startedAt: timestamp,
      latencyMs: 1,
      outcome: 'failure',
      reason: 'provider_error',
    }]);
    expect(messages.some(message =>
      message.includes('одновременно недоступны'),
    )).to.equal(true);

    await recordProviderRun([{
      provider: 'gemini',
      model: 'gemini-model',
      startedAt: timestamp,
      latencyMs: 1,
      outcome: 'success',
    }]);
    expect(messages.some(message =>
      message.includes('хотя бы один LLM-провайдер'),
    )).to.equal(true);
  });

  it('uses a minimum sample before raising SLO alerts', async () => {
    await evaluateAiSlo({
      llmRuns: 19,
      successfulRuns: 0,
      fallbackRuns: 19,
      latencyP95Ms: 30000,
    });
    expect(messages).to.deep.equal([]);
    await evaluateAiSlo({
      llmRuns: 20,
      successfulRuns: 18,
      fallbackRuns: 5,
      latencyP95Ms: 16000,
    });
    expect(messages).to.have.length(3);
  });

  it('alerts for Gemini alone on 503 and timeout, then recovers on success', async () => {
    const attempt = {provider: 'gemini' as const, model: 'gemini-model',
      startedAt: timestamp, latencyMs: 1, outcome: 'failure' as const};
    await recordProviderRun([{...attempt, reason: 'provider_error', status: 503}], 18);
    expect(messages).to.have.length(1);
    expect(messages[0]).to.contain('HTTP 503; тикет №18');
    await recordProviderRun([{...attempt, reason: 'timeout'}], 19);
    expect(messages).to.have.length(1);
    timestamp += 30 * 60 * 1000;
    await recordProviderRun([{...attempt, reason: 'timeout'}], 19);
    expect(messages[1]).to.contain('тайм-аут; тикет №19');
    await recordProviderRun([{...attempt, outcome: 'success'}]);
    expect(messages[2]).to.contain('Восстановление');
  });

  it('does not alert for a recovered retry or a cancelled run', async () => {
    const attempt = {provider: 'gemini' as const, model: 'gemini-model',
      startedAt: timestamp, latencyMs: 1, outcome: 'failure' as const};
    await recordProviderRun([{...attempt, reason: 'provider_error', status: 503},
      {...attempt, outcome: 'success'}]);
    await recordProviderRun([{...attempt, reason: 'rate_limit', status: 429},
      {...attempt, outcome: 'success'}]);
    await recordProviderRun([{...attempt, reason: 'provider_error', status: 503},
      {...attempt, reason: 'cancelled'}]);
    expect(messages).to.deep.equal([]);
  });

  it('does not announce auth recovery after a different failure', async () => {
    const attempt = {provider: 'gemini' as const, model: 'gemini-model',
      startedAt: timestamp, latencyMs: 1, outcome: 'failure' as const};
    await recordProviderRun([{...attempt, reason: 'auth'}]);
    await recordProviderRun([{...attempt, reason: 'timeout'}]);
    expect(messages.some(message => message.includes('Восстановление'))).to.equal(false);
  });

  it('deduplicates delivery warnings per ticket and resets after delivery', async () => {
    await recordTicketDeliveryFailure(18, 'bot_blocked');
    await recordTicketDeliveryFailure(18, 'bot_blocked');
    await recordTicketDeliveryFailure(19, 'timeout');
    expect(messages).to.have.length(2);
    expect(messages[0]).to.contain('пользователь заблокировал бота');
    await recordTicketDeliverySuccess(18);
    expect(messages[2]).to.contain('успешно отправлен');
    await recordTicketDeliveryFailure(18, 'timeout');
    expect(messages).to.have.length(4);
  });

  it('retries a warning if the alert channel failed to accept it', async () => {
    let calls = 0;
    resetOperationalAlertsForTests({now: () => timestamp, sender: async message => {
      if (++calls === 1) throw new Error('Telegram unavailable');
      messages.push(message);
    }});
    await recordTicketDeliveryFailure(18, 'timeout');
    await recordTicketDeliveryFailure(18, 'timeout');
    expect(calls).to.equal(2);
    expect(messages).to.have.length(1);
  });
});
