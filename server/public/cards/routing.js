// Routing/liveness panel — TV top status strip. Routing is fixed (every turn is Opus), so this
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
  // BARE labels for the yes/no facts — no chip, no "Up"/"Off" word. Lit means up, dim means down, and
  // a dead one is the only grey thing in a row of green. That frees the width the machine readout
  // below needs, on a strip that must never wrap (see #tv-routing in app.css).
  const flag = (label, on, bad) =>
    '<span class="rt-flag' + (on ? ' on' : bad ? ' bad' : '') + '">' + label + '</span>';
  // Anything carrying a VALUE keeps a chip, because the value is the point and a bare number beside a
  // bare label reads as two labels.
  const chip = (label, val, state) =>
    '<span class="rt-chip' + (state ? ' rt-' + state : '') + '"><span class="rt-k">' + label +
    '</span><span class="rt-v">' + val + '</span></span>';
  // Liveness (s.mics): mic beacons + worker heartbeats. Pi is that worker's own heartbeat, independent
  // of priority. Wkr names the highest-priority live worker — the one that would claim the next
  // command — so it keeps a value where the rest are flags.
  const m = s.mics || {};
  const liveWorker = m.workers && (m.workers.mac ? 'Mac' : m.workers.pi ? 'Pi' : m.workers.fly ? 'Fly' : null);
  const h = m.host;
  el.innerHTML =
    '<div class="devstrip"><div class="devchips rt-row">' +
      flag('INJ', !!r.inject, false) +
      flag('ESP', !!m.esp, true) +
      flag('MAC', !!m.mac, true) +
      flag('PI', !!(m.workers && m.workers.pi), true) +
      '<span class="rt-sep"></span>' +
      chip('WKR', liveWorker || 'Down', liveWorker ? null : 'crit') +
      // The Pi's own resources. Absent when its heartbeat is stale — better to show nothing than a
      // number frozen at whatever it was when the machine stopped talking.
      (h ? chip('MEM', h.mem + '%', h.mem_state) : '') +
      (h && h.swap != null ? chip('SWP', h.swap + '%', h.swap_state) : '') +
      (h && h.sessions != null ? chip('SES', String(h.sessions), null) : '') +
    '</div></div>';
}
