// The calendar wall's middle — a day timeline beside the month grid(s), painted from
// /api/calendar?wall=1. Display-only by charter: nothing here is interactive; voice does the
// writing AND the view-changing (wall_mode / calendar_months are app_settings, and the payload
// follows them). Only tv-calendar.html loads this; the other walls share none of it.
//
// The server ships finished geometry — hour rows, the now-line's row and percentage, chip colors,
// mini-grid column count — so this file only lays markup into the two panels.
import { esc, liveStream } from './shared.js';

let nextTransition = null;   // when the next chip changes state, from the server

// A chip in a MONTH cell, where nothing else says when it is — so it carries its time.
function chip(it) {
  const cls = 'cw-chip' + (it.done ? ' done' : it.expired ? ' exp' : it.grace ? ' grace' : it.past ? ' past' : '');
  const t = it.time ? `<span class="cw-t">${esc(it.time)}</span>` : '';
  const rep = it.repeating ? '<span class="cw-r">↻</span>' : '';
  return `<span class="${cls}" style="--c:${esc(it.color)}">${t}<span class="cw-l">${esc(it.title)}</span>${rep}</span>`;
}

// A chip on the DAY TIMELINE, where the line it sits on already says the time — so it carries none,
// and no repeat glyph either. Both were spending width that several chips now share between them.
function dayChip(it) {
  const cls = 'cw-dchip' + (it.done ? ' done' : it.expired ? ' exp' : it.grace ? ' grace' : it.past ? ' past' : '');
  // The server decides both the number and which kind it is; this only paints it.
  const sc = it.score ? `<span class="cw-sc k-${esc(it.score_kind)}">${esc(it.score)}</span>` : '';
  return `<span class="${cls}" style="--c:${esc(it.color)}"><span class="cw-l">${esc(it.title)}</span>${sc}</span>`;
}

// One half-hour line. The server decides how many chips fit and hands back the rest as a count, so a
// hidden item is still visible AS hidden rather than silently dropped.
function halfLine(half) {
  const more = half.more ? `<span class="cw-more">+${half.more}</span>` : '';
  return `<div class="cw-half">${half.items.map(dayChip).join('')}${more}</div>`;
}

function dayHtml(dl) {
  const allday = dl.allday.length
    ? `<div class="cw-allday">${dl.allday.map(dayChip).join('')}</div>` : '';
  const hours = dl.hours.map((h) => {
    const now = h.now !== null ? `<div class="cw-now" style="top:${h.now}%"></div>` : '';
    return `<div class="cw-hour${h.now !== null ? ' cur' : ''}">` +
      `<span class="cw-hl">${esc(h.label)}</span>` +
      `<div class="cw-hitems">${h.halves.map(halfLine).join('')}</div>${now}</div>`;
  }).join('');
  return `<div class="cw-dayhead">${esc(dl.label)}</div>${allday}<div class="cw-hours">${hours}</div>`;
}

// One month, full size — chips in the cells. Used when the wall shows a single month.
function bigMonth(m, dow) {
  const head = dow.map((d) => `<span>${esc(d)}</span>`).join('');
  const cells = m.weeks.map((w) => w.map((c) =>
    `<div class="cw-cell${c.inMonth ? '' : ' out'}${c.today ? ' today' : ''}">` +
    `<span class="cw-daynum">${c.day}</span>` +
    `<div class="cw-chips">${c.items.map(chip).join('')}</div></div>`).join('')).join('');
  return `<div class="cw-month big"><h3>${esc(m.label)}</h3>` +
    `<div class="cw-dow">${head}</div><div class="cw-grid">${cells}</div></div>`;
}

// One month, mini — day numbers with list-colored dots. Used when the wall shows several.
function miniMonth(m) {
  const cells = m.weeks.map((w) => w.map((c) => {
    const dots = c.items.slice(0, 3).map((it) => `<i style="background:${esc(it.color)}"></i>`).join('');
    return `<div class="cw-cell${c.inMonth ? '' : ' out'}${c.today ? ' today' : ''}">` +
      `<span class="cw-daynum">${c.day}</span><div class="cw-dots">${dots}</div></div>`;
  }).join('')).join('');
  return `<div class="cw-month mini"><h3>${esc(m.label)}</h3><div class="cw-grid">${cells}</div></div>`;
}

// The served day column, kept after render so the now-line can move without asking the server again.
let dayline = null;

const pad = (n) => String(n).padStart(2, '0');
const dateKey = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

// Put the line where the clock is. Returns false when the current hour has no row, which means the
// range the server laid out no longer covers now — a real change, not something to paper over.
function moveNow(now) {
  const rows = document.querySelectorAll('#cw-day .cw-hour');
  const i = dayline.hours.findIndex((x) => x.h === now.getHours());
  const row = rows[i];
  const old = document.querySelector('.cw-now');
  if (old) old.remove();
  if (i < 0 || !row) return false;
  rows.forEach((r) => r.classList.remove('cur'));
  row.classList.add('cur');
  const el = document.createElement('div');
  el.className = 'cw-now';
  el.style.top = `${Math.round((now.getMinutes() / 60) * 100)}%`;
  row.appendChild(el);
  return true;
}

// The one thing this page works out for itself, and it is not a poll: nothing is fetched and no
// state is inspected. A clock hand has to tick, and the only alternative is the server pushing a
// frame every minute to announce what time it is. It re-aims at the next exact minute each pass, so
// it cannot drift. The two cases that are NOT just the clock moving — the day rolling over, and the
// hour leaving the rendered range — are changes to what the server laid out, so those re-read.
function tick() {
  const now = new Date();
  setTimeout(tick, 60000 - (now.getSeconds() * 1000 + now.getMilliseconds()));
  if (!dayline) return;
  // Chips change state on their own as time passes — due, then past grace and draining — and the
  // server says when the next one does. Without this the tick only moved the now-line, so something
  // went overdue and kept its old colour until an unrelated edit happened to touch the lists.
  if (nextTransition && localStamp(now) >= nextTransition) return load();
  if (dateKey(now) !== dayline.date || !moveNow(now)) load();
}
// Local wall-clock 'YYYY-MM-DDTHH:MM', the same shape the server compares against.
function localStamp(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

async function load() {
  const day = document.getElementById('cw-day');
  const mon = document.getElementById('cw-months');
  if (!day || !mon) return;
  let d;
  try { d = await (await fetch('/api/calendar?wall=1')).json(); } catch (_) { return; }
  if (!d || d.error || !d.months) return;
  dayline = d.dayline || null;
  nextTransition = d.next_transition || null;
  day.innerHTML = d.dayline ? dayHtml(d.dayline) : '';
  mon.style.gridTemplateColumns = `repeat(${d.cols}, 1fr)`;
  mon.innerHTML = d.count === 1 ? bigMonth(d.months[0], d.dow) : d.months.map(miniMonth).join('');
}

// Dated items arrive by PUSH. The hub subscribes to list_items/lists in Supabase realtime and emits
// `lists` here the moment either changes, so a reminder added by voice is on the wall as it is spoken.
// This is a wall — nobody is standing at it to notice a dead stream — so it goes through liveStream,
// which judges the connection by whether the server's `ping` keeps arriving.
liveStream('/api/list-stream', { lists: load });

load();
tick();
