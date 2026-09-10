// Overall-score health bar — TV right column. THREE vertical gauges side by side in one track, each
// filled to its own 0-100%: tasks (left, gold), nutrition (middle, blue), training (right, green) —
// the order they appear across the wall itself. Stacked into one column they said what the overall
// was but not which part was short, and the overall is still legible: three full bars is a full
// block, and a bar that lags leaves a notch in it.
// Paints #healthbar; no-ops where that element is absent (phone uses its own surface).
//
// The gold band is earned by clearing dated list items and drained by leaving them overdue, and it
// starts EMPTY — nothing scheduled means no gold, which is the incentive it exists to create. It is
// also the only band that can fall on its own, with no input from him, as something sits unactioned.
//
// Gamified floating delta: when the overall moves (you log food / a set / check something off), a
// transient "+1.3" / "−0.8" floats up off the bar at the fill line, so a change is felt, not just
// shown. Checking a task off needs nothing extra here — it moves the overall like anything else.
let prevOverall = null;

export function render(s) {
  const el = document.getElementById('healthbar');
  if (!el) return;
  const sc = s && s.score;
  if (!sc) { el.innerHTML = ''; prevOverall = null; return; }
  const pct = (v) => Math.max(0, Math.min(100, Number(v) || 0));
  const nFill = pct(sc.nutrition && sc.nutrition.pct);     // each column fills to its OWN score
  const tFill = pct(sc.training && sc.training.pct);
  const kFill = pct(sc.tasks && sc.tasks.pct);
  const overall = Math.max(0, Math.min(100,
    typeof sc.overall === 'number' ? sc.overall : (nFill + tFill + kFill) / 3));  // the delta pill sits here
  // Drive the fills via CSS vars (numbers 0–100) so CSS can lay the bar out vertical (landscape) OR
  // horizontal (portrait) from the same render.
  el.style.setProperty('--nfill', nFill);
  el.style.setProperty('--tfill', tFill);
  el.style.setProperty('--kfill', kFill);
  el.innerHTML =
    '<div class="hb-track">' +
      '<div class="hb-fill hb-task"></div>' +
      '<div class="hb-fill hb-nutr"></div>' +
      '<div class="hb-fill hb-train"></div>' +
    '</div>';
  // Float the delta only on a genuine move (skip the first paint, and pace-drift noise below 0.1pt).
  if (prevOverall !== null && Math.abs(overall - prevOverall) >= 0.1) floatDelta(el, overall - prevOverall, overall);
  prevOverall = overall;
}

// A right-anchored pill at the fill line that rises and fades. Appended to #healthbar (not the clipped
// track) and anchored to the right edge so it grows left into the dashboard, never off-screen.
function floatDelta(el, d, overall) {
  const tag = document.createElement('div');
  tag.className = 'hb-delta ' + (d > 0 ? 'up' : 'down');
  tag.textContent = (d > 0 ? '+' : '−') + Math.abs(d).toFixed(1);
  tag.style.bottom = overall + '%';
  tag.addEventListener('animationend', () => tag.remove());
  el.appendChild(tag);
}
