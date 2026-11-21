// @ts-check
import { expect, test } from '@playwright/test';

import {
  addDigest,
  addVerdict,
  emptyState,
  importState,
} from '../service/foryou.js';

import {
  ACCOUNT_B,
  ACCOUNT,
  AVATAR,
  BSKY_DID,
  BSKY_DID_2,
  CID,
  HOME,
  bskyWrites,
  mastoPosts,
  reblogCalls,
  seed,
  seedAccounts,
  seedWithBsky,
  seedWithTwoBsky,
  stubBluesky,
  stubMastodon,
  stubMastodonPost,
} from './foryou-fixtures.js';

// The For You page against a stubbed Mastodon server and a stubbed Fleeting
// service: the digest renders with its "why this post" lines, reaching the
// end records last read, the next digest leaves out the posts already shown,
// and a like or a boost through the digest's boost/quote menu counts for the
// rule that picked the post.
//
// The service stub applies the service's own For You operations
// (service/foryou.js) to an in-memory state. `service.paired` and
// `service.down` stand for a device with no cookie and a service that does
// not answer.

let service;

// Requests from a service worker skip page.route, so the stub would miss
// the writes once the worker controls the page
test.use({ serviceWorkers: 'block' });

async function stubService(page) {
  service = { state: emptyState(), paired: true, down: false };
  await page.route('**/fleeting-api/**', async (route) => {
    const req = route.request();
    const path = new URL(req.url()).pathname.replace('/fleeting-api', '');
    if (service.down) return route.fulfill({ status: 502, body: '' });
    if (!service.paired) {
      if (path === '/pair/options') {
        return route.fulfill({
          json: { challengeId: 'c', options: { challenge: 'x' } },
        });
      }
      return route.fulfill({
        status: 401,
        json: { paired: false, hasPasskey: true, setup: false },
      });
    }
    const body = req.postDataJSON();
    const ops = {
      'GET /foryou': (s) => s,
      'GET /session': (s) => s,
      'POST /foryou/digests': (s) => addDigest(s, body),
      'POST /foryou/verdicts': (s) => addVerdict(s, body),
      'POST /foryou/import': (s) => importState(s, body),
    };
    const op = ops[`${req.method()} ${path}`];
    if (!op) return route.fulfill({ status: 404, json: { error: 'nope' } });
    try {
      service.state = op(service.state);
    } catch (e) {
      console.error(`service stub: ${req.method()} ${path}: ${e.message}`);
      return route.fulfill({ status: 400, json: { error: e.message } });
    }
    return route.fulfill({ json: service.state });
  });
}

test.beforeEach(async ({ page }) => {
  await stubService(page);
  await stubMastodon(page);
});

test('shows a digest, records last read, then shows nothing new', async ({
  page,
}) => {
  await seed(page);
  await page.goto('/#/foryou');

  const posts = page.locator('.foryou-posts > li');
  await expect(posts).toHaveCount(3);
  await expect(
    page.locator('#foryou-page').getByText('Replying to someone'),
  ).toHaveCount(0);
  await expect(page.locator('.foryou-why').first()).not.toBeEmpty();
  await expect(page.getByText('Replies 1')).toBeVisible();

  await page.getByText("That's all for now.").scrollIntoViewIfNeeded();
  await expect.poll(() => service.state.lastRead).toBeTruthy();
  expect(service.state.digests[0].picks).toHaveLength(3);

  await page.getByRole('button', { name: 'Reload' }).click();
  await expect(
    page.getByText('Nothing new since your last digest.'),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Show the previous digest' }),
  ).toBeVisible();
});

test('a like counts as interesting for the rule that picked the post', async ({
  page,
}) => {
  await seed(page);
  await page.goto('/#/foryou');
  const first = page.locator('.foryou-posts > li').first();
  await expect(first).toBeVisible();
  await first.locator('.foryou-like').click();

  await expect
    .poll(() => Object.values(service.state.verdicts))
    .toHaveLength(1);
  const [verdict] = Object.values(service.state.verdicts);
  expect(verdict.verdict).toBe('interesting');
  expect(verdict.actions).toEqual(['like']);
  expect(verdict.rule).toBeTruthy();
});

// The digest's own action row: the rocket opens the shared BoostQuoteMenu
// (src/components/boost-quote-menu.jsx) instead of boosting at once.
const DAVE_DID = 'did:plc:testdave';

// A top-level Bluesky post hot enough for the digest's rules to pick (the
// raw-engagement rule ranks it; its author is "followed" because the post
// itself is in the home timeline)
function bskyFeedItem({ embeddingDisabled = false } = {}) {
  const minutesAgo = new Date(Date.now() - 5 * 60_000).toISOString();
  return {
    post: {
      uri: `at://${DAVE_DID}/app.bsky.feed.post/hot1`,
      cid: CID,
      author: {
        did: DAVE_DID,
        handle: 'dave.bsky.social',
        displayName: 'Dave',
        avatar: AVATAR,
        followersCount: 500,
      },
      record: {
        $type: 'app.bsky.feed.post',
        text: 'A hot Bluesky take about zoning reform',
        createdAt: minutesAgo,
      },
      indexedAt: minutesAgo,
      replyCount: 3,
      repostCount: 2,
      likeCount: 60,
      viewer: { embeddingDisabled },
    },
  };
}

async function openBoostMenu(page, item) {
  const first = item ?? page.locator('.foryou-posts > li').first();
  // The digest load (both networks) can outlast the default 5s under load
  await expect(first).toBeVisible({ timeout: 20_000 });
  await first
    .locator('.foryou-actions')
    .getByRole('button', { name: 'Boost' })
    .click();
}

test('the digest rocket opens the menu, not an instant boost', async ({
  page,
}) => {
  await seed(page);
  await page.goto('/#/foryou');
  await openBoostMenu(page);

  await expect(page.getByRole('menuitem', { name: 'Boost' })).toBeVisible();
  await expect(
    page.getByRole('menuitem', { name: 'Quote with link' }),
  ).toBeVisible();
  await expect(
    page.getByRole('menuitem', { name: 'Quote without attribution' }),
  ).toBeVisible();

  // Opening the menu neither boosted nor counted a verdict
  expect(reblogCalls).toBe(0);
  expect(Object.keys(service.state.verdicts)).toEqual([]);
});

test('confirming Boost in the menu boosts and counts as interesting', async ({
  page,
}) => {
  await seed(page);
  await page.goto('/#/foryou');
  await openBoostMenu(page);
  await page.getByRole('menuitem', { name: 'Boost' }).click();

  await expect.poll(() => reblogCalls).toBe(1);
  await expect
    .poll(() => Object.values(service.state.verdicts))
    .toHaveLength(1);
  const [verdict] = Object.values(service.state.verdicts);
  expect(verdict.verdict).toBe('interesting');
  expect(verdict.actions).toEqual(['boost']);
  expect(verdict.rule).toBeTruthy();
});

test('a quote with link counts as interesting for the rule', async ({
  page,
}) => {
  let posted = 0;
  await page.route('https://instance-a.test/api/v1/statuses', (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    posted++;
    return route.fulfill({
      json: { ...HOME[0], id: 'new1', content: '<p>look</p>' },
    });
  });
  await seed(page);
  await page.goto('/#/foryou');
  const firstItem = page.locator('.foryou-posts > li').first();
  await expect(firstItem).toBeVisible();
  await firstItem.getByRole('button', { name: 'Boost' }).click();
  await page.getByRole('menuitem', { name: 'Quote with link' }).click();
  await expect(page.locator('#compose-container')).toBeVisible();
  await page.locator('#compose-container textarea').fill('look at this');
  await page.getByRole('button', { name: 'Post', exact: true }).click();
  await expect.poll(() => posted).toBe(1);
  await expect
    .poll(() => Object.values(service.state.verdicts))
    .toHaveLength(1);
  const [verdict] = Object.values(service.state.verdicts);
  expect(verdict.verdict).toBe('interesting');
  expect(verdict.actions).toEqual(['quote']);
});

test('Quote with link targets every account', async ({ page }) => {
  await seedWithBsky(page);
  await stubBluesky(page, []);
  await page.goto('/#/foryou');
  await expect(page.locator('.foryou-posts > li')).toHaveCount(3, {
    timeout: 20_000,
  });
  await openBoostMenu(page);
  await page.getByRole('menuitem', { name: 'Quote with link' }).click();

  // A link quote is an ordinary fresh post, so the composer offers every
  // logged-in account, both networks, all checked
  const compose = page.locator('#compose-container');
  await expect(compose).toBeVisible();
  await expect(
    compose.locator('.cross-post-toolbar .account-picker-option'),
  ).toHaveCount(2);
  await expect(
    compose.locator('.cross-post-toolbar input[type=checkbox]'),
  ).toHaveCount(2);
  await expect(
    compose.locator('.cross-post-toolbar input[type=checkbox]:checked'),
  ).toHaveCount(2);
});

test('a Bluesky digest post offers the native quote', async ({ page }) => {
  await seedWithBsky(page);
  await stubBluesky(page, [bskyFeedItem()]);
  await page.goto('/#/foryou');

  const item = page
    .locator('.foryou-posts > li')
    .filter({ hasText: 'hot Bluesky take' });
  await openBoostMenu(page, item);

  // Bluesky has native quotes, so the menu's quote item is the native one;
  // "Quote with link" is the non-native fallback and must not appear. The
  // dev build adds a DEV-tagged "Quote with link" variant, so match the
  // name exactly.
  const quote = page.getByRole('menuitem', { name: 'Quote', exact: true });
  await expect(quote).toBeVisible();
  await expect(
    page.getByRole('menuitem', { name: 'Quote with link', exact: true }),
  ).toBeHidden();

  await quote.click();
  await expect(page.locator('#compose-container')).toBeVisible();
});

// Opens the composer with a NATIVE quote of the digest's Bluesky post
// (T4's flow: rocket → Quote), with the Mastodon compose POSTs captured
async function openNativeQuote(page) {
  const item = page
    .locator('.foryou-posts > li')
    .filter({ hasText: 'hot Bluesky take' });
  await openBoostMenu(page, item);
  await page.getByRole('menuitem', { name: 'Quote', exact: true }).click();
  const compose = page.locator('#compose-container');
  await expect(compose).toBeVisible();
  return compose;
}

test('quoting a Bluesky post reaches both networks, each its own way', async ({
  page,
}) => {
  await seedWithBsky(page);
  await stubBluesky(page, [bskyFeedItem()]);
  await stubMastodonPost(page);
  await page.goto('/#/foryou');

  const compose = await openNativeQuote(page);

  // Like a new post, the quote targets every logged-in account, both
  // networks, all checked
  await expect(
    compose.locator('.cross-post-toolbar .account-picker-option'),
  ).toHaveCount(2);
  await expect(
    compose.locator('.cross-post-toolbar input[type=checkbox]:checked'),
  ).toHaveCount(2);

  await compose.locator('textarea').first().fill('nice one');
  await compose.locator('button[type=submit]').click();

  // Exactly one Bluesky write (the native quote) and one Mastodon POST
  // (the link quote)
  await expect.poll(() => bskyWrites.length).toBe(1);
  await expect.poll(() => mastoPosts.length).toBe(1);

  // Bluesky quotes natively: the typed text with the quoted record as the
  // embed, and no post URL in the text
  const record = bskyWrites[0].record;
  expect(record.text).toContain('nice one');
  expect(record.text).not.toContain('bsky.app');
  expect(record.embed?.$type).toBe('app.bsky.embed.record');
  expect(record.embed?.record?.uri).toBe(
    'at://did:plc:testdave/app.bsky.feed.post/hot1',
  );

  // Mastodon gets the quoted post's URL appended to the text instead, and
  // no quoted_status_id
  const { status, quoted_status_id: quotedStatusId } = mastoPosts[0];
  expect(status).toContain('nice one');
  expect(status).toContain('bsky.app/profile/dave.bsky.social/post/hot1');
  expect(quotedStatusId).toBeUndefined();
});

test('a second same-network account also gets the native quote', async ({
  page,
}) => {
  await seedWithTwoBsky(page);
  await stubBluesky(page, [bskyFeedItem()]);
  await stubMastodonPost(page);
  await page.goto('/#/foryou');

  const compose = await openNativeQuote(page);

  // All three accounts — two Bluesky, one Mastodon — are checked targets
  await expect(
    compose.locator('.cross-post-toolbar .account-picker-option'),
  ).toHaveCount(3);
  await expect(
    compose.locator('.cross-post-toolbar input[type=checkbox]:checked'),
  ).toHaveCount(3);

  await compose.locator('textarea').first().fill('nice one');
  await compose.locator('button[type=submit]').click();

  // Both Bluesky accounts quote natively (ids are network-global); the
  // Mastodon account still gets the link
  await expect.poll(() => bskyWrites.length).toBe(2);
  await expect.poll(() => mastoPosts.length).toBe(1);
  expect(bskyWrites.map((w) => w.repo).sort()).toEqual(
    [BSKY_DID, BSKY_DID_2].sort(),
  );
  for (const write of bskyWrites) {
    expect(write.record.text).toContain('nice one');
    expect(write.record.embed?.$type).toBe('app.bsky.embed.record');
  }
  expect(mastoPosts[0].status).toContain('bsky.app/profile/');
});

test('a Bluesky post with quotes turned off disables the quote item', async ({
  page,
}) => {
  await seedWithBsky(page);
  await stubBluesky(page, [bskyFeedItem({ embeddingDisabled: true })]);
  await page.goto('/#/foryou');

  const item = page
    .locator('.foryou-posts > li')
    .filter({ hasText: 'hot Bluesky take' });
  await openBoostMenu(page, item);

  const quote = page.getByRole('menuitem', {
    name: /not allowed to quote/,
  });
  await expect(quote).toBeVisible();
  await expect(quote).toBeDisabled();
});

test('Boost as a second same-network account', async ({ page }) => {
  await seedAccounts(page, [ACCOUNT, ACCOUNT_B]);
  // B's server answers only the search that resolves the post and the
  // reblog itself; its other routes abort
  await page.route('https://instance-b.test/**', (route) => route.abort());
  await page.route('https://instance-b.test/api/v2/search*', (route) =>
    route.fulfill({ json: { statuses: [{ ...HOME[0], id: '1' }] } }),
  );
  await page.route(
    'https://instance-b.test/api/v1/statuses/1/reblog',
    (route) =>
      route.fulfill({
        json: { ...HOME[0], id: '1', reblogged: true, reblogs_count: 2 },
      }),
  );
  await page.goto('/#/foryou');
  await openBoostMenu(page);

  await page
    .getByRole('menuitem', { name: 'Boost as @bob@instance-b.test' })
    .click();
  await expect(page.getByText('Boosted as @bob@instance-b.test')).toBeVisible();
});

test('"Not for me" shows the reasons', async ({ page }) => {
  await seed(page);
  await page.goto('/#/foryou');
  await page.getByRole('button', { name: 'Not for me' }).first().click();
  await expect(
    page.getByRole('button', { name: 'Just this post' }),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'Block' })).toBeVisible();
});

test('conversation mode has no For You page', async ({ page }) => {
  await seed(page, { conversationMode: true });
  await page.goto('/#/foryou');
  await expect(page).toHaveURL(/#\/conversations$/);
});

test('the lab still loads through the shared loader', async ({ page }) => {
  await seed(page);
  await page.goto('/#/_foryou-lab');
  await expect(page.getByText(/posts, picked by \d+ rules/)).toBeVisible();
  await expect(page.locator('.lab-posts > li').first()).toBeVisible();
});

test('uploads the browser-storage state once, then deletes it', async ({
  page,
}) => {
  const lastRead = Date.now() - 60 * 60_000;
  await page.addInitScript((lastRead) => {
    if (sessionStorage.getItem('seeded')) return;
    sessionStorage.setItem('seeded', '1');
    localStorage.setItem(
      'foryouState',
      JSON.stringify({
        lastRead,
        digests: [{ at: lastRead, picks: [{ key: 'old/1', rule: 'raw' }] }],
        verdicts: {},
      }),
    );
  }, lastRead);
  await seed(page);
  await page.goto('/#/foryou');
  await expect(page.locator('.foryou-posts > li').first()).toBeVisible();
  expect(service.state.digests[0]).toEqual({
    at: lastRead,
    picks: [{ key: 'old/1', rule: 'raw' }],
  });
  expect(
    await page.evaluate(() => localStorage.getItem('foryouState')),
  ).toBeNull();
});

test('an unpaired device sees "Unlock Fleeting"', async ({ page }) => {
  service.paired = false;
  await seed(page);
  await page.goto('/#/foryou');
  await expect(
    page.getByRole('button', { name: 'Unlock Fleeting' }),
  ).toBeVisible();
});

test('a service that does not answer gives an error and a retry', async ({
  page,
}) => {
  service.down = true;
  await seed(page);
  await page.goto('/#/foryou');
  await expect(page.getByText(/Failed to load/)).toBeVisible();
  service.down = false;
  await page.getByRole('button', { name: 'Try again' }).click();
  await expect(page.locator('.foryou-posts > li')).toHaveCount(3);
});
