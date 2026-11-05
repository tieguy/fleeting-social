# Account-Agnostic Actions Design

## Summary

fleeting-social currently ties what a user can do to whichever account is "active" — switching accounts is a precondition for posting as, boosting as, or viewing the profile of a different logged-in account. This design removes that constraint across three UI surfaces (compose, per-status actions, and profile navigation) by replacing "the active account acts" with "the user explicitly picks which account(s) act," without introducing a new persisted "acting account" concept that would just recreate the same problem in a different form.

The approach is to extract the account-selection and network-eligibility logic that already exists in scattered form (e.g. the follow/mute/block routing in `related-actions.jsx`, the mention-network picker) into one shared helper (`acting-accounts.js`) and one shared picker component (`account-picker.jsx`), then reuse both across the three surfaces: compose gets a persistent per-account checkbox list instead of a single cross-post toggle, per-status actions (boost, favourite, reply) get an "as @…" chooser scoped to accounts eligible on that post's network, and the profile nav link becomes a submenu over all logged-in accounts. Each surface's account choice is otherwise stateless and made fresh per action; only the compose target set is persisted (as the unchecked-account list, so new accounts default in). The work rides entirely on existing per-account plumbing (`api({ account })`, `publishThread({ account })`, `_instance` tagging) rather than adding new state management, and is delivered in six phases — shared helpers, compose, profile submenu, boost, favourite/reply, and a documentation/copy cleanup — each independently testable.

## Definition of Done

The active/switched account no longer constrains what the user can do:

- The compose window shows a checkbox per logged-in account (not "active account + cross-post toggle"). All accounts are checked by default; the last selection persists. A post can go to any subset, including *only* a non-active account. Checked accounts are peers — no primary/secondary distinction in the UI; the character counter enforces the strictest checked network.
- The nav menu's "Profile" item is a submenu listing all logged-in accounts; picking one opens that account's profile without switching accounts.
- Boost can be performed as any eligible account (same network as the target post) from the boost confirmation menu. Favourite-as and Reply-as are available from the status overflow ("…") menu.
- The README states the product assumption: fleeting-social is for people with accounts on both Mastodon and Bluesky; multi-account is the normal case.

Out of scope: Openvibe-style multi-platform username unification; merged bookmarks/favourites pages; removing the account-switch mechanism itself.

## Glossary

- **Mastodon**: A federated (multi-server) social network using the ActivityPub protocol; one of the two networks fleeting-social supports.
- **Bluesky / AT Protocol**: The other supported social network, built on the AT Protocol; behaves differently enough from Mastodon (e.g. client-side link unfurling, native quote posts) that the codebase normalizes it to look Mastodon-shaped internally.
- **masto.js-compatible facade**: fleeting-social wraps Bluesky's API in an adapter that mimics the shape of `masto.js` (the standard Mastodon client library), so the rest of the app can treat Bluesky and Mastodon accounts interchangeably.
- **Cross-post**: The current (pre-this-design) compose behavior of also publishing a post to other logged-in accounts via a single on/off toggle, distinct from the account you're actively posting as.
- **Boost / Favourite**: Mastodon-style terms (equivalent to "repost"/"like") for re-sharing or liking a post; this design lets either be performed as any eligible logged-in account, not just the active one.
- **`info._bluesky`**: A flag set by the app's data converters on profile/account objects to record which network they belong to; used to route actions to a client on the correct network.
- **`_instance` tagging / `draftStatus._instance`**: An existing convention where merged-timeline items are stamped with their source account/instance, and the composer accepts an instance to post from; "Reply as" reuses this same field.
- **`eligibleAccounts` / `allAccounts`**: The two pure functions this design introduces — the former filters logged-in accounts to those on the same network as a target (for boost/favourite/reply), the latter returns the full account roster (for compose checkboxes and the profile submenu).
- **`store.local`**: The app's local persistence layer, used here to remember which accounts are unchecked in the compose picker across sessions.
- **`publishThread` / `resolveMediaIds`**: The existing unified function that publishes a post or thread to one account, including re-uploading media per target; the compose redesign loops this over every checked account.
- **Character/char limit enforcement (`compose-counting.js`)**: Existing helpers that decide how strict a length limit applies to a post; this design makes that limit "strictest network among checked accounts" (e.g. Bluesky's 300-character cap) rather than being tied to the active account's network.
- **Openvibe, Buffer**: Third-party multi-platform posting tools cited as prior art for "post to a checked subset of accounts as peers" compose UI.
- **Sora / SoraSNS**: A third-party client cited as prior art for choosing which account performs a per-status action (rather than per-post publishing).
- **Upstream Phanpy**: The open-source Mastodon client fleeting-social is forked from; referenced to note that this feature is an open, unimplemented request there (issue #274).

## Architecture

Three UI surfaces generalize from "the active account acts" to "an explicitly chosen account acts", backed by one small shared helper and no new global state. The account choice is ephemeral per action — deliberately, since a remembered "acting account" would recreate the switched-account concept this design removes. The one persisted piece of state is the compose target set.

**Shared helper — `src/utils/acting-accounts.js`.** Pure functions:

```js
// All logged-in accounts able to act on a target on `instance` /
// with converter info `info` (same-network rule; uses info._bluesky
// and isBlueskyInstance).
eligibleAccounts({ instance, info })

// All logged-in accounts, current first, deduped — the compose
// checkbox roster.
allAccounts()
```

This generalizes the ad-hoc network-routing logic currently duplicated in `src/components/related-actions.jsx:86-105` and `src/utils/mention-network.js`, which are refactored to call it.

**Shared UI — `src/components/account-picker.jsx`.** One component, two variants: a checkbox list (compose) and menu items (nav submenu, boost menu, overflow menu). Each row shows avatar, `@acct`, and a network badge.

**Compose targets.** `compose.jsx` replaces `crossPostAccounts` + the single `crossPost` boolean with `targetAccounts`: the full roster from `allAccounts()`, each row checked/unchecked. Default all-checked; the unchecked set persists in `store.local` (keyed by account ID so logins/logouts don't corrupt it). Publishing loops `publishThread({ account })` over every checked account as peers; media re-uploads per target via the existing `resolveMediaIds` path; the char counter enforces the strictest checked network (300 when any Bluesky target is checked, via the existing `compose-counting.js` helpers). Zero checked accounts disables Post. Replies, quotes, and edits keep today's single-network behavior — no checkboxes; acting-account choice for replies arrives via "Reply as" instead.

**Per-status actions.** Action routing already goes through `api({ instance })` / `api({ account })` (`src/components/status.jsx:410-417`). The change is choice, not plumbing: the boost confirmation menu gains one "Boost as @…" row per eligible account when more than one exists; the "…" overflow menu gains "Favourite as…" and "Reply as…" submenus. "Reply as" opens the composer with `draftStatus._instance` set to the chosen account — the same mechanism `mention-network.js` already uses for cross-network mentions. Boosted/favourited highlight state means "any of my accounts did this"; the menu shows which.

**Profile submenu.** Read-only navigation: `nav-menu.jsx`'s single Profile link becomes a submenu of all accounts, each linking to `/${account.instanceURL}/a/${account.info.id}`. Profile pages already render per-instance via `api({ instance })`.

**Product assumption:** the normal user has ≥2 accounts (one per network) — otherwise a native client serves better. Single-account states degrade gracefully (plain Profile link, no checkboxes, no "as…" rows) but are not designed around.

## Existing Patterns

Investigation confirmed the design rides on patterns already in the fork:

- **Per-account clients:** `api({ account })` (`src/utils/api.js:235`) resolves a masto-compatible client for any logged-in account, Mastodon or Bluesky. All new action routing uses it.
- **Network-based routing:** `related-actions.jsx:86-105` already routes follow/mute/block by the *target profile's* network via `info._bluesky`; `mention-network.js` picks a mention account the same way. `eligibleAccounts` extracts this into one place.
- **Multi-account publish loop:** `compose.jsx:1717-1752` already loops `publishThread({ account })` over cross-post accounts, with per-target media re-upload in `src/utils/publish.js:62-87`. Peer checkboxes generalize the loop's input; the loop itself stands.
- **`_instance` tagging + `draftStatus._instance`:** merged timelines stamp items with their source instance, and the composer already accepts a posting instance — "Reply as" reuses both.
- **Prior art (external):** Openvibe (default-post-everywhere with per-post toggles) and Buffer (per-channel checkboxes) for compose; Sora/SoraSNS for per-action account choice. Upstream Phanpy has this as an open request (issue #274), not an implementation. Openvibe's multi-platform username unification was considered and excluded.

Divergence from upstream Phanpy (single cross-post toggle, single Profile link) is accepted; upstream mergeability is no longer a design constraint for this fork.

## Implementation Phases

### Phase 1: Shared helpers and picker component

**Goal:** One source of truth for "who can act" and one reusable account UI.

**Components:**
- `src/utils/acting-accounts.js` — `eligibleAccounts({ instance, info })`, `allAccounts()`
- `src/components/account-picker.jsx` — checkbox-list and menu-item variants (avatar, `@acct`, network badge)
- Refactor `src/components/related-actions.jsx` and `src/utils/mention-network.js` to call `eligibleAccounts`

**Dependencies:** None.

**Done when:** Unit tests pass for both helper functions (network filtering, dedupe, current-first ordering); related-actions and mention flows behave as before.

### Phase 2: Compose peer checkboxes

**Goal:** Post to any subset of accounts, active account irrelevant.

**Components:**
- `src/components/compose.jsx` — replace `crossPostAccounts`/`crossPost` (lines 227-236) and the cross-post toolbar (lines 2152-2181) with an AccountPicker checkbox list bound to `targetAccounts`; persist unchecked set in `store.local`; disable Post at zero targets; drive the publish loop (lines 1717-1752) from the checked set as peers
- `src/utils/compose-counting.js` integration — strictest-network char limit from the checked set
- Accepted deviation (signed off 2026-08-31): the composer keeps the account it opened with as an internal primary. The UI shows no primary. When that account is unchecked, the composer skips its publish and its media pre-upload, and every checked target posts through the re-upload path.

**Dependencies:** Phase 1.

**Done when:** Tests pass for target-set persistence, strictest-limit selection, and zero-target gating; a post composed while "active" on Mastodon can be published only to Bluesky (and vice versa), verified live.

### Phase 3: Profile submenu

**Goal:** View any of your profiles without switching.

**Components:**
- `src/components/nav-menu.jsx` — Profile link (lines 228-235) becomes a submenu over `allAccounts()` using the AccountPicker menu variant; plain link when only one account

**Dependencies:** Phase 1.

**Done when:** Submenu lists every account and navigates to each profile without an account switch or reload.

### Phase 4: Boost as any account

**Goal:** The priority per-status action.

**Components:**
- Boost confirmation menu (in `src/components/status.jsx`) — "Boost as @…" rows from `eligibleAccounts`, executed via `api({ account })`
- Boosted-state display — the highlight reflects only the default acting account; a boost-as reports via toast. Accepted limitation (signed off 2026-08-31): "any of my accounts boosted" would need client-side per-status bookkeeping that survives refetches, and the chooser never renders with one account per network — revisit only if two same-network accounts become real.

**Dependencies:** Phase 1.

**Done when:** Tests pass for eligibility and per-account boost dispatch; boosting a post as the non-active account works live on both networks.

### Phase 5: Favourite as / Reply as

**Goal:** Complete the per-status action set.

**Components:**
- Status "…" overflow menu (`src/components/status.jsx`) — "Favourite as…" and "Reply as…" submenus
- "Reply as" opens the composer with `draftStatus._instance` set to the chosen account

**Dependencies:** Phases 1 and 4 (menu structure), Phase 2 (composer behavior).

**Done when:** Favourite-as dispatches to the chosen account; Reply-as opens the composer posting from the chosen account; tests cover both.

### Phase 6: README product assumption + polish

**Goal:** Document the assumption and reconcile stray surfaces.

**Components:**
- `README.md` — state that fleeting-social presumes accounts on both networks; multi-account is the normal case
- Sweep for stale "cross-post" strings/labels in UI copy and `src/locales/en.po`

**Dependencies:** Phases 2–5.

**Done when:** README updated; no UI copy refers to the old cross-post toggle model.

## Additional Considerations

**Error handling:** compose publishes per-target independently; a failed target reports a toast naming the account and reuses the existing `failedAtIndex`/retry machinery without disturbing successful targets. Per-status actions report failure per account by name.

**Persisted target set:** stored as the *unchecked* account IDs, so newly added accounts default to checked (matching the all-checked default) and removed accounts vanish harmlessly.

**Cross-network limits are unchanged:** a Mastodon account can never boost/favourite/reply to a Bluesky post or vice versa; `eligibleAccounts` encodes the same-network rule, and single-eligible-account cases render no "as…" chooser.
