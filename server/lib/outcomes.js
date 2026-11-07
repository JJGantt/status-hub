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

// A session's thread (`events`, routes/conversation.js) is never empty once the session has been told
// anything: its launch prompt, a follow-up, or a reply reach the thread before any surface can open it.
// An empty one means every surface shows a blank page and nothing else fails — a transcript read from
// the wrong file, a host that never streamed, a seed that found no turns. `row` is the desk_sessions
// row with its launch prompt as `launch_prompt`; a row younger than `graceMs` may not have streamed yet.
const EMPTY_THREAD_GRACE_MS = 90 * 1000;
function emptyThread(row, events, now = Date.now(), graceMs = EMPTY_THREAD_GRACE_MS) {
  if (events && events.length) return false;
  const told = row.launch_prompt || row.last_prompt || row.last_reply || row.working;
  if (!told) return false;
  const started = row.started ? new Date(row.started).getTime() : 0;
  return now - started >= graceMs;
}

module.exports = { vanishedRecordings, RECORD_EVENTS, emptyThread };
