// The HTTP routes under /fleeting-api/. See "Job 1: For You API" and
// "Authentication" in docs/design-plans/2026-11-05-deepthought-service.md.

import { AuthError, deviceCookie } from './auth.js';
import {
  BadRequest,
  addDigest,
  addVerdict,
  emptyState,
  importState,
} from './foryou.js';

const PREFIX = '/fleeting-api';
const MAX_BODY = 2 * 1024 * 1024;
const FORYOU = 'foryou';

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function send(res, status, body, headers = {}) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(JSON.stringify(body));
}

async function readJson(req) {
  if (!/^application\/json\b/.test(req.headers['content-type'] || '')) {
    throw new HttpError(415, 'send JSON');
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw new HttpError(413, 'body too large');
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  } catch {
    throw new HttpError(400, 'body is not JSON');
  }
}

// Tailscale serve adds these to proxied requests and strips them from
// incoming ones. The service logs them when present and does not need them.
function tailscaleIdentity(req) {
  const login = req.headers['tailscale-user-login'];
  return login ? ` tailscale-user=${login}` : '';
}

export function createApp({
  store,
  auth,
  secureCookie = true,
  log = () => {},
}) {
  const readForYou = () => store.read(FORYOU, emptyState());
  const updateForYou = (fn) => store.update(FORYOU, emptyState(), fn);

  async function paired(req, res, passkey) {
    const { token, device } = await auth.issueDevice({
      userAgent: req.headers['user-agent'],
      passkeyId: passkey.id,
    });
    log(
      `paired device ${device.id} (${device.userAgent})${tailscaleIdentity(req)}`,
    );
    send(
      res,
      200,
      { paired: true },
      { 'Set-Cookie': deviceCookie(token, { secure: secureCookie }) },
    );
  }

  // Routes that need no device cookie
  const open = {
    'GET /health': (req, res) => send(res, 200, { ok: true }),
    'POST /setup/options': async (req, res) =>
      send(res, 200, await auth.setupOptions(await readJson(req))),
    'POST /setup': async (req, res) => {
      const passkey = await auth.completeSetup(await readJson(req));
      await paired(req, res, passkey);
    },
    'POST /pair/options': async (req, res) =>
      send(res, 200, await auth.pairOptions()),
    'POST /pair': async (req, res) => {
      const passkey = await auth.verifyPair(await readJson(req));
      await paired(req, res, passkey);
    },
  };

  // Routes that need a device cookie
  const closed = {
    'GET /session': (req, res) => send(res, 200, { paired: true }),
    'POST /passkeys/options': async (req, res) =>
      send(res, 200, await auth.registrationOptions()),
    'POST /passkeys': async (req, res) => {
      const passkey = await auth.verifyRegistration(await readJson(req));
      log(`registered another passkey ${passkey.id}`);
      send(res, 200, { ok: true });
    },
    'GET /foryou': async (req, res) => send(res, 200, await readForYou()),
    'POST /foryou/digests': async (req, res) => {
      const body = await readJson(req);
      send(res, 200, await updateForYou((s) => addDigest(s, body)));
    },
    'POST /foryou/verdicts': async (req, res) => {
      const body = await readJson(req);
      send(res, 200, await updateForYou((s) => addVerdict(s, body)));
    },
    'POST /foryou/import': async (req, res) => {
      const body = await readJson(req);
      send(res, 200, await updateForYou((s) => importState(s, body)));
    },
  };

  return async function handle(req, res) {
    try {
      const url = new URL(req.url, 'http://service');
      if (!url.pathname.startsWith(`${PREFIX}/`)) {
        throw new HttpError(404, 'not found');
      }
      // SameSite=Strict keeps the cookie off cross-site requests; this also
      // stops a cross-site POST that needs no cookie, such as /pair
      const site = req.headers['sec-fetch-site'];
      if (site && site !== 'same-origin') {
        throw new HttpError(403, 'cross-site request');
      }
      const route = `${req.method} ${url.pathname.slice(PREFIX.length)}`;
      if (open[route]) return await open[route](req, res);
      if (!closed[route]) throw new HttpError(404, 'not found');

      const found = await auth.deviceFor(req.headers.cookie);
      if (!found) {
        // `setup` tells the app to ask for the setup code instead of a
        // passkey
        const hasPasskey = await auth.hasPasskey();
        return send(res, 401, {
          paired: false,
          hasPasskey,
          setup: !hasPasskey && auth.setupOpen(),
        });
      }
      if (found.touched) {
        res.setHeader(
          'Set-Cookie',
          deviceCookie(found.token, { secure: secureCookie }),
        );
      }
      return await closed[route](req, res);
    } catch (e) {
      const status =
        e instanceof HttpError || e instanceof AuthError
          ? e.status
          : e instanceof BadRequest
            ? 400
            : 500;
      if (status >= 500) log(`error: ${e.stack || e}`);
      if (!res.headersSent) {
        send(res, status, {
          error: status >= 500 ? 'server error' : e.message,
        });
      }
    }
  };
}
