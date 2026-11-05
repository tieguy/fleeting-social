# fleeting-social — developer notes

Last verified: 2026-10-21

fleeting-social is a fork of [Phanpy](https://github.com/cheeaun/phanpy) (a Mastodon web client) that adds native Bluesky (AT Protocol) support and interweaves the two networks. Most of the codebase is stock Phanpy; the fork-specific machinery lives under `src/utils/bluesky/` plus a handful of merge/filter helpers.

For the product goal and the user-facing feature list, see [`README.md`](README.md). This file is for how the Bluesky half is built.

## Bluesky support architecture

A small adapter layer (`src/utils/bluesky/`) wraps [`@atproto/api`](https://github.com/bluesky-social/atproto/tree/main/packages/api) and converts Bluesky posts/profiles/notifications into Mastodon-shaped objects, exposing a **masto.js-compatible facade**. The rest of the app doesn't know the difference — which is exactly why a Bluesky account can be merged in as an equal peer rather than living in a separate mode.

- `src/utils/bluesky/convert.js` — pure converters from AT Protocol shapes to Mastodon shapes (`postToStatus`, `profileToAccount`, `notificationToMasto`, `textToHTML`, etc.).
- `src/utils/bluesky/client.js` — the `masto`-compatible facade: `masto.v1.*` / `masto.v2.*` methods backed by an `@atproto/api` agent.
- `src/utils/bluesky/index.js` — account plumbing: `blueskyApi(account)`, `getOtherNetworkAccounts()`, `getBlueskyAccounts()`, `hasMultipleNetworks()`.
- `src/utils/bluesky/link-card.js` — outgoing **link cards**. Bluesky (unlike Mastodon) unfurls links client-side, so `createStatus` builds the `app.bsky.embed.external` embed itself: `linkFacetUris` lists the post's link facets, `buildExternalEmbed` unfurls one via Bluesky's hosted CardyB service (`cardyb.bsky.app`) and uploads the thumbnail blob. It's **best-effort** (any failure just posts without a card) and only fires when the post has no other embed — an external card can't coexist with images/quote in the same slot.
- `src/utils/bluesky/quote-link.js` — a pasted **bsky.app post URL becomes a native quote**, not a link card. `parseBskyPostUrl` / `firstQuotedPostLink` recognise the URL in the facets; `quoteEmbedFromLinks` in `client.js` resolves it to an AT-URI + CID and emits `app.bsky.embed.record`, which takes the embed slot before the link-card path sees it. This distinction is load-bearing: only a `record` embed increments the target's `quoteCount` and puts the post in its quote list, so a post URL sent as an external card is a quote that renders like one and that the network cannot see. Resolution is best-effort — an unresolvable URL falls through to the link card. The URL stays in the post text, matching the link-card path.
- `src/utils/api.js` — `api()` resolves the current account to either the Bluesky facade or a real Mastodon client. Passing `api({ account })` yields a per-account client, which is what the merge paths use.

`@atproto/api` is **lazy-loaded**, so Mastodon-only users don't pay the bundle cost.

### Session death is proven, never announced

Bluesky accounts log in with an app password only. AT Protocol OAuth is not supported: its authorization server fetches the client metadata document from the app's origin over the public internet, and the deployment is tailnet-only. The session is the app-password refresh JWT, kept in the accounts store in localStorage; `@atproto/api`'s `AtpAgent` refreshes it, and refresh tokens are single-use, so every refresh rotates it.

An account's `authExpired` flag hides it from every merged view and shows "Log back in" in the Accounts sheet, so a false positive is a visible logout while everything still works. A Bluesky account with no refresh JWT, such as one an earlier OAuth login stored, is treated the same way. The merged views test `isBlueskyLoggedIn` in `src/utils/bluesky/index.js`; the composer and the Accounts sheet test `isLoggedIn` in `src/utils/acting-accounts.js`, which mirrors it. Two rules keep it honest, both in `src/utils/bluesky/client.js`:

- **A failed refresh is terminal only if the store has nothing newer.** Another tab may have rotated the token already. The client sets `authExpired` only when the stored refresh JWT is missing or is the one that just failed. A `network-error` refresh changes nothing.
- **The client re-reads the store on every call.** It resumes from the stored session, not the one it was created with, and stays registered after a failure. A newer refresh JWT in the store (another tab's rotation, or a fresh login) revives it, and a successful refresh clears the flag (`persistSessionForAccount` in `index.js`). Rotations persisted by another tab are adopted through the `storage` event without a network call (`adoptSession`).

The facade deliberately over-loads some Mastodon concepts. `v1.statuses.$select(id).quotes.list()` — Mastodon's own quotes endpoint, API v7+ — is backed by `app.bsky.feed.getQuotes` and, like masto.js, yields **statuses** rather than accounts (unlike the sibling `favouritedBy` / `rebloggedBy` listings). `v1.lists.list()` returns not only the user's Bluesky lists but also their subscribed **feed generators**, shaped as lists and tagged `_feed`. Per-list metadata and timeline calls branch on the AT-URI collection (`app.bsky.feed.generator` → `getFeedGenerator`/`getFeed`; `app.bsky.graph.list` → `getList`/`getListFeed`). Consumers must treat `_feed` entries as read-only — no edit / manage-members — see `src/pages/lists.jsx` and `src/pages/list.jsx`.

### Publishing and threading

**Single publish path:** `src/utils/publish.js` — `publishThread({ account, segments, shared, ... })` is the unified entry point for posts, replies, threads, and cross-posts (it absorbed and replaced the old `bluesky/cross-post.js`). A single-segment thread is a post; multi-segment is a thread. `canCrossPost({ poll, scheduledAt, visibility })` is the sole eligibility predicate (no polls, no scheduling, no visibility beyond public/unlisted). Cross-post targets re-upload media from `mediaAttachments.fileData`; the primary post's own media is already uploaded by the composer, but segments 2+ of a primary thread also re-upload via `resolveMediaIds`.

**Atomic Bluesky threads:** the facade's `masto.v1.statuses.createThread(paramsList)` (`src/utils/bluesky/client.js`) commits a whole thread in one `applyWrites` — all-or-nothing, so failure needs no resume bookkeeping (zero statuses, `failedAtIndex` = `startAt`). It builds each post's URI/CID client-side via `src/utils/bluesky/thread-writes.js` (`prepareForHashing`, `computeCid`, `nextTid`, `buildThreadWrites`; lazy-loaded) so later posts can reference earlier ones before the server replies. Silent-failure gotchas: `$type` must be set before hashing and undefined properties stripped, or the computed CID diverges from the server's; `nextTid()` chains from the previous TID so ordering holds **even for same-millisecond calls**; and `createdAt` advances +1ms per post because identical timestamps give undefined feed ordering (atproto issue #3027).

**Sequential Mastodon chains:** each segment posts as a reply to the previous, with per-segment idempotency keys (`prefix`, `prefix-1`, …) that stay index-stable across retries. On partial failure `publishThread` returns `{ statuses, failedAtIndex, error, skippedMedia }`; `compose.jsx` records the posted statuses in `threadPublishState`, locks them in the UI, and offers "Retry remaining", resuming via the `startAt` / `resumeInReplyToId` **inputs**. It also deletes the on-disk draft at that moment — the draft has no record of which segments posted, so restoring it after a reload would republish the thread from zero.

**Contract detail — do not revert:** `visibility` and `sensitiveMedia` are read from React state in `compose.jsx`, never from FormData. Their controls are `disabled` while retrying a partially-posted thread, and disabled controls drop out of FormData, which silently changed the remaining segments' visibility mid-thread. `src/utils/compose-counting.js` holds the pure counting/validation helpers (`countableText`, `segmentCharCount`, `shouldEnforceCharLimit`, `getSegmentCharCount`, `validateSegments`); `compose.jsx` calls `shouldEnforceCharLimit` to decide whether client-side limits apply at all — single posts within the primary instance's own limit deliberately let the backend validate.

### Interweaving (merged timeline + notifications)

The "one home" experience is a chronological k-way merge across the current account plus every logged-in account on the *other* network, gated on the `settings.mergedTimeline` setting (default on).

- `src/utils/merged-timeline.js` — `createMergedTimelineIterator(sources)` merges multiple paginators by `createdAt`, stamping each item with `_instance`.
- `src/pages/following.jsx` — merged **home timeline**; the `states.reloadFollowing` counter is a bump-to-refetch signal (consumed as its `refresh` prop) that forces a reload, e.g. after the main-character mute in `src/components/main-character-banner.jsx`.
- `src/pages/notifications.jsx` — merged **notifications** page.
- `src/pages/home.jsx` (`NotificationsMenu`) — the bell-dropdown, which uses the same merge.

**Notification filtering.** `settings.notificationsResponsesOnly` (default on) trims notifications to "direct responses" — replies and mentions only. `src/utils/notification-filter.js`'s `isDirectResponse` (keeps the Mastodon-shaped `mention` type) is applied at all three surfaces: the page, the bell-dropdown, and the bell **badge** in `src/components/background-service.jsx` (which fetches a batch and filters, rather than reacting to the single latest notification). For this to distinguish quotes from replies, `notificationToMasto` maps a Bluesky `quote` reason to the native `quote` type (not `mention`). Caveat: the badge check is single-account (current account only), a pre-existing limitation.

When adding a feature that fetches per-account data, remember that the current account may be Bluesky *or* Mastodon, and that merged views fan out over both — thread per-account clients through `api({ account })` and label results with `_instance`. This fan-out already backs timelines, notifications, DMs, lists, and search.

The same routing rule applies to **per-profile actions** (follow / mute / block, and the relationship load that gates their UI): send them to a client on the *target profile's* network — detected via the converter's `info._bluesky` flag — not the currently-active account, which may be on the other network. See `src/components/related-actions.jsx`, which resolves an acting client by the profile's network rather than by instance-string matching. Correspondingly, the Bluesky facade's account actions return a *full* relationship object (they re-read the profile and apply the change), because callers replace their entire relationship state with the return value — a partial object would wipe the other flags.

**Mentions follow the same network rule.** A @-mention only links and notifies when posted from an account on the *mentioned profile's* network — a Bluesky handle is inert in a Mastodon post and vice-versa. `src/utils/mention-network.js`'s `getMentionInstance` picks an account on the target's network (or `null` if there is none), which the mention entry points (`related-actions.jsx`, `account-statuses.jsx`) pass into the composer as `draftStatus._instance`; `compose.jsx` posts from that instance. When it returns `null`, the mention affordance is hidden rather than producing a dead mention.

## Fixed accounts on the login page

A single-user build sets `FLEETING_ACCOUNTS` (comma-separated `network:identifier` pairs, for example `mastodon:luis_in_brief@social.coop,bluesky:lu.is`). `src/utils/fixed-accounts.js` parses it; malformed entries are dropped, so a typo in deploy configuration cannot break the page. When at least one entry parses, `src/pages/login.jsx` replaces the free-text server and handle fields with one entry per account: a Mastodon button that runs the normal OAuth flow for that instance, and a Bluesky app-password form whose handle field is read-only. The handle field is still submitted, so password managers can pair the saved app password with it. When the variable is unset, the login page is stock.

The conversations page and the For You lab show `src/components/fixed-accounts-banner.jsx` at the top when this device is not logged in to a fixed account, or when that account's Bluesky session has expired. `fixedAccountStates` in `fixed-accounts.js` compares the fixed accounts with the accounts store. Each listed account has a log-in control. The Mastodon control runs `startMastodonLogin` (`src/utils/mastodon-login.js`), the same OAuth start the login page uses, and sets `loginRedirect` so the callback opens the same page again. The Bluesky control opens `src/components/bluesky-login-form.jsx`, the login page's app-password form, in place. A revoked Mastodon token is not detected: any stored token counts as logged in.

## Engagement tab

`/engagement` (`src/pages/engagement.jsx`, registered in `shortcuts-settings.jsx` and `columns.jsx`) is a stateless 24-hour tally of likes and boosts on the user's posts. It fans out over the current account plus merged other-network accounts, requests `types: ['favourite', 'reblog']` from each source's v1 notifications, and computes the window from server timestamps on every open, so every device shows the same numbers.

`src/utils/engagement-tally.js` holds the pure parts:

- `walkUntilCutoff(iterator, { cutoff, pageCap })` pages back until an item predates the cutoff, the iterator ends, or `PAGE_CAP` (5 × 80) pages are read. It continues past empty pages: the Bluesky facade applies `types` after fetching, so a page can be empty with more pages to follow. Hitting the cap sets `capped`, and the summary line then reads "at least".
- `tallyEngagement(sources, { cutoff })` returns per-network totals and per-post rows keyed `${instance}/${statusId}`, looking through `status.reblog`. A Bluesky notification whose subject post failed to hydrate has a null `status`; it counts toward the network total but gets no row, so a total can exceed the sum of its rows.

Three invariants:

- **No engager identities.** The tab never renders the notification's `account`.
- **No responses-only filter.** `settings.notificationsResponsesOnly` does not apply here, and the notification page, bell dropdown and badge do not change.
- **Counts are what each server knows.** A Mastodon instance sees only the likes and boosts that federated to it, so both the tally and the lifetime totals can be lower than the fediverse-wide numbers.

## Quote without attribution

A quote action in both boost/quote menus (action bar and kebab, `src/components/status.jsx`), alongside the instance's native quote or link-quote item, shares a post's text as a PNG card with the author redacted, attached to a new post with alt text prefilled. Four modules under `src/utils/`:

- `post-card-model.js` (pure) — `buildCardModel(status)` turns a Mastodon-shaped status (Bluesky posts already arrive in this shape) into card content: content warning, plain-text paragraphs via `getHTMLText`, an omitted-content note (`[2 images not shown]`, `[poll not shown]`, `[quoted post not shown]`, `[link preview not shown]`), and alt text capped at the composer's 1500-char `descriptionLimit`. Its test runs under `// @vitest-environment happy-dom` because `getHTMLText` needs a DOM.
- `post-card-layout.js` (pure) — `layoutCard(model, measureText, opts)` wraps the content into positioned lines (word wrap, hard break for over-wide tokens, paragraph gaps, a line cap with a trailing `[…]` line). The header stands in for the author: a mask glyph (`AVATAR_GLYPH`) in the avatar circle, `HEADER_NAME` ("Anonymized post") where the display name goes, and `HEADER_HANDLE` ("Quoted without attribution to avoid pile-ons") where the handle goes. The measurer is injected so the layout is unit-tested in Node.
- `post-card-render.js` (browser only, lazy-imported) — `renderCardBlob(status, opts)` draws the layout on a Canvas 2D surface at the device pixel ratio, floored at 2x, and resolves `{ blob, altText, truncated }`. The palette follows the app theme (`is-dark` / `is-light` on `<html>`, else the system preference); `opts.theme` overrides it. When `truncated` is set, the menu handler in `status.jsx` shows a toast after opening the composer. The card is `DEFAULT_WIDTH` (600px) wide; a caller-supplied `opts.width` is floored at `MIN_WIDTH` (240px).
- `post-card-attachment.js` — `blobToAttachment(blob, altText)` wraps that blob in the composer's attachment shape. The composer's existing `draftStatus` restore path attaches it.

Two invariants, both load-bearing:

- **No remote resources.** The avatar is a gray circle with a locally drawn emoji glyph, the name and handle are fixed explanatory text, post media is omitted, and custom emoji stay as `:shortcode:` text, so the canvas never loads a cross-origin image and never taints; `toBlob` keeps working and the strict CSP needs no allowance. A DOM screenshot (html2canvas and kin) fails on both counts, cross-origin images and the CSP, and is not used.
- **No original-post identifiers.** Nothing derived from the original's URL, ID, handle, display name, avatar, or timestamp is drawn or attached, so the new post cannot be traced through the network and does not notify the author. @-mentions inside the body are kept verbatim by decision.

On a post the user cannot boost (`!canBoost`), the action is unreachable on both surfaces. This is a code reading on 2026-09-10, not a browser observation. In the action bar, the rocket `StatusButton` is the menu trigger and carries `disabled={!canBoost}`, so the menu does not open. In the kebab, the Boost entry is a `SubMenu` that receives the same `disabled` prop, so its submenu does not open.

## Conversation mode

Outside fixed daily windows, the app shows only conversations: threads with
a reply or mention to the user. The design plan is
`docs/design-plans/2026-10-21-conversation-mode.md`.

- **Schedule.** `src/utils/conversation-schedule.js` holds
  `FULL_APP_WINDOWS` (weekday and weekend lists of `[startMinute,
  endMinute)` in device local time), `isFullAppOpen(date)` and
  `nextChange(date)`. The schedule is a constant by decision, so nothing in
  the app can switch it off. A change is a code change and a deploy.
- **Guard.** `src/utils/useConversationMode.js` sets one timer for the next
  window edge and re-checks when the page becomes visible. In conversation
  mode, `App` in `src/app.jsx` renders `ConversationRoutes` instead of the
  normal route trees and chrome: the list, a thread, `/notifications`,
  login, welcome, and the For You lab (`/_foryou-lab`, an experiment
  reached only by typing its URL). Every other path redirects to
  `/conversations`.
  Entry into the mode waits until the composer closes, then
  `hideAllModals()` closes any sheet left open.
- **List.** `src/pages/conversations.jsx` walks `types: ['mention']`
  notifications from every merged source for one day, plus one more day
  per tap of "Show one more day", and
  `groupConversations` in `src/utils/conversation-group.js` makes one row per
  thread. Bluesky rows group by `_threadRootId`, which the converter sets
  from `record.reply.root`. Mastodon rows group by following `inReplyToId`
  through the batch, so one thread can show as two rows. Mastodon private
  mentions are dropped, and so are responses from muted or blocked
  Bluesky authors (`isHiddenAuthor`), because the facade passes them on.
  `statusExtras` lists what a text-only row leaves out (media, quoted
  post, link preview, poll). The header's "New post" button opens the
  full composer, threads included.
- **Thread.** `src/pages/conversation-thread.jsx` fetches the context of
  the post and of the thread root, and `threadRows` in
  `src/utils/conversation-tree.js` nests the replies (indent capped at
  three levels, long side branches collapsed to a "# more replies" row).
  Each post is a `Status` in `readOnly` and `previewMode`, with the page's
  own reply, quote, like and share-link buttons. Quote follows
  `getQuotePolicy` in `src/utils/quote-utils.js`, which the full app's
  quote menu in `status.jsx` also uses. After a post, the composer's toast
  opens the conversation thread (`Modals` gets `conversationMode`). `src/components/inert-links.jsx` stops every
  click inside an `<a>` in the capture phase. Only a web link in the post
  text (`.content`, not `.mention`) or a link-preview `a.card` opens, in a
  new tab.
- **Push notices.** `NotificationService` is not rendered in conversation
  mode. `src/components/conversation-notification-router.jsx` maps a tapped
  notice, from either the `/notifications?id=` URL or the service worker's
  message, to the thread of its post.

Dev builds show the full app at any time, so that local work and the
Playwright specs do not depend on the clock. Set localStorage
`conversationModeOverride` to `on` to force conversation mode, or to
`schedule` to follow the windows. Production builds ignore the key.
`tests/conversation-mode.spec.js` covers the redirects, the missing chrome
and the inert thread links.

Three invariants, all load-bearing:

- **The schedule is not a setting.** No UI changes it.
- **No path out.** In conversation mode, nothing rendered navigates to a
  route outside the conversation tree, and every other route redirects.
  The For You lab is the one exception, by decision, while its ranking
  rules are being chosen.
- **No draft loss.** The guard never switches modes while the composer is
  open.

## Build: console calls are stripped

`vite-plugin-remove-console` deletes every `console.*` call from production
builds. An arrow function whose whole body is one console call, such as
`.forEach((r) => console.error(r))`, is left with an empty body, and the
build fails with a parse error. Give such a function a block body, or use a
loop.

## UI strings

Every user-visible string goes through the lingui macros (`<Trans>` and the `t`
template tag), which compile to a lookup keyed by a **hash of the source
string**. The app is English-only; `src/locales/en.po` is the one catalog,
loaded in `src/utils/lang.js`.

The production build strips the source text from the compiled lookup, so a
string that is not in `en.po` renders as its raw hash — the user sees
`0D0OPY` where the sentence should be. **After adding or editing any macro
string, run `npm run extract` and commit `src/locales/en.po`.** Extraction also
rewrites the `#:` line references throughout the file; `npm run git:po-filter`
configures a textconv that hides that churn in diffs.

## Service worker: stale app shell recovery

`public/sw.js` is otherwise upstream Phanpy's file verbatim; the one fork
addition is a recovery path for a cached app shell that outlived its bundles.
The failure it removes: `pageCache()` is NetworkFirst, so a slow navigation is
answered from the `pages` cache; the host serves only the newest deploy, so a
hashed bundle named by an older cached `index.html` 404s as `text/html`; and a
browser silently refuses to run a `type="module"` script with that content
type. The page goes blank and cannot repair itself, because its own scripts are
what failed to load — and the strict CSP rules out an inline bootstrap script.

So the repair lives in the worker. `StaleShellRecoveryPlugin` on the assets
route calls into `src/utils/sw-shell-recovery.js`, which deletes the `pages`
cache and reloads the window clients via `client.navigate()`.

Three invariants, all load-bearing:

- **Only a 404/410 triggers a repair, never a network error.** Offline is the
  case the cache exists to serve; repairing on any failed request would delete
  the app shell every time the user loses signal.
- **Only a cache *miss* triggers a repair.** StaleWhileRevalidate reaches the
  network twice over — to fill a miss, and to revalidate a hit in the
  background. A 404 on the revalidation of a bundle still held locally is
  expected once its deploy is gone, and the page is running fine off that
  cached copy; reloading there would interrupt for nothing and discard an
  in-progress compose draft. This case gets commoner as `maxHashes` rises.
- **A repair timestamp is persisted in the Cache API**, not in memory. A worker
  has no localStorage and can be terminated between events, and a repair
  triggers a reload — so without a durable cooldown a repair that does not fix
  the page would reload forever.

Unit tests cover the decision logic, but the failure itself lives in service
worker state, so it is verified in a browser instead:
`node scripts/verify-sw-recovery.mjs` against a production build drives the real
worker through the whole sequence. Run it after changing either file.

`maxHashes` on the `assets` cache and that cache's `maxEntries` move together:
a build emits ~24 hashed JS and CSS files, so an entry cap below roughly
`maxHashes × 24` lets LRU eviction discard old hashes before `AssetHashPlugin`
counts them, and `maxHashes` stops meaning anything.

## Deployment

Fleeting is single-user and served only on the operator's tailnet, from `deepthought`, at `https://fleeting.peafowl-polaris.ts.net`. The files are in `deploy/`; on the host they are installed as plain copies (`~/.local/bin/fleeting-deploy`, `~/.config/containers/systemd/fleeting.container`, `~/.config/systemd/user/fleeting-deploy.{service,timer}`, `~/containers/volumes/fleeting/Caddyfile`), so a change to one of them is copied over by hand.

- **Serving.** A Caddy Quadlet serves `~/containers/volumes/fleeting/site/current` on `127.0.0.1:8085`, and `tailscale serve --service=svc:fleeting` terminates TLS in front of it. Missing files get a plain 404, which the service worker's stale-shell recovery relies on.
- **Deploys are pulls.** `fleeting-deploy.timer` runs every 10 minutes. The script compares the head of `main` on GitHub with `site/deployed-sha` and does nothing if they match. Otherwise it builds that commit in a clean clone, copies `dist/` to `site/releases/<sha>`, and swaps the `current` symlink; it keeps the newest three releases. A failed build leaves the running release in place. `systemctl --user start fleeting-deploy.service` deploys immediately.
- **Build settings** (`FLEETING_ACCOUNTS`, `FLEETING_WEBSITE`, `FLEETING_DISALLOW_ROBOTS`) are `Environment=` lines in `fleeting-deploy.service`.
- **Headers.** The CSP and security headers are computed in `vite.config.js` and written to the Netlify-style `dist/_headers`. The deploy script converts that file into the Caddy snippet `site/headers.caddy`, and restarts Caddy only when the snippet changes.

## Naming

The project was renamed from `phanpy-plus` to `fleeting-social`. As of this rename the change is **README + docs only** — `package.json`, the git repo/remote, deploy config, and in-code strings still say `phanpy`/`phanpy-plus` and are a separate pass.
