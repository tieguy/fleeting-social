import { describe, expect, it, vi } from 'vitest';

import { createServiceSessionManager } from './service-session';

function reply(status, body = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

// A PDS that accepts only `valid` as the access token
function setup({ valid = 'access-2', answer } = {}) {
  let session = {
    did: 'did:plc:alice',
    accessJwt: 'access-1',
    pdsUrl: 'https://pds.example',
  };
  const seen = [];
  const fetch = vi.fn(async (req) => {
    const token = req.headers.get('authorization')?.replace('Bearer ', '');
    seen.push({ url: req.url, token });
    if (token === valid) return reply(200, { ok: true });
    return reply(400, { error: 'ExpiredToken', message: 'Token has expired' });
  });
  const requestAccess = vi.fn(async (failed) => {
    if (answer) return answer(failed);
    session = { ...session, accessJwt: 'access-2' };
    return session;
  });
  const manager = createServiceSessionManager({
    did: 'did:plc:alice',
    getSession: () => session,
    requestAccess,
    fetch,
  });
  return {
    manager,
    fetch,
    requestAccess,
    seen,
    setSession: (s) => (session = s),
  };
}

describe('createServiceSessionManager', () => {
  it('sends the stored access token to the PDS', async () => {
    const t = setup({ valid: 'access-1' });
    const res = await t.manager.fetchHandler(
      '/xrpc/app.bsky.actor.getProfile?actor=x',
      { method: 'GET' },
    );
    expect(res.status).toBe(200);
    expect(t.seen).toEqual([
      {
        url: 'https://pds.example/xrpc/app.bsky.actor.getProfile?actor=x',
        token: 'access-1',
      },
    ]);
    expect(t.requestAccess).not.toHaveBeenCalled();
    expect(t.manager.did).toBe('did:plc:alice');
  });

  it('reports the refused token to the service and retries once', async () => {
    const t = setup();
    const res = await t.manager.fetchHandler('/xrpc/x', { method: 'GET' });
    expect(res.status).toBe(200);
    expect(t.requestAccess).toHaveBeenCalledWith('access-1');
    expect(t.seen.map((s) => s.token)).toEqual(['access-1', 'access-2']);
  });

  it('treats a 401 as a refused token too', async () => {
    const t = setup();
    t.fetch.mockImplementationOnce(async () => reply(401, {}));
    const res = await t.manager.fetchHandler('/xrpc/x', { method: 'GET' });
    expect(res.status).toBe(200);
    expect(t.requestAccess).toHaveBeenCalledTimes(1);
  });

  it('does not ask the service about other errors', async () => {
    const t = setup();
    t.fetch.mockImplementationOnce(async () =>
      reply(400, { error: 'InvalidRequest' }),
    );
    const res = await t.manager.fetchHandler('/xrpc/x', { method: 'GET' });
    expect(res.status).toBe(400);
    expect(t.requestAccess).not.toHaveBeenCalled();
  });

  it('requests that fail together share one call to the service', async () => {
    const t = setup();
    const results = await Promise.all(
      [1, 2, 3].map(() => t.manager.fetchHandler('/xrpc/x', { method: 'GET' })),
    );
    expect(results.map((r) => r.status)).toEqual([200, 200, 200]);
    expect(t.requestAccess).toHaveBeenCalledTimes(1);
  });

  it('returns the refusal when the session is dead', async () => {
    const t = setup({ answer: () => null });
    const res = await t.manager.fetchHandler('/xrpc/x', { method: 'GET' });
    expect(res.status).toBe(400);
    expect(t.seen).toHaveLength(1);
  });

  it('returns the refusal when the service has nothing newer', async () => {
    const t = setup({
      answer: () => ({ accessJwt: 'access-1', pdsUrl: 'https://pds.example' }),
    });
    const res = await t.manager.fetchHandler('/xrpc/x', { method: 'GET' });
    expect(res.status).toBe(400);
    expect(t.seen).toHaveLength(1);
  });

  it('returns the refusal when the service cannot be reached', async () => {
    const t = setup({
      answer: () => {
        throw new Error('down');
      },
    });
    const res = await t.manager.fetchHandler('/xrpc/x', { method: 'GET' });
    expect(res.status).toBe(400);
  });

  it('sends an upload body again on the retry', async () => {
    const t = setup();
    const body = new Uint8Array([1, 2, 3]);
    const bodies = [];
    t.fetch.mockImplementation(async (req) => {
      bodies.push(new Uint8Array(await req.arrayBuffer()));
      const token = req.headers.get('authorization');
      return token === 'Bearer access-2'
        ? reply(200, {})
        : reply(400, { error: 'ExpiredToken' });
    });
    const res = await t.manager.fetchHandler(
      '/xrpc/com.atproto.repo.uploadBlob',
      {
        method: 'POST',
        body,
        headers: { 'Content-Type': 'image/png' },
      },
    );
    expect(res.status).toBe(200);
    expect(bodies).toEqual([body, body]);
  });

  it('refuses to send without a stored session', async () => {
    const t = setup();
    t.setSession(null);
    await expect(
      t.manager.fetchHandler('/xrpc/x', { method: 'GET' }),
    ).rejects.toThrow(/No Bluesky session/);
  });
});
