// @ts-check
import { expect, test } from '@playwright/test';

import {
  addDigest,
  addVerdict,
  emptyState,
  importState,
} from '../service/foryou.js';

import { seed, stubMastodon } from './foryou-fixtures.js';

// The For You page against a stubbed Mastodon server and a stubbed Fleeting
// service: the digest renders with its "why this post" lines, reaching the
// end records last read, the next digest leaves out the posts already shown,
// and a like counts for the rule that picked the post.
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
