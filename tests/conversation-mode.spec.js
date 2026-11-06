// @ts-check
import { expect, test } from '@playwright/test';

// The conversation-mode guard. Dev builds show the full app unless
// localStorage `conversationModeOverride` is 'on' (see useConversationMode).

const ACCOUNT = {
  info: {
    id: 'a1',
    username: 'alice',
    acct: 'alice@instance-a.test',
    displayName: 'Alice',
  },
  instanceURL: 'instance-a.test',
  accessToken: 'token-a',
};

function seed(page, { loggedIn, conversationMode }) {
  return page.addInitScript(
    ([account, loggedIn, conversationMode]) => {
      if (conversationMode) {
        localStorage.setItem('conversationModeOverride', 'on');
      }
      if (loggedIn) {
        localStorage.setItem('accounts', JSON.stringify([account]));
        localStorage.setItem(
          'instances',
          JSON.stringify({
            [account.instanceURL]: { domain: account.instanceURL },
          }),
        );
        sessionStorage.setItem('currentAccount', account.info.id);
      }
    },
    [ACCOUNT, loggedIn, conversationMode],
  );
}

test.beforeEach(async ({ page }) => {
  await page.route('https://instance-a.test/**', (route) => route.abort());
});

test.describe('in conversation mode', () => {
  test.beforeEach(({ page }) =>
    seed(page, { loggedIn: true, conversationMode: true }),
  );

  for (const path of [
    '/',
    '/following',
    '/notifications',
    '/instance-a.test/s/123',
    '/instance-a.test/a/a1',
    '/search?q=hello',
    '/https://instance-a.test/@alice',
  ]) {
    test(`${path} redirects to the conversation list`, async ({ page }) => {
      await page.goto(`/#${path}`);
      await expect(page).toHaveURL(/#\/conversations$/);
      await expect(
        page.getByRole('heading', { name: 'Conversations' }),
      ).toBeVisible();
    });
  }

  test('a thread renders with inert profile links', async ({ page }) => {
    const status = {
      id: '123',
      created_at: '2026-10-21T12:00:00.000Z',
      account: {
        id: 'b1',
        username: 'bob',
        display_name: 'Bob',
        acct: 'bob@instance-a.test',
        url: 'https://instance-a.test/@bob',
        avatar: '',
        avatar_static: '',
      },
      content: '<p>Replying to you</p>',
      visibility: 'public',
      media_attachments: [],
      mentions: [],
      tags: [],
      emojis: [],
    };
    await page.route('https://instance-a.test/api/v1/statuses/123', (route) =>
      route.fulfill({ json: status }),
    );
    await page.route(
      'https://instance-a.test/api/v1/statuses/123/context',
      (route) => route.fulfill({ json: { ancestors: [], descendants: [] } }),
    );
    await page.goto('/#/conversations/instance-a.test/123');
    await expect(page.getByText('Replying to you')).toBeVisible();
    await page.locator('.name-text').first().click();
    await expect(page).toHaveURL(/#\/conversations\/instance-a.test\/123$/);
    await expect(page.locator('.account-container')).toHaveCount(0);
  });

  test('shows no app chrome', async ({ page }) => {
    await page.goto('/#/conversations');
    await expect(
      page.getByRole('heading', { name: 'Conversations' }),
    ).toBeVisible();
    await expect(page.locator('#compose-button')).toHaveCount(0);
    await expect(page.locator('#shortcuts')).toHaveCount(0);
    await expect(page.locator('.nav-menu-button')).toHaveCount(0);
  });
});

test('logged out in conversation mode, a deep link goes to login', async ({
  page,
}) => {
  await seed(page, { loggedIn: false, conversationMode: true });
  await page.goto('/#/following');
  await expect(page).toHaveURL(/#\/login$/);
});

test('outside conversation mode, the full app is unchanged', async ({
  page,
}) => {
  await seed(page, { loggedIn: true, conversationMode: false });
  await page.goto('/#/following');
  await expect(page).toHaveURL(/#\/following$/);
  await expect(page.locator('#compose-button')).toBeVisible();
});

test('outside conversation mode, the conversation list has the navigation menu', async ({
  page,
}) => {
  await seed(page, { loggedIn: true, conversationMode: false });
  await page.goto('/#/conversations');
  await expect(
    page.getByRole('heading', { name: 'Conversations' }),
  ).toBeVisible();
  await expect(
    page.locator('#conversations-page .nav-menu-button'),
  ).toBeVisible();
});

test('when a full-app window opens on the conversation list, it goes to For You', async ({
  page,
}) => {
  await seed(page, { loggedIn: true, conversationMode: true });
  await page.goto('/#/conversations');
  await expect(
    page.getByRole('heading', { name: 'Conversations' }),
  ).toBeVisible();
  // The window opens: the dev override goes away, and the page comes back
  // into view, which makes the hook check the schedule again.
  await page.evaluate(() => {
    localStorage.removeItem('conversationModeOverride');
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await expect(page).toHaveURL(/#\/foryou$/);
});
