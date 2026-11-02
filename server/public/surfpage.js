// The surf app's page (surf.html): paints /api/surf/stream, which the hub pushes whenever a wind
// reading, a buoy reading or a forecast arrives. Every value arrives finished — colours, labels, the
// hours — so this only lays them out.
import { esc, liveStream, state } from './shared.js';
import * as surf from './cards/surf.js';
import * as weather from './cards/weather.js';

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
// ONE SEA, blended from the buoys either side (lib/livebuoy.js), with each buoy's own total under it —
// the blend is what to read, the two are there to show it is not hiding a disagreement.
function seaHtml(sea, buoys) {
  if (!sea) return '';
  return '<div class="sp-card">' +
    `<div class="sp-h">Sea<span class="sp-age">${esc(age(sea.age_min))}</span></div>` +
    `<div class="sp-big">${num(sea.wvht_ft)}<span class="sp-u">ft</span> @ ${num(sea.dpd_s, 's')} ${esc(sea.mwd_compass || '')}</div>` +
    part('Swell', sea.swh_ft, sea.swp_s, sea.swd) +
    part('Wind waves', sea.wwh_ft, sea.wwp_s, sea.wwd) +
    '<div class="sp-row sp-dim">' + (buoys || []).map((b) =>
      `<span class="sp-k">${esc(b.name)}</span>${num(b.wvht_ft, ' ft')}`).join('') + '</div>' +
    '</div>';
}

// WATER: what the buoys read now, and the marine model's next day beside it.
const hourLabel = (h) => `${(+h) % 12 || 12}${+h < 12 ? 'a' : 'p'}`;
function waterHtml(w) {
  if (!w || (w.now_f == null && !(w.next || []).length)) return '';
  return '<div class="sp-card">' +
    '<div class="sp-h">Water</div>' +
    // The temperature is written in its own colour (`waterColor` in routes/surf.js): the wetsuit scale,
    // cold blue to warm orange. The watch draws the same number the same way.
    `<div class="sp-big"${w.now_color ? ` style="color:${esc(w.now_color)}"` : ''}>` +
      `${num(w.now_f)}<span class="sp-u">°</span></div>` +
    ((w.next || []).length ? '<div class="sp-row sp-dim">' + w.next.map((n) =>
      `<span class="sp-k">${esc(hourLabel(n.t))}</span>${num(n.f, '°')}`).join('') + '</div>' : '') +
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
  document.getElementById('sp-live').innerHTML = windHtml(d.wind) + seaHtml(d.sea, d.buoys) + waterHtml(d.water);
  document.getElementById('sp-hours').innerHTML = hoursHtml(d.hours);
  // The heat map is rebuilt only for a new forecast: rebuilding it on every reading would throw away
  // where it was scrolled to every ten minutes.
  const at = d.surf && d.surf.capturedAt;
  // The card re-renders itself from `state.last` once its history arrives. With no status stream on
  // this page, this is that frame's only writer.
  state.last = { surf: d.surf, weather: d.weather };
  if (at !== captured) { captured = at; surf.render(state.last); }
  // Rain chance, the hub's own card (cards/weather.js): 7 days x 24 hours, drawn from the same frame.
  weather.render(state.last);
}

liveStream('/api/surf/stream', { surf: (e) => { try { paint(JSON.parse(e.data)); } catch (_) {} } });
