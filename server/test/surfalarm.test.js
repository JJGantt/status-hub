'use strict';
// lib/surfalarm.js's `item` output: what the hub may still do to an alarm item once its moment has come.
// A wrong answer re-rings a snoozed alarm at once, or deletes it before it rings again.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createSurfAlarms } = require('../lib/surfalarm');

// One engaged alarm for `day`, holding item `it1`, with no forecast at all: the decision is then
// "no alarm", which on an untouched item means delete it.
function harness({ itemDue, stateAt, now }) {
  const writes = [];
  const sb = async (q) => {
    if (q.startsWith('surf_alarms')) {
      return [{ day: '2026-11-05', engaged: true, outputs: ['item'], rules: [{ hours: [], wake: '07:00' }],
                state: { item: { id: 'it1', ...(stateAt ? { at: stateAt } : {}) } }, decided: null }];
    }
    if (q.startsWith('surf_snapshots')) return [];
    if (q.startsWith('list_items')) return [{ id: 'it1', due: itemDue, deleted: false, completed_at: null }];
    return [];
  };
  const sbWrite = async (path, method, body) => { writes.push({ path, method, body }); };
  const alarms = createSurfAlarms({ sb, sbWrite, uuid: () => 'new', nowLocal: () => now,
                                    today: () => '2026-11-05', tz: () => 'America/New_York', log: () => {} });
  return { alarms, itemWrites: () => writes.filter((w) => w.path.startsWith('list_items')) };
}

test('an alarm not yet due follows the decision', async () => {
  const h = harness({ itemDue: '2026-11-05T07:00', stateAt: '2026-11-05T07:00', now: '2026-11-05T05:00:00' });
  await h.alarms.tick('test');
  assert.deepEqual(h.itemWrites().map((w) => w.body.deleted), [true]);
});

test('an alarm that is ringing is left alone', async () => {
  const h = harness({ itemDue: '2026-11-05T07:00', stateAt: '2026-11-05T07:00', now: '2026-11-05T07:02:00' });
  await h.alarms.tick('test');
  assert.deepEqual(h.itemWrites(), []);
});

test('a snoozed alarm is left alone, though its due is in the future again', async () => {
  const h = harness({ itemDue: '2026-11-05T07:11', stateAt: '2026-11-05T07:00', now: '2026-11-05T07:04:00' });
  await h.alarms.tick('test');
  assert.deepEqual(h.itemWrites(), []);
});
