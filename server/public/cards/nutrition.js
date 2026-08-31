// Today · Nutrition card: pace rings (Cal/P/C/F). The eating window is fixed for the day, so the
// drain is pure clock math — the server sends consumed/goal + the window, and the BROWSER ticks the
// ring fill + marker every second (smooth, no 30s round-trip). Each ring's arc = (1-frac)+progress;
// it drains over the window and fills as you log. White marker = the (1-frac) zero-food baseline.
//
// Staged meals extend the ring without touching it: the eaten arc keeps its exact length and color,
// and a detached piece is drawn past its end, running to where the arc WOULD end and painted the
// color the ring WOULD be, had the staged meal been committed.
import { state } from '../shared.js';

const RC = 2 * Math.PI * 34; // ring circumference (r=34)
function hslToHex(h, s, l) {
 const c = (1 - Math.abs(2 * l - 1)) * s, x = c * (1 - Math.abs(((h / 60) % 2) - 1)), m = l - c / 2;
 let r, g, b;
 if (h < 60) [r, g, b] = [c, x, 0]; else if (h < 120) [r, g, b] = [x, c, 0];
 else if (h < 180) [r, g, b] = [0, c, x]; else if (h < 240) [r, g, b] = [0, x, c];
 else if (h < 300) [r, g, b] = [x, 0, c]; else [r, g, b] = [c, 0, x];
 const to = (v) => Math.round((v + m) * 255).toString(16).padStart(2, '0');
 return '#' + to(r) + to(g) + to(b);
}
const SCALE = 0.4; // devNorm magnitude that saturates the color (matches lib/pace.js)
const underColor = (dn) => hslToHex(120 * (1 - Math.max(0, Math.min(1, -dn / SCALE))), 0.75, 0.5); // green→red as you fall behind
const overColor = (dn) => hslToHex(45 - 20 * Math.max(0, Math.min(1, dn / SCALE)), 0.9, 0.5);       // amber→orange when ahead
// minutes since 4am in the browser's clock (the eating window is in NY; Jared's devices are NY)
function nowOffsetMin() { const d = new Date(); return (((d.getHours() - 4) * 60 + d.getMinutes() + d.getSeconds() / 60) + 1440) % 1440; }

export function render(s) {
 const P = s.pace || {}, PM = P.macros || {};
 const ring = (glyph, key) => { const m = PM[key]; if (!m) return '';
  return '<div class="ring" data-macro="' + key + '">' +
   '<svg viewBox="0 0 80 80">' +
   '<circle cx="40" cy="40" r="34" fill="none" stroke="#0e1318" stroke-width="7" />' +
   '<circle class="ring-base" cx="40" cy="40" r="34" fill="none" stroke-width="7" stroke-linecap="round" transform="rotate(-90 40 40)" stroke-dasharray="0 ' + RC + '" />' +
   '<circle class="ring-staged" cx="40" cy="40" r="34" fill="none" stroke-width="7" stroke-linecap="round" transform="rotate(-90 40 40)" style="display:none" />' +
   '<circle class="ring-over" cx="40" cy="40" r="34" fill="none" stroke-width="7" stroke-linecap="round" transform="rotate(-90 40 40)" style="display:none" />' +
   '<circle class="ring-over-staged" cx="40" cy="40" r="34" fill="none" stroke-width="7" stroke-linecap="round" transform="rotate(-90 40 40)" style="display:none" />' +
   '<line class="ring-mark" stroke="#e8eaed" stroke-width="2" stroke-linecap="round" />' +
   '<text x="40" y="37" text-anchor="middle" class="rg">' + glyph + '</text>' +
   '<text x="40" y="54" text-anchor="middle" class="rd"></text>' +
   '</svg>' +
   '<div class="rtot">' + (m.consumed || 0) + ' / ' + (m.goal || 0) + '</div>' +
   '</div>'; };
 const el = document.getElementById('nutrition'); if (!el) return; // absent on /page after consolidation
 el.innerHTML = '<h2>Today · Nutrition</h2>' +
  '<div class=rings>' + ring('Cal', 'calories') + ring('P', 'protein_g') + ring('C', 'carbs_g') + ring('F', 'fat_g') +
   miniGroup(P.produce) + '</div>' +
  '<div class=pnote>' + (P.window_label || '') + '</div>';
 tickRings(); // paint immediately at the current second
}

// ---- produce rings (dark green vegetables / all vegetables / fruit) -------
// Deliberately a different gauge from the four above. Those DRAIN with the clock (pace); these start
// empty each day and FILL toward a fixed goal, so there's no marker, no overflow arc, and no live
// tick — they only change when food is logged, which arrives via the normal SSE re-render.
// No number is drawn: at this size only the icon is legible, so the icon carries the identity and the
// unfilled track is tinted with the ring's own color so you can still tell them apart at 0%.
const MRC = 2 * Math.PI * 30;  // mini ring circumference (r=30)
const PRODUCE = [
 { key: 'dark_green_g', color: '#22c55e', title: 'Dark green vegetables' },
 { key: 'veg_g', color: '#f59e0b', title: 'Vegetables (all)' },
 { key: 'fruit_g', color: '#ef4444', title: 'Fruit' },
];
// Tiny white glyphs, ~23 units tall inside the r=30 ring (inner diameter 52) so they read as shapes
// rather than filling the hole. Solid silhouettes only — strokes and interior detail vanish by ~20px,
// which is the size these hit on the phone. The RING COLOR carries identity at that size; the glyph
// only has to be distinct in outline (pointed / wedge / round).
const ICONS = {
 // leaf: tilted blade (tip upper-right, base lower-left) with a stem and an angled midrib. The tilt +
 // stem are what make it read as a leaf — a symmetric upright oval reads as a seed instead.
 dark_green_g: '<path d="M30 50c0-12 10-22 23-22 0 12-10 22-23 22z" fill="#fff"/><path d="M32 48 47 33" stroke="#0e1318" stroke-width="1.7" stroke-linecap="round"/><path d="M30 50l-4.5 4.5" stroke="#fff" stroke-width="2.4" stroke-linecap="round"/>',
 // carrot: tapered wedge pointing down + three fronds
 veg_g: '<path d="M34 37h12l-5 16a1 1 0 0 1-2 0z" fill="#fff"/><path d="M39 36 32 29l4 7zM41 36l7-7-4 7zM39.2 36V28h1.6v8z" fill="#fff"/>',
 // apple: two-lobe body with a top notch + stem
 fruit_g: '<path d="M40 36c-2.5-2.5-9-2-9 5 0 6.5 4 12 9 12s9-5.5 9-12c0-7-6.5-7.5-9-5z" fill="#fff"/><path d="M39.2 36v-6h1.6v6z" fill="#fff"/>',
};

function miniGroup(produce) {
 if (!produce) return '';
 return '<div class="ringmini">' + PRODUCE.map((p) => {
  const m = produce[p.key]; if (!m) return '';
  const frac = Math.max(0, Math.min(1, m.progress || 0));
  const fill = frac * MRC;
  // At exactly 0 the round line-cap would still paint a dot at 12 o'clock, so an untouched goal would
  // read as slightly started. Drop the arc entirely instead — empty has to look empty.
  const arc = frac <= 0 ? '' :
   '<circle cx="40" cy="40" r="30" fill="none" stroke="' + p.color + '" stroke-width="8" stroke-linecap="round"' +
   ' transform="rotate(-90 40 40)" stroke-dasharray="' + fill.toFixed(2) + ' ' + (MRC - fill).toFixed(2) + '" />';
  return '<div class="mring" title="' + p.title + ' ' + (m.consumed || 0) + 'g / ' + (m.goal || 0) + 'g">' +
   '<svg viewBox="0 0 80 80">' +
   '<circle cx="40" cy="40" r="30" fill="none" stroke="' + p.color + '" stroke-opacity=".22" stroke-width="8" />' +
   arc +
   '<g class="micon">' + (ICONS[p.key] || '') + '</g>' +
   '</svg></div>';
 }).join('') + '</div>';
}

// The staged piece: an arc segment ending exactly where the ring would end if the staged meals were
// committed, held clear of the eaten arc by GAP so the two never read as one fill. Drawn on top of
// the arc it extends, so its own color is never blended with the one underneath.
const GAP = 3;        // arc units (~5°) of clear track between the eaten arc and the staged piece
const CAP = 3.5;      // half the stroke width: a round cap overshoots each end by this much, so a
                      // piece that merely started GAP later would still butt against the arc's cap
const MIN_PIECE = 1;  // a small staged meal shrinks to the round cap rather than disappearing
function paintStaged(el, from, to, color) {
 if (!el) return;
 const span = to - from;
 if (!color || span <= 0.5) { el.style.display = 'none'; return; }
 const len = Math.max(MIN_PIECE, span - GAP - 2 * CAP);
 el.setAttribute('stroke', color);
 el.setAttribute('stroke-dasharray', len.toFixed(2) + ' ' + (RC - len).toFixed(2));
 el.setAttribute('stroke-dashoffset', (len - to).toFixed(2));   // anchor the piece's END at `to`
 el.style.display = '';
}

// live tick: recompute the pace position from the browser clock + the (fixed-for-the-day) window
function tickRings() {
 const P = state.last && state.last.pace; if (!P || !P.window) return;
 const w = P.window, off = nowOffsetMin();
 const frac = off <= w.startMin ? 0 : off >= w.endMin ? 1 : (off - w.startMin) / (w.endMin - w.startMin);
 const phi = 2 * Math.PI * frac; // marker: CCW from top
 const pt = (r) => [(40 - r * Math.sin(phi)).toFixed(2), (40 - r * Math.cos(phi)).toFixed(2)];
 const [ix, iy] = pt(29), [ox, oy] = pt(39.5);
 document.querySelectorAll('#nutrition .ring').forEach((el) => {
  const m = (P.macros || {})[el.dataset.macro]; if (!m) return;
  const goal = m.goal || 0, consumed = m.consumed || 0;
  const dn = goal > 0 ? (consumed - goal * frac) / goal : 0;     // (consumed - expected) / goal
  const base = Math.max(0, Math.min(1, 1 + dn)) * RC, over = Math.max(0, Math.min(1, dn)) * RC;
  const dev = Math.round(consumed - goal * frac);
  const ba = el.querySelector('.ring-base'); ba.setAttribute('stroke-dasharray', base + ' ' + (RC - base)); ba.setAttribute('stroke', dn <= 0 ? underColor(dn) : '#22c55e');
  const oa = el.querySelector('.ring-over');
  if (over > 0) { oa.setAttribute('stroke-dasharray', over + ' ' + (RC - over)); oa.setAttribute('stroke', overColor(dn)); oa.style.display = ''; } else oa.style.display = 'none';
  const stg = m.staged || 0;
  if (stg > 0) {
   const dn2 = goal > 0 ? (consumed + stg - goal * frac) / goal : 0;   // the pace it would be at, committed
   const base2 = Math.max(0, Math.min(1, 1 + dn2)) * RC, over2 = Math.max(0, Math.min(1, dn2)) * RC;
   paintStaged(el.querySelector('.ring-staged'), base, base2, dn2 <= 0 ? underColor(dn2) : '#22c55e');
   paintStaged(el.querySelector('.ring-over-staged'), over, over2, dn2 > 0 ? overColor(dn2) : null);
  } else {
   el.querySelector('.ring-staged').style.display = 'none';
   el.querySelector('.ring-over-staged').style.display = 'none';
  }
  const mk = el.querySelector('.ring-mark'); mk.setAttribute('x1', ix); mk.setAttribute('y1', iy); mk.setAttribute('x2', ox); mk.setAttribute('y2', oy);
  const rd = el.querySelector('.rd'); rd.textContent = (dev > 0 ? '+' : '') + dev; rd.setAttribute('fill', dev < 0 ? '#f87171' : dev > 0 ? overColor(dn) : '#22c55e');
 });
}
setInterval(tickRings, 1000);
