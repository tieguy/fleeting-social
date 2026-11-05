// Bluesky client that exposes a masto.js-compatible facade, so phanpy's
// existing UI code can talk to Bluesky through the same `masto.v1.*` calls.
//
// @atproto/api is loaded lazily (all facade methods are async) so it stays
// out of the main bundle for Mastodon-only users.
import {
  CHAT_PROXY_SERVICE,
  CHAT_PROXY_TYPE,
  convoToConversation,
  messageToMessage,
} from './chat';
import {
  atUriToId,
  blueskyInstanceInfo,
  BSKY_WEB,
  didFromAtUri,
  feedItemToStatus,
  idToAtUri,
  mutedWordText,
  notificationToMasto,
  postToStatus,
  profileToAccount,
  profileToRelationship,
} from './convert';
import { repairMentionFacets, resolveHandleDid } from './facets';
import {
  areSameAuthor,
  getFeedItemAuthors,
  shouldDisplayReplyInFollowing,
} from './following-reply-filter';
import { buildExternalEmbed, firstLinkFacetUri } from './link-card';
import { firstQuotedPostLink } from './quote-link';
import { shortenLinkFacets } from './shorten-links';

const MAX_IMAGE_SIZE = 950_000; // Bluesky blob limit is ~976KB

// Bluesky's Discover ("What's Hot") feed generator
const DISCOVER_FEED =
  'at://did:plc:z72i7hdynmk6r22z27h6tvur/app.bsky.feed.generator/whats-hot';

let atprotoPromise;
export function loadAtproto() {
  return (atprotoPromise ||= import('@atproto/api'));
}

// Uploaded media blobs pending post creation, keyed by fake media ID
const pendingMedia = new Map();
let mediaCounter = 0;

// masto.js-style paginator: list() returns an async iterable whose
// .values() iterator yields pages (arrays) via .next()
function paginator(fetchPage) {
  const iterable = {
    values() {
      let cursor;
      let ended = false;
      const iterator = {
        async next() {
          if (ended) return { done: true, value: undefined };
          const { items, cursor: nextCursor } = await fetchPage(cursor);
          cursor = nextCursor;
          if (!nextCursor) ended = true;
          return { done: false, value: items };
        },
        [Symbol.asyncIterator]() {
          return this;
        },
      };
      return iterator;
    },
    [Symbol.asyncIterator]() {
      return this.values();
    },
  };
  return iterable;
}

async function resizeImage(file, type = 'image/jpeg') {
  const bitmap = await createImageBitmap(file);
  let { width, height } = bitmap;
  const maxDim = 2048;
  if (width > maxDim || height > maxDim) {
    const scale = maxDim / Math.max(width, height);
    width = Math.round(width * scale);
    height = Math.round(height * scale);
  }
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  canvas.getContext('2d').drawImage(bitmap, 0, 0, width, height);
  for (const quality of [0.9, 0.8, 0.7, 0.6, 0.5]) {
    const blob = await new Promise((resolve) =>
      canvas.toBlob(resolve, type, quality),
    );
    if (blob && blob.size <= MAX_IMAGE_SIZE) return blob;
  }
  throw new Error('Unable to compress image below Bluesky size limit');
}

export async function prepareImageForBluesky(file) {
  const supported = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
  if (supported.includes(file.type) && file.size <= MAX_IMAGE_SIZE) {
    return file;
  }
  return await resizeImage(file);
}

async function getImageDimensions(blob) {
  try {
    const bitmap = await createImageBitmap(blob);
    const dim = { width: bitmap.width, height: bitmap.height };
    bitmap.close?.();
    return dim;
  } catch (e) {
    return null;
  }
}

export function createBlueskyClient({
  service,
  instance,
  session,
  did,
  onSessionChange,
  getStoredSession, // () => latest persisted session for this account
  onAuthExpired, // auth is terminally dead; only a fresh login can fix it
}) {
  let agent = null;

  // Refresh tokens are single-use (rotated), so a refresh token that failed
  // terminally must not be retried on every call — but a *different* token
  // appearing in the store (another tab/window rotated it, or the user logged
  // in again) means the account is alive again.
  let deadRefreshJwt = null;
  // The refresh token the agent currently holds, tracked so an in-flight
  // 'expired' event (which carries no session) can record which token died.
  let lastRefreshJwt = session?.refreshJwt || null;

  function expiredError() {
    return new Error(
      'Your Bluesky session has expired. Please log in to this account again.',
    );
  }

  let resumePromise = null;
  async function ready() {
    if (!agent) {
      const { AtpAgent } = await loadAtproto();
      agent = new AtpAgent({
        service,
        persistSession: (evt, sess) => {
          if (evt === 'update' || evt === 'create') {
            lastRefreshJwt = sess?.refreshJwt || lastRefreshJwt;
            deadRefreshJwt = null;
            onSessionChange?.(sess);
          } else if (evt === 'expired' || evt === 'create-failed') {
            console.warn('Bluesky session', evt);
            deadRefreshJwt = lastRefreshJwt;
            // Allow a future revival (newer stored token) to actually resume
            resumePromise = null;
            // Terminal only if the store has no newer token to revive from.
            // The client stays registered: ready() re-reads the store and
            // revives if a fresh login/rotation lands there.
            const stored = getStoredSession?.();
            if (!stored?.refreshJwt || stored.refreshJwt === deadRefreshJwt) {
              onAuthExpired?.();
            }
          }
          // 'network-error' is transient: the agent keeps its session and
          // the next request retries the refresh
        },
      });
      // A response that is still 401 after the agent's own refresh attempt
      // can mean the agent kept a session the server no longer accepts: it
      // treats every refresh failure other than 401, ExpiredToken and
      // InvalidToken as transient. proveSession() settles it.
      const manager = agent.sessionManager;
      if (typeof manager?.fetchHandler === 'function') {
        const inner = manager.fetchHandler.bind(manager);
        manager.fetchHandler = async (url, init) => {
          const res = await inner(url, init);
          if (res.status === 401) checkSession();
          return res;
        };
      }
    }
    if (agent.hasSession) return;
    // Always resume from the *stored* session, not the snapshot this client
    // was created with — another tab/window may have rotated the tokens since
    const stored = getStoredSession?.() || session;
    if (!stored?.refreshJwt) {
      onAuthExpired?.();
      throw expiredError();
    }
    if (stored.refreshJwt === deadRefreshJwt) throw expiredError();
    if (!resumePromise) {
      lastRefreshJwt = stored.refreshJwt;
      resumePromise = agent.resumeSession(stored).catch((e) => {
        resumePromise = null;
        throw e;
      });
    }
    await resumePromise;
  }

  // Proves a session dead with one explicit refresh, at most once a minute.
  // Only the server refusing the refresh token counts: a network failure, a
  // rate limit (429) or a server error (5xx) proves nothing. A successful
  // refresh persists an 'update', which also clears authExpired. A newer
  // token in the store (another tab, a fresh login) wins over the failure.
  const SESSION_CHECK_INTERVAL = 60 * 1000;
  let sessionCheck = null;
  let lastSessionCheck = 0;
  function checkSession() {
    if (sessionCheck) return sessionCheck;
    if (Date.now() - lastSessionCheck < SESSION_CHECK_INTERVAL) return null;
    lastSessionCheck = Date.now();
    sessionCheck = proveSession().finally(() => {
      sessionCheck = null;
    });
    return sessionCheck;
  }
  async function proveSession() {
    const held = agent?.session;
    // No session held: the 'expired' handler already decided
    if (!held?.refreshJwt) return;
    try {
      await agent.sessionManager.refreshSession();
    } catch (e) {
      const status = e?.status;
      if (!(status >= 400 && status < 500) || status === 429) return;
      // A 401 refusal already fired 'expired' and dropped the session
      if (!agent.session) return;
      const stored = getStoredSession?.();
      if (stored?.refreshJwt && stored.refreshJwt !== held.refreshJwt) return;
      deadRefreshJwt = held.refreshJwt;
      agent.sessionManager.session = undefined;
      resumePromise = null;
      onAuthExpired?.();
    }
  }

  // Adopt a token rotation persisted by another tab/window (no network).
  // Keeping the in-memory session current prevents this context from
  // refreshing with a stale, already-rotated (hence revoked) token.
  function adoptSession(newSession) {
    if (!newSession?.refreshJwt || !newSession?.accessJwt) return;
    if (deadRefreshJwt && deadRefreshJwt !== newSession.refreshJwt) {
      deadRefreshJwt = null;
    }
    if (!agent || newSession.refreshJwt === agent.session?.refreshJwt) return;
    agent.sessionManager.session = { ...newSession };
    lastRefreshJwt = newSession.refreshJwt;
  }

  function agentDid() {
    return agent?.did || agent?.session?.did || did;
  }

  // Caches to map AT-URIs back to data needed for actions
  const cids = new Map(); // uri → cid
  const likeUris = new Map(); // post uri → viewer's like record uri
  const repostUris = new Map(); // post uri → viewer's repost record uri
  const followUris = new Map(); // did → viewer's follow record uri
  const statusCache = new Map(); // uri → last converted status

  function toStatus(post) {
    const status = postToStatus(post, instance);
    if (status) statusCache.set(post.uri, status);
    return status;
  }

  function toFeedStatus(item) {
    const status = feedItemToStatus(item, instance);
    if (status?.reblog) statusCache.set(status.reblog.uri, status.reblog);
    else if (status) statusCache.set(status.uri, status);
    return status;
  }

  // After an action succeeds, return a fresh status; if the refetch fails,
  // fall back to the cached conversion with the change applied so callers
  // always get a usable status object
  async function statusAfterAction(uri, changes) {
    try {
      return await refreshedStatus(uri);
    } catch (e) {
      const cached = statusCache.get(uri);
      if (cached) {
        const updated = { ...cached, ...changes };
        statusCache.set(uri, updated);
        return updated;
      }
      throw e;
    }
  }

  // ----- Preferences (muted words, feed view prefs) -----
  const PREFS_TTL = 5 * 60 * 1000;
  let prefsCache = null; // { prefs, fetchedAt }
  async function getPrefs(force) {
    if (!force && prefsCache && Date.now() - prefsCache.fetchedAt < PREFS_TTL) {
      return prefsCache.prefs;
    }
    try {
      const prefs = await agent.getPreferences();
      prefsCache = { prefs, fetchedAt: Date.now() };
    } catch (e) {
      console.error(e);
      prefsCache = { prefs: null, fetchedAt: Date.now() };
    }
    return prefsCache.prefs;
  }

  async function getMutedWords(force) {
    const prefs = await getPrefs(force);
    return prefs?.moderationPrefs?.mutedWords || [];
  }

  // Following-feed preferences, same ones the official app sets under
  // Settings → Content and media (enforced client-side by every client)
  async function getFeedViewPrefs(force) {
    await ready();
    const prefs = await getPrefs(force);
    return prefs?.feedViewPrefs?.home || {};
  }

  async function setFeedViewPrefs(pref) {
    await ready();
    await agent.setFeedViewPrefs('home', pref);
    await getPrefs(true);
  }

  const FILTER_CONTEXTS = [
    'home',
    'notifications',
    'public',
    'thread',
    'account',
  ];
  function mutedWordToFilter(word) {
    const id = word.id || word.value;
    return {
      id,
      title: word.value,
      context: FILTER_CONTEXTS,
      expiresAt: word.expiresAt || null,
      filterAction: 'hide',
      keywords: [
        {
          id,
          keyword: word.value,
          wholeWord: !/\s/.test(word.value),
        },
      ],
    };
  }

  function escapeRegExp(str) {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  // Bluesky applies muted words client-side, against the post text, tags,
  // link card, image alt text, and the same parts of a quoted post; stamp Mastodon-style
  // `filtered` results so phanpy's existing filter UI handles them
  function applyMutedWords(status, words) {
    const target = status?.reblog || status;
    if (!target || !words?.length) return status;
    const text = mutedWordText(target);
    const matches = [];
    for (const word of words) {
      if (word.expiresAt && Date.parse(word.expiresAt) < Date.now()) continue;
      const value = word.value;
      let matched;
      if (/\s/.test(value)) {
        matched = text.toLowerCase().includes(value.toLowerCase());
      } else {
        try {
          matched = new RegExp(
            `(?:^|[^\\p{L}\\p{N}#])${escapeRegExp(value)}(?:$|[^\\p{L}\\p{N}])`,
            'iu',
          ).test(text);
        } catch (e) {
          matched = text.toLowerCase().includes(value.toLowerCase());
        }
      }
      if (matched) matches.push(word);
    }
    if (matches.length) {
      target.filtered = matches.map((word) => {
        const { keywords, ...filter } = mutedWordToFilter(word);
        return {
          filter,
          keywordMatches: [word.value],
          statusMatches: null,
        };
      });
    }
    return status;
  }

  async function withMutedWords(statuses) {
    try {
      const words = await getMutedWords();
      if (words.length) {
        for (const status of statuses) {
          if (status) applyMutedWords(status, words);
        }
      }
    } catch (e) {
      console.error(e);
    }
    return statuses;
  }

  // ----- Lists -----
  const LIST_COLLECTION = 'app.bsky.graph.list';
  const LISTITEM_COLLECTION = 'app.bsky.graph.listitem';
  const listItemUris = new Map(); // `${listUri}|${memberDid}` → listitem record uri

  function listViewToMasto(list) {
    return {
      id: atUriToId(list.uri),
      title: list.name,
      repliesPolicy: 'list',
      exclusive: false,
      _bluesky: true,
    };
  }

  // Bluesky custom feeds (feed generators) have no Mastodon equivalent, so we
  // surface the ones the user has subscribed to as list-shaped entries (marked
  // `_feed`) — they render on the Lists page and their timeline is fetched with
  // getFeed instead of getListFeed.
  const FEED_GEN_COLLECTION = 'app.bsky.feed.generator';
  function isFeedGenId(id) {
    return idToAtUri(id).includes(`/${FEED_GEN_COLLECTION}/`);
  }
  function feedGenViewToMasto(view) {
    return {
      id: atUriToId(view.uri),
      title: view.displayName || 'Feed',
      repliesPolicy: 'list',
      exclusive: false,
      _bluesky: true,
      _feed: true,
    };
  }
  async function getSavedFeedGenerators() {
    try {
      const prefs = await getPrefs();
      const saved = (prefs?.savedFeeds || []).filter((f) => f.type === 'feed');
      if (!saved.length) return [];
      const res = await agent.app.bsky.feed.getFeedGenerators({
        feeds: saved.map((f) => f.value),
      });
      const byUri = new Map((res.data.feeds || []).map((v) => [v.uri, v]));
      // Preserve the user's saved order, pinned feeds first (stable sort).
      const items = saved
        .map((f) => ({ f, view: byUri.get(f.value) }))
        .filter((x) => x.view);
      items.sort((a, b) => (b.f.pinned ? 1 : 0) - (a.f.pinned ? 1 : 0));
      return items.map((x) => feedGenViewToMasto(x.view));
    } catch (e) {
      console.error('Failed to fetch saved Bluesky feeds', e);
      return [];
    }
  }

  async function findListItemUri(listUri, memberDid) {
    const key = `${listUri}|${memberDid}`;
    if (listItemUris.has(key)) return listItemUris.get(key);
    let cursor;
    for (let page = 0; page < 10; page++) {
      const res = await agent.app.bsky.graph.getList({
        list: listUri,
        limit: 100,
        cursor,
      });
      for (const item of res.data.items || []) {
        listItemUris.set(`${listUri}|${item.subject.did}`, item.uri);
      }
      if (listItemUris.has(key)) return listItemUris.get(key);
      cursor = res.data.cursor;
      if (!cursor) break;
    }
    return null;
  }

  function trackPost(post) {
    if (!post?.uri) return;
    cids.set(post.uri, post.cid);
    if (post.viewer) {
      if (post.viewer.like) likeUris.set(post.uri, post.viewer.like);
      else likeUris.delete(post.uri);
      if (post.viewer.repost) repostUris.set(post.uri, post.viewer.repost);
      else repostUris.delete(post.uri);
    }
  }

  function trackProfile(profile) {
    if (!profile?.did) return;
    if (profile.viewer?.following) {
      followUris.set(profile.did, profile.viewer.following);
    } else if (profile.viewer) {
      followUris.delete(profile.did);
    }
  }

  function trackFeedItem(item) {
    trackPost(item.post);
    trackProfile(item.post?.author);
    if (item.reply) {
      trackPost(item.reply.parent);
      trackPost(item.reply.root);
    }
  }

  async function fetchPost(uri) {
    await ready();
    const res = await agent.getPosts({ uris: [uri] });
    const post = res.data.posts[0];
    if (!post) throw new Error('Post not found');
    trackPost(post);
    return post;
  }

  async function refreshedStatus(uri) {
    const post = await fetchPost(uri);
    return toStatus(post);
  }

  async function resolveCid(uri) {
    if (cids.has(uri)) return cids.get(uri);
    const post = await fetchPost(uri);
    return post.cid;
  }

  async function hydrateNotifications(notifications) {
    // Hydrate subject posts (for likes/reposts: the liked post;
    // for replies/mentions/quotes: the post itself)
    const uris = new Set();
    for (const n of notifications) {
      const subject =
        n.reason === 'like' || n.reason === 'repost'
          ? n.reasonSubject
          : ['reply', 'mention', 'quote'].includes(n.reason)
            ? n.uri
            : null;
      if (subject) uris.add(subject);
    }
    const posts = new Map();
    const uriList = [...uris];
    for (let i = 0; i < uriList.length; i += 25) {
      try {
        const res = await agent.getPosts({ uris: uriList.slice(i, i + 25) });
        for (const post of res.data.posts) {
          trackPost(post);
          posts.set(post.uri, toStatus(post));
        }
      } catch (e) {
        console.error(e);
      }
    }
    return notifications
      .map((n) => {
        const subjectUri =
          n.reason === 'like' || n.reason === 'repost'
            ? n.reasonSubject
            : n.uri;
        return notificationToMasto(n, instance, posts.get(subjectUri));
      })
      .filter(Boolean);
  }

  function statusEndpoints(id) {
    const uri = idToAtUri(id);
    return {
      async fetch() {
        await ready();
        return await refreshedStatus(uri);
      },
      async remove() {
        await ready();
        await agent.deletePost(uri);
        return { id, _deleted: true };
      },
      async update() {
        throw new Error('Editing posts is not supported on Bluesky');
      },
      async favourite() {
        await ready();
        const cid = await resolveCid(uri);
        const res = await agent.like(uri, cid);
        likeUris.set(uri, res.uri);
        return await statusAfterAction(uri, {
          favourited: true,
          _likeUri: res.uri,
        });
      },
      async unfavourite() {
        await ready();
        let likeUri = likeUris.get(uri);
        if (!likeUri) {
          const post = await fetchPost(uri);
          likeUri = post.viewer?.like;
        }
        if (likeUri) await agent.deleteLike(likeUri);
        likeUris.delete(uri);
        return await statusAfterAction(uri, {
          favourited: false,
          _likeUri: null,
        });
      },
      async reblog() {
        await ready();
        const cid = await resolveCid(uri);
        const res = await agent.repost(uri, cid);
        repostUris.set(uri, res.uri);
        const status = await statusAfterAction(uri, {
          reblogged: true,
          _repostUri: res.uri,
        });
        // masto's reblog() returns a boost wrapper with .reblog
        return {
          id: `${id}+repost+${agentDid()}`,
          reblog: status,
          _bluesky: true,
          _instance: instance,
        };
      },
      async unreblog() {
        await ready();
        let repostUri = repostUris.get(uri);
        if (!repostUri) {
          const post = await fetchPost(uri);
          repostUri = post.viewer?.repost;
        }
        if (repostUri) await agent.deleteRepost(repostUri);
        repostUris.delete(uri);
        return await statusAfterAction(uri, {
          reblogged: false,
          _repostUri: null,
        });
      },
      async bookmark() {
        await ready();
        const cid = await resolveCid(uri);
        await agent.app.bsky.bookmark.createBookmark({ uri, cid });
        return await statusAfterAction(uri, { bookmarked: true });
      },
      async unbookmark() {
        await ready();
        await agent.app.bsky.bookmark.deleteBookmark({ uri });
        return await statusAfterAction(uri, { bookmarked: false });
      },
      async mute() {
        await ready();
        const post = await fetchPost(uri);
        const root = post.record?.reply?.root?.uri || uri;
        await agent.app.bsky.graph.muteThread({ root });
        const status = toStatus(post);
        if (status) status.muted = true;
        return status;
      },
      async unmute() {
        await ready();
        const post = await fetchPost(uri);
        const root = post.record?.reply?.root?.uri || uri;
        await agent.app.bsky.graph.unmuteThread({ root });
        const status = toStatus(post);
        if (status) status.muted = false;
        return status;
      },
      async pin() {
        throw new Error('Pinning is not supported here yet');
      },
      async unpin() {
        throw new Error('Unpinning is not supported here yet');
      },
      context: {
        fetch: async () => {
          await ready();
          const res = await agent.getPostThread({
            uri,
            depth: 15,
            parentHeight: 30,
          });
          const thread = res.data.thread;
          const ancestors = [];
          const descendants = [];
          // Walk up the parent chain
          let parent = thread?.parent;
          while (parent) {
            if (parent.post) {
              trackFeedItem(parent);
              const status = toStatus(parent.post);
              if (status) ancestors.unshift(status);
            }
            parent = parent.parent;
          }
          // Walk down replies, depth-first (phanpy rebuilds nesting
          // from inReplyToId)
          const walkReplies = (replies) => {
            for (const reply of replies || []) {
              if (reply.post) {
                trackFeedItem(reply);
                const status = toStatus(reply.post);
                if (status) descendants.push(status);
                walkReplies(reply.replies);
              }
            }
          };
          walkReplies(thread?.replies);
          if (thread?.post) trackPost(thread.post);
          return { ancestors, descendants };
        },
      },
      favouritedBy: {
        list: ({ limit = 40 } = {}) =>
          paginator(async (cursor) => {
            await ready();
            const res = await agent.getLikes({ uri, limit, cursor });
            return {
              items: res.data.likes.map((like) =>
                profileToAccount(like.actor, instance),
              ),
              cursor: res.data.cursor,
            };
          }),
      },
      rebloggedBy: {
        list: ({ limit = 40 } = {}) =>
          paginator(async (cursor) => {
            await ready();
            const res = await agent.getRepostedBy({ uri, limit, cursor });
            return {
              items: res.data.repostedBy.map((p) =>
                profileToAccount(p, instance),
              ),
              cursor: res.data.cursor,
            };
          }),
      },
      // Mastodon's quotes endpoint (API v7+); on Bluesky quotes are native and
      // app.bsky.feed.getQuotes returns the quoting posts themselves, so this
      // yields statuses rather than accounts — same as masto.js.
      quotes: {
        list: ({ limit = 20 } = {}) =>
          paginator(async (cursor) => {
            await ready();
            const res = await agent.app.bsky.feed.getQuotes({
              uri,
              limit,
              cursor,
            });
            return {
              items: (res.data.posts || []).map(toStatus).filter(Boolean),
              cursor: res.data.cursor,
            };
          }),
      },
      history: {
        list: async () => [],
      },
      source: {
        fetch: async () => {
          const post = await fetchPost(uri);
          return {
            id,
            text: post.record?.text || '',
            spoilerText: '',
          };
        },
      },
    };
  }

  // Builds the reply refs for a post replying to inReplyToId (a masto-shaped
  // Bluesky id). Used by createStatus and (Phase 3) createThread.
  async function buildReplyRefs(inReplyToId) {
    const parentUri = idToAtUri(inReplyToId);
    const parentPost = await fetchPost(parentUri);
    const parentRef = { uri: parentPost.uri, cid: parentPost.cid };
    const rootRef = parentPost.record?.reply?.root || parentRef;
    return { root: rootRef, parent: parentRef };
  }

  // A pasted bsky.app post URL means a quote. Bluesky unfurls nothing
  // server-side, so a client that sends such a URL as an external link card
  // (which is what the link-card path below would do with any URL) produces
  // something that renders like a quote but is not one: the quoted post's
  // quoteCount stays put and the post never shows up in its quote list.
  // Best-effort — if the URL names a post we cannot resolve, return null and
  // let the link card handle it, exactly as before.
  async function quoteEmbedFromLinks(facets) {
    const target = firstQuotedPostLink(facets);
    if (!target) return null;
    try {
      const targetDid = target.actor.startsWith('did:')
        ? target.actor
        : await resolveHandleDid(target.actor);
      if (!targetDid) return null;
      const quoteUri = `at://${targetDid}/app.bsky.feed.post/${target.rkey}`;
      const cid = await resolveCid(quoteUri);
      if (!cid) return null;
      return {
        $type: 'app.bsky.embed.record',
        record: { uri: quoteUri, cid },
      };
    } catch (e) {
      console.warn('Posting a linked post as a link, not a quote:', e);
      return null;
    }
  }

  // Builds a complete app.bsky.feed.post record from masto-shaped params —
  // everything EXCEPT reply refs (callers attach those). Shared by
  // createStatus and (Phase 3) createThread.
  async function buildPostRecord(params) {
    await ready();

    const {
      status: text,
      spoiler_text: spoilerText,
      language,
      sensitive,
      poll,
      media_ids: mediaIds,
      quoted_status_id: quotedStatusId,
      scheduled_at: scheduledAt,
    } = params;
    if (poll) {
      throw new Error('Polls are not supported on Bluesky');
    }
    if (scheduledAt) {
      throw new Error('Scheduled posts are not supported on Bluesky');
    }

    let fullText = text || '';
    if (spoilerText) {
      fullText = `CW: ${spoilerText}\n\n${fullText}`;
    }

    const { RichText } = await loadAtproto();
    const rt = new RichText({ text: fullText });
    await rt.detectFacets(agent);
    // Shorten each link's display text (the full URL stays in the facet's
    // `uri`) — the 300-grapheme limit counts literal text, and this is what
    // the official app does, so it's also what the compose counter assumes.
    const { text: shortenedText, facets: shortenedFacets } = shortenLinkFacets(
      rt.text,
      rt.facets,
    );
    // detectFacets leaves `did: ''` on every mention it could not resolve, and
    // the PDS rejects the whole record over it. Retry, then drop the rest.
    const { facets, unresolved } = await repairMentionFacets(
      shortenedText,
      shortenedFacets,
    );
    if (unresolved.length) {
      console.warn('Posting without unresolvable mentions:', unresolved);
    }

    const record = {
      $type: 'app.bsky.feed.post',
      text: shortenedText,
      facets,
      createdAt: new Date().toISOString(),
    };
    if (language) record.langs = [language];
    if (sensitive) {
      record.labels = {
        $type: 'com.atproto.label.defs#selfLabels',
        values: [{ val: 'graphic-media' }],
      };
    }

    // Embeds: images and/or quote
    let mediaEmbed = null;
    const images = (mediaIds || [])
      .map((mid) => pendingMedia.get(mid))
      .filter(Boolean);
    if (images.length) {
      mediaEmbed = {
        $type: 'app.bsky.embed.images',
        images: images.map(({ blob, alt, aspectRatio }) => ({
          image: blob,
          alt: alt || '',
          ...(aspectRatio ? { aspectRatio } : {}),
        })),
      };
    }
    let recordEmbed = null;
    if (quotedStatusId) {
      const quoteUri = idToAtUri(quotedStatusId);
      const cid = await resolveCid(quoteUri);
      recordEmbed = {
        $type: 'app.bsky.embed.record',
        record: { uri: quoteUri, cid },
      };
    } else {
      recordEmbed = await quoteEmbedFromLinks(facets);
    }
    if (mediaEmbed && recordEmbed) {
      record.embed = {
        $type: 'app.bsky.embed.recordWithMedia',
        media: mediaEmbed,
        record: recordEmbed,
      };
    } else if (mediaEmbed) {
      record.embed = mediaEmbed;
    } else if (recordEmbed) {
      record.embed = recordEmbed;
    }

    // Link card: when the text carries a URL and there's no other embed, attach
    // an external card so shared links render as a rich preview. Best-effort —
    // any failure just posts without a card. Skipped for image/quote posts,
    // since an external embed can't coexist with them in the same slot.
    // A post URL never reaches this point: quoteEmbedFromLinks claimed it
    // above, unless the post it names could not be resolved.
    if (!record.embed) {
      const linkUrl = firstLinkFacetUri(facets);
      if (linkUrl) {
        const externalEmbed = await buildExternalEmbed(agent, linkUrl);
        if (externalEmbed) record.embed = externalEmbed;
      }
    }

    return record;
  }

  // Converts a posted record (uri, cid) to a Mastodon-shaped status.
  // Handles cid bookkeeping and fallback to local conversion if
  // the AppView hasn't indexed the post yet.
  async function toReturnedStatus(uri, cid, record) {
    cids.set(uri, cid);

    // Return the created post as a Mastodon-shaped status
    try {
      return await refreshedStatus(uri);
    } catch (e) {
      // AppView may not have indexed it yet — build locally
      const profile = {
        did: agentDid(),
        handle: agent.session?.handle || '',
      };
      const status = postToStatus(
        {
          uri,
          cid,
          author: profile,
          record,
          indexedAt: record.createdAt,
        },
        instance,
      );
      return status;
    }
  }

  async function createStatus(params) {
    await ready();
    const record = await buildPostRecord(params);
    if (params.in_reply_to_id) {
      record.reply = await buildReplyRefs(params.in_reply_to_id);
    }
    const res = await agent.post(record);
    for (const mid of params.media_ids || []) pendingMedia.delete(mid);
    return await toReturnedStatus(res.uri, res.cid, record);
  }

  // Atomically create an N-post self-thread via com.atproto.repo.applyWrites.
  // All-or-nothing: on failure, nothing is posted. paramsList entries are the
  // same masto-shaped params accepted by createStatus; only the first may
  // carry in_reply_to_id; quoted_status_id works per-segment and is ignored
  // in posts following the first.
  async function createThread(paramsList) {
    if (!Array.isArray(paramsList) || paramsList.length === 0) {
      throw new Error('createThread: empty paramsList');
    }
    if (paramsList.length === 1) {
      return [await createStatus(paramsList[0])];
    }

    // Enforce contract: only the first entry may carry in_reply_to_id
    for (let i = 1; i < paramsList.length; i++) {
      if (paramsList[i].in_reply_to_id) {
        throw new Error(
          `createThread: only the first post may carry in_reply_to_id (found at index ${i})`,
        );
      }
    }

    const { buildThreadWrites } = await import('./thread-writes');
    await ready();
    const did = agentDid();

    // Determine initial reply ref if this thread is a reply
    // Do this BEFORE building records so we fail fast if the reply target is deleted
    let initialReply;
    if (paramsList[0].in_reply_to_id) {
      initialReply = await buildReplyRefs(paramsList[0].in_reply_to_id);
    }

    // Build all records
    const records = [];
    const baseTime = Date.now();
    for (let i = 0; i < paramsList.length; i++) {
      const record = await buildPostRecord(paramsList[i]);
      // Monotonic createdAt (+1ms per post): identical timestamps cause
      // undefined feed ordering (atproto issue #3027).
      record.createdAt = new Date(baseTime + i).toISOString();
      records.push(record);
    }

    // Build writes and posts using the pure orchestration function
    const { writes, posts } = await buildThreadWrites({
      did,
      records,
      initialReply,
    });

    const res = await agent.com.atproto.repo.applyWrites({
      repo: did,
      writes,
      validate: true,
    });

    // Ground-truth check: the server's applyWrites results carry the real
    // CIDs. A mismatch means our local computeCid is wrong — the thread's
    // internal reply refs are then broken (posts reference nonexistent CIDs)
    // and would silently vanish from thread views. Warn loudly and prefer
    // the server's values for everything downstream.
    const results = res?.data?.results || [];
    if (results.length && results.length !== posts.length) {
      console.warn('createThread: server results length mismatch', {
        expected: posts.length,
        got: results.length,
      });
    }
    for (let i = 0; i < posts.length; i++) {
      const serverCid = results[i]?.cid;
      const serverUri = results[i]?.uri;
      if (serverCid && serverCid !== posts[i].cid) {
        console.warn(
          'createThread: computed CID mismatch — reply refs may be broken',
          { index: i, computed: posts[i].cid, server: serverCid },
        );
        posts[i].cid = serverCid;
      }
      if (serverUri && serverUri !== posts[i].uri) {
        console.warn('createThread: computed URI mismatch', {
          index: i,
          computed: posts[i].uri,
          server: serverUri,
        });
        posts[i].uri = serverUri;
      }
    }

    // Post-success bookkeeping: consumed media ids leave pendingMedia,
    // mirroring createStatus cleanup after agent.post.
    for (const params of paramsList) {
      for (const mid of params.media_ids || []) pendingMedia.delete(mid);
    }

    // Parallelize status construction
    const statuses = await Promise.all(
      posts.map(({ uri, cid, record }) => toReturnedStatus(uri, cid, record)),
    );
    return statuses;
  }

  async function uploadMedia(params) {
    await ready();
    const { file, description } = params;
    if (!/^image\//.test(file.type)) {
      throw new Error(
        'Only images can be uploaded to Bluesky from here for now',
      );
    }
    const prepared = await prepareImageForBluesky(file);
    const bytes = new Uint8Array(await prepared.arrayBuffer());
    const res = await agent.uploadBlob(bytes, {
      encoding: prepared.type || file.type,
    });
    const dim = await getImageDimensions(prepared);
    const id = `bsky-media-${++mediaCounter}`;
    pendingMedia.set(id, {
      blob: res.data.blob,
      alt: description || '',
      aspectRatio: dim ? { width: dim.width, height: dim.height } : undefined,
    });
    return {
      id,
      type: 'image',
      url: null,
      previewUrl: null,
      description: description || '',
    };
  }

  function accountEndpoints(id) {
    // id is a DID (or handle via lookup flows)
    // Return a FULL relationship object after each action (the UI replaces its
    // whole relationship state with what we return, so a partial object would
    // wipe the other flags). Re-read the profile, then apply the change we just
    // made on top in case the read is momentarily stale.
    async function relationshipAfter(overrides) {
      try {
        const res = await agent.getProfile({ actor: id });
        trackProfile(res.data);
        return { ...profileToRelationship(res.data), ...overrides };
      } catch (e) {
        return { id, ...overrides };
      }
    }
    return {
      async fetch() {
        await ready();
        const res = await agent.getProfile({ actor: id });
        trackProfile(res.data);
        return profileToAccount(res.data, instance);
      },
      statuses: {
        list: ({
          limit = 20,
          onlyMedia,
          only_media,
          excludeReplies,
          exclude_replies,
          excludeReblogs,
          exclude_reblogs,
          pinned,
        } = {}) =>
          paginator(async (cursor) => {
            if (pinned) return { items: [], cursor: null };
            await ready();
            const media = onlyMedia ?? only_media;
            const noReplies = excludeReplies ?? exclude_replies;
            const noReblogs = excludeReblogs ?? exclude_reblogs;
            const filter = media
              ? 'posts_with_media'
              : noReplies
                ? 'posts_and_author_threads'
                : 'posts_with_replies';
            const res = await agent.getAuthorFeed({
              actor: id,
              limit,
              cursor,
              filter,
            });
            let feed = res.data.feed;
            if (noReblogs) {
              feed = feed.filter((item) => !item.reason);
            }
            feed.forEach(trackFeedItem);
            return {
              items: feed.map(toFeedStatus).filter(Boolean),
              cursor: res.data.cursor,
            };
          }),
      },
      async follow() {
        await ready();
        const res = await agent.follow(id);
        followUris.set(id, res.uri);
        return relationshipAfter({ following: true, requested: false });
      },
      async unfollow() {
        await ready();
        let followUri = followUris.get(id);
        if (!followUri) {
          const res = await agent.getProfile({ actor: id });
          followUri = res.data.viewer?.following;
        }
        if (followUri) await agent.deleteFollow(followUri);
        followUris.delete(id);
        return relationshipAfter({ following: false, requested: false });
      },
      async mute() {
        await ready();
        await agent.mute(id);
        return relationshipAfter({ muting: true });
      },
      async unmute() {
        await ready();
        await agent.unmute(id);
        return relationshipAfter({ muting: false });
      },
      async block() {
        await ready();
        await agent.app.bsky.graph.block.create(
          { repo: agentDid() },
          {
            subject: id,
            createdAt: new Date().toISOString(),
          },
        );
        return relationshipAfter({ blocking: true });
      },
      async unblock() {
        await ready();
        const res = await agent.getProfile({ actor: id });
        const blockUri = res.data.viewer?.blocking;
        if (blockUri) {
          const rkey = blockUri.split('/').pop();
          await agent.app.bsky.graph.block.delete({
            repo: agentDid(),
            rkey,
          });
        }
        return relationshipAfter({ blocking: false });
      },
      async removeFromFollowers() {
        // Bluesky has no "remove follower" primitive.
        throw new Error('Removing followers is not supported on Bluesky');
      },
      followers: {
        list: ({ limit = 40 } = {}) =>
          paginator(async (cursor) => {
            await ready();
            const res = await agent.getFollowers({ actor: id, limit, cursor });
            return {
              items: res.data.followers.map((p) =>
                profileToAccount(p, instance),
              ),
              cursor: res.data.cursor,
            };
          }),
      },
      following: {
        list: ({ limit = 40 } = {}) =>
          paginator(async (cursor) => {
            await ready();
            const res = await agent.getFollows({ actor: id, limit, cursor });
            return {
              items: res.data.follows.map((p) => profileToAccount(p, instance)),
              cursor: res.data.cursor,
            };
          }),
      },
      featuredTags: {
        list: async () => [],
      },
      lists: {
        // Lists (of mine) that contain this account — Bluesky has no
        // direct lookup, so scan my curate lists' members
        list: async () => {
          await ready();
          const res = await agent.app.bsky.graph.getLists({
            actor: agentDid(),
            limit: 50,
          });
          const myLists = (res.data.lists || []).filter((l) =>
            /curatelist/.test(l.purpose || ''),
          );
          const containing = [];
          for (const list of myLists) {
            try {
              const itemUri = await findListItemUri(list.uri, id);
              if (itemUri) containing.push(listViewToMasto(list));
            } catch (e) {
              console.error(e);
            }
          }
          return containing;
        },
      },
      familiarFollowers: {
        fetch: async () => [],
      },
    };
  }

  const masto = {
    v1: {
      instance: {
        fetch: async () => blueskyInstanceInfo(instance),
      },
      preferences: {
        fetch: async () => ({}),
      },
      customEmojis: {
        list: async () => [],
      },
      announcements: {
        list: async () => [],
      },
      markers: {
        fetch: async () => ({}),
        create: async () => ({}),
      },
      // Bluesky has no Mastodon-style Web Push. Stub the endpoint so the
      // Settings push form reads "no subscription" instead of crashing on
      // `masto.v1.push.subscription` being undefined.
      push: {
        subscription: {
          fetch: async () => null,
          create: async () => null,
          update: async () => null,
          remove: async () => ({}),
        },
      },
      followedTags: {
        list: () => paginator(async () => ({ items: [], cursor: null })),
      },
      followRequests: {
        list: async () => [],
      },
      featuredTags: {
        list: async () => [],
      },
      lists: {
        list: async () => {
          await ready();
          const res = await agent.app.bsky.graph.getLists({
            actor: agentDid(),
            limit: 100,
          });
          const curated = (res.data.lists || [])
            .filter((l) => /curatelist/.test(l.purpose || ''))
            .map(listViewToMasto);
          // Subscribed custom feeds show up alongside lists.
          const feeds = await getSavedFeedGenerators();
          return [...feeds, ...curated];
        },
        create: async ({ title }) => {
          await ready();
          const res = await agent.app.bsky.graph.list.create(
            { repo: agentDid() },
            {
              purpose: 'app.bsky.graph.defs#curatelist',
              name: title,
              createdAt: new Date().toISOString(),
            },
          );
          return {
            id: atUriToId(res.uri),
            title,
            repliesPolicy: 'list',
            exclusive: false,
            _bluesky: true,
          };
        },
        $select: (id) => {
          const listUri = idToAtUri(id);
          const rkey = listUri.split('/').pop();
          return {
            fetch: async () => {
              await ready();
              if (isFeedGenId(id)) {
                const res = await agent.app.bsky.feed.getFeedGenerator({
                  feed: listUri,
                });
                return feedGenViewToMasto(res.data.view);
              }
              const res = await agent.app.bsky.graph.getList({
                list: listUri,
                limit: 1,
              });
              return listViewToMasto(res.data.list);
            },
            update: async ({ title }) => {
              await ready();
              const existing = await agent.com.atproto.repo.getRecord({
                repo: agentDid(),
                collection: LIST_COLLECTION,
                rkey,
              });
              await agent.com.atproto.repo.putRecord({
                repo: agentDid(),
                collection: LIST_COLLECTION,
                rkey,
                record: { ...existing.data.value, name: title },
              });
              return {
                id,
                title,
                repliesPolicy: 'list',
                exclusive: false,
                _bluesky: true,
              };
            },
            remove: async () => {
              await ready();
              await agent.app.bsky.graph.list.delete({
                repo: agentDid(),
                rkey,
              });
              return {};
            },
            accounts: {
              list: ({ limit = 40 } = {}) =>
                paginator(async (cursor) => {
                  await ready();
                  const res = await agent.app.bsky.graph.getList({
                    list: listUri,
                    limit,
                    cursor,
                  });
                  const items = (res.data.items || []).map((item) => {
                    listItemUris.set(
                      `${listUri}|${item.subject.did}`,
                      item.uri,
                    );
                    trackProfile(item.subject);
                    return profileToAccount(item.subject, instance);
                  });
                  return { items, cursor: res.data.cursor };
                }),
              create: async ({ accountIds }) => {
                await ready();
                const ids = Array.isArray(accountIds)
                  ? accountIds
                  : [accountIds];
                for (const memberDid of ids) {
                  const res = await agent.app.bsky.graph.listitem.create(
                    { repo: agentDid() },
                    {
                      list: listUri,
                      subject: memberDid,
                      createdAt: new Date().toISOString(),
                    },
                  );
                  listItemUris.set(`${listUri}|${memberDid}`, res.uri);
                }
                return {};
              },
              remove: async ({ accountIds }) => {
                await ready();
                const ids = Array.isArray(accountIds)
                  ? accountIds
                  : [accountIds];
                for (const memberDid of ids) {
                  const itemUri = await findListItemUri(listUri, memberDid);
                  if (itemUri) {
                    await agent.app.bsky.graph.listitem.delete({
                      repo: agentDid(),
                      rkey: itemUri.split('/').pop(),
                    });
                    listItemUris.delete(`${listUri}|${memberDid}`);
                  }
                }
                return {};
              },
            },
          };
        },
      },
      accounts: {
        verifyCredentials: async () => {
          await ready();
          const res = await agent.getProfile({ actor: agentDid() });
          return profileToAccount(res.data, instance);
        },
        lookup: async ({ acct }) => {
          await ready();
          // acct may come as `handle@instance` — the handle alone is the actor
          const actor = acct.split('@').filter(Boolean)[0] || acct;
          const res = await agent.getProfile({ actor });
          trackProfile(res.data);
          return profileToAccount(res.data, instance);
        },
        search: {
          // masto.js exposes this as a paginator; call sites await
          // .list() directly for the first page
          list: async ({ q, limit = 8 } = {}) => {
            await ready();
            const res = await agent.searchActorsTypeahead({ q, limit });
            return res.data.actors.map((p) => profileToAccount(p, instance));
          },
        },
        relationships: {
          fetch: async ({ id }) => {
            await ready();
            const ids = Array.isArray(id) ? id : [id];
            const res = await agent.getProfiles({ actors: ids });
            res.data.profiles.forEach(trackProfile);
            return res.data.profiles.map(profileToRelationship);
          },
        },
        familiarFollowers: {
          fetch: async () => [],
        },
        $select: accountEndpoints,
      },
      statuses: {
        create: createStatus,
        createThread,
        $select: statusEndpoints,
      },
      timelines: {
        home: {
          list: ({ limit = 20 } = {}) =>
            paginator(async (cursor) => {
              await ready();
              const [res, fvp] = await Promise.all([
                agent.getTimeline({ limit, cursor }),
                getFeedViewPrefs().catch(() => ({})),
              ]);
              // Honor the official app's Following-feed preferences.
              // Self-threads (the whole parent/root chain by one author)
              // are never treated as replies, reposted replies count as
              // reposts, and other replies must involve a second
              // participant you follow (parent, grandparent or root) —
              // the official app applies that rule unconditionally; here
              // hideRepliesByUnfollowed: false (settable in our Settings
              // UI) opts out of it
              const userDid = agentDid();
              const feed = res.data.feed.filter((item) => {
                if (fvp.hideReposts && item.reason) return false;
                if (item.reply && !item.reason) {
                  const selfThread = areSameAuthor(getFeedItemAuthors(item));
                  if (!selfThread) {
                    if (fvp.hideReplies) return false;
                    if (
                      fvp.hideRepliesByUnfollowed !== false &&
                      !shouldDisplayReplyInFollowing(item, userDid)
                    ) {
                      return false;
                    }
                    if (
                      fvp.hideRepliesByLikeCount > 0 &&
                      (item.post?.likeCount || 0) < fvp.hideRepliesByLikeCount
                    ) {
                      return false;
                    }
                  }
                }
                if (
                  fvp.hideQuotePosts &&
                  /^app\.bsky\.embed\.record/.test(item.post?.embed?.$type)
                ) {
                  return false;
                }
                return true;
              });
              feed.forEach(trackFeedItem);
              const items = await withMutedWords(
                feed.map(toFeedStatus).filter(Boolean),
              );
              return { items, cursor: res.data.cursor };
            }),
        },
        tag: {
          $select: (hashtag) => ({
            list: ({ limit = 20 } = {}) =>
              paginator(async (cursor) => {
                await ready();
                // Multi-word "tags" come from trending topics — search
                // them as phrases instead of hashtags
                const q = /\s/.test(hashtag) ? hashtag : `#${hashtag}`;
                const res = await agent.app.bsky.feed.searchPosts({
                  q,
                  limit,
                  cursor,
                });
                res.data.posts.forEach(trackPost);
                const items = await withMutedWords(
                  res.data.posts.map(toStatus).filter(Boolean),
                );
                return { items, cursor: res.data.cursor };
              }),
          }),
        },
        list: {
          $select: (id) => {
            const listUri = idToAtUri(id);
            return {
              list: ({ limit = 20 } = {}) =>
                paginator(async (cursor) => {
                  await ready();
                  // A subscribed custom feed uses getFeed; a curated user list
                  // uses getListFeed. Both return `data.feed` of feed items.
                  const res = isFeedGenId(id)
                    ? await agent.app.bsky.feed.getFeed({
                        feed: listUri,
                        limit,
                        cursor,
                      })
                    : await agent.app.bsky.feed.getListFeed({
                        list: listUri,
                        limit,
                        cursor,
                      });
                  res.data.feed.forEach(trackFeedItem);
                  const items = await withMutedWords(
                    res.data.feed.map(toFeedStatus).filter(Boolean),
                  );
                  return { items, cursor: res.data.cursor };
                }),
            };
          },
        },
      },
      tags: {
        $select: (hashtag) => ({
          fetch: async () => ({ name: hashtag, following: false }),
          follow: async () => {
            throw new Error('Following hashtags is not supported on Bluesky');
          },
          unfollow: async () => {
            throw new Error('Following hashtags is not supported on Bluesky');
          },
        }),
      },
      bookmarks: {
        list: ({ limit = 20 } = {}) =>
          paginator(async (cursor) => {
            await ready();
            const res = await agent.app.bsky.bookmark.getBookmarks({
              limit,
              cursor,
            });
            const items = [];
            for (const bookmark of res.data.bookmarks || []) {
              const item = bookmark.item;
              if (item?.$type?.includes('postView') || item?.uri) {
                trackPost(item);
                const status = toStatus(item);
                if (status) {
                  status.bookmarked = true;
                  items.push(status);
                }
              }
            }
            return { items, cursor: res.data.cursor };
          }),
      },
      favourites: {
        list: ({ limit = 20 } = {}) =>
          paginator(async (cursor) => {
            await ready();
            const res = await agent.getActorLikes({
              actor: agentDid(),
              limit,
              cursor,
            });
            res.data.feed.forEach(trackFeedItem);
            return {
              items: res.data.feed.map(toFeedStatus).filter(Boolean),
              cursor: res.data.cursor,
            };
          }),
      },
      notifications: {
        requests: {
          list: async () => [],
        },
        list: ({ limit = 30, types, excludeTypes, exclude_types } = {}) =>
          paginator(async (cursor) => {
            await ready();
            const res = await agent.listNotifications({
              limit: Math.min(limit * 2, 100),
              cursor,
            });
            let items = await hydrateNotifications(res.data.notifications);
            const excluded = excludeTypes || exclude_types;
            if (types?.length) {
              items = items.filter((n) => types.includes(n.type));
            }
            if (excluded?.length) {
              items = items.filter((n) => !excluded.includes(n.type));
            }
            return { items, cursor: res.data.cursor };
          }),
      },
      trends: {
        statuses: {
          // Bluesky's Discover ("What's Hot") feed
          list: ({ limit = 20 } = {}) =>
            paginator(async (cursor) => {
              await ready();
              const res = await agent.app.bsky.feed.getFeed({
                feed: DISCOVER_FEED,
                limit,
                cursor,
              });
              res.data.feed.forEach(trackFeedItem);
              const items = await withMutedWords(
                res.data.feed.map(toFeedStatus).filter(Boolean),
              );
              return { items, cursor: res.data.cursor };
            }),
        },
        tags: {
          // Bluesky trending topics, mapped to Mastodon trending-tag shape
          list: ({ limit = 10 } = {}) =>
            paginator(async () => {
              await ready();
              let topics = [];
              try {
                const res = await agent.app.bsky.unspecced.getTrends({
                  limit,
                });
                topics = (res.data.trends || []).map((t) => ({
                  name: t.displayName || t.topic,
                  url: `${BSKY_WEB}${t.link || ''}`,
                  history: [{ day: '', uses: t.postCount || 0, accounts: 0 }],
                }));
              } catch (e) {
                try {
                  const res = await agent.app.bsky.unspecced.getTrendingTopics({
                    limit,
                  });
                  topics = (res.data.topics || []).map((t) => ({
                    name: t.displayName || t.topic,
                    url: `${BSKY_WEB}${t.link || ''}`,
                    history: [{ day: '', uses: 0, accounts: 0 }],
                  }));
                } catch (e2) {
                  console.error(e2);
                }
              }
              return { items: topics, cursor: null };
            }),
        },
        links: {
          list: () => paginator(async () => ({ items: [], cursor: null })),
        },
      },
      scheduledStatuses: {
        list: () => paginator(async () => ({ items: [], cursor: null })),
      },
      filters: {
        list: async () => {
          await ready();
          return (await getMutedWords(true)).map(mutedWordToFilter);
        },
      },
      media: {
        $select: (id) => ({
          update: async ({ description }) => {
            const media = pendingMedia.get(id);
            if (media) media.alt = description || '';
            return { id, description };
          },
          fetch: async () => ({ id }),
        }),
      },
    },
    v2: {
      instance: {
        fetch: async () => blueskyInstanceInfo(instance),
      },
      media: {
        create: uploadMedia,
      },
      notifications: {
        policy: {
          fetch: async () => ({}),
          update: async () => ({}),
        },
      },
      filters: {
        // Mastodon v2 filters mapped onto Bluesky muted words.
        // One filter = one muted word; multi-keyword filters become
        // multiple muted words.
        list: async () => {
          await ready();
          return (await getMutedWords(true)).map(mutedWordToFilter);
        },
        create: async ({
          title,
          keywordsAttributes,
          keywords_attributes,
          expiresIn,
          expires_in,
        } = {}) => {
          await ready();
          const attrs = keywordsAttributes || keywords_attributes || [];
          let keywords = attrs
            .filter((k) => !k._destroy && k.keyword)
            .map((k) => k.keyword);
          if (!keywords.length && title) keywords = [title];
          if (!keywords.length) throw new Error('No keywords to mute');
          const expiresSec = expiresIn ?? expires_in;
          const expiresAt = expiresSec
            ? new Date(Date.now() + expiresSec * 1000).toISOString()
            : undefined;
          await agent.addMutedWords(
            keywords.map((value) => ({
              value,
              targets: ['content', 'tag'],
              actorTarget: 'all',
              ...(expiresAt ? { expiresAt } : {}),
            })),
          );
          const words = await getMutedWords(true);
          const created = words.find((w) => w.value === keywords[0]);
          return created
            ? mutedWordToFilter(created)
            : mutedWordToFilter({ value: keywords[0] });
        },
        $select: (id) => ({
          fetch: async () => {
            await ready();
            const words = await getMutedWords();
            const word = words.find((w) => (w.id || w.value) === id);
            if (!word) throw new Error('Filter not found');
            return mutedWordToFilter(word);
          },
          update: async ({
            title,
            keywordsAttributes,
            keywords_attributes,
            expiresIn,
            expires_in,
          } = {}) => {
            await ready();
            const words = await getMutedWords(true);
            const word = words.find((w) => (w.id || w.value) === id);
            if (!word) throw new Error('Filter not found');
            const attrs = keywordsAttributes || keywords_attributes || [];
            let keywords = attrs
              .filter((k) => !k._destroy && k.keyword)
              .map((k) => k.keyword);
            if (!keywords.length && title) keywords = [title];
            const expiresSec = expiresIn ?? expires_in;
            const expiresAt = expiresSec
              ? new Date(Date.now() + expiresSec * 1000).toISOString()
              : undefined;
            await agent.removeMutedWord(word);
            if (keywords.length) {
              await agent.addMutedWords(
                keywords.map((value) => ({
                  value,
                  targets: word.targets || ['content', 'tag'],
                  actorTarget: word.actorTarget || 'all',
                  ...(expiresAt ? { expiresAt } : {}),
                })),
              );
            }
            const after = await getMutedWords(true);
            const updated = after.find((w) => w.value === keywords[0]);
            return updated
              ? mutedWordToFilter(updated)
              : mutedWordToFilter({ value: keywords[0] || word.value });
          },
          remove: async () => {
            await ready();
            const words = await getMutedWords(true);
            const word = words.find((w) => (w.id || w.value) === id);
            if (word) await agent.removeMutedWord(word);
            await getMutedWords(true);
            return {};
          },
        }),
      },
      search: {
        list: async ({ q, type, limit = 20 }) => {
          await ready();
          const result = { accounts: [], statuses: [], hashtags: [] };
          const wantAccounts = !type || type === 'accounts';
          const wantStatuses = !type || type === 'statuses';
          if (wantAccounts) {
            try {
              const res = await agent.searchActors({ q, limit });
              result.accounts = res.data.actors.map((p) =>
                profileToAccount(p, instance),
              );
            } catch (e) {}
          }
          if (wantStatuses) {
            try {
              const res = await agent.app.bsky.feed.searchPosts({ q, limit });
              res.data.posts.forEach(trackPost);
              result.statuses = res.data.posts.map(toStatus).filter(Boolean);
            } catch (e) {}
          }
          return result;
        },
      },
    },
  };

  // Fork-specific direct-message surface. Bluesky chat is a separate service
  // reached through the `bsky_chat` proxy; every call routes through a proxied
  // clone of the agent. Consumed via the unified DM client (src/utils/dm.js).
  function chatAgent() {
    return agent.withProxy(CHAT_PROXY_TYPE, CHAT_PROXY_SERVICE);
  }
  async function buildMessageInput(text) {
    const { RichText } = await loadAtproto();
    const rt = new RichText({ text });
    let facets;
    try {
      await rt.detectFacets(agent); // resolves mentions + links to facets
      // Same unresolved-mention hazard as buildPostRecord: an empty `did`
      // would make the chat service reject the message.
      ({ facets } = await repairMentionFacets(rt.text, rt.facets));
    } catch (e) {}
    return { text: rt.text, facets };
  }
  const chat = {
    listConversations: ({ limit = 40 } = {}) =>
      paginator(async (cursor) => {
        await ready();
        const res = await chatAgent().chat.bsky.convo.listConvos({
          limit,
          cursor,
        });
        const items = (res.data.convos || []).map((c) =>
          convoToConversation(c, agentDid(), instance),
        );
        return { items, cursor: res.data.cursor };
      }),
    getMessages: (convoId, { limit = 50 } = {}) =>
      paginator(async (cursor) => {
        await ready();
        const res = await chatAgent().chat.bsky.convo.getMessages({
          convoId,
          limit,
          cursor,
        });
        // getMessages returns newest-first; the thread UI reverses for display.
        const items = (res.data.messages || []).map((m) =>
          messageToMessage(m, agentDid(), instance),
        );
        return { items, cursor: res.data.cursor };
      }),
    getConvo: async (convoId) => {
      await ready();
      const res = await chatAgent().chat.bsky.convo.getConvo({ convoId });
      return convoToConversation(res.data.convo, agentDid(), instance);
    },
    getConvoForMembers: async (memberIds) => {
      await ready();
      const members = Array.isArray(memberIds) ? memberIds : [memberIds];
      const res = await chatAgent().chat.bsky.convo.getConvoForMembers({
        members,
      });
      return convoToConversation(res.data.convo, agentDid(), instance);
    },
    sendMessage: async (convoId, text) => {
      await ready();
      const message = await buildMessageInput(text);
      const res = await chatAgent().chat.bsky.convo.sendMessage({
        convoId,
        message,
      });
      return messageToMessage(res.data, agentDid(), instance);
    },
    markRead: async (convoId, messageId) => {
      await ready();
      await chatAgent().chat.bsky.convo.updateRead({
        convoId,
        ...(messageId ? { messageId } : {}),
      });
      return {};
    },
    getUnreadCount: async () => {
      await ready();
      const res = await chatAgent().chat.bsky.convo.getUnreadCounts();
      return res.data.count || 0;
    },
  };

  const client = {
    masto,
    chat,
    get agent() {
      return agent;
    },
    instance,
    accessToken: session?.accessJwt,
    bluesky: true,
    adoptSession,
    // Exposed for session-lifecycle tests; not part of the facade contract
    _ready: ready,
    getFeedViewPrefs,
    setFeedViewPrefs,
    onStreamingReady() {
      // No streaming support for Bluesky (yet)
    },
  };
  return client;
}
