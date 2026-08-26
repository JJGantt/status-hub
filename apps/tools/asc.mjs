#!/usr/bin/env node
// A tiny App Store Connect API client — enough to see and register DEVICES.
//
// Why this exists: an Ad Hoc build only installs on iPhones whose UDID was registered with Apple
// BEFORE the build was signed, because the UDID list is baked into the provisioning profile inside
// the .ipa. So "is his phone registered?" has to be answerable before spending a macOS runner on an
// archive, and registering has to be doable without a Mac or a browser login. Both are plain REST
// calls; the only fiddly part is the auth, which is a short-lived ES256 JWT rather than a token.
//
// Runs on Linux (it is called from a cheap ubuntu runner), needs no Xcode, and reads the same
// AuthKey .p8 that the TestFlight workflow already uses.
//
//   node asc.mjs devices                     — list every registered device
//   node asc.mjs register <UDID> <name…>     — register one iPhone
//
// Env: ASC_KEY_P8 (the key's PEM text), ASC_KEY_ID, ASC_ISSUER_ID.

import { createSign, createPrivateKey } from 'node:crypto';

const { ASC_KEY_P8, ASC_KEY_ID, ASC_ISSUER_ID } = process.env;
if (!ASC_KEY_P8 || !ASC_KEY_ID || !ASC_ISSUER_ID) {
  console.error('need ASC_KEY_P8, ASC_KEY_ID and ASC_ISSUER_ID in the environment');
  process.exit(2);
}

const b64url = (buf) => Buffer.from(buf).toString('base64')
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

// Apple caps the lifetime at 20 minutes and rejects anything longer outright, so this is 15.
function token() {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'ES256', kid: ASC_KEY_ID, typ: 'JWT' };
  const payload = { iss: ASC_ISSUER_ID, iat: now, exp: now + 900, aud: 'appstoreconnect-v1' };
  const input = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
  const signer = createSign('SHA256');
  signer.update(input);
  // ES256 in JOSE is the raw r||s pair. Node defaults to DER, which Apple rejects with a
  // bare 401 and no explanation — 'ieee-p1363' is the whole fix.
  const sig = signer.sign({ key: createPrivateKey(ASC_KEY_P8), dsaEncoding: 'ieee-p1363' });
  return `${input}.${b64url(sig)}`;
}

async function api(method, path, body) {
  const res = await fetch(`https://api.appstoreconnect.apple.com${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token()}`,
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* Apple sometimes returns bare HTML on 5xx */ }
  if (!res.ok) {
    const detail = json?.errors?.map((e) => `${e.title}: ${e.detail}`).join('; ') || text.slice(0, 400);
    throw new Error(`${method} ${path} -> ${res.status}\n${detail}`);
  }
  return json;
}

const [cmd, ...rest] = process.argv.slice(2);

if (cmd === 'devices') {
  const { data } = await api('GET', '/v1/devices?limit=200');
  const ios = data.filter((d) => (d.attributes.platform || '').toUpperCase() === 'IOS');
  console.log(`${data.length} device(s) on the account, ${ios.length} iOS:\n`);
  for (const d of data) {
    const a = d.attributes;
    console.log(`  ${a.status === 'ENABLED' ? '[on] ' : '[OFF]'} ${a.platform}  ${a.udid}  ${a.name}  (${a.deviceClass || '?'})`);
  }
  if (!ios.some((d) => d.attributes.status === 'ENABLED')) {
    console.log('\nNo ENABLED iOS device. An Ad Hoc build signed now would install on nothing.');
  }
} else if (cmd === 'register') {
  const [udid, ...nameParts] = rest;
  const name = nameParts.join(' ') || 'iPhone';
  if (!udid) { console.error('usage: asc.mjs register <UDID> <name…>'); process.exit(2); }
  // A modern UDID is 8 hex, a dash, then 16 hex. The older all-hex 40-char form still exists on
  // devices predating the A12, so accept both rather than rejecting a legitimate one.
  if (!/^[0-9a-fA-F]{8}-[0-9a-fA-F]{16}$/.test(udid) && !/^[0-9a-fA-F]{40}$/.test(udid)) {
    console.error(`"${udid}" is not a UDID. Expected 8hex-16hex (or 40 hex on older hardware).`);
    console.error('An APNs push token and the "Serial Number" from Settings are NOT the UDID.');
    process.exit(2);
  }
  try {
    const { data } = await api('POST', '/v1/devices', {
      data: { type: 'devices', attributes: { name, platform: 'IOS', udid } },
    });
    console.log(`registered ${data.attributes.udid} as "${data.attributes.name}"`);
  } catch (e) {
    // Re-registering an existing UDID is an error, not a no-op. That is fine — the goal is
    // "present and enabled", so report it as already-done rather than failing the run.
    if (/already exist/i.test(e.message)) console.log(`${udid} was already registered — nothing to do.`);
    else throw e;
  }
} else {
  console.error('usage: asc.mjs devices | asc.mjs register <UDID> <name…>');
  process.exit(2);
}
