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
  el.innerHTML =
    '<div class="devstrip">' +
      '<div class="devchips">' +
        chip('Model', MODEL[r.model] || r.model) +
        chip('Think', THINK[r.thinking] || r.thinking) +
        chip('Runner', RUNNER[r.runner] || r.runner) +
        chip('AO', r.wake ? 'On' : 'Off', r.wake ? '#39d353' : '#5c6675') +  // AO = always-on (wake-free) voice
        chip('INJ', r.inject ? 'On' : 'Off', r.inject ? '#39d353' : '#5c6675') +  // INJ = voice-inject mode
      '</div>' +
    '</div>';
}
