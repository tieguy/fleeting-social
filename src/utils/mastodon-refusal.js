// Reports a Mastodon 401 to the Fleeting service, which checks the token and
// alone decides that it is revoked (see "Account sessions" in CLAUDE.md).
//
// masto.js takes no fetch of its own and calls the global `fetch` for every
// request, so the watcher wraps the global once. It only reads the response
// status and the request's Authorization header; it changes nothing.

import { reportMastodonRefusal } from './account-sync';
import { getAccounts } from './store-utils';

const REPORT_INTERVAL = 60 * 1000;

// The stored Mastodon account whose token a refused request carried, or
// null. Pure, for tests.
export function refusedMastodonAccount({ url, authorization, accounts }) {
  const token = /^Bearer\s+(\S+)$/i.exec(authorization || '')?.[1];
  if (!token) return null;
  let host;
  try {
    host = new URL(url).host.toLowerCase();
  } catch (e) {
    return null;
  }
  return (
    accounts.find(
      (a) =>
        a.accountType !== 'bluesky' &&
        a.accessToken === token &&
        String(a.instanceURL).toLowerCase() === host,
    ) || null
  );
}

const lastReport = new Map(); // token → time
let installed = false;

export function watchMastodonRefusals() {
  if (installed || typeof window === 'undefined') return;
  installed = true;
  const original = window.fetch;
  window.fetch = async function fetch(input, init) {
    const res = await original.call(this, input, init);
    if (res.status === 401) {
      try {
        const req = input instanceof Request ? input : null;
        const headers = new Headers(init?.headers || req?.headers);
        const account = refusedMastodonAccount({
          url: req ? req.url : String(input),
          authorization: headers.get('authorization'),
          accounts: getAccounts(),
        });
        const last = account && lastReport.get(account.accessToken);
        if (account && !(last && Date.now() - last < REPORT_INTERVAL)) {
          lastReport.set(account.accessToken, Date.now());
          reportMastodonRefusal(account);
        }
      } catch (e) {
        console.warn(e);
      }
    }
    return res;
  };
}
