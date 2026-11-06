// Conversation mode: outside these windows the app shows only conversations.
// The schedule is a constant, not a setting, so that it cannot be switched off
// from inside the app. Changing it takes a deploy.
//
// Each window is [startMinute, endMinute) in the device's local time, measured
// from midnight. No window crosses midnight, so a check reads one day only.

const at = (hour, minute = 0) => hour * 60 + minute;

export const FULL_APP_WINDOWS = {
  weekday: [
    [at(8), at(9)],
    [at(12), at(13)],
    [at(21), at(21, 30)],
  ],
  weekend: [
    [at(8), at(9)],
    [at(21), at(21, 30)],
  ],
};

function windowsFor(date, windows) {
  const day = date.getDay();
  return day === 0 || day === 6 ? windows.weekend : windows.weekday;
}

function minuteOfDay(date) {
  return date.getHours() * 60 + date.getMinutes();
}

export function isFullAppOpen(date, windows = FULL_APP_WINDOWS) {
  const minute = minuteOfDay(date);
  return windowsFor(date, windows).some(
    ([start, end]) => minute >= start && minute < end,
  );
}

// The first moment after `date` at which isFullAppOpen gives a different
// answer. The search walks window edges day by day, so a weekday/weekend
// boundary with no edge on it does not count as a change. Returns null when
// the answer never changes (no windows at all).
export function nextChange(date, windows = FULL_APP_WINDOWS) {
  const current = isFullAppOpen(date, windows);
  for (let offset = 0; offset < 8; offset++) {
    const day = new Date(date);
    day.setDate(day.getDate() + offset);
    day.setHours(0, 0, 0, 0);
    const edges = windowsFor(day, windows)
      .flat()
      .sort((a, b) => a - b);
    for (const edge of edges) {
      const candidate = new Date(day);
      candidate.setHours(0, edge, 0, 0);
      if (candidate <= date) continue;
      if (isFullAppOpen(candidate, windows) !== current) return candidate;
    }
  }
  return null;
}

// The start of the next full-app window after `date`, or null when there is
// none. The conversation page shows it.
export function nextOpening(date, windows = FULL_APP_WINDOWS) {
  let t = date;
  for (let i = 0; i < 2; i++) {
    t = nextChange(t, windows);
    if (!t) return null;
    if (isFullAppOpen(t, windows)) return t;
  }
  return null;
}

// Whether `target` falls on the same calendar day as `now` ('today'), the
// next one ('tomorrow'), or later ('later'), in device local time
export function dayRelation(now, target) {
  const day = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const days = Math.round((day(target) - day(now)) / (24 * 60 * 60 * 1000));
  return days <= 0 ? 'today' : days === 1 ? 'tomorrow' : 'later';
}
