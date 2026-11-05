import './foryou.css';

import { msg, plural } from '@lingui/core/macro';
import { Trans, useLingui } from '@lingui/react/macro';
import { useEffect, useReducer, useRef, useState } from 'preact/hooks';
import { InView } from 'react-intersection-observer';
import { subscribe, useSnapshot } from 'valtio';
import { subscribeKey } from 'valtio/utils';

import DislikeReasons from '../components/dislike-reasons';
import FixedAccountsBanner from '../components/fixed-accounts-banner';
import Icon from '../components/icon';
import Link from '../components/link';
import Loader from '../components/loader';
import NavMenu from '../components/nav-menu';
import Status from '../components/status';
import { api } from '../utils/api';
import {
  blendDigest,
  digestCutoff,
  mulberry32,
  reasonFor,
  tallyRules,
  UNBLENDED_RULES,
} from '../utils/foryou';
import { pickForRule, RULES, scorePool } from '../utils/foryou-lab';
import { forYouSources, loadCandidates } from '../utils/foryou-load';
import {
  loadForYouState,
  recordDigestRead,
  recordVerdict,
  shownKeys,
} from '../utils/foryou-store';
import shortenNumber from '../utils/shorten-number';
import showCompose from '../utils/show-compose';
import showToast from '../utils/show-toast';
import states, { saveStatus, statusKey } from '../utils/states';
import useTitle from '../utils/useTitle';

const ruleById = new Map(RULES.map((r) => [r.id, r]));

function splitKey(key) {
  const i = key.indexOf('/');
  return { instance: key.slice(0, i), id: key.slice(i + 1) };
}

function ReasonLine({ reason }) {
  const { t } = useLingui();
  switch (reason?.type) {
    case 'always':
      return t`On your "Always show" list`;
    case 'shared':
      return plural(reason.count, {
        one: 'Shared by # person you follow',
        other: 'Shared by # people you follow',
      });
    case 'relative': {
      const likes = shortenNumber(reason.likes);
      const followers = shortenNumber(reason.followers);
      return t`${likes} likes, from an account with ${followers} followers`;
    }
    case 'raw': {
      const likes = shortenNumber(reason.likes);
      return t`${likes} likes`;
    }
    case 'affinity':
      return t`From someone you often reply to, boost or like`;
    case 'quiet':
      return plural(reason.posts, {
        one: 'From a quiet poster: # post today',
        other: 'From a quiet poster: # posts today',
      });
    case 'feed': {
      const { feed } = reason;
      const likes = shortenNumber(reason.likes);
      return t`${feed} feed, ${likes} likes`;
    }
    case 'topics': {
      const topics = reason.topics.join(', ');
      return t`About ${topics}`;
    }
    case 'random':
      return t`A random post, to check the rules against chance`;
    default:
      return null;
  }
}

// Reply, boost and like, always visible, as in the conversation thread: the
// timeline's own action bar shows only on hover, so a phone has none. The
// page counts these actions for the rule that picked the post by watching
// `states`, so the post's long-press menu counts too.
function DigestActions({ statusID, instance, masto, verdict, onNotForMe }) {
  const { t } = useLingui();
  const snapStates = useSnapshot(states);
  const key = statusKey(statusID, instance);
  const status = snapStates.statuses[key];
  const [busy, setBusy] = useState(false);
  if (!status) return null;
  const { favourited, reblogged, favouritesCount, reblogsCount, repliesCount } =
    status;

  async function toggle(field, countField, on, off) {
    const was = states.statuses[key];
    setBusy(true);
    // Optimistic, as in the full app
    states.statuses[key] = {
      ...was,
      [field]: !was[field],
      [countField]: (was[countField] || 0) + (was[field] ? -1 : 1),
    };
    try {
      const select = masto.v1.statuses.$select(statusID);
      saveStatus(await (was[field] ? select[off]() : select[on]()), instance);
    } catch (e) {
      console.error(e);
      states.statuses[key] = was;
      showToast(t`Failed: ${e?.message || e}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div class="foryou-actions">
      <button
        type="button"
        class="plain"
        onClick={() =>
          showCompose({ replyToStatus: { ...status, _instance: instance } })
        }
      >
        <Icon icon="comment" alt={t`Reply`} />
        {repliesCount > 0 && <span>{shortenNumber(repliesCount)}</span>}
      </button>
      <button
        type="button"
        class={`plain ${reblogged ? 'boosted' : ''}`}
        disabled={busy}
        aria-pressed={!!reblogged}
        onClick={() =>
          toggle('reblogged', 'reblogsCount', 'reblog', 'unreblog')
        }
      >
        <Icon icon="rocket" alt={reblogged ? t`Unboost` : t`Boost`} />
        {reblogsCount > 0 && <span>{shortenNumber(reblogsCount)}</span>}
      </button>
      <button
        type="button"
        class={`plain foryou-like ${favourited ? 'liked' : ''}`}
        disabled={busy}
        aria-pressed={!!favourited}
        onClick={() =>
          toggle('favourited', 'favouritesCount', 'favourite', 'unfavourite')
        }
      >
        <Icon icon="heart" alt={favourited ? t`Unlike` : t`Like`} />
        {favouritesCount > 0 && <span>{shortenNumber(favouritesCount)}</span>}
      </button>
      <button
        type="button"
        class={verdict === 'not-for-me' ? 'small' : 'light small'}
        onClick={onNotForMe}
      >
        {verdict === 'not-for-me' ? (
          <Trans>✓ Not for me</Trans>
        ) : (
          <Trans>Not for me</Trans>
        )}
      </button>
    </div>
  );
}

const FILTER_LABELS = {
  reply: msg`Replies`,
  language: msg`Other languages`,
  muted: msg`Muted or blocked accounts`,
  filter: msg`Your filters`,
  mutedWord: msg`Muted words`,
  shown: msg`Shown in an earlier digest`,
};

// Builds one digest from the candidate pool. See "Blend" in
// docs/design-plans/2026-11-05-for-you.md.
function buildDigest(pool, { followers, affinity, seed }) {
  const { scored, featuresByKey } = scorePool(pool, { followers, affinity });
  const ranked = (rule) =>
    pickForRule(rule, scored, { seed, limit: Infinity }).picks;
  const byKey = new Map(pool.map((c) => [c.key, c]));
  const picks = blendDigest({
    alwaysKeys: ranked(ruleById.get('always')),
    rankings: RULES.filter((r) => !UNBLENDED_RULES.has(r.id)).map((rule) => ({
      rule: rule.id,
      keys: ranked(rule),
    })),
    randomKeys: ranked(ruleById.get('random')),
    authorOf: (key) => byKey.get(key).author,
    random: mulberry32(seed),
  });
  return picks.map(({ key, rule }) => ({
    key,
    rule,
    reason: reasonFor(rule, featuresByKey.get(key), byKey.get(key)),
  }));
}

function ForYou() {
  const { t, _ } = useLingui();
  useTitle(t`For You`, '/foryou');
  const snapStates = useSnapshot(states);
  const { masto, instance } = api();
  const [reloadCount, reload] = useReducer((c) => c + 1, 0);
  const [digest, setDigest] = useState(null);
  const [error, setError] = useState(null);
  const [verdicts, setVerdicts] = useState({});
  const [reasons, setReasons] = useState({});
  const [openReasons, setOpenReasons] = useState({});
  const [finished, setFinished] = useState(false);
  const [previous, setPrevious] = useState(null);
  const [store, setStore] = useState(null);

  const sources = useRef(null);
  if (sources.current === null) {
    sources.current = forYouSources(
      { masto, instance },
      snapStates.settings.mergedTimeline,
    );
  }

  useEffect(() => {
    let cancelled = false;
    setDigest(null);
    setError(null);
    setFinished(false);
    setPrevious(null);
    setOpenReasons({});
    (async () => {
      try {
        const state = await loadForYouState();
        const now = Date.now();
        const cutoff = digestCutoff({ now, lastRead: state.lastRead });
        const { loaded, failed, pool, removed, followers, affinity } =
          await loadCandidates(sources.current, { cutoff, log: () => {} });
        const shown = shownKeys(state, now);
        removed.shown = new Set(
          pool.filter((c) => shown.has(c.key)).map((c) => c.key),
        );
        const fresh = pool.filter((c) => !shown.has(c.key));
        const seed = Math.floor(Math.random() * 1e9);
        const items = buildDigest(fresh, { followers, affinity, seed });
        const byKey = new Map(fresh.map((c) => [c.key, c]));
        for (const { key } of items) {
          const { status, instance } = byKey.get(key);
          saveStatus(status, instance);
        }
        if (cancelled) return;
        setStore(state);
        setVerdicts(state.verdicts);
        setReasons({});
        setDigest({
          items,
          cutoff,
          lastRead: state.lastRead,
          mastoByInstance: new Map(loaded.map((s) => [s.instance, s.masto])),
          removed: Object.entries(removed)
            .map(([filter, keys]) => [filter, keys.size])
            .filter(([, n]) => n > 0),
          sources: [
            ...loaded.map(({ instance, homeCount, homeHours }) => ({
              instance,
              homeCount,
              homeHours,
            })),
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

  const shownItems = previous?.items || digest?.items || [];
  const itemsRef = useRef(shownItems);
  itemsRef.current = shownItems;

  function setVerdict(key, rule, verdict, action) {
    setVerdicts((prev) => ({
      ...prev,
      [key]: { ...prev[key], rule, verdict },
    }));
    recordVerdict(key, { rule, verdict, action }).then(setStore);
  }

  // Likes, boosts and replies made from the digest count as "interesting"
  // for the rule that picked the post. Status saves its like and boost state
  // in `states.statuses`; the composer saves its last post in
  // `states.lastPosted`.
  useEffect(() => {
    if (!shownItems.length) return;
    const baseline = new Map();
    for (const { key } of shownItems) {
      const s = states.statuses[key];
      baseline.set(key, { like: !!s?.favourited, boost: !!s?.reblogged });
    }
    const counted = new Set();
    const count = (key, rule, action) => {
      if (counted.has(`${key} ${action}`)) return;
      counted.add(`${key} ${action}`);
      setVerdict(key, rule, 'interesting', action);
    };
    const unsubStatuses = subscribe(states.statuses, () => {
      for (const { key, rule } of itemsRef.current) {
        const s = states.statuses[key];
        const base = baseline.get(key);
        if (!s || !base) continue;
        if (s.favourited && !base.like) count(key, rule, 'like');
        if (s.reblogged && !base.boost) count(key, rule, 'boost');
      }
    });
    const unsubPosted = subscribeKey(states, 'lastPosted', (posted) => {
      const replyTo = posted?.replyToStatus;
      if (posted?.type !== 'reply' || !replyTo?.id) return;
      const item = itemsRef.current.find(
        ({ key }) => splitKey(key).id === replyTo.id,
      );
      if (item) count(item.key, item.rule, 'reply');
    });
    return () => {
      unsubStatuses();
      unsubPosted();
    };
  }, [shownItems]);

  function notForMe(key, rule) {
    setOpenReasons((prev) => ({ ...prev, [key]: true }));
    if (verdicts[key]?.verdict !== 'not-for-me') {
      setVerdict(key, rule, 'not-for-me');
    }
  }

  function addReason(key, rule, reason) {
    setReasons((prev) => ({ ...prev, [key]: [...(prev[key] || []), reason] }));
    setVerdict(key, rule, 'not-for-me', reason);
  }

  function finish() {
    if (finished || previous || !digest?.items.length) return;
    setFinished(true);
    recordDigestRead({
      at: Date.now(),
      picks: digest.items,
    }).then(setStore);
  }

  async function showPrevious() {
    const last = store?.digests?.at(-1);
    if (!last) return;
    setPrevious({ loading: true, items: [] });
    const items = [];
    await Promise.all(
      last.picks.map(async (pick) => {
        const { instance, id } = splitKey(pick.key);
        const client = digest.mastoByInstance.get(instance);
        if (!client) return;
        try {
          const status = await client.v1.statuses.$select(id).fetch();
          saveStatus(status, instance);
          items.push(pick);
        } catch (e) {}
      }),
    );
    const order = new Map(last.picks.map((p, i) => [p.key, i]));
    items.sort((a, b) => order.get(a.key) - order.get(b.key));
    setPrevious({ items });
  }

  const ruleTally = store ? tallyRules(store.digests, store.verdicts) : [];

  return (
    <div id="foryou-page" class="deck-container" tabIndex="-1">
      <div class="timeline-deck deck">
        <header>
          <div class="header-grid">
            <div class="header-side">
              <NavMenu />
            </div>
            <h1>
              <Trans>For You</Trans>
            </h1>
            <div class="header-side">
              <button
                type="button"
                class="plain"
                onClick={reload}
                disabled={!digest && !error}
              >
                <Trans>Reload</Trans>
              </button>
            </div>
          </div>
        </header>
        <main>
          <FixedAccountsBanner />
          {error ? (
            <p class="ui-state">
              <Trans>Failed to load: {error}</Trans>
            </p>
          ) : !digest ? (
            <div class="ui-state">
              <Loader />
              <p>
                <Trans>Reading posts from your accounts and feeds…</Trans>
              </p>
            </div>
          ) : (
            <>
              <section class="foryou-intro">
                {previous ? (
                  <p>
                    <Trans>Your previous digest.</Trans>
                  </p>
                ) : digest.lastRead ? (
                  <p>
                    <Trans>
                      Posts since{' '}
                      {new Date(digest.cutoff).toLocaleString(undefined, {
                        weekday: 'short',
                        hour: 'numeric',
                        minute: '2-digit',
                      })}
                      .
                    </Trans>
                  </p>
                ) : (
                  <p>
                    <Trans>Posts from the last 24 hours.</Trans>
                  </p>
                )}
                {digest.sources
                  .filter((s) => s.failed)
                  .map((s) => (
                    <p key={s.instance} class="foryou-failed">
                      <Trans>
                        {s.instance} not loaded. Log back in to this account to
                        include it.
                      </Trans>
                    </p>
                  ))}
              </section>
              {previous?.loading ? (
                <div class="ui-state">
                  <Loader />
                </div>
              ) : !shownItems.length ? (
                <div class="ui-state">
                  <p>
                    <Trans>Nothing new since your last digest.</Trans>
                  </p>
                  {!!store?.digests?.length && !previous && (
                    <button type="button" onClick={showPrevious}>
                      <Trans>Show the previous digest</Trans>
                    </button>
                  )}
                </div>
              ) : (
                <ol class="foryou-posts">
                  {shownItems.map(({ key, rule, reason }) => {
                    const { instance, id } = splitKey(key);
                    const verdict = verdicts[key]?.verdict;
                    return (
                      <li
                        key={key}
                        class={verdict ? `foryou-verdict-${verdict}` : ''}
                      >
                        <p class="foryou-why insignificant">
                          <ReasonLine reason={reason} />
                        </p>
                        <Link class="status-link" to={`/${instance}/s/${id}`}>
                          <Status statusID={id} instance={instance} />
                        </Link>
                        <DigestActions
                          statusID={id}
                          instance={instance}
                          masto={digest.mastoByInstance.get(instance)}
                          verdict={verdict}
                          onNotForMe={() => notForMe(key, rule)}
                        />
                        {openReasons[key] && (
                          <DislikeReasons
                            status={states.statuses[key]}
                            masto={digest.mastoByInstance.get(instance)}
                            given={reasons[key] || []}
                            onReason={(r) => addReason(key, rule, r)}
                          />
                        )}
                      </li>
                    );
                  })}
                </ol>
              )}
              {!!shownItems.length && !previous?.loading && (
                <InView
                  as="section"
                  className="foryou-end"
                  onChange={(inView) => inView && finish()}
                >
                  <p>
                    <Trans>That's all for now.</Trans>
                  </p>
                </InView>
              )}
              <footer class="foryou-footer insignificant">
                {!!digest.removed.length && (
                  <p>
                    <Trans>Removed by filters:</Trans>{' '}
                    {digest.removed
                      .map(([filter, n]) => `${_(FILTER_LABELS[filter])} ${n}`)
                      .join(' · ')}
                  </p>
                )}
                <p>
                  {digest.sources
                    .filter((s) => !s.failed)
                    .map(({ instance, homeCount, homeHours }) => (
                      <span key={instance} class="foryou-coverage">
                        <Trans>
                          {instance}: {homeCount} home posts read, back{' '}
                          {homeHours} h
                        </Trans>
                      </span>
                    ))}
                </p>
                {!!ruleTally.length && (
                  <details>
                    <summary>
                      <Trans>How each rule is doing</Trans>
                    </summary>
                    <table>
                      <thead>
                        <tr>
                          <th>
                            <Trans>Rule</Trans>
                          </th>
                          <th>
                            <Trans>Shown</Trans>
                          </th>
                          <th>
                            <Trans>Interesting</Trans>
                          </th>
                          <th>
                            <Trans>Not for me</Trans>
                          </th>
                        </tr>
                      </thead>
                      <tbody>
                        {ruleTally.map((r) => (
                          <tr key={r.rule}>
                            <td>{r.rule}</td>
                            <td>{r.shown}</td>
                            <td>{r.interesting}</td>
                            <td>{r.notForMe}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </details>
                )}
              </footer>
            </>
          )}
        </main>
      </div>
    </div>
  );
}

export default ForYou;
