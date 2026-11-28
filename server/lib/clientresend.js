'use strict';
// A device's log batch sent again after the hub already stored it (routes/voice.js /api/clientlog).
//
// The watch (apps/Watch/Hub.swift LogOutbox) and the iPhone app (apps/Shared/ClientLog.swift) keep each
// line until the hub has answered for its batch. When the batch is stored but the answer is lost (the
// watch moving between the phone's relay and its own Wi-Fi drops the 204 in flight), the device sends
// the same lines again with its next batch, and every failure among them would be reported a second
// time as a fresh incident. So a batched line exactly equal to one accepted in an EARLIER request is
// dropped. Lines alike within one batch are kept: each is its own call on the device, and every line
// carries the device's own time to the second, so two real events rarely share every field.
//
// A batch counts as accepted only once it is stored (`remember` after the write), because a batch the
// hub failed to store is sent again on purpose and must not be dropped. The memory is the process's, so
// a resend that crosses a hub restart still comes through twice.

const crypto = require('crypto');

const KEEP_MS = 24 * 3600e3;
const CAP = 50000;

const canonical = (v) => Array.isArray(v) ? `[${v.map(canonical).join(',')}]`
  : v && typeof v === 'object' ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`
  : JSON.stringify(v);
const keyOf = (l) => crypto.createHash('sha1').update(canonical(l)).digest('base64');

function createResendGuard({ keepMs = KEEP_MS, cap = CAP } = {}) {
  const seen = new Map();   // line key -> when it was accepted (insertion order is age order)

  function prune(now) {
    for (const [k, at] of seen) {
      if (seen.size <= cap && now - at < keepMs) break;
      seen.delete(k);
    }
  }

  return {
    /** The lines of this batch not already accepted from an earlier one, and how many were dropped. */
    fresh(lines, now = Date.now()) {
      prune(now);
      const kept = lines.filter((l) => !seen.has(keyOf(l)));
      return { kept, dropped: lines.length - kept.length };
    },
    /** Marks a stored batch's lines as accepted. */
    remember(lines, now = Date.now()) {
      for (const l of lines) { const k = keyOf(l); seen.delete(k); seen.set(k, now); }
      prune(now);
    },
  };
}

module.exports = { createResendGuard };
