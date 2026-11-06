// Pure parts of the account sync with the Fleeting service. The service
// holds every account session (see "Account sessions" in CLAUDE.md); the
// accounts store in localStorage is this device's copy of what the service
// answered, so the rest of the app reads accounts as before.
//
// An account that the service sent carries `serviceSynced`. An account
// without it was logged in on this device before the service held it, and
// is uploaded once (`pendingImports`). An account with it that the service
// no longer lists was logged out on another device, and loses its
// credentials here too, so a stale copy is never uploaded again.
//
// No store or browser imports, so this runs under vitest's node runner.

import { profileToAccount } from './bluesky/convert';

const isBlueskyAcct = (a) => a?.accountType === 'bluesky';

export function hostOf(url) {
  try {
    return new URL(url).host.toLowerCase();
  } catch (e) {
    return null;
  }
}

function matchesView(account, view) {
  if (view.network === 'bluesky') {
    return isBlueskyAcct(account) && account.info?.id === view.id;
  }
  return (
    !isBlueskyAcct(account) &&
    String(account.info?.id) === String(view.id) &&
    String(account.instanceURL).toLowerCase() === view.instanceURL
  );
}

// Writes one service account into a local account object, in place.
// `existing` is the local account or a new empty object.
export function applyView(existing, view) {
  const acc = existing;
  if (view.network === 'bluesky') {
    const instance = hostOf(view.service) || acc.instanceURL;
    const info = view.profile
      ? profileToAccount(view.profile, instance)
      : acc.info || { id: view.id, username: view.handle, acct: view.handle };
    Object.assign(acc, {
      info,
      instanceURL: instance,
      accessToken: view.accessJwt,
      accountType: 'bluesky',
      blueskyService: view.service,
      blueskySession: {
        did: view.id,
        handle: view.handle,
        accessJwt: view.accessJwt,
        pdsUrl: view.pdsUrl,
        active: view.active !== false,
      },
      vapidKey: acc.vapidKey ?? null,
      serviceSynced: true,
    });
  } else {
    Object.assign(acc, {
      info: view.info || acc.info,
      instanceURL: view.instanceURL,
      accessToken: view.accessToken,
      vapidKey: view.vapidKey || acc.vapidKey || null,
      serviceSynced: true,
    });
    if (view.clientId) acc.clientId = view.clientId;
    if (view.clientSecret) acc.clientSecret = view.clientSecret;
  }
  if (view.authExpired) acc.authExpired = true;
  else delete acc.authExpired;
  return acc;
}

// Removes an account's credentials and keeps its entry, so the Accounts
// sheet offers "Log back in"
export function stripCredentials(acc) {
  delete acc.accessToken;
  delete acc.blueskySession;
  delete acc.authExpired;
  delete acc.serviceSynced;
  return acc;
}

// Applies the service's account list to the local accounts array, in place.
// Returns true when anything changed.
export function mergeServiceAccounts(
  accounts,
  views,
  { now = Date.now() } = {},
) {
  const before = JSON.stringify(accounts);
  for (const view of views) {
    const existing = accounts.find((a) => matchesView(a, view));
    if (existing) {
      applyView(existing, view);
    } else {
      accounts.push(applyView({ createdAt: now }, view));
    }
  }
  for (const acc of accounts) {
    if (acc.serviceSynced && !views.some((v) => matchesView(acc, v))) {
      stripCredentials(acc);
    }
  }
  return JSON.stringify(accounts) !== before;
}

// Local accounts that the service has not seen: logged in on this device
// before the service held sessions, or a Mastodon login on this device
export function pendingImports(accounts) {
  return accounts.filter((a) => {
    if (a.serviceSynced) return false;
    if (isBlueskyAcct(a)) return !!a.blueskySession?.refreshJwt;
    return !!a.accessToken;
  });
}

// Whether any account can act, the same rule as `isLoggedIn` in
// ./acting-accounts.js
export function hasLoggedInAccount(accounts) {
  return accounts.some((a) =>
    isBlueskyAcct(a)
      ? !a.authExpired && !!a.blueskySession?.accessJwt
      : !a.authExpired && !!a.accessToken,
  );
}
