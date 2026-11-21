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

// Both Bluesky accounts on top of the Mastodon one, for same-network
// cross-target quotes (a quote of a Bluesky post reaches every Bluesky
// account — the ids are network-global)
export function seedWithTwoBsky(page) {
  return seedAccounts(page, [ACCOUNT, BSKY_ACCOUNT, BSKY_ACCOUNT_2]);
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

// `sub` is the account's did, so each stubbed Bluesky account gets its own
// token pair (both hit the same https://bsky.social PDS stub)
export function fakeJwt(scope, sub = BSKY_DID) {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${b64({ alg: 'none', typ: 'JWT' })}.${b64({
    scope,
    sub,
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

// A second Bluesky account on the same PDS, for same-network cross-targets.
// Its did deliberately differs from any digest post's author did: For You
// drops self-authored posts, so the second account must not own the post
// the test quotes.
export const BSKY_DID_2 = 'did:plc:testerin';

const BSKY2_ACCESS_JWT = fakeJwt('com.atproto.access', BSKY_DID_2);
const BSKY2_REFRESH_JWT = fakeJwt('com.atproto.refresh', BSKY_DID_2);
export const BSKY_ACCOUNT_2 = {
  info: {
    id: BSKY_DID_2,
    username: 'erin.bsky.social',
    acct: 'erin.bsky.social',
    displayName: 'Erin',
    avatar: AVATAR,
    avatarStatic: AVATAR,
  },
  instanceURL: 'bsky.social',
  accountType: 'bluesky',
  accessToken: BSKY2_ACCESS_JWT,
  blueskySession: {
    did: BSKY_DID_2,
    handle: 'erin.bsky.social',
    accessJwt: BSKY2_ACCESS_JWT,
    refreshJwt: BSKY2_REFRESH_JWT,
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

const BSKY_PROFILE_2 = {
  did: BSKY_DID_2,
  handle: 'erin.bsky.social',
  displayName: 'Erin',
  avatar: AVATAR,
  followersCount: 10,
  followsCount: 5,
  postsCount: 100,
};

// did → session material for each stubbed Bluesky account. stubBluesky
// answers session/profile calls with the identity parsed from the
// request's bearer token, so both accounts validate against the one stub
const BSKY_SESSIONS = {
  [BSKY_DID]: {
    profile: BSKY_PROFILE,
    accessJwt: BSKY_ACCESS_JWT,
    refreshJwt: BSKY_REFRESH_JWT,
  },
  [BSKY_DID_2]: {
    profile: BSKY_PROFILE_2,
    accessJwt: BSKY2_ACCESS_JWT,
    refreshJwt: BSKY2_REFRESH_JWT,
  },
};

// The did this request is authenticated as — the bearer JWT's `sub`
function bearerDid(route) {
  const auth = route.request().headers().authorization || '';
  const payload = auth.replace(/^Bearer /, '').split('.')[1];
  if (!payload) return null;
  try {
    return JSON.parse(Buffer.from(payload, 'base64url').toString()).sub;
  } catch {
    return null;
  }
}

// Bodies of the Bluesky write endpoints, captured by stubBluesky and
// reset on every stubBluesky so tests stay independent:
// com.atproto.repo.createRecord (single posts) and applyWrites (threads)
export let bskyWrites = [];
export let bskyThreadWrites = [];

// POST bodies at the Mastodon compose endpoint, captured by
// stubMastodonPost
export let mastoPosts = [];

// Records POSTs to the Mastodon compose endpoint so a test can assert on
// the real request body. Registered after stubMastodon, so it wins for
// this exact URL while the rest of the instance keeps stubMastodon's
// replies.
export function stubMastodonPost(page) {
  mastoPosts = [];
  return page.route(`https://${DOMAIN}/api/v1/statuses`, (route) => {
    mastoPosts.push(route.request().postDataJSON());
    return route.fulfill({ json: { ...HOME[0], id: 'new1' } });
  });
}

// Stubs the Bluesky account's PDS. `feed` is an array of
// app.bsky.feed.defs#feedViewPost shapes for the home timeline; anything
// else the app asks the PDS for aborts, as stubMastodon does for the
// Mastodon instance.
export function stubBluesky(page, feed = []) {
  bskyWrites = [];
  bskyThreadWrites = [];
  const feedPosts = feed.map((item) => item.post).filter(Boolean);
  return page.route('https://bsky.social/**', (route) => {
    const url = new URL(route.request().url());
    const rpc = url.pathname.replace('/xrpc/', '');
    const did = bearerDid(route) || BSKY_DID;
    const session = BSKY_SESSIONS[did] || BSKY_SESSIONS[BSKY_DID];
    const fullSession = {
      did,
      handle: session.profile.handle,
      active: true,
      accessJwt: session.accessJwt,
      refreshJwt: session.refreshJwt,
    };
    const replies = {
      'com.atproto.server.getSession': fullSession,
      'com.atproto.server.refreshSession': fullSession,
      'app.bsky.actor.getProfile':
        BSKY_SESSIONS[url.searchParams.get('actor')]?.profile ||
        session.profile,
      'app.bsky.actor.getPreferences': { preferences: [] },
      'app.bsky.feed.getTimeline': { feed },
      'app.bsky.feed.getActorLikes': { feed: [] },
      'app.bsky.feed.getAuthorFeed': { feed: [] },
      'app.bsky.graph.getLists': { lists: [] },
      // Hydration by uri — quote resolution asks for the quoted post's cid
      'app.bsky.feed.getPosts': {
        posts: feedPosts.filter((p) =>
          url.searchParams.getAll('uris').includes(p.uri),
        ),
      },
    };
    // Write endpoints: capture the body so tests assert on the real record
    if (rpc === 'com.atproto.repo.createRecord') {
      bskyWrites.push(route.request().postDataJSON());
      return route.fulfill({
        json: { uri: `at://${did}/app.bsky.feed.post/new1`, cid: CID },
      });
    }
    if (rpc === 'com.atproto.repo.applyWrites') {
      bskyThreadWrites.push(route.request().postDataJSON());
      return route.fulfill({
        json: {
          results: [{ uri: `at://${did}/app.bsky.feed.post/new1`, cid: CID }],
        },
      });
    }
    const body = replies[rpc];
    return body ? route.fulfill({ json: body }) : route.abort();
  });
}
