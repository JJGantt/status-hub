// THE DAY, LYING DOWN — hours running left to right, items placed at their own time, stacked into
// lanes where two of them would collide.
//
// The dial (cards/dayline.js) is the same day standing up, and it is the right shape on a wall: a
// tall column, one row per hour, read from across a room. A phone in portrait has the opposite
// budget — plenty of width, almost no height — so the axis turns ninety degrees and the day scrolls
// under a fixed viewport instead of being squeezed into one.
//
// LANES ARE WHY THIS WORKS. An hour is about eleven pixels here, so a 4pm item and a 7pm one are
// thirty pixels apart and their titles are not: one row would be a smear. Each chip goes in the
// first lane free at its own x, so a title takes the width it needs and the next one drops a lane.
// When every lane is busy the chip already in the one that frees soonest is CUT SHORT rather than
// overlapped — a title losing its tail is still readable, two titles on top of each other are not.
//
// It keeps going past today: the days after it are the same axis continued, ruled and labelled at
// each midnight, which is what makes the look-ahead free here. Scroll right and you are in tomorrow.
//
// DISPLAY ONLY. It paints whatever the one calendar fetch hands it (see cards/dayline.js — the day,
// the days after it and the overdue list are one answer to one question).
import { esc } from '../shared.js';
import { chip } from './dayline.js';

const TICK_EVERY = 3;    // hours between hour labels and their guide lines
const LANE_GAP = 3;
const CHIP_GAP = 4;      // clear space between two chips sharing a lane
const MIN_LANES = 3;     // the floor, whatever the height: two items at the same hour plus one more
const MAX_LANES = 6;     // past six the rows are thinner than the type on them
const MIN_LANE_H = 20;
const MAX_LANE_H = 30;
const CHIP_MIN_W = 22;   // a chip cut this short is a coloured stub, and that is the honest amount

let host = null, cfg = null, day0 = null, placed = false, lastD = null;

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
export function mountStrip(el, { axisH = 14, hourW = 11 } = {}) {
  if (!el) return null;
  host = el;
  cfg = { axisH, hourW };
  el.innerHTML = '<div class="ds-scroll"><div class="ds-strip"></div></div><span class="ds-late"></span>';
  // The clock hand has to tick; nothing is fetched and nothing is inspected. It re-aims at the next
  // exact minute each pass, so it cannot drift, and the DAY rolling over is a change to what the
  // server laid out — dayline.js's own tick re-reads then and paint() runs again with the new days.
  const tick = () => {
    const now = new Date();
    setTimeout(tick, 60000 - (now.getSeconds() * 1000 + now.getMilliseconds()));
    moveNow();
  };
  tick();
  // How many lanes there are is measured off this element, and the element's height is whatever the
  // rest of the screen did not need — so a rotation or a keyboard opening changes it and the strip
  // has to be laid out again. Nothing is fetched: it repaints the answer it already has.
  window.addEventListener('resize', () => { placed = false; if (lastD) paint(lastD); }, { passive: true });
  return { paint };
}

// How the block's height is spent. It takes whatever the rest of the screen did not need, and it
// spends it on LANES FIRST and then on their height — more rows while there is room for another
// readable one, taller rows once there is not. Both, rather than one: a fixed lane height leaves a
// band of black under a quiet day, and a fixed lane count makes a busy one unreadable.
function geom() {
  const avail = Math.max(0, host.clientHeight - cfg.axisH);
  const n = Math.min(MAX_LANES,
    Math.max(MIN_LANES, Math.floor((avail + LANE_GAP) / (MIN_LANE_H + LANE_GAP))));
  const h = Math.max(MIN_LANE_H,
    Math.min(MAX_LANE_H, Math.floor((avail - (n - 1) * LANE_GAP) / n)));
  return { n, h };
}

function nowX() {
  const n = new Date();
  return (n.getHours() + n.getMinutes() / 60) * cfg.hourW;
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
  const dayW = 24 * cfg.hourW;
  const { n: N, h: LANE_H } = geom();
  strip.style.width = `${days.length * dayW}px`;
  strip.style.height = `${cfg.axisH + N * LANE_H + (N - 1) * LANE_GAP}px`;
  // The chips take their height AND their type from the lane, the way the dial's rows do — one
  // number, read back in CSS, so a taller lane is a bigger chip rather than the same chip floating.
  strip.style.setProperty('--ds-laneh', `${LANE_H}px`);

  // The axis: a rule and a label at each midnight, a fainter one every three hours. Day one is
  // today and gets no rule — the now-line is the mark on it, and a second line at its left edge
  // would read as one more boundary rather than as where the strip begins.
  let html = '';
  days.forEach((day, k) => {
    const x0 = k * dayW;
    if (k) html += `<i class="ds-day" style="left:${x0}px"></i>`;
    const more = day.more ? `<b class="ds-more">+${day.more}</b>` : '';
    html += `<span class="ds-dlab" style="left:${x0 + (k ? 3 : 0)}px">${esc(day.dow)} ${day.day}${more}</span>`;
    for (let h = TICK_EVERY; h < 24; h += TICK_EVERY) {
      const x = x0 + h * cfg.hourW;
      // The LINE always; the label only where the day's own name is not already sitting. At this
      // scale the first tick after a midnight is thirty pixels from it, which is inside the word.
      html += `<i class="ds-tick" style="left:${x}px"></i>` +
        (h > TICK_EVERY ? `<span class="ds-hl" style="left:${x + 2}px">${hourLabel(h)}</span>` : '');
    }
  });

  // Every item on the seven days, in time order — the order lane packing has to walk them in.
  const items = [];
  days.forEach((day, k) => (day.items || []).forEach((it) => {
    const h = hourOf(it.time);
    items.push({ it, x: k * dayW + (h == null ? 0 : h * cfg.hourW), timed: h != null });
  }));
  items.sort((a, b) => a.x - b.x);
  html += items.map((o) =>
    `<span class="ds-item" style="left:${o.x}px">${chip(o.it, o.timed)}</span>`).join('');
  html += `<i class="ds-now" style="left:${nowX()}px"></i>`;
  strip.innerHTML = html;

  // Lane packing, after the browser has measured what each title actually wants.
  const els = [...strip.querySelectorAll('.ds-item')];
  const right = new Array(N).fill(-Infinity);   // where each lane is busy until
  const last = new Array(N).fill(null);         // and what is sitting there
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
  });

  // How many things are late, whatever day they were due. The strip itself shows the ones from today
  // once you scroll back to them; anything older is off its left end entirely, and this is the only
  // thing on the page that would say so. It does not scroll with the strip.
  const late = (d.overdue || []).length;
  const badge = host.querySelector('.ds-late');
  badge.textContent = late ? String(late) : '';
  badge.classList.toggle('on', late > 0);

  // Land a little to the left of now, so the last hour or two is in the picture with what is coming.
  // Only on the first paint and when the day rolls — a repaint under someone mid-scroll must not
  // throw them back to now.
  const today = d.today || dateKey(new Date());
  if (!placed || today !== day0) {
    day0 = today; placed = true;
    requestAnimationFrame(() => { scroll.scrollLeft = Math.max(0, nowX() - scroll.clientWidth * 0.3); });
  }
}
