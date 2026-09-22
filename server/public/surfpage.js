// The surf app's page (surf.html): paints /api/surf/stream, which the hub pushes whenever a wind
// reading, a buoy reading or a forecast arrives. Every value arrives finished — colours, labels, the
// hours — so this only lays them out.
import { esc, liveStream } from './shared.js';
import * as surf from './cards/surf.js';

const num = (v, unit) => (v == null ? '—' : `${v}${unit || ''}`);
const age = (m) => (m == null ? '' : m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${m % 60}m`);

function windHtml(w) {
  if (!w) return '<div class="sp-card"><div class="sp-h">Wind</div><div class="sp-big">—</div></div>';
  const f = w.forecast;
  return '<div class="sp-card">' +
    `<div class="sp-h">Wind<span class="sp-age">${esc(age(w.age_min))}</span></div>` +
    `<div class="sp-big">${num(w.kts)}<span class="sp-u">kt</span> ${esc(w.compass || '')}` +
    `<span class="sp-chip" style="--c:${esc(w.type_color)}">${esc(w.type || 'Calm')}</span></div>` +
    `<div class="sp-row"><span class="sp-k">Gust</span>${num(w.gust, ' kt')}` +
    (w.avg30 ? `<span class="sp-k">30m</span>${num(w.avg30.kts, ' kt')}` : '') + '</div>' +
    (f ? `<div class="sp-row sp-dim"><span class="sp-k">Forecast</span>${num(f.kts, ' kt')} ${esc(f.compass || '')}` +
         `<span class="sp-chip" style="--c:${esc(f.type_color)}">${esc(f.type || '')}</span></div>` : '') +
    '</div>';
}

function part(label, ft, s, dir) {
  if (ft == null) return '';
  return `<div class="sp-row"><span class="sp-k">${label}</span>${num(ft, ' ft')} @ ${num(s, 's')} ${esc(dir || '')}</div>`;
}
function buoyHtml(b) {
  return '<div class="sp-card">' +
    `<div class="sp-h">${esc(b.name)}<span class="sp-sub">${b.miles} mi ${esc(b.bearing)}</span>` +
    `<span class="sp-age">${esc(age(b.age_min))}</span></div>` +
    `<div class="sp-big">${num(b.wvht_ft)}<span class="sp-u">ft</span> @ ${num(b.dpd_s, 's')} ${esc(b.mwd_compass || '')}</div>` +
    part('Swell', b.swh_ft, b.swp_s, b.swd) +
    part('Wind waves', b.wwh_ft, b.wwp_s, b.wwd) +
    (b.water_f != null ? `<div class="sp-row sp-dim"><span class="sp-k">Water</span>${b.water_f}°</div>` : '') +
    '</div>';
}

function hoursHtml(hours) {
  return (hours || []).map((h) =>
    `<div class="sp-hr"><div class="sp-hc" style="background:${esc(h.color)}"></div>` +
    `<div class="sp-ht">${esc(h.t)}</div><div class="sp-hf">${esc(h.ft || '')}</div>` +
    `<div class="sp-hw" style="color:${esc(h.wind_color)}">${h.wind_kts == null ? '' : h.wind_kts}</div></div>`).join('');
}

let captured = null;
function paint(d) {
  document.getElementById('sp-live').innerHTML = windHtml(d.wind) + (d.buoys || []).map(buoyHtml).join('');
  document.getElementById('sp-hours').innerHTML = hoursHtml(d.hours);
  // The heat map is rebuilt only for a new forecast: rebuilding it on every reading would throw away
  // where it was scrolled to every ten minutes.
  const at = d.surf && d.surf.capturedAt;
  if (at !== captured) { captured = at; surf.render({ surf: d.surf }); }
}

liveStream('/api/surf/stream', { surf: (e) => { try { paint(JSON.parse(e.data)); } catch (_) {} } });
