// The session a spoken follow-up would land in — pinned to the right of the wall's footer row.
//
// It earns a permanent slot because it is the one thing on that screen you cannot work out by
// looking: the pointer follows the last thing dispatched by VOICE, not the session you are looking
// at and not the one that spoke most recently. Without it, the session you have in mind and the one
// that will receive your words can differ silently.
//
// Repo name only. The wall is read from across a room; the label and last reply belong on the phone
// panel where there is room to read them.
import { esc } from '../shared.js';

export function render(s) {
  const el = document.getElementById('tv-follow');
  if (!el) return;                                   // absent on the phone dashboard → no-op
  const f = s && s.desk_focus;
  // Nothing dispatched, or a pointer left over from a session since closed. Render nothing at all —
  // an empty box on a display nobody interacts with is worse than no box.
  if (!f) { el.innerHTML = ''; return; }
  el.innerHTML =
    '<span class="tv-follow-box"><span class="fb-k">Follow-ups</span>' +
    '<span class="fb-v">' + esc(f.repo || f.id) + '</span></span>';
}
