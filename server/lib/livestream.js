'use strict';
// A recording streamed to the hub WHILE it is being recorded (/api/voice-live, the watch's LiveStream).
// The stream is what makes a recording that dies observable at the moment it dies: the connection is
// open exactly as long as the recording, a recording that ends on purpose says so before the
// connection closes, and one that does not was cut off. Nothing waits on a clock for that.
//
// The body is a sequence of frames, each [type: 1 byte][length: 4 bytes, big-endian][payload]:
//   A  audio: AAC in ADTS framing, so the concatenated payloads are themselves a playable .aac stream
//   P  the recording paused (the system took the microphone); R  it resumed
//   E  it ended and is being sent; C  it was cancelled
// A frame split across network chunks is held until the rest of it arrives.

const TYPES = new Set(['A', 'P', 'R', 'E', 'C']);
const MAX_FRAME = 1 << 20;

class FrameReader {
  constructor() { this.pending = Buffer.alloc(0); this.bad = null; }
  // Answers the complete frames in `chunk` (with whatever was held from before), as { type, data }.
  push(chunk) {
    const out = [];
    if (this.bad) return out;
    this.pending = this.pending.length ? Buffer.concat([this.pending, chunk]) : chunk;
    while (this.pending.length >= 5) {
      const type = String.fromCharCode(this.pending[0]);
      const len = this.pending.readUInt32BE(1);
      if (!TYPES.has(type) || len > MAX_FRAME) { this.bad = `bad frame ${JSON.stringify(type)} len ${len}`; break; }
      if (this.pending.length < 5 + len) break;
      out.push({ type, data: this.pending.subarray(5, 5 + len) });
      this.pending = this.pending.subarray(5 + len);
    }
    return out;
  }
}

// How a stream ended, from what the hub saw. `complete`: the request body finished cleanly (the watch
// closed it). `last`: the last control frame, or null. `paused`: a P with no R after it. `gapMs`: from the
// last byte received to the connection closing.
//
//   ended / cancelled  the recording said how it ended. Nothing to do.
//   unmarked           the body closed cleanly with no E or C. This is what an app killed mid-recording
//                      looks like: the system's networking finishes the upload for a process that is no
//                      longer there (measured in the simulator with SIGKILL: a clean end 50ms after the
//                      last audio, no E). The watch's own code never closes without E or C, and a lost
//                      network never produces a clean end, so this is unambiguous. Reported, audio kept.
//   lost               the connection dropped mid-body while audio was flowing, the close following the
//                      last byte at once: something between the app and the hub went away rather than
//                      the network going quiet. Reported, and the audio so far is kept.
//   limited            the hub closed it itself: the stream reached the server's request limit
//                      (server.requestTimeout, sent to the watch as 408). Only a locked recording runs that
//                      long. The watch carries on recording and uploads the whole clip when it ends, so
//                      nothing is lost; logged only, and the next-start check still covers the recording.
//   stalled            the connection dropped after bytes had already stopped arriving, or while the
//                      recording was paused, when none are expected. That is what a lost network looks
//                      like, and the watch may still be recording and will upload the clip itself. Not
//                      reported here; a recording that is never heard from again is still caught by the
//                      next-start check (lib/outcomes.js).
const LOST_GAP_MS = 3000;

function endOf({ complete, last, paused, gapMs, limited }) {
  if (last === 'E') return 'ended';
  if (last === 'C') return 'cancelled';
  if (limited && !complete) return 'limited';
  if (complete) return 'unmarked';
  if (paused || !(gapMs < LOST_GAP_MS)) return 'stalled';
  return 'lost';
}

// Seconds of audio in an ADTS stream, read off its frame headers: every frame says its own byte length,
// how many 1024-sample blocks it holds and at what sample rate. Nothing is decoded and no process is
// started, so it is instant; ffmpeg reading the same file costs the hub 2-3s, most of it starting ffmpeg.
// null when the bytes are not ADTS from the first byte, which says nothing either way.
const ADTS_RATES = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];
function adtsSeconds(buffers) {
  const b = Buffer.isBuffer(buffers) ? buffers : Buffer.concat(buffers);
  let i = 0, secs = 0;
  while (i + 7 <= b.length) {
    if (b[i] !== 0xFF || (b[i + 1] & 0xF0) !== 0xF0) return null;
    const rate = ADTS_RATES[(b[i + 2] >> 2) & 0x0F];
    const len = ((b[i + 3] & 0x03) << 11) | (b[i + 4] << 3) | (b[i + 5] >> 5);
    if (!rate || len < 7) return null;
    secs += (((b[i + 6] & 0x03) + 1) * 1024) / rate;
    i += len;
  }
  return i === 0 ? null : secs;
}

module.exports = { FrameReader, endOf, adtsSeconds, LOST_GAP_MS };
