// @ts-check
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, test } from '@playwright/test';

import { seed, stubMastodon } from './foryou-fixtures.js';

// The Fleeting service (service/) for real, with Chromium's virtual
// authenticator: the first device registers a passkey with the setup code
// from the service's log, a second browser context unlocks with the same
// passkey, and the two see the same For You state. The dev server proxies
// /fleeting-api to the service on port 8787 (vite.config.js).
//
// Runs only in the Chromium project: the virtual authenticator is a Chrome
// DevTools Protocol feature.

test.describe.configure({ mode: 'serial' });
test.use({ serviceWorkers: 'block' });

const ORIGIN = 'http://localhost:5173';
let service;
let dataDir;
let setupCode;

test.beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'fleeting-service-spec-'));
  service = spawn('node', ['server.js'], {
    cwd: new URL('../service/', import.meta.url).pathname,
    env: {
      ...process.env,
      FLEETING_SERVICE_RP_ID: 'localhost',
      FLEETING_SERVICE_ORIGIN: ORIGIN,
      FLEETING_SERVICE_DATA: dataDir,
      FLEETING_SERVICE_PORT: '8787',
    },
  });
  setupCode = await new Promise((resolve, reject) => {
    let out = '';
    service.stdout.on('data', (chunk) => {
      out += chunk;
      const m = out.match(/setup code[^:]*: (\S+)/);
      if (m) resolve(m[1]);
    });
    service.stderr.on('data', (chunk) => (out += chunk));
    service.on('exit', (code) =>
      reject(new Error(`service exited ${code}: ${out}`)),
    );
    setTimeout(() => reject(new Error(`no setup code: ${out}`)), 10_000);
  });
});

test.afterAll(() => {
  service?.kill();
  rmSync(dataDir, { recursive: true, force: true });
});

async function authenticator(page) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  const { authenticatorId } = await cdp.send(
    'WebAuthn.addVirtualAuthenticator',
    {
      options: {
        protocol: 'ctap2',
        transport: 'internal',
        hasResidentKey: true,
        hasUserVerification: true,
        isUserVerified: true,
        automaticPresenceSimulation: true,
      },
    },
  );
  return { cdp, authenticatorId };
}

async function openForYou(browser) {
  const context = await browser.newContext();
  const page = await context.newPage();
  await stubMastodon(page);
  await seed(page);
  return { context, page };
}

const forYouState = (page) =>
  page.evaluate(() => fetch('/fleeting-api/foryou').then((r) => r.json()));

test('two devices share one state through one passkey', async ({ browser }) => {
  // First device: setup code, then a new passkey
  const a = await openForYou(browser);
  const authA = await authenticator(a.page);
  await a.page.goto('/#/foryou');
  await a.page.getByPlaceholder('Setup code').fill(setupCode);
  await a.page.getByRole('button', { name: 'Create passkey' }).click();
  const postsA = a.page.locator('.foryou-posts > li');
  await expect(postsA).toHaveCount(3);
  await postsA.first().locator('.foryou-like').click();
  await expect
    .poll(async () => Object.keys((await forYouState(a.page)).verdicts))
    .toHaveLength(1);

  // Second device: the same passkey, as if synced, and no setup code
  const b = await openForYou(browser);
  const authB = await authenticator(b.page);
  const { credentials } = await authA.cdp.send('WebAuthn.getCredentials', {
    authenticatorId: authA.authenticatorId,
  });
  expect(credentials).toHaveLength(1);
  await authB.cdp.send('WebAuthn.addCredential', {
    authenticatorId: authB.authenticatorId,
    credential: credentials[0],
  });
  await b.page.goto('/#/foryou');
  await b.page.getByRole('button', { name: 'Unlock Fleeting' }).click();
  // Device A read this digest to its end, so B has nothing new: the last
  // read and the shown posts are shared
  await expect(
    b.page.getByText('Nothing new since your last digest.'),
  ).toBeVisible();
  const stateB = await forYouState(b.page);
  expect(stateB.lastRead).toBeTruthy();
  expect(Object.values(stateB.verdicts)[0]).toMatchObject({
    verdict: 'interesting',
    actions: ['like'],
  });

  await a.context.close();
  await b.context.close();
});

test('a request with no cookie gets 401, a cross-site one 403', async ({
  request,
}) => {
  const none = await request.get(`${ORIGIN}/fleeting-api/foryou`);
  expect(none.status()).toBe(401);
  expect(await none.json()).toMatchObject({ paired: false, setup: false });
  const cross = await request.post(`${ORIGIN}/fleeting-api/pair/options`, {
    headers: { 'Sec-Fetch-Site': 'cross-site' },
  });
  expect(cross.status()).toBe(403);
});
