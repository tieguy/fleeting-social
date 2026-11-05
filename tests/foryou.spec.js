// @ts-check
import { expect, test } from '@playwright/test';

// The For You page against a stubbed Mastodon server: the digest renders
// with its "why this post" lines, reaching the end records last read, the
// next digest leaves out the posts already shown, and a like counts for the
// rule that picked the post.

const DOMAIN = 'instance-a.test';
const ACCOUNT = {
  info: {
    id: 'me',
    username: 'alice',
    acct: `alice@${DOMAIN}`,
    displayName: 'Alice',
  },
  instanceURL: DOMAIN,
  accessToken: 'token-a',
};

function account(id, followers) {
  return {
    id,
    username: id,
    acct: id,
    display_name: id,
    url: `https://${DOMAIN}/@${id}`,
    avatar: '',
    avatar_static: '',
    followers_count: followers,
  };
}

function status(id, author, text, { minutesAgo, likes }) {
  return {
    id,
    created_at: new Date(Date.now() - minutesAgo * 60_000).toISOString(),
    account: account(author, 100),
    content: `<p>${text}</p>`,
    language: 'en',
    visibility: 'public',
    sensitive: false,
    spoiler_text: '',
    media_attachments: [],
    mentions: [],
    tags: [],
    emojis: [],
    reblogs_count: 1,
    favourites_count: likes,
    replies_count: 1,
    favourited: false,
    reblogged: false,
  };
}

const HOME = [
  status('1', 'ann', 'Zoning reform passed the board', {
    minutesAgo: 30,
    likes: 40,
  }),
  status('2', 'bea', 'A quiet afternoon post', { minutesAgo: 60, likes: 3 }),
  status('3', 'cal', 'Some thoughts on tea', { minutesAgo: 90, likes: 12 }),
  // A reply, which the filters remove
  {
    ...status('4', 'dee', 'Replying to someone', { minutesAgo: 20, likes: 0 }),
    in_reply_to_id: '99',
    in_reply_to_account_id: 'zed',
  },
];

function seed(page, { conversationMode = false } = {}) {
  return page.addInitScript(
    ([account, conversationMode]) => {
      if (conversationMode) {
        localStorage.setItem('conversationModeOverride', 'on');
      }
      localStorage.setItem('accounts', JSON.stringify([account]));
      localStorage.setItem(
        'instances',
        JSON.stringify({
          [account.instanceURL]: { domain: account.instanceURL },
        }),
      );
      sessionStorage.setItem('currentAccount', account.info.id);
    },
    [ACCOUNT, conversationMode],
  );
}

test.beforeEach(async ({ page }) => {
  await page.route(`https://${DOMAIN}/**`, (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    if (path === '/api/v1/accounts/verify_credentials') {
      return route.fulfill({ json: account('me', 10) });
    }
    if (path === '/api/v1/timelines/home') {
      // One page, then the end of the timeline
      return route.fulfill({
        json: url.searchParams.get('max_id') ? [] : HOME,
      });
    }
    if (
      path === '/api/v1/lists' ||
      path === '/api/v1/favourites' ||
      path === '/api/v1/accounts/me/statuses'
    ) {
      return route.fulfill({ json: [] });
    }
    const like = path.match(/^\/api\/v1\/statuses\/(\d+)\/favourite$/);
    if (like) {
      const post = HOME.find((s) => s.id === like[1]);
      return route.fulfill({
        json: { ...post, favourited: true, favourites_count: 41 },
      });
    }
    return route.abort();
  });
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
  await expect
    .poll(() =>
      page.evaluate(
        () => JSON.parse(localStorage.getItem('foryouState'))?.lastRead,
      ),
    )
    .toBeTruthy();

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
    .poll(() =>
      page.evaluate(() =>
        Object.values(
          JSON.parse(localStorage.getItem('foryouState'))?.verdicts || {},
        ),
      ),
    )
    .toHaveLength(1);
  const [verdict] = await page.evaluate(() =>
    Object.values(JSON.parse(localStorage.getItem('foryouState')).verdicts),
  );
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

