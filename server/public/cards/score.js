// Overall-score health bar — TV right column. A vertical gauge filled to the overall %, split into two
// stacked colours: nutrition (bottom) + training (top). Because overall = ½·nutrition + ½·training, each
// side contributes up to exactly 50% of the bar, so the two segments together reach the overall %.
// Paints #healthbar; no-ops where that element is absent (phone uses its own surface).
//
// Gamified floating delta: when the overall moves (you log food / a set), a transient "+1.3" / "−0.8"
// floats up off the bar at the fill line, so a change is felt, not just shown.
let prevOverall = null;

export function render(s) {
  const el = document.getElementById('healthbar');
  if (!el) return;
  const sc = s && s.score;
  if (!sc) { el.innerHTML = ''; prevOverall = null; return; }
  const nFill = Math.max(0, Math.min(50, sc.nutrition.pct * 0.5));   // nutrition's share of the bar (0–50%)
  const tFill = Math.max(0, Math.min(50, sc.training.pct * 0.5));     // training's share (0–50%)
  const overall = Math.max(0, Math.min(100,
    typeof sc.overall === 'number' ? sc.overall : nFill + tFill));    // bar fills to here
  el.innerHTML =
    '<div class="hb-track">' +
      '<div class="hb-fill hb-nutr" style="bottom:0;height:' + nFill + '%"></div>' +
      '<div class="hb-fill hb-train" style="bottom:' + nFill + '%;height:' + tFill + '%"></div>' +
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
