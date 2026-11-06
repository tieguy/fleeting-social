// The accounts a single-user deployment offers on the login page, from the
// build-time FLEETING_ACCOUNTS variable. When it is set, the login page
// shows one entry per account instead of free-text server and handle fields.
//
// Format: comma-separated `network:identifier` pairs, e.g.
//   mastodon:luis_in_brief@social.coop,bluesky:lu.is
//
// Pure module so it runs under vitest's node runner. Malformed entries are
// dropped rather than thrown: a typo in deploy config must not take the
// login page down.

export function parseFixedAccounts(value) {
  if (!value) return [];
  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map(parseEntry)
    .filter(Boolean);
}

function parseEntry(entry) {
  const sep = entry.indexOf(':');
  if (sep < 0) return null;
  const network = entry.slice(0, sep).trim().toLowerCase();
  const id = entry
    .slice(sep + 1)
    .trim()
    .replace(/^@/, '');
  if (!id) return null;

  if (network === 'mastodon') {
    const at = id.lastIndexOf('@');
    if (at <= 0 || at === id.length - 1) return null;
    const username = id.slice(0, at);
    const instance = id.slice(at + 1).toLowerCase();
    return { network, username, instance, label: `@${username}@${instance}` };
  }
  if (network === 'bluesky') {
    const handle = id.toLowerCase();
    return { network, handle, label: `@${handle}` };
  }
  return null;
}

// Which fixed accounts this device is logged in to. `accounts` is the
// accounts store. Each fixed account comes back with `state`:
//   'ok'      — a usable session is stored
//   'expired' — the Fleeting service found the session dead (`authExpired`)
//   'missing' — nothing stored for it on this device
export function fixedAccountStates(fixedAccounts, accounts = []) {
  return fixedAccounts.map((fixed) => {
    const stored = accounts.find((a) => matches(fixed, a));
    let state = 'missing';
    if (stored) {
      if (stored.authExpired) state = 'expired';
      else if (
        fixed.network === 'bluesky'
          ? stored.blueskySession?.accessJwt
          : stored.accessToken
      ) {
        state = 'ok';
      }
    }
    return { ...fixed, state };
  });
}

function matches(fixed, account) {
  const lower = (s) => (s || '').toLowerCase().replace(/^@/, '');
  if (fixed.network === 'bluesky') {
    if (account.accountType !== 'bluesky') return false;
    return [account.blueskySession?.handle, account.info?.acct].some(
      (h) => lower(h) === fixed.handle,
    );
  }
  if (account.accountType === 'bluesky') return false;
  return (
    lower(account.info?.username) === lower(fixed.username) &&
    lower(account.instanceURL) === fixed.instance
  );
}
