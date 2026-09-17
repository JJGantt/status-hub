#!/usr/bin/env node
// A tiny App Store Connect API client — enough to see and register DEVICES, to register a new
// target's BUNDLE ID, and to see and change who TestFlight will let install a build.
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
//   node asc.mjs bundle-id <identifier> <name…> — register a bundle id for a new app or extension target
//   node asc.mjs testers                     — list the beta groups, their public links, and who is in them
//   node asc.mjs add-tester <group> <email> [first] [last] — put an address in a group
//   node asc.mjs public-link <group> on|off  — the shareable join link, external groups only
//   node asc.mjs builds                      — the builds TestFlight is offering, and when they expire
//
// TestFlight shows the app to anyone signed in with an Apple ID that has ever been a tester, but it
// only lets them INSTALL while that Apple ID is currently in a group — the state a phone reports as
// not being one of the testers. So `testers` is the diagnosis and `add-tester` is the fix, and the
// address that matters is the one the phone is signed in to iCloud with, not the developer account.
//
// An INTERNAL group can only hold Apple IDs that are Users on the App Store Connect account, and it
// can never have a public link — Apple only offers those on external groups, which is why a missing
// link is usually a missing external group rather than a setting that got switched off.
//
// A new target's bundle id has to be registered HERE before the first archive. The CI archive's
// automatic signing does not register one: with the watch app's ids missing it chose a profile it
// then could not find ("Build input file cannot be found: …mobileprovision") and the archive failed.
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
} else if (cmd === 'bundle-id') {
  const [identifier, ...nameParts] = rest;
  const name = nameParts.join(' ');
  if (!identifier || !name) { console.error('usage: asc.mjs bundle-id <identifier> <name…>'); process.exit(2); }
  try {
    // UNIVERSAL is what Xcode itself registers, and what the account's other watch ids are.
    const { data } = await api('POST', '/v1/bundleIds', {
      data: { type: 'bundleIds', attributes: { identifier, name, platform: 'UNIVERSAL' } },
    });
    console.log(`registered ${data.attributes.identifier} as "${data.attributes.name}" (${data.id})`);
  } catch (e) {
    if (/already (exist|been used|registered)|not available/i.test(e.message)) console.log(`${identifier} is already registered — nothing to do.\n${e.message}`);
    else throw e;
  }
} else if (cmd === 'builds') {
  // A build stops being installable 90 days after upload, and TestFlight words that on the phone as
  // the tester not having access rather than as an expiry — so "it says I am not a tester" is only
  // a membership problem once this shows a live build.
  // The app's own builds relationship refuses `include`; the top-level collection filtered by app
  // takes it, and the group assignment is the point — a build in no group reaches nobody.
  const { data } = await api('GET', '/v1/builds?filter[app]=6805268657&limit=20&include=betaGroups');
  console.log(`${data.length} build(s) on JaredHub:\n`);
  for (const b of data) {
    const a = b.attributes;
    const groups = (b.relationships?.betaGroups?.data || []).length;
    console.log(`  ${a.version}  uploaded ${a.uploadedDate}  expires ${a.expirationDate}  ${a.expired ? 'EXPIRED' : 'live'}  ${a.processingState}  groups: ${groups}`);
  }
  // Internal testing is limited to Apple IDs that are Users on the account, so an address that is
  // not here cannot be in an internal group however the invite was sent.
  const { data: users } = await api('GET', '/v1/users?limit=200');
  console.log(`\n${users.length} App Store Connect user(s):\n`);
  for (const u of users) {
    const a = u.attributes;
    console.log(`  ${a.username}  ${[a.firstName, a.lastName].filter(Boolean).join(' ')}  ${(a.roles || []).join('/')}`);
  }
} else if (cmd === 'testers' || cmd === 'add-tester' || cmd === 'public-link') {
  // Every beta call hangs off one app, and the account has more than one.
  const APP_ID = '6805268657';   // JaredHub

  const groups = async () => (await api('GET', `/v1/apps/${APP_ID}/betaGroups?limit=200`)).data;
  const findGroup = (all, name) => {
    const hit = all.filter((g) => g.attributes.name.toLowerCase() === String(name).toLowerCase());
    if (hit.length !== 1) {
      console.error(`no single group called "${name}". Groups: ${all.map((g) => g.attributes.name).join(', ')}`);
      process.exit(2);
    }
    return hit[0];
  };

  if (cmd === 'add-tester') {
    const [group, email, first = '', last = ''] = rest;
    if (!group || !email) { console.error('usage: asc.mjs add-tester <group> <email> [first] [last]'); process.exit(2); }
    const g = findGroup(await groups(), group);
    try {
      await api('POST', '/v1/betaTesters', {
        data: {
          type: 'betaTesters',
          attributes: { email, firstName: first, lastName: last },
          relationships: { betaGroups: { data: [{ type: 'betaGroups', id: g.id }] } },
        },
      });
      console.log(`added ${email} to "${g.attributes.name}"`);
    } catch (e) {
      // An address Apple already knows cannot be created again, but it can still be short of this
      // group — which is exactly the case being fixed, so look it up and attach it instead.
      if (!/already exist|taken|duplicate/i.test(e.message)) throw e;
      const { data } = await api('GET', `/v1/betaTesters?filter[email]=${encodeURIComponent(email)}&limit=1`);
      if (!data.length) throw e;
      await api('POST', `/v1/betaGroups/${g.id}/relationships/betaTesters`, {
        data: [{ type: 'betaTesters', id: data[0].id }],
      });
      console.log(`${email} already existed; added to "${g.attributes.name}"`);
    }
  }

  if (cmd === 'public-link') {
    const [group, state] = rest;
    if (!group || !['on', 'off'].includes(state)) { console.error('usage: asc.mjs public-link <group> on|off'); process.exit(2); }
    const g = findGroup(await groups(), group);
    if (g.attributes.isInternalGroup) {
      console.error(`"${g.attributes.name}" is an internal group; Apple offers public links on external groups only.`);
      process.exit(2);
    }
    const { data } = await api('PATCH', `/v1/betaGroups/${g.id}`, {
      data: { type: 'betaGroups', id: g.id, attributes: { publicLinkEnabled: state === 'on' } },
    });
    console.log(`"${data.attributes.name}" public link ${data.attributes.publicLinkEnabled ? data.attributes.publicLink : 'off'}`);
  }

  // Always print the state, including straight after a change, for the same reason the devices
  // workflow does: the log should end with what the account says, not with what we asked for.
  const all = await groups();
  console.log(`\n${all.length} beta group(s) on JaredHub:\n`);
  for (const g of all) {
    const a = g.attributes;
    console.log(`  ${a.name}  [${a.isInternalGroup ? 'internal' : 'external'}]  link: ${a.publicLinkEnabled ? a.publicLink : 'none'}`);
    const { data: testers } = await api('GET', `/v1/betaGroups/${g.id}/betaTesters?limit=200`);
    for (const t of testers) {
      const ta = t.attributes;
      console.log(`      ${ta.email}  ${[ta.firstName, ta.lastName].filter(Boolean).join(' ')}  ${ta.state || ''}`);
    }
    if (!testers.length) console.log('      (empty)');
  }
} else {
  console.error('usage: asc.mjs devices | register <UDID> <name…> | bundle-id <identifier> <name…> | testers | add-tester <group> <email> [first] [last] | public-link <group> on|off | builds');
  process.exit(2);
}
