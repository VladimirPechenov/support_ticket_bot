import {expect} from 'chai';
import {
  embedGeminiText,
  GeminiEmbeddingError,
} from '../src/gemini-embeddings';

function asFetch(
  implementation: (
    input: string | URL | Request,
    init?: RequestInit,
  ) => Promise<Response>,
): typeof fetch {
  return implementation as typeof fetch;
}

describe('direct Gemini embeddings security', () => {
  it('uses the direct Google endpoint and requested embedding contract', async () => {
    let capturedUrl = '';
    let capturedInit: RequestInit | undefined;
    const vector = await embedGeminiText(
      'Как настроить сервис?',
      {model: 'models/gemini-embedding-001', dimensions: 3},
      'RETRIEVAL_QUERY',
      undefined,
      {
        apiKey: 'google-test-key',
        fetchImpl: asFetch(async (input, init) => {
          capturedUrl = String(input);
          capturedInit = init;
          return new Response(JSON.stringify({
            embedding: {values: [0.1, '0.2', 0.3]},
          }), {status: 200, headers: {'Content-Type': 'application/json'}});
        }),
      },
    );

    expect(vector).to.deep.equal([0.1, 0.2, 0.3]);
    expect(capturedUrl).to.equal(
      'https://generativelanguage.googleapis.com/v1beta/models/' +
      'gemini-embedding-001:embedContent',
    );
    expect(capturedUrl).not.to.include('google-test-key');
    expect((capturedInit?.headers as Record<string, string>)['x-goog-api-key'])
      .to.equal('google-test-key');
    const body = JSON.parse(String(capturedInit?.body));
    expect(body).to.deep.include({
      model: 'models/gemini-embedding-001',
      taskType: 'RETRIEVAL_QUERY',
      outputDimensionality: 3,
    });
  });

  it('propagates AbortSignal without exposing its reason or input text', async () => {
    const controller = new AbortController();
    let notifyStarted!: () => void;
    const started = new Promise<void>(resolve => {
      notifyStarted = resolve;
    });
    const request = embedGeminiText(
      'private embedding text',
      {model: 'gemini-embedding-001', dimensions: 2},
      'RETRIEVAL_QUERY',
      controller.signal,
      {
        apiKey: 'secret-google-key',
        fetchImpl: asFetch(async (_input, init) => {
          notifyStarted();
          return new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => {
              reject(init.signal?.reason || new Error('aborted'));
            }, {once: true});
          });
        }),
      },
    );
    await started;
    controller.abort(new Error(
      'operator takeover secret-google-key private embedding text',
    ));

    let received: unknown;
    try {
      await request;
    } catch (error) {
      received = error;
    }
    expect(received).to.be.instanceOf(GeminiEmbeddingError);
    expect((received as Error).message).to.equal('Embedding request cancelled');
    expect((received as Error).message).not.to.include('secret-google-key');
    expect((received as Error).message).not.to.include('private embedding text');
  });

  it('redacts provider response bodies and thrown transport details', async () => {
    const providerError = embedGeminiText(
      'customer private query',
      {model: 'gemini-embedding-001'},
      'RETRIEVAL_QUERY',
      undefined,
      {
        apiKey: 'secret-google-key',
        fetchImpl: asFetch(async () => new Response(JSON.stringify({
          error: {message: 'secret-google-key customer private query'},
        }), {status: 429, headers: {'Content-Type': 'application/json'}})),
      },
    );
    let providerFailure: unknown;
    try {
      await providerError;
    } catch (error) {
      providerFailure = error;
    }
    expect(providerFailure).to.be.instanceOf(GeminiEmbeddingError);
    expect((providerFailure as GeminiEmbeddingError).status).to.equal(429);
    expect((providerFailure as Error).message)
      .to.equal('Gemini embedding request failed');

    const transportError = embedGeminiText(
      'another private query',
      {model: 'gemini-embedding-001'},
      'RETRIEVAL_QUERY',
      undefined,
      {
        apiKey: 'another-secret-key',
        fetchImpl: asFetch(async () => {
          throw new Error('another-secret-key another private query');
        }),
      },
    );
    let transportFailure: unknown;
    try {
      await transportError;
    } catch (error) {
      transportFailure = error;
    }
    expect((transportFailure as Error).message)
      .to.equal('Gemini embedding request failed');
    expect(JSON.stringify(transportFailure)).not.to.include('another-secret-key');
    expect(JSON.stringify(transportFailure)).not.to.include('another private query');
  });

  it('reports invalid vectors without including the provider payload', async () => {
    const request = embedGeminiText(
      'private dimension query',
      {model: 'gemini-embedding-001', dimensions: 3},
      'RETRIEVAL_QUERY',
      undefined,
      {
        apiKey: 'google-test-key',
        fetchImpl: asFetch(async () => new Response(JSON.stringify({
          embedding: {values: [1, 2]},
          secret: 'private provider payload',
        }), {status: 200, headers: {'Content-Type': 'application/json'}})),
      },
    );
    let received: unknown;
    try {
      await request;
    } catch (error) {
      received = error;
    }
    expect((received as Error).message)
      .to.equal('Gemini embedding dimension mismatch');
    expect(JSON.stringify(received)).not.to.include('private provider payload');
  });
});
