// The phone/desktop calendar page — a month grid + day agenda painted from /api/calendar, which
// ships the finished grid (cells, chips, colors, time labels). READ-ONLY by charter: voice/MCP and
// the todo pane do the writing; this surface only shows what has a date on it.
//
// The TV has its own wall page (tv-calendar.html + tv-calendar.js); this one is the interactive
// surface — navbar, month paging, tap a day to see it in the agenda. Not on the status stream (it
// renders none of it); it takes `/api/list-stream`, which pushes when a dated item changes.
import { esc, liveStream } from './shared.js';
import { mountNavbar } from './navbar.js';

let month = null;   // 'YYYY-MM' in view; null = let the server pick the current one
let sel = null;     // selected day 'YYYY-MM-DD'
let data = null;    // the served month: { month, label, prev, next, weeks } (+ today/dow beside it)

function chip(it) {
  const cls = 'cal-chip' + (it.done ? ' done' : it.expired ? ' exp' : it.grace ? ' grace' : it.past ? ' past' : '');
  const t = it.time ? `<span class="cc-t">${esc(it.time)}</span>` : '';
  const rep = it.repeating ? '<span class="cc-r">↻</span>' : '';
  return `<span class="${cls}" style="--c:${esc(it.color)}">${t}<span class="cc-l">${esc(it.title)}</span>${rep}</span>`;
}

function agendaRow(it) {
  const cls = 'cal-ag-item' + (it.done ? ' done' : it.expired ? ' exp' : it.grace ? ' grace' : it.past ? ' past' : '');
  const t = it.time ? esc(it.time) : '';
  const rep = it.repeating ? ' <span class="cc-r">↻</span>' : '';
  const list = `${it.emoji ? esc(it.emoji) + ' ' : ''}${esc(it.list)}`;
  return `<div class="${cls}" style="--c:${esc(it.color)}">` +
    `<span class="ag-t">${t}</span><span class="ag-l">${esc(it.title)}${rep}</span><span class="ag-w">${list}</span></div>`;
}

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
  document.getElementById('cal-title').textContent = m.label;
  document.getElementById('cal-dow').innerHTML = data.dow.map((d) => `<span>${esc(d)}</span>`).join('');
  const selDate = sel || data.today;
  document.getElementById('cal-grid').innerHTML = m.weeks.map((w) => w.map((c) => {
    const cls = 'cal-cell' + (c.inMonth ? '' : ' out') + (c.today ? ' today' : '') +
      (c.date === selDate ? ' sel' : '');
    const dots = c.items.slice(0, 4).map((it) => `<i style="background:${esc(it.color)}"></i>`).join('');
    return `<div class="${cls}" data-date="${esc(c.date)}">` +
      `<span class="cal-daynum">${c.day}</span>` +
      `<div class="cal-chips">${c.items.map(chip).join('')}</div>` +
      `<div class="cal-dots">${dots}</div></div>`;
  }).join('')).join('');
  document.getElementById('cal-agenda').innerHTML = agendaHtml(m);
}

async function load() {
  let d;
  try { d = await (await fetch('/api/calendar' + (month ? '?month=' + month : ''))).json(); } catch (_) { return; }
  if (!d || d.error || !d.months || !d.months.length) return;
  data = d;
  month = d.months[0].month;
  render();
}

mountNavbar();
document.getElementById('cal-prev').addEventListener('click', () => { if (data) { month = data.months[0].prev; sel = null; load(); } });
document.getElementById('cal-next').addEventListener('click', () => { if (data) { month = data.months[0].next; sel = null; load(); } });
document.getElementById('cal-grid').addEventListener('click', (e) => {
  const cell = e.target.closest('.cal-cell');
  if (!cell) return;
  sel = cell.dataset.date;
  render();
});
window.addEventListener('focus', load);
// Voice edits arrive by push — the hub emits `lists` off its Supabase realtime subscription the
// moment a dated item or a list changes. `load()` re-reads whatever month is in view, so paging is
// preserved. liveStream rather than a bare EventSource: this stream can legitimately carry no data
// for hours, so only the server's `ping` distinguishes quiet from dead.
liveStream('/api/list-stream', { lists: load });
load();
