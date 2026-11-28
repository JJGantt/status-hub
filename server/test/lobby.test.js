'use strict';
// The lobby-door race (lib/lobby.js): a report counts once per path, only for a known code, only while
// the code is fresh; the winner is the first arrival.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { judgeArrival, summarize, message, VALID_MS } = require('../lib/lobby');

const t0 = Date.parse('2026-11-28T03:00:00Z');
const race = { id: 'r1', created_at: new Date(t0).toISOString(), reason: 'test' };

test('a fresh report of a path counts', () => {
  assert.equal(judgeArrival(race, 'sms', [], t0 + 4000).status, 200);
});
test('each path counts once', () => {
  assert.equal(judgeArrival(race, 'sms', ['sms'], t0 + 5000).status, 409);
  assert.equal(judgeArrival(race, 'email', ['sms'], t0 + 5000).status, 200);
});
test('an unknown code or path does not count', () => {
  assert.equal(judgeArrival(null, 'sms', [], t0).status, 404);
  assert.equal(judgeArrival(race, 'carrier-pigeon', [], t0).status, 404);
});
test('a code older than its window does not count', () => {
  assert.equal(judgeArrival(race, 'sms', [], t0 + VALID_MS + 1).status, 410);
  assert.equal(judgeArrival(race, 'sms', [], t0 + VALID_MS - 1).status, 200);
});
test('the winner is the first arrival, with each path latency and send result', () => {
  const s = summarize(race, [
    { kind: 'send', path: 'sms', ok: true }, { kind: 'send', path: 'email', ok: true, skipped: true },
    { kind: 'send', path: 'imessage', ok: false, error: 'Mac asleep' },
    { kind: 'arrive', path: 'sms', at: new Date(t0 + 4200).toISOString() },
  ]);
  assert.equal(s.winner, 'sms');
  assert.equal(s.paths.sms.arrived_s, 4.2);
  assert.equal(s.paths.email.skipped, true);
  assert.equal(s.paths.imessage.error, 'Mac asleep');
  assert.equal(summarize(race, []).winner, null);
});
test('the message carries the codeword, the code and the path', () => {
  assert.equal(message('north', 'abc123XYZ', 'imessage'), 'open-lobby-7731 north abc123XYZ imessage');
  assert.equal(message(undefined, 'abc123XYZ', 'email'), 'open-lobby-7731 main abc123XYZ email');
});
