import { describe, expect, it } from 'vitest';

import { fixedAccountStates, parseFixedAccounts } from './fixed-accounts.js';

describe('parseFixedAccounts', () => {
  it('returns no accounts when unset', () => {
    expect(parseFixedAccounts(undefined)).toEqual([]);
    expect(parseFixedAccounts('')).toEqual([]);
  });

  it('parses one Mastodon and one Bluesky account, in order', () => {
    expect(
      parseFixedAccounts('mastodon:luis_in_brief@social.coop,bluesky:lu.is'),
    ).toEqual([
      {
        network: 'mastodon',
        username: 'luis_in_brief',
        instance: 'social.coop',
        label: '@luis_in_brief@social.coop',
      },
      { network: 'bluesky', handle: 'lu.is', label: '@lu.is' },
    ]);
  });

  it('accepts a leading @, spaces and mixed-case networks and hosts', () => {
    expect(
      parseFixedAccounts(' Mastodon:@Luis@Social.Coop , BLUESKY:@Lu.Is '),
    ).toEqual([
      {
        network: 'mastodon',
        username: 'Luis',
        instance: 'social.coop',
        label: '@Luis@social.coop',
      },
      { network: 'bluesky', handle: 'lu.is', label: '@lu.is' },
    ]);
  });

  it('drops malformed entries and keeps the rest', () => {
    expect(
      parseFixedAccounts(
        'mastodon:social.coop,mastodon:luis@,nostr:npub1,bluesky:,lu.is,bluesky:lu.is',
      ),
    ).toEqual([{ network: 'bluesky', handle: 'lu.is', label: '@lu.is' }]);
  });
});

describe('fixedAccountStates', () => {
  const fixed = parseFixedAccounts(
    'mastodon:luis_in_brief@social.coop,bluesky:lu.is',
  );
  const mastodon = {
    info: { username: 'Luis_in_Brief', acct: 'luis_in_brief' },
    instanceURL: 'social.coop',
    accessToken: 'token',
  };
  const bluesky = {
    accountType: 'bluesky',
    info: { acct: 'lu.is' },
    instanceURL: 'bsky.social',
    blueskySession: { handle: 'lu.is', accessJwt: 'jwt' },
  };
  const states = (accounts) =>
    fixedAccountStates(fixed, accounts).map((a) => a.state);

  it('reports both accounts missing on a fresh device', () => {
    expect(states([])).toEqual(['missing', 'missing']);
  });

  it('reports both accounts ok when both sessions are stored', () => {
    expect(states([mastodon, bluesky])).toEqual(['ok', 'ok']);
  });

  it('reports a revoked Mastodon token', () => {
    expect(states([{ ...mastodon, authExpired: true }, bluesky])).toEqual([
      'expired',
      'ok',
    ]);
  });

  it('reports an expired Bluesky session', () => {
    expect(states([mastodon, { ...bluesky, authExpired: true }])).toEqual([
      'ok',
      'expired',
    ]);
  });

  it('does not match an account on another server or network', () => {
    expect(
      states([
        { ...mastodon, instanceURL: 'mastodon.social' },
        { ...bluesky, accountType: undefined },
      ]),
    ).toEqual(['missing', 'missing']);
  });

  it('treats a stored account with no session as missing', () => {
    expect(
      states([
        { ...mastodon, accessToken: undefined },
        { ...bluesky, blueskySession: undefined },
      ]),
    ).toEqual(['missing', 'missing']);
  });
});
