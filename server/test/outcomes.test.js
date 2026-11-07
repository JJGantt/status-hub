'use strict';
// lib/outcomes.js: a watch recording that started must end. The cost of a wrong answer is an agent
// started for nothing (false positive) or a lost command nobody hears about (false negative).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { vanishedRecordings, emptyThread } = require('../lib/outcomes');

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

// emptyThread: an opened session whose thread holds nothing although it was told something.
const NOW = Date.parse('2026-11-07T18:40:00Z');
const row = (o) => ({ started: '2026-11-07T18:28:48Z', ...o });

test('a session that was dispatched with a prompt and shows nothing is reported', () => {
  // 2026-11-07: a repo with an underscore pointed the host at a transcript that did not exist.
  assert.equal(emptyThread(row({ launch_prompt: 'How often have the cats...' }), [], NOW), true);
  assert.equal(emptyThread(row({ last_reply: 'Short answer' }), [], NOW), true);
  assert.equal(emptyThread(row({ working: true }), [], NOW), true);
});

test('a session with anything in its thread is not reported', () => {
  assert.equal(emptyThread(row({ launch_prompt: 'x' }), [{ kind: 'prompt', text: 'x' }], NOW), false);
});

test('a session never told anything, or only just started, is not reported', () => {
  assert.equal(emptyThread(row({}), [], NOW), false);   // a terminal opened by hand, idle
  assert.equal(emptyThread({ started: '2026-11-07T18:39:30Z', launch_prompt: 'x' }, [], NOW), false);
});
