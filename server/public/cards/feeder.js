// Cat feeder status card. Reads s.feeder (device_status row, device='cat-feeder', with a .data
// payload mirrored from the feeder over the LAN). Null-safe: no-ops where #feeder is absent
// (e.g. the TV wall, which intentionally omits this tile for now).
import { ago } from '../shared.js';

const FOOD_COLOR = { full: '#22c55e', medium: '#eab308', mid: '#eab308', low: '#f97316', empty: '#ef4444' };
const MOTOR = { standby: 'Idle', feeding: 'Feeding…' };

// Next enabled scheduled feed, by clock (schedule times are the feeder's local time ≈ ET, same as the browser).
function nextFeed(sched) {
  if (!sched || !sched.length) return null;
  const now = new Date();
  const nowMin = now.getHours() * 60 + now.getMinutes();
  const mins = sched.map((e) => ({ e, m: e.hour * 60 + e.minute }));
  const later = mins.filter((x) => x.m > nowMin).sort((a, b) => a.m - b.m);
  return (later[0] || mins.sort((a, b) => a.m - b.m)[0]).e; // wraps to tomorrow's first
}

export function render(s) {
  const el = document.getElementById('feeder');
  if (!el) return;                       // absent on the TV wall
  const F = s.feeder;
  if (!F) { el.innerHTML = '<h2>Cat Feeder</h2><div class=big>—</div>'; return; }
  const d = F.data || {};
  const online = F.online;
  const food = d.food_level || 'unknown';
  const motor = F.status || '';
  const sched = (d.schedule || []).filter((e) => e.enabled);
  const next = nextFeed(sched);

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
    '<div class=feed-sched>' +
      '<div class=feed-shead>Schedule' + (next ? ' · next ' + next.time : '') + '</div>' +
      schedRows +
    '</div>';
}
