'use strict';
// lib/volume.js: turning muscle_volume()'s answer (data-layer 00156, where the counting rule lives) into
// the gauges. What can go wrong here is the arithmetic between the two: which day's bouts are about to
// drop, which target applies, and what "today" means.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { computeVolume } = require('../lib/volume');

const window = ['2026-10-26', '2026-10-27', '2026-10-28', '2026-10-29', '2026-10-30', '2026-10-31', '2026-11-01'];
const vol = {
  window,
  bouts: [
    { muscle: 'quads', day: '2026-10-26', sets: 6 },     // oldest day: drops tomorrow
    { muscle: 'quads', day: '2026-10-27', sets: 4 },     // second-oldest: drops the day after
    { muscle: 'quads', day: '2026-11-01', sets: 11 },    // today, already capped by the function
    { muscle: 'abs', day: '2026-10-31', sets: 3 },
  ],
  days: [
    { muscle: 'quads', day: '2026-11-01', raw: 13 },     // uncapped: the badge shows what was done
    { muscle: 'abs', day: '2026-10-31', raw: 3 },
  ],
  targets: { _default: 14, abs: 8 },
};
const byMuscle = (v) => Object.fromEntries(v.groups.flatMap((g) => g.muscles).map((m) => [m.muscle, m]));

test('totals sum every bout in the window, and the drop tiers are the two oldest days', () => {
  const q = byMuscle(computeVolume(vol, []))['quads'];
  assert.equal(q.sets, 21);
  assert.equal(q.drop_tomorrow, 6);
  assert.equal(q.drop_day_after, 4);
});

test('a muscle uses its own target when it has one, the default otherwise', () => {
  const m = byMuscle(computeVolume(vol, []));
  assert.equal(m.abs.target, 8);
  assert.equal(m.quads.target, 14);
  assert.equal(computeVolume(vol, []).target_default, 14);
});

test('today is the uncapped credit on the newest day, and recency reads today / yesterday / ready', () => {
  const m = byMuscle(computeVolume(vol, []));
  assert.equal(m.quads.today, 13);
  assert.equal(m.quads.recency, 'today');
  assert.equal(m.abs.recency, 'yesterday');
  assert.equal(m.hamstrings.recency, 'ready');
  assert.equal(m.hamstrings.sets, 0);
});

test('the fill bands never pass the target, so an overfilled bar does not over-stripe', () => {
  const q = byMuscle(computeVolume({ ...vol, bouts: [...vol.bouts, { muscle: 'quads', day: '2026-10-30', sets: 11 }] }, []))['quads'];
  assert.equal(q.fill, 1);
  assert.ok(q.stable_fill + q.drop_day_after_fill + q.drop_tomorrow_fill <= 1 + 1e-9);
});
