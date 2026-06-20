'use strict';
// Exercise variants by equipment → name + a YouTube "how to" search link (opens in the browser).
const EQUIP_LABEL = { dumbbell: 'Dumbbell', rings: 'Ring', barbell: 'Barbell', machine: 'Machine', cable: 'Cable', bodyweight: '' };

function variantName(base, eq) {
  const lab = Object.prototype.hasOwnProperty.call(EQUIP_LABEL, eq) ? EQUIP_LABEL[eq] : eq;
  if (!lab) return base;                                            // bodyweight → base name only
  if (base.toLowerCase().includes(lab.toLowerCase())) return base;  // base already names the implement
  return lab + ' ' + base;
}
function youtubeHowTo(name) {
  return 'https://www.youtube.com/results?search_query=' + encodeURIComponent(name + ' how to');
}
function buildVariants(catalogRows) {
  const out = {};
  for (const c of catalogRows) {
    const eqs = (c.equipment && c.equipment.length) ? c.equipment : [null];
    out[c.name] = eqs.map((eq) => { const nm = eq ? variantName(c.name, eq) : c.name; return { name: nm, url: youtubeHowTo(nm) }; });
  }
  return out;
}

module.exports = { buildVariants };
