'use strict';
// lib/nutritionlog.js's goalForDay: which calorie goal a day is held to. Every nutrition surface (the
// rings' history view, the calendar colours, the score) asks it, so a wrong answer recolours days.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildGoalResolver } = require('../lib/nutritionlog');

const today = '2026-11-12';
// A continuous tracked run, so every day below sits in the active cluster.
const rows = ['2026-11-08', '2026-11-09', '2026-11-10', '2026-11-11', '2026-11-12']
  .map((d) => ({ occurred_at: d + 'T12:00:00', calories: 2800 }));

test('a stored computed target carries forward to a later day with no row of its own', () => {
  const { goalForDay } = buildGoalResolver({ rows, today, fallbackMaint: 2500,
    targets: [{ date: '2026-11-09', calories: 3240 }] });
  assert.equal(goalForDay('2026-11-10'), 3240);
});

test('a manual override is the goal for its own day', () => {
  const { goalForDay } = buildGoalResolver({ rows, today, fallbackMaint: 2500, targets: [
    { date: '2026-11-11', calories: 2520 }, { date: '2026-11-12', calories: 3000, override: true }] });
  assert.equal(goalForDay('2026-11-12'), 3000);
});

test('an override never carries forward: the next day falls back to the last computed target', () => {
  const { goalForDay } = buildGoalResolver({ rows, today, fallbackMaint: 2500, targets: [
    { date: '2026-11-09', calories: 3240 }, { date: '2026-11-10', calories: 3000, override: true }] });
  assert.equal(goalForDay('2026-11-10'), 3000);
  assert.equal(goalForDay('2026-11-11'), 3240);
});
