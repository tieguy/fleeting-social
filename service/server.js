// Fleeting service entry point. Configuration comes from the environment:
//
//   FLEETING_SERVICE_RP_ID    WebAuthn relying party ID, the app's host name
//   FLEETING_SERVICE_ORIGIN   the app's origin, for example https://host
//   FLEETING_SERVICE_DATA     data directory (default ./data)
//   FLEETING_SERVICE_PORT     listen port (default 8080)
//
// The RP ID and origin come from configuration, not from the request: the
// request reaches the service through tailscale serve and Caddy, so its URL
// names an internal host.

import { createServer } from 'node:http';

import * as webauthn from '@simplewebauthn/server';

import { createAccounts } from './accounts.js';
import { createApp } from './app.js';
import { createAuth } from './auth.js';
import { createStore } from './store.js';

const rpID = process.env.FLEETING_SERVICE_RP_ID;
const origin = process.env.FLEETING_SERVICE_ORIGIN;
if (!rpID || !origin) {
  console.error(
    'Set FLEETING_SERVICE_RP_ID and FLEETING_SERVICE_ORIGIN; see server.js',
  );
  process.exit(1);
}
const dataDir = process.env.FLEETING_SERVICE_DATA || './data';
const port = Number(process.env.FLEETING_SERVICE_PORT || 8080);

function log(line) {
  console.log(`fleeting-service: ${line}`);
}

const store = await createStore(dataDir);
const auth = createAuth({ store, webauthn, rpID, origin, log });
const accounts = createAccounts({ store, log });
const handle = createApp({
  store,
  auth,
  accounts,
  secureCookie: origin.startsWith('https:'),
  log,
});

createServer(handle).listen(port, () => {
  log(`listening on ${port}, origin ${origin}`);
  auth.startSetup();
});

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => process.exit(0));
}
