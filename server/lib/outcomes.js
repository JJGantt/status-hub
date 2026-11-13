'use strict';
// Outcome checks: a thing that was started has to END in one of the ways it is supposed to. When it does
// not, nothing throws (the process that held it may simply be gone), so the only place the failure can
// be seen is the next event from the same device. Each check here reads that event stream and answers
// with what never finished, and the caller reports each one as an error, which is what makes the ops
// responder investigate.

// A watch recording ends in exactly one of these. `mic-failed` counts: the microphone never opened, and
// that failure is already a line of its own.
const RECORD_ENDS = new Set(['record-stop', 'record-cancel', 'mic-failed', 'record-lost']);
const RECORD_EVENTS = ['record-start', 'mic-open', ...RECORD_ENDS];

// `events`: one device's recording events oldest first, each { ev, at }. Answers every record-start
// whose microphone opened and that was followed by another record-start (or nothing yet, which is not
// counted: it may still be running) with no end between. A start before its mic opened that is stopped
// at once ends without a `record-stop` by design (Capture.stop while arming), hence the mic-open test.
// The outbox can deliver a batch twice, so a repeat of the same event at the same moment is one event.
function vanishedRecordings(events) {
  const seen = new Set();
  const out = [];
  let open = null;   // { at, opened }
  for (const e of events) {
    const key = `${e.ev}|${e.at}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (e.ev === 'record-start') {
      if (open && open.opened) out.push({ at: open.at, next: e.at });
      open = { at: e.at, opened: false };
    } else if (e.ev === 'mic-open') {
      if (open) open.opened = true;
    } else if (RECORD_ENDS.has(e.ev)) {
      open = null;
    }
  }
  return out;
}

// A session's thread (`events`, routes/conversation.js) always shows something: the hub puts the launch
// prompt in it from the moment the row exists (marked `launch` until the host's own copy arrives). What
// must also hold is that the HOST has confirmed something: Claude Code writes the launch prompt to the
// transcript within about a second of the row being written (0.3-5.6s across 25 Mac launches), and the
// host streams it at once. A thread with nothing from the host past `HOST_CONFIRM_MS` is a session every
// surface draws as its prompt and then nothing, for ever: a transcript read from the wrong file, a host
// that never streamed. `row` is the desk_sessions row with its launch prompt as `launch_prompt`.
// `since` is when this process started: the thread lives in memory, so after a restart the turn in flight
// is back only once the host's next frame replays it, and the clock runs from whichever came later.
const HOST_CONFIRM_MS = 30 * 1000;
function unconfirmedThread(row, events, now = Date.now(), since = 0) {
  if ((events || []).some((e) => !e.launch)) return false;
  if (!(row.launch_prompt || row.last_prompt || row.last_reply || row.working)) return false;
  return now - Math.max(row.started ? new Date(row.started).getTime() : 0, since) >= HOST_CONFIRM_MS;
}

// Whether a host's prompt is its copy of the launch stand-in. The stand-in is the row's stored prompt, which
// can be a cut-down copy of what the host was given, and a replayed prompt carries no command id, so the
// host's text has to START with the stand-in's rather than equal it. Whitespace is ignored.
const flatText = (t) => String(t || '').replace(/\s+/g, ' ').trim();
function echoesLaunch(seedText, hostText) {
  const seed = flatText(seedText);
  return !!seed && flatText(hostText).startsWith(seed);
}

module.exports = { vanishedRecordings, RECORD_EVENTS, unconfirmedThread, echoesLaunch };
