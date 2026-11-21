import { Trans, useLingui } from '@lingui/react/macro';
import { MenuItem } from '@szhsin/react-menu';
import { useMemo, useState } from 'preact/hooks';
import { useSnapshot } from 'valtio';

import { eligibleAccounts } from '../utils/acting-accounts';
import { api } from '../utils/api';
import { isBlueskyInstance } from '../utils/bluesky';
import haptics from '../utils/haptics';
import {
  getQuotePolicy,
  quoteMessages,
  supportsNativeQuote,
} from '../utils/quote-utils';
import RTF from '../utils/relative-time-format';
import shortenNumber from '../utils/shorten-number';
import showCompose from '../utils/show-compose';
import showToast from '../utils/show-toast';
import states, { saveStatus, statusKey } from '../utils/states';
import {
  getAccountByInstance,
  getAccounts,
  hasAccountInInstance,
  isSelfAccountID,
} from '../utils/store-utils';

import Icon from './icon';
import MenuConfirm from './menu-confirm';

const { DEV } = import.meta.env;

// The boost/quote menu, shared by the status action bar (the rocket button)
// and the status context menu's "Boost" submenu. Extracted from
// status.jsx's two inline MenuConfirm blocks.
//
// `children` is the trigger: the menu button when !subMenu, the submenu
// label when subMenu. `showBoostAs={false}` omits the "Boost as @…" items
// (the action-bar variant, where they live in the overflow menu instead).
// `status` is optional: the status in hand, as `Status` takes it — used
// when present, else looked up in the store. Statuses that are never
// saved to the store (e.g. search results) still get their menu.
function BoostQuoteMenu({
  statusID,
  status: propStatus,
  instance: propInstance,
  subMenu = false,
  showBoostAs = true,
  children,
}) {
  const { _, t, i18n } = useLingui();
  const rtf = RTF(i18n.locale);

  const { masto, instance, authenticated } = api({ instance: propInstance });
  const { instance: currentInstance } = api();
  // Posts from any logged-in account's instance (either network) are
  // interactable — api({instance}) routes actions through that account's
  // own authenticated client
  const sameInstance =
    instance === currentInstance ||
    (authenticated && hasAccountInInstance(instance));

  let sKey = statusKey(statusID || propStatus?.id, instance);
  const snapStates = useSnapshot(states);
  let status = propStatus;
  if (!status) {
    status = snapStates.statuses[sKey] || snapStates.statuses[statusID];
    sKey = statusKey(status?.id, instance);
  }

  const [renderingCard, setRenderingCard] = useState(false);

  const {
    id,
    account: { id: accountId, acct, username } = {},
    reblogged,
    reblogsCount,
    quotesCount,
    visibility, // public, unlisted, private, direct
    createdAt,
    mediaAttachments = [],
    quoteApproval,
    url,
    uri,
    _bluesky,
  } = status || {};

  const unauthInteractionErrorMessage = t`Sorry, your current logged-in server can't interact with this post from another server.`;

  // Can boost if:
  // - authenticated AND
  // - visibility != direct OR
  // - visibility = private AND isSelf
  const isPublic = ['public', 'unlisted'].includes(visibility);
  let canBoost = authenticated && isPublic;
  const isSelf = isSelfAccountID(accountId, instance);
  if (visibility === 'private' && isSelf) {
    canBoost = true;
  }

  let quoteDisabled = false;
  let quoteText = t`Quote`;
  let quoteMetaText;

  if (supportsNativeQuote(instance)) {
    const { disabled, reason } = getQuotePolicy({
      visibility,
      isSelf,
      quoteApproval,
    });
    quoteDisabled = disabled;
    if (reason === 'requestQuote') {
      quoteText = _(quoteMessages.requestQuote);
      quoteMetaText = _(quoteMessages.quoteManualReview);
    } else if (reason) {
      quoteMetaText = _(quoteMessages[reason]);
    }
  }

  // Compose routes posts through the status's _instance client; native
  // Mastodon statuses don't carry it, so stamp it before handing off —
  // otherwise replies/quotes cross-account go through the wrong client
  const composeStatus = (s = status) =>
    s && instance && !s._instance ? { ...s, _instance: instance } : s;

  const confirmBoostStatus = async () => {
    if (!sameInstance || !authenticated) {
      alert(unauthInteractionErrorMessage);
      return false;
    }
    try {
      // Optimistic
      states.statuses[sKey] = {
        ...status,
        reblogged: !reblogged,
        reblogsCount: reblogsCount + (reblogged ? -1 : 1),
      };
      if (reblogged) {
        const newStatus = await masto.v1.statuses.$select(id).unreblog();
        saveStatus(newStatus, instance);
      } else {
        const newStatus = await masto.v1.statuses.$select(id).reblog();
        saveStatus(newStatus, instance);
      }
      return true;
    } catch (e) {
      console.error(e);
      // Revert optimistism
      states.statuses[sKey] = status;
      return false;
    }
  };

  // "Boost as…": other logged-in accounts on this status's network. The
  // account the plain Boost acts through (the one owning `instance`) is
  // excluded — it's the default path above.
  const defaultActingAccount = getAccountByInstance(instance);
  const boostAsAccounts = eligibleAccounts({
    targetIsBluesky: _bluesky || isBlueskyInstance(instance),
    accounts: getAccounts(),
  }).filter((a) => a.info.id !== defaultActingAccount?.info?.id);

  // Resolve this status for another acting account: same instance (or any
  // Bluesky account — its ids are network-global) uses the id directly; a
  // Mastodon account on another instance must resolve the status URL on
  // its own server first.
  const resolveStatusAs = async (account) => {
    const { masto: actingMasto, instance: actingInstance } = api({
      account,
    });
    let targetId = id;
    if (actingInstance !== instance) {
      const results = await actingMasto.v2.search.list({
        q: url || uri,
        type: 'statuses',
        limit: 1,
        resolve: true,
      });
      targetId = results?.statuses?.[0]?.id;
      if (!targetId) {
        throw new Error(t`post not found on that server`);
      }
    }
    return { actingMasto, actingInstance, targetId };
  };

  const boostStatusAs = async (account) => {
    const acctName = account.info.acct || account.info.username;
    try {
      const { actingMasto, targetId } = await resolveStatusAs(account);
      await actingMasto.v1.statuses.$select(targetId).reblog();
      showToast(t`Boosted as @${acctName}`);
      return true;
    } catch (e) {
      console.error(e);
      showToast(t`Unable to boost as @${acctName}: ${e?.message || e}`);
      return false;
    }
  };

  // "Quote without attribution": render the post as a redacted PNG card and
  // open the composer with it attached. Nothing that identifies the original
  // (URL, ID, handle, name, avatar, time) reaches the new post.
  const quoteWithoutAttribution = async () => {
    if (renderingCard) return;
    setRenderingCard(true);
    try {
      const [{ renderCardBlob }, { blobToAttachment }] = await Promise.all([
        import('../utils/post-card-render'),
        import('../utils/post-card-attachment'),
      ]);
      const { blob, altText, truncated } = await renderCardBlob(status);
      const attachment = await blobToAttachment(blob, altText);
      showCompose({
        draftStatus: {
          status: '',
          mediaAttachments: [attachment],
        },
        _quoteContext: composeStatus(),
      });
      if (truncated) {
        showToast(t`This post is long, so the card shows only its beginning.`);
      }
    } catch (e) {
      console.error(e);
      showToast(t`Could not render the post`);
    } finally {
      setRenderingCard(false);
    }
  };

  // Check if media has no descriptions
  const mediaNoDesc = useMemo(() => {
    return mediaAttachments.some(
      (attachment) => !attachment.description?.trim?.(),
    );
  }, [mediaAttachments]);

  const statusMonthsAgo = useMemo(() => {
    return Math.floor(
      (new Date() - new Date(createdAt)) / (1000 * 60 * 60 * 24 * 30),
    );
  }, [createdAt]);

  const menuFooter =
    mediaNoDesc && !reblogged ? (
      <div class="footer">
        <Icon icon="alert" />
        <Trans>Some media have no descriptions.</Trans>
      </div>
    ) : (
      statusMonthsAgo >= 3 && (
        <div class="footer">
          <Icon icon="info" />
          <span>
            <Trans>
              Old post (<strong>{rtf.format(-statusMonthsAgo, 'month')}</strong>
              )
            </Trans>
          </span>
        </div>
      )
    );

  if (!status) {
    return null;
  }

  return (
    <MenuConfirm
      subMenu={subMenu}
      disabled={!canBoost}
      className={
        subMenu ? `menu-reblog ${reblogged ? 'checked' : ''}` : undefined
      }
      confirmLabel={
        <>
          <Icon icon="rocket" />
          <span class="menu-grow">{reblogged ? t`Unboost` : t`Boost`}</span>
          {reblogsCount > 0 && (
            <small class="more-insignificant">
              {shortenNumber(reblogsCount)}
            </small>
          )}
        </>
      }
      menuExtras={
        <>
          {supportsNativeQuote(instance) && (
            <MenuItem
              disabled={quoteDisabled}
              onClick={() => {
                showCompose({
                  quoteStatus: composeStatus(),
                  _quoteContext: composeStatus(),
                });
              }}
            >
              <Icon icon="quote" />
              {quoteMetaText ? (
                <small>
                  {quoteText}
                  <br />
                  {quoteMetaText}
                </small>
              ) : (
                <span class={subMenu ? undefined : 'menu-grow'}>
                  {quoteText}
                </span>
              )}
              {!subMenu && quotesCount > 0 && (
                <small class="more-insignificant">
                  {shortenNumber(quotesCount)}
                </small>
              )}
            </MenuItem>
          )}
          {(DEV || !supportsNativeQuote(instance)) && (
            <MenuItem
              onClick={() => {
                showCompose({
                  draftStatus: {
                    status: `\n${url}`,
                  },
                  _quoteContext: composeStatus(),
                });
              }}
            >
              <Icon icon="quote" />
              <span>
                <Trans>Quote with link</Trans>
              </span>
              {supportsNativeQuote(instance) && DEV && (
                <small class="tag collapsed">DEV</small>
              )}
            </MenuItem>
          )}
          <MenuItem disabled={renderingCard} onClick={quoteWithoutAttribution}>
            <Icon icon="quote" />
            <span>
              <Trans>Quote without attribution</Trans>
            </span>
          </MenuItem>
          {showBoostAs &&
            boostAsAccounts.map((account) => {
              const acctName = account.info.acct || account.info.username;
              return (
                <MenuItem
                  key={account.info.id}
                  onClick={async () => {
                    haptics.trigger('light');
                    await boostStatusAs(account);
                  }}
                >
                  <Icon icon="rocket" />
                  <span>{t`Boost as @${acctName}`}</span>
                </MenuItem>
              );
            })}
        </>
      }
      menuFooter={menuFooter}
      onClick={async () => {
        haptics.trigger('light');
        try {
          const done = await confirmBoostStatus();
          if (done) {
            showToast(
              reblogged
                ? t`Unboosted @${username || acct}'s post`
                : t`Boosted @${username || acct}'s post`,
            );
          }
        } catch (e) {}
      }}
    >
      {children}
    </MenuConfirm>
  );
}

export default BoostQuoteMenu;
