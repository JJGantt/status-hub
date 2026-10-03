// **A reply read aloud in a real voice** (`/api/tts`, `lib/speech.js` on the server). Chunk 0 is asked
// for first and played the moment it lands; every later chunk is fetched while the one before it plays
// and scheduled to start exactly where it ends, on one AudioContext, so the joins are gapless.
//
// The AudioContext is built inside the tap, which is what iOS asks before a page may make sound, and
// `alarmAudio` claims the native `.playback` session for the duration so the mute switch does not
// silence it (`StatusHubApp.swift`; a no-op in a plain browser).
let ctx = null;
let run = 0;            // each play counts up, so a stopped one's late chunks are dropped
let sources = [];
let onEnd = null;

function nativeAudio(on) {
  try { window.webkit.messageHandlers.alarmAudio.postMessage(on); } catch (_) {}
}

export function speaking() { return sources.length > 0 || onEnd !== null; }

export function stopSpeaking() {
  run++;
  for (const s of sources) { try { s.stop(); } catch (_) {} }
  sources = [];
  finish();
}

function finish() {
  if (!onEnd) return;
  const cb = onEnd;
  onEnd = null;
  nativeAudio(false);
  cb();
}

async function fetchChunk(text, i) {
  const r = await fetch('/api/tts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, i }),
  });
  if (!r.ok) throw new Error('tts ' + r.status + ' ' + (await r.text()).slice(0, 200));
  return { of: Number(r.headers.get('X-Chunks') || 1), bytes: await r.arrayBuffer() };
}

// Plays `text`; `done` runs once when it ends, is stopped, or fails. Timings go to the console and to
// /api/tapdebug, since the first-sound delay is the number this whole path is judged on.
export async function speak(text, done) {
  stopSpeaking();
  const me = ++run;
  onEnd = done || (() => {});
  const t0 = performance.now();
  if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)();
  if (ctx.state !== 'running') { try { await ctx.resume(); } catch (_) {} }
  nativeAudio(true);
  const timing = [];
  try {
    const first = await fetchChunk(text, 0);
    if (me !== run) return;
    const of = first.of;
    // Two ahead at most: the model is much faster than the voice, and a burst of requests only
    // risks the rate limit.
    const pending = new Map();
    const want = (i) => { if (i < of && !pending.has(i)) pending.set(i, fetchChunk(text, i)); };
    want(1); want(2);
    let at = 0;
    let lastSrc = null;
    for (let i = 0; i < of; i++) {
      const got = i === 0 ? first : await pending.get(i);
      if (me !== run) return;
      want(i + 2);
      const buf = await ctx.decodeAudioData(got.bytes.slice(0));
      if (me !== run) return;
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.connect(ctx.destination);
      const now = ctx.currentTime;
      // A chunk that arrives after the last one ran out starts now; that gap is a stall, and is logged.
      if (i > 0 && at < now) timing.push({ stall: i, ms: Math.round((now - at) * 1000) });
      at = Math.max(at, now + 0.02);
      src.start(at);
      if (i === 0) timing.push({ first_ms: Math.round(performance.now() - t0), of });
      at += buf.duration;
      sources.push(src);
      lastSrc = src;
      src.onended = () => { sources = sources.filter((s) => s !== src); };
    }
    if (lastSrc) lastSrc.onended = () => {
      sources = sources.filter((s) => s !== lastSrc);
      if (me === run) finish();
    };
    timing.push({ total_audio_s: Math.round(at * 10) / 10 });
  } catch (e) {
    timing.push({ error: String(e.message || e) });
    if (me === run) stopSpeaking();
  }
  console.log('[tts]', JSON.stringify(timing));
  try {
    fetch('/api/tapdebug', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tts: timing }) });
  } catch (_) {}
}
