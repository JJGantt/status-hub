'use strict';
// lib/clientresend.js: a batch the hub stored, sent again because its answer was lost, is not stored or
// reported twice; a batch the hub failed to store, and lines alike within one batch, are kept.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createResendGuard } = require('../lib/clientresend');

const fail = { src: 'watch', ev: 'request-failed', t: '2026-11-28T04:10:39Z', build: '238', level: 'error', path: '/api/voice-messages' };
const link = (reachable) => ({ src: 'watch', ev: 'phone-link', t: '2026-11-28T04:10:40Z', build: '238', reachable });

test('lines of a stored batch that come again are dropped, new lines with them kept', () => {
  const g = createResendGuard();
  assert.deepEqual(g.fresh([fail]), { kept: [fail], dropped: 0 });
  g.remember([fail]);
  const again = g.fresh([{ ...fail }, link(true), link(false)]);
  assert.equal(again.dropped, 1);
  assert.deepEqual(again.kept, [link(true), link(false)]);
});

test('field order does not make a resent line look new', () => {
  const g = createResendGuard();
  g.remember([fail]);
  const reordered = Object.fromEntries(Object.entries(fail).reverse());
  assert.equal(g.fresh([reordered]).dropped, 1);
});

test('a batch the hub did not store comes through whole when it is sent again', () => {
  const g = createResendGuard();
  g.fresh([fail]);          // the write failed, so it was never remembered
  assert.equal(g.fresh([fail]).dropped, 0);
});

test('identical lines within one batch are each kept', () => {
  const g = createResendGuard();
  assert.equal(g.fresh([fail, { ...fail }]).kept.length, 2);
});

test('a line is forgotten after the keep window and past the cap', () => {
  const g = createResendGuard({ keepMs: 1000, cap: 2 });
  g.remember([fail], 0);
  assert.equal(g.fresh([fail], 2000).dropped, 0);
  g.remember([fail, link(true), link(false)], 3000);
  assert.equal(g.fresh([fail], 3000).dropped, 0);
  assert.equal(g.fresh([link(false)], 3000).dropped, 1);
});
