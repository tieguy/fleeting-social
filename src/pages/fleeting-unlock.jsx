import './foryou.css';

import { Trans, useLingui } from '@lingui/react/macro';
import { useEffect, useState } from 'preact/hooks';

import Loader from '../components/loader';
import ServiceUnlock, { AddPasskeyButton } from '../components/service-unlock';
import {
  ServiceUnpairedError,
  serviceSession,
} from '../utils/fleeting-service';
import useTitle from '../utils/useTitle';

// Sets up or unlocks this device for the Fleeting service, reached only by
// typing its URL. Unlike For You, it is open in conversation mode, so a
// device can be set up at any time. It has no links, so it adds no path out
// of conversation mode.
function FleetingUnlock() {
  const { t } = useLingui();
  useTitle(t`Unlock Fleeting`, '/_fleeting-unlock');
  const [state, setState] = useState({ loading: true });

  function check() {
    setState({ loading: true });
    serviceSession().then(
      () => setState({ unlocked: true }),
      (e) =>
        setState(
          e instanceof ServiceUnpairedError
            ? { unpaired: e }
            : { error: e?.message || String(e) },
        ),
    );
  }
  useEffect(check, []);

  return (
    <div id="fleeting-unlock-page" class="deck-container" tabIndex="-1">
      <div class="timeline-deck deck">
        <header>
          <div class="header-grid">
            <div class="header-side" />
            <h1>
              <Trans>Fleeting service</Trans>
            </h1>
            <div class="header-side" />
          </div>
        </header>
        <main>
          {state.loading ? (
            <div class="ui-state">
              <Loader />
            </div>
          ) : state.unpaired ? (
            <ServiceUnlock unpaired={state.unpaired} onUnlocked={check} />
          ) : state.error ? (
            <div class="ui-state">
              <p>
                <Trans>Failed to load: {state.error}</Trans>
              </p>
              <button type="button" onClick={check}>
                <Trans>Try again</Trans>
              </button>
            </div>
          ) : (
            <div class="ui-state">
              <p>
                <Trans>This device is unlocked for the Fleeting service.</Trans>
              </p>
              <p>
                <AddPasskeyButton />
              </p>
            </div>
          )}
        </main>
      </div>
    </div>
  );
}

export default FleetingUnlock;
