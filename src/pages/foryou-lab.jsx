import './foryou-lab.css';

import { useEffect, useMemo, useReducer, useRef, useState } from 'preact/hooks';
import { useSnapshot } from 'valtio';

import FixedAccountsBanner from '../components/fixed-accounts-banner';
import Link from '../components/link';
import Loader from '../components/loader';
import NavMenu from '../components/nav-menu';
import Status from '../components/status';
import { api } from '../utils/api';
import { getOtherNetworkAccounts } from '../utils/bluesky';
import { idToAtUri } from '../utils/bluesky/convert';
import {
  LAB_FEEDS,
  WINDOW_MS,
  affinityFromActivity,
  authorKey,
  buildPool,
  runLab,
  scoreRules,
} from '../utils/foryou-lab';
import { muteWordEverywhere } from '../utils/mute-word';
import showToast from '../utils/show-toast';
import states, { saveStatus } from '../utils/states';
import useTitle from '../utils/useTitle';

// Experiment page, reached only by typing its URL. Its strings are plain
// text, not lingui macros, so they need no catalog entries.

const HOME_PAGES = 30;
const FEED_PAGES = 4;
const ACTIVITY_PAGES = 3;
const PROFILE_CONCURRENCY = 6;
const VERDICTS_KEY = 'foryouLabVerdicts';
const REASONS_KEY = 'foryouLabReasons';

function loadVerdicts() {
  try {
    return JSON.parse(localStorage.getItem(VERDICTS_KEY)) || {};
  } catch (e) {
    return {};
  }
}

function saveVerdicts(verdicts) {
  try {
    localStorage.setItem(VERDICTS_KEY, JSON.stringify(verdicts));
  } catch (e) {}
}

// Reasons given for "Not for me", by post key: [{ type, value }]
function loadReasons() {
  try {
    return JSON.parse(localStorage.getItem(REASONS_KEY)) || {};
  } catch (e) {
    return {};
  }
}

function saveReasons(reasons) {
  try {
    localStorage.setItem(REASONS_KEY, JSON.stringify(reasons));
  } catch (e) {}
}

function hashtagsOf(status) {
  const names = (status.tags || []).map((t) => t.name);
  return [...new Set(names.filter(Boolean).map((n) => n.toLowerCase()))];
}

// The reasons offered after "Not for me". Each one but "Just this post" also
// acts: it mutes or blocks the author on the post's network, or mutes a word
// on every logged-in account, so the dislike and the fix are one tap.
function DislikeReasons({ candidate, masto, given, onReason }) {
  const { status } = candidate;
  const account = status.account;
  const [busy, setBusy] = useState(false);
  const [word, setWord] = useState('');
  const selection = useRef('');
  const done = (type, value) =>
    given.some((r) => r.type === type && r.value === value);

  async function act(type, value, action) {
    if (busy || done(type, value)) return;
    setBusy(true);
    try {
      if (action) await action();
      onReason({ type, value });
    } catch (e) {
      console.error(e);
      showToast(`Failed: ${e?.message || e}`);
    }
    setBusy(false);
  }

  async function muteWord(value) {
    const word = (value || '').trim();
    if (!word) return;
    await act('mute-word', word, async () => {
      const instances = await muteWordEverywhere(word, { expiresIn: 0 });
      if (!instances.length) throw new Error('no account accepted the mute');
      showToast(`Muted "${word}" on ${instances.join(', ')}`);
    });
  }

  const button = (type, value, label, action) => (
    <button
      type="button"
      class={done(type, value) ? '' : 'light'}
      disabled={busy}
      onClick={() => act(type, value, action)}
    >
      {done(type, value) ? `✓ ${label}` : label}
    </button>
  );

  return (
    <div class="lab-reasons">
      <span class="insignificant">Why?</span>
      {button('post', '', 'Just this post')}
      {button('mute-author', account?.acct, `Mute @${account?.acct}`, () =>
        masto.v1.accounts.$select(account.id).mute(),
      )}
      {button('block-author', account?.acct, 'Block', () =>
        masto.v1.accounts.$select(account.id).block(),
      )}
      {hashtagsOf(status).map((tag) => (
        <button
          key={tag}
          type="button"
          class={done('mute-word', tag) ? '' : 'light'}
          disabled={busy}
          onClick={() => muteWord(tag)}
        >
          {done('mute-word', tag) ? `✓ Muted ${tag}` : `Mute #${tag}`}
        </button>
      ))}
      <button
        type="button"
        class="light"
        disabled={busy}
        // Read the selection before the tap can clear it
        onPointerDown={() => {
          selection.current = String(window.getSelection() || '').trim();
        }}
        onClick={() => {
          const text =
            selection.current || String(window.getSelection() || '').trim();
          if (text) muteWord(text);
          else showToast('Select a word or phrase in the post first');
        }}
      >
        Mute selected text
      </button>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          muteWord(word).then(() => setWord(''));
        }}
      >
        <input
          type="text"
          placeholder="Mute a word…"
          value={word}
          onInput={(e) => setWord(e.target.value)}
          disabled={busy}
        />
      </form>
      {given
        .filter(
          (r) =>
            r.type === 'mute-word' && !hashtagsOf(status).includes(r.value),
        )
        .map((r) => (
          <span key={r.value} class="insignificant">
            ✓ Muted "{r.value}"
          </span>
        ))}
    </div>
  );
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

async function loadSource({ masto, instance }, cutoff, log) {
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
  try {
    lists = (await masto.v1.lists.list()).filter(
      (l) => l._feed && LAB_FEEDS.has(idToAtUri(l.id)),
    );
  } catch (e) {
    console.error(e);
  }
  const feeds = [];
  for (const list of lists) {
    log(`${instance}: reading feed "${list.title}"`);
    try {
      const items = await collect(
        masto.v1.timelines.list.$select(list.id).list({ limit: 50 }).values(),
        { pages: FEED_PAGES },
      );
      feeds.push({ title: list.title, count: items.length });
      for (const item of items) {
        entries.push({ item, origin: `feed: ${list.title}`, instance });
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
    feeds,
    own: own.map((status) => ({ instance, status })),
    likes: likes.map((status) => ({ instance, status })),
  };
}

// Follower counts for every author in the pool. Mastodon statuses carry them;
// Bluesky post authors are partial profiles, so those are fetched.
async function loadFollowers(pool, sources, log) {
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

function fmt(n, digits = 2) {
  return n === null || n === undefined ? '–' : Number(n.toFixed(digits));
}

function ForYouLab() {
  useTitle('For You lab', '/_foryou-lab');
  const snapStates = useSnapshot(states);
  const { masto, instance } = api();
  const [reloadCount, reload] = useReducer((c) => c + 1, 0);
  const [progress, setProgress] = useState([]);
  const [lab, setLab] = useState(null);
  const [error, setError] = useState(null);
  const [verdicts, setVerdicts] = useState(loadVerdicts);
  const [reasons, setReasons] = useState(loadReasons);
  const [revealed, setRevealed] = useState(false);
  const [copied, setCopied] = useState(false);

  const sources = useRef(null);
  if (sources.current === null) {
    sources.current = [
      { masto, instance },
      ...(snapStates.settings.mergedTimeline
        ? getOtherNetworkAccounts().map((account) => api({ account }))
        : []),
    ];
  }

  useEffect(() => {
    let cancelled = false;
    const log = (line) => !cancelled && setProgress((p) => [...p, line]);
    setLab(null);
    setError(null);
    setProgress([]);
    setRevealed(false);
    (async () => {
      const cutoff = Date.now() - WINDOW_MS;
      try {
        const loaded = await Promise.all(
          sources.current.map((s) => loadSource(s, cutoff, log)),
        );
        const pool = buildPool(
          loaded.flatMap((s) => s.entries),
          {
            cutoff,
            selfKeys: new Set(loaded.map((s) => s.selfKey)),
            mutedWords: loaded.flatMap((s) => s.mutedWords),
          },
        );
        log(`Pool: ${pool.length} posts. Reading follower counts`);
        const followers = await loadFollowers(pool, loaded, log);
        const affinity = affinityFromActivity({
          ownStatuses: loaded.flatMap((s) => s.own),
          likes: loaded.flatMap((s) => s.likes),
        });
        const seed = Math.floor(Math.random() * 1e9);
        const result = runLab(pool, { followers, affinity, seed });
        const byKey = new Map(pool.map((c) => [c.key, c]));
        for (const key of result.union) {
          const { status, instance } = byKey.get(key);
          saveStatus(status, instance);
        }
        if (cancelled) return;
        setLab({
          ...result,
          byKey,
          mastoByInstance: new Map(loaded.map((s) => [s.instance, s.masto])),
          poolSize: pool.length,
          sources: loaded.map(
            ({
              instance,
              homeCount,
              homeHours,
              homeWalk,
              feeds,
              own,
              likes,
            }) => ({
              instance,
              homeCount,
              homeHours,
              homePages: homeWalk.pages,
              homeStop: homeWalk.stop,
              feeds,
              activity: own.length + likes.length,
            }),
          ),
        });
      } catch (e) {
        console.error(e);
        if (!cancelled) setError(String(e?.message || e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [reloadCount]);

  function judge(key, verdict) {
    setVerdicts((prev) => {
      const next = { ...prev };
      if (next[key] === verdict) delete next[key];
      else next[key] = verdict;
      saveVerdicts(next);
      return next;
    });
  }

  function addReason(key, reason) {
    setVerdicts((prev) => {
      if (prev[key] === 'down') return prev;
      const next = { ...prev, [key]: 'down' };
      saveVerdicts(next);
      return next;
    });
    setReasons((prev) => {
      const next = { ...prev, [key]: [...(prev[key] || []), reason] };
      saveReasons(next);
      return next;
    });
  }

  const results = useMemo(
    () => (lab ? scoreRules(lab.rules, verdicts) : []),
    [lab, verdicts],
  );
  const judgedCount = lab ? lab.union.filter((key) => verdicts[key]).length : 0;

  function exportJSON() {
    const rulesByKey = new Map();
    for (const rule of lab.rules) {
      for (const key of rule.picks) {
        rulesByKey.set(key, [...(rulesByKey.get(key) || []), rule.id]);
      }
    }
    const data = {
      ranAt: new Date().toISOString(),
      poolSize: lab.poolSize,
      sources: lab.sources,
      rules: results.map(({ id, eligible, picks, up, judged }) => ({
        id,
        eligible,
        picks: picks.length,
        judged,
        up,
      })),
      posts: lab.union.map((key) => {
        const c = lab.byKey.get(key);
        return {
          key,
          verdict: verdicts[key] || null,
          reasons: reasons[key] || [],
          rules: rulesByKey.get(key),
          author: c.status.account?.acct,
          // Language the author's client declared, not detected from the text
          language: c.status.language || null,
          origins: [...c.origins],
          features: lab.featuresByKey.get(key),
          counts: {
            replies: c.status.repliesCount,
            boosts: c.status.reblogsCount,
            likes: c.status.favouritesCount,
            quotes: c.status.quotesCount,
          },
          text: c.text.slice(0, 200),
        };
      }),
    };
    navigator.clipboard
      ?.writeText(JSON.stringify(data, null, 1))
      .then(() => setCopied(true));
  }

  const rulesForKey = (key) =>
    lab.rules.filter((r) => r.picks.includes(key)).map((r) => r.id);

  return (
    <div id="foryou-lab-page" class="deck-container" tabIndex="-1">
      <div class="timeline-deck deck">
        <header>
          <div class="header-grid">
            <div class="header-side">
              <NavMenu />
            </div>
            <h1>For You lab</h1>
            <div class="header-side">
              <button
                type="button"
                class="plain"
                onClick={reload}
                disabled={!lab && !error}
              >
                Reload
              </button>
            </div>
          </div>
        </header>
        <main>
          <FixedAccountsBanner />
          {error ? (
            <p class="ui-state">Failed: {error}</p>
          ) : !lab ? (
            <div class="ui-state">
              <Loader />
              <ul class="lab-progress">
                {progress.map((line, i) => (
                  <li key={i}>{line}</li>
                ))}
              </ul>
            </div>
          ) : (
            <>
              <section class="lab-intro">
                <p>
                  {lab.union.length} posts, picked by {lab.rules.length} rules
                  from a pool of {lab.poolSize} posts from the last 24 hours, in
                  random order. Mark each one. The rules stay hidden until you
                  reveal them.
                </p>
                <ul class="lab-sources">
                  {lab.sources.map((s) => (
                    <li key={s.instance}>
                      <b>{s.instance}</b>: {s.homeCount} home items over{' '}
                      {s.homeHours} h
                      {s.feeds.map((f) => (
                        <span key={f.title}>
                          {' '}
                          · {f.title} {f.failed ? '(failed)' : f.count}
                        </span>
                      ))}{' '}
                      · {s.activity} of your posts and likes
                    </li>
                  ))}
                </ul>
                <p>
                  Judged {judgedCount} of {lab.union.length}.{' '}
                  <button type="button" onClick={() => setRevealed((r) => !r)}>
                    {revealed ? 'Hide rules' : 'Reveal rules'}
                  </button>{' '}
                  <button type="button" onClick={exportJSON}>
                    {copied ? 'Copied' : 'Copy results as JSON'}
                  </button>
                </p>
              </section>
              {revealed && (
                <table class="lab-results">
                  <thead>
                    <tr>
                      <th>Rule</th>
                      <th>Eligible</th>
                      <th>Interesting / judged</th>
                    </tr>
                  </thead>
                  <tbody>
                    {results.map((r) => (
                      <tr key={r.id}>
                        <td>
                          <b>{r.name}</b>
                          <br />
                          <small>{r.note}</small>
                        </td>
                        <td>{r.eligible}</td>
                        <td>
                          {r.up} / {r.judged}
                          {r.judged < r.picks.length &&
                            ` (${r.picks.length - r.judged} unjudged)`}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
              <ol class="lab-posts">
                {lab.union.map((key) => {
                  const c = lab.byKey.get(key);
                  const f = lab.featuresByKey.get(key);
                  const verdict = verdicts[key];
                  return (
                    <li key={key} class={verdict ? `judged-${verdict}` : ''}>
                      <Status
                        status={c.status}
                        instance={c.instance}
                        size="s"
                        previewMode
                        readOnly
                      />
                      <div class="lab-actions">
                        <button
                          type="button"
                          class={verdict === 'up' ? '' : 'light'}
                          onClick={() => judge(key, 'up')}
                        >
                          Interesting
                        </button>
                        <button
                          type="button"
                          class={verdict === 'down' ? '' : 'light'}
                          onClick={() => judge(key, 'down')}
                        >
                          Not for me
                        </button>
                        <Link
                          to={`/${c.instance}/s/${c.status.id}`}
                          target="_blank"
                        >
                          Open
                        </Link>
                      </div>
                      {verdict === 'down' && (
                        <DislikeReasons
                          candidate={c}
                          masto={lab.mastoByInstance.get(c.instance)}
                          given={reasons[key] || []}
                          onReason={(reason) => addReason(key, reason)}
                        />
                      )}
                      {revealed && (
                        <p class="lab-why insignificant">
                          {rulesForKey(key).join(', ')} ·{' '}
                          {f.followed ? 'followed' : 'not followed'} · relative{' '}
                          {fmt(f.relative, 3)} · raw {fmt(f.raw, 1)} · followers{' '}
                          {f.followers ?? '–'} · shared by {f.sharedBy} ·
                          affinity {f.affinity} · posts today{' '}
                          {f.authorPostsToday}
                          {f.topics.length
                            ? ` · ${f.topics.join(', ')}`
                            : ''} · {[...c.origins].join(', ')}
                        </p>
                      )}
                    </li>
                  );
                })}
              </ol>
            </>
          )}
        </main>
      </div>
    </div>
  );
}

export default ForYouLab;
