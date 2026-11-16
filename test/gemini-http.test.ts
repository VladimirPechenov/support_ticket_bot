import {expect} from 'chai';
import {
  configuredGeminiProxyUrl,
  createGeminiApiClient,
} from '../src/gemini-http';

describe('Gemini SOCKS transport', () => {
  const originalProxyUrl = process.env.GEMINI_PROXY_URL;

  afterEach(() => {
    if (originalProxyUrl === undefined) delete process.env.GEMINI_PROXY_URL;
    else process.env.GEMINI_PROXY_URL = originalProxyUrl;
  });

  it('accepts the internal proxy SOCKS endpoint', () => {
    process.env.GEMINI_PROXY_URL = 'socks5h://proxy:10808';
    expect(configuredGeminiProxyUrl()).to.equal(
      'socks5h://proxy:10808',
    );
  });

  it('rejects non-SOCKS transports without reflecting the URL', () => {
    process.env.GEMINI_PROXY_URL = 'https://secret@example.test/proxy';
    expect(configuredGeminiProxyUrl).to.throw(
      'GEMINI_PROXY_URL must be a SOCKS proxy URL',
    );
  });

  it('adds the Google key through the custom API client', async () => {
    let capturedRequest: Request | undefined;
    const client = createGeminiApiClient(
      'google-test-key',
      async request => {
        capturedRequest = request as Request;
        return new Response('{}', {status: 200});
      },
    );
    const response = await client.fetch(new Request(
      'https://generativelanguage.googleapis.com/v1beta/models/test',
    ));
    expect(response.status).to.equal(200);
    expect(client.hasApiKey()).to.equal(true);
    expect(capturedRequest?.headers.get('x-goog-api-key'))
      .to.equal('google-test-key');
  });
});
