// Reminders / lists / notes — the phone wall's fifth swipe pane. Voice/MCP writes these; this pane shows
// them and lets you check things off and add. Fetches its own data (NOT part of the status stream), and
// refreshes on mount, after any edit, and on window focus. No-ops where #todopane is absent (kiosk/mac/page).
import { esc } from '../shared.js';

let mounted = false;
let busy = false;

// Local-naive due ('YYYY-MM-DD' or '...THH:MM') → compact '8/19' / '8/19 9a' label.
function fmtDue(due) {
  const m = String(due || '').match(/^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?/);
  if (!m) return esc(String(due || ''));
  let s = `${+m[2]}/${+m[3]}`;
  if (m[4] != null) {
    let h = +m[4]; const mm = m[5]; const ap = h < 12 ? 'a' : 'p'; let h12 = h % 12; if (h12 === 0) h12 = 12;
    s += ` ${h12}${mm === '00' ? '' : ':' + mm}${ap}`;
  }
  return s;
}

// One row. No checkbox: clearing something takes a deliberate left-swipe, so it can't happen from a
// stray tap. The gesture is pure CSS — each row is its own tiny horizontal scroller with scroll-snap
// (see app.css), so the BROWSER owns the drag physics, momentum, rubber-banding and snapping. There
// is no pointer maths here, which is the whole point: hand-rolled swipe handling fights the browser
// and loses. The text itself stays put (the row is sticky) and the X slides in over its right end.
function row(kind, id, inner) {
  return `<li class="sw" data-kind="${kind}" data-id="${esc(id)}">` +
    `<div class="sc">` +
      `<div class="row">${inner}</div>` +
      `<button class="del" aria-label="clear" tabindex="-1">\u00d7</button>` +
    `</div></li>`;
}

function html(d) {
  const rem = (d.reminders || []).map((r) => row('reminder', r.id,
    `<span class="txt">${esc(r.text)}</span>${r.due ? `<span class="due">${esc(fmtDue(r.due))}</span>` : ''}`)).join('');
  let out = `<section><h3>Reminders</h3><ul>${rem || '<li class="empty">Nothing due</li>'}</ul>` +
    `<div class="add"><input type="text" placeholder="New reminder" data-add="reminder">` +
    `<input type="datetime-local" data-due="reminder" aria-label="when"></div></section>`;
  for (const l of d.lists || []) {
    const items = (l.items || []).map((i) => row('item', i.id, `<span class="txt">${esc(i.text)}</span>`)).join('');
    out += `<section><h3>${esc(l.name)}</h3><ul>${items || '<li class="empty">Empty</li>'}</ul>` +
      `<div class="add"><input type="text" placeholder="Add to ${esc(l.name)}" data-add="item" data-list="${esc(l.name)}"></div></section>`;
  }
  const notes = (d.notes || []).map((n) =>
    `<details><summary>${esc(n.name)}</summary><pre>${esc(n.content || '')}</pre></details>`).join('');
  if (notes) out += `<section><h3>Notes</h3>${notes}</section>`;
  return `<div class="todo">${out}</div>`;
}

async function load() {
  const el = document.getElementById('todopane');
  if (!el) return;
  let d;
  try { d = await (await fetch('/api/todos')).json(); } catch (_) { return; }
  if (!d || d.error) return;
  el.innerHTML = html(d);
  wire(el);
  // Also correct the badge whenever the pane is (re)loaded — covers a clear made elsewhere, e.g. by
  // voice, that this device never saw.
  fetch('/api/badge').then((r) => r.json()).then((b) => setNativeBadge(b.badge)).catch(() => {});
}

// Tell the native shell the icon badge count. Inside the iOS app this page IS where reminders get
// cleared, so nothing else knows it happened — and the server's badge-only push can't carry the news
// reliably (iOS throttles background pushes and drops them in practice). A direct message to the app
// updates the icon immediately. No-op in a plain browser.
function setNativeBadge(n) {
  if (!Number.isInteger(n)) return;
  try { window.webkit?.messageHandlers?.badge?.postMessage(n); } catch (_) {}
}

// The to-do widget draws this same list, and a widget only redraws when its timeline is rebuilt. An
// edit here is a deliberate act, so nudge it straight away — unlike core.js's macro nudge there's
// nothing to throttle, since this only fires on an actual tap. No-op in a plain browser.
function reloadNativeWidgets() {
  try { window.webkit?.messageHandlers?.reloadWidgets?.postMessage(1); } catch (_) {}
}

async function post(path, body) {
  if (busy) return;
  busy = true;
  try {
    const r = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const j = await r.json().catch(() => null);
    if (j) setNativeBadge(j.badge);        // the mutation endpoints return the resulting count
  } catch (_) { /* leave the row; next load reconciles */ }
  finally { busy = false; }
  reloadNativeWidgets();
  await load();
}

// Tapping elsewhere closes an open row. This is the ONLY scripted part of the gesture — the swipe
// itself is the browser's own scrolling.
function closeAll(el, except) {
  el.querySelectorAll('li.sw .sc').forEach((sc) => {
    if (sc !== except && sc.scrollLeft) sc.scrollTo({ left: 0, behavior: 'smooth' });
  });
}

function wire(el) {
  el.querySelectorAll('li.sw').forEach((li) => {
    const sc = li.querySelector('.sc');
    sc.addEventListener('pointerdown', () => closeAll(el, sc));   // only one open at a time
    li.querySelector('.del').addEventListener('click', () =>
      post('/api/todos/clear', { kind: li.dataset.kind, id: li.dataset.id }));
  });
  el.addEventListener('pointerdown', (e) => { if (!e.target.closest('li.sw')) closeAll(el); });
  el.querySelectorAll('input[data-add]').forEach((inp) => inp.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    const text = inp.value.trim();
    if (!text) return;
    const kind = inp.dataset.add;
    const body = { kind, text };
    if (kind === 'item') body.list = inp.dataset.list;
    if (kind === 'reminder') { const due = el.querySelector('input[data-due="reminder"]'); if (due && due.value) body.due = due.value; }
    inp.value = '';
    post('/api/todos/add', body);
  }));
}

export function render() {
  if (mounted) return;                              // self-refreshing; not driven by the status stream
  if (!document.getElementById('todopane')) return; // absent on kiosk/mac/page → no-op
  mounted = true;
  load();
  window.addEventListener('focus', load);
}
