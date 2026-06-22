// Surf forecast card — current conditions + 7-day outlook for a spot (Mayport Poles).
// Days render as rows; tapping a row expands an hourly 8a–8p breakdown for that day.
// Data: Pi collector (JJGantt/surf-report) -> surf_snapshots -> server buildSurf().
// Colors come from the server (Surfline's canonical rating palette); this card only paints.
import { state } from '../shared.js';

const SPOT_LABEL = { 'mayport-poles': 'Poles' };
const open = new Set();   // weekdays currently expanded (persists across SSE re-renders)
let bound = false;

const ftRange = (a, b) =>
  (a == null || b == null) ? '—' : (a === b ? `${a} ft` : `${a}–${b} ft`);

export function render(s) {
  const S = s && s.surf;
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

  const hourRow = (h) =>
    '<div class=surfhr>' +
      '<span class=sh-t>' + h.t + '</span>' +
      '<span class=sh-rt style="color:' + h.ratingColor + '">' + h.ratingLabel + '</span>' +
      '<span class=sh-ft>' + ftRange(h.hMin, h.hMax) + '</span>' +
      '<span class=sh-w>' + (h.wind || '—') + '</span>' +
      '<span class=sh-air>' + (h.airF != null ? h.airF + '°' : '—') + '</span>' +
    '</div>';

  const dayRow = (d) => {
    const isOpen = open.has(d.weekday);
    const row =
      '<div class="surfrow' + (isOpen ? ' open' : '') + '" data-day="' + d.weekday + '">' +
        '<span class=sr-x>' + (isOpen ? '▾' : '▸') + '</span>' +
        '<span class=sr-wd>' + d.weekday + '</span>' +
        '<span class=sr-rt style="color:' + d.ratingColor + '">' + d.ratingLabel + '</span>' +
        '<span class=sr-ft>' + ftRange(d.hMin, d.hMax) + '</span>' +
        '<span class=sr-air>' + (d.airHi != null ? d.airHi + '°' : '—') + '</span>' +
      '</div>';
    if (!isOpen) return row;
    const hours = (d.hours && d.hours.length)
      ? '<div class=surfhr-head><span>Time</span><span>Cond</span><span>Surf</span><span>Wind</span><span>Air</span></div>'
        + d.hours.map(hourRow).join('')
      : '<div class=surfhr-empty>No daytime hours</div>';
    return row + '<div class=surfhours>' + hours + '</div>';
  };

  el.innerHTML = head + '<div class=surfdays>' + (S.days || []).map(dayRow).join('') + '</div>';

  if (!bound) {
    bound = true;
    el.addEventListener('click', (e) => {
      const row = e.target.closest('.surfrow');
      if (!row || !el.contains(row)) return;
      const day = row.dataset.day;
      if (open.has(day)) open.delete(day); else open.add(day);
      render(state.last);   // re-paint from the latest payload with new expand state
    });
  }
}
