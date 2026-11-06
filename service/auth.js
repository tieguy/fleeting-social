// Passkeys, the one-time setup code, and device cookies.
//
// A passkey is the only proof of identity. A device cookie remembers, for one
// device, that a passkey was used there. The first passkey registers with a
// one-time setup code that the service writes to its log. See "Authentication"
// in docs/design-plans/2026-11-05-deepthought-service.md.
//
// `webauthn` is @simplewebauthn/server, passed in so that tests can replace it.

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export const COOKIE = 'fleeting_device';
export const COOKIE_MAX_AGE = 365 * 24 * 60 * 60; // seconds
const CHALLENGE_TTL = 10 * 60 * 1000;
const MAX_CHALLENGES = 100;
export const SETUP_CODE_TTL = 15 * 60 * 1000;
const SETUP_MAX_TRIES = 10;
// Last use is written at most this often, and the cookie's expiry moves
// forward at the same time
const TOUCH_INTERVAL = 60 * 60 * 1000;
// No 0/O or 1/I/L, so the code reads off a log without mistakes
const CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';

export const DEVICES = 'devices';
export function emptyDevices() {
  return { passkeys: [], devices: [] };
}

export function hashToken(token) {
  return createHash('sha256').update(token).digest('hex');
}

export function makeSetupCode() {
  const bytes = randomBytes(16);
  let code = '';
  for (let i = 0; i < 16; i++) {
    code += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
    if (i % 4 === 3 && i < 15) code += '-';
  }
  return code;
}

function normalizeCode(code) {
  return String(code || '')
    .toUpperCase()
    .replace(/[^0-9A-Z]/g, '');
}

export function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

export function deviceCookie(token, { secure }) {
  return [
    `${COOKIE}=${token}`,
    'HttpOnly',
    secure ? 'Secure' : null,
    'SameSite=Strict',
    'Path=/fleeting-api',
    `Max-Age=${COOKIE_MAX_AGE}`,
  ]
    .filter(Boolean)
    .join('; ');
}

export class AuthError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

export function createAuth({
  store,
  webauthn,
  rpID,
  origin,
  rpName = 'Fleeting',
  log = () => {},
  now = Date.now,
}) {
  const challenges = new Map();
  let setup = null; // { code, expires, tries }

  const readDevices = () => store.read(DEVICES, emptyDevices());
  const updateDevices = (fn) => store.update(DEVICES, emptyDevices(), fn);

  function saveChallenge(kind, challenge) {
    const id = randomBytes(16).toString('base64url');
    for (const [k, c] of challenges) {
      if (c.expires < now() || challenges.size >= MAX_CHALLENGES) {
        challenges.delete(k);
      }
    }
    challenges.set(id, { kind, challenge, expires: now() + CHALLENGE_TTL });
    return id;
  }

  // Works once: the challenge is deleted when it is read
  function takeChallenge(kind, id) {
    const c = challenges.get(id);
    challenges.delete(id);
    if (!c || c.kind !== kind || c.expires < now()) {
      throw new AuthError('challenge expired or unknown');
    }
    return c.challenge;
  }

  // At start: when no passkey exists, make a setup code and log it
  async function startSetup() {
    const { passkeys } = await readDevices();
    if (passkeys.length) return null;
    setup = {
      code: makeSetupCode(),
      expires: now() + SETUP_CODE_TTL,
      tries: 0,
    };
    log(`setup code (one use, valid 15 minutes): ${setup.code}`);
    return setup.code;
  }

  function setupOpen() {
    return !!setup && setup.expires > now() && setup.tries < SETUP_MAX_TRIES;
  }

  function checkSetupCode(code) {
    if (!setupOpen()) throw new AuthError('setup is closed', 403);
    const given = Buffer.from(normalizeCode(code));
    const want = Buffer.from(normalizeCode(setup.code));
    if (given.length !== want.length || !timingSafeEqual(given, want)) {
      setup.tries++;
      if (!setupOpen()) log('setup code closed after too many wrong tries');
      throw new AuthError('wrong setup code', 403);
    }
  }

  async function registrationOptions({ excludeExisting }) {
    const { passkeys } = await readDevices();
    const options = await webauthn.generateRegistrationOptions({
      rpName,
      rpID,
      userName: 'fleeting',
      userDisplayName: 'Fleeting',
      attestationType: 'none',
      authenticatorSelection: {
        residentKey: 'preferred',
        userVerification: 'required',
      },
      excludeCredentials: excludeExisting
        ? passkeys.map((p) => ({ id: p.id, transports: p.transports }))
        : [],
    });
    return {
      challengeId: saveChallenge('register', options.challenge),
      options,
    };
  }

  async function verifyRegistration({ challengeId, response }) {
    const expectedChallenge = takeChallenge('register', challengeId);
    let verification;
    try {
      verification = await webauthn.verifyRegistrationResponse({
        response,
        expectedChallenge,
        expectedOrigin: origin,
        expectedRPID: rpID,
        requireUserVerification: true,
      });
    } catch (e) {
      throw new AuthError(`registration failed: ${e.message}`);
    }
    if (!verification?.verified || !verification.registrationInfo) {
      throw new AuthError('registration failed');
    }
    const { credential } = verification.registrationInfo;
    const passkey = {
      id: credential.id,
      publicKey: Buffer.from(credential.publicKey).toString('base64url'),
      counter: credential.counter,
      transports: response?.response?.transports || [],
      createdAt: now(),
    };
    await updateDevices((doc) => ({
      ...doc,
      passkeys: [...doc.passkeys.filter((p) => p.id !== passkey.id), passkey],
    }));
    return passkey;
  }

  // The first passkey, with the setup code. The code is spent only when the
  // registration succeeds.
  async function setupOptions({ code }) {
    checkSetupCode(code);
    return registrationOptions({ excludeExisting: false });
  }

  async function completeSetup({ code, challengeId, response }) {
    checkSetupCode(code);
    const passkey = await verifyRegistration({ challengeId, response });
    setup = null;
    log(`registered the first passkey ${passkey.id}`);
    return passkey;
  }

  async function pairOptions() {
    const { passkeys } = await readDevices();
    if (!passkeys.length) throw new AuthError('no passkey registered', 409);
    const options = await webauthn.generateAuthenticationOptions({
      rpID,
      allowCredentials: passkeys.map((p) => ({
        id: p.id,
        transports: p.transports,
      })),
      userVerification: 'required',
    });
    return { challengeId: saveChallenge('pair', options.challenge), options };
  }

  async function verifyPair({ challengeId, response }) {
    const expectedChallenge = takeChallenge('pair', challengeId);
    const { passkeys } = await readDevices();
    const passkey = passkeys.find((p) => p.id === response?.id);
    if (!passkey) throw new AuthError('unknown passkey', 401);
    let verification;
    try {
      verification = await webauthn.verifyAuthenticationResponse({
        response,
        expectedChallenge,
        expectedOrigin: origin,
        expectedRPID: rpID,
        requireUserVerification: true,
        credential: {
          id: passkey.id,
          publicKey: new Uint8Array(
            Buffer.from(passkey.publicKey, 'base64url'),
          ),
          counter: passkey.counter,
          transports: passkey.transports,
        },
      });
    } catch (e) {
      throw new AuthError(`passkey check failed: ${e.message}`, 401);
    }
    // A verified result with no authenticationInfo counts as a failure
    if (!verification?.verified || !verification.authenticationInfo) {
      throw new AuthError('passkey check failed', 401);
    }
    const { newCounter } = verification.authenticationInfo;
    await updateDevices((doc) => ({
      ...doc,
      passkeys: doc.passkeys.map((p) =>
        p.id === passkey.id ? { ...p, counter: newCounter } : p,
      ),
    }));
    return passkey;
  }

  // Makes a device token for one device and stores its hash
  async function issueDevice({ userAgent, passkeyId }) {
    const token = randomBytes(32).toString('base64url');
    const device = {
      id: randomBytes(4).toString('hex'),
      hash: hashToken(token),
      userAgent: String(userAgent || '').slice(0, 300),
      passkeyId,
      createdAt: now(),
      lastUsed: now(),
    };
    await updateDevices((doc) => ({
      ...doc,
      devices: [...doc.devices, device],
    }));
    return { token, device };
  }

  // The device for a request's cookie, or null. `touched` says that its last
  // use was written now, so the caller sends the cookie again with a new
  // expiry.
  async function deviceFor(cookieHeader) {
    const token = parseCookies(cookieHeader)[COOKIE];
    if (!token) return null;
    const hash = hashToken(token);
    const { devices } = await readDevices();
    const device = devices.find((d) => d.hash === hash);
    if (!device) return null;
    if (now() - device.lastUsed < TOUCH_INTERVAL) {
      return { device, token, touched: false };
    }
    await updateDevices((doc) => ({
      ...doc,
      devices: doc.devices.map((d) =>
        d.hash === hash ? { ...d, lastUsed: now() } : d,
      ),
    }));
    return { device, token, touched: true };
  }

  async function hasPasskey() {
    return (await readDevices()).passkeys.length > 0;
  }

  return {
    startSetup,
    setupOpen,
    setupOptions,
    completeSetup,
    pairOptions,
    verifyPair,
    registrationOptions: () => registrationOptions({ excludeExisting: true }),
    verifyRegistration,
    issueDevice,
    deviceFor,
    hasPasskey,
  };
}
