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

function html(d) {
  const rem = (d.reminders || []).map((r) =>
    `<li><input class="cb" type="checkbox" data-c="reminder" data-id="${esc(r.id)}" aria-label="complete">` +
    `<span class="txt">${esc(r.text)}</span>${r.due ? `<span class="due">${esc(fmtDue(r.due))}</span>` : ''}</li>`).join('');
  let out = `<section><h3>Reminders</h3><ul>${rem || '<li class="empty">Nothing due</li>'}</ul>` +
    `<div class="add"><input type="text" placeholder="New reminder" data-add="reminder">` +
    `<input type="datetime-local" data-due="reminder" aria-label="when"></div></section>`;
  for (const l of d.lists || []) {
    const items = (l.items || []).map((i) =>
      `<li><input class="cb" type="checkbox" data-c="item" data-id="${esc(i.id)}" aria-label="check off">` +
      `<span class="txt">${esc(i.text)}</span></li>`).join('');
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

function wire(el) {
  el.querySelectorAll('.cb').forEach((cb) => cb.addEventListener('change', () =>
    post('/api/todos/complete', { kind: cb.dataset.c, id: cb.dataset.id })));
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
