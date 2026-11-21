# Boost/Quote Menu on Every Screen — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The For You digest's boost button opens the same boost/quote menu as the timeline (boost, boost-as, native quote, link quote, quote-without-attribution), a quote — like a new post — can be shared with every checked account on both networks (native quote where the target can, link-quote elsewhere), quotes count as "interesting" verdicts, and the conversation thread's link-quote targets every account like the timeline's does.

**Architecture:** The boost/quote `MenuConfirm` currently exists twice as inline JSX inside `Status` (`src/components/status.jsx`), and the For You digest (`DigestActions` in `src/pages/foryou.jsx`) bypasses it entirely with an immediate `reblog()` call. Extract the menu — items plus all its handlers — into one reusable component `BoostQuoteMenu` (`src/components/boost-quote-menu.jsx`) that resolves its own status and client from `statusID` + `instance`, exactly as `Status` does. `Status`'s two copies and the digest's rocket button all render it. The composer stops excluding quotes from targetable posts: `composeTargetable` drops its `!quoteStatus` term, and the existing cross-target publish loop gains a per-target quote rule — native `quoted_status_id` on targets that can natively quote the post, the post's URL appended to the text on the others. Quote verdicts thread a `_quoteContext` marker from the menu items through `showCompose` → `Modals` → `states.lastPosted`, which the For You watcher already subscribes to.

**Tech Stack:** Preact + valtio + @szhsin/react-menu (existing); lingui macros for strings; Playwright (`tests/*.spec.js`) for browser tests — the repo's `npm test`; vitest for pure units (no new pure logic in this plan).

**Spec:**
- Lific issue **FLEET-8** — "For You: the boost button boosts at once and skips the boost/quote menu". Its Expected section, verbatim: *"the digest's boost button opens the same boost/quote menu as the timeline's action bar. A boost or a quote made from that menu still counts as an 'interesting' verdict for the rule that picked the post."* Its agent notes direct: reuse or extract the menu in `src/components/status.jsx`, do not copy it.
- Operator review feedback (2026-11-20), superseding the sentence below: **a quote should, like a new post, offer sharing it with both networks.** The account-agnostic-actions design's "Replies, quotes, and edits keep today's single-network behavior" no longer holds for quotes; replies and edits still do.
- `docs/design-plans/2026-08-31-account-agnostic-actions.md` — Phase 4 ("Boost as any account"): the boost menu gains "Boost as @…" rows from `eligibleAccounts`, executed via `api({ account })` with cross-instance resolution. Its same-network rule still governs boost and favourite.
- `docs/design-plans/2026-09-10-no-dunk-quote.md` — the "Quote without attribution" menu item (redacted PNG card → composer attachment).
- `CLAUDE.md` sections "For You" (verdicts), "Publishing and threading", "Quote without attribution", "Conversation mode" — update where this plan changes behavior.

## Global Constraints

- Network routing by action: **boost, favourite and reply stay same-network** (a Mastodon account never boosts or favourites a Bluesky post and vice versa; replies post through the replied post's instance). **Quotes fan out like a new post**: every checked account gets one — a native quote (`quoted_status_id` → record embed / Mastodon quote) on targets that can natively quote the post, and the quoted post's URL appended to the text on every other target. Link quotes and no-attribution quotes remain ordinary fresh posts with no `_instance` stamp.
- Per-target quote rule, implemented once in the composer's cross-target loop: a Bluesky quote is native on every Bluesky account (ids are network-global) and a link everywhere else; a Mastodon (API v7) quote is native on accounts whose `instanceURL` equals the quoted post's instance, and a link everywhere else — cross-instance Mastodon native quoting needs search resolution and is deliberately out of scope (those targets get the link).
- Every user-visible string goes through lingui macros (`t`, `Trans`, `msg`). After moving or adding macro strings, run `npm run extract` and commit `src/locales/en.po` (production builds render raw hashes for missing entries).
- The build strips `console.*`; never leave a console call as an arrow function's whole body.
- Commit straight to `main`; fetch and fast-forward first. The repo is not on SonarQube — the executor offers onboarding once before the first commit, per the machine instructions.
- Browser tests run with `npx playwright test tests/<file>.spec.js`; the whole suite is `npm test`. Unit tests are `npm run test:unit`.
- This plan adds no new UI strings except by moving existing ones (Task 1).

## Review Focus

The five input classes most likely to bite, each pinned by a test in the owning task:

1. **A Bluesky post in the digest** must offer the *native* quote item (never "Quote with link"), and its composer must target both accounts — native embed on Bluesky, URL link-quote on Mastodon. Pinned by Task 2 test T4 (menu) and Task 3 test QA (fan-out bodies).
2. **A post whose author disallows quotes** (Bluesky `viewer.embeddingDisabled`) shows a disabled Quote item instead of a dead one. Pinned by Task 2, test T4b.
3. **"Boost as" across Mastodon instances** must resolve the status on the acting account's server (v2 search) before reblogging; only the boost stays same-network after this plan. Pinned by Task 2, test T5.
4. **A link quote** (which has no `quoteStatus` in the composer) still records a For You verdict — this is why the `_quoteContext` marker exists rather than relying on `type: 'quote'`. Pinned by Task 4's test.
5. **The timeline's own menus after the extraction** — action-bar rocket and the long-press/"kebab" context menu must still open with the same items. Pinned by Task 1's two regression tests.

---

### Task 1: Extract `BoostQuoteMenu` from `status.jsx` (behavior-preserving)

**Files:**
- Create: `src/components/boost-quote-menu.jsx`
- Create: `tests/boost-quote-menu.spec.js`
- Modify: `src/components/status.jsx` (move `quoteMessages` out; replace two inline `MenuConfirm` blocks)
- Modify: `src/utils/quote-utils.js` (receive `quoteMessages`)
- Modify: `src/pages/conversation-thread.jsx:12` (import `quoteMessages` from `../utils/quote-utils`)
- Modify: `src/locales/en.po` (via `npm run extract`)

**Interfaces:**
- Produces: `export default function BoostQuoteMenu({ statusID, instance, subMenu = false, showBoostAs = true, children })` in `src/components/boost-quote-menu.jsx`. `children` is the trigger: the menu button when `!subMenu`, the submenu label when `subMenu`. `showBoostAs={false}` omits the "Boost as @…" items (the action-bar variant, where they live in the overflow menu instead).
- Produces: `export const quoteMessages` moves from `src/components/status.jsx:302-308` to `src/utils/quote-utils.js`. `status.jsx` drops its export and imports it; `conversation-thread.jsx` changes its import path. (The move avoids a circular import `status.jsx ↔ boost-quote-menu.jsx`.)

- [ ] **Step 1: Write the regression spec `tests/boost-quote-menu.spec.js`**

Two tests on the mock home timeline, pinning *current* behavior so the refactor cannot regress it. Copy the seeding pattern from `tests/keyboard-shortcuts.spec.js` (the logged-in `test.social` account init script and the `**/api/v2/instance` / `**/api/v1/instance` routes, lines 91-135) and navigate to `/#/_mock/home`, waiting for `.timeline-item`:

```js
test('action-bar rocket opens the boost/quote menu', async ({ page }) => {
  await setupLoggedInEnv(page); // copied from keyboard-shortcuts.spec.js
  await setupMockHomeEnv(page);
  const first = page.locator('.timeline-item').first();
  await first.hover(); // reveal the hover-only action bar
  await first.locator('.reblog-button').click();
  // test.social serves no API versions → not a native-quote instance
  await expect(page.getByRole('menuitem', { name: 'Boost' })).toBeVisible();
  await expect(
    page.getByRole('menuitem', { name: 'Quote with link' }),
  ).toBeVisible();
  await expect(
    page.getByRole('menuitem', { name: 'Quote without attribution' }),
  ).toBeVisible();
  await page.getByRole('menuitem', { name: 'Quote with link' }).click();
  await expect(page.locator('#compose-container')).toBeVisible();
  await expect(page.locator('#compose-container textarea')).toHaveValue(
    /test\.social\/@testuser\/\d+/,
  );
});

test('context menu offers the same boost/quote submenu', async ({ page }) => {
  // same setup
  await page.locator('.status').first().click({ button: 'right' });
  // Non-native instance, no reblogs/quotes → the submenu entry reads "Boost…"
  await page.getByText('Boost…').click();
  await expect(
    page.getByRole('menuitem', { name: 'Quote with link' }),
  ).toBeVisible();
});
```

If the context-menu trigger differs (check the long-press/`onContextMenu` wiring near `src/components/status.jsx:2329`), drive it the way that code expects; the assertion to keep is that the submenu opens with the quote items.

- [ ] **Step 2: Run the spec, verify it PASSES**

Run: `npx playwright test tests/boost-quote-menu.spec.js`
Expected: PASS. This is a characterization test: it pins existing behavior and must stay green through Steps 3-5.

- [ ] **Step 3: Move `quoteMessages`, then extract the component**

Move `quoteMessages` (status.jsx:302-308) to `src/utils/quote-utils.js` with `import { msg } from '@lingui/core/macro';` and update both importers.

Create `src/components/boost-quote-menu.jsx`. The component owns everything the two inline `MenuConfirm` blocks use, re-derived from `statusID` + `instance` the same way `Status` does it (client and gating at status.jsx:414-421: `api({ instance })`, `sameInstance = instance === currentInstance || (authenticated && hasAccountInInstance(instance))`; status from `useSnapshot(states)` via `statusKey(statusID, instance)`):

- `canBoost` (812-816), `quoteDisabled`/`quoteText`/`quoteMetaText`/`canQuote` (818-836, via `supportsNativeQuote` + `getQuotePolicy` + `quoteMessages`), `quotesCount`
- `composeStatus()` (843-844) stamping `_instance`
- `confirmBoostStatus` (915-941): the `!sameInstance || !authenticated` alert, optimistic `states.statuses[sKey]` flip, `reblog()`/`unreblog()` + `saveStatus`
- `boostAsAccounts` (946-950), `resolveStatusAs` (956-974), `boostStatusAs` (976-988)
- `quoteWithoutAttribution` with its `renderingCard` state (750-782)
- `menuFooter` (1201-1217) with `mediaNoDesc` (865-869) and `statusMonthsAgo` (871-875)

Render (mirroring the existing blocks, menu items at 1334-1397):

```jsx
<MenuConfirm
  subMenu={subMenu}
  disabled={!canBoost}
  className={subMenu ? `menu-reblog ${reblogged ? 'checked' : ''}` : undefined}
  confirmLabel={…}   // rocket icon + `Unboost`/`Boost` + reblog count when > 0
  menuExtras={…}     // native quote item; Quote with link; Quote without attribution;
                     //   boost-as items when showBoostAs
  menuFooter={menuFooter}
  onClick={…}        // confirmBoostStatus() then toast `Boosted @…'s post` / `Unboosted …`
>
  {children}
</MenuConfirm>
```

Two deliberate unifications, both noted here so a reviewer can judge them: the confirm label always shows the reblog count (today only the action-bar copy does), and a confirmed plain boost always toasts (today only the menu copy does). Everything else renders exactly as today.

- [ ] **Step 4: Replace the two copies in `status.jsx`**

- StatusMenuItems' `MenuConfirm subMenu` (1323-1435) → `<BoostQuoteMenu subMenu statusID={id} instance={instance}>{…existing label JSX, 1416-1434…}</BoostQuoteMenu>`
- The action bar's `MenuConfirm` (3215-3312) → `<BoostQuoteMenu showBoostAs={false} statusID={id} instance={instance}><StatusButton …existing props, 3294-3311…/></BoostQuoteMenu>`

Delete only what these two blocks uniquely used (`confirmBoostStatus`, `boostAsAccounts`, `resolveStatusAs`, `boostStatusAs`, `quoteWithoutAttribution`, `renderingCard`, `composeStatus`). **Leave in place** everything the rest of `Status` still uses: `favouriteStatusAs`, `replyStatusAs`, `replyStatus`, the `q` hotkey path (2075-2098), and the edit path's `composeStatus(status.quote?.quotedStatus)` usage (1815-1828) — if those still need `composeStatus`, keep it in `Status` too and let the new component have its own.

- [ ] **Step 5: Verify green, extract strings, commit**

Run: `npx playwright test tests/boost-quote-menu.spec.js && npm run extract && npm test && npm run test:unit && npm run formatting`
Expected: spec PASS; `en.po` gains only reference-line churn for the moved strings; full suites green.

```bash
git add src/components/boost-quote-menu.jsx src/components/status.jsx \
  src/utils/quote-utils.js src/pages/conversation-thread.jsx \
  src/locales/en.po tests/boost-quote-menu.spec.js
git commit -m "Refactor: extract the boost/quote menu into BoostQuoteMenu, shared by status and (next) the For You digest"
```

### Task 2: The For You digest rocket opens the menu (FLEET-8)

**Files:**
- Modify: `src/pages/foryou.jsx` (`DigestActions`, 95-161)
- Modify: `tests/foryou-fixtures.js` (reblog route; Bluesky and second-Mastodon account helpers)
- Modify: `tests/foryou.spec.js` (five new tests)
- Modify: `CLAUDE.md` ("For You" → Verdicts bullet, ~line 125-131)

**Interfaces:**
- Consumes: `BoostQuoteMenu` (Task 1).
- `DigestActions` keeps its reply, like and "Not for me" buttons and the `masto` prop (the like button still uses it). Only the rocket changes: it becomes `BoostQuoteMenu`'s trigger child — same markup (`class="plain ${reblogged ? 'boosted' : ''}"`, rocket icon, count) minus its own `onClick`/`disabled`/`busy` logic; menu gating comes from `canBoost` inside the component.

- [ ] **Step 1: Write the five failing tests in `tests/foryou.spec.js`**

Fixture additions first (`tests/foryou-fixtures.js`):

- In `stubMastodon`, add the reblog route (and a counter export the tests can read):

```js
let reblogCalls = 0; // reset in stubMastodon
const boost = path.match(/^\/api\/v1\/statuses\/(\d+)\/reblog$/);
if (boost) {
  reblogCalls++;
  const post = HOME.find((s) => s.id === boost[1]);
  return route.fulfill({ json: { ...post, reblogged: true, reblogs_count: 2 } });
}
```

- `export const BSKY_ACCOUNT` plus the `fakeJwt`/`CID` helpers, copied from `tests/cross-account-interactions.spec.js:39-75`; a `seedWithBsky(page)` (accounts `[ACCOUNT, BSKY_ACCOUNT]`) and `stubBluesky(page, feed)` that routes `https://bsky.social/xrpc/com.atproto.server.getSession`, `…refreshSession` and `app.bsky.feed.getTimeline*` (copy the route shapes from cross-account-interactions.spec.js:198-236). `stubBluesky(page, [])` answers `{ feed: [] }`.
- `export const ACCOUNT_B` (second Mastodon account, `instance-b.test`) also copied from cross-account-interactions.spec.js:26-37.

The tests:

- **T1 — the rocket opens the menu, not an instant boost:** seed, digest, click the first digest item's rocket — `.foryou-posts > li >> nth=0` → the `.foryou-actions` button with accessible name `Boost`. Expect menuitems `Boost`, `Quote with link`, `Quote without attribution` visible. Then assert `reblogCalls === 0` and `service.state.verdicts` is empty — the old behavior boosts on the first click, so this fails today.
- **T2 — confirming Boost boosts and counts:** click the menuitem `Boost`; expect `reblogCalls === 1` and the verdict `{ verdict: 'interesting', actions: ['boost'] }` in `service.state.verdicts` (same poll pattern as the existing like test, foryou.spec.js:98-114). The existing `states.statuses` watcher already counts the optimistic flip — no page change needed for this half.
- **T3 — Quote with link targets every account:** `seedWithBsky` + `stubBluesky(page, [])`; digest renders the three Mastodon posts; rocket → `Quote with link` → `#compose-container` visible, `.cross-post-toolbar .account-picker-option` has count 2 and both checkboxes are checked (`input[type=checkbox]` both `:checked`).
- **T4 — a Bluesky digest post offers the native quote:** `stubBluesky(page, [bskyFeedItem])` where the item is a top-level post with `viewer: { embeddingDisabled: false }`, high `likeCount` (≥ 40), `replyCount ≥ 1`, and `indexedAt` a few minutes ago (mirror the post shape in cross-account-interactions.spec.js:242-255; if the digest does not pick it, check `src/utils/foryou-lab.js`'s rules and raise the counts). The digest shows the Bluesky post; its rocket menu shows the native `Quote` item and **not** `Quote with link`; clicking `Quote` opens the composer. (The both-networks composer behavior is Task 3; this test only pins the menu.)
- **T4b — embeddingDisabled disables Quote:** same as T4 but `viewer: { embeddingDisabled: true }`; the `Quote` menuitem is disabled.
- **T5 — Boost as a second same-network account:** seed `[ACCOUNT_A, ACCOUNT_B]` (A current; both Mastodon; B's other routes may abort). Digest post from A; its menu shows `Boost as @bob@instance-b.test`; stub `https://instance-b.test/api/v2/search*` → `{ statuses: [{ …HOME[0], id: '1' }] }` and `https://instance-b.test/api/v1/statuses/1/reblog` → the boosted post; click the item; expect the toast `Boosted as @bob@instance-b.test`.

- [ ] **Step 2: Run them, verify they FAIL for the right reason**

Run: `npx playwright test tests/foryou.spec.js`
Expected: T1 fails on the missing menu (the click boosted instead); T2-T5 likewise fail on the missing menu.

- [ ] **Step 3: Implement in `DigestActions`**

Replace the rocket `<button>` (foryou.jsx:138-149) with:

```jsx
<BoostQuoteMenu statusID={statusID} instance={instance}>
  <button type="button" class={`plain ${reblogged ? 'boosted' : ''}`} aria-pressed={!!reblogged}>
    <Icon icon="rocket" alt={reblogged ? t`Unboost` : t`Boost`} />
    {reblogsCount > 0 && <span>{shortenNumber(reblogsCount)}</span>}
  </button>
</BoostQuoteMenu>
```

Import `BoostQuoteMenu` from `../components/boost-quote-menu`. The `toggle` helper stays for the like button only. Update the component's header comment (91-94): the rocket opens the timeline's boost/quote menu.

- [ ] **Step 4: Run the tests, verify PASS**

Run: `npx playwright test tests/foryou.spec.js`
Expected: all PASS, including the pre-existing three.

- [ ] **Step 5: Update `CLAUDE.md`, commit**

In "For You" → Verdicts, replace "The digest has its own reply, boost and like row because the timeline's action bar shows only on hover" with wording that says the digest row's boost button opens the shared `BoostQuoteMenu` (`src/components/boost-quote-menu.jsx`) while reply/like remain direct. In "Quote without attribution", the menu's home becomes the shared component rather than "both boost/quote menus … in status.jsx".

```bash
git add src/pages/foryou.jsx tests/foryou-fixtures.js tests/foryou.spec.js CLAUDE.md
git commit -m "For You: the digest boost button opens the shared boost/quote menu (FLEET-8)"
```

### Task 3: A quote targets every network, like a new post

The operator's review direction (2026-11-20): a QT should, like a new post, offer sharing with both networks. Today `composeTargetable = !editStatus && !replyToStatus && !quoteStatus` (compose.jsx:227) hides the account checkboxes for quotes and pins the post to the quoted status's instance.

**Files:**
- Modify: `src/components/compose.jsx` (`composeTargetable` 227; comment 224-226; cross-target loop 1770-1830)
- Modify: `tests/foryou-fixtures.js` (`seedWithTwoBsky`, xrpc write stubs)
- Modify: `tests/foryou.spec.js` (two new tests)
- Modify: `CLAUDE.md` ("Publishing and threading" — quotes join the cross-target loop)

**Interfaces:**
- Consumes: `buildCrossSegments` / `publishThread` / `canCrossPost` (`src/utils/publish.js`) unchanged; `isBlueskyAccount` (`src/utils/bluesky`); `currentQuoteStatus` (compose.jsx:314-325).
- Produces: no new exports. Behavioral contract: for every checked target, a quote publishes exactly one post — native (`shared.quotedStatusId`, and `quoteApprovalPolicy` where the primary path sets it today, compose.jsx:1648-1653) on targets that can natively quote, else the quoted post's URL appended to segment 0's text.

- [ ] **Step 1: Write the two failing tests in `tests/foryou.spec.js`**

Both ride Task 2's T4 setup (bsky digest post visible). Fixture additions: capture bodies — `stubBluesky` gains routes for `https://bsky.social/xrpc/com.atproto.repo.createRecord` and `…/com.atproto.repo.applyWrites`, each recording `route.request().postDataJSON()` into an exported array and answering `{ uri: at://did:plc:testcarol/app.bsky.feed.post/new1, cid: CID }` / `{ results: [{ uri, cid: CID }] }`; a `stubMastodonPost(page)` recording POST bodies at `https://instance-a.test/api/v1/statuses` (answering `{ ...HOME[0], id: 'new1' }`). Also `seedWithTwoBsky(page)`: a second Bluesky account `BSKY_ACCOUNT_2` (`did:plc:testdave`, `dave.bsky.social`, own `fakeJwt` pair — make `fakeJwt(scope, sub)` take the did) — the `getSession`/`refreshSession` stubs answer with the did parsed from the request's Authorization bearer so both sessions validate.

**QA — quoting a Bluesky post reaches both networks, each its own way** (`seedWithBsky`, T4's bsky post in the digest): rocket → native `Quote` menuitem → `#compose-container` visible; assert `.cross-post-toolbar .account-picker-option` count 2, both checked (fails today — no toolbar for quotes). Type `nice one`, click Post. Assert exactly one bsky write and one masto POST, and their bodies: the bsky record's `text` contains `nice one` and **not** the post URL, with `embed.$type === 'app.bsky.embed.record'`; the masto POST body's `status` contains `nice one` and the bsky post URL (`bsky.app` link), and has **no** `quoted_status_id`.

**QB — a second same-network account also gets the native quote** (`seedWithTwoBsky`): same flow; assert TWO bsky writes both carrying `app.bsky.embed.record`, plus the one masto POST with the URL.

- [ ] **Step 2: Run them, verify they FAIL**

Run: `npx playwright test tests/foryou.spec.js -g "quote"`
Expected: QA fails on the missing `.cross-post-toolbar` (quotes are not targetable today); QB likewise, or on the single-account roster.

- [ ] **Step 3: Implement in `compose.jsx`**

1. Line 227: `const composeTargetable = !editStatus && !replyToStatus;` — quotes join new posts as targetable. Update the comment at 224-226: replies/edits stay network-bound; quotes fan out (native where the target can, URL-append elsewhere).
2. The primary publish path (1639-1653) is unchanged — the mount-time account posts the native quote as today.
3. In the cross-target loop (1771-1806), branch per account when `currentQuoteStatus` exists, per the Global Constraints rule:

```js
const quoteIsBluesky =
  currentQuoteStatus?._bluesky ||
  isBlueskyInstance(currentQuoteStatus?._instance);
const nativeQuote = currentQuoteStatus
  ? quoteIsBluesky
    ? isBlueskyAccount(account)
    : account.instanceURL === currentQuoteStatus?._instance &&
      supportsNativeQuote(account.instanceURL)
  : false;
const targetSegments = nativeQuote
  ? crossSegments
  : currentQuoteStatus?.url
    ? [
        {
          ...crossSegments[0],
          text: `${crossSegments[0].text}\n${currentQuoteStatus.url}`,
        },
        ...crossSegments.slice(1),
      ]
    : crossSegments;
// publishThread({ account, segments: targetSegments, shared: nativeQuote
//   ? { …shared, quotedStatusId: currentQuoteStatus.id, quoteApprovalPolicy }
//   : shared })
```

The `canCrossPost` gate (1772) stays as-is: poll/scheduled/non-public quotes skip the extra targets with the existing toast. Accepted limitation, noted in code: the char counter counts only the typed text, so the appended URL can push a link target over its server limit — the per-target failure toast already reports that.

- [ ] **Step 4: Run the tests, verify PASS**

Run: `npx playwright test tests/foryou.spec.js`
Expected: all PASS, including Task 2's and the pre-existing tests (a single checked account, the common case, behaves exactly as before: one native quote).

- [ ] **Step 5: Update `CLAUDE.md`, commit**

In "Publishing and threading", extend the cross-post paragraph: quotes are cross-targets too — native on targets that can quote, URL-append on the others. Also update the account-agnostic design's residual wording if `CLAUDE.md` repeats "quotes stay network-bound" anywhere (grep for it).

```bash
git add src/components/compose.jsx tests/foryou-fixtures.js tests/foryou.spec.js CLAUDE.md
git commit -m "Composer: a quote targets every account — native where possible, link elsewhere"
```

### Task 4: A quote from the menu counts as an "interesting" verdict

**Files:**
- Modify: `src/components/boost-quote-menu.jsx` (the three quote items)
- Modify: `src/components/modals.jsx` (~60-102)
- Modify: `src/components/compose.jsx` (~1291-1310 passData; ~1852-1858 onClose)
- Modify: `src/utils/states.js:46` (comment)
- Modify: `src/pages/foryou.jsx` (verdict watcher, 338-345)
- Test: `tests/foryou.spec.js`

**Interfaces:**
- `_quoteContext`: the `_instance`-stamped compose status (`composeStatus()`), attached to every `showCompose` call the menu's three quote items make. Flow: `showCompose({ …, _quoteContext })` → `states.showCompose._quoteContext` → `Modals` reads it at close time → `states.lastPosted.quoteContext`. For the composer pop-out round-trip it also flows as a `quoteContext` prop into `Compose` and back as `window.__COMPOSE__._quoteContext` in `passData`.
- `states.lastPosted` gains `quoteContext` (and `type` gains `'quote'` for native quotes: `editStatus ? 'edit' : replyToStatus ? 'reply' : quoteStatus ? 'quote' : 'post'`).

- [ ] **Step 1: Write the failing test**

In `tests/foryou.spec.js` (single Mastodon account, existing fixtures):

```js
test('a quote with link counts as interesting for the rule', async ({ page }) => {
  let posted = 0;
  await page.route('https://instance-a.test/api/v1/statuses', (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    posted++;
    return route.fulfill({ json: { ...HOME[0], id: 'new1', content: '<p>look</p>' } });
  });
  await seed(page);
  await page.goto('/#/foryou');
  const firstItem = page.locator('.foryou-posts > li').first();
  await expect(firstItem).toBeVisible();
  await firstItem.getByRole('button', { name: 'Boost' }).click();
  await page.getByRole('menuitem', { name: 'Quote with link' }).click();
  await expect(page.locator('#compose-container')).toBeVisible();
  await page.locator('#compose-container textarea').fill('look at this');
  await page.getByRole('button', { name: 'Post' }).click();
  await expect.poll(() => posted).toBe(1);
  await expect.poll(() => Object.values(service.state.verdicts)).toHaveLength(1);
  const [verdict] = Object.values(service.state.verdicts);
  expect(verdict.verdict).toBe('interesting');
  expect(verdict.actions).toEqual(['quote']);
});
```

(The point of the fill+Post is that the verdict must follow a *published* quote, not the menu click.)

- [ ] **Step 2: Run it, verify it FAILS**

Run: `npx playwright test tests/foryou.spec.js -g "quote with link counts"`
Expected: FAIL — `service.state.verdicts` stays empty; today nothing links a posted quote to the digest post.

- [ ] **Step 3: Thread `_quoteContext` end to end**

- `boost-quote-menu.jsx`: all three quote items attach `_quoteContext: composeStatus()` — native quote: `showCompose({ quoteStatus: composeStatus(), _quoteContext: composeStatus() })`; link quote: `showCompose({ draftStatus: { status: `\n${url}` }, _quoteContext: composeStatus() })`; no-attribution: add `_quoteContext` to its `showCompose` alongside `draftStatus`.
- `modals.jsx`: read `const quoteContext = states.showCompose?._quoteContext || window.__COMPOSE__?._quoteContext || null` next to the `replyToStatus` read (87-90); pass `quoteContext={…}` into `<Compose>` with the other props; include `quoteContext` in `states.lastPosted` (97-102).
- `compose.jsx`: accept `quoteContext` in the props destructure; include `_quoteContext: quoteContext` in `passData` (1293-1310) so the pop-out round-trip keeps it; change `type` at 1854 to the four-way form above.
- `states.js:46`: comment becomes `lastPosted: null, // { type, instance, newStatus, replyToStatus, quoteContext }`.
- `foryou.jsx` watcher (338-345): today's `subscribeKey` handler early-returns unless `type === 'reply'`. Restructure so the reply branch stays as-is and a quote branch follows it:

```js
const unsubPosted = subscribeKey(states, 'lastPosted', (posted) => {
  const replyTo = posted?.replyToStatus;
  if (posted?.type === 'reply' && replyTo?.id) { /* existing reply match */ }
  const quoted = posted?.quoteContext;
  if (quoted?.id) {
    const item = itemsRef.current.find(({ key }) => splitKey(key).id === quoted.id);
    if (item) count(item.key, item.rule, 'quote');
  }
});
```

- [ ] **Step 4: Run the tests, verify PASS**

Run: `npx playwright test tests/foryou.spec.js`
Expected: all PASS. (The service needs no change: `addVerdict`'s `cleanAction` accepts any text action, service/foryou.js:39-48.)

- [ ] **Step 5: Commit**

```bash
git add src/components/boost-quote-menu.jsx src/components/modals.jsx \
  src/components/compose.jsx src/utils/states.js src/pages/foryou.jsx tests/foryou.spec.js
git commit -m "For You: quotes made from the boost/quote menu count as interesting verdicts"
```

### Task 5: The conversation thread's link quote targets every account

**Files:**
- Modify: `src/pages/conversation-thread.jsx` (`quote()`, 50-58; comment 33-34)
- Modify: `tests/conversation-mode.spec.js` (one new test)
- Modify: `CLAUDE.md` ("Conversation mode" → Thread bullet, ~236-238)

**Interfaces:** none new. The thread's native-quote path (51-52) now also shows the account checkboxes via Task 3 (`quoteStatus` compose is targetable). Only the link-fallback path still pins `_instance` and must change.

- [ ] **Step 1: Write the failing test**

In `tests/conversation-mode.spec.js`, next to the existing thread test (line 66+): seed two Mastodon accounts (A current + B, copying the ACCOUNT_B shape from cross-account-interactions.spec.js:26-37; abort B's routes), conversationModeOverride `on`, stub the thread status + context on instance-a as the existing test does, open the thread, then:

```js
await page.locator('.thread-actions button').nth(1).click(); // the quote button
await expect(page.locator('#compose-container')).toBeVisible();
await expect(page.locator('.cross-post-toolbar .account-picker-option')).toHaveCount(2);
```

Expected failure today: no `.cross-post-toolbar` — the link quote's `_instance` stamp pins the compose to one account, so `composeTargetable` is false and `targetRoster` is empty.

- [ ] **Step 2: Run it, verify it FAILS**

Run: `npx playwright test tests/conversation-mode.spec.js`
Expected: FAIL on the missing cross-post toolbar.

- [ ] **Step 3: Drop the `_instance` stamp from the link path**

`conversation-thread.jsx:54-56` becomes `showCompose({ draftStatus: { status: `\n${status.url}` } })` — matching the timeline menu's link quote (now in `boost-quote-menu.jsx`), which deliberately stamps nothing so the composer targets every checked account. Update the comment at 33-34 to say the link fallback targets every logged-in account, as the full app's "Quote with link".

- [ ] **Step 4: Run the tests, verify PASS**

Run: `npx playwright test tests/conversation-mode.spec.js`
Expected: all PASS.

- [ ] **Step 5: Update `CLAUDE.md`, run the full suites, commit**

In "Conversation mode" → Thread, note both quote paths now target every logged-in account (native where the target can, link elsewhere).

Run: `npm test && npm run test:unit && npm run formatting`
Expected: everything green.

```bash
git add src/pages/conversation-thread.jsx tests/conversation-mode.spec.js CLAUDE.md
git commit -m "Conversation thread: link quote targets every account, as the full app's Quote with link"
```

---

## Manual live check (operator, after Task 5)

Automation cannot cover the pop-out composer window or the real networks. On the tailnet deployment, with both accounts logged in:

1. For You → rocket on a Mastodon post → "Quote with link" → composer shows both accounts checked → post → the digest item's verdict dot appears and the lab shows a `quote` action for that rule.
2. For You → rocket on a Bluesky digest post → native `Quote` → composer shows both accounts checked → post → Bluesky gets the native quote embed, Mastodon gets the post with the bsky.app link; the verdict records.
3. Boost from the digest menu, then "Boost as" the other same-network account (if a second one exists) → toast confirms.
4. Open a quote composer, pop it out to a window, post from there → the verdict still records (the `_quoteContext` round-trip).

Close FLEET-8 with this evidence.
