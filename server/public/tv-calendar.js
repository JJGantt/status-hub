// The calendar wall's middle — a day timeline beside the month grid(s), painted from
// /api/calendar?wall=1. Display-only by charter: nothing here is interactive; voice does the
// writing AND the view-changing (wall_mode / calendar_months are app_settings, and the payload
// follows them). Only tv-calendar.html loads this; the other walls share none of it.
//
// The day column is NOT here — it is cards/dayline.js, the one module every surface draws it with.
// This page hands that module the endpoint it needs and takes the months out of the same response.
//
// The server ships finished geometry — hour rows, chip colors, mini-grid column count — so this file
// only lays markup into the two panels.
import { esc } from './shared.js';
import { mount } from './cards/dayline.js';

// A chip in a MONTH cell, where nothing else says when it is — so it carries its time.
function chip(it) {
  const cls = 'cw-chip' + (it.exempt ? ' exempt' : '') + (it.done ? ' done' : it.expired ? ' exp' : it.grace ? ' grace' : it.past ? ' past' : '');
  const t = it.time ? `<span class="cw-t">${esc(it.time)}</span>` : '';
  const rep = it.repeating ? '<span class="cw-r">↻</span>' : '';
  const imp = it.priority > 0 ? '<span class="cw-imp">!</span>' : '';
  return `<span class="${cls}" style="--c:${esc(it.color)}">${t}${imp}<span class="cw-l">${esc(it.title)}</span>${rep}</span>`;
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

// The months, out of the payload the day column fetched for its own reasons. One request feeds both
// panels, which is why this page mounts the column with `?wall=1` instead of letting it default.
function months(d) {
  const mon = document.getElementById('cw-months');
  if (!mon || !d.months) return;
  mon.style.gridTemplateColumns = `repeat(${d.cols}, 1fr)`;
  mon.innerHTML = d.count === 1 ? bigMonth(d.months[0], d.dow) : d.months.map(miniMonth).join('');
}

// The module owns the fetching, the clock and the reload rules — including the push subscription
// that puts a spoken reminder on the wall as it is said, which reloads the months with it.
mount(document.getElementById('cw-day'), { url: '/api/calendar?wall=1', onload: months });
