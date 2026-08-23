// Project picker — start a Claude session on the Mac from the phone.
//
// Tapping one enqueues a desk command; the Mac's orchestrator opens a Terminal running
// `claude --remote-control <name>` and the session shows up in the Claude app, where the actual
// work happens. This pane only starts it — a clean session in the right directory, from anywhere.
//
// Everything in ~/repos is listed, git checkout or not: the branch chip and dirty dot simply don't
// render for a plain directory.
//
// Self-fetching (NOT part of the status stream), like the todo pane. No-ops where #repospane is
// absent (kiosk / mac / page).
import { esc } from '../shared.js';

let mounted = false;
let desk = { online: false };

// 'now' / '20m' / '3h' / '5d' — how long ago this was last touched (HEAD commit for a repo, the
// directory's mtime otherwise).
function ago(iso) {
  if (!iso) return '';
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 90) return 'now';
  if (s < 3600) return Math.round(s / 60) + 'm';
  if (s < 86400) return Math.round(s / 3600) + 'h';
  return Math.round(s / 86400) + 'd';
}

// Nearly everything sits on main, so that chip would just be a column of identical noise — show
// the branch only when it's something you'd want to know before opening a session there. A
// non-repo directory has no branch at all and renders the same as a plain `main`.
const notable = (b) => !!b && b !== 'main' && b !== 'master';

function html(d) {
  const rows = (d.repos || []).map((r) =>
    `<li data-path="${esc(r.path)}">` +
      `<div class="rp-main"><span class="rp-name">${esc(r.name)}</span>` +
      `<span class="rp-meta">${notable(r.branch) ? `<span class="rp-branch">${esc(r.branch)}</span>` : ''}` +
      `${r.dirty ? '<span class="rp-dirty" title="uncommitted changes"></span>' : ''}</span></div>` +
      `<span class="rp-age">${esc(ago(r.last_active))}</span>` +
    '</li>').join('');
  const off = d.desk && d.desk.online ? '' :
    '<div class="rp-off">Mac is asleep — nothing to launch into</div>';
  return `<div class="repos${d.desk && d.desk.online ? '' : ' off'}"><h3>Start a session</h3>${off}` +
    `<ul>${rows || '<li class="empty">No repos published</li>'}</ul></div>`;
}

async function load() {
  const el = document.getElementById('repospane');
  if (!el) return;
  let d;
  try { d = await (await fetch('/api/repos')).json(); } catch (_) { return; }
  if (!d || d.error) return;
  desk = d.desk || { online: false };
  el.innerHTML = html(d);
  wire(el);
}

// Enqueue, then watch the command row until the Mac reports back. The launch itself is realtime
// (~1s); the ceiling here only exists so a wedged daemon can't leave the row spinning forever.
async function launch(li) {
  if (li.dataset.say) return;   // a launch is in flight, or its result is still on screen
  const say = (cls, text) => { li.className = cls; li.dataset.say = text; };
  say('busy', 'Opening…');
  try {
    const r = await (await fetch('/api/repos/open', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: li.dataset.path }),
    })).json();
    if (!r.id) throw new Error(r.error || 'failed');
    for (let i = 0; i < 20; i++) {                       // ~20s ceiling
      await new Promise((res) => setTimeout(res, 1000));
      const c = await (await fetch('/api/repos/cmd/' + encodeURIComponent(r.id))).json();
      if (c.status === 'done') { say('ok', 'Open on the Mac'); break; }
      if (c.status === 'error' || c.status === 'expired') { say('bad', c.detail || c.status); break; }
      if (i === 19) say('bad', 'No response from the Mac');
    }
  } catch (e) {
    say('bad', String(e.message || e));
  }
  setTimeout(() => { li.className = ''; delete li.dataset.say; }, 4000);
}

function wire(el) {
  el.querySelectorAll('li[data-path]').forEach((li) =>
    li.addEventListener('click', () => { if (desk.online) launch(li); }));
}

export function render() {
  if (mounted) return;                                // self-refreshing; not driven by the status stream
  if (!document.getElementById('repospane')) return;  // absent on kiosk/mac/page → no-op
  mounted = true;
  load();
  window.addEventListener('focus', load);
}
