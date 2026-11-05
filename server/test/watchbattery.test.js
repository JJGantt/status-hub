'use strict';
// lib/watchbattery.js: the watch's battery reading, stored only when it changes, and the bar it becomes.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createWatchBattery, buildWatchBattery } = require('../lib/watchbattery');

test('ingest writes a new whole percent or a charging flip, and nothing else', async () => {
  const writes = [];
  const wb = createWatchBattery({ sbUpsert: async (t, c, row) => { writes.push(row); } });
  await wb.ingest({ level: 0.8, charging: false });
  await wb.ingest({ level: 0.801, charging: false });   // same whole percent
  await wb.ingest({ level: 0.8, charging: true });      // plugged in
  await wb.ingest({ level: 0.79, charging: true });
  assert.deepEqual(writes.map((r) => r.data), [
    { level: 0.8, charging: false }, { level: 0.8, charging: true }, { level: 0.79, charging: true }]);
  assert.ok(writes.every((r) => r.device === 'watch'));
});

test('ingest ignores a reading with monitoring off or no level', async () => {
  const writes = [];
  const wb = createWatchBattery({ sbUpsert: async (t, c, row) => { writes.push(row); } });
  await wb.ingest({ level: -1, charging: false });
  await wb.ingest({ charging: true });
  await wb.ingest(null);
  assert.equal(writes.length, 0);
});

test('a failed write is retried by the next identical reading', async () => {
  let fail = true; const writes = [];
  const wb = createWatchBattery({ sbUpsert: async (t, c, row) => { if (fail) throw new Error('down'); writes.push(row); } });
  const err = console.error; console.error = () => {};
  try { await wb.ingest({ level: 0.5 }); } finally { console.error = err; }
  fail = false;
  await wb.ingest({ level: 0.5 });
  assert.equal(writes.length, 1);
});

test('the bar runs red at empty to green at full', () => {
  const row = (level) => ({ device: 'watch', data: { level, charging: false }, updated_at: '2026-11-05T12:00:00Z' });
  assert.equal(buildWatchBattery(row(0)).color, 'hsl(0, 80%, 45%)');
  assert.equal(buildWatchBattery(row(1)).color, 'hsl(120, 80%, 45%)');
  assert.deepEqual(buildWatchBattery(row(0.42)), { pct: 42, charging: false, color: 'hsl(50, 80%, 45%)', at: '2026-11-05T12:00:00Z' });
  assert.equal(buildWatchBattery(null), null);
  assert.equal(buildWatchBattery({ device: 'watch', data: null }), null);
});
