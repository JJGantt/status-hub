// Surf forecast card — current conditions + 7-day outlook for a spot (Mayport Poles).
// Days render as rows; tapping a row expands an hourly 8a–8p breakdown for that day.
// Data: Pi collector (JJGantt/surf-report) -> surf_snapshots -> server buildSurf().
// Colors come from the server (Surfline's canonical rating palette); this card only paints.
import { state } from '../shared.js';

const SPOT_LABEL = { 'mayport-poles': 'Poles' };
const open = new Set();   // weekdays currently expanded (persists across SSE re-renders)
let bound = false;

// ---- history heatmap -------------------------------------------------------------------------
// /api/surf/history is a string, one char per hour, not an array of rows — see the server comment.
// Fetched once and refetched only when a new snapshot lands (capturedAt moves), because it is ~2KB
// and changes twice a day, while this card re-renders on every 30s broadcast.
const HEAT_DAYS = 90;      // a card is not the place for a year; the PNG in surf-report is
const HEAT_H = 108;
let hist = null, histFor = null, histPending = false;

function loadHistory(capturedAt) {
  if (histPending || histFor === capturedAt) return;
  histPending = true;
  fetch('/api/surf/history')
    .then(r => r.ok ? r.json() : null)
    .then(j => { if (j && j.v) { hist = j; histFor = capturedAt; render(state.last); } })
    .catch(() => {})
    .finally(() => { histPending = false; });
}

// Canvas rather than 2,000 rects: this is a phone surface too, and the grid is pure colour with no
// per-cell interaction to hang off the DOM.
function paintHeat(cv) {
  if (!hist || !cv) return;
  const cols = [], n = hist.v.length;
  const t0 = hist.t0;
  // Column per local day, row per local hour, so the morning band reads as a horizontal stripe.
  const byDay = new Map();
  for (let i = 0; i < n; i++) {
    const d = new Date((t0 + i * 3600) * 1000);
    const key = d.toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
    const hr = +d.toLocaleString('en-US', { hour: 'numeric', hour12: false, timeZone: 'America/New_York' }) % 24;
    if (!byDay.has(key)) { byDay.set(key, new Array(24).fill('.')); cols.push(key); }
    byDay.get(key)[hr] = hist.v[i];
  }
  const days = cols.slice(-HEAT_DAYS);
  const dpr = window.devicePixelRatio || 1;
  const w = cv.clientWidth || 300;
  cv.width = Math.round(w * dpr); cv.height = Math.round(HEAT_H * dpr);
  const g = cv.getContext('2d'); g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, w, HEAT_H);
  const cw = w / days.length, ch = HEAT_H / 24;
  days.forEach((key, x) => {
    const hrs = byDay.get(key);
    for (let h = 0; h < 24; h++) {
      const c = hrs[h];
      g.fillStyle = c === '.' ? '#1a222b' : (hist.colors[+c] || '#1a222b');
      // y inverted: hour 0 at the bottom, matching the PNG.
      g.fillRect(x * cw, HEAT_H - (h + 1) * ch, Math.ceil(cw) + .5, Math.ceil(ch) + .5);
    }
  });
  // 8a and 8p, through the centre of their own row rather than the boundary below it. The axis
  // labels are positioned from this same y, because a label that drifts off its line is worse than
  // no label — it misreads as a different hour.
  g.strokeStyle = 'rgba(255,255,255,.5)'; g.lineWidth = 1;
  for (const h of [8, 20]) {
    const y = HEAT_H - (h + .5) * ch;
    g.beginPath(); g.moveTo(0, y); g.lineTo(w, y); g.stroke();
    const lab = cv.parentElement && cv.parentElement.querySelector('.surfheat-ax [data-h="' + h + '"]');
    if (lab) lab.style.top = (100 * y / HEAT_H).toFixed(2) + '%';
  }
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  const ti = days.indexOf(today);
  if (ti >= 0) {
    g.strokeStyle = '#eb6834'; g.lineWidth = 2;
    const x = (ti + .5) * cw;
    g.beginPath(); g.moveTo(x, 0); g.lineTo(x, HEAT_H); g.stroke();
  }
}

const ftRange = (a, b) =>
  (a == null || b == null) ? '—' : (a === b ? `${a} ft` : `${a}–${b} ft`);

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

  // Built from the ratings actually present, not a fixed list: a hardcoded key left the one all-day
  // Very Poor column unexplained, and would silently omit Good or Epic the first time either shows up.
  const seen = hist ? [...new Set(hist.v.replace(/\./g, ''))].map(Number).sort((a, b) => a - b) : [];
  const key = seen.length
    ? '<div class=surfkey>' + seen.map(i =>
        '<span class=sk-i><span class=sk-sw style="background:' + hist.colors[i] + '"></span>' +
        hist.labels[i] + '</span>').join('') + '</div>'
    : '';
  const heat = '<div class=surfheat><canvas id=surfheatc height=' + HEAT_H + '></canvas>' +
               '<div class=surfheat-ax><span data-h=20>8p</span><span data-h=8>8a</span></div>' +
               '</div>' + key;

  el.innerHTML = head + heat + '<div class=surfdays>' + header + (S.days || []).map(dayRow).join('') + '</div>';
  loadHistory(S.capturedAt);
  paintHeat(el.querySelector('#surfheatc'));

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
