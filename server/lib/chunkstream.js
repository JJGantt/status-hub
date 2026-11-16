'use strict';
// A recording STREAMED TO THE HUB IN ACKNOWLEDGED CHUNKS while it records (/api/voice-chunk): the phone's
// pressed commands, from the page's WebKit recorder (WebM/Opus) and the app's native one (AAC in ADTS).
// docs/VOICE-ON-THE-PHONE.md § Every pressed recording streams to the hub.
//
// A chunk is a POST, and its answer is the acknowledgement. That is the point of the shape: a recorder
// knows within seconds that its audio is NOT reaching the hub (no answer), or that what reaches it is
// damaged (the answer says so), and stops the recording right then instead of letting the user talk for
// minutes into a failure. The watch streams one long request instead (lib/livestream.js), which suits a
// device that cannot spare a request a second but tells it nothing while the body is still open.
//
// This file is the pure part: measuring what arrived, and the rules a stream follows. The route, the
// timers and what a lost stream becomes live in routes/voice.js.

const { adtsSeconds } = require('./livestream');

// Seconds of audio a WebM stream holds, read off its block timestamps — the same timestamps ffmpeg
// counts, so a capture that drops frames (whose timestamps close up over the gap) measures short here
// exactly as it does there. A MediaRecorder writes the Segment and every Cluster with unknown size and
// is cut mid-element at any chunk boundary, so this walks the bytes linearly, descends into the
// containers, and stops at the first element that is not all there. null when it is not WebM.
const EBML_HEADER = 0x1A45DFA3;
const CONTAINERS = new Set([0x18538067 /* Segment */, 0x1F43B675 /* Cluster */, 0xA0 /* BlockGroup */, 0x1549A966 /* Info */]);
const TIMECODE_SCALE = 0x2AD7B1, CLUSTER_TIMECODE = 0xE7, SIMPLE_BLOCK = 0xA3, BLOCK = 0xA1;
const OPUS_FRAME_S = 0.02;

function vint(b, i, keepMarker) {
  if (i >= b.length) return null;
  const first = b[i];
  let len = 1, mask = 0x80;
  while (len <= 8 && !(first & mask)) { len++; mask >>= 1; }
  if (len > 8 || i + len > b.length) return null;
  let v = keepMarker ? first : first & (mask - 1);
  let allOnes = (first & (mask - 1)) === mask - 1;
  for (let k = 1; k < len; k++) { v = v * 256 + b[i + k]; if (b[i + k] !== 0xFF) allOnes = false; }
  return { v, len, unknown: !keepMarker && allOnes };
}

function webmSeconds(buffers) {
  const b = Buffer.isBuffer(buffers) ? buffers : Buffer.concat(buffers);
  if (b.length < 4 || b.readUInt32BE(0) !== EBML_HEADER) return null;
  let i = 0, scale = 1e6, cluster = 0, max = -Infinity, min = Infinity;
  while (i < b.length) {
    const id = vint(b, i, true); if (!id) break;
    const size = vint(b, i + id.len, false); if (!size) break;
    const body = i + id.len + size.len;
    if (CONTAINERS.has(id.v)) { i = body; continue; }          // descend: its children follow inline
    if (size.unknown || body + size.v > b.length) break;      // cut off here; what came before stands
    if (id.v === TIMECODE_SCALE || id.v === CLUSTER_TIMECODE) {
      let v = 0;
      for (let k = 0; k < size.v; k++) v = v * 256 + b[body + k];
      if (id.v === TIMECODE_SCALE) scale = v; else cluster = v;
    } else if (id.v === SIMPLE_BLOCK || id.v === BLOCK) {
      const track = vint(b, body, false);
      if (track && body + track.len + 2 <= b.length) {
        const t = cluster + b.readInt16BE(body + track.len);
        if (t > max) max = t;
        if (t < min) min = t;
      }
    }
    i = body + size.v;
  }
  if (max === -Infinity) return 0;
  return ((max - Math.min(min, 0)) * scale) / 1e9 + OPUS_FRAME_S;
}

// A WAV stream (the Mac's command key records with sox, which writes the header before it knows the
// length): where its samples start and how many bytes a second of them is. null when it is not WAV yet.
function wavLayout(b) {
  if (b.length < 12 || b.toString('latin1', 0, 4) !== 'RIFF' || b.toString('latin1', 8, 12) !== 'WAVE') return null;
  let i = 12, byteRate = 0;
  while (i + 8 <= b.length) {
    const tag = b.toString('latin1', i, i + 4), size = b.readUInt32LE(i + 4);
    if (tag === 'fmt ' && i + 16 <= b.length) byteRate = b.readUInt32LE(i + 16);
    if (tag === 'data') return byteRate ? { data: i + 8, byteRate } : null;
    i += 8 + size + (size & 1);
  }
  return null;
}
function wavSeconds(buffers) {
  const b = Buffer.isBuffer(buffers) ? buffers : Buffer.concat(buffers);
  const w = wavLayout(b);
  return w ? Math.max(0, b.length - w.data) / w.byteRate : null;
}
// The same bytes with the header's two lengths made true, so a stream cut off anywhere is a playable file.
function sealWav(b) {
  const w = wavLayout(b);
  if (!w) return b;
  const out = Buffer.from(b);
  out.writeUInt32LE(out.length - 8, 4);
  out.writeUInt32LE(out.length - w.data, w.data - 4);
  return out;
}

// Seconds held by a stream's audio, by its type.
function heldSeconds(type, parts) {
  if (!parts.length) return 0;
  const f = type === 'aac' ? adtsSeconds : type === 'wav' ? wavSeconds : webmSeconds;
  return f(parts) ?? null;
}

// A capture that keeps under half of the time it recorded is DAMAGED — the same line the finished clip is
// judged by (/api/voice-command), measured here while it is still recording. Judged only once there is
// enough of it that the device's own timing and the encoder's buffering are small against it.
const DAMAGED_KEPT = 0.5;
const DAMAGED_MIN_S = 4;
function isDamaged(held, secs) {
  return held != null && secs >= DAMAGED_MIN_S && held < secs * DAMAGED_KEPT;
}

// How long a stream may go without a chunk before it is treated as lost and its audio is used. A
// recording sends a chunk every second; a paused one (a call, Siri, the page hidden) sends none until
// it carries on, so it waits far longer.
const SILENT_LOST_MS = 60 * 1000;
const PAUSED_LOST_MS = 30 * 60 * 1000;

// A chunk against the stream's next expected sequence number: `take` it, `repeat` an acknowledged one
// (a retry whose answer was lost), or `gap` when chunks are missing in between.
function sequence(next, seq) {
  if (seq === next) return 'take';
  if (seq < next) return 'repeat';
  return 'gap';
}

module.exports = { webmSeconds, wavSeconds, sealWav, heldSeconds, isDamaged, sequence, SILENT_LOST_MS, PAUSED_LOST_MS, DAMAGED_MIN_S };
