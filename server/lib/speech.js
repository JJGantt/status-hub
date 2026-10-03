// **A reply read aloud in a real voice**: the text the hub already shows, turned into speech by Groq's
// Orpheus model, one short chunk at a time. Chunked because the model takes a short input per request
// and because a chunk is what lets playback start before the rest exists: the client plays chunk 0
// while it fetches the next, and the model renders far faster than the voice speaks, so it stays ahead.
//
// Only on request — a play button — and every rendered chunk is kept, so a replay costs nothing.
const crypto = require('crypto');
const { execFile } = require('child_process');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');

const URL = 'https://api.groq.com/openai/v1/audio/speech';
const MODEL = 'canopylabs/orpheus-v1-english';
// The voice is the hub setting `tts_voice` (the Settings page), so changing it needs no deploy and no
// app build. Orpheus's women are autumn, diana and hannah.
const VOICES = ['autumn', 'diana', 'hannah', 'austin', 'daniel', 'troy'];
const DEFAULT_VOICE = 'hannah';
const MAX = 190;   // under the model's per-request input cap

// What is SAID: the reply's text with its markdown syntax gone. Code blocks are skipped outright —
// read aloud they are noise — and a link says its label, never its address.
function spoken(md) {
  return String(md || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/https?:\/\/\S+/g, '')
    .replace(/^\s*\|?\s*:?-{2,}.*$/gm, '')
    .replace(/\|/g, ', ')
    .replace(/^\s{0,3}#{1,6}\s*/gm, '')
    .replace(/^\s*(?:[-*+]|\d+[.)])\s+/gm, '')
    .replace(/^\s*>\s?/gm, '')
    .replace(/(\*\*|__|\*|_|~~)(?=\S)([\s\S]*?\S)\1/g, '$2')
    .replace(/[ \t]+/g, ' ')
    .trim();
}

// Sentences, packed up to MAX characters. The FIRST chunk is kept to one sentence on purpose: it is the
// one he waits for, and a shorter input comes back sooner.
function chunks(text) {
  const lines = spoken(text).split(/\n+/).map((l) => l.trim()).filter(Boolean);
  const sentences = [];
  for (const line of lines) {
    // A line with no closing punctuation (a list item, a heading) ends a sentence of its own.
    for (const s of line.split(/(?<=[.!?:;])\s+/)) {
      let rest = s.trim();
      while (rest.length > MAX) {
        const cut = Math.max(rest.lastIndexOf(', ', MAX), rest.lastIndexOf(' ', MAX));
        const at = cut > MAX / 2 ? cut : MAX;
        sentences.push(rest.slice(0, at).trim());
        rest = rest.slice(at).trim();
      }
      if (rest) sentences.push(/[.!?:;,]$/.test(rest) ? rest : rest + '.');
    }
  }
  const out = [];
  for (const s of sentences) {
    const last = out[out.length - 1];
    if (out.length > 1 && last.length + 1 + s.length <= MAX) out[out.length - 1] = last + ' ' + s;
    else out.push(s);
  }
  return out;
}

// Rendered audio by chunk text, newest kept. A few hundred chunks is a few dozen replies.
const cache = new Map();
const CACHE_MAX = 400;

// SPEED is applied here, not asked of Groq: Orpheus ignores the `speed` field and returns the same
// clip. ffmpeg's atempo stretches time without raising the pitch. Through files, not pipes: a WAV
// written to a pipe has no length in its header, which AVAudioFile on the watch will not read.
// `tts_speed` on the Settings page; the free tier's 1200 characters a minute is about 1.3x of how fast
// this voice speaks, so a long reply above that runs out of audio and pauses for the rate limit.
const DEFAULT_SPEED = 1.2;
function speedOf(v) {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0.8 && n <= 1.6 ? n : DEFAULT_SPEED;
}

async function tempo(wav, speed) {
  if (speed === 1) return wav;
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tts-'));
  const a = path.join(dir, 'in.wav'), b = path.join(dir, 'out.wav');
  try {
    await fs.writeFile(a, wav);
    await new Promise((ok, no) => execFile('ffmpeg',
      ['-hide_banner', '-loglevel', 'error', '-i', a, '-filter:a', `atempo=${speed}`, '-y', b],
      (err) => (err ? no(err) : ok())));
    return await fs.readFile(b);
  } finally {
    fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

async function synth(input, key, { voice, speed } = {}) {
  const sp = speedOf(speed);
  const raw = await render(input, key, voice);
  return tempo(raw, sp);
}

async function render(input, key, voice) {
  const VOICE = VOICES.includes(voice) ? voice : DEFAULT_VOICE;
  const id = crypto.createHash('sha1').update(MODEL + VOICE + input).digest('hex');
  const hit = cache.get(id);
  if (hit) { cache.delete(id); cache.set(id, hit); return hit; }
  // The free tier allows 1200 characters a minute, more than a voice speaks in one, so a long reply
  // fits if its chunks are paced rather than burst: a 429 says how long to wait, and the client is
  // chunks ahead of the voice, so waiting it out costs nothing audible.
  let r;
  for (let attempt = 0; ; attempt++) {
    r = await fetch(URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: MODEL, voice: VOICE, input, response_format: 'wav' }),
    });
    if (r.status !== 429 || attempt >= 6) break;
    const body = await r.text();
    const m = /try again in ([\d.]+)s/.exec(body);
    const wait = Math.min(20, m ? Number(m[1]) + 0.3 : 2);
    console.log('[tts] rate limited, waiting', wait, 's');
    await new Promise((ok) => setTimeout(ok, wait * 1000));
  }
  if (!r.ok) throw new Error(`groq tts ${r.status}: ${(await r.text()).slice(0, 300)}`);
  const buf = Buffer.from(await r.arrayBuffer());
  cache.set(id, buf);
  if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
  return buf;
}

module.exports = { spoken, chunks, synth, VOICES, DEFAULT_VOICE, DEFAULT_SPEED };
