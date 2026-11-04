'use strict';
// The auth gate and every way a request can be signed in (lib/auth.js, the gate included), the
// guess limit shared by /login and the password-derived token, and the session lifecycle: issue at /login, upgrade from the old cookie, revoke one or
// all, survive a restart.
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./harness');

let supa, hub;
before(async () => { supa = await h.fakeSupabase(); hub = await h.startHub(supa); });
after(async () => { await hub.stop(); supa.close(); });

const status = async (p, init) => (await hub.req(p, init)).status;
let ipSeq = 0;
const freshIp = () => `10.0.0.${++ipSeq}`;   // the guess limit is per client address (Fly-Client-IP)
async function login(password = h.PASSWORD, ip = freshIp(), headers = {}) {
  return hub.req('/login', { method: 'POST', body: new URLSearchParams({ password }),
    headers: { 'Fly-Client-IP': ip, 'User-Agent': h.SAFARI, ...headers } });
}

describe('the gate, unauthenticated', () => {
  test('an API route answers 401', async () => assert.equal(await status('/api/todos'), 401));
  test('a page redirects to /login', async () => {
    const r = await hub.req('/', { headers: h.NAV });
    assert.equal(r.status, 302);
    assert.equal(r.headers.get('location'), '/login');
  });
  test('the routes declared above the gate stay public', async () => {
    assert.equal(await status('/healthz'), 200);
    assert.equal(await status('/login'), 200);
  });
  test('the public surf set passes; its neighbours do not', async () => {
    assert.notEqual(await status('/surf'), 401);
    assert.notEqual(await status('/surf'), 302);
    assert.equal(await status('/api/surf/forecast'), 401);
  });
  test('garbage credentials are refused everywhere they can be sent', async () => {
    const ip = { 'Fly-Client-IP': freshIp() };
    for (const headers of [{ 'X-Hub-Token': 'nope' }, { Authorization: 'Bearer nope' }, { Cookie: 'hub=nope' },
                           { Cookie: 'hub=s.00000000-0000-0000-0000-000000000000.x' }, { Cookie: 'hub=d.00' }]) {
      assert.equal(await status('/api/todos', { headers: { ...ip, ...headers } }), 401, JSON.stringify(headers));
    }
    assert.equal(await status('/api/todos?token=nope'), 401);
  });
});

describe('the device token (TV_TOKEN)', () => {
  test('is accepted in X-Hub-Token', async () =>
    assert.equal(await status('/api/todos', { headers: { 'X-Hub-Token': h.DEVICE_TOKEN } }), 200));
  test('is accepted as Authorization: Bearer', async () =>
    assert.equal(await status('/api/todos', { headers: { Authorization: `Bearer ${h.DEVICE_TOKEN}` } }), 200));
  test('is never accepted as ?token= on anything but a page load', async () => {
    assert.equal(await status(`/api/todos?token=${h.DEVICE_TOKEN}`), 401);
    assert.equal(await status(`/api/todos?token=${h.DEVICE_TOKEN}`, { headers: { 'Sec-Fetch-Mode': 'cors' } }), 401);
    assert.ok(!hub.output().includes(h.DEVICE_TOKEN));
  });
  test('as ?token= on a page load, is traded for the device cookie and stripped from the URL', async () => {
    const r = await hub.req(`/tv?mode=x&token=${h.DEVICE_TOKEN}`, { headers: { ...h.NAV, 'User-Agent': h.SAFARI } });
    assert.equal(r.status, 302);
    assert.equal(r.headers.get('location'), '/tv?mode=x');
    const c = h.setCookie(r);
    assert.match(c, /^d\.[0-9a-f]{64}$/);
    assert.ok(!c.includes(h.DEVICE_TOKEN));
    assert.match(r.headers.get('set-cookie'), /HttpOnly/);
    assert.match(r.headers.get('set-cookie'), /Max-Age=315360000/);   // ten years, as before
    assert.equal(await status('/api/todos', { headers: { Cookie: `hub=${c}` } }), 200);
    const page = await hub.req('/tv?mode=x', { headers: { ...h.NAV, Cookie: `hub=${c}` } });
    assert.equal(page.status, 200);
  });
  test('a page load with a wrong ?token= goes to /login, not through', async () => {
    const r = await hub.req('/tv?token=nope', { headers: h.NAV });
    assert.equal(r.headers.get('location'), '/login');
  });
  test('a page load already signed in has its ?token= stripped too', async () => {
    const r = await hub.req('/tv?token=whatever', { headers: { ...h.NAV, 'X-Hub-Token': h.DEVICE_TOKEN } });
    assert.equal(r.status, 302);
    assert.equal(r.headers.get('location'), '/tv');
  });
  test('in a header on a page load, also sets the device cookie for the page\'s own requests', async () => {
    const r = await hub.req('/tv-sidebar', { headers: { ...h.NAV, 'X-Hub-Token': h.DEVICE_TOKEN } });
    assert.equal(r.status, 200);
    assert.match(h.setCookie(r), /^d\./);
  });
  test('the device cookie is tied to TV_TOKEN: a hub with another token refuses it', async () => {
    const r = await hub.req(`/tv?token=${h.DEVICE_TOKEN}`, { headers: h.NAV });
    const c = h.setCookie(r);
    const other = await h.startHub(supa, { TV_TOKEN: 'rotated' });
    try {
      assert.equal((await other.req('/api/todos', { headers: { Cookie: `hub=${c}` } })).status, 401);
    } finally { await other.stop(); }
  });
});

describe('the password-derived token (native app, pre-session browsers)', () => {
  test('is accepted as X-Hub-Token and as the cookie', async () => {
    assert.equal(await status('/api/todos', { headers: { 'X-Hub-Token': h.PASSWORD_TOKEN } }), 200);
    assert.equal(await status('/api/todos', { headers: { Cookie: `hub=${h.PASSWORD_TOKEN}` } }), 200);
  });
  test('a browser page load holding it is moved onto a session', async () => {
    const r = await hub.req('/', { headers: { ...h.NAV, 'User-Agent': h.SAFARI, Cookie: `hub=${h.PASSWORD_TOKEN}` } });
    assert.equal(r.status, 200);
    const c = h.setCookie(r);
    assert.match(c, /^s\.[0-9a-f-]{36}\.[A-Za-z0-9_-]+$/);
    assert.equal(await status('/api/todos', { headers: { Cookie: `hub=${c}` } }), 200);
    const row = supa.tables.hub_sessions.find((s) => s.id === c.split('.')[1]);
    assert.equal(row.via, 'upgrade');
    assert.ok(!JSON.stringify(row).includes(c.split('.')[2]), 'the secret is stored only as a hash');
  });
  test('the app\'s WKWebView is never upgraded (its watch relies on the derived token)', async () => {
    const r = await hub.req('/', { headers: { ...h.NAV, 'User-Agent': h.WKWEBVIEW, Cookie: `hub=${h.PASSWORD_TOKEN}` } });
    assert.equal(r.status, 200);
    assert.equal(h.setCookie(r), null);
  });
  test('a fetch (not a page load) is never upgraded', async () => {
    const r = await hub.req('/api/todos', { headers: { 'User-Agent': h.SAFARI, Cookie: `hub=${h.PASSWORD_TOKEN}` } });
    assert.equal(r.status, 200);
    assert.equal(h.setCookie(r), null);
  });
});

describe('login', () => {
  test('the right password issues a session cookie and redirects home', async () => {
    const r = await login();
    assert.equal(r.status, 302);
    assert.equal(r.headers.get('location'), '/');
    const c = h.setCookie(r);
    assert.match(c, /^s\./);
    assert.notEqual(c, h.PASSWORD_TOKEN);
    assert.match(r.headers.get('set-cookie'), /Max-Age=315360000; Path=\/; HttpOnly; Secure; SameSite=Lax/);
    assert.equal(await status('/api/todos', { headers: { Cookie: `hub=${c}` } }), 200);
    // The watch is handed the web view's cookie and sends it as a header.
    assert.equal(await status('/api/todos', { headers: { 'X-Hub-Token': c } }), 200);
  });
  test('a wrong password is 401 and sets nothing', async () => {
    const r = await login('wrong');
    assert.equal(r.status, 401);
    assert.equal(h.setCookie(r), null);
  });
  test('five wrong passwords lock that IP out, even from the right one; other IPs are unaffected', async () => {
    const ip = freshIp();
    for (let i = 0; i < 5; i++) assert.equal((await login(`wrong${i}`, ip)).status, 401);
    assert.equal((await login('wrong5', ip)).status, 429);
    assert.equal((await login(h.PASSWORD, ip)).status, 429);
    assert.equal((await login(h.PASSWORD, freshIp())).status, 302);
  });
  test('a success does not reset the count (a user on the same address would otherwise reset an attacker\'s)', async () => {
    const ip = freshIp();
    for (let i = 0; i < 4; i++) await login(`wrong${i}`, ip);
    assert.equal((await login(h.PASSWORD, ip)).status, 302);
    assert.equal((await login('wrong4', ip)).status, 401);
    assert.equal((await login(h.PASSWORD, ip)).status, 429);
  });
  test('the same wrong password repeated counts once', async () => {
    const ip = freshIp();
    for (let i = 0; i < 10; i++) assert.equal((await login('same-typo', ip)).status, 401);
    assert.equal((await login(h.PASSWORD, ip)).status, 302);
  });
});

// The password-derived token is only as strong as the password, so a guess at it in a header or the
// cookie spends the same per-address budget as a wrong password at /login.
describe('the guess limit on tokens', () => {
  const at = (ip, headers = {}) => status('/api/todos', { headers: { 'Fly-Client-IP': ip, ...headers } });
  const guess = (i) => h.PASSWORD_TOKEN.slice(0, -4) + String(1000 + i);

  test('five wrong header tokens lock the address out, even for the right token; other addresses are unaffected', async () => {
    const ip = freshIp();
    for (let i = 0; i < 5; i++) assert.equal(await at(ip, { 'X-Hub-Token': guess(i) }), 401);
    assert.equal(await at(ip, { 'X-Hub-Token': guess(5) }), 429);
    assert.equal(await at(ip, { 'X-Hub-Token': h.PASSWORD_TOKEN }), 429);
    assert.equal(await at(ip, { Cookie: `hub=${h.PASSWORD_TOKEN}` }), 429);
    assert.equal(await at(freshIp(), { 'X-Hub-Token': h.PASSWORD_TOKEN }), 200);
  });
  test('Bearer, the cookie and /login all draw on the same budget', async () => {
    const ip = freshIp();
    await at(ip, { Authorization: `Bearer ${guess(0)}` });
    await at(ip, { Cookie: `hub=${guess(1)}` });
    await login('wrong-a', ip);
    await login('wrong-b', ip);
    await at(ip, { 'X-Hub-Token': guess(2) });
    assert.equal((await login(h.PASSWORD, ip)).status, 429);
    assert.equal(await at(ip, { 'X-Hub-Token': h.PASSWORD_TOKEN }), 429);
  });
  test('a locked address still gets in with the device token, the device cookie or a session', async () => {
    const session = h.setCookie(await login());
    const deviceCookie = h.setCookie(await hub.req(`/tv?token=${h.DEVICE_TOKEN}`, { headers: h.NAV }));
    const ip = freshIp();
    for (let i = 0; i < 5; i++) await at(ip, { 'X-Hub-Token': guess(i) });
    assert.equal(await at(ip, { 'X-Hub-Token': h.DEVICE_TOKEN }), 200);
    assert.equal(await at(ip, { Cookie: `hub=${deviceCookie}` }), 200);
    assert.equal(await at(ip, { Cookie: `hub=${session}` }), 200);
    assert.equal(await at(ip), 401);   // no credential at all is an ordinary refusal, not a lockout
  });
  test('a stale token resent forever (after a password change) counts once and locks nothing', async () => {
    const ip = freshIp();
    for (let i = 0; i < 20; i++) assert.equal(await at(ip, { 'X-Hub-Token': guess(0) }), 401);
    assert.equal(await at(ip, { 'X-Hub-Token': h.PASSWORD_TOKEN }), 200);
  });
  test('the right token does not reset the count', async () => {
    const ip = freshIp();
    for (let i = 0; i < 4; i++) await at(ip, { 'X-Hub-Token': guess(i) });
    assert.equal(await at(ip, { 'X-Hub-Token': h.PASSWORD_TOKEN }), 200);
    await at(ip, { 'X-Hub-Token': guess(4) });
    assert.equal(await at(ip, { 'X-Hub-Token': h.PASSWORD_TOKEN }), 429);
  });
  test('wrong sessions and device cookies are not counted: they are never checked against the password', async () => {
    const ip = freshIp();
    for (let i = 0; i < 10; i++) {
      await at(ip, { Cookie: `hub=s.00000000-0000-0000-0000-00000000000${i}.x` });
      await at(ip, { Cookie: `hub=d.${i}` });
    }
    assert.equal(await at(ip, { 'X-Hub-Token': h.PASSWORD_TOKEN }), 200);
  });
  test('an IPv6 client is counted by its /64, so rotating addresses inside it gains nothing', async () => {
    for (let i = 0; i < 5; i++) await at(`2001:db8:1:2::${i + 1}`, { 'X-Hub-Token': guess(i) });
    assert.equal(await at('2001:db8:1:2:ffff::9', { 'X-Hub-Token': h.PASSWORD_TOKEN }), 429);
    assert.equal(await at('2001:db8:1:3::1', { 'X-Hub-Token': h.PASSWORD_TOKEN }), 200);
  });
});

describe('addressKey', () => {
  const { addressKey } = require('../lib/auth');
  test('keeps IPv4 as is, unwraps v4-mapped IPv6, and cuts IPv6 to its /64', () => {
    assert.equal(addressKey('203.0.113.7'), '203.0.113.7');
    assert.equal(addressKey('::ffff:203.0.113.7'), '203.0.113.7');
    assert.equal(addressKey('2001:db8:1:2::1'), '2001:db8:1:2::/64');
    assert.equal(addressKey('2001:0db8:0001:0002:aaaa:bbbb:cccc:dddd'), '2001:db8:1:2::/64');
    assert.equal(addressKey('2001:db8::5'), '2001:db8:0:0::/64');
    assert.equal(addressKey('::1'), '0:0:0:0::/64');
  });
});

describe('sessions: list and revoke', () => {
  const dev = { 'X-Hub-Token': h.DEVICE_TOKEN, 'Content-Type': 'application/json' };
  const revoke = (body) => hub.req('/api/auth/revoke', { method: 'POST', headers: dev, body: JSON.stringify(body) });

  test('the list shows each session, marks the caller\'s own, and never carries a secret', async () => {
    const c = h.setCookie(await login());
    const r = await hub.req('/api/auth/sessions', { headers: { Cookie: `hub=${c}` } });
    const { sessions } = await r.json();
    const mine = sessions.filter((s) => s.current);
    assert.equal(mine.length, 1);
    assert.equal(mine[0].id, c.split('.')[1]);
    assert.ok(!JSON.stringify(sessions).includes(c.split('.')[2]));
    assert.ok(!JSON.stringify(sessions).includes('secret'));
  });
  test('revoking one ends that device only', async () => {
    const a = h.setCookie(await login()), b = h.setCookie(await login());
    const r = await revoke({ id: a.split('.')[1] });
    assert.deepEqual((await r.json()).revoked, [a.split('.')[1]]);
    assert.equal(await status('/api/todos', { headers: { Cookie: `hub=${a}` } }), 401);
    assert.equal(await status('/api/todos', { headers: { Cookie: `hub=${b}` } }), 200);
    const page = await hub.req('/', { headers: { ...h.NAV, Cookie: `hub=${a}` } });
    assert.equal(page.headers.get('location'), '/login');
  });
  test('revoking all ends every session but not the device token or the password-derived token', async () => {
    const a = h.setCookie(await login()), b = h.setCookie(await login());
    const r = await revoke({ all: true });
    assert.ok((await r.json()).revoked.length >= 2);
    for (const c of [a, b]) assert.equal(await status('/api/todos', { headers: { Cookie: `hub=${c}` } }), 401);
    assert.equal(await status('/api/todos', { headers: { 'X-Hub-Token': h.DEVICE_TOKEN } }), 200);
    assert.equal(await status('/api/todos', { headers: { 'X-Hub-Token': h.PASSWORD_TOKEN } }), 200);
    assert.ok(supa.tables.hub_sessions.every((s) => s.revoked_at), 'persisted, so a restart keeps them revoked');
  });
});

describe('sessions across a restart', () => {
  test('a live session still works and a revoked one is still refused after the hub restarts', async () => {
    const live = h.setCookie(await login()), dead = h.setCookie(await login());
    await hub.req('/api/auth/revoke', { method: 'POST', headers: { 'X-Hub-Token': h.DEVICE_TOKEN, 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: dead.split('.')[1] }) });
    const second = await h.startHub(supa);
    try {
      assert.equal((await second.req('/api/todos', { headers: { Cookie: `hub=${live}` } })).status, 200);
      assert.equal((await second.req('/api/todos', { headers: { Cookie: `hub=${dead}` } })).status, 401);
    } finally { await second.stop(); }
  });
  test('a session that cannot be stored is not issued', async () => {
    const broken = await h.startHub(supa, {});
    supa.failWrites = true;
    try {
      const r = await broken.req('/login', { method: 'POST', body: new URLSearchParams({ password: h.PASSWORD }),
        headers: { 'Fly-Client-IP': freshIp() } });
      assert.equal(r.status, 503);
      assert.equal(h.setCookie(r), null);
    } finally { supa.failWrites = false; await broken.stop(); }
  });
});

// Who may call a route is decided by which router it is on (`pub` or `gated` in server.js and
// routes/), never by where it is defined. This reads every registration from the source, so a new
// route is covered the moment it is written.
describe('which routes are public', () => {
  const fs = require('fs');
  const path = require('path');
  const root = path.join(__dirname, '..');
  const files = ['server.js', ...(fs.existsSync(path.join(root, 'routes'))
    ? fs.readdirSync(path.join(root, 'routes')).filter((f) => f.endsWith('.js')).map((f) => `routes/${f}`) : [])];
  const routes = [];
  for (const f of files) {
    const src = fs.readFileSync(path.join(root, f), 'utf8');
    for (const m of src.matchAll(/\b(pub|gated)\.(get|post|put|patch|delete)\(\s*(\[[^\]]*\]|'[^']*'|`[^`]*`)/g)) {
      const paths = m[3].startsWith('[') ? [...m[3].matchAll(/'([^']*)'/g)].map((x) => x[1]) : [m[3].slice(1, -1)];
      for (const p of paths) routes.push({ router: m[1], method: m[2].toUpperCase(), path: p, file: f });
    }
  }
  // Every path anyone may call signed out, and why: the hub's own health and sign-in; the legal pages
  // and Search Console file Google fetches anonymously; the Menu app's routes, which check the owner
  // themselves; the surf app's page and feeds (public data, shown with no sign-in); GitHub's CI webhook,
  // which carries no hub credential and is authenticated by its HMAC signature (routes/ci.js).
  const PUBLIC = new Set([
    'GET /healthz', 'GET /login', 'POST /login', 'GET /${doc}', 'GET /${process.env.GSC_VERIFICATION}',
    'POST /api/cg/transcribe', 'GET /api/cg/orders', 'POST /api/cg/orders', 'POST /api/cg/orders/standardize',
    'POST /api/cg/orders/done',
    'GET /surf', 'GET /api/surf/live', 'GET /api/surf/stream', 'GET /api/surf/history',
    'GET /app.css', 'GET /surf.css', 'GET /dist/surf.js',
    'POST /api/ci/github',
  ]);

  test('the source was read', () => assert.ok(routes.filter((r) => r.router === 'gated').length > 50));
  test('the public routes are exactly the intended set', () => {
    const pub = new Set(routes.filter((r) => r.router === 'pub').map((r) => `${r.method} ${r.path}`));
    assert.deepEqual([...pub].sort(), [...PUBLIC].sort());
  });
  test('every gated route refuses a signed-out request', async () => {
    for (const r of routes.filter((x) => x.router === 'gated')) {
      const p = r.path.replace(/:(\w+)/g, 'x');
      const res = await hub.req(p, { method: r.method, headers: { 'Content-Type': 'application/json' },
        body: r.method === 'GET' ? undefined : '{}' });
      assert.ok(res.status === 401 || (res.status === 302 && res.headers.get('location') === '/login'),
        `${r.method} ${r.path} (${r.file}) answered ${res.status} signed out`);
    }
  });
  test('the static client files are gated too, all but the surf page\'s three', async () => {
    assert.equal((await hub.req('/core.js')).status, 302);
    assert.equal((await hub.req('/surf.css')).status, 200);
  });
});
