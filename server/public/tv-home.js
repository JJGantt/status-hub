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

/**
 * Which session this shows: the newest RUNNING one, falling back to the newest closed-but-resumable
 * one when nothing is running.
 *
 * Newest by `started`, which is also how every surface numbers them out loud — so "session one" and
 * the panel agree. Not by `last_seen`: a reconcile tick touches every row every 30s, so that order
 * reshuffles between reads and the panel would swap sessions on its own.
 */
const newest = (d) => (d.resident || [])[0] || (d.evicted || [])[0] || null;

function render(d) {
  const head = document.getElementById('hw-sess-head');
  const reply = document.getElementById('hw-sess-reply');
  if (!head || !reply) return;
  const s = newest(d);
  // Nothing running and nothing parked is a real state, and an empty panel is its honest rendering.
  if (!s) { head.innerHTML = ''; reply.textContent = ''; return; }
  head.innerHTML =
    `<span class="hw-sess-dot${s.working ? '' : ' idle'}"></span>` +
    `<span class="hw-sess-name">${esc(s.custom_title || s.label || s.repo)}</span>` +
    `<span class="hw-sess-where">${esc(s.repo)} · ${s.worker === 'desk' ? 'Mac' : 'Pi'}</span>`;
  // textContent, not innerHTML: a reply is a model's prose and may hold anything that looks like
  // markup. The panel scrolls rather than truncating — however long the answer is, it is the answer.
  reply.textContent = (s.last_reply || '').trim();
}

async function load() {
  try { render(await (await fetch('/api/sessions')).json()); }
  catch (_) { /* a failed poll leaves the last frame up; the next one reconciles */ }
}

load();
setInterval(load, REFRESH_MS);
