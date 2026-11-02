'use strict';
// The routes that decide who may act, beyond the gate: the Menu app's owner check on /api/cg/*, which
// sits OUTSIDE the gate, and /api/notify, which pushes to Jared's phone and so wants the device token
// itself rather than any signed-in caller.
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./harness');

let supa, hub;
before(async () => { supa = await h.fakeSupabase(); hub = await h.startHub(supa); });
after(async () => { await hub.stop(); supa.close(); });

describe('the Menu app owner check (/api/cg/*)', () => {
  const orders = (headers) => hub.req('/api/cg/orders', { headers });
  test('the dedicated owner token is let through', async () =>
    assert.equal((await orders({ 'X-Owner-Token': h.OWNER_TOKEN })).status, 200));
  test('the owner\'s Anthropic key, what builds up to 44 send, is still let through', async () =>
    assert.equal((await orders({ 'X-Owner-Key': h.OWNER_KEY })).status, 200));
  test('anyone else is refused: no credential, a wrong one, or a hub credential', async () => {
    for (const headers of [{}, { 'X-Owner-Token': 'nope' }, { 'X-Owner-Key': 'nope' },
                           { 'X-Hub-Token': h.DEVICE_TOKEN }, { Cookie: `hub=${h.PASSWORD_TOKEN}` }]) {
      assert.equal((await orders(headers)).status, 401, JSON.stringify(headers));
    }
  });
  test('a wrong owner token is refused even beside the right key: the token, when sent, decides', async () =>
    assert.equal((await orders({ 'X-Owner-Token': 'nope', 'X-Owner-Key': h.OWNER_KEY })).status, 401));
  test('every cg route is behind the check, the transcriber and the writes included', async () => {
    for (const [method, p] of [['POST', '/api/cg/transcribe'], ['POST', '/api/cg/orders'],
                               ['POST', '/api/cg/orders/standardize'], ['POST', '/api/cg/orders/done']]) {
      const r = await hub.req(p, { method, headers: { 'Content-Type': 'application/json' }, body: '{}' });
      assert.equal(r.status, 401, p);
    }
  });
  test('with no token hash configured, no X-Owner-Token is accepted', async () => {
    const bare = await h.startHub(supa, { CG_OWNER_TOKEN_SHA256: '' });
    try {
      assert.equal((await bare.req('/api/cg/orders', { headers: { 'X-Owner-Token': '' } })).status, 401);
      assert.equal((await bare.req('/api/cg/orders', { headers: { 'X-Owner-Token': h.OWNER_TOKEN } })).status, 401);
    } finally { await bare.stop(); }
  });
});

describe('/api/notify', () => {
  const notify = (headers, path = '/api/notify') => hub.req(path, { method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify({ title: 't', body: 'b' }) });
  // APNs is not configured here, so a request that gets past the checks answers 503.
  test('takes the device token in a header or, until every client has moved, in ?token=', async () => {
    assert.equal((await notify({ 'X-Hub-Token': h.DEVICE_TOKEN })).status, 503);
    assert.equal((await notify({ Authorization: `Bearer ${h.DEVICE_TOKEN}` })).status, 503);
    assert.equal((await notify({}, `/api/notify?token=${h.DEVICE_TOKEN}`)).status, 503);
  });
  test('refuses a caller signed in any other way', async () => {
    assert.equal((await notify({ 'X-Hub-Token': h.PASSWORD_TOKEN })).status, 403);
    assert.equal((await notify({})).status, 401);
  });
});
