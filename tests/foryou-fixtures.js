// @ts-check
// A logged-in Mastodon account and a stubbed Mastodon server, for specs that
// open the For You page.

export const DOMAIN = 'instance-a.test';
export const ACCOUNT = {
  info: {
    id: 'me',
    username: 'alice',
    acct: `alice@${DOMAIN}`,
    displayName: 'Alice',
  },
  instanceURL: DOMAIN,
  accessToken: 'token-a',
};

export function account(id, followers) {
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

export function status(id, author, text, { minutesAgo, likes }) {
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

export const HOME = [
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

export function seed(page, { conversationMode = false } = {}) {
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

export function stubMastodon(page) {
  return page.route(`https://${DOMAIN}/**`, (route) => {
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
}
