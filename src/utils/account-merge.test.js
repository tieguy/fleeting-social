import { describe, expect, it } from 'vitest';

import {
  hasLoggedInAccount,
  mergeServiceAccounts,
  pendingImports,
} from './account-merge';

const blueskyView = {
  network: 'bluesky',
  id: 'did:plc:alice',
  handle: 'alice.test',
  service: 'https://bsky.social',
  pdsUrl: 'https://pds.example',
  accessJwt: 'access-2',
  active: true,
  profile: { did: 'did:plc:alice', handle: 'alice.test', displayName: 'Alice' },
  authExpired: false,
};
const mastodonView = {
  network: 'mastodon',
  id: '42',
  instanceURL: 'social.example',
  accessToken: 'masto',
  clientId: 'cid',
  clientSecret: 'secret',
  vapidKey: 'vapid',
  info: { id: '42', acct: 'bob', username: 'bob' },
  authExpired: false,
};

describe('mergeServiceAccounts', () => {
  it('gives a new device every account the service holds', () => {
    const accounts = [];
    expect(
      mergeServiceAccounts(accounts, [blueskyView, mastodonView], { now: 5 }),
    ).toBe(true);
    expect(accounts).toHaveLength(2);
    const [bsky, masto] = accounts;
    expect(bsky).toMatchObject({
      accountType: 'bluesky',
      instanceURL: 'bsky.social',
      accessToken: 'access-2',
      blueskyService: 'https://bsky.social',
      blueskySession: {
        did: 'did:plc:alice',
        accessJwt: 'access-2',
        pdsUrl: 'https://pds.example',
      },
      info: { id: 'did:plc:alice', displayName: 'Alice', _bluesky: true },
      serviceSynced: true,
      createdAt: 5,
    });
    expect(masto).toMatchObject({
      instanceURL: 'social.example',
      accessToken: 'masto',
      clientId: 'cid',
      info: { acct: 'bob' },
      serviceSynced: true,
    });
    expect(hasLoggedInAccount(accounts)).toBe(true);
  });

  it('drops the refresh token a device kept from before', () => {
    const accounts = [
      {
        accountType: 'bluesky',
        info: { id: 'did:plc:alice' },
        instanceURL: 'bsky.social',
        blueskySession: { refreshJwt: 'old', accessJwt: 'old-access' },
        lastAccessedAt: 9,
      },
    ];
    mergeServiceAccounts(accounts, [blueskyView]);
    expect(accounts).toHaveLength(1);
    expect(accounts[0].blueskySession.refreshJwt).toBeUndefined();
    expect(accounts[0].blueskySession.accessJwt).toBe('access-2');
    expect(accounts[0].lastAccessedAt).toBe(9);
  });

  it('copies authExpired from the service, and clears it', () => {
    const accounts = [];
    mergeServiceAccounts(accounts, [{ ...blueskyView, authExpired: true }]);
    expect(accounts[0].authExpired).toBe(true);
    expect(hasLoggedInAccount(accounts)).toBe(false);
    mergeServiceAccounts(accounts, [blueskyView]);
    expect(accounts[0].authExpired).toBeUndefined();
  });

  it('logs out an account that another device logged out', () => {
    const accounts = [];
    mergeServiceAccounts(accounts, [blueskyView, mastodonView]);
    expect(mergeServiceAccounts(accounts, [mastodonView])).toBe(true);
    expect(accounts).toHaveLength(2);
    expect(accounts[0].blueskySession).toBeUndefined();
    expect(accounts[0].accessToken).toBeUndefined();
    expect(accounts[0].serviceSynced).toBeUndefined();
    // and does not upload it again
    expect(pendingImports(accounts)).toEqual([]);
  });

  it('leaves a local login that the service has not seen', () => {
    const local = {
      info: { id: '7' },
      instanceURL: 'other.example',
      accessToken: 'fresh',
    };
    const accounts = [local];
    expect(mergeServiceAccounts(accounts, [])).toBe(false);
    expect(local.accessToken).toBe('fresh');
  });

  it('matches a Mastodon account by ID and server', () => {
    const accounts = [
      {
        info: { id: '42' },
        instanceURL: 'elsewhere.example',
        accessToken: 'x',
      },
    ];
    mergeServiceAccounts(accounts, [mastodonView]);
    expect(accounts).toHaveLength(2);
    expect(accounts[0].accessToken).toBe('x');
  });

  it('reports no change when the service answers the same', () => {
    const accounts = [];
    mergeServiceAccounts(accounts, [blueskyView, mastodonView]);
    expect(mergeServiceAccounts(accounts, [blueskyView, mastodonView])).toBe(
      false,
    );
  });
});

describe('pendingImports', () => {
  it('lists logins the service has not seen', () => {
    const legacyBluesky = {
      accountType: 'bluesky',
      info: { id: 'did:plc:a' },
      blueskySession: { refreshJwt: 'r', accessJwt: 'a' },
    };
    const oauthBluesky = {
      accountType: 'bluesky',
      info: { id: 'did:plc:b' },
      accessToken: 'oauth',
    };
    const mastodon = { info: { id: '1' }, accessToken: 't' };
    const synced = { info: { id: '2' }, accessToken: 't', serviceSynced: true };
    const loggedOut = { info: { id: '3' } };
    expect(
      pendingImports([
        legacyBluesky,
        oauthBluesky,
        mastodon,
        synced,
        loggedOut,
      ]),
    ).toEqual([legacyBluesky, mastodon]);
  });
});
