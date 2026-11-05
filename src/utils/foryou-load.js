// For You: reads the posts and the signals that the rules rank. Shared by
// the For You page and the For You lab.

import { api } from './api';
import { getOtherNetworkAccounts } from './bluesky';
import { idToAtUri } from './bluesky/convert';
import {
  affinityFromActivity,
  authorKey,
  buildPool,
  isAlwaysList,
  LAB_FEEDS,
} from './foryou-lab';

// A Bluesky home page of 40 covered about two minutes on 2026-11-05 (30
// pages, 1 hour). Mastodon servers keep 800 home posts, so its walk ends
// sooner by itself.
const HOME_PAGES = 100;
const FEED_PAGES = 4;
const ACTIVITY_PAGES = 3;
const PROFILE_CONCURRENCY = 6;

// The current account, and the logged-in accounts on the other network when
// the merged timeline is on
export function forYouSources({ masto, instance }, mergedTimeline) {
  return [
    { masto, instance },
    ...(mergedTimeline
      ? getOtherNetworkAccounts().map((account) => api({ account }))
      : []),
  ];
}

// Reads pages until a page ends with an item older than the cutoff (when
// `cutoff` is set), the iterator ends, or `pages` pages are read. One old item
// mid-page, such as a backdated post, does not stop the walk, and neither does
// an empty page: the Bluesky facade filters pages after fetching them. Custom
// feeds are not chronological, so they pass no cutoff. `stats`, when given,
// receives the page count and the reason the walk stopped.
async function collect(iterator, { pages, cutoff, stats = {} }) {
  const items = [];
  stats.pages = 0;
  stats.stop = 'page cap';
  for (let i = 0; i < pages; i++) {
    const { done, value } = await iterator.next();
    if (done) {
      stats.stop = 'end of timeline';
      break;
    }
    stats.pages++;
    if (!value?.length) continue;
    items.push(...value);
    if (cutoff && Date.parse(value[value.length - 1].createdAt) < cutoff) {
      stats.stop = 'cutoff';
      break;
    }
  }
  return items;
}

async function mapLimit(items, limit, fn) {
  const queue = [...items];
  await Promise.all(
    Array.from({ length: limit }, async () => {
      while (queue.length) await fn(queue.shift());
    }),
  );
}

export async function loadSource({ masto, instance }, cutoff, log) {
  const self = await masto.v1.accounts.verifyCredentials();
  log(`${instance}: reading home timeline`);
  const homeWalk = {};
  const home = await collect(
    masto.v1.timelines.home.list({ limit: 40 }).values(),
    { pages: HOME_PAGES, cutoff, stats: homeWalk },
  );
  const entries = home.map((item) => ({ item, origin: 'home', instance }));
  // Hours of home timeline read, from the last item reached; under 24 means
  // the walk ended before the window did
  const homeHours = home.length
    ? Math.round((Date.now() - Date.parse(home.at(-1).createdAt)) / 36e5)
    : 0;

  let lists = [];
  let alwaysList = null;
  try {
    const all = await masto.v1.lists.list();
    lists = all.filter((l) => l._feed && LAB_FEEDS.has(idToAtUri(l.id)));
    alwaysList = all.find(isAlwaysList) || null;
  } catch (e) {
    console.error(e);
  }
  let always = null;
  if (alwaysList) {
    log(`${instance}: reading list "${alwaysList.title}"`);
    try {
      const items = await collect(
        masto.v1.timelines.list
          .$select(alwaysList.id)
          .list({ limit: 40 })
          .values(),
        { pages: FEED_PAGES, cutoff },
      );
      always = { count: items.length };
      for (const item of items) {
        entries.push({ item, origin: 'always', instance });
      }
    } catch (e) {
      console.error(e);
      always = { count: 0, failed: true };
    }
  }
  const feeds = [];
  for (const list of lists) {
    const { strangers } = LAB_FEEDS.get(idToAtUri(list.id));
    log(`${instance}: reading feed "${list.title}"`);
    try {
      const items = await collect(
        masto.v1.timelines.list.$select(list.id).list({ limit: 50 }).values(),
        { pages: FEED_PAGES },
      );
      feeds.push({ title: list.title, count: items.length });
      for (const item of items) {
        entries.push({
          item,
          origin: `feed: ${list.title}`,
          instance,
          strangers,
        });
      }
    } catch (e) {
      console.error(e);
      feeds.push({ title: list.title, count: 0, failed: true });
    }
  }

  // Bluesky muted words, which the facade lists as filters
  let mutedWords = [];
  if (self._bluesky) {
    try {
      mutedWords = (await masto.v1.filters.list()).map((f) => ({
        value: f.title,
        expiresAt: f.expiresAt,
      }));
    } catch (e) {
      console.error(e);
    }
  }

  log(`${instance}: reading your recent posts and likes`);
  const [own, likes] = await Promise.all([
    collect(
      masto.v1.accounts.$select(self.id).statuses.list({ limit: 40 }).values(),
      { pages: ACTIVITY_PAGES },
    ).catch(() => []),
    collect(masto.v1.favourites.list({ limit: 40 }).values(), {
      pages: ACTIVITY_PAGES,
    }).catch(() => []),
  ]);

  return {
    instance,
    masto,
    selfKey: authorKey(instance, self),
    entries,
    mutedWords,
    homeCount: home.length,
    homeHours,
    homeWalk,
    always,
    feeds,
    own: own.map((status) => ({ instance, status })),
    likes: likes.map((status) => ({ instance, status })),
  };
}

// Follower counts for every author in the pool. Mastodon statuses carry them;
// Bluesky post authors are partial profiles, so those are fetched.
export async function loadFollowers(pool, sources, log) {
  const followers = new Map();
  const missing = new Map();
  for (const { author, instance, status } of pool) {
    if (followers.has(author) || missing.has(author)) continue;
    const { account } = status;
    if (account?._partial) missing.set(author, { instance, id: account.id });
    else followers.set(author, account?.followersCount);
  }
  const mastoByInstance = new Map(sources.map((s) => [s.instance, s.masto]));
  let done = 0;
  await mapLimit([...missing], PROFILE_CONCURRENCY, async ([author, a]) => {
    try {
      const account = await mastoByInstance
        .get(a.instance)
        .v1.accounts.$select(a.id)
        .fetch();
      followers.set(author, account.followersCount);
    } catch (e) {}
    done++;
    if (done % 25 === 0) log(`Fetched ${done}/${missing.size} profiles`);
  });
  return followers;
}

// Loads every source and builds the candidate pool. One account failing,
// such as an expired Bluesky session, skips that account instead of failing
// the whole load. Throws only when no account loads.
export async function loadCandidates(sources, { cutoff, log }) {
  const settled = await Promise.allSettled(
    sources.map((s) => loadSource(s, cutoff, log)),
  );
  const loaded = [];
  const failed = [];
  settled.forEach((r, i) => {
    if (r.status === 'fulfilled') {
      loaded.push(r.value);
    } else {
      const { instance } = sources[i];
      const message = String(r.reason?.message || r.reason);
      failed.push({ instance, failed: message });
      log(`${instance}: failed (${message}), skipped`);
    }
  });
  if (!loaded.length) {
    throw new Error(failed.map((f) => f.failed).join('; '));
  }
  const removed = {};
  const pool = buildPool(
    loaded.flatMap((s) => s.entries),
    {
      cutoff,
      selfKeys: new Set(loaded.map((s) => s.selfKey)),
      mutedWords: loaded.flatMap((s) => s.mutedWords),
      removed,
    },
  );
  log(`Pool: ${pool.length} posts. Reading follower counts`);
  const followers = await loadFollowers(pool, loaded, log);
  const affinity = affinityFromActivity({
    ownStatuses: loaded.flatMap((s) => s.own),
    likes: loaded.flatMap((s) => s.likes),
  });
  return { loaded, failed, pool, removed, followers, affinity };
}
