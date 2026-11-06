import { describe, expect, it } from 'vitest';

import { getMentionInstance } from './mention-network';

const bsky = {
  accountType: 'bluesky',
  instanceURL: 'https://bsky.social',
  blueskySession: { accessJwt: 'r' },
};
const masto = { accessToken: 'x', instanceURL: 'mastodon.social' };
const masto2 = { accessToken: 'y', instanceURL: 'hachyderm.io' };

describe('getMentionInstance', () => {
  it('mentions a Mastodon profile from the active Mastodon account', () => {
    expect(
      getMentionInstance({
        targetIsBluesky: false,
        active: { instance: 'mastodon.social', isBluesky: false },
        accounts: [masto, bsky],
      }),
    ).toBe('mastodon.social');
  });

  it('mentions a Bluesky profile from the active Bluesky account', () => {
    expect(
      getMentionInstance({
        targetIsBluesky: true,
        active: { instance: 'https://bsky.social', isBluesky: true },
        accounts: [masto, bsky],
      }),
    ).toBe('https://bsky.social');
  });

  it('routes to a Bluesky account when active is Mastodon (cross-network)', () => {
    expect(
      getMentionInstance({
        targetIsBluesky: true,
        active: { instance: 'mastodon.social', isBluesky: false },
        accounts: [masto, bsky],
      }),
    ).toBe('https://bsky.social');
  });

  it('routes to a Mastodon account when active is Bluesky (cross-network)', () => {
    expect(
      getMentionInstance({
        targetIsBluesky: false,
        active: { instance: 'https://bsky.social', isBluesky: true },
        accounts: [bsky, masto2],
      }),
    ).toBe('hachyderm.io');
  });

  it('returns null when there is no account on the target network', () => {
    // Only a Mastodon account, mentioning a Bluesky profile → dead mention.
    expect(
      getMentionInstance({
        targetIsBluesky: true,
        active: { instance: 'mastodon.social', isBluesky: false },
        accounts: [masto],
      }),
    ).toBeNull();
    // Only a Bluesky account, mentioning a Mastodon profile → dead mention.
    expect(
      getMentionInstance({
        targetIsBluesky: false,
        active: { instance: 'https://bsky.social', isBluesky: true },
        accounts: [bsky],
      }),
    ).toBeNull();
  });

  it('does not route to an auth-expired Bluesky account', () => {
    expect(
      getMentionInstance({
        targetIsBluesky: true,
        active: { instance: 'mastodon.social', isBluesky: false },
        accounts: [masto, { ...bsky, authExpired: true }],
      }),
    ).toBeNull();
  });

  it('prefers the active account for remote Mastodon mentions across instances', () => {
    // Active on mastodon.social, mentioning a profile on a remote instance:
    // the active account posts it (remote @user@domain mentions resolve).
    expect(
      getMentionInstance({
        targetIsBluesky: false,
        active: { instance: 'mastodon.social', isBluesky: false },
        accounts: [masto, masto2],
      }),
    ).toBe('mastodon.social');
  });
});
