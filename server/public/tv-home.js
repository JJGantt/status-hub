// The home wall's own middle. Everything else on this page is a shared card that core.js already
// paints; only two things are this wall's: the day column it mounts, and the session panel.
//
// DISPLAY ONLY, like every wall. Nothing here is interactive and nothing here writes — voice starts
// sessions, voice focuses them, and this is where the answer comes back.
import { esc } from './shared.js';
import { mount } from './cards/dayline.js';

// The month grid is the calendar wall's; this column takes the day on its own, which is what
// `?day=1` serves.
mount(document.getElementById('cw-day'));

const REFRESH_MS = 5000;
const LIST_MAX = 5;      // enough to see what is running without the list becoming the column

/**
 * Which session the panel opens: the FOCUSED one — the session a spoken follow-up lands in, so what
 * the wall is showing and what he is about to talk to are the same session.
 *
 * `focus` is null when nothing has been dispatched or focused, or when the pointer names a session
 * that has since closed; then it falls back to the newest running one, so the panel says something
 * rather than nothing. The list marks whichever is being shown — one highlight meaning "this is the
 * answer below", never a second one claiming to mean focus, which the footer already carries.
 */
const shown = (d) => (d.resident || []).find((s) => s.id === d.focus) || (d.resident || [])[0]
  || (d.evicted || [])[0] || null;

// Running first, then parked, newest first within each — `n` is the number he says out loud, worked
// out by the server so every surface counts the same way. Ordering the list by it means "the second
// session" points at the second line.
const listed = (d) => [...(d.resident || []), ...(d.evicted || [])]
  .sort((a, b) => (a.n || 99) - (b.n || 99)).slice(0, LIST_MAX);

const name = (s) => s.custom_title || s.label || s.repo;

function render(d) {
  const list = document.getElementById('hw-sess-list');
  const head = document.getElementById('hw-sess-head');
  const reply = document.getElementById('hw-sess-reply');
  if (!list || !head || !reply) return;
  const on = shown(d);

  list.innerHTML = listed(d).map((s) =>
    `<div class="hw-row${on && s.id === on.id ? ' on' : ''}${s.status === 'resident' ? '' : ' parked'}">` +
      `<span class="hw-sess-dot${s.working ? '' : ' idle'}"></span>` +
      `<span class="hw-row-n">${s.n ?? ''}</span>` +
      `<span class="hw-row-name">${esc(name(s))}</span>` +
      `<span class="hw-row-where">${s.worker === 'desk' ? 'Mac' : 'Pi'}</span>` +
    '</div>').join('');

  // Nothing running and nothing parked is a real state, and an empty panel is its honest rendering.
  if (!on) { head.innerHTML = ''; reply.textContent = ''; return; }
  head.innerHTML = `<span class="hw-sess-name">${esc(name(on))}</span>` +
    `<span class="hw-sess-where">${esc(on.repo)} · ${on.worker === 'desk' ? 'Mac' : 'Pi'}</span>`;
  // textContent, not innerHTML: a reply is a model's prose and may hold anything that looks like
  // markup. The panel scrolls rather than truncating — however long the answer is, it is the answer.
  reply.textContent = (on.last_reply || '').trim();
}

async function load() {
  try { render(await (await fetch('/api/sessions')).json()); }
  catch (_) { /* a failed poll leaves the last frame up; the next one reconciles */ }
}

load();
setInterval(load, REFRESH_MS);
