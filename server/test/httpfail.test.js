'use strict';
// Every 5xx the hub answers is logged with console.error (and so reaches the ops responder), once,
// with the caught exception's stack when the handler passed it (lib/httpfail.js). A 4xx is not.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./harness');

let supa, hub;
before(async () => { supa = await h.fakeSupabase(); hub = await h.startHub(supa); });
after(async () => { await hub.stop(); supa.close(); });

const auth = { 'X-Hub-Token': h.DEVICE_TOKEN, 'Content-Type': 'application/json' };
const lines = (needle) => hub.output().split('\n').filter((l) => l.includes(needle));
// stderr reaches the test a moment after the response does.
async function eventually(fn) {
  for (let i = 0; i < 50 && !fn(); i++) await new Promise((r) => setTimeout(r, 20));
  return fn();
}

test('a caught failure answered 500 is reported with its method, path, body and stack', async () => {
  supa.failWrites = true;
  try {
    const r = await hub.req('/api/voice-mute?probe=q-secret', { method: 'POST', headers: auth,
      body: JSON.stringify({ holder: 'httpfail-test', on: true }) });
    assert.equal(r.status, 500);
  } finally { supa.failWrites = false; }
  assert.ok(await eventually(() => lines('[http] POST /api/voice-mute answered 500').length === 1), hub.output());
  const out = hub.output();
  const at = out.indexOf('[http] POST /api/voice-mute answered 500');
  assert.match(out.slice(at, at + 2000), /answered 500: \{"error":"[^"]+"\} Error: [^\n]+\n\s+at /);
  assert.ok(!out.includes('q-secret'), 'the query string stays out of the report');
});

test('a 4xx is not reported', async () => {
  const r = await hub.req('/api/voice-mute', { method: 'POST', headers: auth, body: JSON.stringify({}) });
  assert.equal(r.status, 400);
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(lines('[http] POST /api/voice-mute answered 400').length, 0);
});

test('a 5xx the handler logged itself is not reported a second time', async () => {
  supa.failWrites = true;
  try {
    const r = await hub.req('/login', { method: 'POST', body: new URLSearchParams({ password: h.PASSWORD }),
      headers: { 'Fly-Client-IP': '203.0.113.77' } });
    assert.equal(r.status, 503);
  } finally { supa.failWrites = false; }
  assert.ok(await eventually(() => lines('[login] could not store the session').length > 0), hub.output());
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(lines('[http] POST /login').length, 0);
});
