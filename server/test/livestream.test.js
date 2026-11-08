'use strict';
// lib/livestream.js: reading a recording streamed while it records, and deciding how it ended. A wrong
// frame read loses audio; a wrong verdict either starts an agent for nothing or lets a lost command go
// unreported.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { FrameReader, endOf } = require('../lib/livestream');

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
