// The SHOWN session — the most recently pinned, else the most recently active running one
// (desk_sessions_state(), data-layer 00164) — named at the right of the wall's footer row, with the pin
// when it is one. It earns a permanent slot because it moves as sessions take turns.
//
// The repo name and nothing else — no caption. The box IS the statement: something is holding
// follow-ups, and it is this. A word explaining that is text on a wall nobody reads from a chair.
import { esc, PIN_SVG } from '../shared.js';

export function render(s) {
  const el = document.getElementById('tv-follow');
  if (!el) return;                                   // absent on the phone dashboard → no-op
  const f = s && s.desk_focus;
  // Nothing running, or a dispatch still opening. Render nothing at all — an empty box on a display
  // nobody interacts with is worse than no box.
  if (!f) { el.innerHTML = ''; return; }
  el.innerHTML = '<span class="tv-follow-box">' + (f.pinned ? PIN_SVG : '') + esc(f.repo || f.id) + '</span>';
}
