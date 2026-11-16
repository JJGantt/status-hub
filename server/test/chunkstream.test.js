'use strict';
// The phone's recordings streamed in acknowledged chunks (lib/chunkstream.js, /api/voice-chunk): what a
// stream holds is measured from its own timestamps, chunks are taken in order exactly once, and a capture
// that keeps under half of what it recorded is called damaged in the acknowledgement, while recording.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const h = require('./harness');
const { webmSeconds, isDamaged, sequence } = require('../lib/chunkstream');

// A minimal MediaRecorder-shaped WebM: EBML header, a Segment and Clusters of unknown size, one Opus
// block every 20ms carrying its timestamp relative to its cluster's.
const el = (id, body) => Buffer.concat([Buffer.from(id), Buffer.from([0x80 | body.length]), body]);
const UNKNOWN = Buffer.from([0x01, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF]);
function webm(blocks, perCluster = 50) {
  const out = [el([0x1A, 0x45, 0xDF, 0xA3], Buffer.from([0x42, 0x82, 0x84, 0x77, 0x65, 0x62, 0x6D])),
    Buffer.from([0x18, 0x53, 0x80, 0x67]), UNKNOWN];
  for (let i = 0; i < blocks.length; i++) {
    const ms = blocks[i];
    if (i % perCluster === 0) out.push(Buffer.from([0x1F, 0x43, 0xB6, 0x75]), UNKNOWN, el([0xE7], Buffer.from([ms >> 8, ms & 0xFF])));
    const base = blocks[i - (i % perCluster)];
    const rel = Buffer.alloc(2); rel.writeInt16BE(ms - base);
    out.push(el([0xA3], Buffer.concat([Buffer.from([0x81]), rel, Buffer.from([0x80, 1, 2, 3])])));
  }
  return Buffer.concat(out);
}

test('webmSeconds reads the length off the block timestamps, and a cut-off tail does not break it', () => {
  const sound = webm(Array.from({ length: 500 }, (_, i) => i * 20));          // 10s of 20ms frames
  assert.ok(Math.abs(webmSeconds(sound) - 10) < 0.05);
  assert.ok(Math.abs(webmSeconds(sound.subarray(0, sound.length - 3)) - 9.98) < 0.05);
  // A capture that keeps one frame in nine: its timestamps close up over the gaps, so it holds ~1.1s.
  const dropped = webm(Array.from({ length: 56 }, (_, i) => i * 20));
  assert.ok(webmSeconds(dropped) < 1.2);
  assert.equal(webmSeconds(Buffer.from('not webm at all')), null);
});

test('damaged is under half of what was recorded, judged only once there is enough of it', () => {
  assert.equal(isDamaged(1, 10), true);
  assert.equal(isDamaged(9.8, 10), false);
  assert.equal(isDamaged(0.5, 3), false);
  assert.equal(isDamaged(null, 30), false);
});

test('a chunk is taken once, in order', () => {
  assert.equal(sequence(3, 3), 'take');
  assert.equal(sequence(3, 2), 'repeat');
  assert.equal(sequence(3, 5), 'gap');
});

let supa, hub;
before(async () => { supa = await h.fakeSupabase(); hub = await h.startHub(supa, { GROQ_API_KEY: 'unused' }); });
after(async () => { await hub.stop(); supa.close(); });

// One AAC frame in ADTS at 16 kHz: 1024 samples, 64ms.
const adts = () => { const len = 7 + 4; return Buffer.from([0xFF, 0xF1, (1 << 6) | (8 << 2), (1 << 6) | (len >> 11), (len >> 3) & 0xFF, ((len & 7) << 5) | 0x1F, 0xFC, 0, 0, 0, 0]); };
const frames = (n) => Buffer.concat(Array.from({ length: n }, adts));
const chunk = (id, seq, secs, body, extra = '') => hub.req(`/api/voice-chunk?id=${id}&seq=${seq}&type=aac&secs=${secs}&source=phone-cmd${extra}`,
  { method: 'POST', headers: { 'X-Hub-Token': h.DEVICE_TOKEN, 'Content-Type': 'application/octet-stream' }, body });

test('each chunk is acknowledged with what the stream holds; a retry is not counted twice; a gap is refused', async () => {
  const id = crypto.randomUUID();
  let r = await chunk(id, 0, 1.0, frames(16));
  assert.equal(r.status, 200);
  assert.equal((await r.json()).held_s, 1.02);
  r = await chunk(id, 0, 1.0, frames(16));                    // the answer was lost and it came again
  assert.equal((await r.json()).held_s, 1.02);
  r = await chunk(id, 2, 3.0, frames(16));
  assert.equal(r.status, 409);
  assert.equal((await r.json()).next, 1);
  r = await chunk(id, 1, 2.0, frames(16));
  const j = await r.json();
  assert.equal(j.held_s, 2.05);
  assert.equal(j.damaged, false);
});

test('a capture holding a fraction of its recorded time is told it is damaged while it records', async () => {
  const id = crypto.randomUUID();
  await chunk(id, 0, 5.0, frames(8));
  const j = await (await chunk(id, 1, 10.0, frames(8))).json();
  assert.equal(j.damaged, true);
  assert.match(hub.output(), new RegExp(`\\[voice-chunk\\] ${id} DAMAGED`));
});

test('a stream the hub does not know, past its first chunk, is gone', async () => {
  assert.equal((await chunk(crypto.randomUUID(), 4, 5.0, frames(1))).status, 410);
});

test('a WAV stream is measured from its header, and sealed into a file whose lengths are true', () => {
  const { wavSeconds, sealWav } = require('../lib/chunkstream');
  const head = Buffer.alloc(44);
  head.write('RIFF', 0, 'latin1'); head.writeUInt32LE(0xFFFFFFFF, 4); head.write('WAVE', 8, 'latin1');
  head.write('fmt ', 12, 'latin1'); head.writeUInt32LE(16, 16); head.writeUInt16LE(1, 20); head.writeUInt16LE(1, 22);
  head.writeUInt32LE(16000, 24); head.writeUInt32LE(32000, 28); head.writeUInt16LE(2, 32); head.writeUInt16LE(16, 34);
  head.write('data', 36, 'latin1'); head.writeUInt32LE(0xFFFFFFFF, 40);
  const wav = Buffer.concat([head, Buffer.alloc(48000)]);
  assert.equal(wavSeconds([wav.subarray(0, 20), wav.subarray(20)]), 1.5);
  const sealed = sealWav(wav);
  assert.equal(sealed.readUInt32LE(40), 48000);
  assert.equal(sealed.readUInt32LE(4), sealed.length - 8);
});
