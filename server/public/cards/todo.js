// Lists / notes — the phone wall's fifth swipe pane. Voice/MCP writes these; this pane shows them and
// lets you check things off and add. Fetches its own data (NOT part of the status stream), and
// refreshes on mount, after any edit, and on window focus. No-ops where #todopane is absent (kiosk/mac/page).
//
// "Due" at the top is a VIEW, not a list: every dated item from every list, soonest first. There is no
// reminders table any more — a reminder is just an item with a due date (migration 00056) — so a dated
// Amazon item shows up both here and on Amazon, and clearing it in either place is the same row.
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

// One row. No checkbox: finishing or deleting something takes a deliberate left-swipe, so it can't
// happen from a stray tap. The gesture is pure CSS — each row is its own tiny horizontal scroller
// with scroll-snap (see app.css), so the BROWSER owns the drag physics, momentum, rubber-banding and
// snapping. There is no pointer maths here, which is the whole point: hand-rolled swipe handling
// fights the browser and loses. The text stays put (the row is sticky) and the buttons slide in.
//
// ONE swipe reveals TWO buttons — ✓ done and ✕ delete — rather than a second gesture in the opposite
// direction. A right-swipe would have to start the scroller pre-scrolled, which means scripting a
// position on every render and losing the property that makes this reliable. Revealing a choice
// costs nothing and keeps the physics the browser's. ✓ sits nearer the text because it is the
// common case; ✕ is further out, which is the right amount of extra deliberateness for a delete.
function row(id, inner, body = '', expired = false, heat = 0) {
  // The body is rendered but collapsed. Only rows whose text says more than their title carry one —
  // expanding a row to reveal exactly what was already on it would be a dead gesture.
  const detail = body ? `<div class="body">${esc(body)}</div>` : '';
  // `heat` comes from the server (1-3, escalating with how long it has been overdue). It exists
  // because the health bar's gold band floors at zero: once it is pinned there, a second neglected
  // item cannot show on the bar at all, so the row is what carries the growing cost.
  const hot = heat > 1 ? ` heat${heat}` : '';   // 1 is the free grace window; 2+ is actually costing
  return `<li class="sw${expired ? ' exp' : ''}${hot}${body ? ' has-body' : ''}" data-id="${esc(id)}">` +
    `<div class="sc">` +
      `<div class="row">${inner}</div>` +
      `<button class="done" aria-label="done" tabindex="-1">\u2713</button>` +
      `<button class="del" aria-label="delete" tabindex="-1">\u00d7</button>` +
    `</div>${detail}</li>`;
}

// One item's inner markup. `title` is the short label when there is one; the due chip appears on any
// dated item regardless of list, and says which list when shown in the cross-list Due view.
function itemLabel(i) { return (i.title && i.title.trim()) || i.text; }

function itemInner(i, withList) {
  const label = itemLabel(i);
  const where = withList ? `<span class="where">${esc(i.list_name)}</span>` : '';
  const when = i.scheduled_at || i.due;
  const due = when ? `<span class="due">${esc(fmtDue(when))}</span>` : '';
  // One of a recurring set. Every occurrence is its own row, so this says "there are more of these",
  // not "this one will come back".
  const rep = i.series_id ? '<span class="rep">\u21bb</span>' : '';
  const imp = i.priority > 0 ? '<span class="imp">!</span>' : '';
  return `${imp}<span class="txt">${esc(label)}</span>${where}${due}${rep}`;
}

// Full text is only worth revealing when it says more than the label already does.
function bodyFor(i) {
  const full = String(i.text || '').trim();
  return full && full !== itemLabel(i) ? full : '';
}

function html(d) {
  const list = d.due || [];
  const expired = list.filter((i) => i.expired).length;
  const due = list.map((i) => row(i.id, itemInner(i, true), bodyFor(i), i.expired, i.heat || 0)).join('');
  const count = expired ? `<span class="expcount">${expired} expired</span>` : '';
  let out = `<section><h3>Due ${count}</h3><ul>${due || '<li class="empty">Nothing due</li>'}</ul>` +
    `<div class="add"><input type="text" placeholder="New dated item" data-add="item" data-list="todo">` +
    `<input type="datetime-local" data-due="item" aria-label="when"></div></section>`;
  for (const l of d.lists || []) {
    const items = (l.items || []).map((i) => row(i.id, itemInner(i, false), bodyFor(i), i.expired)).join('');
    const mark = l.emoji ? `${esc(l.emoji)} ` : '';
    out += `<section><h3>${mark}${esc(l.name)}</h3><ul>${items || '<li class="empty">Empty</li>'}</ul>` +
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

// Tell the native shell the icon badge count. Inside the iOS app this page IS where items get
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
    // Some mutation endpoints return the resulting count; /clear deliberately doesn't (it answers on
    // the write so the widget can redraw sooner). setNativeBadge ignores a non-integer, and load()
    // re-reads /api/badge immediately after, so either way the badge lands correct.
    if (j) setNativeBadge(j.badge);
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
    // Tap opens the full text; the swipe reveals the buttons. Two different gestures, so revealing
    // detail can never be mistaken for finishing something. Guarded on the swipe having stayed put,
    // or the tap that ends a drag would also toggle the body.
    if (li.classList.contains('has-body')) {
      li.querySelector('.row').addEventListener('click', () => {
        if (sc.scrollLeft) return;
        li.classList.toggle('open');
      });
    }
    li.querySelector('.done').addEventListener('click', () =>
      post('/api/todos/complete', { id: li.dataset.id }));
    li.querySelector('.del').addEventListener('click', () =>
      post('/api/todos/clear', { id: li.dataset.id }));
  });
  el.addEventListener('pointerdown', (e) => { if (!e.target.closest('li.sw')) closeAll(el); });
  el.querySelectorAll('input[data-add]').forEach((inp) => inp.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    const text = inp.value.trim();
    if (!text) return;
    const body = { text, list: inp.dataset.list };
    // The Due section's composer has a datetime beside it; every other section's doesn't. Same
    // endpoint either way — a due date is a field on the item, not a different kind of thing.
    const due = inp.parentElement.querySelector('input[data-due]');
    if (due && due.value) { body.due = due.value; due.value = ''; }
    inp.value = '';
    post('/api/todos/add', body);
  }));
}

// Called by the native app when a widget row's › option is tapped (statushub://item/<id> →
// ItemLaunch). Brings that item into view and opens its full text — the widget only ever had room
// for the title, so "open it" has to mean "show me the rest".
window.__showItem = async (id) => {
  const el = document.getElementById('todopane');
  if (!el) return;
  if (!mounted) { mounted = true; await load(); } else { await load(); }
  // Land on the pane that holds it before hunting for the row — scrollIntoView inside a pane that
  // isn't the visible one does nothing useful.
  try { window.__showPane && window.__showPane('todo'); } catch (_) {}
  const li = el.querySelector(`li.sw[data-id="${CSS.escape(String(id))}"]`);
  if (!li) return;
  li.classList.add('open', 'flash');
  li.scrollIntoView({ block: 'center', behavior: 'smooth' });
  setTimeout(() => li.classList.remove('flash'), 1600);
};

export function render() {
  if (mounted) return;                              // self-refreshing; not driven by the status stream
  if (!document.getElementById('todopane')) return; // absent on kiosk/mac/page → no-op
  mounted = true;
  load();
  window.addEventListener('focus', load);
}
