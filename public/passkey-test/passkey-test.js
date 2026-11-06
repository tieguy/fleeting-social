// WebAuthn check for the Fleeting service. See index.html.
//
// Safari requires each WebAuthn call to start in the tap handler itself, so
// the handlers call navigator.credentials before any `await`.

const logEl = document.getElementById("log");
const STORE_KEY = "passkeyTestCredentialId";

function log(line) {
  logEl.textContent += line + "\n";
}

function b64url(buffer) {
  const bytes = new Uint8Array(buffer);
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromB64url(s) {
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

function random(n) {
  return crypto.getRandomValues(new Uint8Array(n));
}

// Flags byte of authenticator data (WebAuthn §6.1): byte 32
function flags(authData) {
  if (!authData) return "no authenticator data";
  const f = new Uint8Array(authData)[32];
  return [
    `UP=${!!(f & 0x01)}`,
    `UV=${!!(f & 0x04)}`,
    `BE=${!!(f & 0x08)}`,
    `BS=${!!(f & 0x10)}`,
  ].join(" ");
}

function errorText(e) {
  return `${e?.name || "Error"}: ${e?.message || e}`;
}

function getStored() {
  try {
    return localStorage.getItem(STORE_KEY);
  } catch (e) {
    return null;
  }
}

async function environment() {
  log(`time: ${new Date().toISOString()}`);
  log(`url: ${location.href}`);
  log(`userAgent: ${navigator.userAgent}`);
  log(
    `standalone: display-mode=${matchMedia("(display-mode: standalone)").matches} navigator.standalone=${navigator.standalone}`,
  );
  log(`secure context: ${window.isSecureContext}`);
  log(`PublicKeyCredential: ${typeof window.PublicKeyCredential}`);
  if (!window.PublicKeyCredential) return;
  try {
    log(
      `platform authenticator: ${await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable()}`,
    );
  } catch (e) {
    log(`platform authenticator: ${errorText(e)}`);
  }
  try {
    if (PublicKeyCredential.isConditionalMediationAvailable) {
      log(
        `conditional mediation: ${await PublicKeyCredential.isConditionalMediationAvailable()}`,
      );
    }
  } catch (e) {
    log(`conditional mediation: ${errorText(e)}`);
  }
  log(`stored test credential: ${getStored() || "none"}`);
  log("");
}

function register() {
  log("--- create ---");
  // The options the service will use: user verification required, a
  // discoverable credential preferred, no attestation.
  const promise = navigator.credentials.create({
    publicKey: {
      rp: { id: location.hostname, name: "Fleeting passkey test" },
      user: {
        id: random(16),
        name: "fleeting-passkey-test",
        displayName: "Fleeting passkey test",
      },
      challenge: random(32),
      pubKeyCredParams: [
        { type: "public-key", alg: -7 },
        { type: "public-key", alg: -257 },
      ],
      authenticatorSelection: {
        residentKey: "preferred",
        userVerification: "required",
      },
      attestation: "none",
      timeout: 120000,
    },
  });
  promise.then(
    (cred) => {
      try {
        localStorage.setItem(STORE_KEY, cred.id);
      } catch (e) {
        log(`localStorage write failed: ${errorText(e)}`);
      }
      const r = cred.response;
      log(`OK id=${cred.id}`);
      log(`authenticatorAttachment: ${cred.authenticatorAttachment}`);
      log(
        `transports: ${r.getTransports ? JSON.stringify(r.getTransports()) : "n/a"}`,
      );
      log(
        `algorithm: ${r.getPublicKeyAlgorithm ? r.getPublicKeyAlgorithm() : "n/a"}`,
      );
      log(
        `flags: ${flags(r.getAuthenticatorData ? r.getAuthenticatorData() : null)}`,
      );
      log("");
    },
    (e) => {
      log(`FAILED ${errorText(e)}`);
      log("");
    },
  );
}

function login(useStored) {
  const stored = useStored ? getStored() : null;
  log(`--- get (${stored ? "stored credential" : "any passkey"}) ---`);
  if (useStored && !stored) {
    log("no stored credential: run step 1 first");
    log("");
    return;
  }
  const promise = navigator.credentials.get({
    publicKey: {
      rpId: location.hostname,
      challenge: random(32),
      userVerification: "required",
      allowCredentials: stored
        ? [{ type: "public-key", id: fromB64url(stored) }]
        : [],
      timeout: 120000,
    },
  });
  promise.then(
    (cred) => {
      log(`OK id=${cred.id}`);
      log(`matches stored: ${cred.id === getStored()}`);
      log(`authenticatorAttachment: ${cred.authenticatorAttachment}`);
      log(`flags: ${flags(cred.response.authenticatorData)}`);
      log(
        `userHandle: ${cred.response.userHandle ? b64url(cred.response.userHandle) : "none"}`,
      );
      log("");
    },
    (e) => {
      log(`FAILED ${errorText(e)}`);
      log("");
    },
  );
}

document.getElementById("register").addEventListener("click", register);
document.getElementById("login").addEventListener("click", () => login(true));
document
  .getElementById("login-any")
  .addEventListener("click", () => login(false));
document.getElementById("copy").addEventListener("click", () => {
  navigator.clipboard.writeText(logEl.textContent).then(
    () => log("(copied)"),
    (e) => log(`copy failed: ${errorText(e)}`),
  );
});

environment();
