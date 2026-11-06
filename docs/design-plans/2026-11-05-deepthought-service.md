# Fleeting Service Design

## Summary

A small HTTP service on deepthought keeps Fleeting's state in one place for
all of the user's devices. It has two jobs, built in this order:

1. **For You state.** Last read, the posts already shown and the verdicts
   (see "Storage" in `2026-11-05-for-you.md`). Browser storage is per
   device, so today each device has its own copy.
2. **Account sessions.** Today each browser holds its own Mastodon token
   and its own Bluesky refresh token. A Bluesky refresh token works only
   once, so two copies can invalidate each other. Several session bugs
   came from this (see "Session death is proven, never announced" in
   `CLAUDE.md`). After job 2, the service holds the Mastodon token and
   the Bluesky session for every device. It is the only holder of the
   Bluesky refresh token and the only process that refreshes it.

The service is on the same origin as the app, under `/fleeting-api/`. A
browser authenticates with a passkey, once for each device, and then
with a device cookie. The user has a passkey manager on every device, and
the passkey syncs between them. Job 1 builds this authentication, so job
2 adds no new trust step.

## Definition of Done

Job 1 (LUI-276):

- A Quadlet runs the service on deepthought. It publishes no port on the
  host. The Fleeting Caddy container sends `/fleeting-api/*` to it on a
  private Podman network.
- A device pairs with one passkey tap and gets a device cookie. A
  request without a valid cookie gets 401.
- The first passkey registers with a one-time setup code from the
  service's log.
- `src/utils/foryou-store.js` reads and writes through the service. Two
  devices show the same last read, the same shown posts and the same
  verdicts.
- On first contact, each device uploads its local For You state once. The
  service merges it.
- The service's data is under `~/containers/volumes/fleeting-service/`,
  mode 600.
- A push to `main` deploys the service as well as the site.

Job 2 (LUI-277):

- The service stores the Mastodon token and the Bluesky session for each
  fixed account. A new device that pairs gets both accounts with no
  further login.
- No browser holds a Bluesky refresh token. The browser asks the service
  for a new access token. The service refreshes at most once for each
  rotation, for all devices.
- The service alone decides that a Bluesky session is dead.
- `CLAUDE.md` describes the new session model.

## Glossary

- **Service**: The HTTP process that this plan describes.
- **Fixed account**: An account in `FLEETING_ACCOUNTS`.
- **Device**: One browser storage area. Safari and a home-screen web app
  on the same iPhone are two devices.
- **Device cookie**: A random token that the service issues to one
  device.
- **Pairing**: The exchange that gives a device its cookie.
- **Passkey**: A WebAuthn credential for the relying party ID
  `fleeting.peafowl-polaris.ts.net`, kept in iCloud Keychain or
  1Password.
- **Access token**: The short-lived Bluesky `accessJwt`. The PDS sets its
  expiry.
- **Refresh token**: The Bluesky `refreshJwt`. Each use rotates it.

## Threat model

The tailnet holds only the user's own devices (`tailscale status`,
2026-11-05): two iOS devices, two Linux machines, an Android phone, Home
Assistant and a Synology NAS. Tailscale already keeps every other host
out.

For job 1 this is enough. The For You state is low value. For job 2 it is
not enough. The service will hold credentials that control both accounts.
Any process on any tailnet device can send an HTTP request to the service.
Home Assistant and the NAS run third-party software. So the service must
identify the browser, not only the network.

Processes on deepthought that run as `louie` can read the data files. The
Claude Code sessions are such processes. This plan does not protect
against them. They can also change the app's code and deploy it, so a
file permission would not stop them.

## Authentication

### Decision: passkey, then a device cookie

A passkey is the only proof of identity. The device cookie only
remembers, for one device, that the passkey was used there.

Pairing:

1. The app calls `GET /fleeting-api/session`. If the cookie is valid, the
   service returns 200 and pairing stops here.
2. On 401, the app shows "Unlock Fleeting". A tap starts a WebAuthn
   assertion (`navigator.credentials.get`) with a challenge from
   `POST /fleeting-api/pair/options`.
3. The app sends the assertion to `POST /fleeting-api/pair`. The service
   verifies it against the stored public keys.
4. On success, the service creates a device token and returns it as a
   cookie.

Cookie: `HttpOnly; Secure; SameSite=Strict; Path=/fleeting-api; Max-Age`
one year. Each use moves the expiry forward. The service stores a SHA-256
hash of each device token, with the User-Agent and the time of last use.
A command in the container lists devices and revokes one.

Cross-site requests: the service rejects a request whose
`Sec-Fetch-Site` header is present and is not `same-origin`.
`SameSite=Strict` already keeps the cookie off cross-site requests. The
header check also stops a cross-site POST that needs no cookie, such as
`/pair`. The service sends no CORS headers.

Verification: the service verifies registrations and assertions with
[`@simplewebauthn/server`](https://github.com/MasterKale/SimpleWebAuthn).
WebAuthn verification is crypto and CBOR parsing, so the plan uses a
vetted library instead of new code. The browser side uses the native
`navigator.credentials` API. The service stores each passkey's public key
and sign counter in `devices.json`.

### Registering passkeys

Registration is the step that must not be open to any device on the
tailnet.

- **First passkey.** When `devices.json` holds no passkey, the service
  makes a random one-time setup code at start and writes it to its log.
  The user reads it with
  `journalctl --user -u fleeting-service`, or asks a Claude session on
  deepthought for it. The app's "Set up Fleeting" form takes the code and
  registers a passkey. The code works once and expires after 15 minutes.
  Then the service makes no more codes.
- **More passkeys.** A paired device can register another passkey, for
  example a second passkey manager, from the Accounts sheet.
- **Recovery.** If every passkey is lost, the user deletes the passkeys
  from `devices.json` and restarts the service. It then makes a new setup
  code.

Why this choice:

- One mechanism for both jobs. It does not depend on social.coop or the
  Bluesky PDS being up, and it needs no code that checks Mastodon or
  Bluesky credentials.
- It identifies the person at the device: a passkey needs Face ID, a
  fingerprint or a device PIN. A process on Home Assistant or the NAS has
  no passkey and cannot pair.
- In job 2, a new device gets both accounts from one tap, with no
  Mastodon OAuth round trip and no app password.
- The cost is one tap on each device, once a year or after the browser
  clears its cookies.

Not checked: WebAuthn in an iOS home-screen web app. A PWA vendor's demo
claims to create a passkey from the iPhone home screen
([Progressier](https://progressier.com/pwa-capabilities/biometric-authentication-with-passkeys)),
but no Apple source confirms it. The home-screen app has its own cookie
store, so it must pair on its own. The first step of the build is a test
page that runs a passkey registration and assertion from the home-screen
app on the iPhone and the iPad.

### Tailscale layer

Tailscale offers controls at three levels. This plan uses none of them as
a requirement. The service logs the headers of item 2 if they are present.

1. **Grants on the Service.** A tailnet policy grant can name
   `svc:fleeting` as its destination. Its source can be a user, a tag, a
   host alias or an IP address
   ([grants syntax](https://tailscale.com/kb/1538/grants-syntax)). A grant
   whose source lists only the iPhone, the iPad and the laptop stops Home
   Assistant and the NAS before they reach HTTP. Two cautions: the same
   grant also controls the static app, and a new device needs a policy
   edit before it can open Fleeting. The user decided on 2026-11-05 not
   to change the tailnet policy for now. The passkey does not depend on
   it.
2. **Identity headers and app capabilities.** `tailscale serve` adds
   `Tailscale-User-Login` to proxied requests. With `--accept-app-caps`
   (Tailscale 1.92 or later, deepthought has 1.104.2), it also forwards
   the capabilities that a grant gives the requester, as JSON in
   `Tailscale-App-Capabilities`
   ([Tailscale Serve docs](https://tailscale.com/kb/1312/serve),
   [app capabilities](https://tailscale.com/kb/1537/grants-app-capabilities)).
   Serve strips both headers from incoming requests, so a client cannot
   forge them. The docs do not say whether a Tailscale Service adds them,
   and this plan did not test it. Every device here has the same user, so
   the user header cannot tell a phone from the NAS. An app capability
   granted to the three device IP addresses could. But it gives the same
   protection as item 1, with more configuration. The service logs the
   headers if they are present, and does not require them.
3. **Login and MFA.** Tailscale has no per-request login or MFA for HTTP
   traffic. MFA applies when a device logs in to the tailnet, through the
   identity provider. Tailscale SSH has a check mode that asks for a new
   login, but only for SSH. `tsidp` is an OIDC provider that names the
   user from the tailnet
   ([tsidp](https://tailscale.com/docs/features/tsidp)). It is
   experimental, and it identifies the user, not the device, so it gives
   no more than item 2. The passkey is the login factor in this plan.

### Options not chosen

- **Tailnet membership only.** Enough for job 1, not for job 2 (see
  Threat model). Job 1 would then need a second authentication step
  later, and every job 1 endpoint would change.
- **Account proof.** The browser sends its Mastodon or Bluesky access
  token, and the service checks it with `verify_credentials` or
  `getSession` on the account's own server. Pairing then needs no tap in
  job 1. But it adds a second mechanism, it fails when social.coop or the
  PDS is down, and in job 2 a new device has no token to send.
- **A setup code for every device.** Each new device needs the service
  log. The passkey uses the setup code once.

## Routing and deployment

**Path.** The service is at `https://fleeting.peafowl-polaris.ts.net/fleeting-api/`.
Same origin means no CORS, no new `tailscale serve` handler and no CSP
change: `connect-src` already allows `'self'`. The prefix is not `/api/`
because `public/sw.js` caches responses whose path matches
`/api/v\d+/(custom_emojis|lists/\d+|announcements)` and
`/api/v\d+/statuses/\d+/context` on any origin.

**Containers.**

- A Quadlet network, `fleeting.network`.
- `fleeting.container` (Caddy) joins it. The Caddyfile gets a
  `handle /fleeting-api/*` block with `reverse_proxy fleeting-service:8080`,
  before the `file_server` block. A missing static file still gets a plain
  404, so the service worker's stale-shell recovery does not change.
- `fleeting-service.container` joins it and publishes no port. Image
  `docker.io/library/node:24-alpine`, pinned by tag and digest. The image
  publishes arm64 (checked 2026-11-05). `ReadOnly=true`,
  `UserNS=keep-id`, `DropCapability=ALL`, `NoNewPrivileges=true`,
  `--memory=128m --cpus=0.5`.
- Bind mounts: the code read-only, from
  `~/containers/volumes/fleeting-service/current`, and the data
  read-write, from `~/containers/volumes/fleeting-service/data`.

**Code.** The service is in `service/` in this repo. It uses Node
built-ins (`node:http`, `node:crypto`, `node:fs`, `fetch`) and one npm
dependency, `@simplewebauthn/server`. The container runs from the
bind-mounted source and does no `npm install` of its own.
Pure modules (the merge, the For You operations) have Vitest tests next to
them.

**Deploys.** `fleeting-deploy.sh` already builds each new commit in a
clean clone. It also runs `npm ci --omit=dev` in `service/`, copies
`service/` to
`~/containers/volumes/fleeting-service/releases/<sha>`, swaps the
`current` symlink, and restarts the unit only when `service/` changed.
After the restart it checks `GET /fleeting-api/health` through Caddy. If
the check fails, it swaps the symlink back and restarts again.

No step opens a port beyond the tailnet. The existing `svc:fleeting`
handler serves the new path.

## Storage

The data is a few JSON files in the data directory. Each write goes to a
temporary file, then `rename` replaces the old file. One process owns the
files, and an in-process lock serializes each read-modify-write. Size on
2026-11-05: the For You caps (200 digests, 2000 verdicts) give a file of a
few hundred kilobytes.

- `devices.json`: device token hashes, User-Agent, last use.
- `foryou.json`: the shape that `foryou-store.js` keeps now:
  `{ lastRead, digests, verdicts }`.
- `accounts.json` (job 2): one entry for each fixed account.

SQLite was not chosen. `node:sqlite` is still marked as in development in
Node 24, and the data is small. JSON files can be read with `cat` and
backed up with `rsync`.

## Job 1: For You API

The service applies operations. The browser never uploads the whole
state, so two devices that write at the same time do not lose each
other's writes.

| Request | Effect |
|---|---|
| `GET /fleeting-api/foryou` | Returns `{ lastRead, digests, verdicts }`. |
| `POST /fleeting-api/foryou/digests` `{ at, picks }` | Appends the digest. Sets `lastRead` to the later of the stored value and `at`. |
| `POST /fleeting-api/foryou/verdicts` `{ key, rule, verdict, action }` | Same rule as `recordVerdict` now. Each call appends its action. |
| `POST /fleeting-api/foryou/import` `{ lastRead, digests, verdicts }` | Merges one device's local state. Digests: union by `at` and pick keys. Verdicts: the newer `at` wins, and the action lists join. `lastRead`: the later value. |

The caps stay as they are, and the service applies them.
`shownKeys` stays in the browser.

`foryou-store.js` keeps its interface. After the first successful call it
imports the local state once, then deletes the `foryouState` key.

If the service does not answer, the For You page shows an error with a
retry button. It does not fall back to browser storage, because two
stores would need a second merge.

## Job 2: account sessions

### Bluesky: the service is the only refresher

The browser's Bluesky client uses an `Agent` with a custom
`SessionManager`. `@atproto/api` 0.20 accepts one
(`new Agent(sessionManager)`, `dist/session-manager.d.ts`). The
browser-side session manager:

- holds the DID, the PDS URL and the current access token, in memory and
  in the accounts store,
- adds `Authorization: Bearer <access token>` to each request,
- on a 401 or `ExpiredToken`, calls
  `POST /fleeting-api/accounts/bluesky/<did>/access` with the access token
  that failed, then retries the request once.

The service, for that call:

1. If the stored access token is not the one that failed, it returns the
   stored one. Another device refreshed already.
2. Otherwise it calls `com.atproto.server.refreshSession` with the stored
   refresh token. One call at a time for each account.
3. It writes the new tokens to `accounts.json`, then answers.

Login: the browser sends the handle and the app password to
`POST /fleeting-api/accounts/bluesky`. The service calls
`com.atproto.server.createSession` and stores the session. It does not
store the app password.

The three rules in "Session death is proven, never announced" move to the
service:

- The service sets `authExpired` only when the PDS refuses a refresh with
  a 4xx other than 429. A network error, a 429 or a 5xx changes nothing.
- One refresher, so "the store has nothing newer" is always true when a
  refresh fails. Tab and device races are gone.
- A 401 on a request triggers at most one refresh a minute.

If the service fails after the PDS rotates the token but before the write,
the session is lost and the user must log in again. The window is the
length of one file write.

### Mastodon: the service stores the token

A Mastodon token does not rotate, so the race does not exist. The gain is
one login for all devices. After a Mastodon OAuth login in the browser,
the app sends the token to `POST /fleeting-api/accounts/mastodon`. The
service checks it with `verify_credentials` and stores it. The browser
keeps a copy in the accounts store, as now, because masto.js reads it
there. Mastodon requests still go straight from the browser to the
instance.

A revoked Mastodon token is proven the same way as a dead Bluesky
session. When a Mastodon request in the browser gets a 401, the app
reports it to `POST /fleeting-api/accounts/mastodon/check`. The service
calls `verify_credentials`, at most once a minute. It sets `authExpired`
only when the instance answers 401. A network error, a 429 or a 5xx
changes nothing. The service sets no timer for this check.

### Accounts store

On start, a paired device calls `GET /fleeting-api/accounts`. The
response has each fixed account's Mastodon token, or Bluesky DID, PDS
and access token, and its `authExpired` flag. The app writes these into
the existing accounts store, so the rest of the app does not change.

### Logged out

The user does not log out on purpose. The user decided this on
2026-11-05. So the case to design for is a session that the network
ends: a Bluesky refresh that the PDS refuses, or a revoked Mastodon
token.

- The service sets `authExpired` on the account. Every device reads the
  flag from `GET /fleeting-api/accounts` and shows "Log back in".
- A login on any one device replaces the account on the service. The
  other devices get the new session on their next call. No device logs
  in twice.
- The Accounts sheet keeps its log-out action. It deletes the account
  from the service, so every device is logged out. There is no
  per-device log-out.

### Options not chosen

- **Full proxy.** The service makes every Mastodon and Bluesky request,
  and the browser never sees a token. This adds media uploads, the
  Mastodon streaming WebSocket and every API call to the service, and
  changes every masto.js and `@atproto/api` client in the app. The
  refresh-token race needs only a single refresher.
- **Bluesky OAuth with the service as a confidential client.** The
  Bluesky authorization server fetches the client metadata from the
  public internet, and the service is tailnet only (see
  `2026-10-21-single-user-tailnet.md`).

## What job 1 does so that job 2 is not blocked

- Authentication is a passkey, not tailnet membership.
- The cookie is per device and revocable. Job 2 needs this before the
  service holds credentials.
- The data directory is mode 600 from the start.
- The service applies operations under a lock. Job 2's single refresher
  uses the same lock.
- The For You state has no account key. It belongs to the user, so the
  Bluesky DID or Mastodon token can change and the state stays.
- The path is same origin. Job 2 adds endpoints, not routing.

## Prior art considered

- **Mastodon markers** (`/api/v1/markers`) sync last read across devices,
  but only as one post ID per timeline. They cannot hold the shown posts
  or the verdicts.
- **Records in the user's Bluesky repository.** Repository records are
  public, and the verdicts must not be.
- **A sync database** (CouchDB and PouchDB). A second database server
  and a client library for three small documents.

## Verification

- Unit tests: the import merge, the digest and verdict operations, the
  caps, the setup code (one use, expiry), and job 2's refresh decision.
- A Playwright spec with the Chromium virtual authenticator: setup code,
  registration, pairing a second browser context, a write on one context
  and a read on the other.
- On deepthought: `curl` from another tailnet device without a cookie
  gets 401. A cross-site POST gets 403. The For You state is the same on
  the iPhone and the laptop.
- Job 2: two devices with an expired access token at the same time cause
  one `refreshSession` call (service log).

## Out of scope

- A service that collects posts all day.
- Any route outside the tailnet.
- Multiple users.
- Backups of the data directory. The USB backup target on deepthought is
  not set up yet (`~/CONTAINERS.md`, Storage).
