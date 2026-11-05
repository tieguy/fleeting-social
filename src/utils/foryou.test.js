import { describe, expect, it } from 'vitest';

import {
  blendDigest,
  digestCutoff,
  MAX_WINDOW_MS,
  mulberry32,
  OVERLAP_MS,
  reasonFor,
  tallyRules,
} from './foryou';

const HOUR = 60 * 60 * 1000;
const NOW = Date.parse('2026-11-05T21:00:00Z');

describe('digestCutoff', () => {
  it('goes back 24 hours with no last read', () => {
    expect(digestCutoff({ now: NOW, lastRead: null })).toBe(
      NOW - MAX_WINDOW_MS,
    );
  });

  it('starts 30 minutes before last read', () => {
    const lastRead = NOW - 9 * HOUR;
    expect(digestCutoff({ now: NOW, lastRead })).toBe(lastRead - OVERLAP_MS);
  });

  it('goes back at most 24 hours', () => {
    expect(digestCutoff({ now: NOW, lastRead: NOW - 72 * HOUR })).toBe(
      NOW - MAX_WINDOW_MS,
    );
  });

  it('never starts after now, even with a last read in the future', () => {
    expect(digestCutoff({ now: NOW, lastRead: NOW + 2 * HOUR })).toBe(NOW);
  });
});

// Keys are "author:n", so authorOf reads the author from the key
const authorOf = (key) => key.split(':')[0];
const keys = (author, n) =>
  Array.from({ length: n }, (_, i) => `${author}:${i}`);

describe('blendDigest', () => {
  it('puts every "Always show" post first, with no author cap', () => {
    const always = keys('paper', 5);
    const digest = blendDigest({
      alwaysKeys: always,
      rankings: [{ rule: 'raw', keys: ['a:0', 'b:0'] }],
      authorOf,
      random: mulberry32(1),
    });
    expect(digest.slice(0, 5)).toEqual(
      always.map((key) => ({ key, rule: 'always' })),
    );
    expect(digest.slice(5).map((p) => p.key)).toEqual(['a:0', 'b:0']);
  });

  it('records which rule took each post and skips posts already taken', () => {
    const digest = blendDigest({
      rankings: [
        { rule: 'raw', keys: ['a:0', 'b:0', 'c:0'] },
        { rule: 'shared', keys: ['a:0', 'd:0', 'e:0'] },
      ],
      authorOf,
      randomCount: 0,
      random: mulberry32(7),
    });
    const taken = digest.map((p) => p.key);
    expect(new Set(taken).size).toBe(taken.length);
    expect(taken.sort()).toEqual(['a:0', 'b:0', 'c:0', 'd:0', 'e:0']);
    const byKey = Object.fromEntries(digest.map((p) => [p.key, p.rule]));
    expect(byKey['d:0']).toBe('shared');
    expect(byKey['b:0']).toBe('raw');
  });

  it('gives each rule one pick per round', () => {
    const digest = blendDigest({
      rankings: [
        { rule: 'raw', keys: ['a:0', 'b:0', 'c:0'] },
        { rule: 'quiet', keys: ['x:0', 'y:0', 'z:0'] },
      ],
      authorOf,
      size: 4,
      randomCount: 0,
      random: mulberry32(3),
    });
    const rules = digest.map((p) => p.rule);
    expect(rules.filter((r) => r === 'raw')).toHaveLength(2);
    expect(rules.filter((r) => r === 'quiet')).toHaveLength(2);
    // Each rule takes its best posts, in order
    expect(digest.filter((p) => p.rule === 'raw').map((p) => p.key)).toEqual([
      'a:0',
      'b:0',
    ]);
  });

  it('lets a rule with more posts fill in when the others run out', () => {
    const digest = blendDigest({
      rankings: [
        { rule: 'raw', keys: ['a:0'] },
        { rule: 'topics', keys: ['b:0', 'c:0', 'd:0', 'e:0'] },
      ],
      authorOf,
      randomCount: 0,
      random: mulberry32(5),
    });
    expect(digest).toHaveLength(5);
  });

  it('allows at most 2 posts per author', () => {
    const digest = blendDigest({
      rankings: [
        { rule: 'raw', keys: keys('a', 5) },
        { rule: 'shared', keys: [...keys('a', 5), 'b:0'] },
      ],
      authorOf,
      randomCount: 0,
      random: mulberry32(9),
    });
    expect(digest.filter((p) => authorOf(p.key) === 'a')).toHaveLength(2);
    expect(digest.map((p) => p.key)).toContain('b:0');
  });

  it('stops at the digest size, random posts included', () => {
    const rankings = ['raw', 'shared', 'quiet'].map((rule) => ({
      rule,
      keys: Array.from({ length: 40 }, (_, i) => `${rule}${i}:0`),
    }));
    const digest = blendDigest({
      rankings,
      randomKeys: Array.from({ length: 40 }, (_, i) => `r${i}:0`),
      authorOf,
      random: mulberry32(11),
    });
    expect(digest).toHaveLength(25);
    expect(digest.filter((p) => p.rule === 'random')).toHaveLength(2);
  });

  it('places random posts among the rule picks, never before "Always show"', () => {
    for (let seed = 0; seed < 20; seed++) {
      const digest = blendDigest({
        alwaysKeys: ['paper:0'],
        rankings: [{ rule: 'raw', keys: keys('a', 1).concat(keys('b', 1)) }],
        randomKeys: ['r:0', 's:0'],
        authorOf,
        random: mulberry32(seed),
      });
      expect(digest[0]).toEqual({ key: 'paper:0', rule: 'always' });
      expect(digest.filter((p) => p.rule === 'random')).toHaveLength(2);
    }
  });

  it('does not repeat a post as a random pick', () => {
    const digest = blendDigest({
      rankings: [{ rule: 'raw', keys: ['a:0', 'b:0'] }],
      randomKeys: ['a:0', 'b:0'],
      authorOf,
      random: mulberry32(2),
    });
    expect(digest.map((p) => p.key)).toEqual(['a:0', 'b:0']);
  });

  it('is repeatable for a seed', () => {
    const input = () => ({
      rankings: [
        { rule: 'raw', keys: keys('a', 2).concat(keys('b', 2)) },
        { rule: 'shared', keys: keys('c', 2).concat(keys('d', 2)) },
      ],
      randomKeys: keys('e', 2),
      authorOf,
      random: mulberry32(42),
    });
    expect(blendDigest(input())).toEqual(blendDigest(input()));
  });
});

describe('reasonFor', () => {
  const candidate = (status, origins = []) => ({
    status,
    origins: new Set(origins),
  });

  it('counts the follows who shared the post', () => {
    expect(reasonFor('shared', { sharedBy: 4 }, candidate({}))).toEqual({
      type: 'shared',
      count: 4,
    });
  });

  it('names the topic feed and its likes', () => {
    expect(
      reasonFor(
        'feeds',
        {},
        candidate({ favouritesCount: 395 }, [
          'feed: Housing Abundance (quoted)',
          'feed: AI/ML Feed: Blend',
        ]),
      ),
    ).toEqual({ type: 'feed', feed: 'AI/ML Feed: Blend', likes: 395 });
  });

  it('gives likes and followers for relative engagement', () => {
    expect(
      reasonFor(
        'relative',
        { followers: 1200 },
        candidate({ favouritesCount: 30 }),
      ),
    ).toEqual({ type: 'relative', likes: 30, followers: 1200 });
  });

  it('falls back to likes when the follower count is unknown', () => {
    expect(
      reasonFor(
        'relative',
        { followers: null },
        candidate({ favouritesCount: 30, reblogsCount: 2 }),
      ),
    ).toEqual({ type: 'raw', likes: 30, boosts: 2 });
  });

  it('lists matched topics, posts today, and the fixed reasons', () => {
    expect(reasonFor('topics', { topics: ['housing', 'ai'] })).toEqual({
      type: 'topics',
      topics: ['housing', 'ai'],
    });
    expect(reasonFor('quiet', { authorPostsToday: 1 })).toEqual({
      type: 'quiet',
      posts: 1,
    });
    expect(reasonFor('always').type).toBe('always');
    expect(reasonFor('affinity').type).toBe('affinity');
    expect(reasonFor('random').type).toBe('random');
  });
});

describe('tallyRules', () => {
  it('counts shown posts once and verdicts by rule', () => {
    const digests = [
      {
        at: 1,
        picks: [
          { key: 'k1', rule: 'raw' },
          { key: 'k2', rule: 'shared' },
        ],
      },
      { at: 2, picks: [{ key: 'k1', rule: 'raw' }] },
    ];
    const verdicts = {
      k1: { rule: 'raw', verdict: 'interesting' },
      k2: { rule: 'shared', verdict: 'not-for-me' },
    };
    expect(tallyRules(digests, verdicts)).toEqual([
      { rule: 'raw', shown: 1, interesting: 1, notForMe: 0 },
      { rule: 'shared', shown: 1, interesting: 0, notForMe: 1 },
    ]);
  });
});
