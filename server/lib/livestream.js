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
//                      like, and the watch may still be recording and will upload the clip itself. It
//                      is also what a watch that restarts mid-recording looks like, and that one never
//                      uploads anything.
//
// lost, unmarked and stalled all go to BrokenStreams below: the watch gets RECOVER_GRACE_MS to send the
// recording itself, and when it has not, the hub acts on the audio it holds.
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
// started, so it is instant; ffmpeg costs a process start.
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

// How long a stream spent PAUSED, timed from when its P and R frames arrive (they carry no payload). A
// paused recording's file holds only the time it was recording, while the device reports its length as
// wall-clock from the start, so a check of the file against that length has to take this off first or
// every interrupted-and-resumed command reads as damaged. An open pause counts up to now.
class PauseClock {
  constructor(now = Date.now) { this.now = now; this.ms = 0; this.since = null; }
  frame(type) {
    if (type === 'P' && this.since == null) this.since = this.now();
    else if (type === 'R' && this.since != null) { this.ms += this.now() - this.since; this.since = null; }
  }
  seconds() { return (this.ms + (this.since != null ? this.now() - this.since : 0)) / 1000; }
}

// Streams that broke before their recording ended (lost, unmarked, stalled), and what became of them.
// A broken stream is not yet a lost command: a watch that is still alive sends the clip itself, on a
// /api/voice-command naming the stream (`live=<id>`), and that is the copy to act on. So each one waits
// RECOVER_GRACE_MS for that upload, and only when none has come does `recover` run, to act on the audio
// the stream delivered. A clip that arrives AFTER the hub recovered its stream is still a command (the
// whole of what was said, where the recovered one may be a fragment), and `sent` answers it with the id
// of the request recovered from it, so the worker treats it as superseding that one rather than as new.
const RECOVER_GRACE_MS = 3 * 60 * 1000;
const SENT_KEEP_MS = 60 * 60 * 1000;
class BrokenStreams {
  constructor({ graceMs = RECOVER_GRACE_MS, keepMs = SENT_KEEP_MS } = {}) {
    this.graceMs = graceMs; this.keepMs = keepMs;
    this.sentIds = new Set();      // streams a command has named
    this.recoveredAs = new Map();  // stream id -> the request the hub recovered from it
    this.waiting = new Set();      // streams inside their grace
  }
  // Whether this stream is inside its grace here. The next-start check leaves such a recording to it.
  pending(id) { return this.waiting.has(id); }
  _expire(fn) { setTimeout(fn, this.keepMs).unref(); }
  // A command named this stream. Returns the request recovered from it earlier, or null.
  sent(id) {
    this.sentIds.add(id);
    this._expire(() => this.sentIds.delete(id));
    return this.recoveredAs.get(id) || null;
  }
  // The stream broke. `recover()` runs after the grace unless a command names the stream first; it
  // resolves to the recovered request's id (or null when nothing was enqueued). `skipped()` runs instead
  // when the watch sent the recording itself.
  broke(id, { recover, skipped }) {
    this.waiting.add(id);
    setTimeout(async () => {
      this.waiting.delete(id);
      if (this.sentIds.has(id)) return skipped && skipped();
      let rid = null;
      try { rid = await recover(); } catch (e) { console.error(`[voice-live] ${id} could not be recovered: ${e.message || e}`); }
      if (rid) { this.recoveredAs.set(id, rid); this._expire(() => this.recoveredAs.delete(id)); }
    }, this.graceMs).unref();
  }
}

// How the watch itself says a recording ended, from its own log: `events` (client_log rows oldest first,
// each { ev, data }) is searched for the `live-open` naming stream `liveId`, and the first end after it
// answered: 'record-cancel', 'record-stop' or 'mic-failed'. null when the log holds no end for it yet, or
// another recording starts first. A stream can break at the very moment he cancels: the network drops,
// the C frame never arrives, and the stream reads as lost while the watch's log, delivered once it is
// back online, says it was cancelled on purpose.
const WATCH_ENDS = new Set(['record-stop', 'record-cancel', 'mic-failed']);
function endedBy(events, liveId) {
  const i = (events || []).findIndex((e) => e.ev === 'live-open' && e.data && e.data.id === liveId);
  if (i < 0) return null;
  for (const e of events.slice(i + 1)) {
    if (e.ev === 'record-start') return null;
    if (WATCH_ENDS.has(e.ev)) return e.ev;
  }
  return null;
}

module.exports = { FrameReader, endOf, adtsSeconds, PauseClock, BrokenStreams, endedBy, LOST_GAP_MS, RECOVER_GRACE_MS };
