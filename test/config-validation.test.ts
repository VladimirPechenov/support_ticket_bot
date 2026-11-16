import {expect} from 'chai';
import {validateConfig} from '../src/index';

const providerSmoke = require('../scripts/provider-smoke');

function validConfig(): any {
  return {
    bot_token: '123456:TEST_TOKEN',
    staffchat_id: '-1001',
    ai: {
      enabled: true,
      llm: {
        providers: {
          primary: {
            provider: 'mistral',
            model: 'mistral-small-2603',
            daily_request_limit: 1000,
            quota_stop_percent: 0.8,
          },
          fallback: {
            provider: 'gemini',
            model: 'gemini-3.1-flash-lite',
            daily_token_limit: 1_000_000,
            quota_stop_percent: 0.8,
          },
        },
      },
      embeddings: {
        provider: 'mistral',
        model: 'mistral-embed',
        dimensions: 1024,
      },
      rag: {
        qdrant: {
          url: 'http://qdrant:6333',
          collection: 'support_kb_active',
        },
      },
    },
  };
}

describe('direct-provider configuration validation', () => {
  it('accepts full knowledge mode without embeddings or a vector database', () => {
    const config = validConfig();
    config.ai.mode = 'full';
    config.ai.llm.providers.primary = config.ai.llm.providers.fallback;
    delete config.ai.llm.providers.fallback;
    delete config.ai.embeddings;
    delete config.ai.rag;
    config.ai.llm.max_input_tokens = 32768;
    expect(() => validateConfig(config)).not.to.throw();
    config.ai.llm.providers.primary.model = 'gemini-3.8-flash';
    expect(() => validateConfig(config)).not.to.throw();
    expect(providerSmoke.validateProviderProfiles(config.ai.llm.providers, 'full'))
      .to.have.length(1);
    config.ai.llm.providers.fallback = {
      ...config.ai.llm.providers.primary, model: 'gemini-3.5-flash-lite',
    };
    expect(() => validateConfig(config)).not.to.throw();
    expect(providerSmoke.validateProviderProfiles(config.ai.llm.providers, 'full'))
      .to.have.length(2);
    config.ai.llm.providers.primary.model = 'gemini-latest';
    expect(() => validateConfig(config)).to.throw();
  });
  it('accepts bounded Gemini retries with lexical retrieval', () => {
    const config = validConfig();
    config.ai.llm.providers.primary = config.ai.llm.providers.fallback;
    delete config.ai.llm.providers.fallback;
    config.ai.llm.max_attempts = 1;
    config.ai.embeddings.enabled = false;
    expect(() => validateConfig(config)).not.to.throw();
    config.ai.llm.max_attempts = 2;
    expect(() => validateConfig(config)).not.to.throw();
    config.ai.llm.max_attempts = 3;
    expect(() => validateConfig(config)).not.to.throw();
    config.ai.llm.max_attempts = 4;
    expect(() => validateConfig(config)).to.throw('ai.llm.max_attempts');
    config.ai.llm.max_attempts = 1;
    config.ai.embeddings.enabled = true;
    expect(() => validateConfig(config)).to.throw();
  });

  it('accepts pinned direct providers without secrets in YAML', () => {
    expect(() => validateConfig(validConfig())).not.to.throw();

    const lexicalOnly = validConfig();
    lexicalOnly.ai.embeddings.enabled = false;
    expect(() => validateConfig(lexicalOnly)).not.to.throw();
  });

  it('rejects nested transport/key fields', () => {
    const config = validConfig();
    config.ai.llm.providers.primary.api_key = 'forbidden';
    expect(() => validateConfig(config)).to.throw(
      'legacy proxy/API-key fields are not supported',
    );

    const camelCase = validConfig();
    camelCase.ai.embeddings.apiKey = 'forbidden';
    expect(() => validateConfig(camelCase)).to.throw(
      'legacy proxy/API-key fields are not supported',
    );

    const invalidToggle = validConfig();
    invalidToggle.ai.embeddings.enabled = 'false';
    expect(() => validateConfig(invalidToggle)).to.throw(
      'ai.embeddings.enabled must be boolean',
    );
  });

  it('rejects unpinned latest aliases and Qdrant key fields', () => {
    const latest = validConfig();
    latest.ai.llm.providers.primary.model = 'gemini-latest';
    expect(() => validateConfig(latest)).to.throw('must not use latest');

    const qdrantSecret = validConfig();
    qdrantSecret.ai.rag.qdrant.api_key = '';
    expect(() => validateConfig(qdrantSecret)).to.throw(
      'Qdrant API key must be supplied through QDRANT_API_KEY',
    );
  });

  it('rejects any provider or embedding model outside the release pins', () => {
    const primary = validConfig();
    primary.ai.llm.providers.primary.model = 'mistral-small-latest';
    expect(() => validateConfig(primary)).to.throw(
      'mistral/mistral-small-2603',
    );

    const fallback = validConfig();
    fallback.ai.llm.providers.fallback.model = 'gemini-latest';
    expect(() => validateConfig(fallback)).to.throw(
      'gemini/gemini-3.1-flash-lite',
    );

    const embeddings = validConfig();
    embeddings.ai.embeddings.model = 'text-embedding-004';
    expect(() => validateConfig(embeddings)).to.throw(
      'mistral/mistral-embed',
    );

    const disabled = validConfig();
    disabled.ai.enabled = false;
    disabled.ai.llm.providers.primary.model = 'another-model';
    expect(() => validateConfig(disabled)).to.throw(
      'mistral/mistral-small-2603',
    );
  });

  it('requires a free-quota cap and an explicit stop threshold per provider', () => {
    const noLimit = validConfig();
    delete noLimit.ai.llm.providers.primary.daily_request_limit;
    expect(() => validateConfig(noLimit)).to.throw(
      'primary requires daily_request_limit or daily_token_limit',
    );

    const noStop = validConfig();
    delete noStop.ai.llm.providers.fallback.quota_stop_percent;
    expect(() => validateConfig(noStop)).to.throw(
      'fallback.quota_stop_percent is required',
    );

    const tokenOnly = validConfig();
    delete tokenOnly.ai.llm.providers.primary.daily_request_limit;
    tokenOnly.ai.llm.providers.primary.daily_token_limit = 500_000;
    expect(() => validateConfig(tokenOnly)).not.to.throw();
  });

  it('binds provider live-smoke to the same release model pins', () => {
    const profiles = validConfig().ai.llm.providers;
    expect(providerSmoke.validateProviderProfiles(profiles).map(
      (profile: {model: string}) => profile.model,
    )).to.deep.equal([
      'mistral-small-2603',
      'gemini-3.1-flash-lite',
    ]);
    expect(() => providerSmoke.validateProviderProfiles({
      ...profiles,
      fallback: {...profiles.fallback, model: 'mistral-small-latest'},
    })).to.throw('Pinned Mistral/Gemini provider profiles are required');
  });

  it('rejects destructive retention values and invalid runtime limits', () => {
    const retention = validConfig();
    retention.support = {metadata_retention_days: 0};
    expect(() => validateConfig(retention)).to.throw(
      'support.metadata_retention_days',
    );

    const rawMetadataTooLong = validConfig();
    rawMetadataTooLong.support = {metadata_retention_days: 91};
    expect(() => validateConfig(rawMetadataTooLong)).to.throw(
      'support.metadata_retention_days',
    );

    const deadline = validConfig();
    deadline.ai.llm.deadline_ms = 30_001;
    expect(() => validateConfig(deadline)).to.throw('ai.llm.deadline_ms');

    const quota = validConfig();
    quota.ai.llm.providers.primary.quota_stop_percent = 0.95;
    expect(() => validateConfig(quota)).to.throw('quota_stop_percent');

    const contextDocuments = validConfig();
    contextDocuments.ai.rag.qdrant.max_context_docs = 20;
    expect(() => validateConfig(contextDocuments)).to.throw(
      'ai.rag.qdrant.max_context_docs',
    );

    const directAnswer = validConfig();
    directAnswer.ai.rag.qdrant.direct_answer_on_llm_error = 'false';
    expect(() => validateConfig(directAnswer)).to.throw(
      'direct_answer_on_llm_error must be boolean',
    );
  });

  it('validates the staff allowlist without accepting arbitrary values', () => {
    const accepted = validConfig();
    accepted.ai.staff_allowlist = [123, '456'];
    expect(() => validateConfig(accepted)).not.to.throw();

    const rejected = validConfig();
    rejected.ai.staff_allowlist = ['@admin'];
    expect(() => validateConfig(rejected)).to.throw('staff_allowlist');
  });
});
