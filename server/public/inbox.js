// THE INBOX, on the phone — the mirror of the watch's (docs/WATCH.md § The inbox).
//
// Every reply flagged worth reading, newest first, kept for good: unread rows bright, read rows dimmed,
// nothing ever leaving the list, so an answer marked read by accident is still one tap away. A dot in
// the conversation's corner opens it — amber while anything is unread, gray otherwise, and there always,
// because the inbox is how an old answer is reread.
//
// A session's row opens that session (`__showSession`), closing the inbox first. Its id rides `data-sid`, not
// `data-sess`: cards/repos.js opens any `[data-sess]` tapped anywhere on the page, in the capture phase,
// which would open the session behind the inbox and leave the list on top.
// Any other row opens ON ITS OWN, not in the main thread: the question, then the answer, landed on the answer.
// While it is open the NEXT command sent from the page is about it (`setAbout` in voiceagent.js): it
// carries the answer as context, and sending it closes the inbox, so the command and its reply go in
// line in the main thread like any other.
import { onThread, setAbout } from './voiceagent.js';
import { md, esc } from './shared.js';

const PAGE = 60;
let dot = null, sheet = null, listEl = null, viewEl = null;
let rows = [], done = false, busy = false;
let openId = null;
let unread = false;

function when(iso) {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return '';
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  return sameDay
    ? d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
    : d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

function paintDot() { if (dot) dot.classList.toggle('unread', unread); }

async function fetchPage(before) {
  const r = await fetch('/api/voice-inbox?limit=' + PAGE + (before ? '&before=' + encodeURIComponent(before) : ''));
  if (!r.ok) throw new Error('voice-inbox ' + r.status);
  return r.json();
}

// The dot's colour, and the list when it is open. The first page only: rows further back do not change
// when a new answer lands, and re-reading them would throw away the reader's place.
async function refresh() {
  try {
    const j = await fetchPage(null);
    unread = !!j.unread; paintDot();
    if (sheet && sheet.classList.contains('open') && !openId) {
      const have = new Map(rows.map((x) => [x.id, x]));
      for (const x of j.rows) have.set(x.id, x);
      rows = [...have.values()].sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
      paintList();
    }
  } catch (e) { console.error('inbox: refresh failed', e); }
}
let refreshT = 0;
const soon = () => { clearTimeout(refreshT); refreshT = setTimeout(refresh, 300); };

function paintList() {
  if (!listEl) return;
  // Repainted in place: the list's scroll position is the reader's, so nothing here touches it.
  listEl.innerHTML = rows.length
    ? rows.map((x) => `<button type="button" class="ib-row${x.read ? ' read' : ''}${x.session_id ? ' sess' : ''}" data-id="${esc(x.id)}"${x.session_id ? ` data-sid="${esc(x.session_id)}"` : ''}>` +
        `<span class="ib-label">${esc(x.label || '')}</span><span class="ib-when">${esc(when(x.at))}</span></button>`).join('')
    : '';
}

async function loadMore() {
  if (busy || done) return;
  busy = true;
  try {
    const last = rows[rows.length - 1];
    const j = await fetchPage(last ? last.at : null);
    const have = new Set(rows.map((x) => x.id));
    rows = rows.concat(j.rows.filter((x) => !have.has(x.id)));
    if (j.rows.length < PAGE) done = true;
    paintList();
  } catch (e) { console.error('inbox: loading older answers failed', e); }
  finally { busy = false; }
}

function openList() {
  build();
  openId = null; setAbout(null);
  viewEl.hidden = true; listEl.hidden = false;
  sheet.classList.add('open');
  rows = []; done = false;
  listEl.scrollTop = 0;
  loadMore();
}
function close() {
  if (!sheet) return;
  sheet.classList.remove('open');
  openId = null; setAbout(null);
}

// One answer on its own, landed on the answer.
async function paintView(id) {
  try {
    const r = await fetch('/api/voice-inbox/' + encodeURIComponent(id));
    if (!r.ok) throw new Error('voice-inbox/:id ' + r.status);
    const a = await r.json();
    if (openId !== id) return;                       // closed or moved on while it loaded
    viewEl.innerHTML =
      (a.question ? `<div class="ib-q">${md(a.question)}</div>` : '') +
      `<div class="ib-a${a.session_id ? ' sess' : ''}" id="ib-answer">` +
        (a.session_id ? `<span class="ib-k">${esc(a.session_label || '')}</span>` : '') +
        `${md(a.answer)}</div>`;
    const el = document.getElementById('ib-answer');
    if (el) viewEl.scrollTop += el.getBoundingClientRect().top - viewEl.getBoundingClientRect().top;
    if (!a.read) {
      fetch('/api/voice-messages/read', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id }) }).catch((e) => console.error('inbox: marking read failed', e));
      const row = rows.find((x) => x.id === id); if (row) row.read = true;
    }
  } catch (e) { console.error('inbox: opening an answer failed', e); }
}
// A session's answer opens the session itself, where it can be read in full and answered.
function openSession(id, sid) {
  const row = rows.find((x) => x.id === id);
  if (row && !row.read) {
    fetch('/api/voice-messages/read', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id }) }).catch((e) => console.error('inbox: marking read failed', e));
    row.read = true;
  }
  close();
  if (window.__showSession) window.__showSession(sid);
}

function openView(id) {
  openId = id; setAbout(id);
  listEl.hidden = true; viewEl.hidden = false;
  viewEl.innerHTML = '';
  paintView(id);
}
function back() {
  openId = null; setAbout(null);
  viewEl.hidden = true; listEl.hidden = false;
  paintList();
  soon();
}

function build() {
  if (sheet) return;
  sheet = document.createElement('div');
  sheet.className = 'ib-sheet';
  // One button: from an open answer it steps back to the list, from the list it closes, as on the watch.
  sheet.innerHTML = '<div class="ib-head"><button type="button" class="ib-x" aria-label="Close">✕</button></div>' +
    '<div class="ib-list"></div><div class="ib-view" hidden></div>';
  document.body.appendChild(sheet);
  listEl = sheet.querySelector('.ib-list');
  viewEl = sheet.querySelector('.ib-view');
  sheet.querySelector('.ib-x').addEventListener('click', () => (openId ? back() : close()));
  listEl.addEventListener('click', (e) => {
    const b = e.target.closest('.ib-row');
    if (!b) return;
    if (b.dataset.sid) openSession(b.dataset.id, b.dataset.sid); else openView(b.dataset.id);
  });
  listEl.addEventListener('scroll', () => {
    if (listEl.scrollTop + listEl.clientHeight > listEl.scrollHeight - 200) loadMore();
  }, { passive: true });
}

function mount() {
  const card = document.querySelector('.ph-convcard');
  if (!card || dot) return;
  dot = document.createElement('button');
  dot.type = 'button'; dot.className = 'ib-dot'; dot.setAttribute('aria-label', 'Inbox');
  card.appendChild(dot);
  dot.addEventListener('click', openList);
  // Event-driven: a new or newly read answer arrives on the thread's own stream, and `null` is a
  // resync (connect, foreground).
  onThread((row) => { if (!row || row.role === 'assistant') soon(); });
  // A command sent while an answer was open carried it as context; the command and its reply belong in
  // the main thread, so the inbox gets out of the way.
  window.addEventListener('hub:aboutsent', close);
  window.addEventListener('hubreset', close);
  // A tapped answer notification whose answer is too old for the chat's thread (`__showAnswer`).
  window.__showInboxAnswer = (id) => { build(); sheet.classList.add('open'); openView(id); };
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount);
else mount();
