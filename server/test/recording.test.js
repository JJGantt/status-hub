'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { startAfter } = require('../lib/recording');

const timed = (s) => s.split(' ').map((word, i) => ({ word, start: i, end: i + 0.5 }));

test('startAfter: the take starts at the end of the marker, punctuation and case aside', () => {
  const words = timed('Save this to song ideas, starting Now. la la la');
  assert.strictEqual(startAfter(words, 'starting now'), 6.5);
  assert.strictEqual(startAfter(words, 'Starting now.'), 6.5);
});

test('startAfter: the first occurrence wins, so a lyric repeating the marker is kept in the take', () => {
  const words = timed('okay starting now we sing starting now again');
  assert.strictEqual(startAfter(words, 'starting now'), 2.5);
});

test('startAfter: a marker Whisper ran together into one token still matches', () => {
  const words = [{ word: 'go', start: 0, end: 0.4 }, { word: 'starting-now', start: 0.4, end: 1.2 }, { word: 'hum', start: 1.3, end: 2 }];
  assert.strictEqual(startAfter(words, 'starting now'), 1.2);
});

test('startAfter: an absent or empty marker answers null rather than guessing', () => {
  const words = timed('save this starting soon');
  assert.strictEqual(startAfter(words, 'starting now'), null);
  assert.strictEqual(startAfter(words, ''), null);
  assert.strictEqual(startAfter([], 'now'), null);
});
