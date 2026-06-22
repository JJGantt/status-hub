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
const KEY_ID = process.env.APNS_KEY_ID || '';
const BUNDLE_ID = process.env.APNS_BUNDLE_ID || 'com.jaredgantt.statushub';
const ENV = (process.env.APNS_ENV || 'sandbox').toLowerCase();
const HOST = ENV === 'production' ? 'https://api.push.apple.com' : 'https://api.sandbox.push.apple.com';

function privateKeyPem() {
  let pem = process.env.APNS_KEY_P8 || '';
  if (!pem && process.env.APNS_KEY_PATH) {
    try { pem = fs.readFileSync(process.env.APNS_KEY_PATH, 'utf8'); } catch (_) {}
  }
  if (pem && !pem.includes('BEGIN')) {            // allow a base64-wrapped inline key (easier as a Fly secret)
    try { pem = Buffer.from(pem, 'base64').toString('utf8'); } catch (_) {}
  }
  return pem || null;
}

function configured() { return !!(KEY_ID && TEAM_ID && privateKeyPem()); }

// APNs auth JWT — valid up to 1h; reuse for ~50 min (Apple rejects regenerating too often).
let _jwt = { token: null, iat: 0 };
function authToken() {
  const now = Math.floor(Date.now() / 1000);
  if (_jwt.token && now - _jwt.iat < 3000) return _jwt.token;
  const b64 = (s) => Buffer.from(s).toString('base64url');
  const signingInput = b64(JSON.stringify({ alg: 'ES256', kid: KEY_ID })) + '.' +
                       b64(JSON.stringify({ iss: TEAM_ID, iat: now }));
  const key = crypto.createPrivateKey(privateKeyPem());
  const sig = crypto.sign('sha256', Buffer.from(signingInput), { key, dsaEncoding: 'ieee-p1363' });
  _jwt = { token: `${signingInput}.${sig.toString('base64url')}`, iat: now };
  return _jwt.token;
}

// Send one alert push. Resolves { ok, status, detail } and never rejects.
function send(deviceToken, { title, body, payload } = {}) {
  return new Promise((resolve) => {
    if (!configured()) return resolve({ ok: false, status: 0, detail: 'apns not configured' });
    let jwt;
    try { jwt = authToken(); } catch (e) { return resolve({ ok: false, status: 0, detail: 'jwt: ' + e.message }); }
    let done = false;
    const finish = (r) => { if (done) return; done = true; try { client.close(); } catch (_) {} resolve(r); };
    const client = http2.connect(HOST);
    client.on('error', (e) => finish({ ok: false, status: 0, detail: 'connect: ' + e.message }));
    const t = setTimeout(() => finish({ ok: false, status: 0, detail: 'timeout' }), 10000);
    const req = client.request({
      ':method': 'POST',
      ':path': `/3/device/${deviceToken}`,
      authorization: `bearer ${jwt}`,
      'apns-topic': BUNDLE_ID,
      'apns-push-type': 'alert',
      'apns-priority': '10',
      'content-type': 'application/json',
    });
    let status = 0, data = '';
    req.on('response', (h) => { status = h[':status']; });
    req.setEncoding('utf8');
    req.on('data', (d) => (data += d));
    req.on('end', () => { clearTimeout(t); finish({ ok: status === 200, status, detail: data || '' }); });
    req.on('error', (e) => { clearTimeout(t); finish({ ok: false, status: 0, detail: 'req: ' + e.message }); });
    req.end(JSON.stringify({ aps: { alert: { title, body }, sound: 'default' }, ...(payload || {}) }));
  });
}

module.exports = { configured, send, ENV, HOST, BUNDLE_ID, TEAM_ID, KEY_ID };
