'use strict';
// PIN unlock by text or email (lib/doorpin.js): only a message that is the PIN and nothing else counts,
// each PIN opens its own door, and repeated wrong PINs lock the feature.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fromText, fromEmail, keyed, doorFor, lockedOut, LOCK_WINDOW_MS } = require('../lib/doorpin');

test('a text counts only when it is the digits alone', () => {
  assert.equal(fromText('5555'), '5555');
  assert.equal(fromText('  123456 \n'), '123456');
  assert.equal(fromText('code 5555'), null);
  assert.equal(fromText('5555!'), null);
  assert.equal(fromText('55 55'), null);
  assert.equal(fromText('123'), null);
  assert.equal(fromText(''), null);
});

test('an email counts when subject and body are each empty or the same digits', () => {
  assert.equal(fromEmail('5555', ''), '5555');
  assert.equal(fromEmail('', '5555\n\nSent from my iPhone'), '5555');
  assert.equal(fromEmail('5555', '5555\r\n'), '5555');
  assert.equal(fromEmail('5555', 'see you soon'), null);
  assert.equal(fromEmail('Re: 5555', ''), null);
  assert.equal(fromEmail('5555', '6666'), null);
  assert.equal(fromEmail('', ''), null);
});

test('each PIN opens its own door, and nothing opens without the key', () => {
  const pepper = 'pepper';
  const hashes = { lobby: keyed(pepper, '1111'), front: keyed(pepper, '2222') };
  assert.equal(doorFor('1111', hashes, pepper), 'lobby');
  assert.equal(doorFor('2222', hashes, pepper), 'front');
  assert.equal(doorFor('3333', hashes, pepper), null);
  assert.equal(doorFor('1111', hashes, 'other'), null);
  assert.equal(doorFor('1111', hashes, ''), null);
  assert.equal(doorFor('1111', null, pepper), null);
});

test('three wrong PINs within an hour lock it', () => {
  const now = Date.parse('2026-11-28T12:00:00Z');
  assert.equal(lockedOut([now - 1000, now - 2000], now), false);
  assert.equal(lockedOut([now - 1000, now - 2000, now], now), true);
  assert.equal(lockedOut([now - LOCK_WINDOW_MS - 1, now - 2000, now], now), false);
});
