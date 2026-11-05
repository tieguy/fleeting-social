import './foryou-lab.css';

import { useEffect, useMemo, useReducer, useRef, useState } from 'preact/hooks';
import { useSnapshot } from 'valtio';

import DislikeReasons from '../components/dislike-reasons';
import FixedAccountsBanner from '../components/fixed-accounts-banner';
import Link from '../components/link';
import Loader from '../components/loader';
import NavMenu from '../components/nav-menu';
import Status from '../components/status';
import { api } from '../utils/api';
import { WINDOW_MS, runLab, scoreRules } from '../utils/foryou-lab';
import { forYouSources, loadCandidates } from '../utils/foryou-load';
import states, { saveStatus } from '../utils/states';
import useTitle from '../utils/useTitle';

// Experiment page, reached only by typing its URL. Its strings are plain
// text, not lingui macros, so they need no catalog entries.

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
    sources.current = forYouSources(
      { masto, instance },
      snapStates.settings.mergedTimeline,
    );
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
        const { loaded, failed, pool, followers, affinity } =
          await loadCandidates(sources.current, { cutoff, log });
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
          sources: [
            ...loaded.map(
              ({
                instance,
                homeCount,
                homeHours,
                homeWalk,
                always,
                feeds,
                own,
                likes,
              }) => ({
                instance,
                homeCount,
                homeHours,
                homePages: homeWalk.pages,
                homeStop: homeWalk.stop,
                always,
                feeds,
                activity: own.length + likes.length,
              }),
            ),
            ...failed,
          ],
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
                  {lab.sources.map((s) =>
                    s.failed ? (
                      <li key={s.instance} class="lab-failed">
                        <b>{s.instance}</b>: not loaded ({s.failed}). Log back
                        in to this account to include it.
                      </li>
                    ) : (
                      <li key={s.instance}>
                        <b>{s.instance}</b>: {s.homeCount} home items over{' '}
                        {s.homeHours} h
                        {s.feeds.map((f) => (
                          <span key={f.title}>
                            {' '}
                            · {f.title} {f.failed ? '(failed)' : f.count}
                          </span>
                        ))}{' '}
                        · {s.activity} of your posts and likes ·{' '}
                        {s.always
                          ? s.always.failed
                            ? '"Always show" list failed'
                            : `"Always show" list ${s.always.count}`
                          : 'no "Always show" list'}
                      </li>
                    ),
                  )}
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
                          status={c.status}
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
                            : ''} ·{' '}
                          {[...c.origins].join(', ')}
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
