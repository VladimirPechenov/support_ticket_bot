export interface MistralEmbeddingConfig {
  model: string;
  dimensions?: number;
  timeoutMs?: number;
}

export interface MistralEmbeddingDependencies {
  fetchImpl?: typeof fetch;
  apiKey?: string;
}

export class MistralEmbeddingError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = 'MistralEmbeddingError';
  }
}

function linkedSignal(
  parent: AbortSignal | undefined,
  timeoutMs: number,
): {signal: AbortSignal; cleanup: () => void} {
  const controller = new AbortController();
  const abort = () => controller.abort(parent?.reason);
  if (parent?.aborted) abort();
  else parent?.addEventListener('abort', abort, {once: true});
  const timer = setTimeout(() => controller.abort(), Math.max(1, timeoutMs));
  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timer);
      parent?.removeEventListener('abort', abort);
    },
  };
}

export async function embedMistralTexts(
  texts: string[],
  config: MistralEmbeddingConfig,
  signal?: AbortSignal,
  dependencies: MistralEmbeddingDependencies = {},
): Promise<number[][]> {
  const model = config.model.trim();
  const apiKey = dependencies.apiKey || process.env.MISTRAL_API_KEY;
  if (!model) throw new MistralEmbeddingError('Embedding model is required');
  if (!apiKey) throw new MistralEmbeddingError('MISTRAL_API_KEY is required');
  if (!texts.length || texts.some(text => !text.trim())) {
    throw new MistralEmbeddingError('Embedding text is empty');
  }

  const linked = linkedSignal(signal, config.timeoutMs || 10000);
  try {
    const response = await (dependencies.fetchImpl || fetch)(
      'https://api.mistral.ai/v1/embeddings',
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({model, input: texts}),
        signal: linked.signal,
      },
    );
    if (!response.ok) {
      throw new MistralEmbeddingError(
        'Mistral embedding request failed',
        response.status,
      );
    }
    const payload = await response.json() as any;
    const rows = Array.isArray(payload?.data) ? [...payload.data] : [];
    rows.sort((left, right) => Number(left?.index) - Number(right?.index));
    const vectors = rows.map(row => row?.embedding);
    if (vectors.length !== texts.length || vectors.some(vector =>
      !Array.isArray(vector) ||
      vector.length === 0 ||
      vector.some((value: unknown) => !Number.isFinite(Number(value))),
    )) {
      throw new MistralEmbeddingError('Mistral returned invalid embeddings');
    }
    if (
      config.dimensions &&
      vectors.some(vector => vector.length !== config.dimensions)
    ) {
      throw new MistralEmbeddingError('Mistral embedding dimension mismatch');
    }
    return vectors.map(vector => vector.map(Number));
  } catch (error) {
    if (error instanceof MistralEmbeddingError) throw error;
    if (linked.signal.aborted) {
      throw new MistralEmbeddingError(
        signal?.aborted ? 'Embedding request cancelled' : 'Embedding timeout',
      );
    }
    throw new MistralEmbeddingError('Mistral embedding request failed');
  } finally {
    linked.cleanup();
  }
}

export async function embedMistralText(
  text: string,
  config: MistralEmbeddingConfig,
  signal?: AbortSignal,
  dependencies: MistralEmbeddingDependencies = {},
): Promise<number[]> {
  return (await embedMistralTexts(
    [text], config, signal, dependencies,
  ))[0];
}
