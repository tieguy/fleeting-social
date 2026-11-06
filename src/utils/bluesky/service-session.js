// An @atproto/api SessionManager whose session lives on the Fleeting
// service. The browser holds only the access token; it never sees the
// refresh token and never refreshes. When the PDS refuses the access token,
// the manager reports the refused token to the service, which answers with
// the current token: one that another device already got, a new one from
// its own refresh, or none when the session is dead. See "Account sessions"
// in CLAUDE.md.
//
// `getSession()` returns the stored session ({ did, accessJwt, pdsUrl }),
// read again for every request, so a token that another tab stored is used
// at once. `requestAccess(failedToken)` asks the service and resolves to the
// new session, or to null.
//
// No store imports, so this runs under vitest's node runner.

// The same test as @atproto/api's CredentialSession: a 401, or a 400 whose
// XRPC error is ExpiredToken
async function isExpiredToken(res) {
  if (res.status === 401) return true;
  if (res.status !== 400) return false;
  try {
    const body = await res.clone().json();
    return body?.error === 'ExpiredToken';
  } catch (e) {
    return false;
  }
}

export function createServiceSessionManager({
  did,
  getSession,
  requestAccess,
  fetch = (...args) => globalThis.fetch(...args),
}) {
  // Requests that fail with the same token share one call to the service
  let pending = null;
  let pendingFor = null;
  function access(failed) {
    if (!pending || pendingFor !== failed) {
      pendingFor = failed;
      pending = Promise.resolve()
        .then(() => requestAccess(failed))
        .finally(() => {
          pending = null;
          pendingFor = null;
        });
    }
    return pending;
  }

  function request(url, init, session) {
    const req = new Request(new URL(url, session.pdsUrl), init);
    if (!req.headers.has('authorization')) {
      req.headers.set('authorization', `Bearer ${session.accessJwt}`);
    }
    return req;
  }

  return {
    get did() {
      return getSession()?.did || did;
    },
    async fetchHandler(url, init) {
      const session = getSession();
      if (!session?.accessJwt || !session.pdsUrl) {
        throw new Error('No Bluesky session for this account');
      }
      const token = session.accessJwt;
      const res = await fetch(request(url, init, session));
      if (!(await isExpiredToken(res))) return res;
      // A streamed body cannot be sent twice
      if (
        typeof ReadableStream !== 'undefined' &&
        init?.body instanceof ReadableStream
      ) {
        return res;
      }
      let fresh;
      try {
        fresh = await access(token);
      } catch (e) {
        return res;
      }
      if (!fresh?.accessJwt || fresh.accessJwt === token || !fresh.pdsUrl) {
        return res;
      }
      if (init?.signal?.aborted) return res;
      await res.body?.cancel();
      return fetch(request(url, init, fresh));
    },
  };
}
