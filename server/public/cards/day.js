// Today's timeline — the phone's version of the wall's day column. Same endpoint, same server-laid-out
// hours and half-hour lines, same chip states; only the sizing differs. Painted into #daycard, and it
// no-ops where that element is absent (the TV wall draws its own from tv-calendar.js).
//
// It fetches for itself rather than riding the status frame: the frame carries no dated items, and
// this is the same data the lists pane below it self-fetches.
import { esc, liveStream } from '../shared.js';

let dayline = null;
let nextTransition = null;   // when the next chip changes state — the server works it out, not us

// No time on the chip and no repeat glyph: the line it sits on already says the time, and several
// chips share that line's width. Exactly the wall's reasoning, at phone scale.
function chip(it) {
  const cls = 'dc-chip' + (it.done ? ' done' : it.expired ? ' exp' : it.grace ? ' grace' : it.past ? ' past' : '');
  return `<span class="${cls}" style="--c:${esc(it.color)}"><span class="dc-l">${esc(it.title)}</span></span>`;
}

// One half-hour line. The second is reserved for :30-:59, so a 4:30 item sits on the lower line even
// when 4:00 is empty — that placement is the only thing saying which half of the hour it is in.
function halfLine(half) {
  const more = half.more ? `<span class="dc-more">+${half.more}</span>` : '';
  return `<div class="dc-half">${half.items.map(chip).join('')}${more}</div>`;
}

function html(dl) {
  const allday = dl.allday.length ? `<div class="dc-allday">${dl.allday.map(chip).join('')}</div>` : '';
  const hours = dl.hours.map((h) => {
    const now = h.now !== null ? `<div class="dc-now" style="top:${h.now}%"></div>` : '';
    return `<div class="dc-hour${h.now !== null ? ' cur' : ''}">` +
      `<span class="dc-hl">${esc(h.label)}</span>` +
      `<div class="dc-items">${h.halves.map(halfLine).join('')}</div>${now}</div>`;
  }).join('');
  return `<div class="dc-head">${esc(dl.label)}</div>${allday}<div class="dc-hours">${hours}</div>`;
}

async function load() {
  const el = document.getElementById('daycard');
  if (!el) return;
  let d;
  try { d = await (await fetch('/api/calendar?day=1')).json(); } catch (_) { return; }
  if (!d || d.error || !d.dayline) return;
  dayline = d.dayline;
  nextTransition = d.next_transition || null;
  el.innerHTML = html(d.dayline);
  centreOnNow(el);
}

// The spine runs 7a-10p whatever is on it, which is taller than the card. Land on the current hour
// rather than at 7am, so opening the pane shows now without a scroll.
function centreOnNow(el) {
  const cur = el.querySelector('.dc-hour.cur');
  const box = el.querySelector('.dc-hours');
  if (!cur || !box) return;
  box.scrollTop = Math.max(0, cur.offsetTop - box.clientHeight / 2 + cur.offsetHeight / 2);
}

// Local wall-clock 'YYYY-MM-DDTHH:MM', the shape the server compares against.
function stamp(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

// A clock hand has to tick, and chips change state on their own as time passes. Re-aims at the next
// exact minute so it cannot drift. Only two things force a re-read: a chip's state changing (the
// server said when) and the day rolling over. Everything else is just the line moving.
function tick() {
  const now = new Date();
  setTimeout(tick, 60000 - (now.getSeconds() * 1000 + now.getMilliseconds()));
  if (!document.getElementById('daycard') || !dayline) return;
  if (nextTransition && stamp(now) >= nextTransition) return load();
  if (`${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}` !== dayline.date) load();
  moveNow(now);
}

// Move the now-line within its hour without a fetch — the same reason the wall does it this way.
function moveNow(now) {
  const el = document.getElementById('daycard');
  if (!el) return;
  const line = el.querySelector('.dc-now');
  if (line) line.style.top = `${Math.round((now.getMinutes() / 60) * 100)}%`;
}

export function render() {
  if (!document.getElementById('daycard') || dayline) return;   // first paint only; then self-driven
  load();
}

if (document.getElementById('daycard')) {
  liveStream('/api/list-stream', { lists: load });   // an item added or checked off anywhere lands here
  load();
  tick();
}
