'use strict';
// Where a saved recording starts: right after the spoken marker that says the take begins ("starting
// now"). The model names the marker in the words it heard; this finds that exact run of words in the
// clip's word timings and answers the end of its last word. No fuzzy matching: a marker that is not
// there answers null, and the caller hands the model the timed words to choose a start from instead.

// Lower case, letters and digits only, so "Now." and "now" are one word.
const norm = (w) => String(w || '').toLowerCase().replace(/[^a-z0-9']+/g, '').replace(/'/g, '');

// words: [{ word, start, end }]; marker: "starting now". → seconds, or null when the marker is absent.
// The FIRST occurrence wins: the marker is said before the take, and a lyric that repeats it comes after.
function startAfter(words, marker) {
  const want = String(marker || '').split(/\s+/).map(norm).filter(Boolean);
  if (!want.length) return null;
  const toks = [];
  for (const w of words || []) {
    // Whisper sometimes returns two words as one token ("now,then"); split so each can match.
    for (const piece of String(w.word || '').split(/[\s-]+/)) {
      const t = norm(piece);
      if (t) toks.push({ t, end: w.end });
    }
  }
  for (let i = 0; i + want.length <= toks.length; i++) {
    if (want.every((x, j) => toks[i + j].t === x)) return toks[i + want.length - 1].end;
  }
  return null;
}

// The timed words as one compact line for the model: "starting@3.1 now@3.4 …".
function timedLine(words, limit = 120) {
  return (words || []).slice(0, limit).map((w) => `${w.word}@${(+w.start).toFixed(1)}`).join(' ');
}

module.exports = { startAfter, timedLine };
