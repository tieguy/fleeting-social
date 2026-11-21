// @ts-check
import { expect, test } from '@playwright/test';

// Seeding copied from tests/keyboard-shortcuts.spec.js (local helpers there,
// not exports): the logged-in test.social account, the mocked instance
// responses and the mock post factory.
const MOCK_INSTANCE_RESPONSE = {
  uri: 'test.social',
  title: 'Test Social',
  domain: 'test.social',
  version: '4.0.0',
  configuration: {
    statuses: { maxCharacters: 500, maxMediaAttachments: 4 },
    polls: {
      maxOptions: 4,
      maxCharactersPerOption: 50,
      minExpiration: 300,
      maxExpiration: 86400,
    },
    urls: { streaming: 'wss://test.social' },
  },
};

const MOCK_ACCOUNT_INFO = {
  id: '1',
  username: 'testuser',
  acct: 'testuser',
  display_name: 'Test User',
  locked: false,
  bot: false,
  discoverable: true,
  created_at: '2024-01-01T00:00:00.000Z',
  note: '<p>Test user</p>',
  url: 'https://test.social/@testuser',
  uri: 'https://test.social/users/testuser',
  avatar: 'https://test.social/avatars/test.png',
  avatar_static: 'https://test.social/avatars/test.png',
  header: 'https://test.social/headers/test.png',
  header_static: 'https://test.social/headers/test.png',
  followers_count: 100,
  following_count: 50,
  statuses_count: 500,
  last_status_at: '2024-06-01',
  emojis: [],
  roles: [],
  fields: [],
};

function createMockPost(id, index) {
  const i = index ?? 0;
  return {
    id: String(id),
    created_at: new Date(Date.now() - i * 900000).toISOString(),
    account: {
      id: '1',
      username: 'testuser',
      acct: 'testuser',
      display_name: 'Test User',
      url: 'https://test.social/@testuser',
      uri: 'https://test.social/users/testuser',
      avatar: 'https://test.social/avatar.png',
      avatar_static: 'https://test.social/avatar.png',
      header: 'https://test.social/header.png',
      header_static: 'https://test.social/header.png',
      followers_count: 100,
      following_count: 50,
      statuses_count: 200,
      last_status_at: '2024-06-01',
      emojis: [],
      fields: [],
    },
    content: `<p>Test post ${i}</p>`,
    uri: `https://test.social/users/testuser/statuses/${id}`,
    url: `https://test.social/@testuser/${id}`,
    media_attachments: [],
    mentions: [],
    tags: [],
    emojis: [],
    reblogs_count: 0,
    favourites_count: 0,
    replies_count: 0,
    sensitive: false,
    spoiler_text: '',
    visibility: 'public',
    language: 'en',
    favourited: false,
    reblogged: false,
    bookmarked: false,
    muted: false,
    pinned: false,
  };
}

async function setupLoggedInEnv(page) {
  await page.addInitScript(() => {
    const account = {
      info: {
        id: '1',
        username: 'testuser',
        acct: 'testuser',
        display_name: 'Test User',
        avatar: 'https://test.social/avatar.png',
        avatar_static: 'https://test.social/avatar.png',
        header: 'https://test.social/header.png',
        header_static: 'https://test.social/header.png',
      },
      instanceURL: 'test.social',
      accessToken: 'mock-access-token',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      lastAccessedAt: Date.now(),
    };
    localStorage.setItem('accounts', JSON.stringify([account]));
    sessionStorage.setItem('currentAccount', '1');
    localStorage.setItem(
      'preferences',
      JSON.stringify({
        '1@test.social': { 'posting:default:visibility': 'public' },
      }),
    );
    localStorage.setItem(
      'instances',
      JSON.stringify({
        'test.social': {
          uri: 'test.social',
          title: 'Test Social',
          version: '4.0.0',
          configuration: {
            statuses: { maxCharacters: 500, maxMediaAttachments: 4 },
            polls: {
              maxOptions: 4,
              maxCharactersPerOption: 50,
              minExpiration: 300,
              maxExpiration: 86400,
            },
            urls: { streaming: 'wss://test.social' },
          },
        },
      }),
    );
    localStorage.setItem(
      'credentialApplications',
      JSON.stringify({
        'test.social': {
          client_id: 'mock-client-id',
          client_secret: 'mock-client-secret',
          vapid_key: 'mock-vapid-key',
        },
      }),
    );
  });

  await page.route('**/api/v2/instance', async (route) => {
    await route.fulfill({ json: MOCK_INSTANCE_RESPONSE });
  });
  await page.route('**/api/v1/instance', async (route) => {
    await route.fulfill({ json: MOCK_INSTANCE_RESPONSE });
  });
  await page.route('**/api/v1/preferences', async (route) => {
    await route.fulfill({ json: {} });
  });
  await page.route('**/api/v1/accounts/verify_credentials', async (route) => {
    await route.fulfill({ json: MOCK_ACCOUNT_INFO });
  });
  await page.route('**/api/v1/apps/verify_credentials', async (route) => {
    await route.fulfill({ json: { name: 'Test App', website: null } });
  });
}

// The boost/quote menu has two surfaces: the action bar's rocket button
// (`.reblog-button`), which only the status page hero (size l) renders —
// timeline statuses are size m/s with no action bar, and the context menu
// there gates the boost submenu behind `sameInstance` — and the context
// menu of a non-large status. One seeded status page reaches both: the
// hero for the action bar, its reply for the context menu (the seeding
// pattern of keyboard-shortcuts.spec.js Section 10).
async function setupStatusPageEnv(page) {
  await setupLoggedInEnv(page);
  await page.route('**/api/v1/statuses/123', async (route) => {
    await route.fulfill({ json: createMockPost(123, 0) });
  });
  await page.route('**/api/v1/statuses/123/context', async (route) => {
    await route.fulfill({
      json: {
        ancestors: [],
        descendants: [
          {
            ...createMockPost(124, 1),
            descendant: true,
            in_reply_to_id: '123',
            in_reply_to_account_id: '1',
          },
        ],
      },
    });
  });
  await page.route('**/api/v1/timelines/home**', async (route) => {
    await route.fulfill({ json: [] });
  });
  await page.goto('/#/test.social/s/123');
  await page.waitForSelector('article.status', { timeout: 15000 });
}

test('action-bar rocket opens the boost/quote menu', async ({ page }) => {
  await setupStatusPageEnv(page);
  await page.locator('.reblog-button').click();
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
  await setupStatusPageEnv(page);
  // The context menu binds on non-large statuses — the hero is size l —
  // so right-click the reply's content.
  const reply = page.locator('article.status:not(.large)').first();
  await reply.locator('.content').click({ button: 'right' });
  // Non-native instance, no reblogs/quotes → the submenu entry reads "Boost…"
  await page.getByText('Boost…').click();
  await expect(
    page.getByRole('menuitem', { name: 'Quote with link' }),
  ).toBeVisible();
  await expect(
    page.getByRole('menuitem', { name: 'Quote without attribution' }),
  ).toBeVisible();
});
