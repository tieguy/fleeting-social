import './conversations.css';

import { Plural, Trans, useLingui } from '@lingui/react/macro';
import { useEffect, useReducer, useRef, useState } from 'preact/hooks';
import { useSnapshot } from 'valtio';

import Avatar from '../components/avatar';
import FixedAccountsBanner from '../components/fixed-accounts-banner';
import Icon from '../components/icon';
import Link from '../components/link';
import Loader from '../components/loader';
import RelativeTime from '../components/relative-time';
import { api } from '../utils/api';
import { getOtherNetworkAccounts } from '../utils/bluesky';
import {
  PAGE_CAP,
  groupConversations,
  statusExtras,
} from '../utils/conversation-group';
import { dayRelation, nextOpening } from '../utils/conversation-schedule';
import DateTimeFormat from '../utils/date-time-format';
import { walkUntilCutoff } from '../utils/engagement-tally';
import getHTMLText from '../utils/getHTMLText';
import showCompose from '../utils/show-compose';
import states, { saveStatus } from '../utils/states';
import useConversationMode from '../utils/useConversationMode';
import useTitle from '../utils/useTitle';

const LIMIT = 40;
const DAY_MS = 24 * 60 * 60 * 1000;

function names(accounts) {
  const list = accounts.map((a) => a.displayName || a.username || a.acct);
  if (list.length <= 2) return list.join(', ');
  return `${list.slice(0, 2).join(', ')} +${list.length - 2}`;
}

// A row's excerpt is text only, so it names what it leaves out.
function Extras({ status }) {
  const { images, videos, others, quote, card, poll } = statusExtras(status);
  if (!images && !videos && !others && !quote && !card && !poll) return null;
  return (
    <div class="conversation-extras">
      {images > 0 && (
        <span>
          <Icon icon="media" size="s" />{' '}
          <Plural value={images} one="# image" other="# images" />
        </span>
      )}
      {videos > 0 && (
        <span>
          <Icon icon="media" size="s" />{' '}
          <Plural value={videos} one="# video" other="# videos" />
        </span>
      )}
      {others > 0 && (
        <span>
          <Icon icon="attachment" size="s" />{' '}
          <Plural value={others} one="# attachment" other="# attachments" />
        </span>
      )}
      {quote && (
        <span>
          <Icon icon="quote" size="s" /> <Trans>Quoted post</Trans>
        </span>
      )}
      {card && (
        <span>
          <Icon icon="link" size="s" /> <Trans>Link preview</Trans>
        </span>
      )}
      {poll && (
        <span>
          <Icon icon="poll" size="s" /> <Trans>Poll</Trans>
        </span>
      )}
    </div>
  );
}

// The conversation list: threads with a reply or mention to the user in the
// last day, from every merged source, one more day per tap of the footer
// button. In conversation mode this
// is the only page, so the header carries no navigation menu and no home link.
// Each row opens its thread at the latest response.
function Conversations() {
  const { t } = useLingui();
  useTitle(t`Conversations`, '/conversations');
  const snapStates = useSnapshot(states);
  const { masto, instance } = api();
  const [uiState, setUIState] = useState('default');
  const [entries, setEntries] = useState(null);
  const [failed, setFailed] = useState([]);
  const [days, setDays] = useState(1);
  const [hasMore, setHasMore] = useState(false);
  const [reloadCount, reload] = useReducer((c) => c + 1, 0);

  const sources = useRef(null);
  if (sources.current === null) {
    sources.current = [
      { masto, instance },
      ...(snapStates.settings.mergedTimeline
        ? getOtherNetworkAccounts().map((account) => api({ account }))
        : []),
    ];
  }

  // Per source: the notifications iterator and everything read from it so
  // far. "Show one more day" continues the same iterators instead of
  // starting over. A refresh starts over at one day.
  const walks = useRef(null);
  function resetWalks() {
    walks.current = sources.current.map(({ masto, instance }) => ({
      instance,
      iterator: masto.v1.notifications
        .list({ limit: LIMIT, types: ['mention'] })
        .values(),
      notifications: [],
      ended: false,
    }));
  }

  useEffect(() => {
    resetWalks();
    setDays(1);
    load(1);
  }, [reloadCount]);

  useEffect(() => {
    if (days > 1) load(days);
  }, [days]);

  async function load(days) {
    setUIState('loading');
    const cutoff = Date.now() - days * DAY_MS;
    const older = (n) => Date.parse(n.createdAt) < cutoff;
    const current = walks.current;
    const results = await Promise.allSettled(
      current.map(async (walk) => {
        if (walk.ended || walk.notifications.some(older)) return;
        const { notifications, capped } = await walkUntilCutoff(walk.iterator, {
          cutoff,
          pageCap: PAGE_CAP,
        });
        walk.notifications.push(...notifications);
        if (!capped && !notifications.some(older)) walk.ended = true;
      }),
    );
    if (walks.current !== current) return;

    const failedInstances = [];
    // A block body: the build's console stripping leaves an empty arrow body
    // otherwise, which does not parse.
    results.forEach((r, i) => {
      if (r.status !== 'rejected') return;
      console.error(r.reason);
      failedInstances.push(current[i].instance);
    });
    setFailed(failedInstances);
    if (failedInstances.length === current.length) {
      setUIState('error');
      return;
    }
    const next = groupConversations(
      current.map(({ instance, notifications }) => ({
        instance,
        notifications: notifications.filter((n) => !older(n)),
      })),
    );
    next.forEach(({ latestStatus, instance }) =>
      saveStatus(latestStatus, instance),
    );
    setEntries(next);
    setHasMore(current.some((walk) => !walk.ended));
    setUIState('default');
  }

  return (
    <div id="conversations-page" class="deck-container" tabIndex="-1">
      <div class="timeline-deck deck">
        <header>
          <div class="header-grid">
            <div class="header-side" />
            <h1>
              <Trans>Conversations</Trans>
            </h1>
            <div class="header-side">
              <button type="button" class="plain" onClick={() => showCompose()}>
                <Icon icon="quill" size="l" alt={t`New post`} />
              </button>
              <button
                type="button"
                class="plain"
                onClick={reload}
                disabled={uiState === 'loading'}
              >
                <Icon icon="refresh" size="l" alt={t`Refresh`} />
              </button>
            </div>
          </div>
          <NextWindow />
        </header>
        <main>
          <FixedAccountsBanner />
          {failed.length > 0 && (
            <p class="conversations-notice">
              <Trans>Couldn’t load: {failed.join(', ')}</Trans>
            </p>
          )}
          {!entries ? (
            <p class="ui-state">
              {uiState === 'error' ? (
                t`Unable to load conversations.`
              ) : (
                <Loader />
              )}
            </p>
          ) : entries.length ? (
            <ul class="conversations">
              {entries.map((entry) => {
                const account = entry.accounts[0];
                const bluesky = !!entry.latestStatus._bluesky;
                return (
                  <li key={entry.key}>
                    <Link
                      class="conversation-row"
                      to={`/conversations/${entry.instance}/${entry.latestStatus.id}`}
                    >
                      <Avatar
                        url={account?.avatar}
                        size="xxl"
                        alt={account?.displayName}
                        squircle={account?.bot}
                      />
                      <div class="conversation-content">
                        <div class="conversation-top">
                          <span class="conversation-name">
                            {names(entry.accounts)}
                          </span>
                          <Icon
                            icon={bluesky ? 'bluesky' : 'mastodon'}
                            size="s"
                            class="network-badge"
                            alt={bluesky ? 'Bluesky' : 'Mastodon'}
                          />
                          <RelativeTime
                            datetime={entry.latestAt}
                            format="micro"
                          />
                        </div>
                        <div class="conversation-snippet">
                          {getHTMLText(entry.latestStatus.content) || <i>…</i>}
                        </div>
                        <Extras status={entry.latestStatus} />
                        {entry.responseCount > 1 && (
                          <div class="conversation-count">
                            <Plural
                              value={entry.responseCount}
                              one="# reply"
                              other="# replies"
                            />
                          </div>
                        )}
                      </div>
                    </Link>
                  </li>
                );
              })}
            </ul>
          ) : (
            <p class="ui-state insignificant">
              <Plural
                value={days}
                one="No replies or mentions in the last day."
                other="No replies or mentions in the last # days."
              />
            </p>
          )}
          {!!entries && (
            <div class="conversations-footer">
              {uiState === 'loading' ? (
                <Loader />
              ) : hasMore ? (
                <button
                  type="button"
                  class="plain block"
                  onClick={() => setDays((d) => d + 1)}
                >
                  <Trans>Show one more day</Trans>
                </button>
              ) : (
                <p class="ui-state insignificant">
                  <Trans>No older replies or mentions.</Trans>
                </p>
              )}
            </div>
          )}
        </main>
      </div>
    </div>
  );
}

// A quiet line under the title: when the full app opens next. Shown only in
// conversation mode; the hook re-renders it at each window edge.
function NextWindow() {
  const { t, i18n } = useLingui();
  const conversationMode = useConversationMode();
  if (!conversationMode) return null;
  const now = new Date();
  const next = nextOpening(now);
  if (!next) return null;
  const time = DateTimeFormat(i18n.locale, {
    hour: 'numeric',
    minute: '2-digit',
  }).format(next);
  const relation = dayRelation(now, next);
  const weekday = DateTimeFormat(i18n.locale, { weekday: 'long' }).format(next);
  return (
    <p class="conversations-next-window">
      {relation === 'today'
        ? t`Full app opens today at ${time}`
        : relation === 'tomorrow'
          ? t`Full app opens tomorrow at ${time}`
          : t`Full app opens ${weekday} at ${time}`}
    </p>
  );
}

export default Conversations;
