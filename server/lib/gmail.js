'use strict';
// The hub's own Gmail access: the OAuth client and refresh token in GOOGLE_CLIENT_ID /
// GOOGLE_CLIENT_SECRET / GOOGLE_REFRESH_TOKEN (gmail.modify), shared by the lobby race's email path and
// the PIN-by-email watch (routes/gmailpush.js). An access token is reused until a minute before it ends.
let cached = null;   // { token, until }

function configured() {
  const { GOOGLE_CLIENT_ID: id, GOOGLE_CLIENT_SECRET: secret, GOOGLE_REFRESH_TOKEN: refresh } = process.env;
  return !!(id && secret && refresh);
}

async function accessToken() {
  if (cached && Date.now() < cached.until) return cached.token;
  const { GOOGLE_CLIENT_ID: id, GOOGLE_CLIENT_SECRET: secret, GOOGLE_REFRESH_TOKEN: refresh } = process.env;
  const t = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', signal: AbortSignal.timeout(15e3),
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: id, client_secret: secret, refresh_token: refresh, grant_type: 'refresh_token' }) });
  if (!t.ok) throw new Error(`Google token ${t.status} ${(await t.text().catch(() => '')).slice(0, 200)}`);
  const j = await t.json();
  cached = { token: j.access_token, until: Date.now() + ((j.expires_in || 3600) - 60) * 1000 };
  return cached.token;
}

// One Gmail API call (path under /gmail/v1/users/me/); the parsed answer, or an error carrying .status.
async function api(path, { method = 'GET', body } = {}) {
  const r = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/${path}`, { method, signal: AbortSignal.timeout(15e3),
    headers: { Authorization: `Bearer ${await accessToken()}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined });
  if (!r.ok) {
    const e = new Error(`Gmail ${method} ${path.split('?')[0]} ${r.status} ${(await r.text().catch(() => '')).slice(0, 200)}`);
    e.status = r.status;
    throw e;
  }
  return r.status === 204 ? {} : r.json();
}

// A full message reduced to what a handler reads: { id, from, subject, body, labels }. body is the
// text/plain part when there is one, otherwise the HTML with its tags dropped.
function parseMessage(m) {
  const headers = {};
  for (const h of (m.payload && m.payload.headers) || []) headers[h.name.toLowerCase()] = h.value;
  let plain = null, html = null;
  (function walk(p) {
    if (!p) return;
    const data = p.body && p.body.data ? Buffer.from(p.body.data, 'base64url').toString('utf8') : null;
    if (data && p.mimeType === 'text/plain' && plain === null) plain = data;
    if (data && p.mimeType === 'text/html' && html === null) html = data;
    for (const c of p.parts || []) walk(c);
  })(m.payload);
  const body = plain !== null ? plain : (html || '').replace(/<(style|script)[\s\S]*?<\/\1>/gi, '').replace(/<br\s*\/?>|<\/p>|<\/div>/gi, '\n')
    .replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&');
  return { id: m.id, from: headers.from || '', subject: headers.subject || '', body, labels: m.labelIds || [] };
}

module.exports = { configured, accessToken, api, parseMessage };
