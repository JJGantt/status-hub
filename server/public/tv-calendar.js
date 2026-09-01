// The calendar wall's middle — a day timeline beside the month grid(s), painted from
// /api/calendar?wall=1. Display-only by charter: nothing here is interactive; voice does the
// writing AND the view-changing (wall_mode / calendar_months are app_settings, and the payload
// follows them). Only tv-calendar.html loads this; the other walls share none of it.
//
// The server ships finished geometry — hour rows, the now-line's row and percentage, chip colors,
// mini-grid column count — so this file only lays markup into the two panels.
import { esc } from './shared.js';

function chip(it) {
  const cls = 'cw-chip' + (it.past ? ' past' : '') + (it.expired ? ' exp' : '');
  const t = it.time ? `<span class="cw-t">${esc(it.time)}</span>` : '';
  const rep = it.repeating ? '<span class="cw-r">↻</span>' : '';
  return `<span class="${cls}" style="--c:${esc(it.color)}">${t}<span class="cw-l">${esc(it.title)}</span>${rep}</span>`;
}

function dayHtml(dl) {
  const allday = dl.allday.length
    ? `<div class="cw-allday">${dl.allday.map(chip).join('')}</div>` : '';
  const hours = dl.hours.map((h) => {
    const now = h.now !== null ? `<div class="cw-now" style="top:${h.now}%"></div>` : '';
    return `<div class="cw-hour${h.now !== null ? ' cur' : ''}">` +
      `<span class="cw-hl">${esc(h.label)}</span><div class="cw-hitems">${h.items.map(chip).join('')}</div>${now}</div>`;
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

async function load() {
  const day = document.getElementById('cw-day');
  const mon = document.getElementById('cw-months');
  if (!day || !mon) return;
  let d;
  try { d = await (await fetch('/api/calendar?wall=1')).json(); } catch (_) { return; }
  if (!d || d.error || !d.months) return;
  day.innerHTML = d.dayline ? dayHtml(d.dayline) : '';
  mon.style.gridTemplateColumns = `repeat(${d.cols}, 1fr)`;
  mon.innerHTML = d.count === 1 ? bigMonth(d.months[0], d.dow) : d.months.map(miniMonth).join('');
}

load();
setInterval(load, 60000);
