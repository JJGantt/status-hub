'use strict';
// lib/livestream.js: reading a recording streamed while it records, and deciding how it ended. A wrong
// frame read loses audio; a wrong verdict either starts an agent for nothing or lets a lost command go
// unreported.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { FrameReader, endOf, adtsSeconds, PauseClock, BrokenStreams } = require('../lib/livestream');

const frame = (type, data = Buffer.alloc(0)) => {
  const h = Buffer.alloc(5);
  h.write(type, 0, 'latin1');
  h.writeUInt32BE(data.length, 1);
  return Buffer.concat([h, data]);
};

test('frames are read whole however the network splits them', () => {
  const body = Buffer.concat([frame('A', Buffer.from('abc')), frame('P'), frame('R'), frame('A', Buffer.from('de')), frame('E')]);
  const r = new FrameReader();
  const got = [];
  for (let i = 0; i < body.length; i += 3) got.push(...r.push(body.subarray(i, i + 3)));
  assert.deepEqual(got.map((f) => [f.type, f.data.toString()]), [['A', 'abc'], ['P', ''], ['R', ''], ['A', 'de'], ['E', '']]);
});

test('a malformed frame stops reading rather than misreading what follows', () => {
  const r = new FrameReader();
  assert.deepEqual(r.push(Buffer.from('Zxxxxx')), []);
  assert.ok(r.bad);
  assert.deepEqual(r.push(frame('E')), []);
});

test('a recording that says how it ended is not a failure', () => {
  assert.equal(endOf({ complete: true, last: 'E' }), 'ended');
  assert.equal(endOf({ complete: true, last: 'C' }), 'cancelled');
  // The E arrived and then the connection dropped before the body's terminator: still ended.
  assert.equal(endOf({ complete: false, last: 'E', gapMs: 10 }), 'ended');
});

test('a clean close with no end frame is reported', () => {
  assert.equal(endOf({ complete: true, last: null, paused: false, gapMs: 5 }), 'unmarked');
});

test('a drop while audio was flowing is a lost recording', () => {
  assert.equal(endOf({ complete: false, last: null, paused: false, gapMs: 200 }), 'lost');
  assert.equal(endOf({ complete: false, last: 'R', paused: false, gapMs: 900 }), 'lost');
});

test('a drop after the bytes had stopped, or while paused, is a stalled network', () => {
  assert.equal(endOf({ complete: false, last: null, paused: false, gapMs: 45000 }), 'stalled');
  assert.equal(endOf({ complete: false, last: 'P', paused: true, gapMs: 100 }), 'stalled');
  assert.equal(endOf({ complete: false, last: null, paused: false, gapMs: undefined }), 'stalled');
});

test('a stream the hub closed at its own request limit is not a lost recording', () => {
  assert.equal(endOf({ complete: false, last: null, paused: false, gapMs: 82, limited: true }), 'limited');
  assert.equal(endOf({ complete: false, last: 'E', gapMs: 10, limited: true }), 'ended');
});

// One ADTS frame header (7 bytes, no CRC) for `len` bytes in all: 1024 samples at `rateIndex`.
const adts = (len, rateIndex = 8) => {
  const f = Buffer.alloc(len);
  f[0] = 0xFF; f[1] = 0xF1; f[2] = 0x40 | (rateIndex << 2);
  f[3] = (len >> 11) & 0x03; f[4] = (len >> 3) & 0xFF; f[5] = ((len & 0x07) << 5) | 0x1F; f[6] = 0xFC;
  return f;
};

test('streamed audio is measured from its frame headers, however it was chunked', () => {
  const frames = Array.from({ length: 125 }, () => adts(40));   // 125 x 1024 samples at 16 kHz = 8s
  const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} is not ${b}`);
  near(adtsSeconds(frames), 8);
  near(adtsSeconds(Buffer.concat(frames)), 8);
  near(adtsSeconds(adts(40, 3)), 1024 / 48000);
});

test('bytes that are not ADTS measure as unknown, never as a short recording', () => {
  assert.equal(adtsSeconds(Buffer.from('not audio at all')), null);
  assert.equal(adtsSeconds(Buffer.concat([adts(40), Buffer.from('garbage!')])), null);
  assert.equal(adtsSeconds([]), null);
});

test('the pause clock times every P to its R, counts an open pause up to now, and ignores repeats', () => {
  let t = 0;
  const c = new PauseClock(() => t);
  c.frame('A'); t = 10_000;
  c.frame('P'); t = 12_000;
  c.frame('P'); t = 280_000;          // a second P while paused does not restart the pause
  c.frame('R'); t = 290_000;
  c.frame('R');                       // an R with no pause open adds nothing
  assert.equal(c.seconds(), 270);
  c.frame('P'); t = 295_000;
  assert.equal(c.seconds(), 275);     // still paused: counted up to now
});

test('a broken stream is recovered only when no command names it within the grace', async () => {
  const b = new BrokenStreams({ graceMs: 20, keepMs: 1000 });
  const wait = () => new Promise((r) => setTimeout(r, 60));
  let recovered = 0, skipped = 0;
  b.broke('sent', { recover: async () => { recovered++; return 'r1'; }, skipped: () => { skipped++; } });
  b.sent('sent');
  b.broke('silent', { recover: async () => { recovered++; return 'r2'; }, skipped: () => { skipped++; } });
  assert.ok(b.pending('silent') && !b.pending('other'));
  await wait();
  assert.ok(!b.pending('silent'));
  assert.equal(recovered, 1);
  assert.equal(skipped, 1);
  // The clip arriving after its stream was recovered is told which request it supersedes.
  assert.equal(b.sent('silent'), 'r2');
  assert.equal(b.sent('sent'), null);
});

test('a recovery that fails is logged and remembers nothing', async () => {
  const b = new BrokenStreams({ graceMs: 5, keepMs: 1000 });
  b.broke('x', { recover: async () => { throw new Error('boom'); } });
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(b.sent('x'), null);
});
