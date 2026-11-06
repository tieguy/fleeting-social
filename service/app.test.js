import { mkdtemp } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createApp } from './app.js';
import { DEVICES, SETUP_CODE_TTL, createAuth, emptyDevices } from './auth.js';
import { createStore } from './store.js';

// Stands in for @simplewebauthn/server. A "response" is valid when it names
// the challenge it answers. Every verify call must require user
// verification.
function fakeWebauthn() {
  let n = 0;
  const calls = [];
  return {
    calls,
    async generateRegistrationOptions(opts) {
      calls.push(['regOptions', opts]);
      return { challenge: `reg-${++n}` };
    },
    async verifyRegistrationResponse(opts) {
      calls.push(['verifyReg', opts]);
      if (opts.response.challenge !== opts.expectedChallenge) {
        return { verified: false };
      }
      return {
        verified: true,
        registrationInfo: {
          credential: {
            id: opts.response.id,
            publicKey: new Uint8Array([1, 2, 3]),
            counter: 0,
          },
        },
      };
    },
    async generateAuthenticationOptions(opts) {
      calls.push(['authOptions', opts]);
      return { challenge: `auth-${++n}` };
    },
    async verifyAuthenticationResponse(opts) {
      calls.push(['verifyAuth', opts]);
      if (opts.response.challenge !== opts.expectedChallenge) {
        return { verified: false };
      }
      return { verified: true, authenticationInfo: { newCounter: 7 } };
    },
  };
}

const servers = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.close();
});

async function start() {
  const dir = await mkdtemp(join(tmpdir(), 'fleeting-app-'));
  const store = await createStore(join(dir, 'data'));
  const webauthn = fakeWebauthn();
  const clock = { t: 1_000_000 };
  const logs = [];
  const auth = createAuth({
    store,
    webauthn,
    rpID: 'fleeting.test',
    origin: 'https://fleeting.test',
    log: (l) => logs.push(l),
    now: () => clock.t,
  });
  const code = await auth.startSetup();
  const server = createServer(createApp({ store, auth }));
  servers.push(server);
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}/fleeting-api`;

  async function call(method, path, { body, cookie, headers = {} } = {}) {
    const res = await fetch(base + path, {
      method,
      headers: {
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...(cookie ? { Cookie: cookie } : {}),
        ...headers,
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const setCookie = res.headers.get('set-cookie');
    return {
      status: res.status,
      json: await res.json(),
      cookie: setCookie ? setCookie.split(';')[0] : null,
      setCookie,
    };
  }

  async function setup(id = 'pk-1') {
    const opts = await call('POST', '/setup/options', { body: { code } });
    if (opts.status !== 200) return opts;
    return call('POST', '/setup', {
      body: {
        code,
        challengeId: opts.json.challengeId,
        response: { id, challenge: opts.json.options.challenge },
      },
    });
  }

  async function pair(id = 'pk-1') {
    const opts = await call('POST', '/pair/options');
    if (opts.status !== 200) return opts;
    return call('POST', '/pair', {
      body: {
        challengeId: opts.json.challengeId,
        response: { id, challenge: opts.json.options.challenge },
      },
    });
  }

  return { store, webauthn, clock, logs, code, call, setup, pair };
}

describe('authentication', () => {
  it('answers health without a cookie', async () => {
    const { call } = await start();
    expect((await call('GET', '/health')).status).toBe(200);
  });

  it('logs a setup code and says setup is open', async () => {
    const { call, code, logs } = await start();
    expect(code).toMatch(/^[0-9A-Z]{4}(-[0-9A-Z]{4}){3}$/);
    expect(logs.some((l) => l.includes(code))).toBe(true);
    const res = await call('GET', '/foryou');
    expect(res.status).toBe(401);
    expect(res.json).toEqual({ paired: false, hasPasskey: false, setup: true });
  });

  it('rejects a cross-site request', async () => {
    const { call } = await start();
    const res = await call('POST', '/pair/options', {
      headers: { 'Sec-Fetch-Site': 'cross-site' },
    });
    expect(res.status).toBe(403);
  });

  it('registers the first passkey with the setup code, once', async () => {
    const { call, setup, webauthn } = await start();
    const res = await setup();
    expect(res.status).toBe(200);
    expect(res.setCookie).toMatch(/HttpOnly/);
    expect(res.setCookie).toMatch(/Secure/);
    expect(res.setCookie).toMatch(/SameSite=Strict/);
    expect(res.setCookie).toMatch(/Path=\/fleeting-api/);
    expect((await call('GET', '/session', { cookie: res.cookie })).status).toBe(
      200,
    );
    const reg = webauthn.calls.find(([c]) => c === 'verifyReg')[1];
    expect(reg.requireUserVerification).toBe(true);
    expect(reg.expectedRPID).toBe('fleeting.test');
    expect(reg.expectedOrigin).toBe('https://fleeting.test');

    expect((await setup('pk-2')).status).toBe(403);
    const after = await call('GET', '/foryou');
    expect(after.json).toEqual({
      paired: false,
      hasPasskey: true,
      setup: false,
    });
  });

  it('refuses a wrong setup code and closes after ten', async () => {
    const { call, setup } = await start();
    for (let i = 0; i < 10; i++) {
      const res = await call('POST', '/setup/options', {
        body: { code: 'WRONG' },
      });
      expect(res.status).toBe(403);
    }
    expect((await setup()).status).toBe(403);
  });

  it('expires the setup code after 15 minutes', async () => {
    const { clock, setup } = await start();
    clock.t += SETUP_CODE_TTL + 1;
    expect((await setup()).status).toBe(403);
  });

  it('pairs a second device with the passkey', async () => {
    const { setup, pair, call, webauthn, store } = await start();
    await setup();
    const res = await pair();
    expect(res.status).toBe(200);
    expect((await call('GET', '/session', { cookie: res.cookie })).status).toBe(
      200,
    );
    const auth = webauthn.calls.find(([c]) => c === 'verifyAuth')[1];
    expect(auth.requireUserVerification).toBe(true);
    const { passkeys, devices } = await store.read(DEVICES, emptyDevices());
    expect(passkeys[0].counter).toBe(7);
    expect(devices).toHaveLength(2);
    // Only the hash of the token is stored
    expect(JSON.stringify(devices)).not.toContain(res.cookie.split('=')[1]);
  });

  it('uses a challenge once', async () => {
    const { setup, call } = await start();
    await setup();
    const opts = await call('POST', '/pair/options');
    const body = {
      challengeId: opts.json.challengeId,
      response: { id: 'pk-1', challenge: opts.json.options.challenge },
    };
    expect((await call('POST', '/pair', { body })).status).toBe(200);
    expect((await call('POST', '/pair', { body })).status).toBe(400);
  });

  it('refuses an unknown passkey and a wrong challenge', async () => {
    const { setup, pair, call } = await start();
    await setup();
    expect((await pair('pk-other')).status).toBe(401);
    const opts = await call('POST', '/pair/options');
    const res = await call('POST', '/pair', {
      body: {
        challengeId: opts.json.challengeId,
        response: { id: 'pk-1', challenge: 'forged' },
      },
    });
    expect(res.status).toBe(401);
  });

  it('stops a revoked device at once', async () => {
    const { setup, call, store } = await start();
    const { cookie } = await setup();
    await store.update(DEVICES, emptyDevices(), (d) => ({
      ...d,
      devices: [],
    }));
    expect((await call('GET', '/session', { cookie })).status).toBe(401);
  });

  it('sends the cookie again once an hour to move its expiry', async () => {
    const { setup, call, clock } = await start();
    const { cookie } = await setup();
    expect((await call('GET', '/session', { cookie })).setCookie).toBeNull();
    clock.t += 61 * 60 * 1000;
    expect((await call('GET', '/session', { cookie })).setCookie).toMatch(
      /Max-Age=31536000/,
    );
  });

  it('adds another passkey from a paired device', async () => {
    const { setup, call, store, webauthn } = await start();
    const { cookie } = await setup();
    expect((await call('POST', '/passkeys/options')).status).toBe(401);
    const opts = await call('POST', '/passkeys/options', { cookie });
    const regOpts = webauthn.calls.filter(([c]) => c === 'regOptions').at(-1);
    expect(regOpts[1].excludeCredentials).toEqual([
      { id: 'pk-1', transports: [] },
    ]);
    const res = await call('POST', '/passkeys', {
      cookie,
      body: {
        challengeId: opts.json.challengeId,
        response: { id: 'pk-2', challenge: opts.json.options.challenge },
      },
    });
    expect(res.status).toBe(200);
    const { passkeys } = await store.read(DEVICES, emptyDevices());
    expect(passkeys.map((p) => p.id)).toEqual(['pk-1', 'pk-2']);
  });
});

describe('For You routes', () => {
  it('shares one state between two devices', async () => {
    const { setup, pair, call } = await start();
    const a = (await setup()).cookie;
    const b = (await pair()).cookie;
    await call('POST', '/foryou/digests', {
      cookie: a,
      body: { at: 100, picks: [{ key: 'x/1', rule: 'raw' }] },
    });
    await call('POST', '/foryou/verdicts', {
      cookie: b,
      body: { key: 'x/1', rule: 'raw', verdict: 'interesting', action: 'like' },
    });
    const res = await call('GET', '/foryou', { cookie: a });
    expect(res.json.lastRead).toBe(100);
    expect(res.json.digests).toHaveLength(1);
    expect(res.json.verdicts['x/1'].actions).toEqual(['like']);
  });

  it('imports a device state and answers with the merge', async () => {
    const { setup, call } = await start();
    const { cookie } = await setup();
    const res = await call('POST', '/foryou/import', {
      cookie,
      body: { lastRead: 50, digests: [], verdicts: {} },
    });
    expect(res.status).toBe(200);
    expect(res.json.lastRead).toBe(50);
  });

  it('answers 400 to a bad operation and 401 without a cookie', async () => {
    const { setup, call } = await start();
    const { cookie } = await setup();
    const bad = await call('POST', '/foryou/verdicts', {
      cookie,
      body: { key: 'x/1' },
    });
    expect(bad.status).toBe(400);
    const none = await call('POST', '/foryou/digests', {
      body: { at: 1, picks: [] },
    });
    expect(none.status).toBe(401);
  });
});
