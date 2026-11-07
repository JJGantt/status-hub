'use strict';
// A pressed voice command is on every screen from the moment the hub starts taking it (lib/streams.js
// heardStart): a `request` frame with no words, which every way out that enqueues nothing takes down
// again. A start with no end would leave a placeholder up on every surface.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const h = require('./harness');

let supa, hub;
// A Groq key that is never reached: an empty clip is refused before any transcription.
before(async () => { supa = await h.fakeSupabase(); hub = await h.startHub(supa, { GROQ_API_KEY: 'unused' }); });
after(async () => { await hub.stop(); supa.close(); });

// Collects the `request` frames of /api/voice-stream until stopped.
function listen() {
  const u = new URL(hub.base);
  const got = [];
  let req;
  const open = new Promise((resolve) => {
    req = http.get({ host: u.hostname, port: u.port, path: '/api/voice-stream', headers: { 'X-Hub-Token': h.DEVICE_TOKEN } }, (r) => {
      let buf = '';
      r.on('data', (c) => {
        buf += c;
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i); buf = buf.slice(i + 2);
          const data = block.split('\n').find((l) => l.startsWith('data: '));
          if (!block.startsWith('event: voice') || !data) continue;
          const m = JSON.parse(data.slice(6));
          if (m.kind === 'request') got.push(m.row);
        }
      });
      resolve();
    });
  });
  return { open, got, stop: () => req.destroy() };
}

const send = (query) => hub.req(`/api/voice-command?${query}`, { method: 'POST',
  headers: { 'X-Hub-Token': h.DEVICE_TOKEN, 'Content-Type': 'audio/mp4' }, body: '' });
const until = async (fn) => { for (let i = 0; i < 50 && !fn(); i++) await new Promise((r) => setTimeout(r, 20)); };

test('a pressed command is announced at once and taken down when nothing is enqueued', async () => {
  const s = listen(); await s.open;
  assert.equal((await send('client_msg_id=press-1')).status, 400);   // no audio
  await until(() => s.got.length >= 2);
  s.stop();
  assert.equal(s.got.length, 2);
  const [start, end] = s.got;
  assert.deepEqual([start.status, start.text, start.cmid], ['transcribing', '', 'press-1']);
  assert.deepEqual([end.id, end.status, end.cmid], [start.id, 'dropped', 'press-1']);
  const pending = await (await hub.req('/api/voice-pending', { headers: { 'X-Hub-Token': h.DEVICE_TOKEN } })).json();
  assert.deepEqual(pending, []);
});

test('a listener\'s capture and a dictation are never announced', async () => {
  const s = listen(); await s.open;
  await send('source=watch&client_msg_id=listen-1');
  await send('dry=1&client_msg_id=dict-1');
  await new Promise((r) => setTimeout(r, 150));
  s.stop();
  assert.deepEqual(s.got, []);
});
