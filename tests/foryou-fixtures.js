// @ts-check
// Logged-in accounts and stubbed servers, for specs that open the For You
// page: the current Mastodon account, a second Mastodon account on another
// instance, and a Bluesky account, each with its stub.

export const AVATAR =
  'data:image/gif;base64,R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==';

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

// A second Mastodon account, for "Boost as" and compose-target tests
export const ACCOUNT_B = {
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

export function seedAccounts(
  page,
  accounts,
  { conversationMode = false } = {},
) {
  return page.addInitScript(
    ([accounts, conversationMode]) => {
      if (conversationMode) {
        localStorage.setItem('conversationModeOverride', 'on');
      }
      localStorage.setItem('accounts', JSON.stringify(accounts));
      localStorage.setItem(
        'instances',
        JSON.stringify(
          Object.fromEntries(
            accounts
              .filter((a) => a.instanceURL !== 'bsky.social')
              .map((a) => [a.instanceURL, { domain: a.instanceURL }]),
          ),
        ),
      );
      sessionStorage.setItem('currentAccount', accounts[0].info.id);
    },
    [accounts, conversationMode],
  );
}

export function seed(page, { conversationMode = false } = {}) {
  return seedAccounts(page, [ACCOUNT], { conversationMode });
}

// The current Mastodon account plus the Bluesky account: the digest then
// reads both networks (the merged timeline is on by default)
export function seedWithBsky(page) {
  return seedAccounts(page, [ACCOUNT, BSKY_ACCOUNT]);
}

// How many reblog calls hit the stubbed Mastodon server; reset on every
// stubMastodon so tests stay independent
export let reblogCalls = 0;

export function stubMastodon(page) {
  reblogCalls = 0;
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
    const boost = path.match(/^\/api\/v1\/statuses\/(\d+)\/reblog$/);
    if (boost) {
      reblogCalls++;
      const post = HOME.find((s) => s.id === boost[1]);
      return route.fulfill({
        json: { ...post, reblogged: true, reblogs_count: 2 },
      });
    }
    return route.abort();
  });
}

// The Bluesky account and its tokens, copied from
// tests/cross-account-interactions.spec.js: @atproto/api decodes JWTs
// locally to check expiry, so fake tokens must be structurally valid with a
// far-future exp, and the lexicon validates the CID's format.
export const BSKY_DID = 'did:plc:testcarol';

export function fakeJwt(scope) {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${b64({ alg: 'none', typ: 'JWT' })}.${b64({
    scope,
    sub: BSKY_DID,
    exp: 4102444800,
    iat: 1,
  })}.x`;
}

// A structurally valid CID — the lexicon validates the format
export const CID =
  'bafyreidfayvfuwqa7qlnopdjiqrxzs6blmoeu4rujcjtnci5beludirz2a';

const BSKY_ACCESS_JWT = fakeJwt('com.atproto.access');
const BSKY_REFRESH_JWT = fakeJwt('com.atproto.refresh');
export const BSKY_ACCOUNT = {
  info: {
    id: BSKY_DID,
    username: 'carol.bsky.social',
    acct: 'carol.bsky.social',
    displayName: 'Carol',
    avatar: AVATAR,
    avatarStatic: AVATAR,
  },
  instanceURL: 'bsky.social',
  accountType: 'bluesky',
  accessToken: BSKY_ACCESS_JWT,
  blueskySession: {
    did: BSKY_DID,
    handle: 'carol.bsky.social',
    accessJwt: BSKY_ACCESS_JWT,
    refreshJwt: BSKY_REFRESH_JWT,
    active: true,
  },
};

const BSKY_PROFILE = {
  did: BSKY_DID,
  handle: 'carol.bsky.social',
  displayName: 'Carol',
  avatar: AVATAR,
  followersCount: 10,
  followsCount: 5,
  postsCount: 100,
};

// Stubs the Bluesky account's PDS. `feed` is an array of
// app.bsky.feed.defs#feedViewPost shapes for the home timeline; anything
// else the app asks the PDS for aborts, as stubMastodon does for the
// Mastodon instance.
export function stubBluesky(page, feed = []) {
  return page.route('https://bsky.social/**', (route) => {
    const rpc = new URL(route.request().url()).pathname.replace('/xrpc/', '');
    const session = {
      did: BSKY_DID,
      handle: 'carol.bsky.social',
      active: true,
      accessJwt: BSKY_ACCESS_JWT,
      refreshJwt: BSKY_REFRESH_JWT,
    };
    const replies = {
      'com.atproto.server.getSession': session,
      'com.atproto.server.refreshSession': session,
      'app.bsky.actor.getProfile': BSKY_PROFILE,
      'app.bsky.actor.getPreferences': { preferences: [] },
      'app.bsky.feed.getTimeline': { feed },
      'app.bsky.feed.getActorLikes': { feed: [] },
      'app.bsky.feed.getAuthorFeed': { feed: [] },
      'app.bsky.graph.getLists': { lists: [] },
    };
    const body = replies[rpc];
    return body ? route.fulfill({ json: body }) : route.abort();
  });
}
