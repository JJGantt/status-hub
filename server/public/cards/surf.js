// Surf forecast card — current conditions + 7-day outlook for a spot (Mayport Poles).
// Days render as rows; tapping a row expands an hourly 8a–8p breakdown for that day.
// Data: Pi collector (JJGantt/surf-report) -> surf_snapshots -> server buildSurf().
// Colors come from the server (Surfline's canonical rating palette); this card only paints.
import { state } from '../shared.js';

const SPOT_LABEL = { 'mayport-poles': 'Poles' };

const ftRange = (a, b) =>
  (a == null || b == null) ? '—' : (a === b ? `${a} ft` : `${a}–${b} ft`);

// ---- history grids ----------------------------------------------------------------------------
// /api/surf/history returns strings, one char per hour, not arrays of rows — see the server comment.
// Fetched once and refetched only when a new snapshot lands (capturedAt moves), because it is ~2KB
// and changes twice a day, while this card re-renders on every 30s broadcast.
const GRID_H = 86;         // per grid; both are drawn on one canvas so they sit flush
const DOW_H = 13;          // weekday-letter strip above the grids, same canvas so it stays aligned
const WATER_H = 68;
const PAD_L = 26;          // left gutter for axis labels, so nothing is written over the data
let hist = null, histFor = null, histPending = false;

function loadHistory(capturedAt) {
  if (histPending || histFor === capturedAt) return;
  histPending = true;
  fetch('/api/surf/history')
    .then(r => r.ok ? r.json() : null)
    .then(j => { if (j && j.hours) { hist = j; histFor = capturedAt; render(state.last); } })
    .catch(() => {})
    .finally(() => { histPending = false; });
}

const dayKey = (d) => d.toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
const hourOf = (d) => +d.toLocaleString('en-US', { hour: 'numeric', hour12: false,
                                                   timeZone: 'America/New_York' }) % 24;

// Bucket the hourly strings into day columns x hour rows, in local time.
function grid() {
  const cols = [], byDay = new Map();
  for (let i = 0; i < hist.hours; i++) {
    const d = new Date((hist.t0 + i * 3600) * 1000);
    const k = dayKey(d);
    if (!byDay.has(k)) { byDay.set(k, { r: new Array(24).fill('.'), s: new Array(24).fill('.') });
                         cols.push(k); }
    const h = hourOf(d), c = byDay.get(k);
    c.r[h] = hist.rating[i];
    c.s[h] = hist.size[i];
  }
  return { cols, byDay };
}

// Canvas rather than ~1,300 rects: this is a phone surface and the grids are pure colour with no
// per-cell interaction to hang off the DOM.
function paintGrids(cv) {
  if (!hist || !cv) return;
  const { cols, byDay } = grid();
  const dpr = window.devicePixelRatio || 1;
  const w = cv.clientWidth || 320, H = DOW_H + GRID_H * 2;
  cv.width = Math.round(w * dpr); cv.height = Math.round(H * dpr);
  const g = cv.getContext('2d'); g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, w, H);
  const plotW = w - PAD_L;
  const cw = plotW / cols.length, ch = GRID_H / 24;

  // Weekday letter over each column, on the same canvas as the grids so it cannot drift out of
  // alignment with them the way a separately-laid-out HTML row could.
  g.font = '9px system-ui, -apple-system, sans-serif';
  g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillStyle = '#8b96a5';
  const skip = cw < 9 ? Math.ceil(9 / cw) : 1;      // thin columns get every Nth letter, not a smear
  cols.forEach((k, x) => {
    if (x % skip) return;
    // Midday avoids the key being shifted a day by a DST-edge parse; +6 %7 turns Sun-first into
    // Mon-first so the string reads MTWTFSS.
    const dow = (new Date(k + 'T12:00:00').getDay() + 6) % 7;
    g.fillText('MTWTFSS'[dow], PAD_L + (x + .5) * cw, DOW_H / 2);
  });
  g.textAlign = 'start'; g.textBaseline = 'alphabetic';

  cols.forEach((k, x) => {
    const c = byDay.get(k);
    for (let h = 0; h < 24; h++) {
      // hour 0 at the bottom of each grid, so the morning band reads as a horizontal stripe
      const y = DOW_H + GRID_H - (h + 1) * ch;
      const rb = c.r[h], sb = c.s[h];
      g.fillStyle = rb === '.' ? '#1a222b' : (hist.bandColors[parseInt(rb, 36)] || '#1a222b');
      g.fillRect(PAD_L + x * cw, y, Math.ceil(cw) + .5, Math.ceil(ch) + .5);
      g.fillStyle = sb === '.' ? '#1a222b' : (hist.sizeColors[parseInt(sb, 36)] || '#1a222b');
      g.fillRect(PAD_L + x * cw, GRID_H + y, Math.ceil(cw) + .5, Math.ceil(ch) + .5);
    }
  });

  // 8a and 4p on cell boundaries, so a line coincides with the hour it names rather than floating
  // half a row off it.
  // Guides on both grids, with their labels in the left gutter rather than over the data — the same
  // reason the weekday letters sit above rather than on top.
  g.font = '9px system-ui, -apple-system, sans-serif';
  g.textBaseline = 'middle';
  for (const base of [DOW_H, DOW_H + GRID_H]) {
    for (const [h, txt] of [[8, '8a'], [16, '4p']]) {
      const y = base + GRID_H - h * ch;
      g.strokeStyle = 'rgba(255,255,255,.55)'; g.lineWidth = 1;
      g.beginPath(); g.moveTo(PAD_L, y); g.lineTo(w, y); g.stroke();
      g.fillStyle = '#8b96a5'; g.textAlign = 'right';
      g.fillText(txt, PAD_L - 5, y);
    }
  }
  g.textAlign = 'start';
  // Seam between the grids, and today.
  g.strokeStyle = 'rgba(255,255,255,.85)'; g.lineWidth = 1;
  g.beginPath(); g.moveTo(PAD_L, DOW_H + GRID_H + .5); g.lineTo(w, DOW_H + GRID_H + .5); g.stroke();
  const now = new Date();
  const ti = cols.indexOf(dayKey(now));
  if (ti >= 0) {
    g.strokeStyle = '#ffffff'; g.lineWidth = 1.5;
    const x = PAD_L + (ti + .5) * cw;
    g.beginPath(); g.moveTo(x, DOW_H); g.lineTo(x, H); g.stroke();
    // Crossbar at the current time. y runs from midnight at the grid's floor upward, the same
    // mapping the 8a/4p guides use, so hour + minutes lands on the instant rather than the cell.
    const hNow = hourOf(now) + now.getMinutes() / 60;
    g.lineWidth = 2;
    for (const base of [DOW_H, DOW_H + GRID_H]) {
      const y = base + GRID_H - hNow * ch;
      g.beginPath(); g.moveTo(x - cw * .45, y); g.lineTo(x + cw * .45, y); g.stroke();
    }
  }
}

// Water: measured up to now, forecast beyond it. Two series, because a prediction and a reading are
// different claims and must not be drawn as one line.
function paintWater(cv) {
  if (!hist || !cv) return;
  const dpr = window.devicePixelRatio || 1;
  const w = cv.clientWidth || 320;
  cv.width = Math.round(w * dpr); cv.height = Math.round(WATER_H * dpr);
  const g = cv.getContext('2d'); g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, w, WATER_H);
  const vals = hist.water.concat(hist.waterFc).filter(v => v != null);
  if (!vals.length) return;
  const lo = Math.floor(Math.min(...vals)) - 1, hi = Math.ceil(Math.max(...vals)) + 1;
  const X = (i) => PAD_L + (i / (hist.hours - 1)) * (w - PAD_L);
  const Y = (v) => WATER_H - 6 - ((v - lo) / (hi - lo)) * (WATER_H - 14);

  // Horizontal grid labelled in the gutter. Without it the trace has shape but no scale: a reader
  // can see it rising and cannot say what it is rising to.
  //
  // The step widens until the labels have room. At 2F a ten-degree range puts six labels in 60px
  // and they collide, which is worse than a coarser grid.
  let step = 2;
  while ((hi - lo) / step > 4) step += 2;
  g.font = '9px system-ui, -apple-system, sans-serif';
  g.textBaseline = 'middle'; g.textAlign = 'right';
  for (let v = Math.ceil(lo / step) * step; v <= hi; v += step) {
    const y = Y(v);
    g.strokeStyle = 'rgba(255,255,255,.10)'; g.lineWidth = 1;
    g.beginPath(); g.moveTo(PAD_L, y); g.lineTo(w, y); g.stroke();
    g.fillStyle = '#8b96a5';
    g.fillText(v + '\u00b0', PAD_L - 5, y);
  }
  g.textAlign = 'start';

  const line = (arr, color, dash) => {
    g.strokeStyle = color; g.lineWidth = 1.4; g.setLineDash(dash); g.beginPath();
    let pen = false;
    arr.forEach((v, i) => {
      if (v == null) { pen = false; return; }
      if (pen) g.lineTo(X(i), Y(v)); else { g.moveTo(X(i), Y(v)); pen = true; }
    });
    g.stroke(); g.setLineDash([]);
  };
  line(hist.water, '#6aa6c8', []);
  line(hist.waterFc, '#6aa6c8', [3, 2]);

}

export function render(s) {
  const S = s && s.surf;
  const el = document.getElementById('surf');
  if (!el) return;
  if (!S) { el.innerHTML = '<div class=devstrip><span class=devname>Surf</span>' +
    '<span class=devchip><span class=dc-v style="color:#8b96a5">—</span></span></div>'; return; }

  const name = SPOT_LABEL[S.spot] || S.spot;
  const cur = S.current || {};
  const chip = (label, val, col) => '<span class=devchip>' +
    (label ? '<span class=dc-l>' + label + '</span>' : '') +
    '<span class=dc-v style="color:' + (col || '#e6eaf0') + '">' + val + '</span></span>';

  const head =
    '<div class=devstrip>' +
      '<span class=devname>Surf · ' + name + '</span>' +
      chip('', '<span class=dot style="background:' + (cur.ratingColor || '#8b96a5') + '"></span>' +
        (cur.ratingLabel || '—'), '#e6eaf0') +
      chip('Now', ftRange(cur.hMin, cur.hMax), '#e6eaf0') +
      chip('Water', (S.waterTempF != null ? S.waterTempF + '°' : '—'), '#6aa6c8') +
      chip('Air', (cur.airF != null ? cur.airF + '°' : '—'), '#eab308') +
    '</div>';

  // Keys are built from the bands actually present in the window. One that advertises a level the
  // grid does not contain sends you looking for a colour that is not there, and the nearest one you
  // find is a different level.
  const keyRow = (chars, colors, labels) => {
    const present = [...new Set(chars.replace(/\./g, ''))]
      .map((c) => parseInt(c, 36)).sort((a, b) => a - b);
    return present.length
      ? '<div class=surfkey>' + present.map(i =>
          '<span class=sk-i><span class=sk-sw style="background:' + colors[i] + '"></span>' +
          labels[i] + '</span>').join('') + '</div>'
      : '';
  };
  const keys = hist
    ? keyRow(hist.rating, hist.bandColors, hist.bandLabels) +
      keyRow(hist.size, hist.sizeColors, hist.sizeLabels)
    : '';
  // Grids first, then both keys, then water — grids butt together so a column is the same day in
  // each, which leaves nowhere for a key between them.
  const heat = hist
    ? '<div class=surfheat><canvas id=surfgrids></canvas>' +
      '</div>' +
      keys + '<div class=surfwater><canvas id=surfwater></canvas></div>'
    : '';

  el.innerHTML = head + heat;
  loadHistory(S.capturedAt);
  paintGrids(el.querySelector('#surfgrids'));
  paintWater(el.querySelector('#surfwater'));

}
