// The session wall: which sessions are running, and what the focused one last said.
//
// DISPLAY ONLY. There is no interaction on this screen and there never will be — it is a TV across a
// room, and eventually a watch. Everything here is driven by voice, so what it has to do is show the
// list Jared is naming from ("focus the second session") and the answer that came back.
//
// Its own module, loaded only by tv-session-focus.html. The live wall shares nothing with it.
import { esc } from './shared.js';

const REFRESH_MS = 5000;

/**
 * What a tab is called.
 *
 * The REPO, unless Jared named the session himself. A generated title is long and a router label
 * describes a job — neither fits a tab, and both make the row unreadable at a glance. `custom_title`
 * is only ever set by a rename he did, which is why it is stored apart from `label`.
 */
const tabName = (s) => s.custom_title || s.repo;

function render(d) {
  const tabs = document.getElementById('sf-tabs');
  const body = document.getElementById('sf-body');
  if (!tabs || !body) return;

  const live = d.resident || [];
  const focus = d.focus || null;

  tabs.innerHTML = live.map((s) =>
    `<span class="sf-tab${s.id === focus ? ' on' : ''}">` +
      `<span class="sf-dot${s.working ? '' : ' idle'}"></span>` +
      `<span class="sf-n">${s.n ?? ''}</span>` +
      `<span class="sf-name">${esc(tabName(s))}</span>` +
      `<span class="sf-where">${s.worker === 'desk' ? 'Mac' : 'Pi'}</span>` +
    '</span>').join('');

  // The focused session's last COMPLETED turn. Nothing is shown when nothing holds follow-ups —
  // an empty panel is the honest rendering of "no session is being talked to", and no tab is lit.
  const on = live.find((s) => s.id === focus);
  if (!on) { body.innerHTML = ''; return; }
  body.innerHTML =
    '<div class="sf-head">' +
      `<span class="sf-title">${esc(on.custom_title || on.label || on.repo)}</span>` +
      `<span class="sf-meta">${esc(on.repo)}</span>` +
    '</div>' +
    `<div class="sf-reply">${esc((on.last_reply || '').trim())}</div>`;
}

async function load() {
  try { render(await (await fetch('/api/sessions')).json()); }
  catch (_) { /* a failed poll leaves the last frame up; the next one reconciles */ }
}

load();
setInterval(load, REFRESH_MS);
