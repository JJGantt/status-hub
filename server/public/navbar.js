// Shared bottom navigation. PHONE WALL: just settings + the two voice buttons (chat/misc are swipe
// panes — no nav buttons needed). /page (desktop): adds chat + back-to-wall buttons. Right side is
// always brain (full Opus) + sparkle (fast) voice, tap-to-talk, driving the shared activity popup.
// Mounted once per page by core.js.
import { makeRecorder, activityBar } from './voiceagent.js';
import { open as openSettings } from './settings.js';

const CHAT = '<svg viewBox="0 0 24 24" width="21" height="21" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path></svg>';

const SPARKLE = '<svg viewBox="0 0 24 24" width="25" height="25" fill="currentColor" aria-hidden="true">' +
  '<path d="M12 1c.6 5.7 4.3 9.4 10 10-5.7.6-9.4 4.3-10 10-.6-5.7-4.3-9.4-10-10 5.7-.6 9.4-4.3 10-10Z"/></svg>';
const BRAIN = '<svg viewBox="0 0 24 24" width="21" height="21" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  '<path d="M12 5a3 3 0 1 0-5.997.142 4 4 0 0 0-2.526 5.77 4 4 0 0 0 .556 6.588A4 4 0 1 0 12 18Z"></path>' +
  '<path d="M12 5a3 3 0 1 1 5.997.142 4 4 0 0 1 2.526 5.77 4 4 0 0 1-.556 6.588A4 4 0 1 1 12 18Z"></path></svg>';
const GEAR = '<svg viewBox="0 0 24 24" width="21" height="21" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  '<circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z"></path></svg>';
const SWAP = '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  '<path d="M16 3l4 4-4 4M20 7H8M8 21l-4-4 4-4M4 17h12"></path></svg>';

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
  const mkVoice = (cls, svg, tier, label) => {
    const b = document.createElement('button');
    b.className = 'wfab ' + cls; b.type = 'button'; b.setAttribute('aria-label', label);
    b.innerHTML = svg;
    const rec = makeRecorder({ onStatus, onActive: (a) => b.classList.toggle('rec', a), quick: true, autoStop: true, tier });
    b.addEventListener('click', () => rec.toggle());
    return b;
  };

  const gear = document.createElement('button');
  gear.className = 'nav-gear'; gear.type = 'button'; gear.setAttribute('aria-label', 'Settings');
  gear.innerHTML = GEAR; gear.addEventListener('click', () => openSettings());

  const left = document.createElement('div'); left.className = 'navbar-grp';
  if (!onWall) {
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
  left.appendChild(gear);
  const right = document.createElement('div'); right.className = 'navbar-grp';
  right.appendChild(mkVoice('wfab-power', BRAIN, 'power', 'Voice command (full Opus thinking)'));
  right.appendChild(mkVoice('wfab-fast', SPARKLE, 'fast', 'Quick voice command (efficiency)'));

  const bar = document.createElement('div'); bar.className = 'navbar';
  bar.appendChild(left); bar.appendChild(right);
  document.body.appendChild(bar);
}
