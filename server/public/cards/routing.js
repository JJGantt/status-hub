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
  // The session a spoken follow-up lands in, above the chips. It is the one piece of state here you
  // cannot infer by looking at anything else — it follows the last thing dispatched by VOICE, not the
  // session on screen and not the one that spoke last, so without showing it the session you have in
  // mind and the one that will receive your words can differ silently.
  //
  // Nothing dispatched, or a pointer left over from a closed session, is a real state and says so.
  const f = s.desk_focus;
  const name = f ? (f.label || f.repo || f.id) : null;
  const focusRow =
    '<div class="tv-focus' + (f ? ' on' : '') + '">' +
      '<span class="tf-l">Follow-ups</span>' +
      '<span class="tf-v">' + (name ? esc(name) : 'none') + '</span>' +
      (f && f.label && f.repo && f.label !== f.repo ? '<span class="tf-r">' + esc(f.repo) + '</span>' : '') +
    '</div>';

  el.innerHTML =
    '<div class="devstrip">' +
      focusRow +
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
