// Reports pane — the write-ups dispatched sessions hand back when they finish.
//
// This is the OTHER half of the repo pane: there you send work out, here you read what came back.
// It is its own pane rather than a link tucked into the launcher, because a report is something you
// go looking for days later ("what did it actually change?"), and a destination you can swipe to is
// findable in a way a link inside another card is not.
//
// Reading happens in a sandboxed iframe INSIDE the pane rather than by navigating to /report/<id>.
// Same document, same CSP — the response's own `sandbox` directive gives it an opaque origin whether
// it is a top-level page or a frame, so nothing is given up — but going back to the list is then a
// button rather than a full reload of the hub and its event stream. The standalone page still exists
// and is what a notification tap opens, since that arrives with no hub loaded to return to.
//
// Self-fetching (NOT part of the status stream), like the todo and repo panes. No-ops where
// #reportspane is absent (kiosk / mac / page).
import { esc } from '../shared.js';

let mounted = false;

// 'now' / '20m' / '3h' / 'Aug 12' — recent reports want elapsed time, older ones want a date.
function ago(iso) {
  if (!iso) return '';
  const then = new Date(iso), s = (Date.now() - then.getTime()) / 1000;
  if (s < 90) return 'now';
  if (s < 3600) return Math.round(s / 60) + 'm';
  if (s < 86400) return Math.round(s / 3600) + 'h';
  if (s < 6 * 86400) return Math.round(s / 86400) + 'd';
  return then.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function listHtml(rows) {
  if (!rows.length) {
    return '<div class="reports"><h3>Reports</h3>' +
      '<div class="rpt-empty">Nothing published yet. A session that finishes dispatched work can hand ' +
      'back a page, and it lands here.</div></div>';
  }
  const items = rows.map((r) =>
    `<li data-id="${esc(r.id)}">` +
      `<div class="rpt-top"><span class="rpt-title">${esc(r.title || 'Untitled')}</span>` +
      `<span class="rpt-age">${esc(ago(r.created))}</span></div>` +
      (r.repo ? `<div class="rpt-repo">${esc(r.repo)}</div>` : '') +
      (r.summary ? `<div class="rpt-sum">${esc(r.summary)}</div>` : '') +
    '</li>').join('');
  return `<div class="reports"><h3>Reports</h3><ul>${items}</ul></div>`;
}

// Open one in place. The iframe is created fresh each time rather than reused: reports are static
// documents, and a fresh frame means the previous one's scroll position can't bleed into the next.
function openReport(el, id, title) {
  const safe = String(id).replace(/[^0-9a-fA-F-]/g, '');
  if (!safe) return;
  el.innerHTML =
    '<div class="rpt-reader">' +
      `<div class="rpt-bar"><button class="rpt-back" type="button">‹ Reports</button>` +
      `<span class="rpt-bar-title">${esc(title || '')}</span></div>` +
      `<iframe class="rpt-frame" src="/report/${safe}" title="${esc(title || 'Report')}"></iframe>` +
    '</div>';
  el.querySelector('.rpt-back').addEventListener('click', () => load(el));
}

async function load(el) {
  el = el || document.getElementById('reportspane');
  if (!el) return;
  let d;
  try { d = await (await fetch('/api/reports')).json(); } catch (_) { return; }
  if (!d || d.error) return;
  const rows = d.reports || [];
  el.innerHTML = listHtml(rows);
  el.querySelectorAll('li[data-id]').forEach((li) =>
    li.addEventListener('click', () => openReport(el, li.dataset.id, li.querySelector('.rpt-title').textContent)));
}

// Called by the native app when a report notification is tapped on a build new enough to route it
// here instead of navigating the whole web view to /report/<id>. Harmless on older builds — they
// simply never call it, and the standalone page is what opens.
window.__showReport = (id) => {
  const el = document.getElementById('reportspane');
  if (!el) return false;
  try { window.__showPane && window.__showPane('reports'); } catch (_) {}
  openReport(el, id, '');
  return true;
};

export function render() {
  if (mounted) return;                                 // self-refreshing; not driven by the status stream
  if (!document.getElementById('reportspane')) return; // absent on kiosk/mac/page → no-op
  mounted = true;
  load();
  // Only refresh back to the list when the pane is showing the list; re-reading while a report is
  // open would yank the page out from under you on every app switch.
  window.addEventListener('focus', () => {
    const el = document.getElementById('reportspane');
    if (el && !el.querySelector('.rpt-reader')) load(el);
  });
}
