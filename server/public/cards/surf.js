// Surf forecast card — current conditions + 7-day outlook for a spot (Mayport Poles).
// Data: Pi collector (repo JJGantt/surf-report) -> surf_snapshots -> server buildSurf().
// Server computes ratings/colors/aggregates; this card only paints.
const SPOT_LABEL = { 'mayport-poles': 'Poles' };

const ftRange = (a, b) =>
  (a == null || b == null) ? '—' : (a === b ? `${a} ft` : `${a}–${b} ft`);

export function render(s) {
  const S = s.surf;
  const el = document.getElementById('surf');
  if (!el) return;
  if (!S) { el.innerHTML = '<div class=devstrip><span class=devname>Surf</span>' +
    '<span class=devchip><span class=dc-v style="color:#8b96a5">—</span></span></div>'; return; }

  const name = SPOT_LABEL[S.spot] || S.spot;
  const cur = S.current || {};
  const chip = (label, val, col) => '<span class=devchip>' +
    (label ? '<span class=dc-l>' + label + '</span>' : '') +
    '<span class=dc-v style="color:' + (col || '#e6eaf0') + '">' + val + '</span></span>';

  const head =
    '<div class=devstrip>' +
      '<span class=devname>Surf · ' + name + '</span>' +
      chip('', '<span class=dot style="background:' + (cur.ratingColor || '#8b96a5') + '"></span>' +
        (cur.ratingLabel || '—'), '#e6eaf0') +
      chip('Now', ftRange(cur.hMin, cur.hMax), '#e6eaf0') +
      chip('Water', (S.waterTempF != null ? S.waterTempF + '°' : '—'), '#6aa6c8') +
      chip('Air', (cur.airF != null ? cur.airF + '°' : '—'), '#eab308') +
    '</div>';

  const dayCell = (d) =>
    '<div class=surfday>' +
      '<div class=sd-wd>' + d.weekday + '</div>' +
      '<div class=sd-dot style="background:' + (d.ratingColor || '#8b96a5') + '"></div>' +
      '<div class=sd-ft>' + ftRange(d.hMin, d.hMax) + '</div>' +
      '<div class=sd-rt style="color:' + (d.ratingColor || '#8b96a5') + '">' + (d.ratingLabel || '—') + '</div>' +
      '<div class=sd-air>' + (d.airHi != null ? d.airHi + '°' : '—') + '</div>' +
    '</div>';

  const week = '<div class=surfweek>' + (S.days || []).map(dayCell).join('') + '</div>';
  el.innerHTML = head + week;
}
