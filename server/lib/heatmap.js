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
  // self-scaling intensity: your busiest day = brightest, the rest scale relative to it
  let maxCount = 0; for (const k in counts) if (k <= today && counts[k] > maxCount) maxCount = counts[k];
  const level = (c) => (c <= 0 ? 0 : Math.min(4, Math.max(1, Math.ceil((4 * c) / (maxCount || 1)))));
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
  return { weeks: cols, months, maxCount };
}

module.exports = { buildWorkoutHeatmap };
