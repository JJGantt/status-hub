'use strict';
// lib/clientflood.js: a device logging in a loop is reported once and its excess dropped, while a busy
// but normal minute is kept whole.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createFloodGuard } = require('../lib/clientflood');

const line = (ev, t = '2026-11-28T02:35:33Z', src = 'phone') => ({ src, ev, t, build: '235' });

function guard(limit = 5) {
  const reports = [];
  return { admit: createFloodGuard({ limit, report: (m, src, c) => reports.push({ m, src, c }) }), reports };
}

test('a kind past its limit in one minute is reported once and the rest dropped', () => {
  const { admit, reports } = guard();
  const kept = Array.from({ length: 50 }, () => admit(line('watch-link'))).filter(Boolean).length;
  assert.equal(kept, 5);
  assert.equal(reports.length, 1);
  assert.equal(reports[0].src, 'phone');
  assert.match(reports[0].m, /phone is flooding the hub: more than 5 'watch-link'/);
});

test('the limit is per device, per event and per minute of the device clock', () => {
  const { admit, reports } = guard();
  for (let i = 0; i < 5; i++) {
    assert.ok(admit(line('watch-link')));
    assert.ok(admit(line('scroll')));
    assert.ok(admit(line('watch-link', undefined, 'watch')));
    assert.ok(admit(line('watch-link', '2026-11-28T02:36:01Z')));
  }
  assert.equal(reports.length, 0);
});

test('a line with no time counts against the hub clock', () => {
  const { admit, reports } = guard(2);
  const now = Date.parse('2026-11-28T02:35:00Z');
  assert.ok(admit({ src: 'web', ev: 'x' }, now));
  assert.ok(admit({ src: 'web', ev: 'x' }, now));
  assert.equal(admit({ src: 'web', ev: 'x' }, now), false);
  assert.equal(reports.length, 1);
});

test('the default limit keeps the busiest minute client_log has seen', () => {
  const { admit, reports } = { admit: createFloodGuard({ report: () => assert.fail('reported') }), reports: [] };
  for (let i = 0; i < 47; i++) assert.ok(admit(line('session-shown', undefined, 'watch')));
  assert.equal(reports.length, 0);
});
