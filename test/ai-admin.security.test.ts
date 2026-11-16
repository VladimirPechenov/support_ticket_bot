import {expect} from 'chai';
import cache from '../src/cache';
import * as db from '../src/db';
import {
  aiControlCommand,
  aiHealthCommand,
} from '../src/ai-admin';

interface SentMessage {
  chatId: string | number;
  text: string;
  options: Record<string, unknown>;
}

describe('AI admin authorization and runtime controls', () => {
  const originalBot = cache.bot;
  const originalOwnerId = cache.config.owner_id;
  const originalOwnerIds = cache.config.owner_ids;
  const originalParseMode = cache.config.parse_mode;
  const originalGoogleKey = process.env.GOOGLE_API_KEY;
  const originalMistralKey = process.env.MISTRAL_API_KEY;
  let originalFlags: db.RuntimeFeatureFlags;
  let originalSessions: typeof cache.aiSessions;
  let messages: SentMessage[];

  beforeEach(() => {
    originalFlags = db.getRuntimeFeatureFlags();
    originalSessions = cache.aiSessions;
    cache.aiSessions = {} as any;
    db.setRuntimeFeatureFlag('ai_mode', 'off');
    db.setRuntimeFeatureFlag('ai_rollout_percent', 0);
    db.setRuntimeFeatureFlag('web_tool_rollout_percent', 0);
    cache.config.owner_id = '4242';
    cache.config.owner_ids = ['4343'];
    cache.config.parse_mode = 'none';
    messages = [];
    cache.bot = {
      sendMessage: async (chatId: string | number, text: string, options: any) => {
        messages.push({chatId, text, options});
        return {message_id: messages.length};
      },
    } as any;
  });

  afterEach(() => {
    db.setRuntimeFeatureFlag('ai_mode', originalFlags.aiMode);
    db.setRuntimeFeatureFlag(
      'ai_rollout_percent',
      originalFlags.aiRolloutPercent,
    );
    db.setRuntimeFeatureFlag(
      'web_tool_rollout_percent',
      originalFlags.webToolRolloutPercent,
    );
    cache.bot = originalBot;
    cache.config.owner_id = originalOwnerId;
    cache.config.owner_ids = originalOwnerIds;
    cache.config.parse_mode = originalParseMode;
    cache.aiSessions = originalSessions;
    restoreEnvironment('GOOGLE_API_KEY', originalGoogleKey);
    restoreEnvironment('MISTRAL_API_KEY', originalMistralKey);
  });

  it('denies a non-owner even when the session claims admin rights', async () => {
    await aiControlCommand(context(100, 'mode full', true));
    await aiHealthCommand(context(100, '', true));

    expect(db.getRuntimeFeatureFlags()).to.deep.equal({
      aiMode: 'off',
      aiRolloutPercent: 0,
      webToolRolloutPercent: 0,
    });
    expect(messages.map(message => message.text)).to.deep.equal([
      'Недостаточно прав.',
      'Недостаточно прав.',
    ]);
  });

  it('allows the owner to update only the declared runtime flags', async () => {
    await aiControlCommand(context(4242, 'mode full'));
    await aiControlCommand(context(4242, 'ai 25'));
    await aiControlCommand(context(4242, 'web 5'));

    expect(db.getRuntimeFeatureFlags()).to.deep.equal({
      aiMode: 'full',
      aiRolloutPercent: 25,
      webToolRolloutPercent: 5,
    });
    expect(messages).to.have.length(3);
    expect(messages[2].text).to.include('mode: full');
    expect(messages[2].text).to.include('AI rollout: 25%');
    expect(messages[2].text).to.include('web rollout: 5%');
    expect(messages.every(message => message.options.parse_mode === undefined))
      .to.equal(true);
  });

  it('allows a second configured owner and denies other users', async () => {
    await aiControlCommand(context(4343, 'mode full'));
    expect(db.getRuntimeFeatureFlags().aiMode).to.equal('full');
    await aiControlCommand(context(4444, 'mode off', true));
    expect(db.getRuntimeFeatureFlags().aiMode).to.equal('full');
    expect(messages[1].text).to.equal('Недостаточно прав.');
  });

  it('rejects non-canary percentages and leaves state unchanged', async () => {
    await aiControlCommand(context(4242, 'ai 10'));
    await aiControlCommand(context(4242, 'web -1'));
    await aiControlCommand(context(4242, 'mode unsafe'));

    expect(db.getRuntimeFeatureFlags()).to.deep.equal({
      aiMode: 'off',
      aiRolloutPercent: 0,
      webToolRolloutPercent: 0,
    });
    expect(messages).to.have.length(3);
    expect(messages.every(message => message.text.includes('/aictl mode')))
      .to.equal(true);
  });

  it('reports key presence to the owner without exposing key values', async () => {
    process.env.GOOGLE_API_KEY = 'google-admin-secret';
    process.env.MISTRAL_API_KEY = 'mistral-admin-secret';
    await aiHealthCommand(context(4242));

    expect(messages).to.have.length(1);
    expect(messages[0].text).to.include('Google key: configured');
    expect(messages[0].text).to.include('Mistral key: configured');
    expect(messages[0].text).not.to.include('google-admin-secret');
    expect(messages[0].text).not.to.include('mistral-admin-secret');
  });

  it('cancels active runs when the owner switches to safe mode', async () => {
    db.setRuntimeFeatureFlag('ai_mode', 'full');
    const controller = new AbortController();
    cache.aiSessions['active-admin-run'] = {
      ticketId: 'active-admin-run',
      userId: 'user',
      disabled: false,
      history: [],
      runId: 'before-safe-mode',
      abortController: controller,
    };

    await aiControlCommand(context(4242, 'mode off'));

    expect(controller.signal.aborted).to.equal(true);
    expect(cache.aiSessions['active-admin-run'].abortController)
      .to.equal(controller);
    expect(cache.aiSessions['active-admin-run'].runId)
      .to.equal('before-safe-mode');
  });
});

function context(
  userId: number,
  match: string = '',
  admin: boolean = false,
): any {
  return {
    from: {id: userId},
    chat: {id: 9001, type: 'private'},
    message: {chat: {id: 9001}},
    session: {admin},
    match,
  };
}

function restoreEnvironment(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
