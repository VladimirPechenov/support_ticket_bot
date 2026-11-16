import {expect} from 'chai';
import * as db from '../src/db';
import {rolloutBucket, runtimeModeForTicket} from '../src/ai';

describe('stable AI rollout cohorts', () => {
  it('uses an approximately uniform, deterministic 0..99 hash bucket', () => {
    const buckets = Array.from({length: 10_000}, (_, index) =>
      rolloutBucket(`ticket-${index}`));
    expect(buckets.every(bucket => bucket >= 0 && bucket < 100)).to.equal(true);
    expect(rolloutBucket('ticket-42')).to.equal(rolloutBucket('ticket-42'));
    const firstQuarter = buckets.filter(bucket => bucket < 25).length;
    const firstHalf = buckets.filter(bucket => bucket < 50).length;
    expect(firstQuarter).to.be.within(2350, 2650);
    expect(firstHalf).to.be.within(4850, 5150);
  });

  it('admits staff while keeping web zero as an absolute kill switch', () => {
    const originalNodeEnv = process.env.NODE_ENV;
    const originalFlags = db.getRuntimeFeatureFlags();
    try {
      process.env.NODE_ENV = 'production';
      db.setRuntimeFeatureFlag('ai_mode', 'full');
      db.setRuntimeFeatureFlag('ai_rollout_percent', 0);
      db.setRuntimeFeatureFlag('web_tool_rollout_percent', 0);
      const config: any = {
        staff_allowlist: ['42'],
        tools: {verified_docs: {enabled: true}},
      };
      expect(runtimeModeForTicket('ticket-a', config, 42)).to.deep.equal({
        mode: 'full',
        allowWebTool: false,
      });
      expect(runtimeModeForTicket('ticket-b', config, 43)).to.deep.equal({
        mode: 'off',
        allowWebTool: false,
      });
      db.setRuntimeFeatureFlag('web_tool_rollout_percent', 5);
      expect(runtimeModeForTicket('ticket-a', config, 42)).to.deep.equal({
        mode: 'full',
        allowWebTool: true,
      });
      expect(runtimeModeForTicket('ticket-b', config, 43)).to.deep.equal({
        mode: 'off',
        allowWebTool: false,
      });
    } finally {
      if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = originalNodeEnv;
      db.setRuntimeFeatureFlag('ai_mode', originalFlags.aiMode);
      db.setRuntimeFeatureFlag(
        'ai_rollout_percent',
        originalFlags.aiRolloutPercent,
      );
      db.setRuntimeFeatureFlag(
        'web_tool_rollout_percent',
        originalFlags.webToolRolloutPercent,
      );
    }
  });
});
