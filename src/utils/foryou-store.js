// For You state: last read, the digests already shown, and the verdicts.
//
// This module is the only place that knows where the state lives. It keeps
// it in browser storage for now; a service on deepthought will keep it so
// that every device sees the same state, and only this module changes then.
// So every function is async, as a network call will be.

const KEY = 'foryouState';
// Digests older than this cannot hold a post the next digest could show,
// because the window goes back at most 24 hours.
const DIGEST_KEEP_MS = 48 * 60 * 60 * 1000;
// Kept for per-rule counts over time
const DIGEST_KEEP_COUNT = 200;
const VERDICT_KEEP_COUNT = 2000;

function empty() {
  return { lastRead: null, digests: [], verdicts: {} };
}

function read() {
  try {
    const state = JSON.parse(localStorage.getItem(KEY));
    if (state && typeof state === 'object') return { ...empty(), ...state };
  } catch (e) {}
  return empty();
}

function write(state) {
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
  } catch (e) {}
}

// { lastRead, digests: [{ at, picks: [{ key, rule }] }], verdicts: { [key]:
// { rule, verdict: 'interesting' | 'not-for-me', actions: [...], at } } }
export async function loadForYouState() {
  return read();
}

// Records that the user reached the end of a digest at `at`.
export async function recordDigestRead({ at, picks }) {
  const state = read();
  state.lastRead = at;
  state.digests = [...state.digests, { at, picks }].slice(-DIGEST_KEEP_COUNT);
  write(state);
  return state;
}

// Records a verdict on a digest post. `action` is what the user did: 'like',
// 'boost', 'reply', or a "Not for me" reason ({ type, value }).
export async function recordVerdict(key, { rule, verdict, action }) {
  const state = read();
  const prev = state.verdicts[key];
  state.verdicts[key] = {
    rule,
    verdict,
    actions: [...(prev?.actions || []), action].filter(Boolean),
    at: Date.now(),
  };
  const keys = Object.keys(state.verdicts);
  if (keys.length > VERDICT_KEEP_COUNT) {
    keys
      .sort((a, b) => state.verdicts[a].at - state.verdicts[b].at)
      .slice(0, keys.length - VERDICT_KEEP_COUNT)
      .forEach((k) => delete state.verdicts[k]);
  }
  write(state);
  return state;
}

// Keys of the posts that a recent digest showed
export function shownKeys(state, now = Date.now()) {
  const keys = new Set();
  for (const { at, picks } of state?.digests || []) {
    if (now - at > DIGEST_KEEP_MS) continue;
    for (const { key } of picks) keys.add(key);
  }
  return keys;
}
