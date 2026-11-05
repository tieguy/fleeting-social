// For You digest: the pure parts. The page in src/pages/foryou.jsx loads the
// posts (src/utils/foryou-load.js) and ranks them with the lab's rules
// (src/utils/foryou-lab.js); this module chooses the window, blends the
// rules into one digest, and words the "why this post" line.
// The design plan is docs/design-plans/2026-11-05-for-you.md.

export const MAX_WINDOW_MS = 24 * 60 * 60 * 1000;
// A post that was too new to rank well at last read gets a second chance
// with more engagement. See "Window: since last read" in the design plan.
export const OVERLAP_MS = 30 * 60 * 1000;
export const DIGEST_SIZE = 25;
export const RANDOM_COUNT = 2;
export const DIGEST_PER_AUTHOR_CAP = 2;
// Rules that the blend does not draw from: "always" posts go first, and
// "random" posts are placed separately.
export const UNBLENDED_RULES = new Set(['always', 'random']);

// The oldest post time the digest covers: 30 minutes before last read, and
// at most 24 hours back. With no last read, the full 24 hours.
export function digestCutoff({
  now,
  lastRead,
  overlapMs = OVERLAP_MS,
  maxMs = MAX_WINDOW_MS,
}) {
  const oldest = now - maxMs;
  if (!Number.isFinite(lastRead)) return oldest;
  return Math.min(now, Math.max(oldest, lastRead - overlapMs));
}

// Seeded random numbers in [0, 1), so a blend can be repeated in tests.
export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffled(items, random) {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

// Builds the digest as [{ key, rule }].
//
// - `alwaysKeys`: the "Always show" posts, newest first. All of them go
//   first, and they do not count toward the per-author cap.
// - `rankings`: [{ rule, keys }], each rule's posts best first.
// - `randomKeys`: the posts the random picks may come from.
// - `authorOf(key)`: the author key of a post.
//
// The rules take posts by team-draft interleaving (Radlinski, Kurup and
// Joachims, CIKM 2008, https://doi.org/10.1145/1458082.1458092), extended
// from two rankings to many: in each round the rules pick in a random order, and each takes its best post that no rule took
// before and whose author is under the cap. A rule that has nothing left
// sits out. The blend stops at `size - randomCount` posts or when no rule
// can pick. Then `randomCount` random posts go in at random positions.
export function blendDigest({
  alwaysKeys = [],
  rankings = [],
  randomKeys = [],
  authorOf,
  size = DIGEST_SIZE,
  randomCount = RANDOM_COUNT,
  perAuthorCap = DIGEST_PER_AUTHOR_CAP,
  random = Math.random,
}) {
  const taken = new Set(alwaysKeys);
  const perAuthor = new Map();
  const canTake = (key) =>
    !taken.has(key) && (perAuthor.get(authorOf(key)) || 0) < perAuthorCap;
  const take = (key) => {
    taken.add(key);
    const author = authorOf(key);
    perAuthor.set(author, (perAuthor.get(author) || 0) + 1);
  };

  const target = Math.max(0, size - randomCount);
  const cursors = rankings.map(({ rule, keys }) => ({ rule, keys, i: 0 }));
  const blended = [];
  let active = cursors;
  while (blended.length < target && active.length) {
    const next = [];
    for (const cursor of shuffled(active, random)) {
      if (blended.length >= target) break;
      while (cursor.i < cursor.keys.length && !canTake(cursor.keys[cursor.i])) {
        cursor.i++;
      }
      if (cursor.i >= cursor.keys.length) continue;
      const key = cursor.keys[cursor.i++];
      take(key);
      blended.push({ key, rule: cursor.rule });
      next.push(cursor);
    }
    active = next;
  }

  let placed = 0;
  for (const key of shuffled(randomKeys, random)) {
    if (placed >= randomCount) break;
    if (!canTake(key)) continue;
    take(key);
    const at = Math.floor(random() * (blended.length + 1));
    blended.splice(at, 0, { key, rule: 'random' });
    placed++;
  }

  return [...alwaysKeys.map((key) => ({ key, rule: 'always' })), ...blended];
}

function feedNameOf(candidate) {
  for (const origin of candidate?.origins || []) {
    if (origin.startsWith('feed: ') && !origin.endsWith(' (quoted)')) {
      return origin.slice('feed: '.length);
    }
  }
  return null;
}

// What the "why this post" line says, as a type and its values. The page
// turns it into words, so the wording stays with the other UI strings.
export function reasonFor(rule, features = {}, candidate = {}) {
  const status = candidate.status || {};
  const likes = status.favouritesCount || 0;
  switch (rule) {
    case 'always':
      return { type: 'always' };
    case 'shared':
      return { type: 'shared', count: features.sharedBy || 0 };
    case 'relative':
      return features.followers
        ? { type: 'relative', likes, followers: features.followers }
        : { type: 'raw', likes, boosts: status.reblogsCount || 0 };
    case 'raw':
      return { type: 'raw', likes, boosts: status.reblogsCount || 0 };
    case 'affinity':
      return { type: 'affinity' };
    case 'quiet':
      return { type: 'quiet', posts: features.authorPostsToday || 0 };
    case 'feeds': {
      const feed = feedNameOf(candidate);
      return feed ? { type: 'feed', feed, likes } : { type: 'raw', likes };
    }
    case 'topics':
      return { type: 'topics', topics: features.topics || [] };
    case 'random':
      return { type: 'random' };
    default:
      return { type: 'unknown' };
  }
}

// Per-rule counts over recorded digests and verdicts: how many posts each
// rule put in a digest, and how many of those the user found interesting
// (liked, boosted, replied) or marked "Not for me".
export function tallyRules(digests = [], verdicts = {}) {
  const tally = new Map();
  const row = (rule) => {
    if (!tally.has(rule)) {
      tally.set(rule, { rule, shown: 0, interesting: 0, notForMe: 0 });
    }
    return tally.get(rule);
  };
  const seen = new Set();
  for (const { picks = [] } of digests) {
    for (const { key, rule } of picks) {
      if (seen.has(key)) continue;
      seen.add(key);
      row(rule).shown++;
    }
  }
  for (const { rule, verdict } of Object.values(verdicts)) {
    if (!rule) continue;
    if (verdict === 'interesting') row(rule).interesting++;
    else if (verdict === 'not-for-me') row(rule).notForMe++;
  }
  return [...tally.values()];
}
