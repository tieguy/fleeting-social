import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  ACCOUNTS,
  ATTEMPT_INTERVAL,
  createAccounts,
  emptyAccounts,
  isTerminalRefusal,
  pdsFromDidDoc,
  publicView,
  refreshDecision,
} from './accounts.js';
import { createStore } from './store.js';

const DID = 'did:plc:alice';
const SERVICE = 'https://bsky.social';
const PDS = 'https://pds.example';
const didDoc = {
  service: [
    {
      id: '#atproto_pds',
      type: 'AtprotoPersonalDataServer',
      serviceEndpoint: PDS,
    },
  ],
};

function reply(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

// A fake Bluesky entryway and Mastodon instance. Each refresh token works
// once, as on the real PDS. `refreshResult` overrides the answer to the next
// refresh calls.
function fakeNetwork() {
  const calls = [];
  let n = 0;
  const live = new Set(['refresh-0']);
  const net = {
    calls,
    live,
    refreshResult: null,
    // resolves the refresh calls held by `hold`
    held: [],
    hold: false,
    mastodonStatus: 200,
    async fetch(url, init = {}) {
      const u = new URL(url);
      const auth = init.headers?.Authorization?.replace(/^Bearer /, '');
      calls.push({ path: u.pathname, host: u.host, auth });
      if (u.pathname === '/xrpc/com.atproto.server.createSession') {
        const { password } = JSON.parse(init.body);
        if (password !== 'app-pass') {
          return reply(401, {
            error: 'AuthenticationRequired',
            message: 'Invalid identifier or password',
          });
        }
        const refreshJwt = `refresh-${++n}`;
        live.add(refreshJwt);
        return reply(200, {
          did: DID,
          handle: 'alice.test',
          accessJwt: `access-${n}`,
          refreshJwt,
          didDoc,
        });
      }
      if (u.pathname === '/xrpc/com.atproto.server.refreshSession') {
        if (net.hold) await new Promise((r) => net.held.push(r));
        if (net.refreshResult) return net.refreshResult();
        if (!live.has(auth)) {
          return reply(400, {
            error: 'ExpiredToken',
            message: 'Token has been revoked',
          });
        }
        live.delete(auth);
        const refreshJwt = `refresh-${++n}`;
        live.add(refreshJwt);
        return reply(200, {
          did: DID,
          handle: 'alice.test',
          accessJwt: `access-${n}`,
          refreshJwt,
          didDoc,
        });
      }
      if (u.pathname === '/xrpc/com.atproto.server.deleteSession') {
        live.delete(auth);
        return reply(200, {});
      }
      if (u.pathname === '/xrpc/app.bsky.actor.getProfile') {
        return reply(200, {
          did: DID,
          handle: 'alice.test',
          displayName: 'Alice',
        });
      }
      if (u.pathname === '/api/v1/accounts/verify_credentials') {
        if (auth !== 'masto-token' || net.mastodonStatus !== 200) {
          return reply(net.mastodonStatus === 200 ? 401 : net.mastodonStatus, {
            error: 'The access token is invalid',
          });
        }
        return reply(200, { id: '42', acct: 'bob', username: 'bob' });
      }
      if (u.pathname === '/oauth/revoke') return reply(200, {});
      throw new Error(`unexpected ${url}`);
    },
  };
  return net;
}

async function setup() {
  const dir = await mkdtemp(join(tmpdir(), 'fleeting-accounts-'));
  const store = await createStore(join(dir, 'data'));
  const net = fakeNetwork();
  const clock = { t: 10_000_000 };
  const logs = [];
  const accounts = createAccounts({
    store,
    fetch: (url, init) => net.fetch(url, init),
    log: (l) => logs.push(l),
    now: () => clock.t,
  });
  const refreshCalls = () =>
    net.calls.filter((c) => c.path.endsWith('refreshSession')).length;
  const stored = async () =>
    (await store.read(ACCOUNTS, emptyAccounts())).accounts;
  return { store, net, clock, logs, accounts, refreshCalls, stored };
}

async function loggedIn() {
  const t = await setup();
  const view = await t.accounts.loginBluesky({
    service: 'bsky.social',
    identifier: '@alice.test',
    password: 'app-pass',
  });
  // The session's first access token is stale long after login
  t.clock.t += 2 * 60 * 60 * 1000;
  return { ...t, view };
}

describe('refreshDecision', () => {
  const entry = { accessJwt: 'a1' };
  it('answers with the stored token when another device refreshed', () => {
    expect(refreshDecision(entry, 'a0', { now: 0 })).toBe('stored');
  });
  it('refreshes when the stored token is the one refused', () => {
    expect(refreshDecision(entry, 'a1', { now: 1e9, lastAttempt: 0 })).toBe(
      'refresh',
    );
  });
  it('refreshes at most once a minute', () => {
    expect(
      refreshDecision(entry, 'a1', {
        now: 1e9,
        lastAttempt: 1e9 - ATTEMPT_INTERVAL + 1,
      }),
    ).toBe('stored');
  });
  it('does nothing for a dead session', () => {
    expect(
      refreshDecision({ ...entry, authExpired: true }, 'a1', { now: 1e9 }),
    ).toBe('expired');
  });
});

describe('isTerminalRefusal', () => {
  it('counts a 4xx other than 429', () => {
    expect([400, 401, 403, 429, 500, 502].map(isTerminalRefusal)).toEqual([
      true,
      true,
      true,
      false,
      false,
      false,
    ]);
  });
});

describe('pdsFromDidDoc', () => {
  it('reads the atproto PDS endpoint', () => {
    expect(pdsFromDidDoc(didDoc)).toBe(PDS);
  });
  it('ignores a missing or non-https endpoint', () => {
    expect(pdsFromDidDoc(undefined)).toBe(null);
    expect(
      pdsFromDidDoc({
        service: [
          {
            id: '#atproto_pds',
            type: 'AtprotoPersonalDataServer',
            serviceEndpoint: 'http://pds.example',
          },
        ],
      }),
    ).toBe(null);
  });
});

describe('publicView', () => {
  it('never includes the refresh token', () => {
    const view = publicView({
      network: 'bluesky',
      id: DID,
      accessJwt: 'a',
      refreshJwt: 'r',
    });
    expect(view.accessJwt).toBe('a');
    expect(JSON.stringify(view)).not.toContain('"r"');
    expect(view).not.toHaveProperty('refreshJwt');
  });
});

describe('Bluesky login', () => {
  it('stores the session, the PDS and the profile, not the password', async () => {
    const { view, stored } = await loggedIn();
    expect(view).toMatchObject({
      id: DID,
      handle: 'alice.test',
      service: SERVICE,
      pdsUrl: PDS,
      accessJwt: 'access-1',
      profile: { displayName: 'Alice' },
      authExpired: false,
    });
    const [entry] = await stored();
    expect(entry.refreshJwt).toBe('refresh-1');
    expect(JSON.stringify(entry)).not.toContain('app-pass');
  });

  it('passes on a wrong password as 401', async () => {
    const { accounts } = await setup();
    await expect(
      accounts.loginBluesky({ identifier: 'alice.test', password: 'nope' }),
    ).rejects.toMatchObject({ status: 401 });
  });

  it('a new login clears a dead session', async () => {
    const t = await loggedIn();
    t.net.live.clear();
    await t.accounts.blueskyAccess({ did: DID, failed: 'access-1' });
    expect((await t.stored())[0].authExpired).toBe(true);
    const view = await t.accounts.loginBluesky({
      identifier: 'alice.test',
      password: 'app-pass',
    });
    expect(view.authExpired).toBe(false);
    expect(await t.stored()).toHaveLength(1);
  });
});

describe('Bluesky access', () => {
  it('two devices with the same expired token cause one refresh', async () => {
    const t = await loggedIn();
    const [a, b] = await Promise.all([
      t.accounts.blueskyAccess({ did: DID, failed: 'access-1' }),
      t.accounts.blueskyAccess({ did: DID, failed: 'access-1' }),
    ]);
    expect(t.refreshCalls()).toBe(1);
    expect(a.accessJwt).toBe('access-2');
    expect(b.accessJwt).toBe('access-2');
    // A third device that reports the old token later gets the new one
    t.clock.t += 5 * ATTEMPT_INTERVAL;
    const c = await t.accounts.blueskyAccess({ did: DID, failed: 'access-1' });
    expect(c.accessJwt).toBe('access-2');
    expect(t.refreshCalls()).toBe(1);
    expect((await t.stored())[0].refreshJwt).toBe('refresh-2');
  });

  it('refreshes the current token at most once a minute', async () => {
    const t = await loggedIn();
    await t.accounts.blueskyAccess({ did: DID, failed: 'access-1' });
    await t.accounts.blueskyAccess({ did: DID, failed: 'access-2' });
    expect(t.refreshCalls()).toBe(1);
    t.clock.t += ATTEMPT_INTERVAL;
    const view = await t.accounts.blueskyAccess({
      did: DID,
      failed: 'access-2',
    });
    expect(t.refreshCalls()).toBe(2);
    expect(view.accessJwt).toBe('access-3');
  });

  it('ends the session when the PDS refuses the refresh token', async () => {
    const t = await loggedIn();
    t.net.live.clear();
    const view = await t.accounts.blueskyAccess({
      did: DID,
      failed: 'access-1',
    });
    expect(view.authExpired).toBe(true);
    expect((await t.stored())[0].authExpired).toBe(true);
    // A dead session does not refresh again
    t.clock.t += 5 * ATTEMPT_INTERVAL;
    await t.accounts.blueskyAccess({ did: DID, failed: 'access-1' });
    expect(t.refreshCalls()).toBe(1);
  });

  for (const [name, result] of [
    ['a 429', () => reply(429, { error: 'RateLimitExceeded' })],
    ['a 5xx', () => reply(502, { error: 'UpstreamFailure' })],
    [
      'a network error',
      () => {
        throw new TypeError('fetch failed');
      },
    ],
  ]) {
    it(`changes nothing on ${name}`, async () => {
      const t = await loggedIn();
      t.net.refreshResult = result;
      const view = await t.accounts.blueskyAccess({
        did: DID,
        failed: 'access-1',
      });
      expect(view.authExpired).toBe(false);
      expect(view.accessJwt).toBe('access-1');
      const [entry] = await t.stored();
      expect(entry.refreshJwt).toBe('refresh-1');
      expect(entry.authExpired).toBeUndefined();
    });
  }

  it('a refusal does not end a session that a login replaced meanwhile', async () => {
    const t = await loggedIn();
    t.net.hold = true;
    t.net.live.clear();
    const access = t.accounts.blueskyAccess({ did: DID, failed: 'access-1' });
    await new Promise((r) => setTimeout(r, 10));
    t.net.hold = false;
    await t.accounts.loginBluesky({
      identifier: 'alice.test',
      password: 'app-pass',
    });
    t.net.held.forEach((r) => r());
    const view = await access;
    expect(view.authExpired).toBe(false);
    const [entry] = await t.stored();
    expect(entry.authExpired).toBeUndefined();
    expect(entry.accessJwt).toBe('access-2');
  });

  it('answers 404 for an account it does not hold', async () => {
    const { accounts } = await setup();
    await expect(
      accounts.blueskyAccess({ did: DID, failed: 'x' }),
    ).rejects.toMatchObject({ status: 404 });
  });
});

describe('Bluesky import', () => {
  it('takes over a device refresh token when it holds no session', async () => {
    const t = await setup();
    const view = await t.accounts.importBluesky({
      did: DID,
      service: SERVICE,
      refreshJwt: 'refresh-0',
    });
    expect(view.accessJwt).toBe('access-1');
    expect((await t.stored())[0].refreshJwt).toBe('refresh-1');
  });

  it('keeps its own live session', async () => {
    const t = await loggedIn();
    const view = await t.accounts.importBluesky({
      did: DID,
      service: SERVICE,
      refreshJwt: 'refresh-0',
    });
    expect(view.accessJwt).toBe('access-1');
    expect(t.refreshCalls()).toBe(0);
  });

  it('refuses a dead device token with 401', async () => {
    const t = await setup();
    await expect(
      t.accounts.importBluesky({
        did: DID,
        service: SERVICE,
        refreshJwt: 'refresh-dead',
      }),
    ).rejects.toMatchObject({ status: 401 });
    expect(await t.stored()).toEqual([]);
  });
});

describe('Mastodon', () => {
  const body = {
    instanceURL: 'Social.Example',
    accessToken: 'masto-token',
    clientId: 'cid',
    clientSecret: 'csecret',
  };

  it('stores a token that verify_credentials accepts', async () => {
    const t = await setup();
    const view = await t.accounts.saveMastodon(body);
    expect(view).toMatchObject({
      network: 'mastodon',
      id: '42',
      instanceURL: 'social.example',
      accessToken: 'masto-token',
      info: { acct: 'bob' },
      authExpired: false,
    });
    expect(await t.accounts.list()).toHaveLength(1);
  });

  it('refuses a token the instance refuses', async () => {
    const t = await setup();
    await expect(
      t.accounts.saveMastodon({ ...body, accessToken: 'bad' }),
    ).rejects.toMatchObject({ status: 401 });
  });

  it('marks the account only when the instance answers 401', async () => {
    const t = await setup();
    await t.accounts.saveMastodon(body);
    const check = {
      id: '42',
      instanceURL: 'social.example',
      accessToken: 'masto-token',
    };

    t.net.mastodonStatus = 503;
    expect((await t.accounts.checkMastodon(check)).authExpired).toBe(false);

    // At most one check a minute
    t.net.mastodonStatus = 401;
    expect((await t.accounts.checkMastodon(check)).authExpired).toBe(false);
    t.clock.t += ATTEMPT_INTERVAL;
    expect((await t.accounts.checkMastodon(check)).authExpired).toBe(true);
  });

  it('gives a device with an older token the stored one, unchecked', async () => {
    const t = await setup();
    await t.accounts.saveMastodon(body);
    const view = await t.accounts.checkMastodon({
      id: '42',
      instanceURL: 'social.example',
      accessToken: 'older',
    });
    expect(view.accessToken).toBe('masto-token');
    expect(
      t.net.calls.filter((c) => c.path.endsWith('verify_credentials')),
    ).toHaveLength(1);
  });
});

describe('remove', () => {
  it('deletes a Bluesky account and ends its session', async () => {
    const t = await loggedIn();
    expect(await t.accounts.remove({ network: 'bluesky', id: DID })).toEqual({
      removed: true,
    });
    expect(await t.stored()).toEqual([]);
    expect(t.net.live.has('refresh-1')).toBe(false);
  });

  it('deletes a Mastodon account and revokes its token', async () => {
    const t = await setup();
    await t.accounts.saveMastodon({
      instanceURL: 'social.example',
      accessToken: 'masto-token',
      clientId: 'cid',
      clientSecret: 'csecret',
    });
    await t.accounts.remove({
      network: 'mastodon',
      id: '42',
      instanceURL: 'social.example',
    });
    expect(await t.stored()).toEqual([]);
    expect(t.net.calls.some((c) => c.path === '/oauth/revoke')).toBe(true);
  });
});
