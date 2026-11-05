import { describe, expect, it } from 'vitest';

import {
  accountRoster,
  eligibleAccounts,
  isLoggedIn,
} from './acting-accounts';

const bsky = {
  accountType: 'bluesky',
  instanceURL: 'https://bsky.social',
  blueskySession: { refreshJwt: 'r' },
  info: { id: 'did:plc:abc' },
};
const bsky2 = {
  accountType: 'bluesky',
  instanceURL: 'https://bsky.social',
  blueskySession: { refreshJwt: 's' },
  info: { id: 'did:plc:def' },
};
const bskyExpired = {
  accountType: 'bluesky',
  instanceURL: 'https://bsky.social',
  blueskySession: { refreshJwt: 't' },
  authExpired: true,
  info: { id: 'did:plc:dead' },
};
const masto = {
  accessToken: 'x',
  instanceURL: 'mastodon.social',
  info: { id: '1' },
};
const masto2 = {
  accessToken: 'y',
  instanceURL: 'hachyderm.io',
  info: { id: '2' },
};
const mastoLoggedOut = { instanceURL: 'mstdn.social', info: { id: '3' } };

describe('eligibleAccounts', () => {
  it('returns only Mastodon accounts for a Mastodon target', () => {
    expect(
      eligibleAccounts({
        targetIsBluesky: false,
        accounts: [bsky, masto, masto2],
      }),
    ).toEqual([masto, masto2]);
  });

  it('returns only Bluesky accounts for a Bluesky target', () => {
    expect(
      eligibleAccounts({
        targetIsBluesky: true,
        accounts: [bsky, masto, bsky2],
      }),
    ).toEqual([bsky, bsky2]);
  });

  it('excludes logged-out and auth-expired accounts', () => {
    expect(
      eligibleAccounts({
        targetIsBluesky: false,
        accounts: [masto, mastoLoggedOut],
      }),
    ).toEqual([masto]);
    expect(
      eligibleAccounts({
        targetIsBluesky: true,
        accounts: [bskyExpired, bsky2],
      }),
    ).toEqual([bsky2]);
  });

  it('returns empty when no account is on the target network', () => {
    expect(
      eligibleAccounts({ targetIsBluesky: true, accounts: [masto] }),
    ).toEqual([]);
    expect(eligibleAccounts({ targetIsBluesky: false, accounts: [] })).toEqual(
      [],
    );
  });
});

describe('accountRoster', () => {
  it('puts the current account first, keeps others in order', () => {
    expect(
      accountRoster({ accounts: [masto, bsky, masto2], currentID: '2' }),
    ).toEqual([masto2, masto, bsky]);
  });

  it('drops logged-out and auth-expired accounts', () => {
    expect(
      accountRoster({
        accounts: [mastoLoggedOut, masto, bskyExpired, bsky],
        currentID: '1',
      }),
    ).toEqual([masto, bsky]);
  });

  it('dedupes accounts sharing an info.id', () => {
    const dupe = { ...masto };
    expect(accountRoster({ accounts: [masto, dupe, bsky] })).toEqual([
      masto,
      bsky,
    ]);
  });

  it('works when currentID is missing or unknown', () => {
    expect(
      accountRoster({ accounts: [masto, bsky], currentID: 'nope' }),
    ).toEqual([masto, bsky]);
    expect(accountRoster({ accounts: [masto, bsky] })).toEqual([masto, bsky]);
  });
});

describe('isLoggedIn', () => {
  it('needs a refresh JWT for a Bluesky account', () => {
    const bsky = { accountType: 'bluesky', accessToken: 'a' };
    expect(isLoggedIn(bsky)).toBe(false);
    expect(isLoggedIn({ ...bsky, blueskySession: { refreshJwt: 'r' } })).toBe(
      true,
    );
    expect(
      isLoggedIn({
        ...bsky,
        blueskySession: { refreshJwt: 'r' },
        authExpired: true,
      }),
    ).toBe(false);
  });

  it('needs an access token for a Mastodon account', () => {
    expect(isLoggedIn({ accessToken: 't' })).toBe(true);
    expect(isLoggedIn({})).toBe(false);
  });
});
