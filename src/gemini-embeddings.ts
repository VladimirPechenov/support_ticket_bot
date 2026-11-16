import {geminiFetch} from './gemini-http';

export type GeminiEmbeddingTask =
  | 'RETRIEVAL_QUERY'
  | 'RETRIEVAL_DOCUMENT';

export interface GeminiEmbeddingConfig {
  model: string;
  dimensions?: number;
  timeoutMs?: number;
}

export interface GeminiEmbeddingDependencies {
  fetchImpl?: typeof fetch;
  apiKey?: string;
}

export class GeminiEmbeddingError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = 'GeminiEmbeddingError';
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

function normalizedModel(model: string): string {
  return model.trim().replace(/^models\//, '');
}

export async function embedGeminiText(
  text: string,
  config: GeminiEmbeddingConfig,
  taskType: GeminiEmbeddingTask,
  signal?: AbortSignal,
  dependencies: GeminiEmbeddingDependencies = {},
): Promise<number[]> {
  const model = normalizedModel(config.model);
  const apiKey = dependencies.apiKey || process.env.GOOGLE_API_KEY;
  if (!model) throw new GeminiEmbeddingError('Embedding model is required');
  if (!apiKey) throw new GeminiEmbeddingError('GOOGLE_API_KEY is required');
  if (!text.trim()) throw new GeminiEmbeddingError('Embedding text is empty');

  const linked = linkedSignal(signal, config.timeoutMs || 10000);
  try {
    const response = await (dependencies.fetchImpl || geminiFetch)(
      `https://generativelanguage.googleapis.com/v1beta/models/${
        encodeURIComponent(model)
      }:embedContent`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': apiKey,
        },
        body: JSON.stringify({
          model: `models/${model}`,
          content: {parts: [{text}]},
          taskType,
          ...(config.dimensions ?
            {outputDimensionality: config.dimensions} : {}),
        }),
        signal: linked.signal,
      },
    );
    if (!response.ok) {
      throw new GeminiEmbeddingError(
        'Gemini embedding request failed',
        response.status,
      );
    }
    const payload = await response.json() as any;
    const values = payload?.embedding?.values;
    if (
      !Array.isArray(values) ||
      values.length === 0 ||
      values.some((value: unknown) => !Number.isFinite(Number(value)))
    ) {
      throw new GeminiEmbeddingError('Gemini returned an invalid embedding');
    }
    if (config.dimensions && values.length !== config.dimensions) {
      throw new GeminiEmbeddingError('Gemini embedding dimension mismatch');
    }
    return values.map(Number);
  } catch (error) {
    if (error instanceof GeminiEmbeddingError) throw error;
    if (linked.signal.aborted) {
      throw new GeminiEmbeddingError(
        signal?.aborted ? 'Embedding request cancelled' : 'Embedding timeout',
      );
    }
    throw new GeminiEmbeddingError('Gemini embedding request failed');
  } finally {
    linked.cleanup();
  }
}
