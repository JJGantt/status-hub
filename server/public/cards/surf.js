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
// Refetched when a new snapshot lands (capturedAt moves) or when the copy ages out, never on the
// 30s broadcast that re-renders this card: the whole archive is one response, and redrawing grids
// does not require re-reading them.
const GRID_H = 86;         // per grid; both are drawn on one canvas so they sit flush
const DOW_H = 13;          // weekday-letter strip above the grids, same canvas so it stays aligned
const WATER_H = 68;
const PAD_L = 26;          // left gutter for axis labels, so nothing is written over the data

// The plots hold the whole archive and scroll horizontally; the card lands at the right-hand end,
// showing the window the server marks with `defaultT0`. The gutter is its own canvas OUTSIDE the
// scroller, so the hour and temperature labels stay put while the data slides under them — the
// reason the plot canvases have no left padding of their own.
//
// Held as a distance from the RIGHT edge, not the left, and it survives the re-render on every 30s
// broadcast (this card rebuilds its innerHTML) — a reader mid-scroll would otherwise be thrown back
// to today twice a minute. Measuring from the right also means 0 keeps following today as the
// forecast extends, where a remembered scrollLeft would slide off the end.
let scrollEnd = 0;
let hist = null, histFor = null, histPending = false, histAt = 0;

// `capturedAt` alone is not enough to decide the copy is current. It moves with the Surfline
// capture, every 3h, but the water trace is a half-hourly buoy reading that advances independently
// — so a card left open all day held a water series hours behind a source that had moved many
// times. The age check is what picks those up; it matches the server's own cache floor, so a
// refetch inside the window is answered from memory rather than costing a rebuild.
const HIST_MAX_AGE_MS = 15 * 60 * 1000;

function loadHistory(capturedAt) {
  if (histPending) return;
  if (hist && histFor === capturedAt && Date.now() - histAt < HIST_MAX_AGE_MS) return;
  histPending = true;
  fetch('/api/surf/history')
    .then(r => r.ok ? r.json() : null)
    .then(j => { if (j && j.hours) { hist = j; histFor = capturedAt; histAt = Date.now(); render(state.last); } })
    .catch(() => {})
    .finally(() => { histPending = false; });
}

// ONE formatter each, built once. toLocaleDateString/toLocaleString with an options object build a
// fresh Intl.DateTimeFormat on every call, and grid() calls these for each of 2160 hours of history —
// which cost a second of frozen main thread on a phone, during which nothing paints and no touch is
// delivered. Reusing the instances is the same output (verified hour by hour across DST in both
// directions) for a twenty-fifth of the time.
const DAY_FMT = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' });
const HOUR_FMT = new Intl.DateTimeFormat('en-US', { hour: 'numeric', hour12: false, timeZone: 'America/New_York' });
const dayKey = (d) => DAY_FMT.format(d);
const hourOf = (d) => +HOUR_FMT.format(d) % 24;

// Bucket the hourly strings into day columns x hour rows, in local time. Held against the history
// object it was built from: layout() runs once per plot and there are two of them, so without this
// the whole 2160-hour walk happens twice for a result that cannot have changed in between.
let gridCache = null, gridFor = null;
function grid() {
  if (gridCache && gridFor === hist) return gridCache;
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
  gridFor = hist; gridCache = { cols, byDay };
  return gridCache;
}

// Day columns and the pixel geometry the two plots share. The column width is chosen so the
// default window exactly fills the visible strip — everything older is off to the left, reachable
// only by scrolling, and the card looks unchanged until someone does.
function layout(viewW) {
  const { cols, byDay } = grid();
  const dT0 = hist.defaultT0 == null ? hist.t0 : hist.defaultT0;
  const di = Math.max(0, cols.indexOf(dayKey(new Date(dT0 * 1000))));
  const cw = viewW / Math.max(1, cols.length - di);
  return { cols, byDay, cw, totalW: cw * cols.length };
}

// Backing store at device resolution, CSS box at the size asked for. The archive only grows, so the
// plot canvas only gets wider; capping the total device width trades sharpness for a canvas that
// still draws, rather than one the browser refuses to allocate and leaves blank.
function fitCanvas(cv, w, h) {
  const dpr = Math.min(window.devicePixelRatio || 1, 16384 / Math.max(1, w));
  cv.style.width = w + 'px'; cv.style.height = h + 'px';
  cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr);
  const g = cv.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, w, h);
  return g;
}

// A wall is read from a couch. Anything a reader can get from POSITION alone is not worth the pixels
// at that distance — the weekday letters over the columns and the 8a/4p labels beside them both go,
// while the guide lines they named stay, because the line is the thing that was doing the work. What
// keeps its labels is the one axis no colour or placement can carry: the water temperature.
const onWall = () => document.body.classList.contains('tv');

// Canvas rather than ~1,300 rects: this is a phone surface and the grids are pure colour with no
// per-cell interaction to hang off the DOM. `cv` scrolls inside its box; `ax` is the gutter canvas
// pinned beside it, so the hour labels stay readable however far back the data is dragged.
function paintGrids(cv, ax, viewW) {
  if (!hist || !cv) return;
  const wall = onWall();
  const dowH = wall ? 0 : DOW_H;
  const { cols, byDay, cw, totalW } = layout(viewW);
  const H = dowH + GRID_H * 2, ch = GRID_H / 24;
  const g = fitCanvas(cv, totalW, H);

  // Weekday letter over each column, on the same canvas as the grids so it cannot drift out of
  // alignment with them the way a separately-laid-out HTML row could.
  if (!wall) {
    g.font = '9px system-ui, -apple-system, sans-serif';
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillStyle = '#8b96a5';
    const skip = cw < 9 ? Math.ceil(9 / cw) : 1;    // thin columns get every Nth letter, not a smear
    cols.forEach((k, x) => {
      if (x % skip) return;
      // Midday avoids the key being shifted a day by a DST-edge parse; +6 %7 turns Sun-first into
      // Mon-first so the string reads MTWTFSS.
      const dow = (new Date(k + 'T12:00:00').getDay() + 6) % 7;
      g.fillText('MTWTFSS'[dow], (x + .5) * cw, DOW_H / 2);
    });
    g.textAlign = 'start'; g.textBaseline = 'alphabetic';
  }

  cols.forEach((k, x) => {
    const c = byDay.get(k);
    for (let h = 0; h < 24; h++) {
      // hour 0 at the bottom of each grid, so the morning band reads as a horizontal stripe
      const y = dowH + GRID_H - (h + 1) * ch;
      const rb = c.r[h], sb = c.s[h];
      g.fillStyle = rb === '.' ? '#1a222b' : (hist.bandColors[parseInt(rb, 36)] || '#1a222b');
      g.fillRect(x * cw, y, Math.ceil(cw) + .5, Math.ceil(ch) + .5);
      g.fillStyle = sb === '.' ? '#1a222b' : (hist.sizeColors[parseInt(sb, 36)] || '#1a222b');
      g.fillRect(x * cw, GRID_H + y, Math.ceil(cw) + .5, Math.ceil(ch) + .5);
    }
  });

  // 8a and 4p on cell boundaries, so a line coincides with the hour it names rather than floating
  // half a row off it. Guides on both grids; their labels live on the gutter canvas.
  for (const base of [dowH, dowH + GRID_H]) {
    for (const h of [8, 16]) {
      const y = base + GRID_H - h * ch;
      g.strokeStyle = 'rgba(255,255,255,.55)'; g.lineWidth = 1;
      g.beginPath(); g.moveTo(0, y); g.lineTo(totalW, y); g.stroke();
    }
  }
  // Seam between the grids, and today.
  g.strokeStyle = 'rgba(255,255,255,.85)'; g.lineWidth = 1;
  g.beginPath(); g.moveTo(0, dowH + GRID_H + .5); g.lineTo(totalW, dowH + GRID_H + .5); g.stroke();

  // WEEK SEPARATORS. The columns are days, and past the width of a couple of weeks nothing says
  // where one week ends — the weekday letters are the phone's, and the wall drops them. A black
  // line at each Saturday -> Sunday boundary cuts the window into weeks, which is what makes a
  // column countable: the eye lands on a week and counts days inside it rather than counting cells
  // from the now-line. Weeks break on Sunday, the same alignment server.js builds the nutrition and
  // workout week columns on, so a separator lines up with a column edge in the maps above it.
  // BLACK and 1px. Black is the one ink that reads on every colour either grid uses — white was
  // tried and vanishes against the pale blue size grid below the seam, which is also already a
  // white line. 1px is enough at that contrast; heavier starts taking cells off the picture.
  // The grids only, not the water trace under them: the now-line continues down there because it is
  // one mark on one timeline, where seven separators would be clutter over a sparse trace.
  g.strokeStyle = '#000'; g.lineWidth = 1;
  cols.forEach((k, x) => {
    if (new Date(k + 'T12:00:00').getDay()) return;   // 0 = Sunday, the column a week opens on
    g.beginPath(); g.moveTo(x * cw, dowH); g.lineTo(x * cw, H); g.stroke();
  });
  const now = new Date();
  const ti = cols.indexOf(dayKey(now));
  if (ti >= 0) {
    g.strokeStyle = '#ffffff'; g.lineWidth = 1.5;
    const x = (ti + .5) * cw;
    g.beginPath(); g.moveTo(x, dowH); g.lineTo(x, H); g.stroke();
    // Crossbar at the current time. y runs from midnight at the grid's floor upward, the same
    // mapping the 8a/4p guides use, so hour + minutes lands on the instant rather than the cell.
    const hNow = hourOf(now) + now.getMinutes() / 60;
    g.lineWidth = 2;
    for (const base of [dowH, dowH + GRID_H]) {
      const y = base + GRID_H - hNow * ch;
      g.beginPath(); g.moveTo(x - cw * .45, y); g.lineTo(x + cw * .45, y); g.stroke();
    }
  }
  // A WEEK OUT, dashed. Dropping the weekday letters took with them the one thing they were good
  // for — working out which column is which day — so this puts it back with a single mark instead
  // of one per column: today is solid, seven days on is dashed, and every other day is counted off
  // between them. Dashed rather than solid because it names a DATE and the solid line names now;
  // two marks that mean different things must not be drawn the same.
  const wi = wall ? cols.indexOf(dayKey(new Date(Date.now() + 7 * 86400000))) : -1;
  if (wi >= 0) {
    g.strokeStyle = '#ffffff'; g.lineWidth = 1.5; g.setLineDash([4, 4]);
    const x = (wi + .5) * cw;
    g.beginPath(); g.moveTo(x, dowH); g.lineTo(x, H); g.stroke();
    g.setLineDash([]);
  }

  // The gutter is still SIZED on a wall even though nothing is written in it: the water plot below
  // has one for its temperatures, and the two are one timeline — a grid inset by a different amount
  // than the trace under it puts a vertical read on two different hours.
  if (!ax) return;
  const a = fitCanvas(ax, PAD_L, H);
  if (wall) return;
  a.font = '9px system-ui, -apple-system, sans-serif';
  a.textBaseline = 'middle'; a.textAlign = 'right'; a.fillStyle = '#8b96a5';
  for (const base of [DOW_H, DOW_H + GRID_H])
    for (const [h, txt] of [[8, '8a'], [16, '4p']])
      a.fillText(txt, PAD_L - 5, base + GRID_H - h * ch);
}

// Water: measured up to now, forecast beyond it. Two series, because a prediction and a reading are
// different claims and must not be drawn as one line. Same width and same scroll offset as the
// grids above, so a vertical read through both lands on one hour.
function paintWater(cv, ax, viewW) {
  if (!hist || !cv) return;
  const { cols, cw, totalW } = layout(viewW);
  const g = fitCanvas(cv, totalW, WATER_H);
  const vals = hist.water.concat(hist.waterFc).filter(v => v != null);
  if (!vals.length) return;
  const lo = Math.floor(Math.min(...vals)) - 1, hi = Math.ceil(Math.max(...vals)) + 1;
  const X = (i) => (i / (hist.hours - 1)) * totalW;
  const Y = (v) => WATER_H - 6 - ((v - lo) / (hi - lo)) * (WATER_H - 14);

  // Horizontal grid labelled in the gutter. Without it the trace has shape but no scale: a reader
  // can see it rising and cannot say what it is rising to.
  //
  // The step widens until the labels have room. At 2F a ten-degree range puts six labels in 60px
  // and they collide, which is worse than a coarser grid.
  let step = 2;
  while ((hi - lo) / step > 4) step += 2;
  for (let v = Math.ceil(lo / step) * step; v <= hi; v += step) {
    const y = Y(v);
    g.strokeStyle = 'rgba(255,255,255,.10)'; g.lineWidth = 1;
    g.beginPath(); g.moveTo(0, y); g.lineTo(totalW, y); g.stroke();
  }

  // The same white marker the grids above carry, continued down through the trace — the two are one
  // timeline, so the eye should be able to drop straight from today's column onto the temperature at
  // it. Drawn BEFORE the series: it is a reference, and a reading it covers is a reading lost.
  const ti = cols.indexOf(dayKey(new Date()));
  if (ti >= 0) {
    g.strokeStyle = '#ffffff'; g.lineWidth = 1.5;
    const x = (ti + .5) * cw;
    g.beginPath(); g.moveTo(x, 0); g.lineTo(x, WATER_H); g.stroke();
  }
  // Both marks continue down here, for the same reason the solid one does: this is one timeline.
  const wi = onWall() ? cols.indexOf(dayKey(new Date(Date.now() + 7 * 86400000))) : -1;
  if (wi >= 0) {
    g.strokeStyle = '#ffffff'; g.lineWidth = 1.5; g.setLineDash([4, 4]);
    const x = (wi + .5) * cw;
    g.beginPath(); g.moveTo(x, 0); g.lineTo(x, WATER_H); g.stroke();
    g.setLineDash([]);
  }

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

  if (!ax) return;
  const a = fitCanvas(ax, PAD_L, WATER_H);
  a.font = '9px system-ui, -apple-system, sans-serif';
  a.textBaseline = 'middle'; a.textAlign = 'right'; a.fillStyle = '#8b96a5';
  for (let v = Math.ceil(lo / step) * step; v <= hi; v += step)
    a.fillText(v + '\u00b0', PAD_L - 5, Y(v));
}

// The grids and the water trace are one timeline, so dragging either moves the other. Mirroring
// only when the value differs is what stops the two boxes driving each other in a loop.
function syncScroll(el) {
  const boxes = [...el.querySelectorAll('.surfscroll')];
  if (!boxes.length) return;
  const max = Math.max(0, boxes[0].scrollWidth - boxes[0].clientWidth);
  const at = Math.max(0, max - scrollEnd);
  for (const b of boxes) {
    b.scrollLeft = at;
    b.addEventListener('scroll', () => {
      scrollEnd = Math.max(0, b.scrollWidth - b.clientWidth - b.scrollLeft);
      const x = b.scrollLeft;
      for (const o of boxes) if (o !== b && o.scrollLeft !== x) o.scrollLeft = x;
    }, { passive: true });
  }
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
      chip('', ftRange(cur.hMin, cur.hMax), '#e6eaf0') +
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
  // each, which leaves nowhere for a key between them. Each plot is a gutter canvas beside a
  // scrolling box, not one canvas: see paintGrids.
  const heat = hist
    ? '<div class=surfheat><canvas class=surfax id=surfgridax></canvas>' +
      '<div class=surfscroll><canvas id=surfgrids></canvas></div></div>' +
      keys +
      '<div class=surfwater><canvas class=surfax id=surfwaterax></canvas>' +
      '<div class=surfscroll><canvas id=surfwater></canvas></div></div>'
    : '';

  el.innerHTML = head + heat;
  loadHistory(S.capturedAt);
  // Width the gutters first. A canvas with no CSS width is 300px wide, and both plots are flex rows
  // whose scrolling half is whatever the gutter leaves — measure before that and every strip gets a
  // different width, which puts the two timelines out of step with each other.
  for (const ax of el.querySelectorAll('.surfax')) ax.style.width = PAD_L + 'px';
  const box = el.querySelector('.surfscroll');
  const viewW = box ? box.clientWidth : 0;
  // Zero means the card is hidden — the kiosk drops surf from its top strip. Painting it anyway
  // costs the Pi ~4,000 fills every broadcast for something nobody can see, at a made-up width.
  if (!viewW) return;
  paintGrids(el.querySelector('#surfgrids'), el.querySelector('#surfgridax'), viewW);
  paintWater(el.querySelector('#surfwater'), el.querySelector('#surfwaterax'), viewW);
  syncScroll(el);

}
