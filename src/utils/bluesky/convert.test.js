import { describe, expect, it } from 'vitest';

import { mutedWordText, postToStatus } from './convert';

// Build a minimal Bluesky post view whose record text @-mentions someone.
// Byte offsets index into the UTF-8 encoding of `text`.
function mentionPost({ text, handle, did }) {
  const byteStart = new TextEncoder().encode(
    text.slice(0, text.indexOf(`@${handle}`)),
  ).length;
  const byteEnd = byteStart + new TextEncoder().encode(`@${handle}`).length;
  return {
    uri: 'at://did:plc:author/app.bsky.feed.post/abc',
    cid: 'cid1',
    author: {
      did: 'did:plc:author',
      handle: 'author.bsky.social',
      displayName: 'Author',
    },
    record: {
      text,
      createdAt: '2024-01-01T00:00:00.000Z',
      facets: [
        {
          index: { byteStart, byteEnd },
          features: [{ $type: 'app.bsky.richtext.facet#mention', did }],
        },
      ],
    },
    indexedAt: '2024-01-01T00:00:00.000Z',
  };
}

describe('postToStatus mentions', () => {
  it('uses the handle (not the DID) for a mention acct', () => {
    const status = postToStatus(
      mentionPost({
        text: '@adonovan.bsky.social the problem is solvable',
        handle: 'adonovan.bsky.social',
        did: 'did:plc:bjwzrz7adhzwn7bdtvplo4in',
      }),
      'bsky.social',
    );
    expect(status.mentions).toHaveLength(1);
    const [m] = status.mentions;
    // id stays the DID (mention-click matching relies on it)
    expect(m.id).toBe('did:plc:bjwzrz7adhzwn7bdtvplo4in');
    // acct/username should be the human handle
    expect(m.acct).toBe('adonovan.bsky.social');
    expect(m.username).toBe('adonovan.bsky.social');
  });

  it('handles a mention that is not at the start of the text', () => {
    const status = postToStatus(
      mentionPost({
        text: 'hey @bob.bsky.social look',
        handle: 'bob.bsky.social',
        did: 'did:plc:bob',
      }),
      'bsky.social',
    );
    expect(status.mentions[0].acct).toBe('bob.bsky.social');
  });

  it('falls back to the DID when no record text is available', () => {
    const status = postToStatus(
      {
        uri: 'at://did:plc:author/app.bsky.feed.post/abc',
        cid: 'cid1',
        author: { did: 'did:plc:author', handle: 'author.bsky.social' },
        record: {
          // no text, but a mention facet exists
          facets: [
            {
              index: { byteStart: 0, byteEnd: 5 },
              features: [
                { $type: 'app.bsky.richtext.facet#mention', did: 'did:plc:x' },
              ],
            },
          ],
        },
        indexedAt: '2024-01-01T00:00:00.000Z',
      },
      'bsky.social',
    );
    expect(status.mentions[0].acct).toBe('did:plc:x');
  });
});

describe('mutedWordText', () => {
  it('covers text, tags, card, alt text and the quoted post', () => {
    const text = mutedWordText({
      text: 'post body',
      tags: [{ name: 'tagword' }],
      card: { title: 'card title', description: 'card desc' },
      mediaAttachments: [{ description: 'alt words' }],
      quote: {
        quotedStatus: {
          text: 'quoted body',
          card: { title: 'quoted card' },
          mediaAttachments: [{ description: 'quoted alt' }],
        },
      },
    });
    for (const part of [
      'post body',
      'tagword',
      'card title',
      'card desc',
      'alt words',
      'quoted body',
      'quoted card',
      'quoted alt',
    ]) {
      expect(text).toContain(part);
    }
  });

  it('stops at one level of quoting', () => {
    const text = mutedWordText({
      text: 'a',
      quote: {
        quotedStatus: { text: 'b', quote: { quotedStatus: { text: 'c' } } },
      },
    });
    expect(text).toBe('a\nb');
  });
});
