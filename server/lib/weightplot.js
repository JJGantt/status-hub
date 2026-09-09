'use strict';
// Weekly weigh-in average — one number per week, laid out on the SAME week columns as the two heat
// maps so a point sits over the week it belongs to. That alignment is the whole chart: the Sunday
// anchor and the column count here must stay identical to buildWorkoutHeatmap / buildNutritionLog,
// or the plot says one week and points at another.
//
// WHY THE PLAIN MEAN. Day-to-day weight is water, glycogen and gut content around a slow trend, and
// that noise is roughly symmetric — so the mean of a week's readings is the efficient estimator of
// where the week sat, and it is unbiased however many times the scale was stepped on. The
// alternatives all fail on one of those two counts: min/max/first/last of the week are biased by
// the COUNT (six weigh-ins find a lower low than three at the same true weight), a median of four
// or five readings throws away most of them and moves in steps of observations rather than smoothly,
// and a trailing average or a fitted trend is a value AT an instant, not a value OF a bucket —
// putting one over a week column would mean the point above the column is partly the week before it.
// The cost of the mean is that a one-weigh-in week is drawn as loudly as a six-weigh-in week; `n`
// rides along on each point so a surface can say so if it ever wants to.
//
// A week with NO weigh-in is interpolated between the nearest week either side — for a single gap
// that is the midpoint, for a longer one it is the straight line across it. The anchors may sit
// outside the window: weigh-ins from before the first column still anchor a gap at the start. What
// is NOT filled is a gap with no week after it — the current week before the first weigh-in of it —
// because that is extrapolation, and inventing this week's weight is a different claim from
// bridging between two weeks that were both measured.

// x/y are FRACTIONS the card turns into percentages of the plot box: x 0 at the first column's
// centre and 1 at the last's, y 0 on the top line and 1 on the bottom.
function buildWeightPlot(weights, weeks, today) {
  const anchor = new Date(today + 'T12:00:00Z');
  const dow = anchor.getUTCDay(); // 0=Sun .. 6=Sat — week columns start Sunday, as the heat maps do
  const startMs = anchor.getTime() - dow * 86400000 - (weeks - 1) * 7 * 86400000;
  const day = (n) => new Date(startMs + n * 86400000).toISOString().slice(0, 10);

  // Every weigh-in ever, bucketed by week INDEX against this window — negative for anything older
  // than the first column, which is what lets a gap at the left edge be interpolated rather than
  // dropped. Only the 0..weeks-1 slice is drawn.
  const bucket = new Map();
  for (const p of weights || []) {
    if (!p || !isFinite(p.weight)) continue;
    const i = Math.floor((Date.parse(p.date + 'T12:00:00Z') - startMs) / (7 * 86400000));
    const b = bucket.get(i) || (bucket.set(i, []), bucket.get(i));
    b.push(p.weight);
  }
  if (!bucket.size) return null;
  const mean = new Map();
  for (const [i, v] of bucket) mean.set(i, v.reduce((a, b) => a + b, 0) / v.length);
  const known = [...mean.keys()].sort((a, b) => a - b);

  const cols = [];
  for (let i = 0; i < weeks; i++) {
    if (mean.has(i)) { cols.push({ week: day(i * 7), n: bucket.get(i).length, avg: round1(mean.get(i)), imputed: false }); continue; }
    let lo = null, hi = null;
    for (const k of known) { if (k < i) lo = k; else if (hi === null) hi = k; }
    const v = (lo !== null && hi !== null)
      ? mean.get(lo) + (mean.get(hi) - mean.get(lo)) * ((i - lo) / (hi - lo))
      : null;
    cols.push({ week: day(i * 7), n: 0, avg: v === null ? null : round1(v), imputed: v !== null });
  }

  const drawn = cols.filter((c) => c.avg != null).map((c) => c.avg);
  if (!drawn.length) return null;
  const min = Math.min(...drawn), max = Math.max(...drawn);
  // The band is whole pounds, because the three labels are the only numbers on the plot and a
  // decimal there is a precision the eye cannot use from a couch. Smallest integer band that holds
  // the data, then grown a pound at a time on whichever side is tighter until it is at least two
  // wide and an EVEN number of pounds — otherwise the middle line has no integer to be labelled.
  let lo = Math.floor(min), hi = Math.ceil(max);
  while (hi - lo < 2 || (hi - lo) % 2) { if (hi - max <= min - lo) hi += 1; else lo -= 1; }
  const r5 = (v) => Math.round(v * 100000) / 100000;   // the column pitch is ~24px; 3 places drifts a fifth of one
  return {
    points: cols.map((c, i) => ({
      week: c.week, n: c.n, avg: c.avg, imputed: c.imputed,
      x: weeks > 1 ? r5(i / (weeks - 1)) : 0.5,
      y: c.avg == null ? null : r5((hi - c.avg) / (hi - lo)),
    })),
    axis: [{ v: String(hi), y: 0 }, { v: String((lo + hi) / 2), y: 0.5 }, { v: String(lo), y: 1 }],
  };
}

const round1 = (v) => Math.round(v * 10) / 10;

module.exports = { buildWeightPlot };
