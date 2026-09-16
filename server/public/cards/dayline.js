// The day column — today's dated items laid onto hour rows, with a line where the clock is.
//
// ONE implementation for every surface that shows it: the calendar wall beside its month grid, the
// home wall's middle column, and the phone's lists pane. They differ in size (CSS) and in which
// endpoint feeds them, never in markup. There were two copies of this and they were already
// drifting — different class names for the same chip, two clocks, two reload rules.
//
// The server ships finished geometry — which hours exist, which half-hour line an item sits on, how
// many chips fit, the now-line's percentage, chip colours and scores — so this file only paints.
import { esc, liveStream } from '../shared.js';

// Every mounted column: { el, url, centre, onload, dl, next }. Small by nature — at most one per
// surface on screen — so a list is the right shape and the tick can just walk it.
const columns = [];

// No repeat glyph, and no time unless the surface asks: on the day column the line a chip sits on
// already says the time, and several chips share that line's width. Both were spending room the
// chips need more.
function chip(it, withTime) {
  const cls = 'cw-dchip' + (it.exempt ? ' exempt' : '') +
    (it.done ? ' done' : it.expired ? ' exp' : it.grace ? ' grace' : it.past ? ' past' : '');
  // The server decides both the number and which kind it is; this only paints it.
  const sc = it.score ? `<span class="cw-sc k-${esc(it.score_kind)} ${esc(it.score_sign)}">${esc(it.score)}</span>` : '';
  // Important carries the same amber ! the lists pane uses; exempt goes hollow, because it is
  // not a thing to do — it is a thing that is simply on the schedule.
  const imp = it.priority > 0 ? '<span class="cw-imp">!</span>' : '';
  // The look-ahead asks for the time ON the chip: its box is a whole day, so nothing else there says
  // when. The day column never does — the hour row a chip sits on already said it, and repeating it
  // spends the width the title needs.
  const tm = withTime && it.time ? `<span class="cw-t">${esc(it.time)}</span>` : '';
  return `<span class="${cls}" style="--c:${esc(it.color)}">${imp}${tm}<span class="cw-l">${esc(it.title)}</span>${sc}</span>`;
}

// One half-hour line. The second is reserved for :30-:59, so a 4:30 item sits on the lower line even
// when 4:00 is empty — that placement is the only thing saying which half of the hour it is in. The
// server decides how many chips fit and hands back the rest as a count, so a hidden item is still
// visible AS hidden rather than silently dropped.
function halfLine(half) {
  const more = half.more ? `<span class="cw-more">+${half.more}</span>` : '';
  return `<div class="cw-half">${half.items.map((it) => chip(it)).join('')}${more}</div>`;
}

// Chips per line — what the CSS lays out side by side, and the same number the server caps a half at.
const PER_LINE = 2;

// An hour's items: its two half-lines, or ONE merged line carrying both halves' chips side by side.
//
// Merging throws away the :00 / :30 distinction, which the two lines exist to carry — but only the
// dial ever asks for it, and only where two lines would each be too short to hold a word. There the
// choice is not between "when" and "what", it is between one chip that says both and two bars that
// say neither. Anything past the line's width becomes the +N, counting the halves' own overflow too.
function hourItems(hr, merged) {
  if (!merged) return hr.halves.map(halfLine).join('');
  const all = hr.halves.flatMap((x) => x.items);
  const more = hr.halves.reduce((n, x) => n + x.more, 0) + Math.max(0, all.length - PER_LINE);
  // The second line stays, empty. It is what the floor in tv-home.css takes its room from, so the
  // merged chip lands at exactly the height a lone item's does — drop it and the chip stretches the
  // whole row, which puts FATTER chips further from now than at the axis and reads backwards.
  return halfLine({ items: all.slice(0, PER_LINE), more }) + '<div class="cw-half"></div>';
}

export function dayHtml(dl) {
  const allday = dl.allday.length
    ? `<div class="cw-allday">${dl.allday.map((it) => chip(it)).join('')}</div>` : '';
  const hours = dl.hours.map((h) => {
    const now = h.now !== null ? `<div class="cw-now" style="top:${h.now}%"></div>` : '';
    return `<div class="cw-hour${h.now !== null ? ' cur' : ''}">` +
      `<span class="cw-hl">${esc(h.label)}</span>` +
      `<div class="cw-hitems">${hourItems(h, false)}</div>${now}</div>`;
  }).join('');
  // The date and the all-day strip are one block, so a surface that lifts them off the hours (the
  // dial, which also stacks its overdue rows on top) moves them together. Everywhere else the block
  // is `display: contents` and lays out exactly as its two children would.
  return `<div class="cw-top"><div class="cw-dayhead">${esc(dl.label)}</div>${allday}</div>` +
    `<div class="cw-hours">${hours}</div>`;
}

// ONE DAY OF THE LOOK-AHEAD — which day it is, then what is on it. A list, not a timeline: at a
// day's remove the useful fact is what is on the day, and hour rows for a day nobody is living in
// yet would spend the whole box drawing empty hours.
function aheadDay(d) {
  // The +N goes in the HEADER, not under the chips. It is a fact about the day rather than a fourth
  // item, the header has the width spare, and a box sized for exactly three chips has no room for a
  // line under them — put it there and it is simply clipped, which is a hidden item hidden twice.
  const more = d.more ? `<span class="cw-more">+${d.more}</span>` : '';
  // The month rides with the number only where the server says it does — the day it resets.
  const mo = d.month ? `<span class="cw-wmo">${esc(d.month)}</span>` : '';
  // The grid is the server's: rows and columns are geometry, and the chips size themselves off the
  // row count, so this is the one number the box's whole appearance turns on.
  // `data-cols` as well as the custom property: CSS can lay the grid out from `--cols`, but it
  // cannot BRANCH on one, and a second column needs a rule of its own — its chips are limited by
  // their width, not by the row height the font is otherwise derived from.
  return `<div class="cw-wday" data-cols="${d.cols || 1}" ` +
    `style="--rows:${d.rows || 4};--cols:${d.cols || 1}">` +
    `<div class="cw-wh"><span class="cw-wdow">${esc(d.dow)}</span>` +
      `<span class="cw-wnum">${d.day}</span>${mo}${more}</div>` +
    `<div class="cw-witems">${d.items.map((it) => chip(it, true)).join('')}</div>` +
  '</div>';
}

export function aheadHtml(days) { return (days || []).map(aheadDay).join(''); }

/**
 * Mount a day column on an element and keep it live.
 *
 * `url` is whichever calendar view this surface needs — `?day=1` for a column on its own, `?wall=1`
 * where the same payload also carries the months. `onload` hands that whole payload back, so a page
 * wanting more out of the response gets it without a second fetch.
 *
 * `ahead` is a second element for the look-ahead days, painted from the SAME response and by the
 * same reload — the two columns are one answer to one question, and a look-ahead fetching on its own
 * is two clocks and two chances to be showing different days at the same moment.
 */
export function mount(el, { url = '/api/calendar?day=1', centre = false, onload = null, dial = false,
                            ahead = null, dock = false } = {}) {
  if (!el) return;
  const col = { el, url, centre, onload, dial, ahead, dock, dl: null, next: null, today: null, overdue: null };
  columns.push(col);
  if (dial) {
    el.classList.add('dial');
    // The projection is a function of the container's height, so it has to be recomputed when that
    // changes. Nothing else here cares about resize: equal rows in a flex column handle it alone.
    window.addEventListener('resize', () => project(col));
  }
  load(col);
}

/**
 * Lay the hours out as a DIAL — the day printed on a drum turning behind the glass, seen edge-on.
 *
 * This is the actual projection rather than a shrinking effect made to look like one. Put the drum's
 * axis at the middle of the column and let one hour subtend a fixed angle: an hour `d` hours from now
 * sits at angle θ = (d / SPAN)·90°, its position is R·sin θ and its apparent height is what is left
 * between its own two edges. Two things fall out of that for free, which is why it is worth doing
 * properly:
 *
 *   · NOW IS ALWAYS THE CENTRE. sin 0 = 0, so the current moment lands on the axis by construction —
 *     there is no offset to compute and nothing to keep in sync as the clock moves.
 *   · THE ROWS ALWAYS FILL THE COLUMN EXACTLY. The edges are ±90°, sin of which is ±1, so the first
 *     and last hour land on the top and bottom of the box however many hours are in between.
 *
 * Everything shrinks continuously toward both edges; nothing is a plateau. The hour numbers scale
 * and fade with cos θ, which is the same foreshortening a real drum would show and is what makes it
 * read as turning rather than as a list with small ends.
 */
const SPAN = 12;                 // hours from the centre to the edge of the drum — a whole day across
// The shortest chip that can still hold a word: 10px of text on 1.2 lines inside 4px of the chip's
// own padding. Below it the row flattens to bars. The height a chip WANTS is not here — it is
// `--chip-full` in tv-home.css, read back below, because the CSS floors on it too and one number
// with two definitions is one number that drifts.
const CHIP_MIN = 17;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

function project(col) {
  if (!col.dial || !col.dl) return;
  const box = col.el.querySelector('.cw-hours');
  const rows = box ? box.querySelectorAll('.cw-hour') : null;
  if (!box || !rows || !rows.length) return;
  const H = box.clientHeight;
  if (!H) return;
  const R = H / 2;
  const now = new Date();
  const nowT = now.getHours() + now.getMinutes() / 60;
  const angle = (t) => clamp((t - nowT) / SPAN, -1, 1) * (Math.PI / 2);
  const y = (t) => R + R * Math.sin(angle(t));

  // THE AXIS IS A PROPERTY OF THE COLUMN, not of an hour. It never moves; the day moves past it. The
  // server's marker is a child of the hour it falls in, which is right for a list and wrong here —
  // as that hour slides upward the marker goes with it, out of the row's overflow and out of sight.
  // That is how the line disappeared a few minutes into every hour.
  let axis = box.querySelector(':scope > .cw-now');
  if (!axis) {
    // The shared markup's in-row marker is removed rather than hidden. Left in place it is a second
    // element answering to `.cw-now` on this surface, and the first one in document order at that —
    // which is what anything measuring the line finds.
    box.querySelectorAll('.cw-hour .cw-now').forEach((el) => el.remove());
    axis = document.createElement('div'); axis.className = 'cw-now'; box.appendChild(axis);
  }
  axis.style.top = `${R}px`;

  col.dl.hours.forEach((hr, i) => {
    const row = rows[i];
    if (!row) return;
    // `t`, not `h`: the window crosses midnight, so the same hour number appears at both ends and
    // only the timeline position can be angled off. It falls back to `h` for a plain day.
    const at = hr.t === undefined ? hr.h : hr.t;
    const top = y(at), bottom = y(at + 1);
    const h = Math.max(0, bottom - top);
    row.style.height = `${h}px`;
    // Foreshortening, from the middle of the hour — the face of the drum turning away from you.
    const face = Math.cos(angle(at + 0.5));
    row.style.setProperty('--face', face.toFixed(3));
    // Below a readable hour number there is no room for one, and the row becomes a band of colour.
    // Said in classes so the CSS decides what survives at each size, not this file.
    row.classList.toggle('sliver', h < 15);
    // Which hour is the current one is worked out here every tick, not taken from the payload. The
    // server decides it once, at fetch time, and the dial only re-fetches when the hour rolls — so
    // between those it was lighting whichever hour happened to be current when it last loaded.
    row.classList.toggle('cur', nowT >= at && nowT < at + 1);
  });

  // WHETHER WORDS FIT IS A PROPERTY OF THE CHIP, NOT OF THE ROW. An hour is two half-lines however
  // little is in it, and once the row is tight an occupied half keeps a chip's worth of height at
  // the empty one's expense (the floor is in tv-home.css) — so a lone item stays legible about twice
  // as far from now as a busy hour's do. A single row-height threshold could not tell those apart
  // and flattened both at the same distance: 4pm went wordless from 12:30 onward, its empty :30 line
  // spending half the row saying nothing.
  //
  // The height is READ BACK from the layout rather than recomputed from the CSS's paddings and gaps,
  // which is why this is a second pass over the same rows — pass one has to have been applied first.
  // Nothing here feeds back into it: a half's height comes from the row, not from what is in it.
  // Read once, not per row: both are the same for every hour in the column.
  const gap = parseFloat(getComputedStyle(box.querySelector('.cw-hitems') || box).rowGap) || 0;
  const chipFull = parseFloat(getComputedStyle(col.el).getPropertyValue('--chip-full')) || 0;

  rows.forEach((row, i) => {
    const hr = col.dl.hours[i];
    const box2 = row.querySelector('.cw-hitems');
    if (!hr || !box2) return;

    // TWO SHORT LINES ARE WORSE THAN ONE. An hour with something in BOTH halves cannot borrow from a
    // neighbour the way a lone item can — the halves simply split the row — so once the row is short
    // enough they both shrink under a full chip, and further out the hour goes wordless with items
    // sitting in it. Below that point the two lines become one and the chips sit side by side,
    // exactly as two items in the same half already do; anything past the line's width rides along
    // as the +N, the halves' own overflow counted in.
    //
    // The threshold is the SAME one the CSS floors an occupied half at, and deliberately so: an hour
    // splits its row while both halves can hold a full chip, and stops when they cannot. Above it
    // nothing changes and the line a chip sits on still says which half of the hour it is in; below
    // it that placement is what gets spent, because a chip that says WHAT beats two that say only
    // WHEN. Cheaper than it sounds at the crossover — the merged chip is the same size the split
    // ones just were, so what changes there is the number of lines, not the look of a chip.
    //
    // Every input is invariant to the outcome — the box's height comes from the row, the gap and the
    // floor from the stylesheet — so the decision cannot oscillate with what it last drew, which
    // measuring the halves themselves would.
    const merged = hr.halves.every((x) => x.items.length) && (box2.clientHeight - gap) / 2 < chipFull;
    if (merged !== (row.dataset.merged === '1')) {
      box2.innerHTML = hourItems(hr, merged);
      row.dataset.merged = merged ? '1' : '0';
    }

    const half = row.querySelector('.cw-half:not(:empty)');
    const ch = half ? half.clientHeight : 0;
    row.style.setProperty('--chiph', `${ch}px`);
    row.classList.toggle('thin', ch < CHIP_MIN);
  });
  paintEdges(col);   // which items are already legible is exactly what was just decided
}

// THE TWO EDGES — what the dial holds because it cannot show it. The dial is a rolling window
// centred on now and it foreshortens hard, so being INSIDE the window is not the same as being
// readable: at half past midnight a noon item sat on a one-pixel row. Membership at both edges is
// therefore decided here rather than on the server — `.thin` is a measured outcome of the
// projection, and only this pass knows it.
//
//   THE DOCK, at the bottom: today's items still to come, held until the drum turns far enough for
//   their row to carry words — and today's all-day items, which no row will ever carry. Their
//   deadline is the end of the day, the far end of what is still to come, so they sit under the
//   timed ones.
//   OVERDUE, at the top: items that went red and are still sitting there, held once their row has
//   receded past words or out of the window altogether — or was never in it, for anything overdue
//   from an earlier day. Its rows sit ABOVE the date, not under it: the date heads the day, and an
//   item from Tuesday stacked below "Wed" would claim to be Wednesday's.
//
// Both COVER the dial rather than shortening it, so the axis stays the middle of the column. What
// they cover is the rim, where the rows are slivers — but not only slivers once they grow, and a row
// under a cover is not legible however tall it is. So covering counts: an item whose row sits under
// either one joins it. That makes membership depend on the covers' heights, which depend on
// membership, so it is iterated — from empty, and each pass can only add, so it settles, and always
// on the same answer for the same geometry rather than on whatever was drawn last minute.
function paintEdges(col) {
  if (!col.dl || (!col.dock && !col.overdue)) return;
  const rows = [...col.el.querySelectorAll('.cw-hour')];
  const hours = col.dl.hours || [];
  const box = col.el.querySelector('.cw-hours');
  const H = box ? box.clientHeight : 0;

  // A past item is not waiting for anything. For an all-day item "past" is the end of its day, and by
  // then it is either done or in `overdue`.
  const upcoming = col.dock && col.today && col.today.items ? col.today.items.filter((it) => !it.past) : [];
  const timed = upcoming.filter((it) => it.time), allday = upcoming.filter((it) => !it.time);
  const overdue = col.overdue || [];

  // A full chip: what a lone item gets on any row with room for words, since an occupied half floors
  // at it (tv-home.css).
  const chipFull = parseFloat(getComputedStyle(col.el).getPropertyValue('--chip-full')) || CHIP_MIN;
  // A dock row lands at the height of the dial's last row that can still hold words, so an item is
  // already where it is going to be when the drum reaches it. That height is measured off a chip
  // actually sitting there; with none on any readable row — an empty day, or before the first
  // projection — it is the full chip a lone item would get. Falling back to CHIP_MIN drew the dock at
  // the smallest size that still holds a word, 10px text, on exactly the days it was all there was.
  let dkRow = 0;
  for (const r of rows) {
    if (r.classList.contains('thin')) continue;
    const ch = parseFloat(r.style.getPropertyValue('--chiph'));
    if (ch) dkRow = ch;
  }
  dkRow = dkRow || chipFull;
  // An overdue row is a full chip. It has no row it is about to become, and it is something costing
  // him right now, so it is drawn at the size a chip wants rather than the smallest that still reads.
  const ovRow = chipFull;
  const top = col.el.querySelector('.cw-top');

  // Each pass paints what is held so far and MEASURES the covers that produces, so their borders,
  // the wrapping all-day strip and whatever else CSS adds are counted exactly rather than estimated.
  // The first pass paints nothing held, which is what makes the answer independent of last minute's.
  // It all happens inside one task, so no intermediate state is ever on screen.
  let held = { ov: [], dk: [] };
  for (;;) {
    paintDock(col, held.dk, dkRow);
    paintOverdue(col, held.ov, ovRow);
    const dockEl = col.el.querySelector('.cw-dock');
    const topEdge = top ? top.offsetHeight : 0;
    const botEdge = H - (dockEl ? dockEl.offsetHeight : 0);
    // Rows and payload hours are the same list in the same order, so the ids line up without
    // matching on anything. A pixel of slack either way: the heights are fractional and offsets are
    // not, and a row that merely touches a cover is not under it.
    //
    // A covered row is blanked as well as discounted. The cover is opaque, but it ends wherever it
    // ends, and that is usually partway down a row — half an hour number or the bottom of a chip
    // left showing under it reads as a broken wall, not as a row that is out of sight.
    const legible = new Set();
    hours.forEach((hr, i) => {
      const r = rows[i];
      if (!r) return;
      // Before the column has a height nothing has been laid out, and every row would read as covered.
      const covered = H > 0 && (r.offsetTop < topEdge - 1 || r.offsetTop + r.offsetHeight > botEdge + 1);
      r.classList.toggle('covered', covered);
      if (covered || r.classList.contains('thin')) return;
      (hr.halves || []).forEach((h) => (h.items || []).forEach((it) => legible.add(it.id)));
    });
    const next = { ov: overdue.filter((it) => !legible.has(it.id)),
                   dk: timed.filter((it) => !legible.has(it.id)).concat(allday) };
    if (next.ov.length === held.ov.length && next.dk.length === held.dk.length) break;
    held = next;
  }
}

// Most overdue rows the top cover takes. Every row is past hours of the dial it hides, and unlike the
// dock this list has no natural bound — nothing cleared stays overdue for as long as it is left — so
// the rest ride on the top row as its +N, a hidden item still visible AS hidden.
const OVERDUE_MAX = 4;

// One held row. It mirrors `.cw-hour` exactly — gutter, then an items box the chip takes HALF of. A
// chip's 50% is a percentage of its flex container, so the box has to be there: hang the chip off the
// row itself and 50% is measured against a container 56px wider, which is a chip that changes width
// at the moment the dial picks it up or lets it go.
// An all-day row is marked, so the dock can rule it off from the timed ones above it: its gutter is
// empty, and directly under "10p" an empty gutter reads as 10pm too.
const edgeRow = (label, it, more = '') =>
  `<div class="cw-dkrow${it.time ? '' : ' allday'}"><span class="cw-dkh">${esc(label || '')}</span>` +
  `<div class="cw-dkitems">${chip(it, false)}${more}</div></div>`;

// Only as tall as it needs to be: with nothing waiting there is no dock at all and the dial has its
// whole column back.
function paintDock(col, waiting, rowH) {
  let el = col.el.querySelector('.cw-dock');
  if (!waiting.length) { if (el) el.remove(); return; }
  const html = waiting.map((it) => edgeRow(it.time, it)).join('');
  if (!el) { el = document.createElement('div'); el.className = 'cw-dock'; col.el.appendChild(el); }
  el.style.setProperty('--dkrow', `${Math.round(rowH)}px`);
  if (el.innerHTML !== html) el.innerHTML = html;
}

// Oldest at the top, the way the dial runs, so the newest sits nearest the day it left. Past the cap
// the OLDEST collapse into the +N: the rows kept are the ones closest to the timeline they came off.
function paintOverdue(col, items, rowH) {
  const top = col.el.querySelector('.cw-top');
  let el = col.el.querySelector('.cw-overdue');
  if (!items.length || !top) { if (el) el.remove(); return; }
  const shown = items.slice(-OVERDUE_MAX);
  const more = items.length - shown.length;
  const html = shown.map((it, k) =>
    edgeRow(it.when, it, k === 0 && more ? `<span class="cw-more">+${more}</span>` : '')).join('');
  if (!el) { el = document.createElement('div'); el.className = 'cw-overdue'; top.prepend(el); }
  el.style.setProperty('--dkrow', `${Math.round(rowH)}px`);
  if (el.innerHTML !== html) el.innerHTML = html;
}

async function load(col) {
  let d;
  try { d = await (await fetch(col.url)).json(); } catch (_) { return; }
  if (!d || d.error) return;
  if (col.onload) col.onload(d);
  // With a dock, the response's FIRST ahead day is today: it feeds the dock and the look-ahead
  // column takes the days after it. One request answers both, so the two cannot disagree about
  // which day it is.
  col.today = col.dock && d.ahead ? d.ahead[0] : null;
  // Only the dial's request carries it; its absence is what keeps the other surfaces tray-less.
  col.overdue = col.dial ? d.overdue || null : null;
  if (col.ahead && d.ahead) col.ahead.innerHTML = aheadHtml(col.dock ? d.ahead.slice(1) : d.ahead);
  if (!d.dayline) return;
  col.dl = d.dayline;
  // When the next chip changes state on its own — comes due, leaves grace, starts draining. Without
  // it the clock only moved the line, and an item went overdue keeping its old colour until some
  // unrelated edit happened to touch the lists.
  col.next = d.next_transition || null;
  col.el.innerHTML = dayHtml(d.dayline);
  col.hour = new Date().getHours();   // which hour this window was built around
  project(col);
  paintEdges(col);
  if (col.centre) centreOnNow(col.el);
}

// The spine is taller than the card on a surface that scrolls, so land on the current hour rather
// than at the top of the day.
function centreOnNow(el) {
  const cur = el.querySelector('.cw-hour.cur');
  const box = el.querySelector('.cw-hours');
  if (!cur || !box) return;
  box.scrollTop = Math.max(0, cur.offsetTop - box.clientHeight / 2 + cur.offsetHeight / 2);
}

// Put the line where the clock is. False means the current hour has no row, which means the range
// the server laid out no longer covers now — a real change, not something to paper over.
function moveNow(col, now) {
  const rows = col.el.querySelectorAll('.cw-hour');
  const i = col.dl.hours.findIndex((x) => x.h === now.getHours());
  const row = rows[i];
  const old = col.el.querySelector('.cw-now');
  if (old) old.remove();
  if (i < 0 || !row) return false;
  rows.forEach((r) => r.classList.remove('cur'));
  row.classList.add('cur');
  const line = document.createElement('div');
  line.className = 'cw-now';
  line.style.top = `${Math.round((now.getMinutes() / 60) * 100)}%`;
  row.appendChild(line);
  return true;
}

const pad = (n) => String(n).padStart(2, '0');
const dateKey = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
// Local wall-clock 'YYYY-MM-DDTHH:MM', the same shape the server compares against.
const stamp = (d) => `${dateKey(d)}T${pad(d.getHours())}:${pad(d.getMinutes())}`;

// Not a poll: nothing is fetched and no state is inspected. A clock hand has to tick, and the only
// alternative is the server pushing a frame every minute to announce what time it is. It re-aims at
// the next exact minute each pass, so it cannot drift. The two cases that are NOT just the clock
// moving — the day rolling over, and the hour leaving the rendered range — are changes to what the
// server laid out, so those re-read.
function tick() {
  const now = new Date();
  setTimeout(tick, 60000 - (now.getSeconds() * 1000 + now.getMilliseconds()));
  for (const col of columns) {
    if (!col.dl || !col.el.isConnected) continue;
    // A dial re-projects instead of moving a line: every row's size depends on the clock, not just
    // the marker, and the hours it lays out never leave the range because it holds all of them.
    if (col.dial) {
      // The window the server built is centred on the hour it was asked for, so it has to be asked
      // again when the hour rolls — otherwise the dial drifts an hour off its own data every hour.
      if ((col.next && stamp(now) >= col.next) || dateKey(now) !== col.dl.date || now.getHours() !== col.hour) load(col);
      else project(col);
      continue;
    }
    if ((col.next && stamp(now) >= col.next) || dateKey(now) !== col.dl.date || !moveNow(col, now)) load(col);
  }
}
tick();

// Dated items arrive by PUSH. The hub subscribes to list_items/lists in Supabase realtime and emits
// `lists` here the moment either changes, so a reminder added by voice is on the wall as it is
// spoken. This is a wall — nobody is standing at it to notice a dead stream — so it goes through
// liveStream, which judges the connection by whether the server's `ping` keeps arriving.
liveStream('/api/list-stream', { lists: () => columns.forEach(load) });

// The phone's lists pane mounts itself: it is plain markup in the page, with no module of its own to
// do it. The walls mount their column from their own page script, because they choose the endpoint.
const daycard = document.getElementById('daycard');
if (daycard) mount(daycard, { centre: true });
