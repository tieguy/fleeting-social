// The session manager inside the real @atproto/api Agent: every call the
// facade makes, including uploads and the chat proxy, goes through it
import { Agent } from '@atproto/api';
import { describe, expect, it, vi } from 'vitest';

import { createServiceSessionManager } from './service-session';

function reply(status, body = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function setup() {
  let session = {
    did: 'did:plc:alice',
    handle: 'alice.test',
    accessJwt: 'access-1',
    pdsUrl: 'https://pds.example',
  };
  const seen = [];
  const fetch = vi.fn(async (req) => {
    const url = new URL(req.url);
    seen.push({
      path: url.pathname,
      token: req.headers.get('authorization'),
      proxy: req.headers.get('atproto-proxy'),
    });
    if (req.headers.get('authorization') !== 'Bearer access-2') {
      return reply(400, { error: 'ExpiredToken', message: 'expired' });
    }
    if (url.pathname.endsWith('getProfile')) {
      return reply(200, { did: 'did:plc:alice', handle: 'alice.test' });
    }
    if (url.pathname.endsWith('uploadBlob')) {
      return reply(200, {
        blob: {
          $type: 'blob',
          ref: {
            $link:
              'bafkreie5737gdxlw5i64vzichcalba3z2v5n6icifvx5xytvske7mr3hpm',
          },
          mimeType: 'image/png',
          size: 3,
        },
      });
    }
    if (url.pathname.endsWith('listConvos')) return reply(200, { convos: [] });
    return reply(404, { error: 'NotFound' });
  });
  const requestAccess = vi.fn(async () => {
    session = { ...session, accessJwt: 'access-2' };
    return session;
  });
  const agent = new Agent(
    createServiceSessionManager({
      did: 'did:plc:alice',
      getSession: () => session,
      requestAccess,
      fetch,
    }),
  );
  return { agent, seen, requestAccess };
}

describe('Agent with the service session manager', () => {
  it('knows the DID and renews an expired token for a read', async () => {
    const { agent, seen, requestAccess } = setup();
    expect(agent.did).toBe('did:plc:alice');
    const res = await agent.getProfile({ actor: 'did:plc:alice' });
    expect(res.data.handle).toBe('alice.test');
    expect(requestAccess).toHaveBeenCalledTimes(1);
    expect(seen.map((s) => s.token)).toEqual([
      'Bearer access-1',
      'Bearer access-2',
    ]);
  });

  it('sends an upload again after renewing', async () => {
    const { agent, seen } = setup();
    const res = await agent.uploadBlob(new Uint8Array([1, 2, 3]), {
      encoding: 'image/png',
    });
    expect(res.data.blob).toBeTruthy();
    expect(seen).toHaveLength(2);
  });

  it('keeps the chat proxy header on a proxied clone', async () => {
    const { agent, seen } = setup();
    const chat = agent.withProxy('bsky_chat', 'did:web:api.bsky.chat');
    await chat.chat.bsky.convo.listConvos();
    expect(seen.at(-1)).toMatchObject({
      path: '/xrpc/chat.bsky.convo.listConvos',
      token: 'Bearer access-2',
      proxy: 'did:web:api.bsky.chat#bsky_chat',
    });
  });
});
