// TV Guide pane — the bedroom TV's TV Guide (google-tv docs/GUIDE.md) on the phone: the same titled
// shelves of thumbnails, each with its service's icon, its note and its description, read from /api/tv/guide. Tapping a
// card plays it on the bedroom TV (/api/tv/guide/open), waking the TV if it is off.
//
// Redrawn when the shelves change: the hub sends a `guide` event on the session stream the phone
// already holds (cards/sessions.js passes it on as `hub:guide`), and on the way back to the app.
// No-ops where #guidepane is absent.
import { esc } from '../shared.js';

// Package to the site whose icon badges its items, as on the TV (google-tv Guide.java SITES).
const SITES = {
  'com.google.android.youtube.tv': 'youtube.com',
  'com.netflix.ninja': 'netflix.com',
  'com.amazon.amazonvideo.livingroom': 'primevideo.com',
  'com.apple.atve.androidtv.appletv': 'tv.apple.com',
  'com.disney.disneyplus': 'disneyplus.com',
  'com.hulu.livingroomplus': 'hulu.com',
  'com.wbd.stream': 'max.com',
  'com.tubitv': 'tubitv.com',
};

let mounted = false;

function card(it) {
  const site = SITES[it.package];
  return `<button class="gd-card" type="button" data-id="${esc(it.id)}">` +
    '<span class="gd-thumb">' +
      (it.image ? `<img class="gd-img" src="${esc(it.image)}" alt="" loading="lazy">` : '') +
      (site ? `<img class="gd-badge" src="https://www.google.com/s2/favicons?domain=${site}&sz=64" alt="">` : '') +
      (it.note ? `<span class="gd-note">${esc(it.note)}</span>` : '') +
    '</span>' +
    `<span class="gd-title">${esc(it.title || '')}</span>` +
    (it.description ? `<span class="gd-desc">${esc(it.description)}</span>` : '') +
  '</button>';
}

function html(shelves) {
  return shelves.filter((s) => s.items && s.items.length).map((s) =>
    `<section class="gd-shelf"><h3>${esc(s.title || '')}</h3><div class="gd-row">${s.items.map(card).join('')}</div></section>`).join('');
}

async function load() {
  const el = document.getElementById('guidepane');
  if (!el) return;
  let d;
  try { d = await (await fetch('/api/tv/guide')).json(); } catch (_) { return; }
  if (!d || !Array.isArray(d.shelves)) return;
  // Each row keeps its scroll across a redraw, so an edit does not throw you back to its start.
  const rows = [...el.querySelectorAll('.gd-row')].map((r) => r.scrollLeft);
  el.innerHTML = html(d.shelves);
  el.querySelectorAll('.gd-row').forEach((r, i) => { r.scrollLeft = rows[i] || 0; });
}

async function play(btn) {
  btn.classList.add('gd-sent');
  setTimeout(() => btn.classList.remove('gd-sent'), 1200);
  try {
    const r = await fetch('/api/tv/guide/open', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: btn.dataset.id }) });
    if (!r.ok) console.error('[guide] open', r.status);
  } catch (e) { console.error('[guide] open', e); }
}

export function render() {
  if (mounted) return;
  const el = document.getElementById('guidepane');
  if (!el) return;
  mounted = true;
  el.addEventListener('click', (e) => {
    const btn = e.target.closest('.gd-card');
    if (btn) play(btn);
  });
  load();
  window.addEventListener('hub:guide', load);
  window.addEventListener('focus', load);
}
