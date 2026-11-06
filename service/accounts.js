// Account sessions for every device. See "Job 2: account sessions" in
// docs/design-plans/2026-11-05-deepthought-service.md.
//
// The service is the only holder of each Bluesky refresh token and the only
// process that refreshes it, so two devices can no longer rotate the same
// token. A browser gets the access token and asks for a new one when the PDS
// refuses it. The service also keeps each Mastodon token, so a device that
// pairs gets every account with no login of its own.
//
// The service alone decides that a session is dead:
//
// - Bluesky: only when the PDS refuses a refresh with a 4xx other than 429.
//   A network error, a 429 or a 5xx changes nothing.
// - Mastodon: only when verify_credentials answers 401.
//
// `fetch` is passed in so that tests can replace the network.

export const ACCOUNTS = 'accounts';
export function emptyAccounts() {
  return { accounts: [] };
}

// A refresh, or a Mastodon token check, runs at most this often for each
// account
export const ATTEMPT_INTERVAL = 60 * 1000;
const NETWORK_TIMEOUT = 15 * 1000;
export const DEFAULT_BLUESKY_SERVICE = 'https://bsky.social';

export class AccountError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// The PDS refused the refresh token. A rate limit proves nothing.
export function isTerminalRefusal(status) {
  return status >= 400 && status < 500 && status !== 429;
}

// What to do when a browser reports that `failed` was refused:
//   'expired' — the session is dead already
//   'stored'  — answer with the stored token: another device refreshed
//               already, or a refresh ran within the last minute
//   'refresh' — refresh with the stored refresh token
export function refreshDecision(entry, failed, { now, lastAttempt = 0 }) {
  if (entry.authExpired) return 'expired';
  if (failed !== entry.accessJwt) return 'stored';
  if (now - lastAttempt < ATTEMPT_INTERVAL) return 'stored';
  return 'refresh';
}

// The PDS URL from a DID document, or null
export function pdsFromDidDoc(didDoc) {
  const services = Array.isArray(didDoc?.service) ? didDoc.service : [];
  const pds = services.find(
    (s) =>
      (s?.id === '#atproto_pds' || s?.id?.endsWith?.('#atproto_pds')) &&
      s?.type === 'AtprotoPersonalDataServer',
  );
  const url = pds?.serviceEndpoint;
  if (typeof url !== 'string') return null;
  try {
    const { protocol, origin } = new URL(url);
    return protocol === 'https:' ? origin : null;
  } catch {
    return null;
  }
}

// What a device gets: everything but the Bluesky refresh token and the
// service's own bookkeeping
export function publicView(entry) {
  if (!entry) return null;
  if (entry.network === 'bluesky') {
    return {
      network: 'bluesky',
      id: entry.id,
      handle: entry.handle,
      service: entry.service,
      pdsUrl: entry.pdsUrl,
      accessJwt: entry.accessJwt,
      active: entry.active !== false,
      profile: entry.profile || null,
      authExpired: !!entry.authExpired,
    };
  }
  return {
    network: 'mastodon',
    id: entry.id,
    instanceURL: entry.instanceURL,
    accessToken: entry.accessToken,
    clientId: entry.clientId || null,
    clientSecret: entry.clientSecret || null,
    vapidKey: entry.vapidKey || null,
    info: entry.info || null,
    authExpired: !!entry.authExpired,
  };
}

function normalizeService(service) {
  let s = String(service || DEFAULT_BLUESKY_SERVICE).trim();
  if (!/^https?:\/\//.test(s)) s = `https://${s}`;
  s = s.replace(/\/+$/, '');
  let url;
  try {
    url = new URL(s);
  } catch {
    throw new AccountError(400, 'service is not a URL');
  }
  if (url.protocol !== 'https:') {
    throw new AccountError(400, 'service must use https');
  }
  return url.origin;
}

function normalizeInstance(instance) {
  const host = String(instance || '')
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/\/+$/, '');
  if (!/^[a-z0-9.-]+(:\d+)?$/.test(host)) {
    throw new AccountError(400, 'instanceURL is not a host name');
  }
  return host;
}

function requireString(value, name) {
  if (typeof value !== 'string' || !value) {
    throw new AccountError(400, `${name} is missing`);
  }
  return value;
}

const isBluesky = (did) => (e) => e.network === 'bluesky' && e.id === did;
const isMastodon = (id, instanceURL) => (e) =>
  e.network === 'mastodon' && e.id === id && e.instanceURL === instanceURL;

export function createAccounts({
  store,
  fetch = globalThis.fetch,
  log = () => {},
  now = Date.now,
}) {
  const read = () => store.read(ACCOUNTS, emptyAccounts());
  const update = (fn) => store.update(ACCOUNTS, emptyAccounts(), fn);
  // account key → time of the last refresh or token check
  const lastAttempt = new Map();
  // DID → the refresh in flight, so concurrent reports share one refresh
  const inflight = new Map();

  // Resolves to the response, or to null on a network error or timeout
  async function call(url, { method = 'GET', token, body } = {}) {
    try {
      return await fetch(url, {
        method,
        headers: {
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(NETWORK_TIMEOUT),
      });
    } catch (e) {
      log(`network error: ${method} ${new URL(url).host}: ${e.message || e}`);
      return null;
    }
  }

  async function json(res) {
    try {
      return await res.json();
    } catch {
      return {};
    }
  }

  async function list() {
    const { accounts } = await read();
    return accounts.map(publicView);
  }

  // ---------- Bluesky ----------

  async function fetchProfile(pdsUrl, did, accessJwt) {
    const res = await call(
      `${pdsUrl}/xrpc/app.bsky.actor.getProfile?actor=${encodeURIComponent(did)}`,
      { token: accessJwt },
    );
    if (res?.ok) return json(res);
    return null;
  }

  // Stores a new session from createSession or refreshSession. Any older
  // session for the DID is replaced.
  async function storeSession(service, data) {
    const pdsUrl = pdsFromDidDoc(data.didDoc) || service;
    const profile = (await fetchProfile(pdsUrl, data.did, data.accessJwt)) || {
      did: data.did,
      handle: data.handle,
    };
    const entry = {
      network: 'bluesky',
      id: data.did,
      handle: data.handle,
      service,
      pdsUrl,
      accessJwt: data.accessJwt,
      refreshJwt: data.refreshJwt,
      active: data.active !== false,
      profile,
      updatedAt: now(),
    };
    await update((state) => {
      state.accounts = state.accounts.filter((e) => !isBluesky(data.did)(e));
      state.accounts.push(entry);
      return state;
    });
    return entry;
  }

  // Logs in with an app password. The service does not keep the password.
  async function loginBluesky(body) {
    const service = normalizeService(body.service);
    const identifier = requireString(body.identifier, 'identifier')
      .trim()
      .replace(/^@/, '');
    const password = requireString(body.password, 'password').trim();
    const res = await call(`${service}/xrpc/com.atproto.server.createSession`, {
      method: 'POST',
      body: { identifier, password },
    });
    if (!res) throw new AccountError(502, `${service} cannot be reached`);
    const data = await json(res);
    if (!res.ok) {
      throw new AccountError(
        res.status === 401 ? 401 : 502,
        data.message || `${service} answered ${res.status}`,
      );
    }
    const entry = await storeSession(service, data);
    lastAttempt.delete(`bluesky:${entry.id}`);
    log(`bluesky login ${entry.handle} (${entry.id})`);
    return publicView(entry);
  }

  // A device hands over the refresh token it kept before the service held
  // sessions. The service keeps its own session when it has a live one, and
  // otherwise refreshes the device's token to prove it and take it over.
  async function importBluesky(body) {
    const did = requireString(body.did, 'did');
    const refreshJwt = requireString(body.refreshJwt, 'refreshJwt');
    const service = normalizeService(body.service);
    const { accounts } = await read();
    const existing = accounts.find(isBluesky(did));
    if (existing && !existing.authExpired) return publicView(existing);

    const res = await call(
      `${service}/xrpc/com.atproto.server.refreshSession`,
      { method: 'POST', token: refreshJwt },
    );
    if (!res) throw new AccountError(502, `${service} cannot be reached`);
    const data = await json(res);
    if (!res.ok || data.did !== did) {
      throw new AccountError(
        isTerminalRefusal(res.status) ? 401 : 502,
        data.message || `${service} answered ${res.status}`,
      );
    }
    const entry = await storeSession(service, data);
    log(`bluesky import ${entry.handle} (${entry.id})`);
    return publicView(entry);
  }

  // Session calls go to the service the account logged in through (for
  // bsky.social accounts, the entryway), as @atproto/api's CredentialSession
  // does; the PDS gets every other call.
  async function refresh(entry) {
    const key = `bluesky:${entry.id}`;
    lastAttempt.set(key, now());
    const used = entry.refreshJwt;
    const res = await call(
      `${entry.service}/xrpc/com.atproto.server.refreshSession`,
      { method: 'POST', token: used },
    );
    if (!res) return entry;
    const data = await json(res);
    if (res.ok && data.accessJwt && data.refreshJwt) {
      log(`bluesky refresh ${entry.handle}: ok`);
      const state = await update((state) => {
        const stored = state.accounts.find(isBluesky(entry.id));
        // A login replaced the session while this refresh ran
        if (!stored || stored.refreshJwt !== used) return state;
        stored.accessJwt = data.accessJwt;
        stored.refreshJwt = data.refreshJwt;
        stored.handle = data.handle || stored.handle;
        stored.active = data.active !== false;
        stored.pdsUrl = pdsFromDidDoc(data.didDoc) || stored.pdsUrl;
        stored.updatedAt = now();
        delete stored.authExpired;
        return state;
      });
      return state.accounts.find(isBluesky(entry.id)) || entry;
    }
    log(
      `bluesky refresh ${entry.handle}: ${res.status} ${data.error || ''}`.trim(),
    );
    if (!isTerminalRefusal(res.status)) return entry;
    const state = await update((state) => {
      const stored = state.accounts.find(isBluesky(entry.id));
      if (stored && stored.refreshJwt === used) {
        stored.authExpired = true;
        log(`bluesky session ended: ${entry.handle}`);
      }
      return state;
    });
    return state.accounts.find(isBluesky(entry.id)) || entry;
  }

  // A device reports that the PDS refused `failed`. Answers with the
  // current access token, a new one, or authExpired.
  async function blueskyAccess(body) {
    const did = requireString(body.did, 'did');
    const failed = typeof body.failed === 'string' ? body.failed : null;
    const { accounts } = await read();
    // Checked after the read: another report may have started a refresh
    // while this one waited for the file
    const pending = inflight.get(did);
    if (pending) return publicView(await pending);
    const entry = accounts.find(isBluesky(did));
    if (!entry) throw new AccountError(404, 'no session for this account');
    const decision = refreshDecision(entry, failed, {
      now: now(),
      lastAttempt: lastAttempt.get(`bluesky:${did}`),
    });
    if (decision !== 'refresh') return publicView(entry);

    const run = refresh(entry).finally(() => inflight.delete(did));
    inflight.set(did, run);
    return publicView(await run);
  }

  // ---------- Mastodon ----------

  async function verifyCredentials(instanceURL, accessToken) {
    return call(`https://${instanceURL}/api/v1/accounts/verify_credentials`, {
      token: accessToken,
    });
  }

  // Stores a Mastodon token after verify_credentials accepts it. Mastodon
  // tokens do not rotate, so the newest token replaces the stored one.
  async function saveMastodon(body) {
    const instanceURL = normalizeInstance(body.instanceURL);
    const accessToken = requireString(body.accessToken, 'accessToken');
    const res = await verifyCredentials(instanceURL, accessToken);
    if (!res) throw new AccountError(502, `${instanceURL} cannot be reached`);
    const info = await json(res);
    if (!res.ok || !info.id) {
      throw new AccountError(
        res.status === 401 ? 401 : 502,
        info.error || `${instanceURL} answered ${res.status}`,
      );
    }
    const entry = {
      network: 'mastodon',
      id: String(info.id),
      instanceURL,
      accessToken,
      clientId: body.clientId || null,
      clientSecret: body.clientSecret || null,
      vapidKey: body.vapidKey || null,
      info,
      updatedAt: now(),
    };
    await update((state) => {
      const i = state.accounts.findIndex(isMastodon(entry.id, instanceURL));
      if (i >= 0) {
        const old = state.accounts[i];
        // Keep the OAuth app of the stored entry when the device has none
        entry.clientId ||= old.clientId || null;
        entry.clientSecret ||= old.clientSecret || null;
        entry.vapidKey ||= old.vapidKey || null;
        state.accounts[i] = entry;
      } else {
        state.accounts.push(entry);
      }
      return state;
    });
    log(`mastodon token stored for ${info.acct}@${instanceURL}`);
    return publicView(entry);
  }

  // A device got a 401 from the instance. The service checks the stored
  // token, at most once a minute, and marks the account only when the
  // instance answers 401. A device with an older token gets the stored one.
  async function checkMastodon(body) {
    const instanceURL = normalizeInstance(body.instanceURL);
    const id = requireString(String(body.id ?? ''), 'id');
    const { accounts } = await read();
    const entry = accounts.find(isMastodon(id, instanceURL));
    if (!entry) throw new AccountError(404, 'no session for this account');
    if (entry.authExpired || body.accessToken !== entry.accessToken) {
      return publicView(entry);
    }
    const key = `mastodon:${instanceURL}:${id}`;
    if (now() - (lastAttempt.get(key) || 0) < ATTEMPT_INTERVAL) {
      return publicView(entry);
    }
    lastAttempt.set(key, now());
    const res = await verifyCredentials(instanceURL, entry.accessToken);
    if (!res || (res.status !== 401 && !res.ok)) return publicView(entry);
    const info = res.ok ? await json(res) : null;
    const state = await update((state) => {
      const stored = state.accounts.find(isMastodon(id, instanceURL));
      if (!stored || stored.accessToken !== entry.accessToken) return state;
      if (res.status === 401) {
        stored.authExpired = true;
        log(`mastodon token refused: ${stored.info?.acct}@${instanceURL}`);
      } else {
        delete stored.authExpired;
        if (info?.id) stored.info = info;
      }
      return state;
    });
    return publicView(state.accounts.find(isMastodon(id, instanceURL)));
  }

  // ---------- Log out ----------

  // Deletes the account from the service, so every device is logged out.
  // Ending the session on the network is best effort.
  async function remove(body) {
    const network = body.network;
    let match;
    if (network === 'bluesky') {
      match = isBluesky(requireString(body.id, 'id'));
    } else if (network === 'mastodon') {
      match = isMastodon(
        requireString(String(body.id ?? ''), 'id'),
        normalizeInstance(body.instanceURL),
      );
    } else {
      throw new AccountError(400, 'network is bluesky or mastodon');
    }
    let removed = null;
    await update((state) => {
      removed = state.accounts.find(match) || null;
      state.accounts = state.accounts.filter((e) => !match(e));
      return state;
    });
    if (!removed) return { removed: false };
    if (removed.network === 'bluesky') {
      await call(`${removed.service}/xrpc/com.atproto.server.deleteSession`, {
        method: 'POST',
        token: removed.refreshJwt,
      });
    } else if (removed.clientId && removed.clientSecret) {
      const form = new URLSearchParams({
        client_id: removed.clientId,
        client_secret: removed.clientSecret,
        token: removed.accessToken,
      });
      try {
        await fetch(`https://${removed.instanceURL}/oauth/revoke`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: form.toString(),
          signal: AbortSignal.timeout(NETWORK_TIMEOUT),
        });
      } catch (e) {
        log(`mastodon revoke failed: ${e.message || e}`);
      }
    }
    log(`logged out ${removed.network} ${removed.id}`);
    return { removed: true };
  }

  return {
    list,
    loginBluesky,
    importBluesky,
    blueskyAccess,
    saveMastodon,
    checkMastodon,
    remove,
  };
}
