// Keeps the accounts store in step with the Fleeting service, which holds
// every account session (see "Account sessions" in CLAUDE.md). The pure
// rules are in ./account-merge.js.

import { proxy } from 'valtio';

import {
  applyView,
  hasLoggedInAccount,
  mergeServiceAccounts,
  pendingImports,
  stripCredentials,
} from './account-merge';
import { blueskyInstanceInfo } from './bluesky/convert';
import { serviceFetch, ServiceUnpairedError } from './fleeting-service';
import store from './store';
import {
  getAccounts,
  getCredentialApplication,
  mutateAccounts,
  setCurrentAccountID,
} from './store-utils';

// `unpaired` holds the ServiceUnpairedError while this device has no cookie
// for the service, so the login page and the fixed-accounts banner can show
// the unlock control. Its own module, not `states`, because `states` imports
// the API clients, which import this file.
export const servicePairing = proxy({ unpaired: null });

function noteServiceError(e) {
  if (e instanceof ServiceUnpairedError) servicePairing.unpaired = e;
}

const sameAccount = (view) => (a) =>
  view.network === 'bluesky'
    ? a.accountType === 'bluesky' && a.info?.id === view.id
    : a.accountType !== 'bluesky' &&
      String(a.info?.id) === String(view.id) &&
      String(a.instanceURL).toLowerCase() === view.instanceURL;

// A Bluesky "instance" has no Mastodon instance API, so its instance and
// NodeInfo records are written locally
function seedBlueskyInstance(instance) {
  if (!instance) return;
  const instances = store.local.getJSON('instances') || {};
  if (instances[instance]) return;
  instances[instance] = blueskyInstanceInfo(instance);
  store.local.setJSON('instances', instances);
  const nodeInfos = store.local.getJSON('nodeInfos') || {};
  nodeInfos[instance] = {
    software: { name: 'bluesky', version: '1.0.0' },
  };
  store.local.setJSON('nodeInfos', nodeInfos);
}

function seedFor(accounts) {
  for (const a of accounts) {
    if (a.accountType === 'bluesky') seedBlueskyInstance(a.instanceURL);
  }
}

// Writes one account from the service into the store and returns the
// stored copy
export function applyAccountView(view) {
  let stored = null;
  mutateAccounts((accounts) => {
    stored = accounts.find(sameAccount(view));
    if (!stored) {
      stored = { createdAt: Date.now() };
      accounts.push(stored);
    }
    applyView(stored, view);
  });
  seedFor([stored]);
  return stored;
}

// The Bluesky session manager's `requestAccess`: reports the access token
// that the PDS refused and stores what the service answers. Resolves to the
// session to retry with, or null.
export async function requestBlueskyAccess(did, failed) {
  const ask = () =>
    serviceFetch('/accounts/bluesky/access', {
      method: 'POST',
      body: { did, failed },
    });
  try {
    let view;
    try {
      view = await ask();
    } catch (e) {
      // The service has no session for the account yet: this device's own
      // login has not been uploaded. Upload it, then ask again.
      if (e?.status !== 404) throw e;
      await syncAccounts();
      view = await ask();
    }
    const stored = applyAccountView(view);
    if (view.authExpired) return null;
    return stored.blueskySession;
  } catch (e) {
    noteServiceError(e);
    console.warn('Bluesky access token not renewed', e);
    return null;
  }
}

// A Mastodon request got a 401. The service checks its token and answers
// with the account, which may hold a newer token or authExpired.
export async function reportMastodonRefusal(account) {
  try {
    const view = await serviceFetch('/accounts/mastodon/check', {
      method: 'POST',
      body: {
        id: account.info.id,
        instanceURL: account.instanceURL,
        accessToken: account.accessToken,
      },
    });
    applyAccountView(view);
  } catch (e) {
    noteServiceError(e);
    console.warn('Mastodon token check failed', e);
  }
}

// Uploads one account that this device logged in to before the service
// held it. A refused credential ends the account here; any other failure
// leaves it for the next sync.
async function importAccount(acc) {
  try {
    let view;
    if (acc.accountType === 'bluesky') {
      view = await serviceFetch('/accounts/bluesky/import', {
        method: 'POST',
        body: {
          did: acc.info.id,
          service: acc.blueskyService,
          refreshJwt: acc.blueskySession.refreshJwt,
        },
      });
    } else {
      const app = getCredentialApplication(acc.instanceURL) || {};
      view = await serviceFetch('/accounts/mastodon', {
        method: 'POST',
        body: {
          instanceURL: acc.instanceURL,
          accessToken: acc.accessToken,
          clientId: acc.clientId || app.client_id,
          clientSecret: acc.clientSecret || app.client_secret,
          vapidKey: acc.vapidKey,
        },
      });
    }
    applyAccountView(view);
  } catch (e) {
    if (e instanceof ServiceUnpairedError) throw e;
    if (e?.status === 401) {
      mutateAccounts((accounts) => {
        const stored = accounts.find(
          (a) =>
            a.info?.id === acc.info?.id && a.instanceURL === acc.instanceURL,
        );
        if (!stored) return false;
        stripCredentials(stored);
      });
    } else {
      console.warn('Account not uploaded to the Fleeting service', e);
    }
  }
}

let syncing = null;

// Uploads this device's own logins, then reads every account from the
// service. Resolves to { changed, gained } — `gained` when the device had
// no usable account before and has one now — or to null when the service
// cannot be used; the accounts store is then left as it is.
export function syncAccounts() {
  return (syncing ||= runSync().finally(() => {
    syncing = null;
  }));
}

async function runSync() {
  try {
    for (const acc of pendingImports(getAccounts())) {
      await importAccount(acc);
    }
    const { accounts: views } = await serviceFetch('/accounts');
    servicePairing.unpaired = null;
    const hadAccount = hasLoggedInAccount(getAccounts());
    let changed = false;
    const accounts = mutateAccounts((accounts) => {
      changed = mergeServiceAccounts(accounts, views);
      return changed;
    });
    seedFor(accounts);
    const gained = !hadAccount && hasLoggedInAccount(accounts);
    // The current account was not usable, so the first usable one takes over
    if (gained) {
      const first = accounts.find((a) => hasLoggedInAccount([a]));
      if (first) setCurrentAccountID(first.info.id);
    }
    return { changed, gained };
  } catch (e) {
    noteServiceError(e);
    if (!(e instanceof ServiceUnpairedError)) {
      console.warn('Account sync with the Fleeting service failed', e);
    }
    return null;
  }
}

// Logs the account out on every device: the service deletes its session
// and ends it on the network
export function removeServiceAccount(account) {
  return serviceFetch('/accounts/remove', {
    method: 'POST',
    body:
      account.accountType === 'bluesky'
        ? { network: 'bluesky', id: account.info.id }
        : {
            network: 'mastodon',
            id: account.info.id,
            instanceURL: account.instanceURL,
          },
  });
}
