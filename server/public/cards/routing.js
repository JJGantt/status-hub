// Routing panel — TV top status strip. Shows the agent's live config from the dashboard stream's
// `routing` field: Model / Thinking / Runner / wake-free voice. Reuses the litter card's devstrip +
// devchip markup so it matches the strip visually. Paints #tv-routing; no-ops where absent (phone).
const MODEL = { haiku: 'Haiku', sonnet: 'Sonnet', opus: 'Opus' };
const THINK = { none: 'None', medium: 'Medium', max: 'Maximum' };
const RUNNER = { local: 'Local', api: 'API' };

export function render(s) {
  const el = document.getElementById('tv-routing');
  if (!el) return;
  const r = s && s.routing;
  if (!r) { el.innerHTML = ''; return; }
  const chip = (label, val, color) =>
    '<span class="devchip"><span class="dc-l">' + label + '</span>' +
    '<span class="dc-v"' + (color ? ' style="color:' + color + '"' : '') + '>' + val + '</span></span>';
  // Liveness chips (s.mics): mic beacons + worker heartbeats. Wkr shows the highest-priority live
  // worker (the one that would claim the next command), red 'Down' when none is.
  const m = s.mics || {};
  const liveWorker = m.workers && (m.workers.mac ? 'Mac' : m.workers.pi ? 'Pi' : m.workers.fly ? 'Fly' : null);
  const UP = '#39d353', DOWN = '#f85149';
  el.innerHTML =
    '<div class="devstrip">' +
      '<div class="devchips">' +
        chip('Model', MODEL[r.model] || r.model) +
        chip('Think', THINK[r.thinking] || r.thinking) +
        chip('Runner', RUNNER[r.runner] || r.runner) +
        chip('AO', r.wake ? 'On' : 'Off', r.wake ? '#39d353' : '#5c6675') +  // AO = always-on (wake-free) voice
        chip('INJ', r.inject ? 'On' : 'Off', r.inject ? '#39d353' : '#5c6675') +  // INJ = voice-inject mode
        chip('ESP', m.esp ? 'Up' : 'Down', m.esp ? UP : DOWN) +
        chip('Mac', m.mac ? 'Up' : 'Down', m.mac ? UP : DOWN) +
        chip('Wkr', liveWorker || 'Down', liveWorker ? UP : DOWN) +
      '</div>' +
    '</div>';
}
