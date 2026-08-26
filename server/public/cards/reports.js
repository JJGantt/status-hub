// Reports — what dispatched sessions hand back.
//
// A session sent off from the phone or by voice answers in its own transcript, which you read in the
// Claude app. A REPORT is the other half: a page the model wrote about what it did, with the
// structure that terminal text cannot carry. This pane is the index; each row opens the page itself
// at /report/<id>, which is served from its own sandboxed origin (see HUB-INTERNALS §6c).
//
// Self-fetching (NOT part of the status stream), like the todo and repos panes. No-ops where
// #reportspane is absent (kiosk / mac / page).
import { esc } from '../shared.js';

let mounted = false;

// 'now' / '20m' / '3h' / '5d' — same shorthand the repo picker uses, for the same reason: a full
// timestamp on every row is noise when what you want is "is this the one from just now".
function ago(iso) {
  if (!iso) return '';
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 90) return 'now';
  if (s < 3600) return Math.round(s / 60) + 'm';
  if (s < 86400) return Math.round(s / 3600) + 'h';
  return Math.round(s / 86400) + 'd';
}

function html(rows) {
  if (!rows.length) {
    return '<div class="reports"><h3>Reports</h3>' +
      '<div class="rep-empty">Nothing published yet. A session dispatched from here writes one when it finishes.</div></div>';
  }
  const items = rows.map((r) =>
    `<li data-id="${esc(r.id)}">` +
      `<div class="rep-top"><span class="rep-title">${esc(r.title)}</span>` +
      `<span class="rep-age">${esc(ago(r.created))}</span></div>` +
      (r.summary ? `<div class="rep-sum">${esc(r.summary)}</div>` : '') +
      (r.repo ? `<div class="rep-repo">${esc(r.repo)}</div>` : '') +
    '</li>').join('');
  return `<div class="reports"><h3>Reports</h3><ul>${items}</ul></div>`;
}

async function load() {
  const el = document.getElementById('reportspane');
  if (!el) return;
  let rows;
  try { rows = await (await fetch('/api/reports')).json(); } catch (_) { return; }
  if (!Array.isArray(rows)) return;
  el.innerHTML = html(rows);
  // A report is its own document at its own URL — opening it is a NAVIGATION, not a pane switch.
  // The native app enables back-swipe so getting out of one needs no control of ours.
  el.querySelectorAll('li[data-id]').forEach((li) =>
    li.addEventListener('click', () => { window.location.href = '/report/' + encodeURIComponent(li.dataset.id); }));
}

export function render() {
  if (mounted) return;                                  // self-refreshing; not driven by the status stream
  if (!document.getElementById('reportspane')) return;  // absent on kiosk/mac/page → no-op
  mounted = true;
  load();
  window.addEventListener('focus', load);
}
