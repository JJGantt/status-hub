// THE DAY, LYING DOWN — hours running left to right, items placed at their own time, stacked into
// lanes where two of them would collide.
//
// The dial (cards/dayline.js) is the same day standing up, and it is the right shape on a wall: a
// tall column, one row per hour, read from across a room. A phone in portrait has the opposite
// budget — plenty of width, almost no height — so the axis turns ninety degrees and the day scrolls
// under a fixed viewport instead of being squeezed into one.
//
// LANES ARE WHY THIS WORKS. Two items a couple of hours apart are closer together than their titles
// are long, so one row would be a smear. Each chip goes in the first lane free at its own x, so a
// title takes the width it needs and the next one drops a lane. When every lane is busy the chip
// already in the one that frees soonest is CUT SHORT rather than overlapped — a title losing its
// tail is still readable, two titles on top of each other are not.
//
// THE SCALE IS WHAT MAKES THE LANES MEAN ANYTHING, and it is the number to be careful with. At
// eleven pixels an hour a chip with a title on it was five to ten HOURS wide, so every item blocked
// its lane for the rest of the day and four items an hour or two apart came out as a diagonal
// staircase — four lanes, each holding one chip, the x of each saying nothing the little `4p` on it
// was not already saying. At twenty-six a chip is about three hours, which is a duration, so two
// things at the same end of an afternoon share a lane and only a real collision drops one.
//
// It keeps going past today: the days after it are the same axis continued, ruled and labelled at
// each midnight, which is what makes the look-ahead free here. Scroll right and you are in tomorrow.
//
// DISPLAY ONLY. It paints whatever the one calendar fetch hands it (see cards/dayline.js — the day,
// the days after it and the overdue list are one answer to one question).
import { esc } from '../shared.js';
import { chip } from './dayline.js';

// EVERY hour is labelled on today, because the strip doubles as the clock — "is it nearer 4 or 5"
// should not need counting from a mark three hours away. That is what sets the scale: a label is
// about eighteen pixels, so an hour has to be wide enough to hold one and still read as a gap.
const TICK_EVERY = 1;
const LANE_GAP = 3;
const CHIP_GAP = 4;      // clear space between two chips sharing a lane
const MIN_LANES = 3;     // always reserved, even on an empty day — the room for a collision
const MAX_LANES = 4;     // past four the block is taking screen off everything under it
const LANE_H = 20;
const CHIP_MIN_W = 22;   // a chip cut this short is a coloured stub, and that is the honest amount

let host = null, cfg = null, day0 = null, placed = false, lastD = null;
// WHICH DAY IS OPEN, besides today. One at a time: two full days side by side is most of the strip
// spent on two days, and the whole point of the collapsed blocks is that a day at a remove needs a
// few chips and not a timeline. Null means only today is.
let openDay = null;

const pad2 = (n) => String(n).padStart(2, '0');
const dateKey = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;

// '2p', '10:30a' — the server's own label, parsed back to a position on the axis. All-day items have
// none, and they belong at the day's own start.
function hourOf(t) {
  const m = String(t || '').match(/^(\d+)(?::(\d+))?([ap])$/);
  if (!m) return null;
  let h = +m[1] % 12;
  if (m[3] === 'p') h += 12;
  return h + (+(m[2] || 0)) / 60;
}

const hourLabel = (h) => `${h % 12 || 12}${h < 12 ? 'a' : 'p'}`;

/**
 * Mount the strip on an element. `hourW` is the whole scale — px per hour. How many lanes there are
 * and how tall they get is measured off the element (see geom), because on this page the strip is
 * the block that absorbs whatever height the rest of the screen did not need.
 */
export function mountStrip(el, { axisH = 14, hourW = 36, dayW = 96 } = {}) {
  if (!el) return null;
  host = el;
  cfg = { axisH, hourW, dayW };
  el.innerHTML = '<div class="ds-scroll"><div class="ds-strip"></div></div><span class="ds-here"></span>';
  // WHICH DAY YOU ARE LOOKING AT, pinned to the left edge and not scrolling with the strip. The day
  // names inside it sit at their own midnights, so today's is off the left end from the moment the
  // strip lands on now — which left the only date on the whole page reading FRI 18, tomorrow.
  const sc = el.querySelector('.ds-scroll');
  sc.addEventListener('scroll', here, { passive: true });
  // TAP A DAY TO OPEN IT, tap it again to put it back. A drag is not a tap: the strip is a scroller
  // and a flick that happens to end over a day would otherwise open it, so the gesture is discarded
  // unless the scroll position is where it started.
  // null, not 0: a click with no pointerdown behind it (the native app, a test) has no gesture to
  // judge, and comparing against a zero that was never a scroll position discarded every real tap
  // the moment the strip was scrolled anywhere at all.
  let downAt = null;
  sc.addEventListener('pointerdown', () => { downAt = sc.scrollLeft; }, { passive: true });
  sc.addEventListener('click', (e) => {
    const hit = e.target.closest('.ds-hit');
    if (!hit) return;
    if (downAt !== null && Math.abs(sc.scrollLeft - downAt) > 4) { downAt = null; return; }
    downAt = null;
    const k = Number(hit.dataset.day);
    openDay = openDay === k ? null : k;
    if (!lastD) return;
    paint(lastD);
    // Land on the day just opened rather than wherever its old 96px block happened to leave the
    // view — opening one is a request to look at it.
    if (openDay !== null) {
      // Exactly on its midnight, not a few pixels before it: the pinned label reads whichever day the
      // LEFT EDGE is in, so a lead-in of eight pixels had it naming the day before the one just opened.
      requestAnimationFrame(() => { sc.scrollLeft = dayStart(openDay); here(); });
    }
  });
  // The clock hand has to tick; nothing is fetched and nothing is inspected. It re-aims at the next
  // exact minute each pass, so it cannot drift, and the DAY rolling over is a change to what the
  // server laid out — dayline.js's own tick re-reads then and paint() runs again with the new days.
  const tick = () => {
    const now = new Date();
    setTimeout(tick, 60000 - (now.getSeconds() * 1000 + now.getMilliseconds()));
    moveNow();
  };
  tick();
  // Back to now: today alone open, and the strip where it lands on a fresh load.
  window.addEventListener('hubreset', () => {
    openDay = null;
    if (lastD) paint(lastD);
    requestAnimationFrame(() => { sc.scrollLeft = Math.max(0, nowX() - sc.clientWidth * 0.3); here(); });
  });
  // How many lanes there are is measured off this element, and the element's height is whatever the
  // rest of the screen did not need — so a rotation or a keyboard opening changes it and the strip
  // has to be laid out again. Nothing is fetched: it repaints the answer it already has.
  window.addEventListener('resize', () => { placed = false; if (lastD) paint(lastD); }, { passive: true });
  return { paint };
}

// How tall the block is, in lanes. It comes from the DAY, not from the space available: this used to
// measure its own container, which is sized by its content, so a first paint read a box that had not
// been squeezed yet, claimed six lanes of it, and then kept them — a third of the screen held for
// four items with the rest of it black. Three lanes always (the room a collision needs), a fourth
// only when the day actually wants one, and nothing beyond that.
const boxH = (n) => cfg.axisH + n * LANE_H + (n - 1) * LANE_GAP;

// TWO SCALES ON ONE BAND. Today is a clock — hours across, every one of them labelled, wide enough
// to read the time off. A day at a remove is not a clock: nobody asks where in Saturday something
// falls, only what is on it, so it collapses to a BLOCK the width of a few chips. Giving every day
// today's scale spent six hundred pixels a day saying almost nothing, and made today's hours narrow
// enough that only every third could be named.
// A day is OPEN when it is drawn as a clock — today always, and whichever one was last tapped.
const isOpen = (k) => k === 0 || k === openDay;
const todayW = () => 24 * cfg.hourW;
const dayWidth = (k) => (isOpen(k) ? todayW() : cfg.dayW);
function dayStart(k) {
  let x = 0;
  for (let i = 0; i < k; i++) x += dayWidth(i);
  return x;
}

function nowX() {
  const n = new Date();
  return (n.getHours() + n.getMinutes() / 60) * cfg.hourW;
}

// The day the LEFT EDGE of the viewport is in.
function here() {
  if (!host || !lastD || !lastD.ahead) return;
  const sc = host.querySelector('.ds-scroll');
  const x = sc.scrollLeft + 1;
  let k = 0;
  while (k + 1 < lastD.ahead.length && x >= dayStart(k + 1)) k++;
  const d = lastD.ahead[k];
  const lab = host.querySelector('.ds-here');
  if (d && lab) lab.textContent = `${d.dow} ${d.day}`;
}

function moveNow() {
  if (!host) return;
  const line = host.querySelector('.ds-now');
  if (line) line.style.left = `${nowX()}px`;
}

function paint(d) {
  if (!host || !d || !d.ahead || !d.ahead.length) return;
  lastD = d;
  const days = d.ahead;
  const scroll = host.querySelector('.ds-scroll');
  const strip = host.querySelector('.ds-strip');
  const N = MAX_LANES;
  strip.style.width = `${dayStart(days.length - 1) + dayWidth(days.length - 1)}px`;
  strip.style.height = `${boxH(N)}px`;

  // THE AXIS. An OPEN day gets an hour rule and an hour NAME at every hour; a collapsed one gets a
  // rule at its own edge and its name. Today's own name sits at x=0 with no rule under it — the
  // now-line is the mark on today, and a second line at the strip's left edge would read as one more
  // boundary rather than as where it begins.
  let html = '';
  days.forEach((day, k) => {
    const x0 = dayStart(k);
    if (k) html += `<i class="ds-day" style="left:${x0}px"></i>`;
    html += `<span class="ds-dlab${isOpen(k) ? ' on' : ''}" style="left:${x0 + (k ? 3 : 0)}px">` +
      `${esc(day.dow)}\u00a0${day.day}</span>`;
    // Every day but today is a tap target, open or closed — tapping the open one puts it back.
    if (k) html += `<i class="ds-hit" data-day="${k}" style="left:${x0}px;width:${dayWidth(k)}px"></i>`;
    if (!isOpen(k)) return;
    for (let h = TICK_EVERY; h < 24; h += TICK_EVERY) {
      const x = x0 + h * cfg.hourW;
      // The LINE always; the NAME wherever the day's own label is not already sitting.
      html += `<i class="ds-tick" style="left:${x}px"></i>` +
        (h > 1 ? `<span class="ds-hl" style="left:${x + 2}px">${hourLabel(h)}</span>` : '');
    }
  });

  // The OPEN days' items, in time order — the order lane packing has to walk them in. Two open days
  // are far enough apart on the axis that one pass over both packs each of them on its own.
  const items = [];
  days.forEach((day, k) => {
    if (!isOpen(k)) return;
    (day.items || []).forEach((it) => {
      const h = hourOf(it.time);
      items.push({ it, x: dayStart(k) + (h == null ? 0 : h * cfg.hourW), timed: h != null });
    });
  });
  items.sort((a, b) => a.x - b.x);
  html += items.map((o) =>
    `<span class="ds-item" style="left:${o.x}px">${chip(o.it, o.timed)}</span>`).join('');

  // A COLLAPSED day is a stack: one chip per lane, in time order, as many as the lanes allow and the
  // rest counted at its head. The chips carry their time, because there is no hour axis under them.
  let blocks = 0;
  days.forEach((day, k) => {
    if (isOpen(k)) return;
    const all = day.items || [];
    const show = all.slice(0, N);
    if (show.length > blocks) blocks = show.length;
    const over = (day.more || 0) + Math.max(0, all.length - N);
    if (over) html += `<b class="ds-more" style="left:${dayStart(k) + cfg.dayW - 3}px">+${over}</b>`;
    show.forEach((it, lane) => {
      html += `<span class="ds-item ds-block" style="left:${dayStart(k) + 2}px;` +
        `width:${cfg.dayW - 4}px;top:${cfg.axisH + lane * (LANE_H + LANE_GAP)}px">` +
        `${chip(it, true)}</span>`;
    });
  });
  html += `<i class="ds-now" style="left:${nowX()}px"></i>`;
  strip.innerHTML = html;

  // Lane packing for the OPEN days only — a block's chips already have their lane.
  const els = [...strip.querySelectorAll('.ds-item:not(.ds-block)')];
  const right = new Array(N).fill(-Infinity);   // where each lane is busy until
  const last = new Array(N).fill(null);         // and what is sitting there
  let used = blocks;                            // how many lanes anything on the strip needed
  els.forEach((e, i) => {
    const x = items[i].x;
    let lane = right.findIndex((r) => r <= x - CHIP_GAP);
    if (lane < 0) {
      // Every lane busy: take the one that frees soonest and cut its occupant short at this chip.
      lane = right.indexOf(Math.min(...right));
      const p = last[lane];
      if (p) p.el.style.maxWidth = `${Math.max(CHIP_MIN_W, x - CHIP_GAP - p.x)}px`;
    }
    e.style.top = `${cfg.axisH + lane * (LANE_H + LANE_GAP)}px`;
    right[lane] = x + e.offsetWidth;
    last[lane] = { el: e, x };
    if (lane + 1 > used) used = lane + 1;
  });
  // Now the block is only as tall as the day made it.
  const H = boxH(Math.max(MIN_LANES, used));
  strip.style.height = `${H}px`;
  scroll.style.height = `${H}px`;


  // Land a little to the left of now, so the last hour or two is in the picture with what is coming.
  // Only on the first paint and when the day rolls — a repaint under someone mid-scroll must not
  // throw them back to now.
  const today = d.today || dateKey(new Date());
  if (!placed || today !== day0) {
    day0 = today; placed = true;
    requestAnimationFrame(() => {
      scroll.scrollLeft = Math.max(0, nowX() - scroll.clientWidth * 0.3);
      here();
    });
  }
}
