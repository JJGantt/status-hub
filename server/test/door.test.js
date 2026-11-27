'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { stateOf } = require('../lib/door');

test('SwitchBot spellings normalise', () => {
  assert.deepEqual(stateOf({ lockState: 'LOCKED', doorState: 'OPENED' }), { lock: 'locked', door: 'opened' });
  assert.deepEqual(stateOf({ lockState: 'unlocked', doorState: 'close' }), { lock: 'unlocked', door: 'closed' });
  assert.deepEqual(stateOf({ lockState: 'JAMMED' }), { lock: 'jammed', door: null });
  assert.deepEqual(stateOf({}), { lock: null, door: null });
});
