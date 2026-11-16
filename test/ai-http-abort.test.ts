import {expect} from 'chai';
import {fetchJsonWithTimeout} from '../src/ai';

describe('AI HTTP cancellation', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('keeps the shared abort active while Qdrant JSON is streaming', async () => {
    const controller = new AbortController();
    let transportSignal: AbortSignal | undefined;
    let bodyStarted!: () => void;
    const started = new Promise<void>(resolve => {
      bodyStarted = resolve;
    });
    global.fetch = (async (_input: any, init?: RequestInit) => {
      transportSignal = init?.signal;
      return {
        ok: true,
        json: async () => {
          bodyStarted();
          return new Promise((_resolve, reject) => {
            const abort = () => reject(new DOMException(
              'The operation was aborted',
              'AbortError',
            ));
            if (transportSignal?.aborted) abort();
            else transportSignal?.addEventListener('abort', abort, {
              once: true,
            });
          });
        },
      } as Response;
    }) as typeof fetch;

    const pending = fetchJsonWithTimeout(
      'http://qdrant:6333/collections/support/points/query',
      {method: 'POST'},
      30000,
      controller.signal,
    );
    await started;
    controller.abort('staff_takeover');

    let failure: any;
    try {
      await pending;
    } catch (error) {
      failure = error;
    }
    expect(transportSignal?.aborted).to.equal(true);
    expect(failure?.name).to.equal('AbortError');
  });
});
