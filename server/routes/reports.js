'use strict';

const { REPORT_CSP, REPORT_CSS } = require('../lib/untrusted');

module.exports = function (ctx) {
  const { gated, sb } = ctx;

  // ---- reports: a dispatched session's HTML write-up of finished work -------------------------
  //
  // The HTML in `reports.html` was written by a model and is opened in a web view already signed in
  // to this hub: it is served under lib/untrusted.js's sandboxing CSP, which is the whole reason this
  // route looks the way it does.
  const escHtml = (v) => String(v == null ? '' : v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  const when = (iso) => {
    try {
      return new Date(iso).toLocaleString('en-US',
        { timeZone: 'America/New_York', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
    } catch (_) { return ''; }
  };

  gated.get('/report/:id', async (req, res) => {
    let rows;
    try { rows = await sb(`reports?id=eq.${encodeURIComponent(req.params.id)}&select=*`); }
    catch (e) { return res.status(502).type('text').send('could not read report'); }
    const r = rows && rows[0];
    if (!r) return res.status(404).type('text').send('no such report');
    const where = [r.repo, when(r.created)].filter(Boolean).join(' · ');
    res.setHeader('Content-Security-Policy', REPORT_CSP);
    res.setHeader('Cache-Control', 'no-cache');
    res.type('html').send(`<!doctype html><html><head><meta charset=utf-8>
  <meta name=viewport content="width=device-width,initial-scale=1">
  <title>${escHtml(r.title)}</title><style>${REPORT_CSS}</style></head><body>
  <header><h1>${escHtml(r.title)}</h1><div class=meta>${escHtml(where)}</div></header>
  ${r.html || ''}
  </body></html>`);
  });

  // The index as JSON, for the walls' reports pane (cards/reports.js). `html` is deliberately not selected: a list of a
  // hundred reports would otherwise carry every page's full markup to a screen that renders none of it.
  gated.get('/api/reports', async (req, res) => {
    try {
      res.json({ reports: await sb('reports?select=id,title,summary,repo,created&order=created.desc&limit=100') || [] });
    } catch (_) {
      res.status(502).json({ error: 'could not read reports' });
    }
  });

  // Every report, newest first — the way back to something you read last week.
  gated.get('/reports', async (req, res) => {
    let rows = [];
    try { rows = await sb('reports?select=id,title,summary,repo,created&order=created.desc&limit=100'); }
    catch (_) {}
    const items = rows.map((r) =>
      `<li><a href="/report/${escHtml(r.id)}">${escHtml(r.title)}</a>` +
      `<div class=meta>${escHtml([r.repo, when(r.created)].filter(Boolean).join(' · '))}</div>` +
      (r.summary ? `<div class=sum>${escHtml(r.summary)}</div>` : '') + '</li>').join('');
    res.setHeader('Cache-Control', 'no-cache');
    res.type('html').send(`<!doctype html><html><head><meta charset=utf-8>
  <meta name=viewport content="width=device-width,initial-scale=1">
  <title>Reports</title><style>${REPORT_CSS}
  ul{list-style:none;padding:0}li{padding:14px 0;border-bottom:1px solid var(--line)}
  li a{font-size:17px;font-weight:600;text-decoration:none}
  .sum{color:var(--fg);font-size:14.5px;margin-top:4px}
  .meta{margin-top:2px}</style></head><body>
  <header><h1>Reports</h1></header>
  ${items ? `<ul>${items}</ul>` : '<p class=meta>Nothing published yet.</p>'}
  </body></html>`);
  });
};
