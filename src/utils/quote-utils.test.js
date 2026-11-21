import { beforeEach, describe, expect, it, vi } from 'vitest';

// The catalog messages now live here, defined with the lingui `msg` macro.
// Vitest runs without the macro transform, so the macro import is stubbed:
// these tests are about the capability checks, not the strings.
vi.mock('@lingui/core/macro', () => ({
  msg: (strings, ...values) =>
    strings.raw.reduce((acc, s, i) => acc + s + (values[i] ?? ''), ''),
}));

// Both dependencies reach into the account store / localStorage, so they are
// stubbed: these tests are about which instance the capability check reads.
vi.mock('./bluesky', () => ({
  isBlueskyInstance: (instance) => blueskyInstances.has(instance),
}));
vi.mock('./store-utils', () => ({
  getCurrentInstance: () => currentInstance,
  getAPIVersions: (instance) =>
    (instance
      ? apiVersionsByInstance[instance]
      : currentInstance?.apiVersions) || {},
}));

let blueskyInstances;
let currentInstance;
let apiVersionsByInstance;

const { getQuotePolicy, supportsNativeQuote } = await import('./quote-utils');

describe('supportsNativeQuote', () => {
  beforeEach(() => {
    blueskyInstances = new Set(['bsky.social']);
    apiVersionsByInstance = {
      'mastodon.social': { mastodon: 7 },
      'old.example': { mastodon: 5 },
    };
    currentInstance = null;
  });

  it('is true for a Bluesky post whatever account is current', () => {
    currentInstance = { apiVersions: { mastodon: 5 } };
    expect(supportsNativeQuote('bsky.social')).toBe(true);
  });

  it('reads the named Mastodon instance, not the current account', () => {
    // Current account is Bluesky: it has no Mastodon apiVersions at all.
    currentInstance = { _bluesky: true };
    expect(supportsNativeQuote('mastodon.social')).toBe(true);
    expect(supportsNativeQuote('old.example')).toBe(false);
  });

  it('falls back to the current instance when none is named', () => {
    currentInstance = { apiVersions: { mastodon: 7 } };
    expect(supportsNativeQuote()).toBe(true);
    currentInstance = { apiVersions: { mastodon: 5 } };
    expect(supportsNativeQuote()).toBe(false);
    currentInstance = { _bluesky: true };
    expect(supportsNativeQuote()).toBe(true);
  });
});

describe('getQuotePolicy', () => {
  it('allows a public post that accepts quotes automatically', () => {
    expect(
      getQuotePolicy({
        visibility: 'public',
        isSelf: false,
        quoteApproval: { currentUser: 'automatic' },
      }),
    ).toEqual({ disabled: false, reason: null });
  });

  it('allows a request when the author reviews quotes', () => {
    expect(
      getQuotePolicy({
        visibility: 'unlisted',
        isSelf: false,
        quoteApproval: { currentUser: 'manual' },
      }),
    ).toEqual({ disabled: false, reason: 'requestQuote' });
  });

  it('refuses someone else’s private post', () => {
    expect(
      getQuotePolicy({
        visibility: 'private',
        isSelf: false,
        quoteApproval: { currentUser: 'automatic' },
      }),
    ).toEqual({ disabled: true, reason: 'quotePrivate' });
  });

  it('allows the user’s own private post', () => {
    expect(
      getQuotePolicy({
        visibility: 'private',
        isSelf: true,
        quoteApproval: { currentUser: 'automatic' },
      }),
    ).toEqual({ disabled: false, reason: null });
  });

  it('names a followers-only policy', () => {
    expect(
      getQuotePolicy({
        visibility: 'public',
        isSelf: false,
        quoteApproval: { automatic: ['followers'], currentUser: 'denied' },
      }),
    ).toEqual({ disabled: true, reason: 'quoteFollowersOnly' });
    expect(getQuotePolicy({ visibility: 'public', isSelf: false })).toEqual({
      disabled: true,
      reason: 'quoteCannot',
    });
  });
});
