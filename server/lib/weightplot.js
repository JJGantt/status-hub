'use strict';
// Weekly weigh-in average — one number per week, laid out on the SAME week columns as the two heat
// maps so a point sits over the week it belongs to. That alignment is the whole chart: the Sunday
// anchor and the column count here must stay identical to buildWorkoutHeatmap / buildNutritionLog,
// or the plot says one week and points at another.
//
// The average is a plain mean of the weigh-ins dated inside the week. Days are not weighted and a
// missing day is not filled: a week with two readings is the mean of those two, and a week with none
// is a hole the line breaks across rather than a value invented to keep it continuous.

// x/y are FRACTIONS the card turns into percentages of the plot box: x 0 at the first column's
// centre and 1 at the last's, y 0 on the top line and 1 on the bottom. The three axis rows are the
// only labels, so they carry their own y and are what `lo`/`hi` are drawn as.
function buildWeightPlot(weights, weeks, today) {
  const anchor = new Date(today + 'T12:00:00Z');
  const dow = anchor.getUTCDay(); // 0=Sun .. 6=Sat — week columns start Sunday, as the heat maps do
  const startMs = anchor.getTime() - dow * 86400000 - (weeks - 1) * 7 * 86400000;
  const day = (n) => new Date(startMs + n * 86400000).toISOString().slice(0, 10);
  const cols = [];
  for (let w = 0; w < weeks; w++) {
    const from = day(w * 7), to = day(w * 7 + 6);
    const vals = (weights || [])
      .filter((p) => p.date >= from && p.date <= to && isFinite(p.weight))
      .map((p) => p.weight);
    cols.push({ week: from, n: vals.length,
                avg: vals.length ? Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * 10) / 10 : null });
  }
  const vals = cols.filter((c) => c.avg != null).map((c) => c.avg);
  if (!vals.length) return null;
  let lo = Math.min(...vals), hi = Math.max(...vals);
  // One weigh-in, or a window that never moved, has no range to divide by — and three labels reading
  // the same number say nothing. Half a pound either side puts that value on the middle line.
  if (hi - lo < 0.2) { lo = Math.round((lo - 0.5) * 10) / 10; hi = Math.round((hi + 0.5) * 10) / 10; }
  const r3 = (v) => Math.round(v * 1000) / 1000;
  const mid = (lo + hi) / 2;
  return {
    points: cols.map((c, i) => ({
      week: c.week, n: c.n, avg: c.avg,
      x: weeks > 1 ? r3(i / (weeks - 1)) : 0.5,
      y: c.avg == null ? null : r3((hi - c.avg) / (hi - lo)),
    })),
    axis: [{ v: hi.toFixed(1), y: 0 }, { v: mid.toFixed(1), y: 0.5 }, { v: lo.toFixed(1), y: 1 }],
  };
}

module.exports = { buildWeightPlot };
