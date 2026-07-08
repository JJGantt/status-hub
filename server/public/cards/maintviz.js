// Maintenance-window visualization — the phone wall's fourth swipe pane. Shows exactly the data the
// adaptive calorie target is based on: the weigh-in-bookended energy-balance window [A..B], the weight
// trend through it, the recency-weighted intake days, and the post-weigh-in days that are deliberately
// NOT used (no weight evidence — the frozen zone). Renders straight from maintenance.viz, the
// estimator's own intermediates, so the display can never drift from the calc. No-ops where #maintviz
// is absent (kiosk / desktop / mac hide the pane in CSS).
import { esc } from '../shared.js';

const DAY = 86400000;
const dms = (d) => Date.parse(d + 'T12:00:00Z');
const idx = (d, ref) => Math.round((dms(d) - dms(ref)) / DAY);
const fmt = (d) => { const t = new Date(dms(d)); return (t.getUTCMonth() + 1) + '/' + t.getUTCDate(); };

export function render(s) {
  const el = document.getElementById('maintviz');
  if (!el) return;
  const m = s && s.maintenance;
  if (!m || !m.viz || !m.viz.weighins || !m.viz.weighins.length) {
    el.innerHTML = '<div class="mv-title">Calorie target</div><div class="mv-note">Calibrating — needs a weigh-in-bookended tracking window (' +
      (m && m.coverage ? esc(m.coverage.window_days + '/' + m.coverage.need_window_days + ' days, ' +
        m.coverage.weighin_days + '/' + m.coverage.need_weighin_days + ' weigh-ins, ' +
        m.coverage.intake_days + '/' + m.coverage.need_intake_days + ' intake days') : '…') + ').</div>';
    return;
  }
  const v = m.viz, A = m.window_start, B = m.window_end, today = s.today;

  // shared x scale: [A-1 .. today+1] in day units relative to B
  const W = 600, L = 46, R = 14;
  const x0 = idx(A, B) - 1, x1 = idx(today, B) + 1;
  const X = (d) => L + (W - L - R) * ((idx(d, B) - x0) / (x1 - x0));
  const XBand = (W - L - R) / (x1 - x0);           // px per day
  const frozen0 = X(B) + XBand * 0.45;             // frozen zone starts just right of B

  // ---- weight panel (y: 34..176) ----
  const wy0 = 34, wy1 = 176;
  const wts = v.weighins.map((w) => w.weight);
  const wmin = Math.min(...wts) - 0.6, wmax = Math.max(...wts) + 0.6;
  const YW = (w) => wy1 - (wy1 - wy0) * ((w - wmin) / (wmax - wmin));
  let sw = '';
  // trend line across [A..B] from the estimator's slope + end-weight (intercept at B)
  if (v.slope_lb_day != null && v.weight_at_end != null) {
    const yA = v.weight_at_end + v.slope_lb_day * idx(A, B), yB = v.weight_at_end;
    sw += `<line x1="${X(A).toFixed(1)}" y1="${YW(yA).toFixed(1)}" x2="${X(B).toFixed(1)}" y2="${YW(yB).toFixed(1)}" stroke="#a78bfa" stroke-width="2.2"/>`;
  }
  for (const w of v.weighins) {
    const op = 0.35 + 0.65 * w.rw, r = 3.4 + 2.6 * w.rw;
    sw += `<circle cx="${X(w.date).toFixed(1)}" cy="${YW(w.weight).toFixed(1)}" r="${r.toFixed(1)}" fill="#a78bfa" fill-opacity="${op.toFixed(2)}"/>`;
  }

  // ---- intake panel (y: 208..420) ----
  const iy0 = 208, iy1 = 420;
  const allCal = [...v.intake, ...v.post].map((d) => d.calories);
  const imax = Math.max(...allCal, m.target || 0, m.maintenance || 0) * 1.12;
  const YI = (c) => iy1 - (iy1 - iy0) * (c / imax);
  const bw = Math.min(XBand * 0.68, 26);
  let si = '';
  for (const d of v.intake) {
    const op = 0.3 + 0.7 * d.rw, c = d.kept ? '#3b82f6' : '#e5484d';
    si += `<rect x="${(X(d.date) - bw / 2).toFixed(1)}" y="${YI(d.calories).toFixed(1)}" width="${bw.toFixed(1)}" height="${(iy1 - YI(d.calories)).toFixed(1)}" fill="${c}" fill-opacity="${op.toFixed(2)}"/>`;
  }
  for (const d of v.post) {
    si += `<rect x="${(X(d.date) - bw / 2).toFixed(1)}" y="${YI(d.calories).toFixed(1)}" width="${bw.toFixed(1)}" height="${(iy1 - YI(d.calories)).toFixed(1)}" fill="url(#mvhatch)" fill-opacity="0.55"/>`;
  }
  // reference lines: avg intake (dashed blue), maintenance (amber), target (green)
  const refs = [];   // label above the line by default; maintenance sits below to avoid colliding with target
  if (v.avg_intake != null) refs.push({ y: YI(v.avg_intake), c: '#3b82f6', t: 'avg ' + v.avg_intake, dash: '5 4', ty: YI(v.avg_intake) + 14 });
  refs.push({ y: YI(m.maintenance), c: '#e6b93d', t: 'maint ' + m.maintenance, ty: YI(m.maintenance) + 14 });
  refs.push({ y: YI(m.target), c: '#39d353', t: 'target ' + m.target, ty: YI(m.target) - 5 });
  for (const r of refs)
    si += `<line x1="${L}" y1="${r.y.toFixed(1)}" x2="${W - R}" y2="${r.y.toFixed(1)}" stroke="${r.c}" stroke-width="1.6"${r.dash ? ` stroke-dasharray="${r.dash}"` : ''}/>`;

  // ---- x ticks (every 3rd day) + window markers ----
  let ticks = '';
  for (let i = x0 + 1; i <= x1 - 1; i++) {
    if (((i - idx(A, B)) % 3) !== 0) continue;
    const dstr = new Date(dms(B) + i * DAY).toISOString().slice(0, 10);
    ticks += `<text x="${(L + (W - L - R) * ((i - x0) / (x1 - x0))).toFixed(1)}" y="436" fill="#8b96a5" font-size="11" text-anchor="middle">${fmt(dstr)}</text>`;
  }
  const vline = (d, label, anchor) =>
    `<line x1="${X(d).toFixed(1)}" y1="${wy0}" x2="${X(d).toFixed(1)}" y2="${iy1}" stroke="#39d353" stroke-width="1" stroke-dasharray="2 3" opacity="0.8"/>` +
    `<text x="${(X(d) + (anchor === 'end' ? -4 : 4)).toFixed(1)}" y="${wy0 - 4}" fill="#39d353" font-size="10.5" text-anchor="${anchor}">${label}</text>`;

  // frozen zone spans both panels
  const frozen = `<rect x="${frozen0.toFixed(1)}" y="${wy0}" width="${(W - R - frozen0).toFixed(1)}" height="${iy1 - wy0}" fill="#7c8794" fill-opacity="0.08"/>` +
    `<text x="${((frozen0 + W - R) / 2).toFixed(1)}" y="${wy0 + 14}" fill="#8b96a5" font-size="10.5" font-style="italic" text-anchor="middle">frozen — no weigh-ins</text>`;

  const trendTxt = m.trend_lb_per_week != null ? `${m.trend_lb_per_week > 0 ? '+' : ''}${m.trend_lb_per_week} lb/wk` : '';
  el.innerHTML =
    '<div class="mv-title">Calorie target</div>' +
    `<div class="mv-sub">window ${esc(fmt(A))} → ${esc(fmt(B))} (weigh-in bookended) · trend ${esc(trendTxt)} · weight ${esc(String(v.weight_at_end ?? '—'))} lb</div>` +
    `<svg viewBox="0 0 ${W} 446" xmlns="http://www.w3.org/2000/svg">` +
    `<defs><pattern id="mvhatch" width="6" height="6" patternTransform="rotate(45)" patternUnits="userSpaceOnUse">` +
    `<rect width="6" height="6" fill="#39434f"/><line x1="0" y1="0" x2="0" y2="6" stroke="#7c8794" stroke-width="2.4"/></pattern></defs>` +
    frozen +
    `<text x="${L + 18}" y="${wy0 - 4}" fill="#a78bfa" font-size="11">weight (lb)</text>` +
    `<text x="${W - R}" y="${YW(wmax - 0.6) + 4}" fill="#5c6675" font-size="10" text-anchor="end">${wmax.toFixed(1)}</text>` +
    `<text x="${W - R}" y="${YW(wmin + 0.6) + 4}" fill="#5c6675" font-size="10" text-anchor="end">${wmin.toFixed(1)}</text>` +
    sw + vline(A, 'A', 'start') + vline(B, 'B', 'end') + si + ticks +
    refs.map((r) => `<text x="${W - R}" y="${r.ty.toFixed(1)}" fill="${r.c}" font-size="11" text-anchor="end">${esc(r.t)}</text>`).join('') +
    '</svg>' +
    '<div class="mv-leg">' +
    '<span><i style="background:#a78bfa"></i>weigh-ins (opacity = recency weight)</span>' +
    '<span><i style="background:#3b82f6"></i>intake day used</span>' +
    '<span><i class="mv-hatchkey"></i>after last weigh-in (unused)</span>' +
    '</div>' +
    `<div class="mv-math">${esc(`${v.avg_intake ?? '—'} avg − (${v.slope_lb_day != null ? (v.slope_lb_day * 1).toFixed(3) : '—'} lb/day × ${v.slope_lb_day > 0 ? 2500 : 3500}) = ${m.maintenance} maintenance → ${m.surplus >= 0 ? '+' : ''}${m.surplus} surplus = ${m.target} target`)}</div>`;
}
