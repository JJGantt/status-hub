'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { heard } = require('../lib/transcribe');

// What Whisper writes for a clip with no speech in it is nothing heard; anything with a word in it is kept.
test('heard: a transcript with no words in it is nothing heard', () => {
  for (const t of ['', '.', ' . ', '...', '?', '—', 'Thank you.', 'thank you', '  Thank you!  ']) {
    assert.strictEqual(heard(t), '', JSON.stringify(t));
  }
});

test('heard: real words are kept as they are', () => {
  for (const t of ['Okay.', 'Thank you for checking that.', '5', 'Qué?', '好', 'Send it.']) {
    assert.strictEqual(heard(t), t, JSON.stringify(t));
  }
});
