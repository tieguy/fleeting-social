import { describe, expect, it } from 'vitest';

import {
  buildPool,
  isAlwaysList,
  isReadable,
  pickForRule,
  RULES,
} from './foryou-lab';

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

describe('feeds and the "Always show" list', () => {
  const now = Date.parse('2026-11-05T12:00:00Z');
  const opts = { cutoff: now - 24 * 36e5 };
  const status = (id, author, extra = {}) => ({
    id,
    content: '<p>Some English text</p>',
    language: 'en',
    account: { id: author, acct: author },
    createdAt: new Date(now - 36e5).toISOString(),
    favouritesCount: 50,
    ...extra,
  });
  const rule = (id) => RULES.find((r) => r.id === id);
  const scoredOf = (pool, followed = false) =>
    pool.map((candidate) => ({
      candidate,
      features: { followed, relative: 1 },
    }));

  it('matches the list title without regard to case or spaces', () => {
    expect(isAlwaysList({ title: ' always SHOW ' })).toBe(true);
    expect(isAlwaysList({ title: 'Always show', _feed: true })).toBe(false);
    expect(isAlwaysList({ title: 'Always' })).toBe(false);
  });

  it('lets the feeds rule pick strangers only from open feeds', () => {
    const pool = buildPool(
      [
        {
          item: status('a', 'x'),
          origin: 'feed: Housing',
          instance: 'i',
          strangers: true,
        },
        {
          item: status('b', 'y'),
          origin: 'feed: San Francisco',
          instance: 'i',
          strangers: false,
        },
      ],
      opts,
    );
    const { picks } = pickForRule(rule('feeds'), scoredOf(pool), { seed: 1 });
    expect(picks).toEqual(['i/a']);
  });

  it('shows every list post, past the per-author cap', () => {
    const pool = buildPool(
      ['1', '2', '3', '4'].map((id) => ({
        item: status(id, 'pdr'),
        origin: 'always',
        instance: 'i',
      })),
      opts,
    );
    const { picks } = pickForRule(rule('always'), scoredOf(pool, true), {
      seed: 1,
    });
    expect(picks).toHaveLength(4);
  });
});

describe('buildPool filter counts', () => {
  const now = Date.parse('2026-11-05T12:00:00Z');
  const status = (id, extra = {}) => ({
    id,
    content: '<p>Some English text</p>',
    language: 'en',
    account: { id: 'a', acct: 'a' },
    createdAt: new Date(now - 36e5).toISOString(),
    ...extra,
  });
  const entry = (item) => ({ item, origin: 'home', instance: 'i' });

  it('counts each removed post once, by filter', () => {
    const removed = {};
    buildPool(
      [
        entry(status('r1', { inReplyToId: 'x' })),
        entry(status('r1', { inReplyToId: 'x' })),
        entry(status('de', { language: 'de' })),
        entry(status('w', { content: '<p>crypto news</p>' })),
        entry(status('ok')),
      ],
      {
        cutoff: now - 24 * 36e5,
        mutedWords: [{ value: 'crypto' }],
        removed,
      },
    );
    expect(
      Object.fromEntries(Object.entries(removed).map(([k, v]) => [k, [...v]])),
    ).toEqual({
      reply: ['i/r1'],
      language: ['i/de'],
      mutedWord: ['i/w'],
    });
  });

  it('does not count a post that another item brought in', () => {
    const removed = {};
    const post = status('p');
    const pool = buildPool(
      [
        // A boost by a muted account, then the post itself
        entry({
          id: 'boost',
          account: { id: 'm', acct: 'm', _viewer: { muted: true } },
          reblog: post,
        }),
        entry(post),
      ],
      { cutoff: now - 24 * 36e5, removed },
    );
    expect(pool.map((c) => c.key)).toEqual(['i/p']);
    expect([...(removed.muted || [])]).toEqual([]);
  });
});
