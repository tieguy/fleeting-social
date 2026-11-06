// Client for the Fleeting service on deepthought, at /fleeting-api/ on the
// app's own origin. The service authenticates each device with a passkey
// once, then with an HttpOnly device cookie. See
// docs/design-plans/2026-11-05-deepthought-service.md.

const BASE = '/fleeting-api';

// The device has no valid cookie. `setup` is true when no passkey exists yet
// and the service takes a setup code; `hasPasskey` is false then.
export class ServiceUnpairedError extends Error {
  constructor({ setup = false, hasPasskey = true } = {}) {
    super('This device is not unlocked for the Fleeting service');
    this.setup = setup;
    this.hasPasskey = hasPasskey;
  }
}

// Any other failure: the service is down, unreachable or refused the call
export class ServiceError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

export async function serviceFetch(path, { method = 'GET', body } = {}) {
  let res;
  try {
    res = await fetch(BASE + path, {
      method,
      credentials: 'same-origin',
      cache: 'no-store',
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    throw new ServiceError(`The Fleeting service cannot be reached`);
  }
  let json = null;
  try {
    json = await res.json();
  } catch (e) {}
  if (res.status === 401 && json?.paired === false) {
    throw new ServiceUnpairedError(json);
  }
  if (!res.ok) {
    throw new ServiceError(
      json?.error || `The Fleeting service answered ${res.status}`,
      res.status,
    );
  }
  return json;
}

const webauthn = () => import('@simplewebauthn/browser');

// Options for the next passkey login. The unlock screen fetches them before
// the tap, so the passkey prompt opens straight from the tap: Safari wants
// WebAuthn calls to follow a user gesture closely.
export function pairOptions() {
  return serviceFetch('/pair/options', { method: 'POST' });
}

export async function pairDevice(prefetched) {
  const { startAuthentication } = await webauthn();
  const { challengeId, options } = prefetched || (await pairOptions());
  const response = await startAuthentication({ optionsJSON: options });
  return serviceFetch('/pair', {
    method: 'POST',
    body: { challengeId, response },
  });
}

// Registers the first passkey with the one-time setup code from the
// service's log, and unlocks this device
export async function setupDevice(code) {
  const { startRegistration } = await webauthn();
  const { challengeId, options } = await serviceFetch('/setup/options', {
    method: 'POST',
    body: { code },
  });
  const response = await startRegistration({ optionsJSON: options });
  return serviceFetch('/setup', {
    method: 'POST',
    body: { code, challengeId, response },
  });
}

// Registers one more passkey, for example in a second passkey manager. The
// device must be unlocked already.
export async function addPasskey() {
  const { startRegistration } = await webauthn();
  const { challengeId, options } = await serviceFetch('/passkeys/options', {
    method: 'POST',
  });
  const response = await startRegistration({ optionsJSON: options });
  return serviceFetch('/passkeys', {
    method: 'POST',
    body: { challengeId, response },
  });
}

export function serviceSession() {
  return serviceFetch('/session');
}
