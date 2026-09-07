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

// No time on the chip and no repeat glyph: the line it sits on already says the time, and several
// chips share that line's width. Both were spending room the chips need more.
function chip(it) {
  const cls = 'cw-dchip' + (it.exempt ? ' exempt' : '') +
    (it.done ? ' done' : it.expired ? ' exp' : it.grace ? ' grace' : it.past ? ' past' : '');
  // The server decides both the number and which kind it is; this only paints it.
  const sc = it.score ? `<span class="cw-sc k-${esc(it.score_kind)} ${esc(it.score_sign)}">${esc(it.score)}</span>` : '';
  // Important carries the same amber ! the lists pane uses; exempt goes hollow, because it is
  // not a thing to do — it is a thing that is simply on the schedule.
  const imp = it.priority > 0 ? '<span class="cw-imp">!</span>' : '';
  return `<span class="${cls}" style="--c:${esc(it.color)}">${imp}<span class="cw-l">${esc(it.title)}</span>${sc}</span>`;
}

// One half-hour line. The second is reserved for :30-:59, so a 4:30 item sits on the lower line even
// when 4:00 is empty — that placement is the only thing saying which half of the hour it is in. The
// server decides how many chips fit and hands back the rest as a count, so a hidden item is still
// visible AS hidden rather than silently dropped.
function halfLine(half) {
  const more = half.more ? `<span class="cw-more">+${half.more}</span>` : '';
  return `<div class="cw-half">${half.items.map(chip).join('')}${more}</div>`;
}

export function dayHtml(dl) {
  const allday = dl.allday.length
    ? `<div class="cw-allday">${dl.allday.map(chip).join('')}</div>` : '';
  const hours = dl.hours.map((h) => {
    const now = h.now !== null ? `<div class="cw-now" style="top:${h.now}%"></div>` : '';
    return `<div class="cw-hour${h.now !== null ? ' cur' : ''}">` +
      `<span class="cw-hl">${esc(h.label)}</span>` +
      `<div class="cw-hitems">${h.halves.map(halfLine).join('')}</div>${now}</div>`;
  }).join('');
  return `<div class="cw-dayhead">${esc(dl.label)}</div>${allday}<div class="cw-hours">${hours}</div>`;
}

/**
 * Mount a day column on an element and keep it live.
 *
 * `url` is whichever calendar view this surface needs — `?day=1` for a column on its own, `?wall=1`
 * where the same payload also carries the months. `onload` hands that whole payload back, so a page
 * wanting more out of the response gets it without a second fetch.
 */
export function mount(el, { url = '/api/calendar?day=1', centre = false, onload = null, dial = false } = {}) {
  if (!el) return;
  const col = { el, url, centre, onload, dial, dl: null, next: null };
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
    // Below about a line of text there is no room for anything but the hour, and below that not even
    // that. Said in classes so the CSS decides what survives at each size, not this file.
    row.classList.toggle('thin', h < 34);
    row.classList.toggle('sliver', h < 15);
    // Which hour is the current one is worked out here every tick, not taken from the payload. The
    // server decides it once, at fetch time, and the dial only re-fetches when the hour rolls — so
    // between those it was lighting whichever hour happened to be current when it last loaded.
    row.classList.toggle('cur', nowT >= at && nowT < at + 1);
  });
}

async function load(col) {
  let d;
  try { d = await (await fetch(col.url)).json(); } catch (_) { return; }
  if (!d || d.error) return;
  if (col.onload) col.onload(d);
  if (!d.dayline) return;
  col.dl = d.dayline;
  // When the next chip changes state on its own — comes due, leaves grace, starts draining. Without
  // it the clock only moved the line, and an item went overdue keeping its old colour until some
  // unrelated edit happened to touch the lists.
  col.next = d.next_transition || null;
  col.el.innerHTML = dayHtml(d.dayline);
  col.hour = new Date().getHours();   // which hour this window was built around
  project(col);
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
