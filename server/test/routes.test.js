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

describe('permission prompts (/api/session-prompts)', () => {
  const json = async (token, method, p, body) => {
    const r = await hub.req(p, { method, headers: { 'Content-Type': 'application/json', 'X-Hub-Token': token },
                                 ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: r.status, json: await r.json().catch(() => ({})) };
  };
  const open = (token = h.DEVICE_TOKEN, claude = 'c0ffee00-1111-2222-3333-444455556666') =>
    json(token, 'POST', '/api/session-prompts', { claude_session_id: claude, tool_name: 'Bash', tool_input: { command: 'rm -rf build' } });
  before(() => {
    supa.tables.desk_sessions = [{ id: 's-prompt01', claude_session_id: 'c0ffee00-1111-2222-3333-444455556666',
                                   status: 'resident', label: 'Build cleanup', repo: 'status-hub' }];
  });

  test('only a machine may report a dialog, and only for a running session the hub knows', async () => {
    assert.equal((await open(h.PASSWORD_TOKEN)).status, 403);
    assert.equal((await open(h.DEVICE_TOKEN, 'deadbeef-0000-0000-0000-000000000000')).status, 404);
    const r = await open();
    assert.equal(r.status, 200);
    assert.equal(r.json.session, 's-prompt01');
  });

  test('a waiting hook is answered the moment a button is pressed, and the first answer stands', async () => {
    const { json: { id } } = await open();
    const waiting = json(h.DEVICE_TOKEN, 'GET', `/api/session-prompts/${id}?wait=20`);
    await new Promise((r) => setTimeout(r, 200));
    const t0 = Date.now();
    assert.equal((await json(h.PASSWORD_TOKEN, 'POST', `/api/session-prompts/${id}/decide`, { decision: 'deny' })).status, 200);
    const got = await waiting;
    assert.equal(got.json.decision, 'deny');
    assert.ok(Date.now() - t0 < 5000);
    const late = await json(h.PASSWORD_TOKEN, 'POST', `/api/session-prompts/${id}/decide`, { decision: 'allow' });
    assert.equal(late.json.decision, 'deny');
    assert.equal(late.json.already, true);
  });

  test('a dialog the terminal answered is gone: a later tap changes nothing, and only a machine can say so', async () => {
    const { json: { id } } = await open();
    assert.equal((await json(h.PASSWORD_TOKEN, 'POST', `/api/session-prompts/${id}/decide`, { decision: 'gone' })).status, 403);
    await json(h.DEVICE_TOKEN, 'POST', `/api/session-prompts/${id}/decide`, { decision: 'gone' });
    const tap = await json(h.PASSWORD_TOKEN, 'POST', `/api/session-prompts/${id}/decide`, { decision: 'allow' });
    assert.equal(tap.json.decision, 'gone');
  });

  test('reading a prompt is for machines; anything else is refused', async () => {
    const { json: { id } } = await open();
    assert.equal((await json(h.PASSWORD_TOKEN, 'GET', `/api/session-prompts/${id}`)).status, 403);
    assert.equal((await json(h.DEVICE_TOKEN, 'GET', '/api/session-prompts/nope')).status, 404);
    assert.equal((await json(h.PASSWORD_TOKEN, 'POST', `/api/session-prompts/${id}/decide`, { decision: 'maybe' })).status, 400);
  });
});
