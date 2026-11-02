'use strict';
// Who a request is. Three credentials sign a request in, from a cookie (`hub`) or a header
// (`X-Hub-Token`, or `Authorization: Bearer`):
//
//   - a SESSION, `s.<id>.<secret>`: what /login sets. One `hub_sessions` row per browser (data-layer
//     00153), holding only the secret's SHA-256, so any one of them, or all, can be revoked without
//     touching the password (`revoke`).
//   - the DEVICE token, TV_TOKEN: the kiosk, the bedroom TV, and every machine client (bin/hub, the
//     voice worker, the responder). Sent in a header. A browser that can only be given a URL (the
//     Pi's kiosk) loads it once as `?token=`, and the gate trades that for the DEVICE COOKIE
//     (`d.<hmac>`, derived from TV_TOKEN, so rotating TV_TOKEN ends it) and redirects to the same
//     URL without the token. Revoked by rotating TV_TOKEN.
//   - the PASSWORD-DERIVED token, sha256("status-hub:" + password): what the native app derives from
//     the password in its Keychain and sends as X-Hub-Token, seeds as its web view's cookie, and hands
//     the watch; and what every browser signed in before sessions existed holds. It is a password
//     equivalent and ends only when HUB_PASSWORD changes. A browser (not the app's web view) that
//     loads a page with it is moved onto a session (`upgrade`), so its stored cookie becomes
//     revocable.
//
// Sessions live in memory and are loaded from Supabase at boot. Until that load lands a session
// credential answers 503 rather than 401, so a deploy never bounces a signed-in page to /login.
const crypto = require('crypto');

const COOKIE_MAX_AGE = 60 * 60 * 24 * 3650;   // ten years: signing in is meant to be one-time

const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest();
const sha256hex = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
// Constant-time string equality: both sides are hashed to the same length first, so neither the
// length nor the position of the first differing byte shows up in the response time.
const safeEqual = (a, b) => crypto.timingSafeEqual(sha256(a), sha256(b));

function getCookie(req, name) {
  const m = (req.headers.cookie || '').match(new RegExp('(?:^|; )' + name + '=([^;]+)'));
  if (!m) return null;
  try { return decodeURIComponent(m[1]); } catch { return m[1]; }
}

function headerToken(req) {
  const x = req.headers['x-hub-token'];
  if (x) return String(x);
  const m = /^Bearer\s+(.+)$/i.exec(String(req.headers.authorization || ''));
  return m ? m[1].trim() : '';
}

// A top-level page load, as opposed to a fetch, an asset or an EventSource. The kiosk's token exchange
// and the session upgrade happen only here, so a page's parallel requests do not each mint a session.
function isNavigation(req) {
  if (req.method !== 'GET') return false;
  const mode = req.headers['sec-fetch-mode'];
  if (mode) return mode === 'navigate';
  return /text\/html/.test(String(req.headers.accept || ''));
}

// A real browser, not the native app's WKWebView. WKWebView's user agent carries no `Safari/` (or
// any browser's) token; every browser's does. The app re-seeds the password-derived cookie at each
// launch and hands the cookie to the watch, whose fallback path checks the password-derived token, so
// its web view must never be upgraded.
const isBrowser = (req) => /\b(Safari|Firefox|Chrome|CriOS|FxiOS|Edg)\//.test(String(req.headers['user-agent'] || ''));

// The request URL with every `token` query parameter removed.
function stripToken(originalUrl) {
  const u = new URL(originalUrl, 'http://x');
  u.searchParams.delete('token');
  return u.pathname + (u.searchParams.toString() ? '?' + u.searchParams.toString() : '');
}

function createAuth({ password, deviceToken, supabaseUrl, supabaseKey }) {
  const PASSWORD_TOKEN = sha256hex('status-hub:' + password);
  const DEVICE_COOKIE = deviceToken
    ? 'd.' + crypto.createHmac('sha256', deviceToken).update('status-hub device cookie').digest('hex') : '';

  const sessions = new Map();   // id -> { secret_sha256, revoked_at, created_at, via, user_agent, ip }
  let ready = false;

  async function rest(path, init = {}) {
    const r = await fetch(`${supabaseUrl}/rest/v1/${path}`, {
      ...init,
      headers: { apikey: supabaseKey, Authorization: `Bearer ${supabaseKey}`, 'Content-Type': 'application/json',
                 ...(init.headers || {}) },
    });
    if (!r.ok) throw new Error(`supabase ${init.method || 'GET'} ${path.split('?')[0]} -> ${r.status}`);
    return r;
  }

  function remember(row) {
    sessions.set(row.id, { secret_sha256: row.secret_sha256, revoked_at: row.revoked_at || null,
      created_at: row.created_at, via: row.via, user_agent: row.user_agent || '', ip: row.ip || '' });
  }

  // Every row, revoked ones included (a revoked id must still be recognised as revoked).
  async function load() {
    const r = await rest('hub_sessions?select=id,secret_sha256,created_at,via,user_agent,ip,revoked_at');
    const rows = await r.json();
    sessions.clear();
    for (const row of rows) remember(row);
    ready = true;
    return rows.length;
  }
  // Boot load, retried with backoff until it lands.
  function start(delay = 1000) {
    load().then((n) => console.log(`[auth] ${n} sessions loaded`))
      .catch((e) => {
        console.error(`[auth] loading sessions failed, retrying in ${delay / 1000}s:`, e.message);
        setTimeout(() => start(Math.min(delay * 2, 60000)), delay);
      });
  }
  // A realtime change to hub_sessions (a revocation made in SQL). The payload is the row itself.
  function onChange(p) {
    if (p.eventType === 'DELETE') { if (p.old && p.old.id) sessions.delete(p.old.id); return; }
    if (p.new && p.new.id && p.new.secret_sha256) remember(p.new);
  }

  // What a credential string is: { kind, id? } or null. `pending` = a session before the boot load.
  function classify(value) {
    if (!value) return null;
    if (value.startsWith('s.')) {
      const [, id, secret] = value.split('.');
      if (!ready) return { kind: 'pending' };
      const s = id && secret && sessions.get(id);
      if (s && !s.revoked_at && safeEqual(sha256hex(secret), s.secret_sha256)) return { kind: 'session', id };
      return null;
    }
    if (DEVICE_COOKIE && value.startsWith('d.')) return safeEqual(value, DEVICE_COOKIE) ? { kind: 'device' } : null;
    if (deviceToken && safeEqual(value, deviceToken)) return { kind: 'device' };
    if (safeEqual(value, PASSWORD_TOKEN)) return { kind: 'password' };
    return null;
  }

  // { kind, id?, from: 'cookie' | 'header' } or null. The header wins when both are present.
  function identify(req) {
    const h = headerToken(req);
    const fromHeader = h && classify(h);
    if (fromHeader) return { ...fromHeader, from: 'header' };
    const c = getCookie(req, 'hub');
    const fromCookie = c && classify(c);
    return fromCookie ? { ...fromCookie, from: 'cookie' } : null;
  }
  const authed = (req) => { const w = identify(req); return !!w && w.kind !== 'pending'; };
  const isDeviceToken = (value) => !!deviceToken && !!value && safeEqual(value, deviceToken);
  // The device token in a header, or (from a client not yet moved to the header) in `?token=`.
  const deviceRequest = (req) => isDeviceToken(headerToken(req))
    || isDeviceToken(typeof req.query?.token === 'string' ? req.query.token : '');

  const cookie = (value) => `hub=${value}; Max-Age=${COOKIE_MAX_AGE}; Path=/; HttpOnly; Secure; SameSite=Lax`;
  const setDeviceCookie = (res) => res.setHeader('Set-Cookie', cookie(DEVICE_COOKIE));

  const clientIp = (req) => String(req.headers['fly-client-ip'] || req.ip || '');
  // A new session for this browser; resolves to the cookie value. Throws if it cannot be stored, since
  // a session held only in memory would sign the browser out at the next deploy.
  async function mint(req, via) {
    const id = crypto.randomUUID();
    const secret = crypto.randomBytes(32).toString('base64url');
    const row = { id, secret_sha256: sha256hex(secret), via,
                  user_agent: String(req.headers['user-agent'] || '').slice(0, 300), ip: clientIp(req) };
    await rest('hub_sessions', { method: 'POST', body: JSON.stringify(row), headers: { Prefer: 'return=minimal' } });
    remember({ ...row, created_at: new Date().toISOString() });
    return `s.${id}.${secret}`;
  }
  async function login(req, res) {
    res.setHeader('Set-Cookie', cookie(await mint(req, 'login')));
  }
  // A browser page load signed in by the password-derived cookie: give it a session instead. A failure
  // leaves it signed in as it was.
  async function upgrade(req, res) {
    try {
      res.setHeader('Set-Cookie', cookie(await mint(req, 'upgrade')));
    } catch (e) {
      console.error('[auth] session upgrade failed:', e.message);
    }
  }

  function list(req) {
    const mine = identify(req);
    return [...sessions.entries()].map(([id, s]) => ({
      id, created_at: s.created_at, via: s.via, user_agent: s.user_agent, ip: s.ip, revoked_at: s.revoked_at,
      current: !!mine && mine.kind === 'session' && mine.id === id,
    })).sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
  }
  // Revoke one session by id, or every live one. Resolves to the ids revoked.
  async function revoke({ id, all }) {
    const now = new Date().toISOString();
    const ids = all ? [...sessions].filter(([, s]) => !s.revoked_at).map(([k]) => k)
      : (sessions.has(id) && !sessions.get(id).revoked_at ? [id] : []);
    if (!ids.length) return [];
    await rest(`hub_sessions?id=in.(${ids.join(',')})`, { method: 'PATCH', body: JSON.stringify({ revoked_at: now }),
      headers: { Prefer: 'return=minimal' } });
    for (const k of ids) sessions.get(k).revoked_at = now;
    return ids;
  }

  return { PASSWORD_TOKEN, start, onChange, identify, authed, isDeviceToken, deviceRequest, setDeviceCookie,
           login, upgrade, list, revoke, clientIp };
}

module.exports = { createAuth, isNavigation, isBrowser, stripToken, safeEqual, getCookie };
