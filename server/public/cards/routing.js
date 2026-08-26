// Routing/liveness panel — TV top status strip. Routing is fixed now (standard Sonnet→Opus), so this
// shows always-on + inject state and the mic/worker liveness from the dashboard stream. Reuses the
// litter card's devstrip + devchip markup so it matches. Paints #tv-routing; no-ops where absent (phone).

const esc = (v) => String(v == null ? '' : v)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export function render(s) {
  const el = document.getElementById('tv-routing');
  if (!el) return;
  const r = s && s.routing;
  if (!r) { el.innerHTML = ''; return; }
  const chip = (label, val, color) =>
    '<span class="devchip"><span class="dc-l">' + label + '</span>' +
    '<span class="dc-v"' + (color ? ' style="color:' + color + '"' : '') + '>' + val + '</span></span>';
  // Liveness chips (s.mics): mic beacons + worker heartbeats. Pi is that worker's own heartbeat
  // (independent of priority). Wkr shows the highest-priority live worker (the one that would
  // claim the next command), red 'Down' when none is.
  const m = s.mics || {};
  const liveWorker = m.workers && (m.workers.mac ? 'Mac' : m.workers.pi ? 'Pi' : m.workers.fly ? 'Fly' : null);
  const UP = '#39d353', DOWN = '#f85149';
  // The session a spoken follow-up would land in, as a small box on the SAME line as the chips —
  // it takes the empty space in the middle of the strip rather than adding a row, because the strip's
  // height is fixed by the cards either side of it.
  //
  // Rendered only when there is one. The pointer outlives the session it named, and an empty box or
  // the word "none" would be noise on a wall you glance at.
  const f = s.desk_focus;
  const box = f ? '<span class="tv-sess">' + esc(f.repo || f.id) + '</span>' : '';

  el.innerHTML =
    '<div class="devstrip">' +
      box +
      '<div class="devchips">' +
        chip('AO', r.wake ? 'On' : 'Off', r.wake ? '#39d353' : '#5c6675') +  // AO = always-on (wake-free) voice
        chip('INJ', r.inject ? 'On' : 'Off', r.inject ? '#39d353' : '#5c6675') +  // INJ = voice-inject mode
        chip('ESP', m.esp ? 'Up' : 'Down', m.esp ? UP : DOWN) +
        chip('Mac', m.mac ? 'Up' : 'Down', m.mac ? UP : DOWN) +
        chip('Pi', m.workers && m.workers.pi ? 'Up' : 'Down', m.workers && m.workers.pi ? UP : DOWN) +
        chip('Wkr', liveWorker || 'Down', liveWorker ? UP : DOWN) +
      '</div>' +
    '</div>';
}
