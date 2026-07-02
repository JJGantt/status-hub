// Voice-system liveness — page status strip. Same data as the TV routing strip's ESP/Mac/Pi/Wkr
// chips (`s.mics`: mic alive-beacons + worker heartbeats), rendered as its own status card on the
// page, which has no routing panel. Paints #mics; no-ops where absent (the TV wall).
export function render(s) {
  const el = document.getElementById('mics');
  if (!el) return;
  const m = s && s.mics;
  if (!m) { el.innerHTML = '<h2>Voice System</h2>'; return; }
  const UP = '#39d353', DOWN = '#f85149';
  const chip = (label, val, color) =>
    '<span class="devchip"><span class="dc-l">' + label + '</span>' +
    '<span class="dc-v" style="color:' + color + '">' + val + '</span></span>';
  const liveWorker = m.workers && (m.workers.mac ? 'Mac' : m.workers.pi ? 'Pi' : m.workers.fly ? 'Fly' : null);
  el.innerHTML =
    '<h2>Voice System</h2>' +
    '<div class="devstrip"><div class="devchips">' +
      chip('ESP mic', m.esp ? 'Up' : 'Down', m.esp ? UP : DOWN) +
      chip('Mac mic', m.mac ? 'Up' : 'Down', m.mac ? UP : DOWN) +
      chip('Pi', m.workers && m.workers.pi ? 'Up' : 'Down', m.workers && m.workers.pi ? UP : DOWN) +
      chip('Worker', liveWorker || 'Down', liveWorker ? UP : DOWN) +
    '</div></div>';
}
