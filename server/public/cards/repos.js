// Project picker — start a Claude session on the Mac from the phone.
//
// Tapping one enqueues a desk command; the Mac's orchestrator opens a Terminal running
// `claude --remote-control <name>` and the session shows up in the Claude app, where the actual
// work happens. The launcher only starts it — a clean session in the right directory, from anywhere.
//
// Above the projects is the list of sessions already running or parked, and a row of it opens that
// session in place of the list: its last prompt and reply, the turn in flight, and a composer that
// answers it (openSession, below).
//
// Everything in ~/repos is listed, git checkout or not: the branch chip and dirty dot simply don't
// render for a plain directory.
//
// Self-fetching (NOT part of the status stream), like the todo pane. No-ops where #repospane is
// absent (/page). Every wall's markup carries it, hidden on the kiosk, so it mounts there too.
import { esc, md, mdInline, PIN_SVG, liveStream, threadScroll, syncKeyed, reportPageError } from '../shared.js';
import { makeRecorder, bindMic } from '../voiceagent.js';
import { speak, stopSpeaking, speaking, paused, pauseSpeaking, resumeSpeaking } from '../speak.js';
import { openHandoff } from '../handoff.js';
import { openScreen } from '../screen.js';
import { mountContent, mountLive } from '../sessiontabs.js';

let mounted = false;
let desk = { online: false };
let machines = { mac: false, pi: false };
let recorder = null;      // one shared recorder; only ever one repo is being dictated to
let armed = null;         // the <li> currently listening
let rows = [];            // every row of the last /api/sessions payload, running and parked
let last = null;          // the last list payload load() drew, so showList can paint before refetching
let cur = null;           // the session open in place of the list (openSession), or null for the list
let opening = 0;          // counts openSession calls, so only the latest one paints
let allParked = false;    // the list was scrolled to its end, so it lists every parked session, not the recent ones
// Pictures queued for the next message, as {url, name}: a local object URL to show, and the hub's
// object name once it has landed. Cleared when they go, so a failed send keeps them.
let shots = [];

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
// Running and parked rows are drawn alike: words sent to a parked session resume it wherever it
// lives (`/api/sessions/followup`), and moving one is asked of the session itself, so neither state
// needs a control of its own.
function sessionsHtml(s) {
  if (!s) return '';
  const res = s.resident || [], ev = s.evicted || [];
  if (!res.length && !ev.length) return '';

  // The machine is the bar on the row's right edge (`--mc`), so the name carries only the repo.
  // The × HIDES the row from every surface's list (`/api/sessions/hide`); the session itself is
  // untouched and the orchestrator still sees it, and anything new in it brings the row back.
  const line = (x, live) =>
    `<li class="sess${live ? ' live' : ''}${x.unread ? ' unread' : ''}${x.working ? ' working' : ''}${!x.working && x.background ? ' bg' : ''}${x.incident ? ' incident' : ''}${x.codex ? ' codex' : ''}${x.prompt ? ' asking' : ''}" data-id="${esc(x.id)}"${x.machine_color ? ` style="--mc:${esc(x.machine_color)}"` : ''}>` +
      `<div class="sess-main">` +
        `<span class="sess-repo">` +
        (x.pinned ? PIN_SVG : '') + `${esc(x.label || x.repo)}` +
        (x.label && x.repo && x.label !== x.repo ? `<span class="sess-in">${esc(x.repo)}</span>` : '') +
        `</span>` +
        `<span class="sess-say">${x.at ? `<span class="sess-at">${esc(ago(x.at))}</span>` : ''}${esc((x.prompt ? x.prompt.line : (x.say || '')).slice(0, 90))}</span>` +
      `</div>` +
      `<button class="sess-x" data-act="hide" aria-label="Hide">\u00d7</button>` +
    '</li>';

  let out = '<div class="sessions"><h3>Sessions</h3><ul>';
  // In the server's `n` order, running and parked interleaved: pins first, then by activity alone
  // (buildSessions), the same order every other surface lists them in.
  out += [...res, ...ev].sort((a, b) => (a.n || 1e9) - (b.n || 1e9))
    .map((x) => line(x, x.status === 'resident')).join('');
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
  // Both buttons always launch: a machine that cannot take the work hands it to the next one, and Fly is
  // always there to be woken (server lib/failover.js). Only the dimming says which machine is down.
  const m = d.machines || {};
  return sessionsHtml(d.sessions) +
    `<div class="repos${m.pi ? '' : ' no-pi'}${m.mac ? '' : ' no-mac'}">` +
    `<h3>Start a session</h3>` +
    `<ul>${rows || '<li class="empty">No repos published</li>'}</ul></div>`;
}

async function load() {
  const el = document.getElementById('repospane');
  if (!el) return;
  let d;
  // A failure leaves whatever is drawn and is reported; the next look at the pane (it swiped into view,
  // the app back in front) tries again.
  try { d = await (await fetch('/api/repos')).json(); } catch (e) { console.error('sessions pane: /api/repos failed', e); return; }
  if (!d || d.error) { console.error('sessions pane: /api/repos answered', d && d.error); return; }
  // Fetched alongside rather than folded into /api/repos: sessions change on their own schedule and
  // a failure to read them must not blank the project list, which is the pane's primary job.
  try { d.sessions = await (await fetch('/api/sessions' + (allParked ? '?parked=all' : ''))).json(); } catch (_) { d.sessions = null; }
  if (d.sessions) keep(d.sessions);
  desk = d.desk || { online: false };
  machines = d.machines || { mac: desk.online, pi: false };
  last = d;
  if (cur) return;   // a session was opened while this was in flight; the list must not replace it
  // Nor while a row is being dictated to: redrawing detaches that row, and the recording then has no
  // row left to tap for sending or to show its status.
  if (armed) return;
  el.innerHTML = html(d);
  wire(el);
}

// The hub answers once a machine has taken it — the one asked for, or the next one that would — and names
// the machine; a launch it took but has not confirmed is then watched on its command row. The ceiling
// only exists so a wedged daemon can't leave the row spinning forever.
const MACHINE = { mac: 'the Mac', pi: 'the Pi', fly: 'Fly' };
async function launch(li, prompt, target) {
  if (li.dataset.say) return;   // a launch is in flight, or its result is still on screen
  const say = (cls, text) => { li.className = cls; li.dataset.say = text; };
  say('busy', `Opening on ${MACHINE[target]}…`);
  try {
    const r = await (await fetch('/api/repos/open', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: li.dataset.path, target, ...(prompt ? { prompt } : {}) }),
    })).json();
    if (!r.id) throw new Error(r.error || 'failed');
    const on = MACHINE[r.machine] || MACHINE[target];
    for (let i = 0; i < 20 && !r.confirmed; i++) {       // ~20s ceiling
      await new Promise((res) => setTimeout(res, 1000));
      const c = await (await fetch('/api/repos/cmd/' + encodeURIComponent(r.id))).json();
      if (c.status === 'done') { r.confirmed = true; break; }
      if (c.status === 'error' || c.status === 'expired') { say('bad', c.detail || c.status); break; }
      if (i === 19) say('bad', `No response from ${on}`);
    }
    if (r.confirmed) say('ok', `Open on ${on}`);
  } catch (e) {
    say('bad', String(e.message || e));
  }
  setTimeout(() => { li.className = ''; delete li.dataset.say; }, 4000);
}

// Tapping a repo DICTATES the session's opening message rather than launching bare. The session is
// going to want to know what you came for, and saying it while the terminal is still opening beats
// typing it into a fresh prompt on the Mac afterwards.
//
// PRESS TO START, PRESS TO SEND, like every press-to-talk button here: the machine's button starts it,
// and tapping the row (or that button) again sends it. Leaving for something else (another row, a
// session, the reset) CANCELS: that recording has lost what it was for.
//
// `dryWhen: () => true` is the whole trick: the recorder then posts to /api/voice-command?dry=1, which
// transcribes and returns the text INSTEAD of enqueueing it as a voice command — this is a prompt for
// a session, not something the voice worker should act on.
function beginDictation(li, target) {
  if (armed === li) { finishDictation(); return; }
  if (armed) cancelDictation();
  armed = li;
  li.className = 'rec';
  li.dataset.say = target === 'mac' ? 'Listening… → Mac' : 'Listening… → Pi';
  const rec = recorder = makeRecorder({
    dryWhen: () => true,
    onStatus: (t) => { if (armed === li && t) li.dataset.say = t; },
    // The recorder is idle again. If no transcript took the row first, the clip failed or was
    // refused: its status stays on the row briefly, and the row is let go so it can be used again.
    onState: (s) => {
      if (s !== 'idle' || armed !== li || recorder !== rec) return;
      armed = null; recorder = null;
      li.className = 'bad';
      setTimeout(() => { if (armed !== li) { li.className = ''; delete li.dataset.say; } }, 2500);
    },
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
  rec.start();
}

// The second press: end the recording and send it. The row keeps `armed` until the transcript (or
// the failure) arrives, so its status line shows the upload.
function finishDictation() {
  if (recorder) recorder.stop();
}

function cancelDictation() {
  if (!armed) return;
  try { recorder && recorder.cancel(); } catch (_) {}
  armed.className = ''; delete armed.dataset.say;
  armed = null; recorder = null;
}

async function sessionAction(li, act) {
  const id = li.dataset.id;
  // Gone at once: the hide is a single write and the pushed `sessions` frame confirms it.
  if (act === 'hide') li.remove();
  try {
    await fetch('/api/sessions/' + act, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id }),
    });
  } catch (e) { console.error('[sessions] ' + act + ' failed:', e && e.message); }
  setTimeout(load, 200);
}

function wire(el) {
  el.querySelectorAll('li.sess .sess-x').forEach((b) =>
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      sessionAction(b.closest('li.sess'), b.dataset.act);
    }));
  // The row itself opens the session; its buttons act on it without opening it.
  el.querySelectorAll('li.sess[data-id]').forEach((li) =>
    li.addEventListener('click', () => openSession(li.dataset.id)));
  el.querySelectorAll('li[data-path]').forEach((li) => {
    li.addEventListener('click', () => {
      if (armed === li) { finishDictation(); return; }   // recording into this row: the tap sends it
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
        li.classList.remove('pick');
        beginDictation(li, target);
      }));
  });
}

// ---- one session, opened in place of the list -------------------------------------------------
// What the watch's session page shows (apps/Watch/SessionsView.swift), at phone size: the
// conversation as the hub's one list of events — prompts, tool calls, what it says between them,
// replies — and a composer whose words go into that conversation — typed in when it is running,
// resumed with them when it is parked; the hub decides which (`/api/sessions/followup`).
//
// Everything here is keyed by the CONVERSATION (`claude_session_id`), not the row: a resume makes a
// new row for the same conversation, so the row the view was opened on can stop being the one that
// is talking. `cur.id` follows the conversation to whichever row is running it.

const nameOf = (x) => x.custom_title || x.label || x.repo || x.id;
const keyOfRow = (r) => r.claude_session_id || r.id;
const newMsgId = () => ((self.crypto && crypto.randomUUID)
  ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));

// The last /api/sessions payload's rows, from a fetch or a pushed `sessions` frame. With a session
// open it is how the view learns the conversation has moved to a new row (a resume), or the row's
// status changed — the header's facts. The conversation itself arrives as events and is never
// re-read for anything the list says.
function keep(payload) {
  if (last) last.sessions = payload;   // so the list showList paints from cache is as fresh as the stream
  rows = [...(payload.resident || []), ...(payload.evicted || [])];
  if (!cur) return;
  const now = rows.find((r) => r.status === 'resident' && keyOfRow(r) === cur.key)
           || rows.find((r) => r.id === cur.id);
  if (!now) return;
  const moved = now.id !== cur.id;
  cur.id = now.id;
  cur.head.prompt = now.prompt || null;
  cur.head.handoff = now.handoff || null;
  cur.head.tabs = now.tabs || [];
  paintAsk();
  paintTabs();
  const bg = now.background || null;
  if (JSON.stringify(bg) !== JSON.stringify(cur.head.background || null)) { cur.head.background = bg; paintBody(); }
  if (moved || now.status !== cur.head.status) reload();
}

// THE DIALOG A SESSION IS STOPPED ON, in the session itself (routes/prompts.js). The notification
// carries the same buttons, but it is swiped away by habit; this stays until the dialog is answered —
// here, on the watch, in the notification or at the keyboard — and the `sessions` frame that follows
// takes it down. The line is the tool call itself, as the notification shows it.
function paintAsk() {
  const el = document.getElementById('repospane');
  const ask = el && el.querySelector('.sv-ask');
  if (!ask || !cur) return;
  const p = cur.head && cur.head.prompt;
  ask.hidden = !p;
  if (!p) { ask.dataset.id = ''; return; }
  if (ask.dataset.id === p.id) return;
  ask.dataset.id = p.id;
  ask.classList.remove('sending');
  ask.querySelector('.sv-ask-line').textContent = p.line;
}

// SESSION TABS. A session view is a strip of tabs: the conversation itself ('session', always there)
// and any extra views the session has open beside it. Each tab keeps its pane mounted while another is
// shown, so switching to the conversation to read something and back loses nothing. The strip shows only
// when there is more than the conversation.
//
// A kind of tab is an entry in TAB_KINDS (how to draw it into its pane) plus a line in tabsOf (when the
// session has one). `mount` answers a close function or `{ close, update, shown }`: `update` takes a newer
// head of the same tab (its `v` moved), `shown` whether its pane is the one on screen. `selfEnds` kinds take
// their own tab down through `done` once they have shown how they ended; any other kind's tab goes the moment
// the session payload stops listing it. `front` says when a tab that appears comes to the front: 'always'
// (it needs him now), 'new' (only one that appears while the session is open, not one already there when
// it opened), or never.
const TAB_KINDS = {
  // A screen the session handed over (routes/handoffs.js). The Mac's screen is shown LIVE (screen.js),
  // its Done and Cancel ending the handoff; when no picture comes, and for the Pi's browser, it is the
  // screenshot tap screen (handoff.js). Opening the session lands on the conversation even with one open:
  // its notification names the tab when that is where he should land (pendingTab).
  handoff: { label: () => 'Handoff', selfEnds: true, front: 'new', mount: (pane, t, done) => {
    const taps = () => openHandoff(t.id, { mount: pane, onEnd: done });
    if (!/^mac-/.test(t.target || '')) return taps();
    let close = openScreen({ mount: pane, session: cur && cur.id, handoff: { id: t.id, focus: t.focus }, onEnd: done,
      onFail: () => { close = taps(); } });
    return () => close();
  } },
  // The Mac's whole screen, live (screen.js), opened from the session bar. It is the phone's, not the
  // session's, so it stays until he closes it.
  screen: { label: () => 'Mac', selfEnds: true, front: 'always',
    mount: (pane, t, done) => openScreen({ mount: pane, session: cur && cur.id, onEnd: done }) },
  // Something the session put up with the session_tab tool (sessiontabs.js), labelled by the session.
  content: { label: (t) => t.title || 'Tab', front: 'new', mount: (pane, t) => mountContent(pane, t) },
  // A live view of a Chrome tab the session drives (sessiontabs.js, lib/liverelay.js), labelled by its site.
  chrome: { label: (t) => hostOf(t.url) || 'Chrome', mount: (pane, t) => mountLive(pane, t) },
};

function hostOf(url) {
  try { return url ? new URL(url).hostname.replace(/^www\./, '') : ''; } catch (_) { return ''; }
}

function tabsOf(head) {
  const tabs = [];
  if (head && head.handoff) tabs.push({ key: 'handoff:' + head.handoff.id, kind: 'handoff', id: head.handoff.id, target: head.handoff.target, focus: head.handoff.focus });
  for (const t of (head && head.tabs) || []) if (TAB_KINDS[t.kind]) tabs.push({ ...t, key: `${t.kind}:${t.id}` });
  return tabs;
}

let pendingTab = null;   // a tab to show once its session opens (a notification tap names one)

function paintTabs() {
  const el = document.getElementById('repospane');
  const sv = el && el.querySelector('.sv');
  if (!sv || !cur) return;
  const at = cur;
  const want = tabsOf(at.head);
  for (const t of want) if (!at.tabs.has(t.key)) addTab(at, sv, t);
  for (const [key, entry] of at.tabs) {
    const now = want.find((t) => t.key === key);
    // A handoff tab the session no longer shows goes when another handoff takes its place: two live views at
    // once are two screen shares from one phone, and the screen agent keeps only the newest of those.
    const replaced = entry.t.kind === 'handoff' && want.some((t) => t.kind === 'handoff');
    if (!now) { if (!TAB_KINDS[entry.t.kind].selfEnds || replaced) dropTab(at, key); continue; }
    if (now.v !== entry.t.v || now.url !== entry.t.url || now.title !== entry.t.title) {
      entry.t = now;
      if (entry.ctl.update) entry.ctl.update(now);
    }
  }
  at.tabsPainted = true;
  if (pendingTab && at.tabs.has(pendingTab)) { showTab(at, pendingTab); pendingTab = null; }
  paintStrip(at);
}

function addTab(at, sv, t) {
  const pane = document.createElement('div');
  pane.className = 'sv-pane'; pane.dataset.tab = t.key; pane.hidden = true;
  sv.append(pane);
  const entry = { t, pane, ctl: {} };
  at.tabs.set(t.key, entry);
  const m = TAB_KINDS[t.kind].mount(pane, t, () => dropTab(at, t.key));
  entry.ctl = typeof m === 'function' ? { close: m } : (m || {});
  const front = TAB_KINDS[t.kind].front;
  if (front === 'always' || (front === 'new' && at.tabsPainted)) showTab(at, t.key);
}

function showTab(at, key) {
  const el = document.getElementById('repospane');
  if (!el || cur !== at) return;
  at.tab = key;
  el.querySelectorAll('.sv-pane').forEach((p) => { p.hidden = p.dataset.tab !== key; });
  for (const [k, e] of at.tabs) if (e.ctl.shown) e.ctl.shown(k === key);
  paintStrip(at);
}

function dropTab(at, key) {
  const entry = at.tabs.get(key);
  if (!entry) return;
  at.tabs.delete(key);
  try { entry.ctl.close && entry.ctl.close(); } catch (_) {}
  entry.pane.remove();
  if (at.tab === key) showTab(at, 'session'); else paintStrip(at);
}

function closeTabs(at) {
  if (!at || !at.tabs) return;
  for (const [, entry] of at.tabs) { try { entry.ctl.close && entry.ctl.close(); } catch (_) {} }
  at.tabs.clear();
}

function paintStrip(at) {
  const el = document.getElementById('repospane');
  const strip = el && el.querySelector('.sv-tabs');
  if (!strip || cur !== at) return;
  strip.hidden = at.tabs.size === 0;
  const tabs = [['session', 'Session'], ...[...at.tabs].map(([key, e]) => [key, TAB_KINDS[e.t.kind].label(e.t)])];
  strip.innerHTML = tabs.map(([key, label]) =>
    `<button type="button" class="sv-tab${at.tab === key ? ' on' : ''}" data-tab="${esc(key)}">${esc(label)}</button>`).join('');
}

// A handoff notification tapped (shared.js `__openHandoff`): its session, on its handoff tab. A handoff
// with no session, or one the hub no longer has, is drawn over everything as before.
window.__openHandoffTab = async (id) => {
  let session = null;
  try {
    const r = await fetch(`/api/handoffs/${encodeURIComponent(id)}?after=-1&wait=0`);
    if (r.ok) session = (await r.json()).session || null;
  } catch (_) {}
  if (!session || !document.getElementById('repospane')) { openHandoff(id); return; }
  pendingTab = 'handoff:' + id;
  await window.__showSession(session);
};

async function answerAsk(decision) {
  const el = document.getElementById('repospane');
  const ask = el && el.querySelector('.sv-ask');
  const id = ask && ask.dataset.id;
  if (!id || ask.classList.contains('sending')) return;
  ask.classList.add('sending');
  try {
    const r = await fetch(`/api/session-prompts/${encodeURIComponent(id)}/decide`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ decision }),
    });
    // Decided (by this tap or an earlier one anywhere) or already gone: either way it is over.
    if (r.ok || r.status === 404) { if (cur && cur.head && cur.head.prompt && cur.head.prompt.id === id) cur.head.prompt = null; paintAsk(); return; }
    console.error('[sessions] prompt decide failed:', r.status);
  } catch (e) { console.error('[sessions] prompt decide failed:', e.message); }
  ask.classList.remove('sending');
}

// ---- THE CONVERSATION IS ONE LIST OF EVENTS ---------------------------------------------------
// Prompt, tool, text and reply, each with a position (`seq`) and an identity (`id`), from the hub
// (routes/conversation.js, the event log). What this view holds is that list and nothing else, and the whole rule
// for keeping it right is below in `frame`: the next seq is appended, a gap is fetched, an old seq is
// ignored. A prompt queued behind a running turn and later read is one event at two moments, same id,
// drawn where the model took it. The watch keeps the same list by the same rule (Sessions.swift).
//
// The one thing on screen that is not from the hub is a PLACEHOLDER: the user's words the instant they are
// sent, before the machine has typed them into the session. It carries the message's own id, and the
// event that comes back for it does too (`cmd`), so it is replaced by id, never by matching text.

/** Merge events into a list by seq: a fetch that fills a gap and a frame that arrived meanwhile cannot disagree. */
function absorb(list, events) {
  const by = new Map(list.map((e) => [e.seq, e]));
  for (const e of events || []) if (e && Number.isFinite(e.seq)) by.set(e.seq, e);
  return [...by.values()].sort((a, b) => a.seq - b.seq);
}

function take(at, events, epoch) {
  // A different epoch is a hub that restarted and numbered from one again: what is held is stale.
  if (epoch && at.epoch && epoch !== at.epoch) at.events = [];
  if (epoch) at.epoch = epoch;
  at.events = absorb(at.events, events);
  at.last = at.events.length ? at.events[at.events.length - 1].seq : 0;
  settlePlaceholders(at);
}

// A PLACEHOLDER ENDS WHEN THE LIST HOLDS ITS WORDS, judged against EVERYTHING held, never only the events
// that just arrived: the event for the words routinely lands BEFORE the send's own answer (the hub hears
// the host's frame while it is still waiting on the command), so a placeholder pushed on that answer has
// already missed the batch that carried its id. And a prompt that comes back with no `cmd` at all (the
// host could not stamp it) after the send began is taken as the oldest placeholder's words — otherwise
// that placeholder has no way to end and sits under the whole turn. Neither rule compares text.
function settlePlaceholders(at) {
  if (!at.placeholders.length) return;
  const cmds = new Set(at.events.filter((e) => e.kind === 'prompt' && e.cmd).map((e) => e.cmd));
  let left = at.placeholders.filter((p) => !cmds.has(p.cmd));
  const orphans = new Set();
  for (const e of at.events) {
    if (e.kind !== 'prompt' || e.cmd || orphans.has(e.id)) continue;
    const i = left.findIndex((p) => e.seq > p.after);
    if (i < 0) continue;
    orphans.add(e.id);
    left = left.filter((_, j) => j !== i);
  }
  at.placeholders = left;
  // A reply after the words were sent, with their placeholder still up ten seconds later, means the event
  // for them never arrived by either rule: the doubled prompt on screen. Reported once, as an error, so the
  // responder hears of it rather than the user. The wait lets the event for words typed just as the
  // previous turn ended arrive behind that turn's reply.
  for (const p of left) {
    if (p.checking || !at.events.some((e) => e.kind === 'reply' && e.seq > p.after)) continue;
    p.checking = true;
    setTimeout(() => {
      if (!at.placeholders.includes(p)) return;
      reportPageError(`session view: a sent prompt's placeholder is still up after a reply (session ${at.id}, msg ${p.cmd})`);
    }, 10000);
  }
}

async function fetchEvents(at, since) {
  try {
    const r = await fetch(`/api/sessions/${encodeURIComponent(at.id)}/events${since ? '?since=' + since : ''}`);
    if (!r.ok) return;
    const j = await r.json();
    if (cur !== at) return;
    take(at, j.events, j.epoch);
    paintBody();
  } catch (_) { /* the next frame's seq will ask again */ }
}

// An `ev` frame: one event of some conversation. Only the open one's are taken.
function frame(a) {
  if (!cur || !a || !a.ev || a.conversation !== cur.key) return;
  const at = cur;
  if (a.session && a.session !== at.id) at.id = a.session;   // the row running the conversation now
  if (a.epoch !== at.epoch) { fetchEvents(at); return; }
  const seq = a.ev.seq;
  if (!Number.isFinite(seq) || seq <= at.last) return;
  if (seq > at.last + 1) fetchEvents(at, at.last);            // a gap: what went by while this was not listening
  take(at, [a.ev]);
  paintBody();
}

let following = false, connected = false;
// Opened on the first open rather than at mount: #repospane is in the kiosk's markup too, and a wall
// that never opens a session has no use for the frames. It then stays for the life of the page, like
// every other stream here — `liveStream` keeps rebuilding a socket after `close()`.
function follow() {
  if (following) return;
  following = true;
  liveStream('/api/session-stream', {
    sessions: (e) => { try { keep(JSON.parse(e.data)); } catch (_) {} },
    ev: (e) => { let a; try { a = JSON.parse(e.data); } catch (_) { return; } frame(a); },
  }, {
    // A RE-connect: whatever went by while the socket was down is in the list on the hub, not here.
    onOpen: () => { if (connected && cur) reload(); connected = true; },
  });
}

// Coming back to the app re-reads the open session, since a suspended stream missed whatever went by.
// How the view scrolls is `threadScroll` in shared.js; the re-read moves it only if it was following.
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && cur) reload(); });

// The header's facts and the whole list, from the hub. A merge, not a replacement: a frame that
// arrived while this was in flight is kept, and a gap either way is filled.
async function reload() {
  if (!cur) return;
  const at = cur;
  let d;
  try {
    const r = await fetch('/api/sessions/' + encodeURIComponent(at.id));
    if (!r.ok) return;
    d = await r.json();
  } catch (_) { return; }
  if (cur !== at) return;
  at.head = d;
  take(at, d.events, d.epoch);
  paintHead();
  paintBody();
}

function paintHead() {
  const el = document.getElementById('repospane');
  const d = cur && cur.head;
  if (!el || !d) return;
  const t = el.querySelector('.sv-title'), w = el.querySelector('.sv-where');
  if (t) t.textContent = nameOf(d);
  if (w) w.textContent = d.worker === 'desk' ? 'Mac' : d.worker === 'fly-desk' ? 'Fly' : 'Pi';
  // An incident run is framed as an alert while it is open, as its row is in every list.
  const sv = el.querySelector('.sv');
  if (sv) { sv.classList.toggle('incident', !!d.incident); sv.classList.toggle('codex', !!d.codex); }
  paintAsk();
  paintTabs();
}

// What is drawn: every event in order, ONE PER ID, at the position of its LATEST occurrence — a prompt
// moves from where it was queued to where the model read it, and a message the list came to hold twice
// (a restart's seed and the host's report of the same turn) is drawn once — and the user's own words the
// hub does not have yet after everything it does. The session is working when the last event is not a reply.
function shown(at) {
  const seen = new Set(), out = [];
  for (let i = at.events.length - 1; i >= 0; i--) {
    const e = at.events[i];
    if (e.id) { if (seen.has(e.id)) continue; seen.add(e.id); }
    out.push(e);
  }
  return out.reverse();
}

// Every event in order, keyed so a repaint updates in place. The newest message is whatever came last —
// a reply, a thought, a tool call, the user's own words — and the caret of a running turn is not one.
function paintBody() {
  const el = document.getElementById('repospane');
  const body = el && el.querySelector('.sv-body');
  if (!body || !cur || !cur.scroll) return;
  const list = shown(cur);
  const working = list.length > 0 && list[list.length - 1].kind !== 'reply';
  const items = list.map((e) => e.kind === 'prompt'
    // Queued (sent, not yet read) is dimmed; it takes its full colour and its real place when read.
    ? { key: 'p' + e.id, html: `<div class="sv-words${e.seen === false ? ' sv-queued' : ''}">${saidHtml(e.text)}</div>` }
    : { key: 'e' + e.seq, html: e.kind === 'reply'
      ? `<div class="sv-turn"><div class="sv-reply">${md(String(e.text || '').trim())}</div></div>`
      : e.kind === 'text'
        ? `<div class="sv-thought">${md(e.text)}</div>`
        : `<div class="sv-tool">${esc(e.text)}</div>` });
  if (working) items.push({ key: 'working', html: '<div class="sv-working"><span class="ai-caret">▍</span></div>' });
  // STOP is there exactly while the caret is: it interrupts the turn, as Esc at the keyboard does.
  const halt = el.querySelector('.sv-halt');
  if (halt && !halt.disabled) halt.hidden = !working || !cur.head || cur.head.status !== 'resident' || !!cur.head.codex;
  // The turn is over but work it started goes on: each background agent by its description, and a
  // background shell, under a pulsing caret, until the host says they have finished. Not a message.
  const bg = !working && cur.head && cur.head.background;
  if (bg) {
    const shells = bg.shells && bg.shells.length ? bg.shells : bg.shell ? [''] : [];
    const lines = [...(bg.agents || []).map((a) => ['agent', a]), ...shells.map((t) => ['shell', t])];
    items.push({ key: 'bg', html: '<div class="sv-bg"><span class="ai-caret">▍</span><div class="sv-bg-lines">' +
      lines.map(([k, t]) => `<div class="sv-bg-line"><span class="sv-bg-k">${k}</span>${t ? ' ' + esc(t) : ''}</div>`).join('') +
      '</div></div>' });
  }
  // The user's words the hub does not have yet: sent from here, on their way to being typed in.
  for (const p of cur.placeholders) items.push({ key: 'q' + p.cmd, html: `<div class="sv-words sv-queued">${saidHtml(p.text)}</div>` });
  cur.scroll.change(() => syncKeyed(body, items));
}

// The user's words into the open conversation. The text stays in the box until the hub has taken it, and a
// resend of the same words carries the same id, so a lost answer cannot type them twice.
// `at` is the session the words are FOR — a spoken follow-up still transcribing when the user leaves the
// view goes to the session the user spoke it into, not to nothing.
async function sendWords(text, at = cur) {
  const el = document.getElementById('repospane');
  text = String(text || '').trim();
  // Pictures alone are a message: "look at this" with nothing typed is the common case for a screenshot.
  const pics = cur === at ? shots.filter((a) => a.name).map((a) => a.name) : [];   // the tray belongs to the open view
  if (!el || !at || (!text && !pics.length) || at.sending) return;
  const status = el.querySelector('.sv-status');
  const say = (t) => { if (status && cur === at) status.textContent = t || ''; };
  if (!at.msg || at.msg.text !== text) at.msg = { text, id: newMsgId() };
  const msgId = at.msg.id;
  const after = at.last;   // how far the list had got before these words could be in it
  at.sending = true;
  if (cur === at) el.querySelector('.sv').classList.add('sending');
  say('');
  try {
    const r = await fetch('/api/sessions/followup', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: at.id, text, attachments: pics, client_msg_id: at.msg.id }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || String(r.status));
    at.msg = null;
    if (cur === at) {
      const box = el.querySelector('.sv-text');
      if (box && box.value.trim() === text) box.value = '';
      // The user's words on screen the instant they are sent, before the machine has typed them in. Keyed by
      // the message's own id, which the event for them carries back (`cmd`), so it is replaced by id.
      // The hub taking nothing (`ignored`: a thank-you-shaped transcription) shows nothing.
      if (!j.ignored) { at.placeholders.push({ cmd: msgId, text: text || '(picture)', after }); settlePlaceholders(at); }
      for (const a of shots) URL.revokeObjectURL(a.url);
      shots = [];
      const tray = el.querySelector('.sv-tray'); if (tray) tray.innerHTML = '';
      paintBody();   // the words land like any arrival
    }
  } catch (e) {
    // Words that were spoken exist nowhere else, so a failed send leaves them in the box to resend.
    const box = cur === at && el.querySelector('.sv-text');
    if (box && !box.value.trim()) box.value = text;
    say(String(e.message || e));
  }
  at.sending = false;
  if (cur === at) el.querySelector('.sv').classList.remove('sending');
}

// Opens one session over the list. False when there is no such row to show, so a caller with
// somewhere else to go (a notification tap) can go there.
// Shrunk before upload, the same as the chat composer's: a phone photo is several megabytes of detail
// no model reads, and the session's machine has to pull it down again on the other side.
async function uploadShot(file) {
  const img = await new Promise((ok, no) => {
    const i = new Image(); i.onload = () => ok(i); i.onerror = no; i.src = URL.createObjectURL(file);
  });
  const scale = Math.min(1, 1568 / Math.max(img.width, img.height));
  const c = document.createElement('canvas');
  c.width = Math.round(img.width * scale); c.height = Math.round(img.height * scale);
  c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
  URL.revokeObjectURL(img.src);
  const blob = await new Promise((ok) => c.toBlob(ok, 'image/jpeg', 0.85));
  const r = await fetch('/api/attach', { method: 'POST', headers: { 'Content-Type': 'image/jpeg' }, body: blob });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.path) throw new Error(j.error || 'upload failed');
  return j.path;
}

// THE USER'S WORDS, with any pictures drawn as pictures.
//
// A session is typed into, so an attachment reaches it as a line naming local files — which is the
// right thing for the session and the wrong thing to show the user, since the user is the one who attached them.
// The basename IS the hub's object name (the host saves each file under it, see fetchAttachment), so
// the same bytes come back from /api/attachment and the line becomes the thumbnails it stands for.
const ATTACH_RE = /^\[Jared attached [^:\]]*: ([^\]]+?) — read (?:it|them) now\.\]\s*/;
function saidHtml(text) {
  const m = ATTACH_RE.exec(String(text || ''));
  if (!m) return mdInline(String(text || ''));
  const shots = m[1].split(',').map((p) => p.trim().split('/').pop()).filter((n) => /^[\w.-]+$/.test(n));
  const rest = String(text).slice(m[0].length).trim();
  return (shots.length
    ? `<span class="sv-said-shots">${shots.map((n) =>
        `<img src="/api/attachment?path=${encodeURIComponent(n)}" alt="">`).join('')}</span>`
    : '') + (rest ? mdInline(rest) : '');
}

// Opening one reads its reply — see `unread` in buildSessions. Fire and forget: the list re-renders
// off the push the hub sends back, and a failed stamp only means the mark stays up.
function markSeen(id) {
  fetch('/api/sessions/seen', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id }) }).catch(() => {});
}

const SPEAK_SVG = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 5L6 9H2v6h4l5 4V5z"></path><path d="M15.5 8.5a5 5 0 0 1 0 7"></path><path d="M19 5a10 10 0 0 1 0 14"></path></svg>';
const SCREEN_SVG = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="4" width="20" height="13" rx="2"></rect><path d="M8 21h8M12 17v4"></path></svg>';
const STOP_SVG = '<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="1"></rect></svg>';
const PAUSE_SVG = '<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><rect x="6" y="5" width="4" height="14" rx="1"></rect><rect x="14" y="5" width="4" height="14" rx="1"></rect></svg>';
const PLAY_SVG = '<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M7 5v14l12-7z"></path></svg>';

async function openSession(id) {
  const el = document.getElementById('repospane');
  if (!el || !id) return false;
  cancelDictation();
  follow();
  // A parked row whose conversation is running again under a newer row opens as that one.
  const tapped = rows.find((r) => r.id === id);
  const live = tapped && rows.find((r) => r.status === 'resident' && keyOfRow(r) === keyOfRow(tapped));
  const rowId = (live || tapped || { id }).id;
  markSeen(rowId);
  const ticket = ++opening;
  let d;
  try {
    const r = await fetch('/api/sessions/' + encodeURIComponent(rowId));
    if (!r.ok) return false;
    d = await r.json();
  } catch (_) { return false; }
  // A later open overtook this one while it loaded (a notification tap racing the session restored at
  // mount): that one is what is on screen, so this one stands down as handled.
  if (ticket !== opening) return true;
  if (cur && cur.rec) cur.rec.cancel();   // leaving mid-recording abandons it; a clip already stopped still sends
  closeTabs(cur);
  cur = { id: d.id, key: keyOfRow(d), head: d, epoch: null, events: [], last: 0, placeholders: [], msg: null, sending: false, rec: null,
    tabs: new Map(), tab: 'session' };
  remember(d.id);
  const at = cur;
  take(at, d.events, d.epoch);
  const pane = el.closest('.pane');
  if (pane) pane.classList.add('sv-open');
  el.innerHTML =
    '<div class="sv">' +
      '<div class="sv-bar"><button class="sv-back" type="button">‹ Sessions</button>' +
        '<span class="sv-title"></span>' +
        '<button class="sv-halt" type="button" hidden>Stop</button>' +
        '<button class="sv-screen" type="button" aria-label="The Mac\'s screen">' + SCREEN_SVG + '</button>' +
        '<span class="sv-where"></span>' +
        '<button class="sv-speak-stop" type="button" aria-label="Stop reading" hidden>' + STOP_SVG + '</button>' +
        '<button class="sv-speak" type="button" aria-label="Read the reply aloud">' + SPEAK_SVG + '</button></div>' +
      '<div class="sv-tabs" hidden></div>' +
      '<div class="sv-pane" data-tab="session">' +
      '<div class="sv-body"></div>' +
      '<div class="sv-ask" hidden><span class="sv-ask-line"></span>' +
        '<button class="sv-ask-btn deny" type="button" data-decide="deny">Deny</button>' +
        '<button class="sv-ask-btn allow" type="button" data-decide="allow">Approve</button></div>' +
      '<div class="sv-input">' +
        '<button class="ai-mic sv-mic" type="button" aria-label="Tap to talk"><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="2" width="6" height="12" rx="3"></rect><path d="M5 11a7 7 0 0 0 14 0"></path><line x1="12" y1="18" x2="12" y2="22"></line></svg></button>' +
        '<button class="ai-mic sv-clip" type="button" aria-label="Attach a picture"><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"></rect><circle cx="8.5" cy="8.5" r="1.5"></circle><path d="M21 15l-5-5L5 21"></path></svg></button>' +
        '<input class="sv-file" type="file" accept="image/*" multiple hidden>' +
        '<input class="ai-text sv-text" type="text" placeholder="Message…" autocomplete="off">' +
        '<button class="ai-send sv-send" type="button">Send</button>' +
        '<div class="ai-status sv-status"></div>' +
      '</div>' +
      '<div class="sv-tray"></div>' +
      '</div>' +
    '</div>';
  // A fresh body, so the first paint lands on the newest message, as opening a thread does.
  at.scroll = threadScroll(el.querySelector('.sv-body'), { lands: (n) => !n.classList.contains('sv-working') && !n.classList.contains('sv-bg') });
  paintHead();
  paintBody();
  // The session's last reply, read aloud in a real voice (speak.js). While it plays the button is a
  // pause — which keeps the place, so carrying on does not start the reply over — and a stop sits
  // beside it.
  const say = el.querySelector('.sv-speak'), hush = el.querySelector('.sv-speak-stop');
  say.addEventListener('click', () => {
    if (speaking()) {
      if (paused()) { resumeSpeaking(); say.innerHTML = PAUSE_SVG; } else { pauseSpeaking(); say.innerHTML = PLAY_SVG; }
      return;
    }
    const reply = [...at.events].reverse().find((e) => e.kind === 'reply');
    if (!reply) return;
    say.classList.add('on');
    say.innerHTML = PAUSE_SVG;
    hush.hidden = false;
    speak(reply.text, () => { say.classList.remove('on'); say.innerHTML = SPEAK_SVG; hush.hidden = true; });
  });
  hush.addEventListener('click', () => stopSpeaking());
  // Interrupt the running turn (`/api/sessions/stop`). What was queued behind it runs next; otherwise the
  // session waits for the next message. The button stays down until the machine has answered.
  const halt = el.querySelector('.sv-halt');
  halt.addEventListener('click', async () => {
    if (halt.disabled) return;
    halt.disabled = true;
    halt.classList.add('busy');
    const st = el.querySelector('.sv-status');
    try {
      const r = await fetch('/api/sessions/stop', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: at.id }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok && st && cur === at) st.textContent = j.error || ('Stop failed (' + r.status + ')');
    } catch (_) {
      if (st && cur === at) st.textContent = 'Stop failed';
    } finally {
      halt.disabled = false;
      halt.classList.remove('busy');
      if (cur === at) paintBody();
    }
  });
  const box = el.querySelector('.sv-text'), mic = el.querySelector('.sv-mic'), status = el.querySelector('.sv-status');
  // PICTURES INTO A TERMINAL SESSION. A session is typed into, so an image cannot be sent to it — what
  // is sent is a PATH. The hub keeps the bytes (`/api/attach`, the same bucket the chat composer uses)
  // and the machine that owns the session pulls them down beside its stashed prompts, so what reaches
  // the tty is a line naming a local file the session can read. Nothing here knows any of that: it
  // uploads, and hands the names to the follow-up.
  const fileIn = el.querySelector('.sv-file'), tray = el.querySelector('.sv-tray');
  el.querySelector('.sv-clip').addEventListener('click', () => fileIn.click());
  const paintTray = () => {
    tray.innerHTML = shots.map((a, i) =>
      `<span class="sv-shot${a.name ? '' : ' up'}"><img src="${esc(a.url)}" alt="">` +
      `<button type="button" class="sv-shot-x" data-i="${i}" aria-label="Remove">✕</button></span>`).join('');
  };
  tray.addEventListener('click', (e) => {
    const x = e.target.closest('.sv-shot-x'); if (!x) return;
    const [gone] = shots.splice(Number(x.dataset.i), 1);
    if (gone) URL.revokeObjectURL(gone.url);
    paintTray();
  });
  fileIn.addEventListener('change', async () => {
    const files = [...(fileIn.files || [])]; fileIn.value = '';
    for (const f of files) {
      const a = { url: URL.createObjectURL(f), name: null };
      shots.push(a); paintTray();
      try { a.name = await uploadShot(f); }
      catch (_) { shots.splice(shots.indexOf(a), 1); status.textContent = 'Upload failed'; }
      paintTray();
    }
  });
  // The Mac's screen: opened beside the conversation, or brought forward when it is already open.
  el.querySelector('.sv-screen').addEventListener('click', () => {
    if (at.tabs.has('screen')) showTab(at, 'screen');
    else { addTab(at, el.querySelector('.sv'), { key: 'screen', kind: 'screen' }); paintStrip(at); }
  });
  el.querySelector('.sv-tabs').addEventListener('click', (e) => {
    const b = e.target.closest('.sv-tab');
    if (b) showTab(at, b.dataset.tab);
  });
  el.querySelector('.sv-ask').addEventListener('click', (e) => {
    const b = e.target.closest('[data-decide]');
    if (b) answerAsk(b.dataset.decide);
  });
  el.querySelector('.sv-back').addEventListener('click', showList);
  swipeBack(el.querySelector('.sv'), () => { if (cur === at) showList(); });
  el.querySelector('.sv-send').addEventListener('click', () => sendWords(box.value));
  box.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); sendWords(box.value); } });
  // Spoken words go straight in, as they do on the watch and as this pane's launcher sends a dictated
  // prompt: `dryWhen` has the hub transcribe without enqueueing a voice command, and the transcript
  // is sent as the follow-up. PRESS TO START, PRESS TO SEND, the same as every mic button (makeRecorder).
  at.rec = makeRecorder({
    dryWhen: () => true,
    session: at.id,
    // Failures only: the red mic is what says it is listening (see initCard in voiceagent.js). A send
    // starting again ('busy', the outbox retrying a clip) or recording again ('rec', a resume after
    // Paused) takes the last failure down.
    onStatus: (t, kind) => {
      if (cur !== at) return;
      if (kind === 'err' || kind === 'clear') status.textContent = t || '';
      else if (kind === 'busy' || kind === 'rec') status.textContent = '';
    },
    onState: (s) => { mic.classList.toggle('ai-rec', s === 'rec'); mic.classList.toggle('ai-armed', s === 'armed'); },
    onTranscript: (t) => {
      const words = String(t || '').trim();
      if (!words) return;
      // Spoken while an earlier message is still going up: held in the box rather than dropped.
      if (at.sending && cur === at) box.value = (box.value.trim() ? box.value.trim() + ' ' : '') + words;
      else sendWords(words, at);
    },
  });
  bindMic(mic, at.rec);
  return true;
}

// A SWIPE TO THE RIGHT, from anywhere on the view, closes it — the view follows the finger, and on
// release either gives way to the list at once (past a third of its width, or a flick) or springs back. This pane is the leftmost, so
// the panes scroller has nothing to do with a rightward drag here and the gesture is free to take.
// It is claimed only once the drag is clearly horizontal, so a vertical scroll of the conversation
// never turns into one, and it yields to anything inside that is itself scrolled sideways (a wide
// code block or table), which a rightward drag has to scroll back first.
function swipeBack(sv, close) {
  let x0 = 0, y0 = 0, t0 = 0, dx = 0, mode = null, k = 1;
  const reset = (animate) => {
    sv.style.transition = animate ? 'transform .2s ease-out' : '';
    sv.style.transform = '';
  };
  sv.addEventListener('touchstart', (e) => {
    if (e.touches.length !== 1) { mode = 'no'; return; }
    const t = e.touches[0];
    x0 = t.clientX; y0 = t.clientY; t0 = Date.now(); dx = 0; mode = null;
    // A picture that pans under the finger (a handoff, the Mac's screen, a live Chrome tab) owns every
    // drag that starts on it. Its own preventDefault stops the browser scrolling, not this handler,
    // which would otherwise read a rightward pan as a swipe out of the session.
    if (e.target.closest && e.target.closest('.ho-stage')) { mode = 'no'; return; }
    for (let n = e.target; n && n !== sv; n = n.parentElement) {
      if (n.scrollLeft > 0 && getComputedStyle(n).overflowX !== 'visible') { mode = 'no'; return; }
    }
    // On a wall opened at phone size the shell is scaled, so a screen pixel is not a layout pixel.
    const w = sv.getBoundingClientRect().width;
    k = w ? sv.offsetWidth / w : 1;
  }, { passive: true });
  sv.addEventListener('touchmove', (e) => {
    if (mode === 'no') return;
    const t = e.touches[0];
    const mx = t.clientX - x0, my = t.clientY - y0;
    if (!mode) {
      if (Math.abs(mx) < 10 && Math.abs(my) < 10) return;
      mode = mx > 0 && mx > Math.abs(my) * 1.5 ? 'swipe' : 'no';
      if (mode === 'no') return;
      sv.style.transition = '';
    }
    e.preventDefault();
    dx = Math.max(0, mx);
    sv.style.transform = `translateX(${dx * k}px)`;
  }, { passive: false });
  const end = () => {
    if (mode !== 'swipe') { mode = null; return; }
    mode = null;
    const w = sv.getBoundingClientRect().width || 1;
    const fast = dx / Math.max(1, Date.now() - t0) > 0.5 && dx > 40;
    if (dx > w / 3 || fast) close();   // the list replaces the view on release, nothing to wait out
    else reset(true);
  };
  sv.addEventListener('touchend', end);
  sv.addEventListener('touchcancel', () => { if (mode === 'swipe') reset(true); mode = null; });
}

// Back to the list, from the view's own button or from anything that needs the list on screen.
async function showList() {
  const el = document.getElementById('repospane');
  if (cur && cur.rec) cur.rec.cancel();   // leaving mid-recording abandons it; a clip already stopped still sends
  closeTabs(cur);
  cur = null;
  remember(null);
  const pane = el && el.closest('.pane');
  if (pane) pane.classList.remove('sv-open');
  // The list as it was last drawn goes up in the same frame, and the fetch then brings it current:
  // waiting on /api/repos and /api/sessions back to back left the pane black for most of a second.
  if (el && last) { el.innerHTML = html(last); wire(el); }
  await load();
}

// AN OPEN SESSION SURVIVES A RELOAD. The page reloads itself whenever a deploy has made it stale, and
// it does that on the way back to visible — which is exactly when a notification tap has just opened
// a session. Without this the session opens and the reload lands the user on home a beat later. Session
// storage, so it belongs to this one web view and a fresh launch starts on home as it should.
const SV_KEY = 'hub:open-session';
function remember(id) {
  try { id ? sessionStorage.setItem(SV_KEY, id) : sessionStorage.removeItem(SV_KEY); } catch (_) {}
}
function remembered() { try { return sessionStorage.getItem(SV_KEY); } catch (_) { return null; } }

// Back to now: the pane shows the list again, which is what a fresh load shows.
window.addEventListener('hubreset', () => { if (cur) showList(); });

// Called by the native app when a repo widget row is tapped (statushub://repo/<path>). The widget
// can't reach a microphone, so it hands the choice over and the recording happens here.
window.__startRepoSession = async (path) => {
  const el = document.getElementById('repospane');
  if (!el) return;
  try { window.__showPane && window.__showPane('repos'); } catch (_) {}
  await showList();
  const li = el.querySelector(`li[data-path="${CSS.escape(String(path))}"]`);
  if (!li) return;
  li.scrollIntoView({ block: 'center', behavior: 'smooth' });
  beginDictation(li, machines.pi ? 'pi' : 'mac');
};

// Called by the native app when a session's reply notification is tapped: opens that session, so
// the reply the notification was about is what is on screen. A row that no longer exists lands on
// the list instead. Remembered BEFORE the fetch: a tap that brings a stale page forward reloads it at
// that moment (shared.js reloadWhenIdle), and an id remembered only once the fetch lands is lost with it.
window.__showSession = async (id) => {
  const el = document.getElementById('repospane');
  if (!el) return;
  remember(String(id));
  try { window.__showPane && window.__showPane('repos'); } catch (_) {}
  if (!(await openSession(String(id)))) showList();
};

// A session's reply relayed into the hub conversation (`data-sess` on it, in voiceagent.js and
// phone-home.js) opens that session when tapped. Capture phase, so it wins over the phone's
// conversation strip, whose own tap opens the chat sheet. A link inside the reply stays a link, and a
// tap that ends a text selection stays a selection.
document.addEventListener('click', (e) => {
  const m = e.target.closest && e.target.closest('[data-sess]');
  if (!m || e.target.closest('a') || !document.getElementById('repospane')) return;
  const sel = window.getSelection && window.getSelection();
  if (sel && !sel.isCollapsed && m.contains(sel.anchorNode)) return;
  e.stopPropagation(); e.preventDefault();
  const chat = document.getElementById('ph-chat');
  if (chat && chat.classList.contains('open')) {
    chat.classList.remove('open');
    const t = document.getElementById('ai-text'); if (t) t.blur();
  }
  window.__showSession(m.dataset.sess);
}, true);

// MOUNTED AT LOAD, not on the first status frame: the pane fetches everything it shows itself, and
// waiting on /api/stream left it blank whenever that stream was slow to deliver after a launch or a
// reload. `render` stays only because core.js calls every card.
export function render() {}
function mount() {
  if (mounted) return;
  if (!document.getElementById('repospane')) return;  // absent on kiosk/mac/page → no-op
  mounted = true;
  const back = remembered();
  if (back) openSession(back).then((ok) => { if (!ok) { remember(null); load(); } }); else load();
  // Coming back to the app re-reads the list. An open session is re-read on its own (above);
  // re-reading the list over it would put the user back on the list after every app switch.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && !cur) load();
  });
  // The sessions pane swiped back into view re-reads the list, since nothing pushes list changes to it
  // while no session is open.
  const pane = document.getElementById('repospane');
  // The hub lists the most recent parked sessions (routes/sessions.js PARKED); scrolling the list to its
  // end asks for the rest, once, and the list stays whole from then on.
  const scroller = pane && pane.closest('.pane');
  if (scroller) scroller.addEventListener('scroll', () => {
    const s = last && last.sessions;
    if (allParked || cur || !s || !(s.parked_total > (s.evicted || []).length)) return;
    if (scroller.scrollTop + scroller.clientHeight < scroller.scrollHeight - 400) return;
    allParked = true; load();
  }, { passive: true });
  let paneSeen = true;
  if (pane && 'IntersectionObserver' in window) {
    new IntersectionObserver((es) => {
      const seen = es[es.length - 1].intersectionRatio > 0.5;
      if (seen === paneSeen) return;
      paneSeen = seen;
      if (seen && !cur) load();
    }, { threshold: [0, 0.5, 1] }).observe(pane);
  }
}
mount();
