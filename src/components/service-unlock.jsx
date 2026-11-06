import { Trans, useLingui } from '@lingui/react/macro';
import { useEffect, useState } from 'preact/hooks';
import { useSnapshot } from 'valtio';

import { servicePairing, syncAccounts } from '../utils/account-sync';
import {
  addPasskey,
  pairDevice,
  pairOptions,
  serviceSession,
  ServiceUnpairedError,
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
// form takes the one-time setup code from the service's log. Once the device
// has its cookie, it reads the accounts from the service, reloads if that
// gave it its first usable account, and otherwise runs `onUnlocked`.
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
      servicePairing.unpaired = null;
      const synced = await syncAccounts();
      if (synced?.gained) {
        window.location.reload();
        return;
      }
      onUnlocked?.();
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
            Fleeting keeps your accounts and For You state on deepthought, for
            every device. Enter the setup code from the Fleeting service's log,
            then create a passkey. Other devices unlock with that passkey.
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
          Fleeting keeps your accounts and For You state on deepthought. Unlock
          this device once with your passkey.
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

// The unlock control, shown only while this device has no cookie for the
// Fleeting service. It asks the service once on mount, and also shows when
// an account sync finds the device unpaired.
export function ServiceGate({ onUnlocked }) {
  const { unpaired } = useSnapshot(servicePairing);
  useEffect(() => {
    serviceSession().catch((e) => {
      if (e instanceof ServiceUnpairedError) servicePairing.unpaired = e;
    });
  }, []);
  if (!unpaired) return null;
  return (
    <ServiceUnlock unpaired={servicePairing.unpaired} onUnlocked={onUnlocked} />
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
