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
//   unmarked           the body closed cleanly with no E or C: the watch's own code closed it without
//                      saying why, which none of its paths should do. Reported.
//   lost               the connection dropped while audio was flowing. Bytes stop and the close follows
//                      at once when the process holding the other end goes away, because its operating
//                      system closes the socket. Reported, and the audio so far is kept.
//   stalled            the connection dropped after bytes had already stopped arriving, or while the
//                      recording was paused, when none are expected. That is what a lost network looks
//                      like, and the watch may still be recording and will upload the clip itself. Not
//                      reported here; a recording that is never heard from again is still caught by the
//                      next-start check (lib/outcomes.js).
const LOST_GAP_MS = 3000;

function endOf({ complete, last, paused, gapMs }) {
  if (last === 'E') return 'ended';
  if (last === 'C') return 'cancelled';
  if (complete) return 'unmarked';
  if (paused || !(gapMs < LOST_GAP_MS)) return 'stalled';
  return 'lost';
}

module.exports = { FrameReader, endOf, LOST_GAP_MS };
