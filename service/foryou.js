// For You state operations. Pure: each takes the stored state and returns a
// new one. The browser sends operations, never the whole state, so two
// devices that write at the same time do not lose each other's writes.
//
// State: { lastRead, digests: [{ at, picks: [{ key, rule }] }], verdicts:
// { [key]: { rule, verdict, actions: [...], at } } }

export const DIGEST_KEEP_COUNT = 200;
export const VERDICT_KEEP_COUNT = 2000;
const VERDICTS = new Set(['interesting', 'not-for-me']);

export class BadRequest extends Error {}

function check(condition, message) {
  if (!condition) throw new BadRequest(message);
}

const isTime = (v) => Number.isFinite(v) && v > 0;
const isText = (v) => typeof v === 'string' && v.length > 0 && v.length < 500;

export function emptyState() {
  return { lastRead: null, digests: [], verdicts: {} };
}

function later(a, b) {
  if (!isTime(a)) return isTime(b) ? b : null;
  if (!isTime(b)) return a;
  return Math.max(a, b);
}

function cleanPicks(picks) {
  check(Array.isArray(picks) && picks.length <= 500, 'picks must be a list');
  return picks.map((p) => {
    check(isText(p?.key) && isText(p?.rule), 'each pick needs key and rule');
    return { key: p.key, rule: p.rule };
  });
}

function cleanAction(action) {
  if (action == null) return null;
  if (isText(action)) return action;
  check(
    typeof action === 'object' &&
      isText(action.type) &&
      JSON.stringify(action).length < 1000,
    'bad action',
  );
  return action;
}

function capVerdicts(verdicts) {
  const keys = Object.keys(verdicts);
  if (keys.length <= VERDICT_KEEP_COUNT) return verdicts;
  const keep = keys
    .sort((a, b) => verdicts[b].at - verdicts[a].at)
    .slice(0, VERDICT_KEEP_COUNT);
  return Object.fromEntries(keep.map((k) => [k, verdicts[k]]));
}

function sortDigests(digests) {
  return [...digests].sort((a, b) => a.at - b.at).slice(-DIGEST_KEEP_COUNT);
}

// The user reached the end of a digest at `at`
export function addDigest(state, { at, picks } = {}) {
  check(isTime(at), 'at must be a time');
  const clean = cleanPicks(picks);
  return {
    ...state,
    lastRead: later(state.lastRead, at),
    digests: sortDigests([...state.digests, { at, picks: clean }]),
  };
}

// A verdict on a digest post. Each call appends its action.
export function addVerdict(
  state,
  { key, rule, verdict, action } = {},
  now = Date.now(),
) {
  check(isText(key), 'key is required');
  check(isText(rule), 'rule is required');
  check(VERDICTS.has(verdict), 'unknown verdict');
  const clean = cleanAction(action);
  const prev = state.verdicts[key];
  return {
    ...state,
    verdicts: capVerdicts({
      ...state.verdicts,
      [key]: {
        rule,
        verdict,
        actions: [...(prev?.actions || []), clean].filter(Boolean),
        at: now,
      },
    }),
  };
}

// Import skips what it cannot use instead of failing: a device that cannot
// upload its old state would never get past the upload.
function lenient(fn, value) {
  try {
    return fn(value);
  } catch (e) {
    if (e instanceof BadRequest) return null;
    throw e;
  }
}

function digestId({ at, picks }) {
  return `${at} ${picks.map((p) => p.key).join(' ')}`;
}

// Merges one device's local state into the stored state
export function importState(state, incoming = {}) {
  check(incoming && typeof incoming === 'object', 'state must be an object');
  const digests = new Map(state.digests.map((d) => [digestId(d), d]));
  for (const d of incoming.digests || []) {
    const picks = lenient(cleanPicks, d?.picks);
    if (!isTime(d?.at) || !picks) continue;
    const clean = { at: d.at, picks };
    digests.set(digestId(clean), clean);
  }

  const verdicts = { ...state.verdicts };
  for (const [key, v] of Object.entries(incoming.verdicts || {})) {
    if (!isText(key) || !isText(v?.rule) || !VERDICTS.has(v?.verdict)) {
      continue;
    }
    const theirs = {
      rule: v.rule,
      verdict: v.verdict,
      actions: (Array.isArray(v.actions) ? v.actions : [])
        .map((a) => lenient(cleanAction, a))
        .filter(Boolean),
      at: isTime(v.at) ? v.at : 0,
    };
    const ours = verdicts[key];
    if (!ours) {
      verdicts[key] = theirs;
      continue;
    }
    const [older, newer] =
      ours.at >= theirs.at ? [theirs, ours] : [ours, theirs];
    verdicts[key] = {
      ...newer,
      actions: [...older.actions, ...newer.actions],
    };
  }

  return {
    lastRead: later(state.lastRead, incoming.lastRead),
    digests: sortDigests([...digests.values()]),
    verdicts: capVerdicts(verdicts),
  };
}
