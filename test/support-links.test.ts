import {expect} from 'chai';
import {normalizeSupportLinks} from '../src/support-links';

describe('support links without installation-specific redirects', () => {
  it('preserves an ordinary documented link', () => {
    const text = 'Read https://example.com/docs/account before continuing.';
    expect(normalizeSupportLinks(text)).to.equal(text);
  });
  it('normalizes absent text without inventing a destination', () => {
    expect(normalizeSupportLinks(undefined as any)).to.equal('');
  });
});
