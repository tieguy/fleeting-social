import { describe, expect, it } from 'vitest';

import {
  dayRelation,
  isFullAppOpen,
  nextChange,
  nextOpening,
} from './conversation-schedule';

// Local-time dates. 2026-10-23 is a Friday, 2026-10-24 a Saturday.
const fri = (hour, minute = 0) => new Date(2026, 9, 23, hour, minute);
const sat = (hour, minute = 0) => new Date(2026, 9, 24, hour, minute);
const sun = (hour, minute = 0) => new Date(2026, 9, 25, hour, minute);
const mon = (hour, minute = 0) => new Date(2026, 9, 26, hour, minute);

describe('isFullAppOpen', () => {
  it('is open inside each weekday window', () => {
    expect(fri(8).getDay()).toBe(5);
    expect(isFullAppOpen(fri(8))).toBe(true);
    expect(isFullAppOpen(fri(12, 30))).toBe(true);
    expect(isFullAppOpen(fri(21, 29))).toBe(true);
  });

  it('treats the end minute as closed', () => {
    expect(isFullAppOpen(fri(9))).toBe(false);
    expect(isFullAppOpen(fri(21, 30))).toBe(false);
  });

  it('is closed between windows', () => {
    expect(isFullAppOpen(fri(7, 59))).toBe(false);
    expect(isFullAppOpen(fri(15))).toBe(false);
    expect(isFullAppOpen(fri(23))).toBe(false);
  });

  it('has no midday window at the weekend', () => {
    expect(sat(8).getDay()).toBe(6);
    expect(isFullAppOpen(sat(8, 30))).toBe(true);
    expect(isFullAppOpen(sat(12, 30))).toBe(false);
    expect(isFullAppOpen(sun(12, 30))).toBe(false);
    expect(isFullAppOpen(sun(21, 15))).toBe(true);
  });

  it('uses the windows it is given', () => {
    const windows = { weekday: [[0, 24 * 60]], weekend: [] };
    expect(isFullAppOpen(fri(3), windows)).toBe(true);
    expect(isFullAppOpen(sat(3), windows)).toBe(false);
  });
});

describe('nextChange', () => {
  it('returns the end of the current window', () => {
    expect(nextChange(fri(8, 15))).toEqual(fri(9));
  });

  it('returns the start of the next window', () => {
    expect(nextChange(fri(9))).toEqual(fri(12));
    expect(nextChange(fri(13, 5))).toEqual(fri(21));
  });

  it('skips the weekday midday window at the weekend', () => {
    expect(nextChange(sat(9))).toEqual(sat(21));
  });

  it('crosses midnight into the next day', () => {
    expect(nextChange(fri(22))).toEqual(sat(8));
    expect(nextChange(sun(22))).toEqual(mon(8));
  });

  it('skips an edge where two windows touch', () => {
    const windows = {
      weekday: [
        [60, 120],
        [120, 180],
      ],
      weekend: [
        [60, 120],
        [120, 180],
      ],
    };
    expect(nextChange(fri(1, 30), windows)).toEqual(fri(3));
  });

  it('returns null when there are no windows', () => {
    expect(nextChange(fri(10), { weekday: [], weekend: [] })).toBe(null);
  });
});

describe('nextOpening', () => {
  it('finds the next window start from conversation mode', () => {
    // Thursday 2026-11-05 21:45 → Friday 08:00
    const next = nextOpening(new Date(2026, 10, 5, 21, 45));
    expect(next).toEqual(new Date(2026, 10, 6, 8, 0));
  });

  it('skips the end of the window that is open now', () => {
    // Thursday 12:30, inside the noon window → 21:00 the same day
    const next = nextOpening(new Date(2026, 10, 5, 12, 30));
    expect(next).toEqual(new Date(2026, 10, 5, 21, 0));
  });

  it('has no noon window on a weekend', () => {
    // Saturday 2026-11-07 10:00 → 21:00
    const next = nextOpening(new Date(2026, 10, 7, 10, 0));
    expect(next).toEqual(new Date(2026, 10, 7, 21, 0));
  });
});

describe('dayRelation', () => {
  const now = new Date(2026, 10, 5, 22, 0);
  it('names today, tomorrow and later', () => {
    expect(dayRelation(now, new Date(2026, 10, 5, 23, 0))).toBe('today');
    expect(dayRelation(now, new Date(2026, 10, 6, 8, 0))).toBe('tomorrow');
    expect(dayRelation(now, new Date(2026, 10, 8, 8, 0))).toBe('later');
  });
});
