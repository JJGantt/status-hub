'use strict';
// An arrival unlocks only after he really left (lib/door.js leftAndCameBack): a phone restarted or
// Bluetooth toggled at home must never open the door.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { leftAndCameBack } = require('../lib/door');

const min = 60e3;
test('door opened, then his device went quiet, then it came back: an arrival', () => {
  assert.equal(leftAndCameBack(30 * min, { opens: [0], leaves: [2 * min] }).ok, true);
});
test('door opened, then the elevator down, then back: an arrival', () => {
  assert.equal(leftAndCameBack(30 * min, { opens: [0], downs: [1 * min] }).ok, true);
});
test('a device going quiet and coming back with no door opening is not', () => {
  assert.equal(leftAndCameBack(30 * min, { opens: [], leaves: [2 * min] }).ok, false);
});
test('the door opened (a package) but nothing shows he left: not an arrival', () => {
  assert.equal(leftAndCameBack(30 * min, { opens: [10 * min] }).ok, false);
});
test('a restart at home long after he came in is not an arrival', () => {
  // Left at 0/2, came back in through the door at 20, phone restarts at 60.
  assert.equal(leftAndCameBack(60 * min, { opens: [0, 20 * min], leaves: [2 * min] }).ok, false);
});
test('evidence before the door opened does not count', () => {
  assert.equal(leftAndCameBack(30 * min, { opens: [10 * min], leaves: [5 * min] }).ok, false);
});
test('events after the arrival are ignored', () => {
  assert.equal(leftAndCameBack(30 * min, { opens: [0, 31 * min], leaves: [2 * min] }).ok, true);
});
