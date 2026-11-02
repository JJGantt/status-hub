'use strict';
// The auth gate and every way a request can be signed in (lib/auth.js, the gate in server.js), the
// login lockout, and the session lifecycle: issue at /login, upgrade from the old cookie, revoke one or
// all, survive a restart.
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./harness');

let supa, hub;
before(async () => { supa = await h.fakeSupabase(); hub = await h.startHub(supa); });
after(async () => { await hub.stop(); supa.close(); });

const status = async (p, init) => (await hub.req(p, init)).status;
let ipSeq = 0;
const freshIp = () => `10.0.0.${++ipSeq}`;   // the lockout is per client IP (Fly-Client-IP)
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
    for (const headers of [{ 'X-Hub-Token': 'nope' }, { Authorization: 'Bearer nope' }, { Cookie: 'hub=nope' },
                           { Cookie: 'hub=s.00000000-0000-0000-0000-000000000000.x' }, { Cookie: 'hub=d.00' }]) {
      assert.equal(await status('/api/todos', { headers }), 401, JSON.stringify(headers));
    }
    assert.equal(await status('/api/todos?token=nope'), 401);
  });
});

describe('the device token (TV_TOKEN)', () => {
  test('is accepted in X-Hub-Token', async () =>
    assert.equal(await status('/api/todos', { headers: { 'X-Hub-Token': h.DEVICE_TOKEN } }), 200));
  test('is accepted as Authorization: Bearer', async () =>
    assert.equal(await status('/api/todos', { headers: { Authorization: `Bearer ${h.DEVICE_TOKEN}` } }), 200));
  test('is still accepted as ?token= on an API call, and logs the path but never the token', async () => {
    assert.equal(await status(`/api/todos?token=${h.DEVICE_TOKEN}`), 200);
    assert.match(hub.output(), /\[auth\] \?token= on GET \/api\/todos/);
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
    for (let i = 0; i < 5; i++) assert.equal((await login('wrong', ip)).status, 401);
    assert.equal((await login('wrong', ip)).status, 429);
    assert.equal((await login(h.PASSWORD, ip)).status, 429);
    assert.equal((await login(h.PASSWORD, freshIp())).status, 302);
  });
  test('a success clears the IP\'s count', async () => {
    const ip = freshIp();
    for (let i = 0; i < 4; i++) await login('wrong', ip);
    assert.equal((await login(h.PASSWORD, ip)).status, 302);
    for (let i = 0; i < 4; i++) assert.equal((await login('wrong', ip)).status, 401);
    assert.equal((await login(h.PASSWORD, ip)).status, 302);
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
