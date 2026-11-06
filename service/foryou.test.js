import { describe, expect, it } from 'vitest';

import {
  BadRequest,
  DIGEST_KEEP_COUNT,
  VERDICT_KEEP_COUNT,
  addDigest,
  addVerdict,
  emptyState,
  importState,
} from './foryou.js';

const pick = (key, rule = 'raw') => ({ key, rule });

describe('addDigest', () => {
  it('appends the digest and keeps only key and rule', () => {
    const s = addDigest(emptyState(), {
      at: 100,
      picks: [{ key: 'a/1', rule: 'raw', reason: { type: 'raw' } }],
    });
    expect(s.digests).toEqual([{ at: 100, picks: [pick('a/1')] }]);
    expect(s.lastRead).toBe(100);
  });

  it('never moves last read back', () => {
    let s = addDigest(emptyState(), { at: 200, picks: [] });
    s = addDigest(s, { at: 100, picks: [] });
    expect(s.lastRead).toBe(200);
    expect(s.digests.map((d) => d.at)).toEqual([100, 200]);
  });

  it('keeps the newest digests up to the cap', () => {
    let s = emptyState();
    for (let i = 1; i <= DIGEST_KEEP_COUNT + 5; i++) {
      s = addDigest(s, { at: i, picks: [] });
    }
    expect(s.digests).toHaveLength(DIGEST_KEEP_COUNT);
    expect(s.digests[0].at).toBe(6);
  });

  it('rejects a digest with no time or bad picks', () => {
    expect(() => addDigest(emptyState(), { picks: [] })).toThrow(BadRequest);
    expect(() =>
      addDigest(emptyState(), { at: 1, picks: [{ key: 'a/1' }] }),
    ).toThrow(BadRequest);
  });
});

describe('addVerdict', () => {
  it('appends each action and keeps the latest verdict', () => {
    let s = addVerdict(
      emptyState(),
      { key: 'a/1', rule: 'raw', verdict: 'interesting', action: 'like' },
      10,
    );
    s = addVerdict(
      s,
      {
        key: 'a/1',
        rule: 'raw',
        verdict: 'not-for-me',
        action: { type: 'topic', value: 'tea' },
      },
      20,
    );
    expect(s.verdicts['a/1']).toEqual({
      rule: 'raw',
      verdict: 'not-for-me',
      actions: ['like', { type: 'topic', value: 'tea' }],
      at: 20,
    });
  });

  it('records a verdict with no action', () => {
    const s = addVerdict(
      emptyState(),
      { key: 'a/1', rule: 'raw', verdict: 'not-for-me' },
      10,
    );
    expect(s.verdicts['a/1'].actions).toEqual([]);
  });

  it('drops the oldest verdicts over the cap', () => {
    let s = emptyState();
    for (let i = 0; i < VERDICT_KEEP_COUNT + 1; i++) {
      s = addVerdict(
        s,
        { key: `a/${i}`, rule: 'raw', verdict: 'interesting' },
        i + 1,
      );
    }
    expect(Object.keys(s.verdicts)).toHaveLength(VERDICT_KEEP_COUNT);
    expect(s.verdicts['a/0']).toBeUndefined();
  });

  it('rejects an unknown verdict', () => {
    expect(() =>
      addVerdict(emptyState(), { key: 'a/1', rule: 'raw', verdict: 'meh' }),
    ).toThrow(BadRequest);
  });
});

describe('importState', () => {
  it('merges digests, verdicts and last read from one device', () => {
    let stored = addDigest(emptyState(), { at: 100, picks: [pick('a/1')] });
    stored = addVerdict(
      stored,
      { key: 'a/1', rule: 'raw', verdict: 'interesting', action: 'like' },
      150,
    );
    const local = {
      lastRead: 300,
      digests: [
        { at: 100, picks: [pick('a/1')] },
        { at: 300, picks: [pick('b/2', 'quiet')] },
      ],
      verdicts: {
        'a/1': {
          rule: 'raw',
          verdict: 'not-for-me',
          actions: ['boost'],
          at: 400,
        },
        'b/2': { rule: 'quiet', verdict: 'interesting', actions: [], at: 310 },
      },
    };
    const merged = importState(stored, local);
    expect(merged.lastRead).toBe(300);
    expect(merged.digests.map((d) => d.at)).toEqual([100, 300]);
    expect(merged.verdicts['a/1']).toEqual({
      rule: 'raw',
      verdict: 'not-for-me',
      actions: ['like', 'boost'],
      at: 400,
    });
    expect(merged.verdicts['b/2'].verdict).toBe('interesting');
  });

  it('keeps the stored verdict when it is newer', () => {
    const stored = addVerdict(
      emptyState(),
      { key: 'a/1', rule: 'raw', verdict: 'interesting', action: 'like' },
      500,
    );
    const merged = importState(stored, {
      verdicts: {
        'a/1': { rule: 'raw', verdict: 'not-for-me', actions: ['x'], at: 400 },
      },
    });
    expect(merged.verdicts['a/1']).toMatchObject({
      verdict: 'interesting',
      actions: ['x', 'like'],
      at: 500,
    });
  });

  it('skips malformed entries instead of failing', () => {
    const merged = importState(emptyState(), {
      lastRead: 'yesterday',
      digests: [{ picks: [] }],
      verdicts: { 'a/1': { verdict: 'interesting' } },
    });
    expect(merged).toEqual(emptyState());
  });

  it('drops a digest with a bad pick and an action that is too long', () => {
    const merged = importState(emptyState(), {
      digests: [
        { at: 1, picks: [{ key: 'a/1' }] },
        { at: 2, picks: [pick('b/2')] },
      ],
      verdicts: {
        'b/2': {
          rule: 'raw',
          verdict: 'not-for-me',
          actions: ['like', { type: 'x', value: 'y'.repeat(2000) }],
          at: 5,
        },
      },
    });
    expect(merged.digests).toEqual([{ at: 2, picks: [pick('b/2')] }]);
    expect(merged.verdicts['b/2'].actions).toEqual(['like']);
  });
});
