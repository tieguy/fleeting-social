// For You lab: candidate ranking rules, compared blind on real data.
// Pure functions only; the page in src/pages/foryou-lab.jsx fetches the
// data and records which picks the user finds interesting.

import { isHiddenAuthor } from './conversation-tree';
import { isFiltered } from './filters';

export const WINDOW_MS = 24 * 60 * 60 * 1000;
export const PICKS_PER_RULE = 12;
export const PER_AUTHOR_CAP = 2;
// Likes a topic-feed post by a stranger needs before the feeds rule ranks it.
// Relative engagement alone favors tiny accounts: one like on a one-follower
// account outscores a hundred likes on a large one.
export const FEED_MIN_LIKES = 20;

// The saved Bluesky feeds the lab reads. Other saved feeds are skipped.
export const LAB_FEEDS = new Set([
  'at://did:plc:kmqa6ybu75bsrh2a7ccavy6g/app.bsky.feed.generator/aaaeenrjnifc4', // Housing Abundance
  'at://did:plc:lrzkd5exmxqrblbruvjieofj/app.bsky.feed.generator/MLBlend', // AI/ML Feed: Blend
  'at://did:plc:ktdlmdqpbyzbvtxrkwz5pvp2/app.bsky.feed.generator/aaab6tnm5ipfm', // San Francisco
]);

export const TOPICS = {
  'open source':
    /\b(open[- ]source|foss|free software|osi\b|gpl|apache license|mit license|copyleft|github|maintainers?)\b/i,
  ai: /\b(ai|a\.i\.|llms?|gpt|claude|gemini|openai|anthropic|machine learning|ml|neural|model weights|agi|chatbots?|genai)\b/i,
  'san francisco':
    /\b(san francisco|sf|sfba|bay area|oakland|berkeley|muni|bart|mission district|tenderloin|soma|sfgov|board of supervisors)\b/i,
  housing:
    /\b(housing|zoning|yimby|nimby|apartments?|homes|rent|density|upzon\w*|permitting|abundance)\b/i,
};

// Reply, boost and like weights for the author-affinity rule
const AFFINITY_WEIGHTS = { reply: 3, boost: 2, like: 1 };

function timeOf(status) {
  const time = Date.parse(status?.createdAt);
  return Number.isNaN(time) ? null : time;
}

export function authorKey(instance, account) {
  return `${instance}/${account?.id}`;
}

function plainText(html) {
  return (html || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .trim();
}

function escapeRegExp(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// True when the text holds one of the user's Bluesky muted words. A phrase
// matches as a substring; a single word matches whole, with or without a
// leading '#', so a Mastodon hashtag matches too.
export function hasMutedWord(text, mutedWords, now = Date.now()) {
  for (const { value, expiresAt } of mutedWords) {
    if (!value || (expiresAt && Date.parse(expiresAt) < now)) continue;
    if (/\s/.test(value)) {
      if (text.toLowerCase().includes(value.toLowerCase())) return true;
    } else if (
      new RegExp(
        `(?:^|[^\\p{L}\\p{N}])${escapeRegExp(value)}(?:$|[^\\p{L}\\p{N}])`,
        'iu',
      ).test(text)
    ) {
      return true;
    }
  }
  return false;
}

// The text muted words are checked against: the post, its content warning,
// link card, image alt text, and the same parts of a quoted post.
export function mutableText(status, depth = 0) {
  if (!status) return '';
  return [
    status.spoilerText,
    plainText(status.content),
    status.card?.title,
    status.card?.description,
    ...(status.mediaAttachments || []).map((m) => m.description),
    depth < 1 ? mutableText(status.quote?.quotedStatus, depth + 1) : '',
  ]
    .filter(Boolean)
    .join('\n');
}

// Builds one candidate per original post from timeline items, which may be
// boost wrappers. Keeps posts created after the cutoff, not by the user, not
// direct, and not replies (a self-thread is represented by its first post).
// Drops muted and blocked authors and boosters, including those on Bluesky
// mute and block lists, posts that match a Mastodon home filter, and posts
// on either network that hold a Bluesky muted word.
// `boostedBy` counts accounts in the home timeline that boosted the post;
// `quotedBy` counts home-timeline authors whose posts quote it. `inHome` is
// set when the post itself, not a boost of it, is in the home timeline.
export function buildPool(
  entries,
  { cutoff, selfKeys = new Set(), mutedWords = [] },
) {
  const pool = new Map();
  const quotes = [];
  for (const { item, origin, instance } of entries) {
    if (!item) continue;
    const status = item.reblog || item;
    if (isHiddenAuthor(status.account) || isHiddenAuthor(item.account)) {
      continue;
    }
    if (
      isFiltered(item.filtered, 'home') ||
      isFiltered(status.filtered, 'home')
    ) {
      continue;
    }
    const key = `${instance}/${status.id}`;
    let candidate = pool.get(key);
    if (!candidate) {
      const time = timeOf(status);
      if (time === null || time < cutoff) continue;
      if (selfKeys.has(authorKey(instance, status.account))) continue;
      if (status.visibility === 'direct') continue;
      // Replies make no sense out of context, and that includes the later
      // posts of a self-thread. The thread's first post stands for it.
      if (status.inReplyToId || status.inReplyToAccountId) continue;
      const text = [status.spoilerText, plainText(status.content)]
        .filter(Boolean)
        .join('\n');
      if (hasMutedWord(mutableText(status), mutedWords)) continue;
      candidate = {
        key,
        instance,
        status,
        author: authorKey(instance, status.account),
        text,
        time,
        origins: new Set(),
        boostedBy: new Set(),
        quotedBy: new Set(),
        inHome: false,
      };
      pool.set(key, candidate);
    }
    candidate.origins.add(origin);
    if (origin === 'home' && !item.reblog) candidate.inHome = true;
    if (item.reblog && origin === 'home') {
      candidate.boostedBy.add(authorKey(instance, item.account));
    }
    const quoted = status.quote?.quotedStatus;
    if (quoted?.id && origin === 'home') {
      quotes.push({
        key: `${instance}/${quoted.id}`,
        by: authorKey(instance, status.account),
      });
    }
  }
  for (const { key, by } of quotes) pool.get(key)?.quotedBy.add(by);
  return [...pool.values()];
}

// Counts the user's own replies, boosts and likes per author.
export function affinityFromActivity({ ownStatuses = [], likes = [] }) {
  const affinity = new Map();
  const add = (key, weight) =>
    affinity.set(key, (affinity.get(key) || 0) + weight);
  for (const { instance, status } of ownStatuses) {
    if (status.reblog) {
      add(authorKey(instance, status.reblog.account), AFFINITY_WEIGHTS.boost);
    } else if (status.inReplyToAccountId) {
      add(`${instance}/${status.inReplyToAccountId}`, AFFINITY_WEIGHTS.reply);
    }
  }
  for (const { instance, status } of likes) {
    add(authorKey(instance, status.account), AFFINITY_WEIGHTS.like);
  }
  return affinity;
}

function gmean(values) {
  return Math.exp(
    values.reduce((sum, v) => sum + Math.log(v), 0) / values.length,
  );
}

// mastodon_digest's ExtendedSimpleScorer: geometric mean of boosts, likes and
// replies, each plus one, or zero when all three are zero.
export function rawEngagement(status) {
  const boosts = status.reblogsCount || 0;
  const likes = status.favouritesCount || 0;
  const replies = status.repliesCount || 0;
  if (!boosts && !likes && !replies) return 0;
  return gmean([boosts + 1, likes + 1, replies + 1]);
}

// mastodon_digest's ExtendedSimpleWeightedScorer: raw engagement divided by
// the square root of the author's follower count. Null when the follower
// count is unknown.
export function relativeEngagement(status, followers) {
  if (!followers || followers <= 0) return null;
  return rawEngagement(status) / Math.sqrt(followers);
}

export function topicsOf(text) {
  return Object.entries(TOPICS)
    .filter(([, re]) => re.test(text))
    .map(([name]) => name);
}

// Deterministic per-run shuffle key
function hashKey(key, seed) {
  let h = 2166136261 ^ seed;
  for (let i = 0; i < key.length; i++) {
    h = Math.imul(h ^ key.charCodeAt(i), 16777619);
  }
  return (h >>> 0) / 4294967296;
}

export function featuresOf(candidate, ctx) {
  const { followers, affinity, homePostsByAuthor, followedAuthors } = ctx;
  const followerCount = followers.get(candidate.author);
  return {
    followed:
      followedAuthors.has(candidate.author) ||
      !!candidate.status.account?._viewer?.following,
    raw: rawEngagement(candidate.status),
    relative: relativeEngagement(candidate.status, followerCount),
    followers: followerCount ?? null,
    sharedBy: candidate.boostedBy.size + candidate.quotedBy.size,
    affinity: affinity.get(candidate.author) || 0,
    authorPostsToday: homePostsByAuthor.get(candidate.author) || 0,
    topics: topicsOf(candidate.text),
  };
}

// Each rule returns a sort key (higher first) or null to skip the candidate.
// Rules marked `followsOnly` see only posts by authors the user follows.
export const RULES = [
  {
    id: 'relative',
    followsOnly: true,
    name: 'Engagement relative to author size',
    note: 'mastodon_digest: gmean(boosts, likes, replies) / √followers',
    score: (f) => (f.relative > 0 ? f.relative : null),
  },
  {
    id: 'raw',
    followsOnly: true,
    name: 'Raw engagement (popularity baseline)',
    note: 'gmean(boosts, likes, replies), no author normalization',
    score: (f) => (f.raw > 0 ? f.raw : null),
  },
  {
    id: 'shared',
    name: 'Shared by people you follow',
    note: 'Distinct follows who boosted or quoted it; any author',
    score: (f) =>
      f.sharedBy > 0 ? f.sharedBy + (f.relative || 0) / 1000 : null,
  },
  {
    id: 'affinity',
    followsOnly: true,
    name: 'Authors you interact with',
    note: 'Your recent replies (3), boosts (2) and likes (1) to the author',
    score: (f, c) => (f.affinity > 0 ? f.affinity + c.time / 1e15 : null),
  },
  {
    id: 'quiet',
    followsOnly: true,
    name: 'Quiet posters',
    note: 'Fewest posts in your home timeline today; ties by relative engagement',
    score: (f, c) =>
      c.inHome && f.authorPostsToday > 0
        ? 1 / f.authorPostsToday + (f.relative || 0) / 1000
        : null,
  },
  {
    id: 'feeds',
    name: 'Topic feeds, relative engagement',
    note: `Posts from your saved topic feeds by authors you do not follow, at least ${FEED_MIN_LIKES} likes`,
    score: (f, c) =>
      !f.followed &&
      (c.status.favouritesCount || 0) >= FEED_MIN_LIKES &&
      [...c.origins].some((o) => o.startsWith('feed:'))
        ? f.relative || 0
        : null,
  },
  {
    id: 'topics',
    followsOnly: true,
    name: 'Topic keywords',
    note: 'Matches open source, AI, San Francisco or housing regexes',
    score: (f) =>
      f.topics.length ? f.topics.length + (f.relative || 0) / 1000 : null,
  },
  {
    id: 'random',
    followsOnly: true,
    name: 'Random (baseline)',
    note: 'A random sample of the pool',
    score: (f, c, seed) => hashKey(c.key, seed),
  },
];

// Top picks for one rule, at most PER_AUTHOR_CAP per author.
export function pickForRule(rule, scored, { seed, limit = PICKS_PER_RULE }) {
  const ranked = scored
    .filter(({ features }) => !rule.followsOnly || features.followed)
    .map(({ candidate, features }) => ({
      candidate,
      value: rule.score(features, candidate, seed),
    }))
    .filter(({ value }) => value !== null && value !== undefined)
    .sort((a, b) => b.value - a.value);
  const perAuthor = new Map();
  const picks = [];
  for (const { candidate } of ranked) {
    if (picks.length >= limit) break;
    const n = perAuthor.get(candidate.author) || 0;
    if (n >= PER_AUTHOR_CAP) continue;
    perAuthor.set(candidate.author, n + 1);
    picks.push(candidate.key);
  }
  return { picks, eligible: ranked.length };
}

export function runLab(pool, { followers, affinity, seed }) {
  const homePostsByAuthor = new Map();
  for (const c of pool) {
    if (c.inHome) {
      homePostsByAuthor.set(
        c.author,
        (homePostsByAuthor.get(c.author) || 0) + 1,
      );
    }
  }
  // Authors whose own posts are in the home timeline count as followed. On
  // Mastodon this also counts authors reached through followed hashtags.
  const followedAuthors = new Set(
    pool.filter((c) => c.inHome).map((c) => c.author),
  );
  const ctx = { followers, affinity, homePostsByAuthor, followedAuthors };
  const scored = pool.map((candidate) => ({
    candidate,
    features: featuresOf(candidate, ctx),
  }));
  const featuresByKey = new Map(
    scored.map(({ candidate, features }) => [candidate.key, features]),
  );
  const rules = RULES.map((rule) => ({
    id: rule.id,
    name: rule.name,
    note: rule.note,
    ...pickForRule(rule, scored, { seed }),
  }));
  // Union of all picks in a seeded random order, so the user judges each
  // post once without knowing which rule chose it.
  const union = [...new Set(rules.flatMap((r) => r.picks))].sort(
    (a, b) => hashKey(a, seed + 1) - hashKey(b, seed + 1),
  );
  return { rules, union, featuresByKey };
}

// Per-rule hit rates from verdicts ('up' | 'down'), counting judged picks only.
export function scoreRules(rules, verdicts) {
  return rules.map((rule) => {
    let up = 0;
    let judged = 0;
    for (const key of rule.picks) {
      const v = verdicts[key];
      if (!v) continue;
      judged++;
      if (v === 'up') up++;
    }
    return { ...rule, up, judged };
  });
}
