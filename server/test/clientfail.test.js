'use strict';
// lib/clientfail.js: which watch log lines reach the ops responder. A false negative is a failure on the
// wrist nobody hears about; a false positive is a duplicate incident for one the hub already reported.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { watchFailure } = require('../lib/clientfail');

const w = (ev, fields = {}) => ({ src: 'watch', ev, t: '2026-11-27T23:00:00Z', build: '412', ...fields });

test('a line the watch marks as a failure is reported, whatever it is called', () => {
  const r = watchFailure(w('speak-stalled', { level: 'error', engine: false, player: false }));
  assert.equal(r.message, 'watch speak-stalled');
  assert.deepEqual(r.context.fields, { engine: false, player: false });
  assert.equal(watchFailure(w('set-report-failed', { level: 'error', page: 'watchset', reps: '8', error: 'HTTP 404' })).message,
    'watch set-report-failed (watchset): HTTP 404');
});

test('a line named as a failure is reported without being marked', () => {
  for (const ev of ['inbox-failed', 'alarm-feed-failed', 'live-broken', 'door-read-failed']) {
    assert.ok(watchFailure(w(ev, { error: 'URLError(-1001)' })), ev);
  }
});

test('ordinary lines are not failures', () => {
  for (const ev of ['record-start', 'speak-end', 'stream-error', 'heard-nothing', 'capture-upload-retry', 'failed-over']) {
    assert.equal(watchFailure(w(ev, { error: 'x' })), null, ev);
  }
});

test("the watch's error line is reported with its message", () => {
  assert.equal(watchFailure(w('error', { msg: 'workout hold: HealthKit unavailable', page: 'workout-hold' })).message,
    'watch: workout hold: HealthKit unavailable');
});

test('a failed request is one incident per route, with the whole path in context', () => {
  const r = watchFailure(w('request-failed', { level: 'error', method: 'POST', path: '/api/todos/complete?x=1', error: 'status(404)' }));
  assert.equal(r.message, 'watch request failed: POST /api/todos/complete: status(404)');
  assert.equal(r.context.path, '/api/todos/complete?x=1');
});

test('a failure already reported elsewhere is not reported again', () => {
  // The transport's request-failed line covers the call site's own line for the same error.
  assert.equal(watchFailure(w('send-failed', { error: 'status(404)', also: 'request-failed' })), null);
  // The hub reported its own 5xx when it answered it, as the watch and as Watchset spell it.
  assert.equal(watchFailure(w('request-failed', { level: 'error', path: '/api/door', error: 'status(502)' })), null);
  assert.equal(watchFailure(w('set-report-failed', { level: 'error', error: 'HTTP 503' })), null);
  // A 4xx is the hub refusing the watch, which only the watch sees.
  assert.ok(watchFailure(w('request-failed', { level: 'error', path: '/api/door', error: 'status(400)' })));
});

test('the established failures keep their wording', () => {
  assert.equal(watchFailure(w('send-failed', { view: 'session', error: 'timed out' })).message, 'watch follow-up send-failed: timed out');
  assert.equal(watchFailure(w('command-failed', { id: 'r1', error: 'worker gone' })).message, 'watch command command-failed: worker gone');
  assert.equal(watchFailure(w('door-set-failed', { via: 'control', level: 'error', error: 'noToken' })).message,
    'watch door control could not set the lock: noToken');
});

test('only the watch is decided here', () => {
  assert.equal(watchFailure({ src: 'phone', ev: 'voice-send-fail', level: 'error' }), null);
  assert.equal(watchFailure(null), null);
});
