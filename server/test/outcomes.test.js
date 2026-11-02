'use strict';
// lib/outcomes.js: a watch recording that started must end. The cost of a wrong answer is an agent
// started for nothing (false positive) or a lost command nobody hears about (false negative).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { vanishedRecordings } = require('../lib/outcomes');

const ev = (e, at) => ({ ev: e, at: `2026-11-02T06:${at}Z` });

test('a recording that ends normally is not reported', () => {
  assert.deepEqual(vanishedRecordings([
    ev('record-start', '21:00'), ev('mic-open', '21:01'), ev('record-stop', '21:09'),
    ev('record-start', '22:00'), ev('mic-open', '22:01'), ev('record-cancel', '22:03'),
    ev('record-start', '23:00'), ev('mic-failed', '23:01'),
  ]), []);
});

test('a recording with an open mic and no end before the next start is reported', () => {
  // 2026-11-02: the app process went mid-command and the next press started fresh.
  assert.deepEqual(vanishedRecordings([
    ev('record-start', '21:53'), ev('mic-open', '21:54'),
    ev('record-start', '22:18'), ev('mic-open', '22:19'), ev('record-stop', '22:31'),
  ]), [{ at: '2026-11-02T06:21:53Z', next: '2026-11-02T06:22:18Z' }]);
});

test('a start stopped before its mic opened is not reported', () => {
  assert.deepEqual(vanishedRecordings([ev('record-start', '21:00'), ev('record-start', '21:02')]), []);
});

test('the newest start, still running, is not reported', () => {
  assert.deepEqual(vanishedRecordings([ev('record-start', '21:00'), ev('mic-open', '21:01')]), []);
});

test('a batch delivered twice is one recording, not a vanished one', () => {
  assert.deepEqual(vanishedRecordings([
    ev('record-start', '21:00'), ev('mic-open', '21:01'),
    ev('record-start', '21:00'), ev('mic-open', '21:01'), ev('record-stop', '21:05'),
  ]), []);
});
