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
import { esc, PIN_SVG } from '../shared.js';
import { makeRecorder } from '../voiceagent.js';

let mounted = false;
let desk = { online: false };
let machines = { mac: false, pi: false };
let recorder = null;      // one shared recorder; only ever one repo is being dictated to
let armed = null;         // the <li> currently listening

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

// Live and parked sessions, above the project list. This is the "is something being worked on"
// question, and it belongs here because the answer is always about a repo.
//
// The two states are deliberately drawn differently rather than as one list with a label: a RESIDENT
// session is open on the Pi and reachable in the Claude app right now, an EVICTED one was closed to
// free the machine and has to be resumed first. Confusing them means tapping something expecting it
// to be live and finding it isn't.
function sessionsHtml(s) {
  if (!s) return '';
  const res = s.resident || [], ev = s.evicted || [], q = s.queued || [];
  if (!res.length && !ev.length && !q.length) return '';

  // Which session a SPOKEN follow-up lands in: the most recently active one unless he pinned another
  // by name (pickFocus in server.js). Worth marking because it moves as sessions take turns.
  const focus = s.focus || null;
  // The NUMBER is the point of showing it: it is how a session gets named out loud ("move session
  // three to the Mac"), and it has to be the same number the voice tools resolve — the server derives
  // both from one rule. The machine chip is here for the same reason: "the other machine" only means
  // something if you can see which one it is on.
  const line = (x, live) =>
    `<li class="sess${live ? ' live' : ''}${x.id === focus ? ' focus' : ''}" data-id="${esc(x.id)}">` +
      `<div class="sess-main">` +
        `<span class="sess-repo">` +
        (x.n ? `<span class="sess-n">${x.n}</span>` : '') +
        `${esc(x.label || x.repo)}` +
        (x.label && x.repo && x.label !== x.repo ? `<span class="sess-in">${esc(x.repo)}</span>` : '') +
          `<span class="sess-where">${x.worker === 'desk' ? 'Mac' : 'Pi'}</span>` +
          (x.id === focus ? '<span class="sess-focus" title="a spoken follow-up goes here">' + (s.pinned ? PIN_SVG : '') + 'follow-ups</span>' : '') +
        `</span>` +
        `<span class="sess-say">${esc((x.say || '').slice(0, 90))}</span>` +
      `</div>` +
      `<div class="sess-act">` +
        (live ? '<span class="sess-dot" title="open and reachable"></span>'
              : `<button class="sess-btn" data-act="resume">resume</button>`) +
        `<button class="sess-btn ghost" data-act="rename">name</button>` +
        (x.claude_session_id
          ? `<button class="sess-btn" data-act="transfer" title="close it here and resume it there with its whole conversation">\u2192 ${x.worker === 'desk' ? 'Pi' : 'Mac'}</button>`
          : '') +
        `<button class="sess-btn ghost" data-act="${live ? 'end' : 'forget'}">${live ? 'close' : '\u00d7'}</button>` +
      `</div>` +
    '</li>';

  let out = '<div class="sessions"><h3>Sessions';
  if (q.length) out += `<span class="sess-q">${q.length} queued</span>`;
  out += '</h3>';
  // The pointer outlives the session it named, so it can resolve to nothing at all. Say that plainly
  // rather than leaving no row marked, which looks the same as not having rendered the marker.
  if (!focus && (res.length || ev.length)) {
    out += '<div class="sess-nofocus">No session is holding follow-ups \u2014 say which one, or start something.</div>';
  }
  out += '<ul>';
  out += res.map((x) => line(x, true)).join('');
  out += ev.map((x) => line(x, false)).join('');
  out += q.map((x) =>
    `<li class="sess queued"><div class="sess-main"><span class="sess-repo">${esc(x.repo)}</span>` +
    `<span class="sess-say">waiting for a slot</span></div></li>`).join('');
  return out + '</ul></div>';
}

function html(d) {
  // Two targets, revealed on tap rather than shown always: the row is a list of projects first, and a
  // launcher second. Tapping picks the project; the second tap picks the machine AND starts recording,
  // so choosing a machine is never a separate decision from saying what you want done.
  const targets =
    `<span class="rp-go">` +
      `<button class="rp-t" data-target="pi" title="Run on the Pi">\u{1F353}</button>` +
      `<button class="rp-t" data-target="mac" title="Run on the Mac">\u{1F34E}</button>` +
    `</span>`;
  const rows = (d.repos || []).map((r) =>
    `<li data-path="${esc(r.path)}">` +
      `<div class="rp-main"><span class="rp-name">${esc(r.name)}</span>` +
      `<span class="rp-meta">${notable(r.branch) ? `<span class="rp-branch">${esc(r.branch)}</span>` : ''}` +
      `${r.dirty ? '<span class="rp-dirty" title="uncommitted changes"></span>' : ''}</span></div>` +
      `<span class="rp-age">${esc(ago(r.last_active))}</span>` + targets +
    '</li>').join('');
  // Only warn when NOTHING can take the work. The Mac being asleep is normal and no longer blocking,
  // since the Pi is the default target — saying "Mac is asleep" then would be alarming about nothing.
  const m = d.machines || {};
  const off = (m.pi || m.mac) ? '' :
    '<div class="rp-off">Neither machine is reachable — nothing to launch into</div>';
  return sessionsHtml(d.sessions) +
    `<div class="repos${(m.pi || m.mac) ? '' : ' off'}${m.pi ? '' : ' no-pi'}${m.mac ? '' : ' no-mac'}">` +
    `<h3>Start a session</h3>${off}` +
    `<ul>${rows || '<li class="empty">No repos published</li>'}</ul></div>`;
}

async function load() {
  const el = document.getElementById('repospane');
  if (!el) return;
  let d;
  try { d = await (await fetch('/api/repos')).json(); } catch (_) { return; }
  if (!d || d.error) return;
  // Fetched alongside rather than folded into /api/repos: sessions change on their own schedule and
  // a failure to read them must not blank the project list, which is the pane's primary job.
  try { d.sessions = await (await fetch('/api/sessions')).json(); } catch (_) { d.sessions = null; }
  desk = d.desk || { online: false };
  machines = d.machines || { mac: desk.online, pi: false };
  el.innerHTML = html(d);
  wire(el);
}

// Enqueue, then watch the command row until the Mac reports back. The launch itself is realtime
// (~1s); the ceiling here only exists so a wedged daemon can't leave the row spinning forever.
async function launch(li, prompt, target) {
  if (li.dataset.say) return;   // a launch is in flight, or its result is still on screen
  const say = (cls, text) => { li.className = cls; li.dataset.say = text; };
  say('busy', `Opening on the ${target === 'mac' ? 'Mac' : 'Pi'}…`);
  try {
    const r = await (await fetch('/api/repos/open', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: li.dataset.path, target, ...(prompt ? { prompt } : {}) }),
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

// Tapping a repo DICTATES the session's opening message rather than launching bare. The session is
// going to want to know what you came for, and saying it while the terminal is still opening beats
// typing it into a fresh prompt on the Mac afterwards. Tap again to cancel.
//
// `dryWhen: () => true` is the whole trick: the recorder then posts to /api/voice-command?dry=1, which
// transcribes and returns the text INSTEAD of enqueueing it as a voice command — this is a prompt for
// a session, not something the voice worker should act on.
function beginDictation(li, target) {
  if (armed === li) { cancelDictation(); return; }
  if (armed) cancelDictation();
  armed = li;
  li.className = 'rec';
  li.dataset.say = target === 'mac' ? 'Listening… \u2192 Mac' : 'Listening… \u2192 Pi';
  recorder = makeRecorder({
    autoStop: true,                                  // trailing-silence stop, same as the voice FAB
    dryWhen: () => true,
    onStatus: (t) => { if (armed === li && t) li.dataset.say = t; },
    onTranscript: (text) => {
      const prompt = String(text || '').trim();
      armed = null; recorder = null;
      li.className = ''; delete li.dataset.say;
      // Nothing said → don't silently open a bare session; the tap was probably a mistake.
      if (!prompt) { li.className = 'bad'; li.dataset.say = 'Nothing heard'; 
        setTimeout(() => { li.className = ''; delete li.dataset.say; }, 2500); return; }
      launch(li, prompt, target);
    },
  });
  recorder.start();
}

function cancelDictation() {
  if (!armed) return;
  try { recorder && recorder.stop(); } catch (_) {}
  armed.className = ''; delete armed.dataset.say;
  armed = null; recorder = null;
}

async function sessionAction(li, act) {
  const id = li.dataset.id;
  // The name is asked for before anything is sent, so a cancelled prompt does nothing at all.
  let name;
  if (act === 'rename') {
    name = prompt('Name');
    if (!name || !name.trim()) return;
  }
  li.classList.add('busy');
  try {
    await fetch('/api/sessions/' + act, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(name ? { id, name: name.trim() } : { id }),
    });
  } catch (_) { /* the next load reconciles */ }
  // Resume, close and transfer are enacted on a machine asynchronously, so give it a moment before
  // re-reading rather than showing a state the machine has not reached yet. A transfer is the slowest
  // of them: it closes a session, uploads the last of the transcript and resumes it elsewhere.
  setTimeout(load, act === 'forget' ? 200 : act === 'transfer' ? 6000 : act === 'rename' ? 1200 : 2500);
}

function wire(el) {
  el.querySelectorAll('li.sess .sess-btn').forEach((b) =>
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      sessionAction(b.closest('li.sess'), b.dataset.act);
    }));
  el.querySelectorAll('li[data-path]').forEach((li) => {
    li.addEventListener('click', () => {
      // First tap opens the machine choice; tapping the row again closes it. Only one row at a time,
      // so the pane never shows two half-made decisions.
      const open = li.classList.contains('pick');
      el.querySelectorAll('li[data-path].pick').forEach((o) => o.classList.remove('pick'));
      if (!open) li.classList.add('pick');
    });
    li.querySelectorAll('.rp-t').forEach((b) =>
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        const target = b.dataset.target;
        if (!machines[target]) return;   // that machine is not reachable; do not queue into a void
        li.classList.remove('pick');
        beginDictation(li, target);
      }));
  });
}

// Called by the native app when a repo widget row is tapped (statushub://repo/<path>). The widget
// can't reach a microphone, so it hands the choice over and the recording happens here.
window.__startRepoSession = async (path) => {
  const el = document.getElementById('repospane');
  if (!el) return;
  try { window.__showPane && window.__showPane('repos'); } catch (_) {}
  if (!mounted) { mounted = true; }
  await load();
  const li = el.querySelector(`li[data-path="${CSS.escape(String(path))}"]`);
  if (!li) return;
  li.scrollIntoView({ block: 'center', behavior: 'smooth' });
  beginDictation(li, machines.pi ? 'pi' : 'mac');
};

export function render() {
  if (mounted) return;                                // self-refreshing; not driven by the status stream
  if (!document.getElementById('repospane')) return;  // absent on kiosk/mac/page → no-op
  mounted = true;
  load();
  window.addEventListener('focus', load);
}
