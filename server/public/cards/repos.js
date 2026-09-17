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
import { esc, PIN_SVG, liveStream } from '../shared.js';
import { makeRecorder, bindTap } from '../voiceagent.js';

let mounted = false;
let desk = { online: false };
let machines = { mac: false, pi: false };
let recorder = null;      // one shared recorder; only ever one repo is being dictated to
let armed = null;         // the <li> currently listening
let rows = [];            // every row of the last /api/sessions payload, running and parked
let cur = null;           // the session open in place of the list (openSession), or null for the list

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
  if (d.sessions) keep(d.sessions);
  desk = d.desk || { online: false };
  machines = d.machines || { mac: desk.online, pi: false };
  if (cur) return;   // a session was opened while this was in flight; the list must not replace it
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
  // The row itself opens the session; its buttons act on it without opening it.
  el.querySelectorAll('li.sess[data-id]').forEach((li) =>
    li.addEventListener('click', () => openSession(li.dataset.id)));
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

// ---- one session, opened in place of the list -------------------------------------------------
// What the watch's session page shows (apps/Watch/SessionsView.swift), at phone size: the prompt
// that started the last turn and the whole reply to it, the tool calls of a turn in flight, and a
// composer whose words go into that conversation — typed in when it is running, resumed with them
// when it is parked; the hub decides which (`/api/sessions/followup`).
//
// Everything here is keyed by the CONVERSATION (`claude_session_id`), not the row: a resume makes a
// new row for the same conversation, so the row the view was opened on can stop being the one that
// is talking. `cur.id` follows the conversation to whichever row is running it.

const nameOf = (x) => x.custom_title || x.label || x.repo || x.id;
const keyOfRow = (r) => r.claude_session_id || r.id;
const newMsgId = () => ((self.crypto && crypto.randomUUID)
  ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));

// Inline markdown only, whitespace kept — what `inlineMarkdown` gives the watch. Escaped FIRST: a
// reply is a model's prose and may hold anything that looks like markup, so the only tags in the
// result are the ones written here. Code and links are lifted out before the emphasis rules run, or
// a `*` inside one would be read as emphasis.
//
// A link ALWAYS asks for a new window. Followed in place it would navigate the app's one web view
// away from the hub, with nothing on screen to come back by. `target=_blank` reaches the app's
// `createWebViewWith` instead, which hands the address to Safari; a build without that handler
// ignores the tap, which is the safe way round. Only http(s) becomes a link — a relative one would
// open a second hub inside the first — and anything else keeps its words and loses its target.
const MARK = '\uE000';                                  // a private-use character: where a lifted span goes back
const HELD = new RegExp(MARK + '(\\d+)' + MARK, 'g');
function inlineMd(text) {
  const held = [];
  const lift = (html) => { held.push(html); return MARK + (held.length - 1) + MARK; };
  const link = (url, words) => lift(`<a href="${url}" target="_blank" rel="noopener noreferrer">${words}</a>`);
  return esc(String(text).split(MARK).join(''))
    .replace(/```[^\n]*\n([\s\S]*?)```\n?/g, (_, c) => lift('<code class="sv-pre">' + c.replace(/\n$/, '') + '</code>'))
    .replace(/`([^`\n]+)`/g, (_, c) => lift('<code>' + c + '</code>'))
    .replace(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g, (_, words, url) => link(url, words))
    .replace(/\[([^\]\n]+)\]\([^)\s]*\)/g, '$1')
    // A bare address. It stops at an escaped quote, and gives back the punctuation that ends the
    // sentence it sits in rather than linking it.
    .replace(/https?:\/\/(?:(?!&quot;)[^\s<])+/g, (m) => {
      const url = m.replace(/[.,;:!?)\]']+$/, '');
      return link(url, url) + m.slice(url.length);
    })
    .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^\w*])\*([^*\s][^*\n]*?)\*(?!\w)/g, '$1<em>$2</em>')
    .replace(HELD, (_, i) => held[+i]);
}

// The last /api/sessions payload's rows, from a fetch or a pushed `sessions` frame. With a session
// open it is also how the view learns what no `session` frame says: the conversation moving to a new
// row (a resume), and a reply that has actually been WRITTEN — the `done` frame is sent off the write
// path, so the row can still hold the previous reply when it arrives.
const unknown = new Set();   // frame row ids that were not in the list even after re-reading it
function keep(payload) {
  rows = [...(payload.resident || []), ...(payload.evicted || [])];
  for (const r of rows) unknown.delete(r.id);
  if (!cur) return;
  const now = rows.find((r) => r.status === 'resident' && keyOfRow(r) === cur.key)
           || rows.find((r) => r.id === cur.id);
  if (!now) return;
  const d = cur.detail;
  const moved = now.id !== cur.id;
  cur.id = now.id;
  if (moved || now.status !== d.status || !!now.working !== !!d.working
      || (now.last_reply !== undefined && now.last_reply !== d.last_reply)) reloadDetail();
}

let reading = null;          // one re-read of the list at a time, shared by every frame waiting on it
async function keyOfFrame(rowId) {
  if (cur && rowId === cur.id) return cur.key;
  const hit = () => rows.find((r) => r.id === rowId);
  if (!hit() && !unknown.has(rowId)) {
    reading = reading || fetch('/api/sessions').then((r) => r.json()).then(keep)
      .catch(() => {}).finally(() => { reading = null; });
    await reading;
    if (!hit()) unknown.add(rowId);
  }
  const r = hit();
  return r ? keyOfRow(r) : rowId;
}

// A tool call or a thought of the open conversation's turn joins the view; a finished turn clears
// them and re-reads the session. Frames for every other session are dropped.
async function frame(a) {
  if (!cur || !a || !a.session) return;
  const key = await keyOfFrame(a.session);
  if (!cur || key !== cur.key) return;
  if (a.state !== 'done') {
    if (!a.text) return;
    cur.activity.push({ text: String(a.text), thought: a.state === 'text' });
    cur.working = true;
    paintBody({ follow: true });
    return;
  }
  cur.id = a.session;
  cur.activity = [];
  cur.mine = '';
  await reloadDetail();
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
    session: (e) => { try { frame(JSON.parse(e.data)); } catch (_) {} },
  }, {
    // A RE-connect: a turn may have ended while the socket was down, and its frames are not replayed.
    onOpen: () => { if (connected && cur) reloadDetail(); connected = true; },
  });
}

async function reloadDetail() {
  if (!cur) return;
  const at = cur;
  let d;
  try {
    const r = await fetch('/api/sessions/' + encodeURIComponent(at.id));
    if (!r.ok) return;
    d = await r.json();
  } catch (_) { return; }
  if (cur !== at) return;
  const fresh = d.last_reply !== at.detail.last_reply;
  at.detail = d;
  at.working = !!d.working;
  // A reply that has landed ends the turn whether or not its `done` frame got here.
  if (fresh) { at.activity = []; at.mine = ''; }
  paintHead();
  paintBody({ top: fresh });
}

function paintHead() {
  const el = document.getElementById('repospane');
  const d = cur && cur.detail;
  if (!el || !d) return;
  const t = el.querySelector('.sv-title'), w = el.querySelector('.sv-where'), dot = el.querySelector('.sv-bar .sess-dot');
  if (t) t.textContent = nameOf(d);
  if (w) w.textContent = d.worker === 'desk' ? 'Mac' : 'Pi';
  if (dot) dot.hidden = d.status !== 'resident';
}

// The conversation's last finished turns, oldest first (`turns`, from /api/sessions/:id). The last
// of them is the row's own last_prompt/last_reply, which stands alone when there is no history.
function turnsOf(d) {
  if (Array.isArray(d.turns) && d.turns.length) return d.turns;
  return d.last_reply ? [{ prompt: d.last_prompt, reply: d.last_reply }] : [];
}

// The earlier turns are context and sit ABOVE where the view lands: `open` puts the last turn's
// prompt at the top, so what is on screen is the exchange he came for and the rest is a scroll up.
// `top` does the same with a reply that has just arrived, where reading it starts. `follow` keeps a
// view that was already at the bottom there as the turn's steps arrive, and leaves one he has
// scrolled up in where it is.
function paintBody({ open = false, top = false, follow = false } = {}) {
  const el = document.getElementById('repospane');
  const body = el && el.querySelector('.sv-body');
  if (!body || !cur) return;
  const atEnd = body.scrollHeight - body.scrollTop - body.clientHeight < 60;
  body.innerHTML =
    turnsOf(cur.detail).map((t) => '<div class="sv-turn">' +
      (t.prompt ? `<div class="sv-words">${inlineMd(t.prompt.trim())}</div>` : '') +
      `<div class="sv-reply">${inlineMd(String(t.reply || '').trim())}</div></div>`).join('') +
    (cur.mine ? `<div class="sv-words">${inlineMd(cur.mine)}</div>` : '') +
    cur.activity.map((a) => a.thought
      ? `<div class="sv-thought">${inlineMd(a.text)}</div>`
      : `<div class="sv-tool">${esc(a.text)}</div>`).join('') +
    (cur.working ? '<div class="sv-working"><span class="ai-caret">▍</span></div>' : '');
  if (open || top) {
    const turns = body.querySelectorAll('.sv-turn');
    const last = turns[turns.length - 1];
    const at = last && (open ? last : last.querySelector('.sv-reply'));
    // Less the body's own padding, so the first turn of a conversation rests at zero.
    body.scrollTop = at ? Math.max(0, at.offsetTop - body.offsetTop - 12) : 0;
  } else if (follow && atEnd) body.scrollTop = body.scrollHeight;
}

// His words into the open conversation. The text stays in the box until the hub has taken it, and a
// resend of the same words carries the same id, so a lost answer cannot type them twice.
async function sendWords(text) {
  const el = document.getElementById('repospane');
  const at = cur;
  text = String(text || '').trim();
  if (!el || !at || !text || at.sending) return;
  const status = el.querySelector('.sv-status');
  const say = (t) => { if (status && cur === at) status.textContent = t || ''; };
  if (!at.msg || at.msg.text !== text) at.msg = { text, id: newMsgId() };
  at.sending = true;
  el.querySelector('.sv').classList.add('sending');
  say('');
  try {
    const r = await fetch('/api/sessions/followup', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: at.id, text, client_msg_id: at.msg.id }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || String(r.status));
    at.msg = null;
    if (cur === at) {
      const box = el.querySelector('.sv-text');
      if (box && box.value.trim() === text) box.value = '';
      at.mine = text;
      paintBody();
      const body = el.querySelector('.sv-body');
      if (body) body.scrollTop = body.scrollHeight;
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
async function openSession(id) {
  const el = document.getElementById('repospane');
  if (!el || !id) return false;
  cancelDictation();
  follow();
  // A parked row whose conversation is running again under a newer row opens as that one.
  const tapped = rows.find((r) => r.id === id);
  const live = tapped && rows.find((r) => r.status === 'resident' && keyOfRow(r) === keyOfRow(tapped));
  const rowId = (live || tapped || { id }).id;
  let d;
  try {
    const r = await fetch('/api/sessions/' + encodeURIComponent(rowId));
    if (!r.ok) return false;
    d = await r.json();
  } catch (_) { return false; }
  if (cur && cur.rec) cur.rec.stop();
  cur = { id: d.id, key: keyOfRow(d), detail: d, working: !!d.working, activity: [], mine: '', msg: null, sending: false, rec: null };
  const at = cur;
  const pane = el.closest('.pane');
  if (pane) pane.classList.add('sv-open');
  el.innerHTML =
    '<div class="sv">' +
      '<div class="sv-bar"><button class="sv-back" type="button">‹ Sessions</button>' +
        '<span class="sv-title"></span><span class="sess-dot" title="open and reachable"></span>' +
        '<span class="sv-where"></span></div>' +
      '<div class="sv-body"></div>' +
      '<div class="sv-input">' +
        '<button class="ai-mic sv-mic" type="button" aria-label="Tap to talk"><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="2" width="6" height="12" rx="3"></rect><path d="M5 11a7 7 0 0 0 14 0"></path><line x1="12" y1="18" x2="12" y2="22"></line></svg></button>' +
        '<input class="ai-text sv-text" type="text" placeholder="Message…" autocomplete="off">' +
        '<button class="ai-send sv-send" type="button">Send</button>' +
      '</div>' +
      '<div class="ai-status sv-status"></div>' +
    '</div>';
  paintHead();
  paintBody({ open: true });
  const box = el.querySelector('.sv-text'), mic = el.querySelector('.sv-mic'), status = el.querySelector('.sv-status');
  el.querySelector('.sv-back').addEventListener('click', showList);
  el.querySelector('.sv-send').addEventListener('click', () => sendWords(box.value));
  box.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); sendWords(box.value); } });
  // Spoken words go straight in, as they do on the watch and as this pane's launcher sends a dictated
  // prompt: `dryWhen` has the hub transcribe without enqueueing a voice command, and the transcript
  // is sent as the follow-up. Trailing silence ends the recording; a second tap ends it sooner.
  at.rec = makeRecorder({
    autoStop: true,
    dryWhen: () => true,
    onStatus: (t, kind) => { if (cur === at && kind !== 'prompt') status.textContent = t || ''; },
    onState: (s) => { mic.classList.toggle('ai-rec', s === 'rec'); mic.classList.toggle('ai-armed', s === 'armed'); },
    onTranscript: (t) => {
      const words = String(t || '').trim();
      if (cur !== at || !words) return;
      // Spoken while an earlier message is still going up: held in the box rather than dropped.
      if (at.sending) box.value = (box.value.trim() ? box.value.trim() + ' ' : '') + words;
      else sendWords(words);
    },
  });
  bindTap(mic, () => at.rec.toggle());
  return true;
}

// Back to the list, from the view's own button or from anything that needs the list on screen.
async function showList() {
  const el = document.getElementById('repospane');
  if (cur && cur.rec) cur.rec.stop();
  cur = null;
  const pane = el && el.closest('.pane');
  if (pane) pane.classList.remove('sv-open');
  await load();
}

// Called by the native app when a repo widget row is tapped (statushub://repo/<path>). The widget
// can't reach a microphone, so it hands the choice over and the recording happens here.
window.__startRepoSession = async (path) => {
  const el = document.getElementById('repospane');
  if (!el) return;
  try { window.__showPane && window.__showPane('repos'); } catch (_) {}
  if (!mounted) { mounted = true; }
  await showList();
  const li = el.querySelector(`li[data-path="${CSS.escape(String(path))}"]`);
  if (!li) return;
  li.scrollIntoView({ block: 'center', behavior: 'smooth' });
  beginDictation(li, machines.pi ? 'pi' : 'mac');
};

// Called by the native app when a session's reply notification is tapped: opens that session, so
// the reply the notification was about is what is on screen. A row that no longer exists lands on
// the list instead.
window.__showSession = async (id) => {
  const el = document.getElementById('repospane');
  if (!el) return;
  try { window.__showPane && window.__showPane('repos'); } catch (_) {}
  if (!mounted) { mounted = true; }
  if (!(await openSession(String(id)))) showList();
};

export function render() {
  if (mounted) return;                                // self-refreshing; not driven by the status stream
  if (!document.getElementById('repospane')) return;  // absent on kiosk/mac/page → no-op
  mounted = true;
  load();
  // Coming back to the app re-reads whichever is showing. Re-reading the list over an open session
  // would put him back on the list every time he switched apps mid-read.
  window.addEventListener('focus', () => (cur ? reloadDetail() : load()));
}
