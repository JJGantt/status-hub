// The month calendar — a month grid + day agenda painted from /api/calendar, which ships the finished
// grid (cells, chips, colors, time labels). READ-ONLY by charter: voice/MCP and the lists do the
// writing; this only shows what has a date on it.
//
// One module, two surfaces: the standalone /calendar page, and the phone home page's calendar sheet
// (expand.js, `cal`), where it sits above the day and the lists. Each surface decides what makes it
// re-read — the page opens its own list stream; the home page already has one (cards/dayline.js) and
// passes its pushes on as `hub:lists`, because a second EventSource on one phone is a known mistake.
// The TV has its own wall page (tv-calendar.html + tv-calendar.js).
import { esc } from '../shared.js';

function chip(it) {
  const cls = 'cal-chip' + (it.exempt ? ' exempt' : '') + (it.done ? ' done' : it.expired ? ' exp' : it.grace ? ' grace' : it.past ? ' past' : '');
  const t = it.time ? `<span class="cc-t">${esc(it.time)}</span>` : '';
  const rep = it.repeating ? '<span class="cc-r">↻</span>' : '';
  const imp = it.priority > 0 ? '<span class="cc-imp">!</span>' : '';
  return `<span class="${cls}" style="--c:${esc(it.color)}">${t}${imp}<span class="cc-l">${esc(it.title)}</span>${rep}</span>`;
}

function agendaRow(it) {
  const cls = 'cal-ag-item' + (it.done ? ' done' : it.expired ? ' exp' : it.grace ? ' grace' : it.past ? ' past' : '');
  const t = it.time ? esc(it.time) : '';
  const rep = it.repeating ? ' <span class="cc-r">↻</span>' : '';
  const list = `${it.emoji ? esc(it.emoji) + ' ' : ''}${esc(it.list)}`;
  return `<div class="${cls}" style="--c:${esc(it.color)}">` +
    `<span class="ag-t">${t}</span><span class="ag-l">${esc(it.title)}${rep}</span><span class="ag-w">${list}</span></div>`;
}

/** Build the calendar inside `root`. Returns { load }, which re-reads whatever month is in view. */
export function mountMonth(root) {
  if (!root) return null;
  root.innerHTML =
    '<header class="cal-head">' +
    '<button class="cal-nav" data-go="prev" type="button" aria-label="Previous month">&#8249;</button>' +
    '<div class="cal-title"></div>' +
    '<button class="cal-nav" data-go="next" type="button" aria-label="Next month">&#8250;</button>' +
    '</header>' +
    '<div class="cal-main"><div class="cal-gridwrap"><div class="cal-dow"></div><div class="cal-grid"></div></div>' +
    '<aside class="cal-agenda"></aside></div>';
  const $ = (s) => root.querySelector(s);
  let month = null;   // 'YYYY-MM' in view; null = let the server pick the current one
  let sel = null;     // selected day 'YYYY-MM-DD'
  let data = null;    // the served month: { months, today, dow }

  // The agenda shows the selected day (today by default) — items or not; an empty day is just its
  // header.
  function agendaHtml(m) {
    const days = m.weeks.flat();
    const day = days.find((c) => c.date === (sel || data.today)) || days.find((c) => c.inMonth);
    if (!day) return '';
    return `<section><h3 class="${day.today ? 'today' : ''}">${esc(day.label)}</h3>${day.items.map(agendaRow).join('')}</section>`;
  }

  function render() {
    if (!data) return;
    const m = data.months[0];
    $('.cal-title').textContent = m.label;
    $('.cal-dow').innerHTML = data.dow.map((d) => `<span>${esc(d)}</span>`).join('');
    const selDate = sel || data.today;
    $('.cal-grid').innerHTML = m.weeks.map((w) => w.map((c) => {
      const cls = 'cal-cell' + (c.inMonth ? '' : ' out') + (c.today ? ' today' : '') +
        (c.date === selDate ? ' sel' : '');
      const dots = c.items.slice(0, 4).map((it) => `<i style="background:${esc(it.color)}"></i>`).join('');
      return `<div class="${cls}" data-date="${esc(c.date)}">` +
        `<span class="cal-daynum">${c.day}</span>` +
        `<div class="cal-chips">${c.items.map(chip).join('')}</div>` +
        `<div class="cal-dots">${dots}</div></div>`;
    }).join('')).join('');
    $('.cal-agenda').innerHTML = agendaHtml(m);
  }

  async function load() {
    let d;
    try { d = await (await fetch('/api/calendar' + (month ? '?month=' + month : ''))).json(); } catch (_) { return; }
    if (!d || d.error || !d.months || !d.months.length) return;
    data = d;
    month = d.months[0].month;
    render();
  }

  root.querySelector('.cal-head').addEventListener('click', (e) => {
    const b = e.target.closest('.cal-nav');
    if (!b || !data) return;
    month = data.months[0][b.dataset.go];
    sel = null;
    load();
  });
  $('.cal-grid').addEventListener('click', (e) => {
    const cell = e.target.closest('.cal-cell');
    if (!cell) return;
    sel = cell.dataset.date;
    render();
  });
  load();
  return { load };
}
