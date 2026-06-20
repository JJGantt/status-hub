'use strict';
// Date helpers in the display timezone, shared by server.js and the builder modules.
const TZ = process.env.TZ_DISPLAY || 'America/New_York';

// A nutrition "day" runs DAY_START_HOUR→DAY_START_HOUR local time, so a late-night
// snack (before 4am) counts toward the day that just ended. This is a display-only
// window over the real occurred_at timestamps — storage is never touched, so changing
// this one number instantly re-groups all history with no migration.
const DAY_START_HOUR = 4;
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function localDate(d = new Date()) {
  return d.toLocaleDateString('en-CA', { timeZone: TZ }); // YYYY-MM-DD
}
// [start, end) occurred_at bounds for the nutrition day currently in progress.
function nutritionWindow() {
  const hh = String(DAY_START_HOUR).padStart(2, '0');
  const dayStart = localDate(new Date(Date.now() - DAY_START_HOUR * 3600000)); // pre-4am → prior day
  const dayEnd = localDate(new Date(Date.parse(dayStart + 'T12:00:00Z') + 86400000));
  return { day: dayStart, start: `${dayStart}T${hh}:00:00`, end: `${dayEnd}T${hh}:00:00` };
}
function lastNDates(n) {
  const today = localDate();
  const anchor = new Date(today + 'T12:00:00Z'); // noon-UTC anchor avoids day flips
  const out = [];
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(anchor.getTime() - i * 86400000);
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
}
// Which 4am-day a naive-local occurred_at timestamp belongs to (matches nutritionWindow()).
function dayBucketOf(ts) {
  const m = String(ts).match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?/);
  if (!m) return String(ts).slice(0, 10);
  const d = new Date(+m[1], +m[2] - 1, +m[3], +m[4] - DAY_START_HOUR, +m[5], +(m[6] || 0));
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

module.exports = { TZ, DAY_START_HOUR, MON, localDate, nutritionWindow, lastNDates, dayBucketOf };
