// Maintenance-window visualization — the phone wall's fourth swipe pane. Shows the data the adaptive
// calorie target is based on: weigh-ins with the recency-weighted trend, per-day intake bars, and the
// per-day HISTORICAL avg/maintenance/target curves (maintenance.viz.series — the estimator replayed
// as-of each day, so the curves step at weigh-ins and hold flat between them).
//
// The WHOLE history is drawn at a fixed density and scrolled by hand, newest day at the right. It
// used to be a fixed 61-day viewport paged by ‹ › arrows; dragging is the same gesture the heatmaps
// use, so the plot behaves like the rest of the wall instead of needing a control of its own.
//
// Two consequences worth knowing. The y scales are global (they have to be — a scale that re-fitted
// as you dragged would make the line jump under your finger), so the weight panel no longer zooms
// into a two-month range. And the y-axis labels would scroll off with everything else, so they ride
// the right edge of the viewport instead: `pinAxis` slides that one group as the plot moves.
//
// No-ops where #maintviz is absent (kiosk / desktop / mac hide the pane in CSS).
import { esc, paintScrolled } from '../shared.js';

const DAY = 86400000;
const PXD = 514 / 61;          // units per day — the density the old fixed 61-day viewport had
const PAD_L = 18;              // room for the first day's tick label to sit centred, not clipped
const PAD_R = 40;              // the gutter the pinned y-axis labels sit in
const VB_H = 442;              // viewBox height; the card scales the whole thing to its width
const VB_MIN = 600;            // a history shorter than this still fills the card, blank on the left
const dms = (d) => Date.parse(d + 'T12:00:00Z');
const idx = (d, ref) => Math.round((dms(d) - dms(ref)) / DAY);
const addDays = (d, n) => new Date(dms(d) + n * DAY).toISOString().slice(0, 10);
const fmt = (d) => { const t = new Date(dms(d)); return (t.getUTCMonth() + 1) + '/' + t.getUTCDate(); };

// Hold the y-axis labels against the right edge of what is actually visible. Everything else is
// drawn in content coordinates and scrolls; this one group is translated back by however far the
// viewport's right edge falls short of the content's.
function pinAxis(sc) {
  const svg = sc.querySelector('svg'), g = svg && svg.querySelector('.mv-axisg');
  if (!g) return;
  const px = svg.getBoundingClientRect().width;
  if (!px) return;                                  // pane not laid out yet (off-screen swipe pane)
  const units = svg.viewBox.baseVal.width / px;     // content units per rendered pixel
  g.setAttribute('transform', `translate(${((sc.scrollLeft + sc.clientWidth) * units - svg.viewBox.baseVal.width).toFixed(1)},0)`);
}

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

  // ---- geometry: every day from the earliest data through today, at a fixed width each ----
  const dataStart = [...v.weighins.map((w) => w.date), ...v.intake.map((d) => d.date)].sort()[0];
  const span = idx(today, dataStart) + 1;
  const W = Math.max(VB_MIN, PAD_L + span * PXD + PAD_R);
  const x0 = W - PAD_R - span * PXD;   // first day's band; the shortfall on a short history pads left
  const X = (d) => x0 + (idx(d, dataStart) + 0.5) * PXD;
  const XBand = PXD;
  const axis = [];   // {y, t} — collected as the panels are scaled, drawn last in the pinned group

  const weighins = v.weighins, intake = v.intake, rows = series;

  // ---- weight panel (y: 24..168) ----
  const wy0 = 24, wy1 = 168;
  let sw = '';
  if (weighins.length) {
    const wts = weighins.map((w) => w.weight);
    const wmin = Math.min(...wts) - 0.6, wmax = Math.max(...wts) + 0.6;
    const YW = (w) => wy1 - (wy1 - wy0) * ((w - wmin) / (wmax - wmin));
    // horizontal weight gridlines at round values. They run the whole content width and pass under
    // the pinned label group; the labels themselves go there (same axis style as intake).
    // Drawn first so the trend line and dots sit on top.
    const wstep = (wmax - wmin) > 12 ? 5 : 2;
    for (let w = Math.ceil(wmin / wstep) * wstep; w <= wmax; w += wstep) {
      const gy = YW(w);
      sw += `<line x1="0" y1="${gy.toFixed(1)}" x2="${W}" y2="${gy.toFixed(1)}" stroke="#39434f" stroke-width="1" stroke-opacity="0.5"/>`;
      axis.push({ y: gy + 3, t: String(w) });
    }
    if (v.slope_lb_day != null && v.weight_at_end != null) {
      const yA = v.weight_at_end + v.slope_lb_day * idx(A, B);
      sw += `<line x1="${X(A).toFixed(1)}" y1="${YW(yA).toFixed(1)}" x2="${X(B).toFixed(1)}" y2="${YW(v.weight_at_end).toFixed(1)}" stroke="#a78bfa" stroke-width="2.2"/>`;
    }
    for (const w of weighins) {
      // In the window or out of it — the estimator no longer has a recency gradient to shade by.
      const op = w.inwin ? 0.95 : 0.35, r = w.inwin ? 5.4 : 3.2;
      sw += `<circle cx="${X(w.date).toFixed(1)}" cy="${YW(w.weight).toFixed(1)}" r="${r.toFixed(1)}" fill="#a78bfa" fill-opacity="${op.toFixed(2)}"/>`;
    }
  }

  // ---- intake panel (y: 200..416) ----
  const iy0 = 200, iy1 = 416;
  const cals = intake.map((d) => d.calories);
  // Scale to what's actually drawn: the bars and the two curves. `avg` is still in the payload (the
  // math line quotes it) but is no longer plotted, so it must not stretch the axis.
  const svals = rows.flatMap((r) => [r.maintenance, r.target]).filter((x) => x != null);
  const imax = Math.max(...cals, ...svals, 1) * 1.12;
  const YI = (c) => iy1 - (iy1 - iy0) * (c / imax);
  const bw = Math.max(3, Math.min(XBand * 0.68, 26));
  let si = '';
  for (const d of intake) {
    if (d.date >= B) {   // after the last weigh-in → not in any window yet
      si += `<rect x="${(X(d.date) - bw / 2).toFixed(1)}" y="${YI(d.calories).toFixed(1)}" width="${bw.toFixed(1)}" height="${(iy1 - YI(d.calories)).toFixed(1)}" fill="url(#mvhatch)" fill-opacity="0.55"/>`;
    } else {
      // Every logged day is real data (no outlier rejection) → always blue. In-window days are
      // solid (they all count equally now); days before the window start are dim.
      const op = d.kept == null ? 0.4 : 0.9;
      si += `<rect x="${(X(d.date) - bw / 2).toFixed(1)}" y="${YI(d.calories).toFixed(1)}" width="${bw.toFixed(1)}" height="${(iy1 - YI(d.calories)).toFixed(1)}" fill="#3b82f6" fill-opacity="${op.toFixed(2)}"/>`;
    }
  }
  // historical per-day curves (step: a value holds until the next day's) — maintenance amber,
  // target green. Gaps (calibrating nulls) break the path.
  //
  // The weighted-average-intake curve used to be drawn here too, dashed blue. It was dropped: blue
  // was already the intake bars, so the same colour meant two things, and the figure it plotted is
  // spelled out in the math line underneath. Two lines read better than three.
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
    `<path d="${step('maintenance')}" fill="none" stroke="#e6b93d" stroke-width="1.8"/>` +
    `<path d="${step('target')}" fill="none" stroke="#39d353" stroke-width="1.8"/>`;
  // intake y-axis: faint horizontal gridlines at round thousands, labeled in the right gutter. No exact
  // per-curve value callouts — the live numbers are in the math line below and the line colors are keyed
  // in the legend; the gridlines just let you read roughly where each line sits.
  let grid = '';
  for (let c = 1000; c < imax; c += 1000) {
    const y = YI(c);
    grid += `<line x1="0" y1="${y.toFixed(1)}" x2="${W}" y2="${y.toFixed(1)}" stroke="#39434f" stroke-width="1" stroke-opacity="0.5"/>`;
    axis.push({ y: y + 3, t: (c / 1000) + 'k' });
  }

  // ---- frozen zone + window markers (only where visible) ----
  let deco = '';
  const f0 = X(B) + XBand * 0.45;
  deco += `<rect x="${f0.toFixed(1)}" y="${wy0}" width="${Math.max(0, W - f0).toFixed(1)}" height="${iy1 - wy0}" fill="#7c8794" fill-opacity="0.08"/>`;
  for (const [d, label, anchor] of [[A, 'A', 'start'], [B, 'B', 'end']]) {
    deco += `<line x1="${X(d).toFixed(1)}" y1="${wy0}" x2="${X(d).toFixed(1)}" y2="${iy1}" stroke="#39d353" stroke-width="1" stroke-dasharray="2 3" opacity="0.8"/>` +
      `<text x="${(X(d) + (anchor === 'end' ? -4 : 4)).toFixed(1)}" y="${wy0 + 11}" fill="#39d353" font-size="10.5" text-anchor="${anchor}">${label}</text>`;
  }

  // ---- x ticks weekly ----
  let ticks = '';
  for (let i = 0; i < span; i += 7) {
    const d = addDays(dataStart, i);
    ticks += `<text x="${X(d).toFixed(1)}" y="432" fill="#8b96a5" font-size="11" text-anchor="middle">${fmt(d)}</text>`;
  }
  // The y-axis labels, in the group pinAxis holds against the right edge. The backing rect is the
  // card's own colour so the gridlines running under it stop cleanly at the numbers.
  const bg = getComputedStyle(el.closest('.card') || el).backgroundColor || '#151a20';
  const axisG = `<g class="mv-axisg">` +
    `<rect x="${W - PAD_R}" y="0" width="${PAD_R}" height="${VB_H}" fill="${bg}"/>` +
    axis.map((a) => `<text x="${W - 3}" y="${a.y.toFixed(1)}" fill="#7c8794" font-size="10" text-anchor="end">${a.t}</text>`).join('') +
    `</g>`;

  const trendTxt = m.trend_lb_per_week != null ? `${m.trend_lb_per_week > 0 ? '+' : ''}${m.trend_lb_per_week} lb/wk` : '';
  // The SVG is sized as a multiple of the card width: at 100% a VB_MIN-wide viewBox fills it, so
  // W/VB_MIN keeps units-per-pixel exactly what it was and everything past one screen scrolls.
  const sc = paintScrolled(el,
    '<div class="mv-head"><div><div class="mv-title">Calorie target</div>' +
    `<div class="mv-sub">window ${esc(fmt(A))} → ${esc(fmt(B))} · trend ${esc(trendTxt)} · ${esc(String(v.weight_at_end ?? '—'))} lb</div></div></div>` +
    '<div class="mv-scroll">' +
    `<svg viewBox="0 0 ${W.toFixed(1)} ${VB_H}" style="width:${(W / VB_MIN * 100).toFixed(3)}%" xmlns="http://www.w3.org/2000/svg">` +
    `<defs><pattern id="mvhatch" width="6" height="6" patternTransform="rotate(45)" patternUnits="userSpaceOnUse">` +
    `<rect width="6" height="6" fill="#39434f"/><line x1="0" y1="0" x2="0" y2="6" stroke="#7c8794" stroke-width="2.4"/></pattern></defs>` +
    deco + sw + grid + si + curves + ticks + axisG +
    '</svg></div>' +
    '<div class="mv-leg">' +
    '<span><i style="background:#a78bfa"></i>weigh-in</span>' +
    '<span><i style="background:#3b82f6"></i>intake</span>' +
    '<span><i class="mv-hatchkey"></i>after last weigh-in (unused)</span>' +
    '<span><i style="background:#39d353"></i>target</span>' +
    '<span><i style="background:#e6b93d"></i>maintenance</span>' +
    '</div>' +
    `<div class="mv-math">${esc(`${m.avg_intake ?? '—'} avg − (${v.slope_lb_day != null ? v.slope_lb_day.toFixed(3) : '—'} lb/day × ${v.slope_lb_day > 0 ? 2500 : 3500}) = ${m.maintenance} maintenance → ${m.surplus >= 0 ? '+' : ''}${m.surplus} surplus = ${m.target} target`)}</div>`,
    { sel: '.mv-scroll', stick: true });
  if (!sc) return;
  sc.addEventListener('scroll', () => pinAxis(sc), { passive: true });
  pinAxis(sc);
  // The pane is off-screen until it is swiped to, so the first render can measure a zero-width SVG
  // and place the axis nowhere. Re-pin once it has a box.
  if (!sc.querySelector('svg').getBoundingClientRect().width) {
    requestAnimationFrame(() => { sc.scrollLeft = sc.scrollWidth; pinAxis(sc); });
  }
}
