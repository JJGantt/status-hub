// Speech → text through Groq Whisper, for a clip of ANY length.
//
// Groq refuses a direct upload over 25 MB, and a phone clip can be far bigger than its words need: iOS
// Safari's recorder has produced ~1.5 Mbps, so two minutes of speech crossed the cap and the command
// was rejected whole. A clip under the cap goes up untouched — the common case, and no added latency.
// Anything over it is re-encoded to what Whisper actually consumes (16 kHz mono) as 24 kbps Opus and
// cut into half-hour pieces transcribed in order, so no single upload can reach the cap however long
// the command runs. There is deliberately no length limit anywhere here.
//
// The bitrate is CONSTRAINED VBR, not libopus's default: unconstrained, an hour of test tone came out
// at 44 kbps against a 24 kbps target (19.9 MB), too close to the cap to trust. Constrained, a
// half-hour piece measured 5.6 MB.
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const GROQ_URL = 'https://api.groq.com/openai/v1/audio/transcriptions';
const GROQ_MAX_BYTES = 24 * 1024 * 1024;   // a margin under Groq's 25 MB direct-upload cap
const SEGMENT_S = 1800;                     // ~5.4 MB per piece at 24 kbps

// Groq identifies the format by the file name's extension, not the part's content-type.
function extFor(ct) {
  return ct.includes('mp4') || ct.includes('m4a') ? 'm4a'
    : ct.includes('mpeg') ? 'mp3' : ct.includes('wav') ? 'wav'
    : ct.includes('ogg') ? 'ogg' : 'webm';
}

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    p.stderr.on('data', (d) => { err = (err + d).slice(-2000); });
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}: ${err.trim()}`))));
  });
}

// `prompt` is Whisper's own vocabulary hint: text it treats as coming just before the clip, which tilts
// what it writes towards the words and spellings in it. Optional; most callers send none.
//
// Groq first, then OpenAI's Whisper (OPENAI_API_KEY) when Groq fails, so one provider being down does
// not lose a command. Both take the same form and cap a file at 25 MB. When both fail, the caller can
// still hand the clip to the Mac's local Whisper (`/api/voice-command`, status 'untranscribed').
const OPENAI_URL = 'https://api.openai.com/v1/audio/transcriptions';
async function whisper(file, type, name, key, prompt, model) {
  const providers = [
    key && { url: GROQ_URL, key, model: model || 'whisper-large-v3-turbo', label: 'groq' },
    process.env.OPENAI_API_KEY && { url: OPENAI_URL, key: process.env.OPENAI_API_KEY, model: 'whisper-1', label: 'openai' },
  ].filter(Boolean);
  let last;
  for (const p of providers) {
    try {
      const form = new FormData();
      form.append('file', await fs.openAsBlob(file, { type }), name);   // file-backed: never held in memory
      form.append('model', p.model);
      form.append('response_format', 'text');
      // English, always. Left to detect the language, Whisper picks one per clip from its opening audio,
      // and a quiet or noisy opening can land it anywhere: a phone command came back as Icelandic.
      form.append('language', 'en');
      if (prompt) form.append('prompt', prompt);
      const r = await fetch(p.url, { method: 'POST', headers: { Authorization: `Bearer ${p.key}` }, body: form,
                                     signal: AbortSignal.timeout(30000) });
      if (!r.ok) throw new Error(`${p.label} ${r.status}`);
      return (await r.text()).trim();
    } catch (e) {
      last = e;
      console.log(`[transcribe] ${p.label} failed: ${e.message || e}`);
    }
  }
  throw Object.assign(new Error(`transcription failed (${last ? last.message : 'no provider'})`), { status: 502, allFailed: true });
}

// How many seconds of audio a clip actually holds, read off its packet timestamps by a stream copy —
// nothing is decoded, so it costs tens of milliseconds whatever the length. null when ffmpeg cannot
// read it, which says nothing either way.
function clipSeconds(file) {
  return new Promise((resolve) => {
    const p = spawn('ffmpeg', ['-hide_banner', '-nostats', '-i', file, '-map', '0:a:0', '-c', 'copy', '-f', 'null', '-'],
      { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    p.stderr.on('data', (d) => { err = (err + d).slice(-4000); });
    p.on('error', () => resolve(null));
    p.on('close', () => {
      const m = [...err.matchAll(/time=(\d+):(\d+):(\d+(?:\.\d+)?)/g)].pop();
      resolve(m ? +m[1] * 3600 + +m[2] * 60 + parseFloat(m[3]) : null);
    });
  });
}

// WHISPER WRITES "Thank you." FOR A CLIP WITH NO SPEECH IN IT — silence, breath, a room. A transcript
// that is that phrase and nothing else is treated as nothing heard, so it is never run as a command or
// typed into a session. The cost is that saying only "thank you" is dropped too. The same rule is in
// voice-pipeline's server.py and mac-listener/listener.py, the other two places speech becomes text, and
// again where a model is started from words: the voice worker, and a session follow-up (server.js).
const NOTHING_SAID = /^\W*thank\s+you\W*$/i;
const heard = (t) => (NOTHING_SAID.test(t) ? '' : t);

// `model` picks the Groq model; omitted, it is turbo. Turbo can drop a whole stretch of a clip and
// return the rest as if that were everything: a 27s watch command lost its first 10s (the cereal) on
// every one of five tries, while that 10s sent alone came back word for word.
//
// → { transcript, segments } — segments is 0 when the clip went up as recorded.
async function transcribe(file, contentType, key, { prompt, model } = {}) {
  const { transcript, segments } = await transcribeAll(file, contentType, key, prompt, model);
  return { transcript: heard(transcript), segments };
}

async function transcribeAll(file, contentType, key, prompt, model) {
  const ct = String(contentType || 'audio/webm');
  const { size } = await fs.promises.stat(file);
  if (size <= GROQ_MAX_BYTES) return { transcript: await whisper(file, ct, `clip.${extFor(ct)}`, key, prompt, model), segments: 0 };
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'clip-'));
  try {
    await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', file, '-vn', '-ac', '1', '-ar', '16000',
      '-c:a', 'libopus', '-b:a', '24k', '-vbr', 'constrained', '-f', 'segment', '-segment_time', String(SEGMENT_S),
      path.join(dir, 'part%04d.ogg')]);
    const parts = (await fs.promises.readdir(dir)).filter((n) => n.endsWith('.ogg')).sort();
    const texts = [];
    for (const p of parts) texts.push(await whisper(path.join(dir, p), 'audio/ogg', p, key, prompt, model));
    return { transcript: texts.filter(Boolean).join(' '), segments: parts.length };
  } finally {
    await fs.promises.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}


// Speech → text with WHO SAID IT, for a watch rewind grab (docs/REWIND.md). OpenAI's diarizing model:
// it returns the words as segments, each tagged with an anonymous speaker (A, B, …). No Groq fallback,
// because Groq has no diarization; the caller falls back to plain `transcribe` and says so.
// `chunking_strategy: auto` is required by the API for clips over 30 s, which a ring of 30 s plus its
// encoder padding can be.
// → { transcript: "A: …\nB: …", segments: [{ speaker, start, end, text }], model }
const DIARIZE_MODEL = 'gpt-4o-transcribe-diarize';
async function diarize(file, contentType) {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error('OPENAI_API_KEY not set');
  const ct = String(contentType || 'audio/mp4');
  const form = new FormData();
  form.append('file', await fs.openAsBlob(file, { type: ct }), `clip.${extFor(ct)}`);
  form.append('model', DIARIZE_MODEL);
  form.append('response_format', 'diarized_json');
  form.append('chunking_strategy', 'auto');
  form.append('language', 'en');
  const r = await fetch(OPENAI_URL, { method: 'POST', headers: { Authorization: `Bearer ${key}` }, body: form,
                                      signal: AbortSignal.timeout(90000) });
  if (!r.ok) throw new Error(`openai diarize ${r.status}: ${(await r.text()).slice(0, 300)}`);
  const body = await r.json();
  const segments = (body.segments || []).map((g) => ({ speaker: String(g.speaker ?? '?'), start: g.start, end: g.end,
                                                       text: String(g.text || '').trim() })).filter((g) => g.text);
  // Consecutive segments from the same speaker are one turn on screen.
  const turns = [];
  for (const g of segments) {
    const last = turns[turns.length - 1];
    if (last && last.speaker === g.speaker) last.text += ' ' + g.text;
    else turns.push({ speaker: g.speaker, text: g.text });
  }
  const transcript = turns.length ? turns.map((t) => `${t.speaker}: ${t.text}`).join('\n') : heard(String(body.text || '').trim());
  return { transcript, segments, model: DIARIZE_MODEL };
}

module.exports = { transcribe, diarize, NOTHING_SAID, clipSeconds, extFor, GROQ_MAX_BYTES, SEGMENT_S };
