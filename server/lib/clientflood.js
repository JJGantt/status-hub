'use strict';
// A device sending far more log lines than it ever does (routes/voice.js /api/clientlog).
//
// clientfail.js raises the lines a device marks as failures; a plain line is only stored. So a device
// stuck in a loop that logs a plain line — the app frozen, the hub's client_log and its Fly logs
// filling — would raise nothing at all. This counts lines per device, event and minute of the DEVICE's
// clock (a watch batch arrives late, stamped with when each line happened), reports the moment one
// passes LIMIT, and drops the rest of that minute's lines of that kind so the flood is not stored.
//
// LIMIT is from client_log itself: across two weeks the most lines one device logged of one event in a
// minute was 47 (the watch's session-shown). 300 is several times that.

const LIMIT = 300;
const KEEP_MINUTES = 10;

function createFloodGuard({ limit = LIMIT, report } = {}) {
  const counts = new Map();   // `${src}|${ev}|${minute}` -> count
  let newest = '';

  function prune(minute) {
    if (minute <= newest) return;
    newest = minute;
    const cutoff = new Date(Date.parse(`${minute}:00Z`) - KEEP_MINUTES * 60e3).toISOString().slice(0, 16);
    for (const k of counts.keys()) if (k.slice(k.lastIndexOf('|') + 1) < cutoff) counts.delete(k);
  }

  /** True when the line should be kept; false once its kind has passed the limit for its minute. */
  return function admit(l, nowMs = Date.now()) {
    const at = Date.parse(l && l.t);
    const minute = new Date(Number.isFinite(at) ? at : nowMs).toISOString().slice(0, 16);
    prune(minute);
    const key = `${l.src || 'unknown'}|${l.ev || '?'}|${minute}`;
    const n = (counts.get(key) || 0) + 1;
    counts.set(key, n);
    if (n === limit + 1 && report) {
      report(`${l.src || 'unknown'} is flooding the hub: more than ${limit} '${l.ev}' log lines in one minute; the rest of that minute's are dropped`, l.src || 'unknown',
        { at: minute, build: l.build, sample: JSON.stringify(l).slice(0, 400),
          look: `client_log where src=${l.src} and ev=${l.ev} around that time` });
    }
    return n <= limit;
  };
}

module.exports = { createFloodGuard, LIMIT };
