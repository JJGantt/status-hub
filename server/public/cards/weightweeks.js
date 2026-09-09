// Weekly weigh-in average, drawn over the week columns of the heat maps below it (home wall only).
//
// EVERY NUMBER COMES FROM THE SERVER (lib/weightplot.js): the mean per week, the three axis values,
// and each point as an x/y fraction. This file turns those fractions into percentages and nothing
// else — the alignment with the columns has to be one calculation, not one per surface.
//
// HOW THE ALIGNMENT WORKS. `.heat` is a flex row of N equal columns with a fixed gap, so a column's
// centre is (half a column) in from each end and the centres are evenly spaced between them. The
// plot box is therefore inset by exactly half a column on both sides — that inset is pure CSS calc
// from --cols and --hgap, so it tracks whatever width the column ends up at — and inside it x runs
// 0..100% from the first centre to the last. Nothing measures anything.
//
// A week nobody weighed in is filled in by the server (straight line across the gap) and arrives
// with `imputed` set, so the trace is continuous and only the dots say what was measured.
//
// The line is an SVG stretched with preserveAspectRatio="none", which distorts anything drawn in it:
// strokes stay true only because of vector-effect, and text would be squashed outright. So the dots
// and the labels are HTML on top, positioned by the same percentages.

export function render(s) {
 const el = document.getElementById('weightweeks'); if (!el) return;  // only the home wall has one
 const W = s && s.weight_plot;
 if (!W || !W.points || !W.points.length) { el.innerHTML = ''; return; }
 const P = W.points;
 el.style.setProperty('--cols', P.length);
 const pc = (v) => (v * 100).toFixed(3);
 // One polyline per run of weeks that HAVE a reading. A gap is a break, not a straight line drawn
 // through weeks nobody stepped on a scale in.
 const runs = [];
 for (const p of P) {
  if (p.y == null) { runs.push(null); continue; }
  const last = runs[runs.length - 1];
  if (last) last.push(p); else runs.push([p]);
 }
 const lines = runs.filter((r) => r && r.length > 1).map((r) =>
  '<polyline class=wp-line points="' + r.map((p) => pc(p.x) + ',' + pc(p.y)).join(' ') + '" ' +
  'vector-effect="non-scaling-stroke" />').join('');
 const grid = W.axis.map((a) =>
  '<line class=wp-grid x1="0" x2="100" y1="' + pc(a.y) + '" y2="' + pc(a.y) + '" ' +
  'vector-effect="non-scaling-stroke" />').join('');
 // A dot marks a week that was WEIGHED. An imputed week has the line drawn through it and nothing
 // else — the absence of a point is the whole statement, and it needs no key to be read.
 const dots = P.filter((p) => p.y != null && !p.imputed).map((p) =>
  '<i class=wp-dot style="left:' + pc(p.x) + '%;top:' + pc(p.y) + '%" ' +
  'title="' + p.week + ': ' + p.avg + ' (' + p.n + ')"></i>').join('');
 const labs = W.axis.map((a, i) =>
  '<span class="wp-lab wp-lab' + i + '">' + a.v + '</span>').join('');
 el.innerHTML =
  '<div class=wp-plot>' +
   '<svg viewBox="0 0 100 100" preserveAspectRatio="none">' + grid + lines + '</svg>' + dots +
  '</div>' + labs;
}
