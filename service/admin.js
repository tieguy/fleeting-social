// Lists and revokes paired devices. Run it in the service container:
//
//   podman exec fleeting-service node admin.js devices
//   podman exec fleeting-service node admin.js revoke <device id>
//   podman exec fleeting-service node admin.js revoke-all
//   podman exec fleeting-service node admin.js passkeys
//
// A revoked device must use a passkey again. The service reads the devices
// file on every request, so a revocation takes effect at once.

import { DEVICES, emptyDevices } from './auth.js';
import { createStore } from './store.js';

const store = await createStore(process.env.FLEETING_SERVICE_DATA || './data');
const [command, arg] = process.argv.slice(2);
const date = (t) => new Date(t).toISOString();

switch (command) {
  case 'devices': {
    const { devices } = await store.read(DEVICES, emptyDevices());
    for (const d of devices) {
      console.log(
        `${d.id}  paired ${date(d.createdAt)}  last used ${date(d.lastUsed)}  ${d.userAgent}`,
      );
    }
    if (!devices.length) console.log('no devices');
    break;
  }
  case 'passkeys': {
    const { passkeys } = await store.read(DEVICES, emptyDevices());
    for (const p of passkeys) {
      console.log(`${p.id}  registered ${date(p.createdAt)}`);
    }
    if (!passkeys.length) console.log('no passkeys');
    break;
  }
  case 'revoke': {
    if (!arg) {
      console.error('usage: node admin.js revoke <device id>');
      process.exit(2);
    }
    let found = false;
    await store.update(DEVICES, emptyDevices(), (doc) => {
      found = doc.devices.some((d) => d.id === arg);
      return { ...doc, devices: doc.devices.filter((d) => d.id !== arg) };
    });
    console.log(found ? `revoked ${arg}` : `no device ${arg}`);
    process.exit(found ? 0 : 1);
    break;
  }
  case 'revoke-all': {
    await store.update(DEVICES, emptyDevices(), (doc) => ({
      ...doc,
      devices: [],
    }));
    console.log('revoked every device');
    break;
  }
  default:
    console.error(
      'usage: node admin.js devices|passkeys|revoke <id>|revoke-all',
    );
    process.exit(2);
}
