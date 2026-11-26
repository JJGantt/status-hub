'use strict';
// Model-written HTML served from an origin already authenticated as the owner: a report (/report/:id)
// and a session's HTML tab (/tab/:id). Script in that document would be same-origin with the dashboard
// and could call /api/* with his cookie, so the response is sandboxed by CSP into an opaque origin AND
// scripts are blocked outright by `default-src 'none'`. Two independent mechanisms, because this is the
// one place where untrusted markup meets an authenticated origin. Inline SVG needs no script; inline
// styles are allowed because a page with no styling is unreadable.

const REPORT_CSP = [
  'sandbox allow-popups allow-popups-to-escape-sandbox allow-top-navigation-by-user-activation',
  "default-src 'none'",
  'img-src data: https:',
  "style-src 'unsafe-inline'",
  'font-src data:',
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');

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

module.exports = { REPORT_CSP, REPORT_CSS };
