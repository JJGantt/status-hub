// Overall-score health bar — TV right column. A vertical gauge filled to the overall %, split into two
// stacked colours: nutrition (bottom) + training (top). Because overall = ½·nutrition + ½·training, each
// side contributes up to exactly 50% of the bar, so the two segments together reach the overall %.
// Paints #healthbar; no-ops where that element is absent (phone uses its own surface).
export function render(s) {
  const el = document.getElementById('healthbar');
  if (!el) return;
  const sc = s && s.score;
  if (!sc) { el.innerHTML = ''; return; }
  const nFill = Math.max(0, Math.min(50, sc.nutrition.pct * 0.5));   // nutrition's share of the bar (0–50%)
  const tFill = Math.max(0, Math.min(50, sc.training.pct * 0.5));     // training's share (0–50%)
  el.innerHTML =
    '<div class="hb-track">' +
      '<div class="hb-fill hb-nutr" style="bottom:0;height:' + nFill + '%"></div>' +
      '<div class="hb-fill hb-train" style="bottom:' + nFill + '%;height:' + tFill + '%"></div>' +
    '</div>';
}
