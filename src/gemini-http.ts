import nodeFetch, {RequestInit as NodeFetchRequestInit} from 'node-fetch';
import {SocksProxyAgent} from 'socks-proxy-agent';

export type GeminiFetch = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

const proxyAgents = new Map<string, SocksProxyAgent>();
const allowedProxyProtocols = new Set([
  'socks:',
  'socks4:',
  'socks4a:',
  'socks5:',
  'socks5h:',
]);

export function configuredGeminiProxyUrl(): string | undefined {
  const value = String(process.env.GEMINI_PROXY_URL || '').trim();
  if (!value) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error('GEMINI_PROXY_URL is invalid');
  }
  if (!allowedProxyProtocols.has(parsed.protocol) || !parsed.hostname) {
    throw new Error('GEMINI_PROXY_URL must be a SOCKS proxy URL');
  }
  return value;
}

function proxyAgent(proxyUrl: string): SocksProxyAgent {
  const existing = proxyAgents.get(proxyUrl);
  if (existing) return existing;
  const created = new SocksProxyAgent(proxyUrl);
  proxyAgents.set(proxyUrl, created);
  return created;
}

export async function geminiFetch(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  const proxyUrl = configuredGeminiProxyUrl();
  if (!proxyUrl) return fetch(input, init);

  const request = new Request(input, init);
  const headers: Record<string, string> = {};
  request.headers.forEach((value, name) => {
    headers[name] = value;
  });
  const nodeInit: NodeFetchRequestInit = {
    method: request.method,
    headers,
    redirect: request.redirect,
    signal: request.signal as any,
    agent: proxyAgent(proxyUrl),
  };
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    nodeInit.body = Buffer.from(await request.arrayBuffer());
  }

  const response = await nodeFetch(request.url, nodeInit);
  const responseHeaders: Record<string, string> = {};
  response.headers.forEach((value, name) => {
    responseHeaders[name] = value;
  });
  return new Response(await response.arrayBuffer(), {
    status: response.status,
    statusText: response.statusText,
    headers: responseHeaders,
  });
}

export function createGeminiApiClient(
  apiKey: string | undefined,
  fetchImpl: GeminiFetch = geminiFetch,
): {
  hasApiKey: () => boolean;
  getProjectId: () => Promise<string>;
  fetch: (request: Request) => Promise<Response>;
} {
  return {
    hasApiKey: () => !!apiKey,
    getProjectId: async () => 'unknown-project-id',
    fetch: async (request: Request): Promise<Response> => {
      if (!apiKey) throw new Error('GOOGLE_API_KEY is required');
      request.headers.set('x-goog-api-key', apiKey);
      return fetchImpl(request);
    },
  };
}
