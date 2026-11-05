import { describe, expect, it } from 'vitest';

import { buildPool, isReadable } from './foryou-lab';

const post = (content, language = null) => ({ content, language });

describe('isReadable', () => {
  it('keeps English and Spanish by declared language', () => {
    expect(isReadable(post('<p>Hello</p>', 'en'))).toBe(true);
    expect(isReadable(post('<p>Hola</p>', 'es'))).toBe(true);
    expect(isReadable(post('<p>Hello</p>', 'en-US'))).toBe(true);
  });

  it('drops other declared languages', () => {
    expect(isReadable(post('<p>Vereiste Felder</p>', 'de'))).toBe(false);
    expect(isReadable(post('<p>Y a un vrai sujet</p>', 'fr'))).toBe(false);
  });

  it('keeps Latin text with no declared language', () => {
    expect(isReadable(post('<p>Hello there</p>'))).toBe(true);
  });

  it('drops non-Latin text even when declared English', () => {
    expect(
      isReadable(
        post('<p>笑いで溢れる日々<br>#tokyocameraclub #mastodon</p>', 'en'),
      ),
    ).toBe(false);
    expect(isReadable(post('<p>Привет всем, как дела</p>'))).toBe(false);
  });

  it('ignores hashtags, mentions and links when judging script', () => {
    expect(
      isReadable(
        post(
          '<p>空に落ちる https://example.com/abcdefghijk #tokyocameraclub</p>',
        ),
      ),
    ).toBe(false);
    expect(isReadable(post('<p>Nice one @日本語 #東京カメラ部</p>'))).toBe(
      true,
    );
  });

  it('keeps a post with no letters', () => {
    expect(isReadable(post('<p>🎉</p>'))).toBe(true);
  });
});

describe('isReadable exemptions', () => {
  it('keeps posts from exempt photo servers', () => {
    expect(
      isReadable({
        content: '<p>空に落ちる</p>',
        language: 'ja',
        account: { acct: 'Negi@mstdn.tokyocameraclub.com' },
      }),
    ).toBe(true);
  });
});

describe('buildPool language fallback', () => {
  const now = Date.parse('2026-11-05T12:00:00Z');
  const at = (h) => new Date(now - h * 36e5).toISOString();
  const account = (id) => ({ id, acct: id });
  const english = {
    id: 'q1',
    content: '<p>An interesting English post</p>',
    language: 'en',
    account: account('b'),
    createdAt: at(48),
  };
  const german = {
    id: 'p1',
    content: '<p>Jemand hat diese Website gemacht</p>',
    language: 'de',
    account: account('a'),
    createdAt: at(1),
    quote: { quotedStatus: english },
  };
  const opts = { cutoff: now - 24 * 36e5 };

  it('replaces a foreign post with its readable quoted post', () => {
    const pool = buildPool(
      [{ item: german, origin: 'home', instance: 'x' }],
      opts,
    );
    expect(pool.map((c) => c.key)).toEqual(['x/q1']);
    expect([...pool[0].origins]).toEqual(['home (quoted)']);
    expect(pool[0].inHome).toBe(false);
  });

  it('drops a foreign post that quotes nothing readable', () => {
    const pool = buildPool(
      [
        {
          item: {
            ...german,
            quote: { quotedStatus: { ...english, language: 'fr' } },
          },
          origin: 'home',
          instance: 'x',
        },
      ],
      opts,
    );
    expect(pool).toEqual([]);
  });
});
