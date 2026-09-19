'use strict';
// Workout volume heatmap: per-day set counts laid out as week-columns (GitHub style).
// Days bucket on the DAY_START_HOUR 4am boundary (same convention as nutrition), so both the
// "today" cell and the counts roll over at 4am, not calendar midnight.
const { MON, localDate, dayBucketOf, DAY_START_HOUR } = require('./dates');

function buildWorkoutHeatmap(rows, weeks = 18, today = localDate(new Date(Date.now() - DAY_START_HOUR * 3600000))) {
  const counts = {};
  for (const r of rows || []) { const d = dayBucketOf(r.occurred_at); counts[d] = (counts[d] || 0) + 1; }
  const anchor = new Date(today + 'T12:00:00Z');
  const dow = anchor.getUTCDay(); // 0=Sun .. 6=Sat
  const startMs = anchor.getTime() - dow * 86400000 - (weeks - 1) * 7 * 86400000;
  // Absolute intensity: one shade per 6 sets, topping out at 37+. Fixed cutoffs, so a color means
  // the same set count in every window and on every surface. Scaling to the window's busiest day
  // instead let one outlier compress everything else — a 47-set day pushed 59% of days onto a
  // single shade and left the brightest green all but unreachable. The top must sit above the
  // ordinary big day: capped at 25+, a 38-set day was the same colour as a 25-set one.
  const level = (c) => (c <= 0 ? 0 : Math.min(7, Math.ceil(c / 6)));
  const cols = [], months = [];
  let prevMon = -1;
  for (let w = 0; w < weeks; w++) {
    const col = [];
    for (let d = 0; d < 7; d++) {
      const ds = new Date(startMs + (w * 7 + d) * 86400000).toISOString().slice(0, 10);
      const c = counts[ds] || 0;
      col.push({ date: ds, count: c, level: ds > today ? -1 : level(c), today: ds === today });
    }
    const m = Number(col[0].date.slice(5, 7)) - 1;       // month of this column's first day
    months.push(m !== prevMon ? MON[m] : '');            // label only when the month changes
    prevMon = m;
    cols.push(col);
  }
  return { weeks: cols, months };
}

module.exports = { buildWorkoutHeatmap };
