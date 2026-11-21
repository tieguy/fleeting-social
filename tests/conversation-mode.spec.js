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

const AVATAR =
  'data:image/gif;base64,R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==';

const ACCOUNT_B = {
  info: {
    id: 'b1',
    username: 'bob',
    acct: 'bob@instance-b.test',
    displayName: 'Bob',
    avatar: AVATAR,
    avatarStatic: AVATAR,
  },
  instanceURL: 'instance-b.test',
  accessToken: 'token-b',
};

function seed(page, { loggedIn, conversationMode, accounts = [ACCOUNT] }) {
  return page.addInitScript(
    ([accounts, loggedIn, conversationMode]) => {
      if (conversationMode) {
        localStorage.setItem('conversationModeOverride', 'on');
      }
      if (loggedIn) {
        localStorage.setItem('accounts', JSON.stringify(accounts));
        localStorage.setItem(
          'instances',
          JSON.stringify(
            Object.fromEntries(
              accounts.map(({ instanceURL }) => [
                instanceURL,
                { domain: instanceURL },
              ]),
            ),
          ),
        );
        sessionStorage.setItem('currentAccount', accounts[0].info.id);
      }
    },
    [accounts, loggedIn, conversationMode],
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

  test("the thread's link quote targets every logged-in account", async ({
    page,
  }) => {
    // Two Mastodon accounts, A current; the thread is on B's instance, as
    // a conversation from a merged source would be. This seed registers
    // after the describe's (init scripts run in registration order), so
    // its accounts list wins.
    await seed(page, {
      loggedIn: true,
      conversationMode: true,
      accounts: [ACCOUNT, ACCOUNT_B],
    });
    // B's unstubbed routes are aborted — the app tolerates the network
    // failures — and the two thread stubs below are registered later, so
    // they take precedence.
    await page.route('https://instance-b.test/**', (route) => route.abort());
    // No API version is ever known for instance B, so the thread's quote
    // button is the link fallback.
    const status = {
      id: '456',
      created_at: '2026-10-21T12:00:00.000Z',
      account: {
        id: 'c1',
        username: 'carol',
        display_name: 'Carol',
        acct: 'carol@instance-b.test',
        url: 'https://instance-b.test/@carol',
        avatar: '',
        avatar_static: '',
      },
      content: '<p>Quote me with a link</p>',
      visibility: 'public',
      url: 'https://instance-b.test/@carol/456',
      media_attachments: [],
      mentions: [],
      tags: [],
      emojis: [],
    };
    await page.route('https://instance-b.test/api/v1/statuses/456', (route) =>
      route.fulfill({ json: status }),
    );
    await page.route(
      'https://instance-b.test/api/v1/statuses/456/context',
      (route) => route.fulfill({ json: { ancestors: [], descendants: [] } }),
    );
    await page.goto('/#/conversations/instance-b.test/456');
    await expect(page.getByText('Quote me with a link')).toBeVisible();
    await page.locator('.thread-actions button').nth(1).click(); // quote
    await expect(page.locator('#compose-container')).toBeVisible();
    // Both accounts are targets, and the composer anchors on the current
    // account (the roster lists it first), as the full app's "Quote with
    // link" — not on the quoted post's instance's account.
    await expect(
      page.locator('.cross-post-toolbar .account-picker-option'),
    ).toHaveCount(2);
    await expect(
      page.locator('.cross-post-toolbar .account-picker-option').first(),
    ).toContainText('@alice@instance-a.test');
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
