const test = require('node:test');
const assert = require('node:assert');
const { stallMessage } = require('../lib/streamstall');

const boot = Date.parse('2026-11-28T18:16:45Z');

test('a stall at the hub start is counted as a restart', () => {
  assert.match(stallMessage({ src: 'phone', t: '2026-11-28T18:16:48Z' }, boot), /during a hub restart/);
  // the old process stopping acking just before the new one starts
  assert.match(stallMessage({ src: 'phone', t: '2026-11-28T18:16:40Z' }, boot), /during a hub restart/);
});

test('a stall away from a restart keeps the plain fingerprint', () => {
  const m = stallMessage({ src: 'phone', t: '2026-11-28T18:30:00Z' }, boot);
  assert.strictEqual(m, 'phone recording: the hub stopped acknowledging its stream; recording carried on');
});

test('a stall with no time of its own is judged by when it arrived', () => {
  assert.match(stallMessage({}, boot, boot + 5_000), /^client recording: .*during a hub restart/);
  assert.doesNotMatch(stallMessage({}, boot, boot + 600_000), /restart/);
});
