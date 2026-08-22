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

// One row. No checkbox: clearing something is a deliberate left-swipe that reveals an X, so it
// can't happen from a stray tap the way a checkbox could. The X sits UNDER the row and is revealed
// by sliding the row off it, which is why .row needs an opaque background.
function row(kind, id, inner) {
  return `<li class="sw" data-kind="${kind}" data-id="${esc(id)}">` +
    `<div class="row">${inner}</div>` +
    `<button class="del" aria-label="delete" tabindex="-1">\u00d7</button></li>`;
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
}

async function post(path, body) {
  if (busy) return;
  busy = true;
  try { await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); }
  catch (_) { /* leave the row; next load reconciles */ }
  finally { busy = false; }
  await load();
}

// Swipe-to-delete. Pointer events so it works with a finger and a trackpad alike.
// The gesture commits to an axis on the first few px: if the drag is more vertical than horizontal
// it is a scroll, and we bail so the list still scrolls normally under the finger.
const OPEN_PX = 72;        // must match .del width in app.css
const COMMIT_PX = 34;      // dragged past this on release -> stay open

function closeAll(el, except) {
  el.querySelectorAll('li.sw.open').forEach((li) => { if (li !== except) li.classList.remove('open'); });
}

function wireSwipe(el) {
  el.querySelectorAll('li.sw').forEach((li) => {
    const row = li.querySelector('.row');
    let x0 = 0, y0 = 0, dx = 0, axis = null, dragging = false;

    const move = (e) => {
      if (!dragging) return;
      dx = e.clientX - x0;
      if (!axis) {
        const dy = e.clientY - y0;
        if (Math.abs(dx) < 6 && Math.abs(dy) < 6) return;      // too small to tell yet
        axis = Math.abs(dx) > Math.abs(dy) ? 'x' : 'y';
        if (axis === 'y') return end(e);                        // it's a scroll — let go
        row.style.transition = 'none';
      }
      const base = li.classList.contains('open') ? -OPEN_PX : 0;
      row.style.transform = `translateX(${Math.max(-OPEN_PX, Math.min(0, base + dx))}px)`;
    };

    const end = (e) => {
      if (!dragging) return;
      dragging = false;
      try { row.releasePointerCapture(e.pointerId); } catch (_) {}
      row.removeEventListener('pointermove', move);
      row.style.transition = '';
      row.style.transform = '';                                 // hand back to the CSS class
      if (axis === 'x') {
        const wasOpen = li.classList.contains('open');
        const open = wasOpen ? dx < COMMIT_PX : dx < -COMMIT_PX;
        closeAll(el, li);
        li.classList.toggle('open', open);
      }
      axis = null;
    };

    row.addEventListener('pointerdown', (e) => {
      if (e.button != null && e.button !== 0) return;
      dragging = true; axis = null; dx = 0; x0 = e.clientX; y0 = e.clientY;
      try { row.setPointerCapture(e.pointerId); } catch (_) {}
      row.addEventListener('pointermove', move);
    });
    row.addEventListener('pointerup', end);
    row.addEventListener('pointercancel', end);

    // Clears it — the one and only "dealt with" state, same as the notification's Done button and
    // the voice tools. Soft, so the row survives its recovery window before being purged.
    li.querySelector('.del').addEventListener('click', () =>
      post('/api/todos/clear', { kind: li.dataset.kind, id: li.dataset.id }));
  });

  // Tapping anywhere else puts an open row away.
  el.addEventListener('pointerdown', (e) => {
    if (!e.target.closest('li.sw')) closeAll(el);
  });
}

function wire(el) {
  wireSwipe(el);
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
