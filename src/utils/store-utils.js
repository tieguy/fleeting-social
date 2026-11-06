import mem from './mem';
import store from './store';

export function getAccounts() {
  return store.local.getJSON('accounts') || [];
}

export function saveAccounts(accounts) {
  store.local.setJSON('accounts', accounts);
}

// Read-modify-write helper for the accounts store. New access tokens from the
// Fleeting service land in this store at any time, so writing back an array
// captured at render/mount time can revert one. Mutations must re-read at
// write time: `fn` gets a freshly-read array; return false to skip saving.
export function mutateAccounts(fn) {
  const accounts = getAccounts();
  if (fn(accounts) === false) return accounts;
  saveAccounts(accounts);
  return accounts;
}

const MINS_5 = 5 * 60 * 1000;
export function getAccount(id) {
  const accounts = getAccounts();
  const account = id ? accounts.find((a) => a.info.id === id) : accounts[0];
  if (!account) return null;
  const now = Date.now();
  // Only update if more than 5 mins
  if (now - account.lastAccessedAt > MINS_5) {
    account.lastAccessedAt = now;
    saveAccounts(accounts);
  }
  return account;
}

export function getAccountByAccessToken(accessToken) {
  const accounts = getAccounts();
  return accounts.find((a) => a.accessToken === accessToken);
}

export function getAccountByInstance(instance) {
  const accounts = getAccounts();
  return accounts.find((a) => a.instanceURL === instance);
}

export function hasAccountInInstance(instance) {
  const accounts = getAccounts();
  return accounts.some((a) => a.instanceURL === instance);
}

// Is this account one of *ours* — on any logged-in account, either network?
// Not just the currently-active one: in a merged timeline your own Bluesky post
// shows up while a Mastodon account is active (and vice-versa), and it's still
// yours to delete, pin, or edit. Must be keyed on (id, instance) together —
// Mastodon account IDs are only unique within an instance.
export function isSelfAccountID(id, instance) {
  if (!id || !instance) return false;
  // api() lowercases the instance it hands back, and both login paths store
  // instanceURL lowercased — normalize anyway, since account records outlive
  // builds in localStorage and a mismatch here would silently hide the
  // self-only actions rather than fail loudly.
  const key = String(instance).toLowerCase().trim();
  return getAccounts().some(
    (a) =>
      a.info?.id === id && String(a.instanceURL).toLowerCase().trim() === key,
  );
}

const standaloneMQ =
  typeof window !== 'undefined'
    ? window.matchMedia('(display-mode: standalone)')
    : null;

export function getCurrentAccountID() {
  try {
    const id = store.session.get('currentAccount');
    if (id) return id;
  } catch (e) {}
  if (standaloneMQ?.matches) {
    try {
      const id = store.local.get('currentAccount');
      if (id) return id;
    } catch (e) {}
  }
  return null;
}

// Memoized version of getCurrentAccountID for performance
export const getCurrentAccID = mem(getCurrentAccountID, {
  expires: 60 * 1000, // 1 minute
});

export function setCurrentAccountID(id) {
  getCurrentAccID.cache.clear();
  getCurrentAcc.cache.clear();
  try {
    store.session.set('currentAccount', id);
  } catch (e) {}
  if (standaloneMQ?.matches) {
    try {
      store.local.set('currentAccount', id);
    } catch (e) {}
  }
}

export function getCurrentAccount() {
  if (!window.__IGNORE_GET_ACCOUNT_ERROR__) {
    // Track down getCurrentAccount() calls before account-based states are initialized
    console.error('getCurrentAccount() called before states are initialized');
    if (import.meta.env.DEV) console.trace();
  }
  const currentAccount = getCurrentAccountID();
  let account = getAccount(currentAccount);
  if (!account) {
    // Fallback to the first account if currentAccount is not found
    account = getAccount();
  }
  return account;
}

// Memoized version of getCurrentAccount for performance
export const getCurrentAcc = mem(getCurrentAccount, {
  expires: 60 * 1000, // 1 minute
});

export function getCurrentAccountNS() {
  const account = getCurrentAccount();
  const {
    instanceURL,
    info: { id },
  } = account;
  return `${id}@${instanceURL}`;
}

export function saveAccount(account) {
  const accounts = getAccounts();
  const acc = accounts.find((a) => a.info.id === account.info.id);
  if (acc) {
    acc.info = account.info;
    acc.instanceURL = account.instanceURL;
    acc.accessToken = account.accessToken;
    acc.vapidKey = account.vapidKey;
    acc.updatedAt = Date.now();
    // A login on this device: the next account sync uploads the new token
    // to the Fleeting service (./account-sync.js)
    delete acc.serviceSynced;
    delete acc.authExpired;
  } else {
    accounts.push(account);
  }
  saveAccounts(accounts);
}

export function updateAccount(accountInfo) {
  // Only update if displayName or avatar or avatar_static is different
  const accounts = getAccounts();
  const acc = accounts.find((a) => a.info.id === accountInfo.id);
  if (acc) {
    if (
      acc.info.displayName !== accountInfo.displayName ||
      acc.info.avatar !== accountInfo.avatar ||
      acc.info.avatar_static !== accountInfo.avatar_static
    ) {
      acc.info = {
        ...acc.info,
        ...accountInfo,
      };
      saveAccounts(accounts);
    }
  }
}

let currentInstance = null;
export function getCurrentInstance() {
  if (currentInstance) return currentInstance;
  try {
    const account = getCurrentAccount();
    const instances = store.local.getJSON('instances');
    const instance = account.instanceURL.toLowerCase();
    return (currentInstance = instances[instance]);
  } catch (e) {
    console.error(e);
    // alert(`Failed to load instance configuration. Please try again.\n\n${e}`);
    // Temporary fix for corrupted data
    // store.local.del('instances');
    // location.reload();
    return {};
  }
}

let currentNodeInfo = null;
export function getCurrentNodeInfo() {
  if (currentNodeInfo) return currentNodeInfo;
  try {
    const account = getCurrentAccount();
    const nodeInfos = store.local.getJSON('nodeInfos') || {};
    const instanceURL = account.instanceURL.toLowerCase();
    return (currentNodeInfo = nodeInfos[instanceURL] || {});
  } catch (e) {
    console.error(e);
    return {};
  }
}

// Massage these instance configurations to match the Mastodon API
// - Pleroma
function getInstanceConfiguration(instance) {
  const { configuration, maxMediaAttachments, maxTootChars, pollLimits } =
    instance;

  const statuses = configuration?.statuses || {};
  if (maxMediaAttachments) {
    statuses.maxMediaAttachments ??= maxMediaAttachments;
  }

  if (maxTootChars) {
    statuses.maxCharacters ??= maxTootChars;
  }

  const polls = configuration?.polls || {};
  if (pollLimits) {
    polls.maxCharactersPerOption ??= pollLimits.maxOptionChars;
    polls.maxExpiration ??= pollLimits.maxExpiration;
    polls.maxOptions ??= pollLimits.maxOptions;
    polls.minExpiration ??= pollLimits.minExpiration;
  }

  return {
    ...configuration,
    statuses,
    polls,
  };
}

export function getCurrentInstanceConfiguration() {
  const instance = getCurrentInstance();
  return getInstanceConfiguration(instance);
}

export function getInstanceInfoByDomain(domain) {
  try {
    const instances = store.local.getJSON('instances');
    return instances?.[domain.toLowerCase().trim()] || null;
  } catch (e) {
    console.error(e);
    return null;
  }
}

export function getInstanceConfigurationByDomain(domain) {
  const instance = getInstanceInfoByDomain(domain);
  return instance ? getInstanceConfiguration(instance) : {};
}

// Pass a domain to ask what THAT instance supports. A capability check about a
// specific post or profile must do so: the current account may be on the other
// network entirely, and its apiVersions say nothing about this one.
export function getAPIVersions(domain) {
  const instance = domain
    ? getInstanceInfoByDomain(domain)
    : getCurrentInstance();
  return instance?.apiVersions || {};
}

export function getVapidKey(instance) {
  // Vapid key has moved from account to instance config
  const config = instance
    ? getInstanceConfiguration(instance)
    : getCurrentInstanceConfiguration();
  const vapidKey = config?.vapid?.publicKey || config?.vapid?.public_key;
  return vapidKey || getCurrentAccount()?.vapidKey;
}

export function isMediaFirstInstance() {
  const instance = getCurrentInstance();
  return /pixelfed/i.test(instance?.version);
}

const CREDENTIAL_APPLICATIONS_KEY = 'credentialApplications';

export function storeCredentialApplication(instanceURL, credentialApplication) {
  const stored = store.local.getJSON(CREDENTIAL_APPLICATIONS_KEY) || {};
  stored[instanceURL] = credentialApplication;
  store.local.setJSON(CREDENTIAL_APPLICATIONS_KEY, stored);
}

export function getCredentialApplication(instanceURL) {
  const stored = store.local.getJSON(CREDENTIAL_APPLICATIONS_KEY) || {};
  return stored[instanceURL] || null;
}
