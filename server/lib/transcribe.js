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

async function whisper(file, type, name, key) {
  const form = new FormData();
  form.append('file', await fs.openAsBlob(file, { type }), name);   // file-backed: never held in memory
  form.append('model', 'whisper-large-v3-turbo');
  form.append('response_format', 'text');
  // English, always. Left to detect the language, Whisper picks one per clip from its opening audio,
  // and a quiet or noisy opening can land it anywhere: a phone command came back as Icelandic.
  form.append('language', 'en');
  const r = await fetch(GROQ_URL, { method: 'POST', headers: { Authorization: `Bearer ${key}` }, body: form });
  if (!r.ok) throw Object.assign(new Error(`transcription failed (${r.status})`), { status: 502 });
  return (await r.text()).trim();
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

// → { transcript, segments } — segments is 0 when the clip went up as recorded.
async function transcribe(file, contentType, key) {
  const ct = String(contentType || 'audio/webm');
  const { size } = await fs.promises.stat(file);
  if (size <= GROQ_MAX_BYTES) return { transcript: await whisper(file, ct, `clip.${extFor(ct)}`, key), segments: 0 };
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'clip-'));
  try {
    await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', file, '-vn', '-ac', '1', '-ar', '16000',
      '-c:a', 'libopus', '-b:a', '24k', '-vbr', 'constrained', '-f', 'segment', '-segment_time', String(SEGMENT_S),
      path.join(dir, 'part%04d.ogg')]);
    const parts = (await fs.promises.readdir(dir)).filter((n) => n.endsWith('.ogg')).sort();
    const texts = [];
    for (const p of parts) texts.push(await whisper(path.join(dir, p), 'audio/ogg', p, key));
    return { transcript: texts.filter(Boolean).join(' '), segments: parts.length };
  } finally {
    await fs.promises.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

module.exports = { transcribe, clipSeconds, extFor, GROQ_MAX_BYTES, SEGMENT_S };
