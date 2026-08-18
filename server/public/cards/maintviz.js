// Maintenance-window visualization — the phone wall's fourth swipe pane. Shows the data the adaptive
// calorie target is based on: weigh-ins with the recency-weighted trend, per-day intake bars, and the
// per-day HISTORICAL avg/maintenance/target curves (maintenance.viz.series — the estimator replayed
// as-of each day, so the curves step at weigh-ins and hold flat between them). Fixed 61-day viewport,
// ‹ › arrows page by month through all history. Renders straight from the estimator's own numbers.
// No-ops where #maintviz is absent (kiosk / desktop / mac hide the pane in CSS).
import { esc, state } from '../shared.js';

const DAY = 86400000;
const VIEW_DAYS = 61;   // clean two-month viewport
const dms = (d) => Date.parse(d + 'T12:00:00Z');
const idx = (d, ref) => Math.round((dms(d) - dms(ref)) / DAY);
const addDays = (d, n) => new Date(dms(d) + n * DAY).toISOString().slice(0, 10);
const fmt = (d) => { const t = new Date(dms(d)); return (t.getUTCMonth() + 1) + '/' + t.getUTCDate(); };

let viewEnd = null;   // viewport end date; null = follow today

export function render(s) {
  const el = document.getElementById('maintviz');
  if (!el) return;
  const m = s && s.maintenance;
  if (!m || !m.viz || !m.viz.weighins || !m.viz.weighins.length) {
    el.innerHTML = '<div class="mv-head"><div class="mv-title">Calorie target</div></div><div class="mv-note">Calibrating (' +
      (m && m.coverage ? esc(m.coverage.window_days + '/' + m.coverage.need_window_days + ' days, ' +
        m.coverage.weighin_days + '/' + m.coverage.need_weighin_days + ' weigh-ins, ' +
        m.coverage.intake_days + '/' + m.coverage.need_intake_days + ' intake days') : '…') + ').</div>';
    return;
  }
  const v = m.viz, A = m.window_start, B = m.window_end, today = s.today;
  const series = v.series || [];

  // ---- viewport [S .. E] = 61 days; earliest data bounds the back arrow ----
  const dataStart = [...v.weighins.map((w) => w.date), ...v.intake.map((d) => d.date)].sort()[0];
  const E = (viewEnd && viewEnd < today) ? viewEnd : (viewEnd = null, today);
  const S = addDays(E, -(VIEW_DAYS - 1));
  const inView = (d) => d >= S && d <= E;
  const canBack = S > dataStart, canFwd = viewEnd != null;

  const W = 600, L = 46, R = 40;   // R = right gutter for the weight scale + curve value labels (kept clear of dots)
  const X = (d) => L + (W - L - R) * ((idx(d, S) + 0.5) / VIEW_DAYS);
  const XBand = (W - L - R) / VIEW_DAYS;

  const weighins = v.weighins.filter((w) => inView(w.date));
  const intake = v.intake.filter((d) => inView(d.date));
  const rows = series.filter((r) => inView(r.date));

  // ---- weight panel (y: 24..168) ----
  const wy0 = 24, wy1 = 168;
  let sw = '';
  if (weighins.length) {
    const wts = weighins.map((w) => w.weight);
    const wmin = Math.min(...wts) - 0.6, wmax = Math.max(...wts) + 0.6;
    const YW = (w) => wy1 - (wy1 - wy0) * ((w - wmin) / (wmax - wmin));
    // horizontal weight gridlines at round values, labeled in the right gutter (same axis style as intake).
    // Drawn first so the trend line and dots sit on top.
    const wstep = (wmax - wmin) > 12 ? 5 : 2;
    for (let w = Math.ceil(wmin / wstep) * wstep; w <= wmax; w += wstep) {
      const gy = YW(w);
      sw += `<line x1="${L}" y1="${gy.toFixed(1)}" x2="${W - R}" y2="${gy.toFixed(1)}" stroke="#39434f" stroke-width="1" stroke-opacity="0.5"/>` +
            `<text x="${W - 3}" y="${(gy + 3).toFixed(1)}" fill="#7c8794" font-size="10" text-anchor="end">${w}</text>`;
    }
    if (v.slope_lb_day != null && v.weight_at_end != null && inView(B)) {
      const a0 = inView(A) ? A : S;   // clip the trend line to the viewport
      const yA = v.weight_at_end + v.slope_lb_day * idx(a0, B);
      sw += `<line x1="${X(a0).toFixed(1)}" y1="${YW(yA).toFixed(1)}" x2="${X(B).toFixed(1)}" y2="${YW(v.weight_at_end).toFixed(1)}" stroke="#a78bfa" stroke-width="2.2"/>`;
    }
    for (const w of weighins) {
      const op = Math.max(0.3, 0.35 + 0.65 * (w.rw || 0)), r = 3.2 + 2.6 * (w.rw || 0);
      sw += `<circle cx="${X(w.date).toFixed(1)}" cy="${YW(w.weight).toFixed(1)}" r="${r.toFixed(1)}" fill="#a78bfa" fill-opacity="${op.toFixed(2)}"/>`;
    }
  }

  // ---- intake panel (y: 200..416) ----
  const iy0 = 200, iy1 = 416;
  const cals = intake.map((d) => d.calories);
  const svals = rows.flatMap((r) => [r.avg, r.maintenance, r.target]).filter((x) => x != null);
  const imax = Math.max(...cals, ...svals, 1) * 1.12;
  const YI = (c) => iy1 - (iy1 - iy0) * (c / imax);
  const bw = Math.max(3, Math.min(XBand * 0.68, 26));
  let si = '';
  for (const d of intake) {
    if (d.date >= B) {   // after the last weigh-in → not in any window yet
      si += `<rect x="${(X(d.date) - bw / 2).toFixed(1)}" y="${YI(d.calories).toFixed(1)}" width="${bw.toFixed(1)}" height="${(iy1 - YI(d.calories)).toFixed(1)}" fill="url(#mvhatch)" fill-opacity="0.55"/>`;
    } else {
      // Every logged day is real data (no outlier rejection) → always blue. In-window days are
      // recency-shaded; days before the window start are dim flat blue.
      const op = d.kept == null ? 0.4 : (0.3 + 0.7 * (d.rw || 0));
      si += `<rect x="${(X(d.date) - bw / 2).toFixed(1)}" y="${YI(d.calories).toFixed(1)}" width="${bw.toFixed(1)}" height="${(iy1 - YI(d.calories)).toFixed(1)}" fill="#3b82f6" fill-opacity="${op.toFixed(2)}"/>`;
    }
  }
  // historical per-day curves (step: a value holds until the next day's) — avg dashed blue,
  // maintenance amber, target green. Gaps (calibrating nulls) break the path.
  const step = (key) => {
    let p = '', pen = false, prevY = null;
    for (const r of rows) {
      const val = r[key];
      if (val == null) { pen = false; prevY = null; continue; }
      const x = X(r.date), y = YI(val);
      if (!pen) { p += `M${x.toFixed(1)} ${y.toFixed(1)}`; pen = true; }
      else p += `L${x.toFixed(1)} ${prevY.toFixed(1)}L${x.toFixed(1)} ${y.toFixed(1)}`;
      prevY = y;
    }
    return p;
  };
  const curves =
    `<path d="${step('avg')}" fill="none" stroke="#3b82f6" stroke-width="1.5" stroke-dasharray="5 4"/>` +
    `<path d="${step('maintenance')}" fill="none" stroke="#e6b93d" stroke-width="1.8"/>` +
    `<path d="${step('target')}" fill="none" stroke="#39d353" stroke-width="1.8"/>`;
  // intake y-axis: faint horizontal gridlines at round thousands, labeled in the right gutter. No exact
  // per-curve value callouts — the live numbers are in the math line below and the line colors are keyed
  // in the legend; the gridlines just let you read roughly where each line sits.
  let grid = '';
  for (let c = 1000; c < imax; c += 1000) {
    const y = YI(c);
    grid += `<line x1="${L}" y1="${y.toFixed(1)}" x2="${W - R}" y2="${y.toFixed(1)}" stroke="#39434f" stroke-width="1" stroke-opacity="0.5"/>` +
            `<text x="${W - 3}" y="${(y + 3).toFixed(1)}" fill="#7c8794" font-size="10" text-anchor="end">${c / 1000}k</text>`;
  }

  // ---- frozen zone + window markers (only where visible) ----
  let deco = '';
  if (B <= E) {
    const f0 = Math.max(X(B) + XBand * 0.45, L);
    deco += `<rect x="${f0.toFixed(1)}" y="${wy0}" width="${Math.max(0, W - R - f0).toFixed(1)}" height="${iy1 - wy0}" fill="#7c8794" fill-opacity="0.08"/>`;
  }
  for (const [d, label, anchor] of [[A, 'A', 'start'], [B, 'B', 'end']]) {
    if (!inView(d)) continue;
    deco += `<line x1="${X(d).toFixed(1)}" y1="${wy0}" x2="${X(d).toFixed(1)}" y2="${iy1}" stroke="#39d353" stroke-width="1" stroke-dasharray="2 3" opacity="0.8"/>` +
      `<text x="${(X(d) + (anchor === 'end' ? -4 : 4)).toFixed(1)}" y="${wy0 + 11}" fill="#39d353" font-size="10.5" text-anchor="${anchor}">${label}</text>`;
  }

  // ---- x ticks weekly ----
  let ticks = '';
  for (let i = 0; i < VIEW_DAYS; i += 7) {
    const d = addDays(S, i);
    ticks += `<text x="${X(d).toFixed(1)}" y="432" fill="#8b96a5" font-size="11" text-anchor="middle">${fmt(d)}</text>`;
  }

  const trendTxt = m.trend_lb_per_week != null ? `${m.trend_lb_per_week > 0 ? '+' : ''}${m.trend_lb_per_week} lb/wk` : '';
  el.innerHTML =
    '<div class="mv-head"><div><div class="mv-title">Calorie target</div>' +
    `<div class="mv-sub">window ${esc(fmt(A))} → ${esc(fmt(B))} · trend ${esc(trendTxt)} · ${esc(String(v.weight_at_end ?? '—'))} lb</div></div>` +
    `<div class="mv-nav"><button type="button" class="mv-arr" data-nav="back" ${canBack ? '' : 'disabled'}>‹</button>` +
    `<button type="button" class="mv-arr" data-nav="fwd" ${canFwd ? '' : 'disabled'}>›</button></div></div>` +
    `<svg viewBox="0 0 ${W} 442" xmlns="http://www.w3.org/2000/svg">` +
    `<defs><pattern id="mvhatch" width="6" height="6" patternTransform="rotate(45)" patternUnits="userSpaceOnUse">` +
    `<rect width="6" height="6" fill="#39434f"/><line x1="0" y1="0" x2="0" y2="6" stroke="#7c8794" stroke-width="2.4"/></pattern></defs>` +
    deco + sw + grid + si + curves + ticks +
    '</svg>' +
    '<div class="mv-leg">' +
    '<span><i style="background:#a78bfa"></i>weigh-in</span>' +
    '<span><i style="background:#3b82f6"></i>intake</span>' +
    '<span><i class="mv-hatchkey"></i>after last weigh-in (unused)</span>' +
    '<span><i style="background:#39d353"></i>target</span>' +
    '<span><i style="background:#e6b93d"></i>maintenance</span>' +
    '<span><i style="background:#3b82f6;height:3px"></i>weighted avg intake</span>' +
    '</div>' +
    `<div class="mv-math">${esc(`${m.avg_intake ?? '—'} avg − (${v.slope_lb_day != null ? v.slope_lb_day.toFixed(3) : '—'} lb/day × ${v.slope_lb_day > 0 ? 2500 : 3500}) = ${m.maintenance} maintenance → ${m.surplus >= 0 ? '+' : ''}${m.surplus} surplus = ${m.target} target`)}</div>`;

  el.querySelectorAll('.mv-arr').forEach((b) => b.addEventListener('click', () => {
    const cur = viewEnd || today;
    if (b.dataset.nav === 'back') {
      const floor = addDays(dataStart, VIEW_DAYS - 1);   // never scroll past the earliest data
      const next = addDays(cur, -30);
      viewEnd = next < floor ? floor : next;
    } else {
      const next = addDays(cur, 30);
      viewEnd = next >= today ? null : next;
    }
    if (state.last) render(state.last);
  }));
}
