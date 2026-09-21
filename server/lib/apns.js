'use strict';
// Minimal APNs (Apple Push Notification service) sender — HTTP/2 + a token-based (.p8) auth JWT.
// No external dependency: Node's http2 sends the request and crypto signs the ES256 JWT (the
// dsaEncoding:'ieee-p1363' option emits the raw R||S signature APNs/JOSE expects, so there's no
// DER→JOSE conversion to hand-roll).
//
// Config (env):
//   APNS_KEY_ID   – the Key ID of the APNs auth key (.p8) from the Apple Developer portal
//   APNS_TEAM_ID  – Apple Team ID (default: the StatusHub team)
//   APNS_BUNDLE_ID– app bundle id == apns-topic (default: com.jaredgantt.statushub)
//   APNS_ENV      – 'sandbox' (default; dev/Xcode-signed device tokens) or 'production' (TestFlight/App Store)
//   APNS_KEY_P8   – the .p8 PEM contents inline (raw or base64), OR
//   APNS_KEY_PATH – a path to the .p8 file
const http2 = require('http2');
const crypto = require('crypto');
const fs = require('fs');

const TEAM_ID = process.env.APNS_TEAM_ID || 'XMH4AVFC78';
const BUNDLE_ID = process.env.APNS_BUNDLE_ID || 'com.jaredgantt.statushub';
const ENV = (process.env.APNS_ENV || 'sandbox').toLowerCase();   // default when a token has no environment
const hostFor = (env) => (String(env).toLowerCase() === 'production'
  ? 'https://api.push.apple.com' : 'https://api.sandbox.push.apple.com');
const HOST = hostFor(ENV);

// Jared's APNs auth keys are ENVIRONMENT-SCOPED (a sandbox key can't authenticate a production push and
// vice-versa — sending the sandbox key to api.push.apple.com yields 403 BadEnvironmentKeyInToken). So we
// hold BOTH keys and pick the one matching each token's environment. The *_PRODUCTION vars are optional;
// without them, production tokens fall back to the default key (and will 403 if it's the sandbox key).
const KEY_ID = { sandbox: process.env.APNS_KEY_ID || '', production: process.env.APNS_KEY_ID_PRODUCTION || process.env.APNS_KEY_ID || '' };

function pemFrom(inlineVar, pathVar) {
  let pem = process.env[inlineVar] || '';
  if (!pem && process.env[pathVar]) { try { pem = fs.readFileSync(process.env[pathVar], 'utf8'); } catch (_) {} }
  if (pem && !pem.includes('BEGIN')) { try { pem = Buffer.from(pem, 'base64').toString('utf8'); } catch (_) {} }  // base64-wrapped inline key (easier as a Fly secret)
  return pem || null;
}
function privateKeyPem(env) {
  if (String(env).toLowerCase() === 'production') {
    return pemFrom('APNS_KEY_P8_PRODUCTION', 'APNS_KEY_PATH_PRODUCTION') || pemFrom('APNS_KEY_P8', 'APNS_KEY_PATH');
  }
  return pemFrom('APNS_KEY_P8', 'APNS_KEY_PATH');
}
function keyIdFor(env) { return String(env).toLowerCase() === 'production' ? KEY_ID.production : KEY_ID.sandbox; }

function configured(env) { return !!(keyIdFor(env) && TEAM_ID && privateKeyPem(env)); }

// APNs auth JWT — valid up to 1h; reuse for ~50 min (Apple rejects regenerating too often). Cached per
// environment since each uses a different signing key.
const _jwt = { sandbox: { token: null, iat: 0 }, production: { token: null, iat: 0 } };
function authToken(env) {
  const e = String(env).toLowerCase() === 'production' ? 'production' : 'sandbox';
  const now = Math.floor(Date.now() / 1000);
  if (_jwt[e].token && now - _jwt[e].iat < 3000) return _jwt[e].token;
  const b64 = (s) => Buffer.from(s).toString('base64url');
  const signingInput = b64(JSON.stringify({ alg: 'ES256', kid: keyIdFor(e) })) + '.' +
                       b64(JSON.stringify({ iss: TEAM_ID, iat: now }));
  const key = crypto.createPrivateKey(privateKeyPem(e));
  const sig = crypto.sign('sha256', Buffer.from(signingInput), { key, dsaEncoding: 'ieee-p1363' });
  _jwt[e] = { token: `${signingInput}.${sig.toString('base64url')}`, iat: now };
  return _jwt[e].token;
}

// Send one alert push. `environment` ('sandbox'|'production') selects the gateway per token; omit to
// use the APNS_ENV default. `sound` is the filename of a sound bundled in the app (see apps/Sounds/,
// e.g. 'reminder.caf') — the app icon is identical on every notification, so the SOUND is what makes
// a reminder distinguishable from a weight nudge without looking at the screen. Omit for the system
// default. `interruptionLevel` ('passive'|'active'|'time-sensitive') controls how hard iOS pushes:
// time-sensitive breaks through Focus, passive stays quiet in the list. Defaults to iOS's 'active'.
// `badge` sets the red count on the home-screen icon; pass 0 to clear it. It is ABSOLUTE, not a
// delta, and iOS only applies it when a push actually arrives — so every push carries the current
// count rather than only the ones that change it. Omit title AND body for a badge-only update:
// that switches the push to type 'background', which is the only form iOS honours without an alert
// (best-effort — iOS throttles background pushes, so treat silent decrements as eventual).
// `category` names a UNNotificationCategory the app registered at launch, which is what puts the
// action buttons on the notification. `payload` carries app-visible data alongside `aps` — the
// reminder's id rides there so an action knows which row it is acting on.
// Resolves { ok, status, detail } and never rejects.
function send(deviceToken, { title, body, payload, environment, sound, interruptionLevel, badge, category } = {}) {
  return new Promise((resolve) => {
    if (!configured(environment)) return resolve({ ok: false, status: 0, detail: 'apns not configured for ' + (environment || ENV) });
    let jwt;
    try { jwt = authToken(environment); } catch (e) { return resolve({ ok: false, status: 0, detail: 'jwt: ' + e.message }); }
    const silent = !title && !body;   // badge-only update — no alert to show
    let done = false;
    const finish = (r) => { if (done) return; done = true; try { client.close(); } catch (_) {} resolve(r); };
    const client = http2.connect(environment ? hostFor(environment) : HOST);
    client.on('error', (e) => finish({ ok: false, status: 0, detail: 'connect: ' + e.message }));
    const t = setTimeout(() => finish({ ok: false, status: 0, detail: 'timeout' }), 10000);
    const req = client.request({
      ':method': 'POST',
      ':path': `/3/device/${deviceToken}`,
      authorization: `bearer ${jwt}`,
      'apns-topic': BUNDLE_ID,
      // A payload with no alert must go out as 'background', not 'alert'. Sending a badge-only
      // update as push-type 'alert' is accepted by APNs (200) but silently DISCARDED by iOS —
      // verified on device: the same badge attached to a visible alert applies, alone it does not.
      // Background pushes must also be priority 5; APNs rejects 10 for them.
      'apns-push-type': silent ? 'background' : 'alert',
      'apns-priority': silent ? '5' : '10',
      'content-type': 'application/json',
    });
    let status = 0, data = '';
    req.on('response', (h) => { status = h[':status']; });
    req.setEncoding('utf8');
    req.on('data', (d) => (data += d));
    req.on('end', () => { clearTimeout(t); finish({ ok: status === 200, status, detail: data || '' }); });
    req.on('error', (e) => { clearTimeout(t); finish({ ok: false, status: 0, detail: 'req: ' + e.message }); });
    const aps = silent
      ? { 'content-available': 1 }                                   // badge-only: nothing displayed
      : { alert: { title, body }, sound: sound || 'default' };
    if (!silent && interruptionLevel) aps['interruption-level'] = interruptionLevel;
    if (Number.isInteger(badge)) aps.badge = badge;
    if (category && !silent) aps.category = category;   // selects the action buttons the app registered
    req.end(JSON.stringify({ aps, ...(payload || {}) }));
  });
}

module.exports = { configured, send, hostFor, ENV, HOST, BUNDLE_ID, TEAM_ID, KEY_ID };
