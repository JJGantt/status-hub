'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { stateOf, eventsFor } = require('../lib/door');

test('SwitchBot spellings normalise', () => {
  assert.deepEqual(stateOf({ lockState: 'LOCKED', doorState: 'OPENED' }), { lock: 'locked', door: 'opened' });
  assert.deepEqual(stateOf({ lockState: 'unlocked', doorState: 'close' }), { lock: 'unlocked', door: 'closed' });
  assert.deepEqual(stateOf({ lockState: 'JAMMED' }), { lock: 'jammed', door: null });
  assert.deepEqual(stateOf({}), { lock: null, door: null });
});

test('a report produces one row per value that changed', () => {
  const prev = { lock_state: 'locked', door_state: 'closed' };
  assert.deepEqual(eventsFor(prev, { lock: 'unlocked', door: 'closed' }, 'webhook', null).map((r) => r.event), ['unlocked']);
  assert.deepEqual(eventsFor(prev, { lock: 'unlocked', door: 'opened' }, 'webhook', null).map((r) => [r.event, r.lock_state, r.door_state]),
    [['unlocked', 'unlocked', 'closed'], ['opened', 'unlocked', 'opened']]);
});

test('a repeated report changes nothing', () => {
  assert.equal(eventsFor({ lock_state: 'locked', door_state: 'closed' }, { lock: 'locked', door: 'closed' }, 'webhook').length, 0);
});

test('an omitted field keeps its previous value', () => {
  const [r] = eventsFor({ lock_state: 'unlocked', door_state: 'opened' }, { lock: null, door: 'closed' }, 'webhook', null);
  assert.deepEqual([r.event, r.lock_state, r.door_state], ['closed', 'unlocked', 'closed']);
});

test('the first report ever records what it carries', () => {
  assert.deepEqual(eventsFor(null, { lock: 'locked', door: 'closed' }, 'backstop', null).map((r) => r.event), ['locked', 'closed']);
});
