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

// Every provider answering 400 means the file is unreadable, not that transcription is down; any other
// failure (a 5xx, a timeout, a 429) still leaves the clip for the Mac's local Whisper.
test('transcribe: a clip every provider refuses with 400 is marked refused; an outage is not', async () => {
  const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
  const { transcribe } = require('../lib/transcribe');
  const file = path.join(os.tmpdir(), `refused-${process.pid}.m4a`);
  fs.writeFileSync(file, Buffer.alloc(557));
  const realFetch = global.fetch, realKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = 'k';
  const quiet = console.log; console.log = () => {};
  const run = async (statuses) => {
    let i = 0;
    global.fetch = async () => new Response('bad', { status: statuses[i++] });
    return transcribe(file, 'audio/mp4', 'g').then(() => null, (e) => e);
  };
  try {
    const refused = await run([400, 400]);
    assert.ok(refused.allFailed && refused.refused);
    for (const s of [[400, 500], [503, 400], [429, 429]]) {
      const e = await run(s);
      assert.ok(e.allFailed && !e.refused, JSON.stringify(s));
    }
  } finally {
    global.fetch = realFetch; console.log = quiet; fs.rmSync(file, { force: true });
    if (realKey === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = realKey;
  }
});
