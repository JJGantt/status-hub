'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { stagesOf, judge, makeTracker, RECENT_N } = require('../lib/latency');

const DAY = 86400000;
const NOW = Date.parse('2026-11-22T20:00:00Z');

test('stagesOf: hub time keyed by how the audio came, pickup, and time to first words', () => {
  assert.deepStrictEqual(stagesOf({
    hub_ms: 1400, audio_via: 'live', hub_received: '2026-11-22T13:57:36.000Z', hub_enqueued: '2026-11-22T13:57:37.400Z',
    worker_start: '2026-11-22T13:57:38.000Z', first_output: '2026-11-22T13:57:42.000Z',
  }), { 'hub:live': 1400, pickup: 600, first_output: 6000 });
  assert.deepStrictEqual(stagesOf({ hub_ms: 900 }), { 'hub:upload': 900 });
  assert.deepStrictEqual(stagesOf(null), {});
  // A stamp missing or out of order is no sample, never a negative one.
  assert.deepStrictEqual(stagesOf({ hub_enqueued: '2026-11-22T13:57:37Z', worker_start: '2026-11-22T13:57:30Z' }), {});
});

const history = (n, value, ageDays = 3) => Array.from({ length: n }, (_, i) => ({ at: NOW - ageDays * DAY + i * 60000, ms: value }));

test('judge: several times slower than the fortnight before is slow', () => {
  const v = judge([...history(20, 3500), ...history(RECENT_N, 14000, 0)], NOW);
  assert.strictEqual(v.slow, true);
  assert.strictEqual(v.baseline, 3500);
  assert.strictEqual(v.recent, 14000);
});

test('judge: one slow command among normal ones is not a regression', () => {
  const recent = [...history(RECENT_N - 1, 3500, 0), { at: NOW, ms: 30000 }];
  assert.strictEqual(judge([...history(20, 3500), ...recent], NOW).slow, false);
});

test('judge: doubling a stage that takes milliseconds is not worth an incident', () => {
  assert.strictEqual(judge([...history(20, 200), ...history(RECENT_N, 600, 0)], NOW).slow, false);
});

test('judge: too little history, or only history from today, judges nothing', () => {
  assert.strictEqual(judge([...history(5, 3500), ...history(RECENT_N, 14000, 0)], NOW).slow, false);
  assert.strictEqual(judge([...history(20, 3500, 0.2), ...history(RECENT_N, 14000, 0)], NOW).slow, false);
  assert.strictEqual(judge([...history(20, 3500, 30), ...history(RECENT_N, 14000, 0)], NOW).slow, false);
});

test('tracker: reports a regression once, and again only after it recovered', () => {
  const said = [];
  let clock = NOW;
  const t = makeTracker({ report: (m) => said.push(m), now: () => clock });
  t.seed(Array.from({ length: 20 }, (_, i) => ({ id: 'old' + i, created_at: new Date(NOW - 3 * DAY + i * 60000).toISOString(), timing: { hub_ms: 3500 } })));
  for (let i = 0; i < 10; i++) t.sample('hub:upload', 14000);
  assert.strictEqual(said.length, 1);
  assert.match(said[0], /hub:upload median 14000ms .* against 3500ms/);
  for (let i = 0; i < RECENT_N; i++) t.sample('hub:upload', 3500);
  for (let i = 0; i < RECENT_N; i++) t.sample('hub:upload', 14000);
  assert.strictEqual(said.length, 2);
});

test('tracker: a request is counted once its run has started answering, and only once', () => {
  const t = makeTracker({ report: () => {}, now: () => NOW });
  const row = { id: 'r1', timing: { hub_ms: 1000, hub_received: '2026-11-22T19:00:00Z', first_output: '2026-11-22T19:00:05Z' } };
  t.request({ id: 'r1', timing: { hub_ms: 1000 } });   // enqueued, not yet answered
  t.request(row);
  t.request(row);
  assert.strictEqual(t._series.get('hub:upload').length, 1);
  assert.strictEqual(t._series.get('first_output').length, 1);
});
