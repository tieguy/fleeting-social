import './fixed-accounts-banner.css';

import { Trans, useLingui } from '@lingui/react/macro';
import { useEffect, useReducer, useState } from 'preact/hooks';
import { useLocation } from 'react-router-dom';

import {
  fixedAccountStates,
  parseFixedAccounts,
} from '../utils/fixed-accounts';
import { startMastodonLogin } from '../utils/mastodon-login';
import { getAccounts } from '../utils/store-utils';

import BlueskyLoginForm from './bluesky-login-form';
import Icon from './icon';
import { ServiceGate } from './service-unlock';

const fixedAccounts = parseFixedAccounts(import.meta.env.FLEETING_ACCOUNTS);

// Lists the build's fixed accounts (FLEETING_ACCOUNTS) that this device is
// not logged in to, or whose session the Fleeting service found dead, with a
// log-in control for each: Mastodon OAuth returns to the current page, and
// the Bluesky app-password form logs in in place. A device that has no
// cookie for the service gets the unlock control first, since unlocking
// brings every account the service holds. Renders nothing when every fixed
// account is logged in and the device is unlocked, or when the build names
// no account. `noServiceUnlock` is for a page that shows its own unlock
// control.
function FixedAccountsBanner({ noServiceUnlock }) {
  const { t } = useLingui();
  const location = useLocation();
  // Re-read the accounts store when another tab changes it, when the page
  // comes back into view, and once a minute, since a Bluesky session can
  // die in this tab without an event
  const [, recheck] = useReducer((c) => c + 1, 0);
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === 'visible') recheck();
    };
    window.addEventListener('storage', recheck);
    document.addEventListener('visibilitychange', onVisible);
    const timer = setInterval(recheck, 60 * 1000);
    return () => {
      window.removeEventListener('storage', recheck);
      document.removeEventListener('visibilitychange', onVisible);
      clearInterval(timer);
    };
  }, []);
  const [openForm, setOpenForm] = useState(null);
  const [mastodonState, setMastodonState] = useState('default');

  const needed = fixedAccountStates(fixedAccounts, getAccounts()).filter(
    (a) => a.state !== 'ok',
  );
  if (!fixedAccounts.length) return null;
  if (!needed.length) {
    return noServiceUnlock ? null : <ServiceGate onUnlocked={recheck} />;
  }

  const logInMastodon = (instance) => {
    setMastodonState('loading');
    startMastodonLogin(instance, {
      redirectPath: location.pathname + location.search,
      onError: () => setMastodonState('error'),
    })
      .then(() => setMastodonState('default'))
      .catch((e) => {
        console.error(e);
        setMastodonState('error');
      });
  };

  return (
    <section class="fixed-accounts-banner">
      {!noServiceUnlock && <ServiceGate onUnlocked={recheck} />}
      <p>
        <Trans>Not logged in on this device:</Trans>
      </p>
      <ul>
        {needed.map((account) => (
          <li key={account.label}>
            <span>
              <Icon icon={account.network} alt="" /> {account.label}
              {account.state === 'expired' && (
                <span class="insignificant">
                  {' '}
                  <Trans>(session expired)</Trans>
                </span>
              )}
            </span>
            {account.network === 'mastodon' ? (
              <button
                type="button"
                disabled={mastodonState === 'loading'}
                onClick={() => logInMastodon(account.instance)}
              >
                <Trans>Log in</Trans>
              </button>
            ) : (
              openForm !== account.label && (
                <button
                  type="button"
                  onClick={() => setOpenForm(account.label)}
                >
                  <Trans>Log in</Trans>
                </button>
              )
            )}
            {account.network === 'mastodon' && mastodonState === 'error' && (
              <p class="error">{t`Failed to log in. Please try again.`}</p>
            )}
            {openForm === account.label && (
              <BlueskyLoginForm
                fixedHandle={account.handle}
                onLoggedIn={() => window.location.reload()}
              />
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

export default FixedAccountsBanner;
