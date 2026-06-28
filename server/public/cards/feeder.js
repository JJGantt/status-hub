// Cat feeder status card. Reads s.feeder (device_status row, device='cat-feeder', with a .data
// payload mirrored from the feeder over the LAN). Null-safe: no-ops where #feeder is absent
// (e.g. the TV wall, which intentionally omits this tile for now).
//
// "Feed now" posts to /api/feed, which enqueues a command the Pi collector executes on the LAN
// (the Fly hub can't reach the feeder directly). The button shows "Feeding…" until the feed log
// (data.last_fed_at) actually advances — real confirmation, not just an optimistic flip.
import { ago, state } from '../shared.js';

const FOOD_COLOR = { full: '#22c55e', medium: '#eab308', mid: '#eab308', low: '#f97316', empty: '#ef4444' };
const MOTOR = { standby: 'Idle', feeding: 'Feeding…' };

let busy = false;          // a feed is in flight
let pendingPrevFed = null; // last_fed_at value at the moment we requested — busy clears when it changes
let busyTimer = 0;

// Next enabled scheduled feed, by clock (schedule times are the feeder's local time ≈ ET, same as the browser).
function nextFeed(sched) {
  if (!sched || !sched.length) return null;
  const now = new Date();
  const nowMin = now.getHours() * 60 + now.getMinutes();
  const mins = sched.map((e) => ({ e, m: e.hour * 60 + e.minute }));
  const later = mins.filter((x) => x.m > nowMin).sort((a, b) => a.m - b.m);
  return (later[0] || mins.sort((a, b) => a.m - b.m)[0]).e; // wraps to tomorrow's first
}

async function requestFeed(el, curFed) {
  if (busy) return;
  busy = true;
  pendingPrevFed = curFed;
  clearTimeout(busyTimer);
  busyTimer = setTimeout(() => { busy = false; render(state.last); }, 30000); // fail-safe un-stick
  render(state.last);
  try {
    const r = await fetch('/api/feed', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ portions: 1 }),
    });
    if (!r.ok) throw new Error('feed request failed');
  } catch (_) {
    busy = false; clearTimeout(busyTimer); render(state.last);
  }
}

export function render(s) {
  const el = document.getElementById('feeder');
  if (!el) return;                       // absent on the TV wall
  const F = s && s.feeder;
  if (!F) { el.innerHTML = '<h2>Cat Feeder</h2><div class=big>—</div>'; return; }
  const d = F.data || {};
  const online = F.online;
  const food = d.food_level || 'unknown';
  const motor = F.status || '';
  const sched = (d.schedule || []).filter((e) => e.enabled);
  const next = nextFeed(sched);

  // Clear the "Feeding…" state once the feed log advances past what it was when we tapped.
  if (busy && d.last_fed_at && d.last_fed_at !== pendingPrevFed) { busy = false; clearTimeout(busyTimer); }

  const chip = (label, val, col) => '<span class=devchip><span class=dc-l>' + label + '</span>' +
    '<span class=dc-v style="color:' + (col || '#e6eaf0') + '">' + val + '</span></span>';

  const statusDot = '<span class=dot style="background:' +
    (!online ? '#ef4444' : motor === 'feeding' ? '#eab308' : '#22c55e') + '"></span>' +
    (!online ? 'Offline' : (MOTOR[motor] || motor || 'Idle'));

  const lastFed = d.last_fed_at
    ? ago(d.last_fed_at) + (d.last_fed_portions ? ' · ' + d.last_fed_portions + 'p' : '')
    : '—';

  const schedRows = sched.length
    ? sched.map((e) => '<div class="feed-srow' + (next && e.time === next.time ? ' feed-next' : '') + '">' +
        '<span class=feed-st>' + e.time + '</span>' +
        '<span class=feed-sp>' + e.portions + ' portion' + (e.portions > 1 ? 's' : '') + '</span></div>').join('')
    : '<div class=feed-srow><span class=feed-st>—</span></div>';

  el.innerHTML =
    '<h2>Cat Feeder</h2>' +
    '<div class=devstrip><div class=devchips>' +
      chip('', statusDot, '#e6eaf0') +
      chip('Food', food, FOOD_COLOR[food] || '#8b96a5') +
      chip('Last fed', lastFed) +
    '</div></div>' +
    '<button type=button class="feed-btn' + (busy ? ' busy' : '') + '"' + (busy ? ' disabled' : '') + '>' +
      (busy ? 'Feeding…' : 'Feed now') + '</button>' +
    '<div class=feed-sched>' +
      '<div class=feed-shead>Schedule' + (next ? ' · next ' + next.time : '') + '</div>' +
      schedRows +
    '</div>';

  // Attach the click handler once; it survives innerHTML rebuilds because it lives on #feeder.
  if (!el.dataset.feedBound) {
    el.dataset.feedBound = '1';
    el.addEventListener('click', (ev) => {
      if (!ev.target.closest('.feed-btn')) return;
      const cur = (state.last && state.last.feeder && state.last.feeder.data || {}).last_fed_at || null;
      requestFeed(el, cur);
    });
  }
}
