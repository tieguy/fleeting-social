// For You state: last read, the digests already shown, and the verdicts.
//
// This module is the only place that knows where the state lives: the
// Fleeting service on deepthought, so every device sees the same state. Each
// write is an operation that the service applies, never the whole state.
// Calls throw ServiceUnpairedError when this device must unlock with a
// passkey, and ServiceError when the service cannot be reached.
//
// State: { lastRead, digests: [{ at, picks: [{ key, rule }] }], verdicts:
// { [key]: { rule, verdict: 'interesting' | 'not-for-me', actions: [...],
// at } } }

import { serviceFetch } from './fleeting-service';

// The key that held the state in browser storage. A device that still has
// it uploads it once, and the service merges it.
const LOCAL_KEY = 'foryouState';
// Digests older than this cannot hold a post the next digest could show,
// because the window goes back at most 24 hours.
const DIGEST_KEEP_MS = 48 * 60 * 60 * 1000;

function localState() {
  try {
    const state = JSON.parse(localStorage.getItem(LOCAL_KEY));
    if (state && typeof state === 'object') return state;
  } catch (e) {}
  return null;
}

export async function loadForYouState() {
  const local = localState();
  if (!local) return serviceFetch('/foryou');
  const state = await serviceFetch('/foryou/import', {
    method: 'POST',
    body: local,
  });
  try {
    localStorage.removeItem(LOCAL_KEY);
  } catch (e) {}
  return state;
}

// Records that the user reached the end of a digest at `at`.
export function recordDigestRead({ at, picks }) {
  return serviceFetch('/foryou/digests', {
    method: 'POST',
    body: { at, picks: picks.map(({ key, rule }) => ({ key, rule })) },
  });
}

// Records a verdict on a digest post. `action` is what the user did: 'like',
// 'boost', 'reply', or a "Not for me" reason ({ type, value }).
export function recordVerdict(key, { rule, verdict, action }) {
  return serviceFetch('/foryou/verdicts', {
    method: 'POST',
    body: { key, rule, verdict, action },
  });
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
