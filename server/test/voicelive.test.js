'use strict';
// /api/voice-live through the real server: a recording that ends on purpose leaves nothing behind, and
// one whose connection drops mid-audio is marked lost the moment it drops. What counts here is the
// verdict the hub reaches from the connection itself, so the request is driven over a raw socket that
// can be cut mid-body the way a dying app cuts it.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const crypto = require('crypto');
const h = require('./harness');

let supa, hub;
// A Groq key that is never reached: the cases below are refused before any transcription.
before(async () => { supa = await h.fakeSupabase(); hub = await h.startHub(supa, { GROQ_API_KEY: 'unused' }); });
after(async () => { await hub.stop(); supa.close(); });

const frame = (type, data = Buffer.alloc(0)) => {
  const head = Buffer.alloc(5);
  head.write(type, 0, 'latin1');
  head.writeUInt32BE(data.length, 1);
  return Buffer.concat([head, data]);
};

// Opens the stream, writes `frames`, then either ends the body or destroys the socket.
function stream(id, frames, { cut }) {
  const u = new URL(hub.base);
  return new Promise((resolve) => {
    const req = http.request({ host: u.hostname, port: u.port, method: 'POST', path: `/api/voice-live?id=${id}&view=chat`,
      headers: { 'X-Hub-Token': h.DEVICE_TOKEN, 'Content-Type': 'application/octet-stream', 'Transfer-Encoding': 'chunked' } });
    req.on('error', () => resolve('cut'));
    req.on('response', (r) => { r.resume(); r.on('end', () => resolve(r.statusCode)); });
    for (const f of frames) req.write(f);
    if (cut) setTimeout(() => { req.destroy(); resolve('cut'); }, 100);
    else req.end();
  });
}

const settled = async (id) => {
  for (let i = 0; i < 50; i++) {
    const line = hub.output().split('\n').find((l) => l.includes(`[voice-live] ${id} `));
    if (line) return line;
    await new Promise((r) => setTimeout(r, 50));
  }
  return null;
};
const lostRows = (id) => (supa.tables.client_log || []).filter((r) => r.ev === 'record-lost' && r.data && r.data.live === id);

test('a recording that ends with E is ended, and nothing is marked lost', async () => {
  const id = crypto.randomUUID();
  assert.equal(await stream(id, [frame('A', Buffer.from('xx')), frame('E')], { cut: false }), 204);
  assert.match(await settled(id), / ended:/);
  assert.equal(lostRows(id).length, 0);
});

test('a connection dropped while audio flows is lost, and marked so at once', async () => {
  const id = crypto.randomUUID();
  await stream(id, [frame('A', Buffer.from('xx')), frame('A', Buffer.from('yy'))], { cut: true });
  assert.match(await settled(id), / lost:/);
  for (let i = 0; i < 50 && !lostRows(id).length; i++) await new Promise((r) => setTimeout(r, 50));
  assert.equal(lostRows(id).length, 1);
});

test('a dropped connection while paused is stalled, not lost', async () => {
  const id = crypto.randomUUID();
  await stream(id, [frame('A', Buffer.from('xx')), frame('P')], { cut: true });
  assert.match(await settled(id), / stalled:/);
  assert.equal(lostRows(id).length, 0);
});

test('a stream without a valid id is refused', async () => {
  assert.equal((await hub.req('/api/voice-live?id=nope', { method: 'POST', headers: { 'X-Hub-Token': h.DEVICE_TOKEN } })).status, 400);
});

// A command sent as just its details takes its audio from the stream (no second upload). When the stream
// cannot supply the whole recording the hub answers 409 `upload`, and the watch sends the clip instead.
const fromLive = (live) => hub.req(`/api/voice-command?live=${live}&dur=3.0&client_msg_id=${crypto.randomUUID()}&source=watch-cmd`,
  { method: 'POST', headers: { 'X-Hub-Token': h.DEVICE_TOKEN, 'X-Audio-Source': 'live' } });

test('a command naming a stream the hub never saw asks for the clip', async () => {
  const r = await fromLive(crypto.randomUUID());
  assert.equal(r.status, 409);
  assert.equal((await r.json()).why, 'unknown');
});

test('a command naming a stream that was lost asks for the clip', async () => {
  const id = crypto.randomUUID();
  await stream(id, [frame('A', Buffer.from('xx')), frame('A', Buffer.from('yy'))], { cut: true });
  await settled(id);
  const r = await fromLive(id);
  assert.equal(r.status, 409);
  assert.equal((await r.json()).why, 'lost');
});
