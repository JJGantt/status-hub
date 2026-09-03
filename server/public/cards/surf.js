// Surf forecast card — current conditions + 7-day outlook for a spot (Mayport Poles).
// Days render as rows; tapping a row expands an hourly 8a–8p breakdown for that day.
// Data: Pi collector (JJGantt/surf-report) -> surf_snapshots -> server buildSurf().
// Colors come from the server (Surfline's canonical rating palette); this card only paints.
import { state } from '../shared.js';

const SPOT_LABEL = { 'mayport-poles': 'Poles' };
const open = new Set();   // weekdays currently expanded (persists across SSE re-renders)
let bound = false;

const ftRange = (a, b) =>
  (a == null || b == null) ? '—' : (a === b ? `${a} ft` : `${a}–${b} ft`);

// ---- history grids ----------------------------------------------------------------------------
// /api/surf/history returns strings, one char per hour, not arrays of rows — see the server comment.
// Fetched once and refetched only when a new snapshot lands (capturedAt moves), because it is ~2KB
// and changes twice a day, while this card re-renders on every 30s broadcast.
const GRID_H = 86;         // per grid; both are drawn on one canvas so they sit flush
const DOW_H = 13;          // weekday-letter strip above the grids, same canvas so it stays aligned
const WATER_H = 54;
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
  const cw = w / cols.length, ch = GRID_H / 24;

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
    g.fillText('MTWTFSS'[dow], (x + .5) * cw, DOW_H / 2);
  });
  g.textAlign = 'start'; g.textBaseline = 'alphabetic';

  cols.forEach((k, x) => {
    const c = byDay.get(k);
    for (let h = 0; h < 24; h++) {
      // hour 0 at the bottom of each grid, so the morning band reads as a horizontal stripe
      const y = DOW_H + GRID_H - (h + 1) * ch;
      const rb = c.r[h], sb = c.s[h];
      g.fillStyle = rb === '.' ? '#1a222b' : (hist.bandColors[+rb] || '#1a222b');
      g.fillRect(x * cw, y, Math.ceil(cw) + .5, Math.ceil(ch) + .5);
      g.fillStyle = sb === '.' ? '#1a222b' : (hist.sizeColors[+sb] || '#1a222b');
      g.fillRect(x * cw, GRID_H + y, Math.ceil(cw) + .5, Math.ceil(ch) + .5);
    }
  });

  // 8a and 4p on cell boundaries, so a line coincides with the hour it names rather than floating
  // half a row off it.
  g.strokeStyle = 'rgba(255,255,255,.55)'; g.lineWidth = 1;
  for (const base of [DOW_H, DOW_H + GRID_H]) {
    for (const h of [8, 16]) {
      const y = base + GRID_H - h * ch;
      g.beginPath(); g.moveTo(0, y); g.lineTo(w, y); g.stroke();
      // Label from the same y the line is stroked at, on the rating grid only — a label that
      // drifts off its line misreads as a different hour, and twice over is just clutter.
      if (base === DOW_H) {
        const lab = cv.parentElement &&
                    cv.parentElement.querySelector('.surfheat-ax [data-h="' + h + '"]');
        if (lab) lab.style.top = (100 * y / H).toFixed(2) + '%';
      }
    }
  }
  // Seam between the grids, and today.
  g.strokeStyle = 'rgba(255,255,255,.85)'; g.lineWidth = 1;
  g.beginPath(); g.moveTo(0, DOW_H + GRID_H + .5); g.lineTo(w, DOW_H + GRID_H + .5); g.stroke();
  const ti = cols.indexOf(dayKey(new Date()));
  if (ti >= 0) {
    g.strokeStyle = '#ffffff'; g.lineWidth = 1.5;
    const x = (ti + .5) * cw;
    g.beginPath(); g.moveTo(x, DOW_H); g.lineTo(x, H); g.stroke();
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
  const lo = Math.min(...vals) - 1, hi = Math.max(...vals) + 1;
  const X = (i) => (i / (hist.hours - 1)) * w;
  const Y = (v) => WATER_H - 4 - ((v - lo) / (hi - lo)) * (WATER_H - 12);

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

  g.fillStyle = '#8b96a5'; g.font = '9px system-ui, sans-serif';
  g.fillText(Math.round(hi - 1) + '\u00b0', 2, 10);
  g.fillText(Math.round(lo + 1) + '\u00b0', 2, WATER_H - 3);
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

  const hourRow = (h) =>
    '<div class=surfhr>' +
      '<span class=sh-t>' + h.t + '</span>' +
      '<span class=sh-rt style="color:' + h.ratingColor + '">' + h.ratingLabel + '</span>' +
      '<span class=sh-ft>' + ftRange(h.hMin, h.hMax) + '</span>' +
      '<span class=sh-w>' + (h.wind || '—') + '</span>' +
      '<span class=sh-air>' + (h.airF != null ? h.airF + '°' : '—') + '</span>' +
    '</div>';

  const bucketCell = (b) =>
    '<span class=sr-buck>' +
      (b
        ? '<span class=sr-rt style="color:' + b.ratingColor + '">' + b.ratingLabel + '</span>' +
          '<span class=sr-ft>' + ftRange(b.hMin, b.hMax) + '</span>'
        : '<span class=sr-rt style="color:#8b96a5">—</span>') +
    '</span>';

  const dayRow = (d) => {
    const isOpen = open.has(d.weekday);
    const row =
      '<div class="surfrow' + (isOpen ? ' open' : '') + '" data-day="' + d.weekday + '">' +
        '<span class=sr-x>' + (isOpen ? '▾' : '▸') + '</span>' +
        '<span class=sr-wd>' + d.weekday + '</span>' +
        bucketCell(d.midday) +
        bucketCell(d.late) +
      '</div>';
    if (!isOpen) return row;
    const hours = (d.hours && d.hours.length)
      ? '<div class=surfhr-head><span>Time</span><span>Cond</span><span>Surf</span><span>Wind</span><span>Air</span></div>'
        + d.hours.map(hourRow).join('')
      : '<div class=surfhr-empty>No daytime hours</div>';
    return row + '<div class=surfhours>' + hours + '</div>';
  };

  const header =
    '<div class=surfhead>' +
      '<span></span><span></span>' +
      '<span class=sh-col>10a–2p</span>' +
      '<span class=sh-col>4–7p</span>' +
    '</div>';

  // Keys are built from the bands actually present in the window. One that advertises a level the
  // grid does not contain sends you looking for a colour that is not there, and the nearest one you
  // find is a different level.
  const keyRow = (chars, colors, labels) => {
    const present = [...new Set(chars.replace(/\./g, ''))].map(Number).sort((a, b) => a - b);
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
      '<div class=surfheat-ax><span data-h=16>4p</span><span data-h=8>8a</span></div></div>' +
      keys + '<div class=surfwater><canvas id=surfwater></canvas></div>'
    : '';

  el.innerHTML = head + heat + '<div class=surfdays>' + header + (S.days || []).map(dayRow).join('') + '</div>';
  loadHistory(S.capturedAt);
  paintGrids(el.querySelector('#surfgrids'));
  paintWater(el.querySelector('#surfwater'));

  if (!bound) {
    bound = true;
    el.addEventListener('click', (e) => {
      const row = e.target.closest('.surfrow');
      if (!row || !el.contains(row)) return;
      const day = row.dataset.day;
      if (open.has(day)) open.delete(day); else open.add(day);
      render(state.last);   // re-paint from the latest payload with new expand state
    });
  }
}
