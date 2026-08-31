// Routing/liveness panel — TV top status strip. Routing is fixed now (standard Sonnet→Opus), so this
// shows inject state and the mic/worker liveness from the dashboard stream. Reuses the litter card's
// devstrip + devchip markup so it matches. Paints #tv-routing; the chips no-op where absent (phone),
// but the always-on border paint below runs on EVERY surface.

export function render(s) {
  const r = s && s.routing;
  // Always-on state rides a body class that colors the TV wall's PERSISTENT footer row border
  // (green on / red off) — it replaced the AO chip this card used to show. TV footer ONLY: no other
  // surface indicates it (the phone popup's border stays its normal gray).
  if (r) {
    document.body.classList.toggle('ao-on', !!r.wake);
    document.body.classList.toggle('ao-off', !r.wake);
  }
  const el = document.getElementById('tv-routing');
  if (!el) return;
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
  el.innerHTML =
    '<div class="devstrip">' +
      '<div class="devchips">' +
        chip('INJ', r.inject ? 'On' : 'Off', r.inject ? '#39d353' : '#5c6675') +  // INJ = voice-inject mode
        chip('ESP', m.esp ? 'Up' : 'Down', m.esp ? UP : DOWN) +
        chip('Mac', m.mac ? 'Up' : 'Down', m.mac ? UP : DOWN) +
        chip('Pi', m.workers && m.workers.pi ? 'Up' : 'Down', m.workers && m.workers.pi ? UP : DOWN) +
        chip('Wkr', liveWorker || 'Down', liveWorker ? UP : DOWN) +
      '</div>' +
    '</div>';
}
