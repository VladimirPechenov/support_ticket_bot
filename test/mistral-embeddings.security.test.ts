import {expect} from 'chai';
import {
  embedMistralText,
  embedMistralTexts,
  MistralEmbeddingError,
} from '../src/mistral-embeddings';

describe('Mistral embeddings transport', () => {
  it('uses the direct API, bearer auth and preserves batch order', async () => {
    let request: any;
    const vectors = await embedMistralTexts(
      ['первый', 'второй'],
      {model: 'mistral-embed', dimensions: 2},
      undefined,
      {
        apiKey: 'secret',
        fetchImpl: (async (url: string, options: any) => {
          request = {url, options};
          return {
            ok: true,
            json: async () => ({data: [
              {index: 1, embedding: [3, 4]},
              {index: 0, embedding: [1, 2]},
            ]}),
          } as Response;
        }) as typeof fetch,
      },
    );

    expect(request.url).to.equal('https://api.mistral.ai/v1/embeddings');
    expect(request.options.headers.Authorization).to.equal('Bearer secret');
    expect(JSON.parse(request.options.body)).to.deep.equal({
      model: 'mistral-embed', input: ['первый', 'второй'],
    });
    expect(vectors).to.deep.equal([[1, 2], [3, 4]]);
  });

  it('does not include provider response bodies or keys in errors', async () => {
    let error: unknown;
    try {
      await embedMistralText(
        'запрос',
        {model: 'mistral-embed'},
        undefined,
        {
          apiKey: 'do-not-leak',
          fetchImpl: (async () => ({
            ok: false,
            status: 401,
            json: async () => ({detail: 'sensitive provider body'}),
          })) as unknown as typeof fetch,
        },
      );
    } catch (caught) {
      error = caught;
    }
    expect(error).to.be.instanceOf(MistralEmbeddingError);
    expect(String(error)).not.to.include('do-not-leak');
    expect(String(error)).not.to.include('sensitive provider body');
    expect((error as MistralEmbeddingError).status).to.equal(401);
  });

  it('physically aborts the request when the parent signal is aborted', async () => {
    const controller = new AbortController();
    let observedSignal: AbortSignal | undefined;
    const promise = embedMistralText(
      'запрос',
      {model: 'mistral-embed', timeoutMs: 1000},
      controller.signal,
      {
        apiKey: 'secret',
        fetchImpl: ((_: string, options: any) => {
          observedSignal = options.signal;
          return new Promise((_, reject) => options.signal.addEventListener(
            'abort', () => reject(new Error('aborted')), {once: true},
          ));
        }) as typeof fetch,
      },
    );
    controller.abort();
    let error: unknown;
    try {
      await promise;
    } catch (caught) {
      error = caught;
    }
    expect(observedSignal?.aborted).to.equal(true);
    expect(error).to.be.instanceOf(MistralEmbeddingError);
    expect((error as Error).message).to.equal('Embedding request cancelled');
  });
});
