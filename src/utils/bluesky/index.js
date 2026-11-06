// Bluesky account management + client registry for phanpy
import { applyAccountView, requestBlueskyAccess } from '../account-sync';
import { serviceFetch } from '../fleeting-service';
import {
  getAccount,
  getAccounts,
  getCurrentAccountID,
  setCurrentAccountID,
} from '../store-utils';

import { createBlueskyClient } from './client';

export { isBlueskyStatusID } from './convert';

export const DEFAULT_BLUESKY_SERVICE = 'https://bsky.social';

// did → client
const blueskyClients = {};

export function isBlueskyAccount(account) {
  return account?.accountType === 'bluesky';
}

// Logged in = the account holds an access token from the Fleeting service
// (or, before the first sync, from this device's own login). The service
// sets `authExpired` when the PDS refuses the session's refresh token —
// treat it as logged out so merged-timeline and cross-post fan-outs skip the
// account instead of erroring on every call. A Bluesky account that an
// earlier OAuth login stored has no `blueskySession` and is logged out.
export function isBlueskyLoggedIn(account) {
  return (
    isBlueskyAccount(account) &&
    !account.authExpired &&
    !!account.blueskySession?.accessJwt
  );
}

export function getBlueskyAccounts() {
  return getAccounts().filter(isBlueskyLoggedIn);
}

// Whether the user is logged in to both networks — used to decide when
// per-post network badges are worth showing. Cached per page load
// (account changes trigger a reload anyway).
let multiNetwork = null;
export function hasMultipleNetworks() {
  if (multiNetwork !== null) return multiNetwork;
  const accounts = getAccounts();
  return (multiNetwork =
    accounts.some(isBlueskyLoggedIn) &&
    accounts.some(
      (a) => !isBlueskyAccount(a) && a.accessToken && !a.authExpired,
    ));
}

// Instances (hostnames) that belong to logged-in Bluesky accounts
export function isBlueskyInstance(instance) {
  if (!instance) return false;
  instance = instance.toLowerCase().trim();
  return getAccounts().some(
    (a) => isBlueskyAccount(a) && a.instanceURL === instance,
  );
}

export function getBlueskyAccountForInstance(instance) {
  if (!instance) return null;
  instance = instance.toLowerCase().trim();
  return (
    getAccounts().find(
      (a) => isBlueskyAccount(a) && a.instanceURL === instance,
    ) || null
  );
}

// The stored session, read again for every request. An account from before
// the service held sessions has no `pdsUrl`; its login service answers until
// the first sync stores the PDS.
function storedSession(did) {
  const acc = getAccounts().find(
    (a) => isBlueskyAccount(a) && a.info.id === did,
  );
  if (!acc?.blueskySession || acc.authExpired) return null;
  return {
    ...acc.blueskySession,
    pdsUrl:
      acc.blueskySession.pdsUrl ||
      acc.blueskyService ||
      DEFAULT_BLUESKY_SERVICE,
  };
}

export function getBlueskyClient(account) {
  const did = account.info.id;
  if (blueskyClients[did]) return blueskyClients[did];
  const client = createBlueskyClient({
    instance: account.instanceURL,
    did,
    getSession: () => storedSession(did),
    requestAccess: (failed) => requestBlueskyAccess(did, failed),
  });
  blueskyClients[did] = client;
  return client;
}

// api()-compatible result for a Bluesky account
export function blueskyApi(account) {
  const client = getBlueskyClient(account);
  return {
    masto: client.masto,
    streaming: undefined,
    client,
    authenticated: isBlueskyLoggedIn(account),
    instance: account.instanceURL,
  };
}

// Log in with handle + app password through the Fleeting service, which
// keeps the session for every device and not the password. Saves the
// account and makes it current.
export async function loginBluesky({ service, identifier, password }) {
  const view = await serviceFetch('/accounts/bluesky', {
    method: 'POST',
    body: {
      service: service || DEFAULT_BLUESKY_SERVICE,
      identifier,
      password,
    },
  });
  applyAccountView(view);
  setCurrentAccountID(view.id);
  // Invalidate any cached client for this account
  delete blueskyClients[view.id];
  return view.id;
}

export function logoutBluesky(accountID) {
  delete blueskyClients[accountID];
}

// Sources for the merged home timeline: all logged-in accounts of the
// *other* network than the current account
export function getOtherNetworkAccounts() {
  const currentID = getCurrentAccountID();
  const current = getAccount(currentID);
  if (!current) return [];
  const accounts = getAccounts();
  if (isBlueskyAccount(current)) {
    // Current is Bluesky → other Mastodon-ish accounts
    return accounts.filter(
      (a) => !isBlueskyAccount(a) && a.accessToken && !a.authExpired,
    );
  }
  // Current is Mastodon → Bluesky accounts
  return accounts.filter(
    (a) => isBlueskyLoggedIn(a) && a.info.id !== currentID,
  );
}

// The home-feed view preferences (hide reposts/replies/quote posts) from
// the first logged-in Bluesky account — one preference set governs the
// whole home timeline, both networks
export async function getHomeFeedViewPrefs() {
  const account = getBlueskyAccounts()[0];
  if (!account) return {};
  try {
    return await blueskyApi(account).client.getFeedViewPrefs();
  } catch (e) {
    console.error(e);
    return {};
  }
}
