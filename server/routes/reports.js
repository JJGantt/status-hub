'use strict';

module.exports = function (ctx) {
  const { gated, sb } = ctx;

  // ---- reports: a dispatched session's HTML write-up of finished work -------------------------
  //
  // SECURITY, and it is the whole reason this route looks the way it does. The HTML in `reports.html`
  // was written by a model, and it is opened inside the app's WKWebView, which is already authenticated
  // to this hub. Served plainly, script in that document would be same-origin with the dashboard and
  // could call /api/* — clearing todos, opening sessions — using the user's own cookie.
  //
  // So the response is sandboxed by CSP into an opaque origin AND scripts are blocked outright by
  // `default-src 'none'`. Two independent mechanisms, because this is the one place where untrusted
  // markup meets an authenticated origin. Inline SVG needs no script, which is why the tool tells the
  // model to draw with it; inline styles are allowed because a report with no styling is unreadable.
  const REPORT_CSP = [
    'sandbox allow-popups allow-popups-to-escape-sandbox allow-top-navigation-by-user-activation',
    "default-src 'none'",
    'img-src data: https:',
    "style-src 'unsafe-inline'",
    'font-src data:',
    "base-uri 'none'",
    "form-action 'none'",
  ].join('; ');

  const escHtml = (v) => String(v == null ? '' : v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  // Deliberately plain and readable rather than styled to match the dashboard: a report is a document
  // you read, not a control surface. Follows the phone's light/dark setting.
  const REPORT_CSS = `
  :root{color-scheme:light dark;--bg:#fff;--fg:#18181b;--mut:#71717a;--line:#e4e4e7;--acc:#2563eb;--code:#f4f4f5}
  @media (prefers-color-scheme:dark){:root{--bg:#0b0b0e;--fg:#e8e8ea;--mut:#a1a1aa;--line:#27272a;--acc:#7aa2f7;--code:#18181b}}
  *{box-sizing:border-box}
  body{margin:0;padding:22px 18px 64px;background:var(--bg);color:var(--fg);
   font:16px/1.62 -apple-system,BlinkMacSystemFont,'SF Pro Text',system-ui,sans-serif;
   -webkit-text-size-adjust:100%;overflow-wrap:anywhere}
  header{border-bottom:1px solid var(--line);padding-bottom:14px;margin-bottom:22px}
  h1{font-size:24px;line-height:1.25;margin:0 0 6px}
  .meta{color:var(--mut);font-size:13px}
  h2{font-size:19px;margin:32px 0 10px;line-height:1.3}
  h3{font-size:16px;margin:22px 0 8px}
  p,ul,ol{margin:0 0 14px}
  ul,ol{padding-left:22px}
  li{margin:4px 0}
  a{color:var(--acc)}
  code{background:var(--code);padding:1.5px 5px;border-radius:4px;font-size:13.5px;
   font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
  pre{background:var(--code);padding:13px 14px;border-radius:9px;overflow-x:auto;font-size:13px;line-height:1.5}
  pre code{background:none;padding:0;font-size:inherit}
  table{border-collapse:collapse;width:auto;min-width:100%;margin:0 0 16px;font-size:14.5px;display:block;overflow-x:auto;-webkit-overflow-scrolling:touch}
  th,td{border:1px solid var(--line);padding:7px 10px;text-align:left;vertical-align:top;min-width:92px}
  th{background:var(--code);font-weight:600}
  blockquote{margin:0 0 14px;padding-left:14px;border-left:3px solid var(--line);color:var(--mut)}
  img,svg{max-width:100%;height:auto}
  hr{border:0;border-top:1px solid var(--line);margin:26px 0}`;

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

  // The index as JSON, for the phone's reports pane. `html` is deliberately not selected: a list of a
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
