// Which logged-in accounts can act on a given target — the shared eligibility
// core behind "post as / boost as / reply as any account". The active/switched
// account is deliberately not special here: callers get a list and let the
// user (or a same-network rule) choose.
//
// Pure module: accounts and the current-account id are passed in by callers
// (getAccounts() / getCurrentAccountID()), keeping this free of store/browser
// imports so it runs under vitest's node runner — same convention as
// ./mention-network.js.

// Mirrors isBlueskyAccount() / isBlueskyLoggedIn() in ./bluesky/index.js,
// inlined for the store-free reason above.
const isBlueskyAcct = (account) => account?.accountType === 'bluesky';

// Whether a stored account can act. A Bluesky account needs an app-password
// refresh JWT and no `authExpired` flag; an `accessToken` alone does not
// count, because a Bluesky account stored by the removed OAuth login holds
// an access token and no refresh JWT. A Mastodon account needs a token.
export const isLoggedIn = (account) =>
  isBlueskyAcct(account)
    ? !account.authExpired && !!account.blueskySession?.refreshJwt
    : !!account?.accessToken;

// Logged-in accounts on the target's network — the accounts that could
// perform a same-network action (boost, favourite, reply, follow…) on it.
// Callers compute targetIsBluesky the usual way:
//   info._bluesky || isBlueskyInstance(instance)
export function eligibleAccounts({ targetIsBluesky, accounts }) {
  return (accounts || []).filter(
    (a) => isLoggedIn(a) && isBlueskyAcct(a) === !!targetIsBluesky,
  );
}

// Every logged-in account, current one first, deduped by info.id — the
// roster for the compose target checkboxes and the Profile submenu.
export function accountRoster({ accounts, currentID }) {
  const roster = (accounts || [])
    .filter(isLoggedIn)
    .filter(
      (a, i, arr) => arr.findIndex((b) => b.info?.id === a.info?.id) === i,
    );
  if (currentID) {
    const i = roster.findIndex((a) => a.info?.id === currentID);
    if (i > 0) roster.unshift(roster.splice(i, 1)[0]);
  }
  return roster;
}
