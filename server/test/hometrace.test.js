'use strict';
// What a near-home trace chunk must look like to be stored (lib/hometrace.js).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { chunkRow } = require('../lib/hometrace');

const ok = { started_at: '2026-11-28T06:00:00Z', ended_at: '2026-11-28T06:00:30Z',
  alt: [[0.5, 1.23, 101.2345]], steps: [[1, 12, 1.8, null]],
  fixes: [[2, 30.326, -81.576, 5, 12.3, 3, 1.4, 90]], activity: [[0, 'walking', 2]], modes: [[0, 'best']] };

test('a well-formed chunk becomes a row with every stream', () => {
  const { row, error } = chunkRow(ok);
  assert.equal(error, undefined);
  assert.equal(row.device, 'phone');
  assert.deepEqual(row.fixes, ok.fixes);
  assert.equal(row.started_at, '2026-11-28T06:00:00.000Z');
});
test('missing streams are stored empty', () => {
  assert.deepEqual(chunkRow({ started_at: ok.started_at, ended_at: ok.ended_at }).row.alt, []);
});
test('bad times are refused', () => {
  assert.match(chunkRow({ ...ok, started_at: 'nope' }).error, /timestamps/);
  assert.match(chunkRow({ ...ok, ended_at: '2026-11-28T05:00:00Z' }).error, /before/);
});
test('a sample of the wrong width is refused', () => {
  assert.match(chunkRow({ ...ok, alt: [[0, 1]] }).error, /alt/);
});
test('an unknown activity or mode is refused', () => {
  assert.match(chunkRow({ ...ok, activity: [[0, 'flying', 1]] }).error, /activity/);
  assert.match(chunkRow({ ...ok, modes: [[0, 'max']] }).error, /modes/);
});
