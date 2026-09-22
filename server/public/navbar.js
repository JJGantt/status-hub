// Shared bottom navigation. PHONE WALL: just settings + the one voice button (chat/misc are swipe
// panes — no nav buttons needed). /page (desktop): adds chat + back-to-wall buttons. Right side is
// the single voice button — one dynamic route (Sonnet handles the simple stuff, escalates to Opus
// when it needs to) — tap-to-talk, driving the shared activity popup.
// Mounted once per page by core.js.
import { makeRecorder, makeListener, activityBar, enqueuePhoto, pendingPhotoCount, bindTap } from './voiceagent.js';
import { open as openSettings } from './settings.js';

const CHAT = '<svg viewBox="0 0 24 24" width="21" height="21" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path></svg>';

const SPARKLE = '<svg viewBox="0 0 24 24" width="25" height="25" fill="currentColor" aria-hidden="true">' +
  '<path d="M12 1c.6 5.7 4.3 9.4 10 10-5.7.6-9.4 4.3-10 10-.6-5.7-4.3-9.4-10-10 5.7-.6 9.4-4.3 10-10Z"/></svg>';
const GEAR = '<svg viewBox="0 0 24 24" width="21" height="21" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  '<circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z"></path></svg>';
const SWAP = '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  '<path d="M16 3l4 4-4 4M20 7H8M8 21l-4-4 4-4M4 17h12"></path></svg>';
const CAMERA = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  '<path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2Z"></path><circle cx="12" cy="13" r="4"></circle></svg>';
const CAL = '<svg viewBox="0 0 24 24" width="21" height="21" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  '<rect x="3" y="4" width="18" height="18" rx="2"></rect><line x1="16" y1="2" x2="16" y2="6"></line><line x1="8" y1="2" x2="8" y2="6"></line><line x1="3" y1="10" x2="21" y2="10"></line></svg>';

// The reset: back to the default scroll position everywhere at once. The phone's home page is a
// screen of scrollers — two heat maps and a plot on one axis, the day's strip, four lists — and
// each one holds where it was left, deliberately. This is the way back to now without a reload.
// Broadcast rather than called: whoever owns a scroll position listens, and nothing here has to know
// what those are or import them.
// Bars rising and falling — a mic that is listening rather than one you hold down.
// Five separate lines rather than one path: each bar has to move on its own for the level-meter
// animation, and a single path can only be animated as a whole.
const EAR = '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">' +
  '<line x1="4" y1="9" x2="4" y2="15"></line><line x1="8" y1="5" x2="8" y2="19"></line>' +
  '<line x1="12" y1="3" x2="12" y2="21"></line><line x1="16" y1="5" x2="16" y2="19"></line>' +
  '<line x1="20" y1="9" x2="20" y2="15"></line></svg>';
const RESET = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  '<path d="M3 12a9 9 0 1 0 3-6.7"></path><polyline points="3 4 3 10 9 10"></polyline></svg>';

export function mountNavbar() {
  if (document.querySelector('.navbar')) return;          // once per page
  const onWall = document.body.classList.contains('tv');  // wall ↔ page view
  const activity = activityBar();
  // local mic feedback → the shared activity popup, mapped exactly like the page-view FAB used to.
  const onStatus = (t, kind) => {
    if (kind === 'rec') activity.rec(t);
    else if (kind === 'prompt') activity.prompt(t);
    else if (kind === 'err') activity.err(t);
    else if (kind === 'clear') activity.clear();
    else activity.busy(t);
  };
  const mkVoice = (cls, svg, label) => {
    const b = document.createElement('button');
    b.className = 'wfab ' + cls; b.type = 'button'; b.setAttribute('aria-label', label);
    b.innerHTML = svg;
    // NO SILENCE DETECTION HERE. This button records exactly what he chose to record: one tap opens
    // the mic, the next sends it. Nothing ends a recording on his behalf, because a pause mid-sentence
    // is not the end of a sentence — the always-on button beside it is where a machine gets to decide.
    const rec = makeRecorder({ onStatus, quick: true,
      onState: (s) => { b.classList.toggle('rec', s === 'rec'); b.classList.toggle('armed', s === 'armed'); } });
    bindTap(b, () => rec.toggle());
    // The native app (opened via statushub://record from a home-screen shortcut) calls this to start the
    // exact same recorder without an on-screen tap — so it lands straight in "listening", like pressing it.
    if (cls === 'wfab-fast') window.__startVoiceCommand = () => rec.start();
    return b;
  };

  const gear = document.createElement('button');
  gear.className = 'nav-gear'; gear.type = 'button'; gear.setAttribute('aria-label', 'Settings');
  gear.innerHTML = GEAR; gear.addEventListener('click', () => openSettings());

  // The standalone calendar page: its left side is just the way back to the wall — chat and misc
  // aren't sections here, so their buttons would be dead.
  const onCal = location.pathname === '/calendar';
  const left = document.createElement('div'); left.className = 'navbar-grp';
  if (!onWall && !onCal) {
    // /page (desktop use): chat + status live as rows here; the buttons scroll to them, and the
    // toggle returns to the wall. The PHONE wall needs none of this — chat/misc are swipe panes.
    const goSection = (cls) => {
      const pages = document.querySelector('.pages');
      if (pages) {
        const i = [...pages.children].findIndex((p) => p.querySelector('.' + cls));
        if (i >= 0) pages.scrollTo({ left: i * pages.clientWidth, behavior: 'smooth' });
      } else {
        const el = document.querySelector('.' + cls);
        if (el) el.scrollIntoView({ behavior: 'smooth' });
      }
    };
    const chat = document.createElement('button');
    chat.className = 'nav-toggle nav-chat'; chat.type = 'button'; chat.innerHTML = CHAT;
    chat.setAttribute('aria-label', 'Conversation');
    chat.onclick = () => goSection('airow');
    const tog = document.createElement('button');
    tog.className = 'nav-toggle'; tog.type = 'button'; tog.innerHTML = SWAP;
    tog.setAttribute('aria-label', 'Back to the wall');
    tog.onclick = () => { location.href = '/'; };
    left.appendChild(chat); left.appendChild(tog);
  }
  if (onCal) {
    const tog = document.createElement('button');
    tog.className = 'nav-toggle'; tog.type = 'button'; tog.innerHTML = SWAP;
    tog.setAttribute('aria-label', 'Back to the wall');
    tog.onclick = () => { location.href = '/'; };
    left.appendChild(tog);
  } else if (!document.body.classList.contains('phonehome')) {
    // Everywhere the navbar mounts except the calendar itself and the phone's home page, where the
    // calendar opens by tapping the day strip: the way IN to the calendar.
    const cal = document.createElement('button');
    cal.className = 'nav-toggle'; cal.type = 'button'; cal.innerHTML = CAL;
    cal.setAttribute('aria-label', 'Calendar');
    cal.onclick = () => { location.href = '/calendar'; };
    left.appendChild(cal);
  }
  left.appendChild(gear);
  // Only where there is something to reset — the walls do not scroll and /page is one long page.
  if (document.body.classList.contains('phonehome')) {
    const reset = document.createElement('button');
    reset.className = 'nav-toggle'; reset.type = 'button'; reset.innerHTML = RESET;
    reset.setAttribute('aria-label', 'Back to now');
    reset.onclick = () => window.dispatchEvent(new CustomEvent('hubreset'));
    left.appendChild(reset);
  }
  const right = document.createElement('div'); right.className = 'navbar-grp';

  // One-shot photo: camera ONLY (no library — `capture` skips straight to the camera sheet), shrinks +
  // uploads + sends immediately as a photo-only message. For "one photo is all the context I need" —
  // the composer's attach button (review tray, add text) is for anything more deliberate than that.
  const camIn = document.createElement('input');
  camIn.type = 'file'; camIn.accept = 'image/*'; camIn.style.display = 'none';
  camIn.setAttribute('capture', 'environment');
  const camBtn = document.createElement('button');
  camBtn.className = 'wfab wfab-cam'; camBtn.type = 'button'; camBtn.setAttribute('aria-label', 'Quick photo');
  camBtn.innerHTML = CAMERA;
  camBtn.style.position = 'relative';
  // Count badge: photos captured but not yet sent (persisted in the durable outbox, so never lost).
  // Driven live by the outbox's 'hub-photo-outbox' event; seeded with the current count on mount.
  const camBadge = document.createElement('span');
  camBadge.style.cssText = 'position:absolute;top:-3px;right:-3px;min-width:17px;height:17px;padding:0 4px;border-radius:9px;background:#e0492f;color:#fff;font-size:11px;line-height:17px;text-align:center;font-weight:700;pointer-events:none;';
  camBadge.hidden = true;
  camBtn.appendChild(camBadge);
  const setCamBadge = (n) => { camBadge.textContent = String(n || 0); camBadge.hidden = !n; };
  window.addEventListener('hub-photo-outbox', (e) => setCamBadge((e.detail && e.detail.pending) || 0));
  pendingPhotoCount().then(setCamBadge);
  camBtn.addEventListener('click', () => camIn.click());
  camIn.addEventListener('change', async () => {
    const f = camIn.files && camIn.files[0]; camIn.value = '';
    if (!f) return;
    camBtn.disabled = true; camBtn.classList.add('busy');
    try {
      // persist-first: resolves as soon as the photo is safely queued; the upload+send proceed in the
      // background and survive a screen-lock, resuming automatically when the hub is reopened.
      await enqueuePhoto(f, (t, kind) => {
        if (!t) return;
        if (kind === 'done') activity.done(t);
        else if (kind === 'wait') activity.err(t);
        else activity.busy(t);
      });
    } catch (e) { activity.err(String(e.message || e)); }
    finally { camBtn.disabled = false; camBtn.classList.remove('busy'); }
  });
  right.appendChild(camBtn);
  // TYPE TO THE HUB. The microphone beside it is the fast way and the camera is the wordless one;
  // this is the one for words you would rather not say out loud, or that a transcript gets wrong.
  // It opens the whole chat rather than a bare input, because composing a reply means seeing what
  // you are replying to — which is the only thing the home page's tail of the thread cannot give
  // you while the keyboard is covering half the screen.
  // OPENING THE CHAT IS NOW THE THREAD'S OWN JOB. The one-line prompt/reply strip on the home page is
  // already the conversation in miniature, so tapping it is the obvious way in — and it frees the slot
  // beside the microphone for the button that needed one. The sheet it opens is unchanged: the whole
  // thread, because composing a reply means seeing what you are replying to.
  const chatSheet = document.getElementById('ph-chat');
  if (chatSheet) {
    const log = document.getElementById('ai-log');
    const openChat = () => {
      chatSheet.classList.add('open');
      // The newest line first, then the focus — focusing first makes iOS scroll the page itself to
      // the input and the log lands wherever that left it.
      if (log) log.scrollTop = log.scrollHeight;
      const t = document.getElementById('ai-text');
      if (t) requestAnimationFrame(() => t.focus());
    };
    const strip = document.getElementById('ph-conv');
    if (strip) { strip.classList.add('tappable'); strip.addEventListener('click', openChat); }
    const close = () => { chatSheet.classList.remove('open'); const t = document.getElementById('ai-text'); if (t) t.blur(); };
    const x = document.getElementById('ph-chat-x');
    if (x) x.addEventListener('click', close);
    // Back to now closes it, like every other sheet on the page.
    window.addEventListener('hubreset', close);
  }
  // ALWAYS-ON, in the slot the keyboard had. Engaged, the phone behaves like the Mac and the ESP: it
  // listens, cuts each utterance at the silence after it, sends it, and keeps listening until this is
  // pressed again. The microphone beside it stays the deliberate one.
  if (document.getElementById('ph-conv')) {
    const ear = document.createElement('button');
    ear.className = 'wfab wfab-listen'; ear.type = 'button'; ear.setAttribute('aria-label', 'Always-on listening');
    ear.innerHTML = EAR;
    // Three states in one button, because nothing else on screen says any of it: engaged and waiting,
    // hearing him right now, and sending what it heard. `on` stays set through all of them — it is
    // what says the microphone is still open at all.
    const lis = makeListener({ onStatus,
      onState: (st) => {
        ear.classList.toggle('on', st !== 'idle');
        ear.classList.toggle('hearing', st === 'hearing');
        ear.classList.toggle('sending', st === 'sending');
      } });
    bindTap(ear, () => lis.toggle());
    // Leaving the page cannot leave a microphone open behind it.
    window.addEventListener('pagehide', () => lis.disengage());
    document.addEventListener('visibilitychange', () => { if (document.hidden) lis.disengage(); });
    right.appendChild(ear);
  }
  right.appendChild(mkVoice('wfab-fast', SPARKLE, 'Voice command'));

  const bar = document.createElement('div'); bar.className = 'navbar';
  bar.appendChild(left); bar.appendChild(right);
  bar.appendChild(camIn);
  document.body.appendChild(bar);
}
