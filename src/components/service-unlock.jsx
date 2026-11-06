import { Trans, useLingui } from '@lingui/react/macro';
import { useEffect, useState } from 'preact/hooks';

import {
  addPasskey,
  pairDevice,
  pairOptions,
  serviceSession,
  setupDevice,
} from '../utils/fleeting-service';
import showToast from '../utils/show-toast';

import Loader from './loader';

function errorMessage(e, t) {
  // The user closed the passkey prompt, or it timed out
  if (e?.name === 'NotAllowedError') return t`The passkey prompt was closed.`;
  return e?.message || String(e);
}

// Shown when this device has no cookie for the Fleeting service. `unpaired`
// is the ServiceUnpairedError: with `setup` set, no passkey exists yet and the
// form takes the one-time setup code from the service's log. `onUnlocked`
// runs once the device has its cookie.
function ServiceUnlock({ unpaired, onUnlocked }) {
  const { t } = useLingui();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [options, setOptions] = useState(null);

  // Fetch the login options before the tap, so the passkey prompt opens
  // straight from it
  useEffect(() => {
    if (unpaired.setup || !unpaired.hasPasskey || options) return;
    let cancelled = false;
    pairOptions().then(
      (o) => !cancelled && setOptions(o),
      () => {},
    );
    return () => {
      cancelled = true;
    };
  }, [unpaired, options]);

  async function run(fn) {
    setBusy(true);
    setError(null);
    try {
      await fn();
      onUnlocked();
    } catch (e) {
      console.error(e);
      setError(errorMessage(e, t));
      setOptions(null);
      setBusy(false);
    }
  }

  if (!unpaired.setup && !unpaired.hasPasskey) {
    return (
      <div class="ui-state service-unlock">
        <p>
          <Trans>
            Fleeting has no passkey yet, and the setup code has expired. Restart
            the Fleeting service for a new setup code.
          </Trans>
        </p>
      </div>
    );
  }

  if (unpaired.setup) {
    return (
      <form
        class="ui-state service-unlock"
        onSubmit={(e) => {
          e.preventDefault();
          const code = e.target.elements.setupCode.value.trim();
          if (code) run(() => setupDevice(code));
        }}
      >
        <h2>
          <Trans>Set up Fleeting</Trans>
        </h2>
        <p>
          <Trans>
            Fleeting keeps this page's state on deepthought, for every device.
            Enter the setup code from the Fleeting service's log, then create a
            passkey. Other devices unlock with that passkey.
          </Trans>
        </p>
        <input
          name="setupCode"
          class="large"
          placeholder={t`Setup code`}
          autocomplete="off"
          autocapitalize="characters"
          spellCheck={false}
          required
          disabled={busy}
        />
        <p>
          <button type="submit" disabled={busy}>
            <Trans>Create passkey</Trans>
          </button>
        </p>
        {busy && <Loader />}
        {error && <p class="service-unlock-error">{error}</p>}
      </form>
    );
  }

  return (
    <div class="ui-state service-unlock">
      <p>
        <Trans>
          Fleeting keeps this page's state on deepthought. Unlock this device
          once with your passkey.
        </Trans>
      </p>
      <p>
        <button
          type="button"
          disabled={busy}
          onClick={() => run(() => pairDevice(options))}
        >
          <Trans>Unlock Fleeting</Trans>
        </button>
      </p>
      {busy && <Loader />}
      {error && <p class="service-unlock-error">{error}</p>}
    </div>
  );
}

// Registers one more passkey for the Fleeting service, for example in a
// second passkey manager. Shown only on a device that is unlocked.
export function AddPasskeyButton() {
  const { t } = useLingui();
  const [paired, setPaired] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    serviceSession().then(
      () => !cancelled && setPaired(true),
      () => {},
    );
    return () => {
      cancelled = true;
    };
  }, []);

  if (!paired) return null;
  return (
    <button
      type="button"
      class="light"
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        try {
          await addPasskey();
          showToast(t`Passkey added`);
        } catch (e) {
          console.error(e);
          showToast(errorMessage(e, t));
        }
        setBusy(false);
      }}
    >
      <Trans>Add a passkey for Fleeting</Trans>
    </button>
  );
}

export default ServiceUnlock;
