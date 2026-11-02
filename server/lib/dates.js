'use strict';
// Date helpers in the display timezone, shared by server.js and the builder modules.
//
// The zone is MUTABLE and follows the user, because "4pm" means 4pm wherever the user actually is — a
// reminder set for 4pm should not fire at 1pm after a flight west. The phone reports its IANA zone
// when it registers for push; the hub persists it in app_settings.display_tz and calls setTZ().
// Everything time-shaped reads through here, so one value moves reminder firing, the overdue badge,
// the weight-reminder time and the 4am day boundary together.
//
// Note this deliberately does NOT re-interpret stored timestamps. occurred_at values are naive local
// wall-clock strings written by whichever device did the logging (data-layer's now()), so a meal
// logged at 8pm in California is stored "20:00" and reads back as 8pm. Moving the zone changes which
// day boundary those strings are compared against — which is the point — not what they mean.
let TZ = process.env.TZ_DISPLAY || 'America/New_York';
const getTZ = () => TZ;
function setTZ(name) {
  const tz = String(name || '').trim();
  if (!tz || tz === TZ) return false;
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); } catch (_) { return false; }  // reject junk
  TZ = tz;
  return true;
}

// A nutrition "day" runs DAY_START_HOUR→DAY_START_HOUR local time, so a late-night
// snack (before 4am) counts toward the day that just ended. This is a display-only
// window over the real occurred_at timestamps — storage is never touched, so changing
// this one number instantly re-groups all history with no migration.
const DAY_START_HOUR = 4;
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function localDate(d = new Date()) {
  return d.toLocaleDateString('en-CA', { timeZone: TZ }); // YYYY-MM-DD (TZ is read live, not captured)
}
// [start, end) occurred_at bounds for the nutrition day currently in progress.
function nutritionWindow() {
  const hh = String(DAY_START_HOUR).padStart(2, '0');
  const dayStart = localDate(new Date(Date.now() - DAY_START_HOUR * 3600000)); // pre-4am → prior day
  const dayEnd = localDate(new Date(Date.parse(dayStart + 'T12:00:00Z') + 86400000));
  return { day: dayStart, start: `${dayStart}T${hh}:00:00`, end: `${dayEnd}T${hh}:00:00` };
}
// The trailing n "training days", anchored on the DAY_START_HOUR boundary (NOT calendar midnight)
// so the workout day rolls over at the same 4am line as the nutrition day. A late set (e.g. 1am)
// still counts toward the day that just ended, and "today"/"tomorrow" stay intuitive after midnight
// (the day after a 1am moment is still "today", not "tomorrow"). YYYY-MM-DD, oldest first.
function lastNTrainingDays(n) {
  const today = localDate(new Date(Date.now() - DAY_START_HOUR * 3600000)); // 4am-day (pre-4am → prior day)
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

// "now" as a naive-local wall-clock timestamp in the display TZ → "YYYY-MM-DDTHH:MM:SS"
// (the format nutrition_entries.occurred_at and sets.occurred_at are stored in).
function nowNaiveLocal() {
  const f = new Intl.DateTimeFormat('en-CA', {
    timeZone: getTZ(), hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const p = {}; for (const part of f.formatToParts(new Date())) p[part.type] = part.value;
  const hh = p.hour === '24' ? '00' : p.hour; // Intl can emit 24 for midnight
  return `${p.year}-${p.month}-${p.day}T${hh}:${p.minute}:${p.second}`;
}

module.exports = { getTZ, setTZ, DAY_START_HOUR, MON, localDate, nutritionWindow, lastNTrainingDays, dayBucketOf, nowNaiveLocal };
