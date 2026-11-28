'use strict';
// PIN unlock by text or email (docs/DOOR.md § PIN by text or email). A message counts only when its
// whole content is the PIN: a text whose body is just the digits, or an email whose subject and body
// are each either empty or those same digits (a "Sent from my ..." footer aside).
const crypto = require('crypto');

const DIGITS = /^\d{4,12}$/;
// Wrong PIN-shaped messages within the window that lock the feature until it is turned back on.
const LOCK_AFTER = 3;
const LOCK_WINDOW_MS = 60 * 60e3;

const clean = (s) => String(s ?? '').replace(/[\s​﻿]+/g, ' ').trim();

// The digits a text consists of, or null.
function fromText(text) {
  const t = clean(text);
  return DIGITS.test(t) ? t : null;
}

// The digits an email consists of, or null.
function fromEmail(subject, body) {
  const lines = String(body ?? '').split(/\r?\n/).map(clean).filter(Boolean);
  while (lines.length && /^(sent from|get outlook for)\b/i.test(lines[lines.length - 1])) lines.pop();
  if (lines.length && /^--\s*$/.test(lines[lines.length - 1])) lines.pop();
  const parts = [clean(subject), lines.join(' ')].filter(Boolean);
  if (!parts.length || !parts.every((p) => p === parts[0])) return null;
  return DIGITS.test(parts[0]) ? parts[0] : null;
}

const keyed = (pepper, pin) => crypto.createHmac('sha256', pepper).update(pin).digest('hex');

// Which door `pin` opens given the stored keyed hashes ({ lobby, front }), or null.
function doorFor(pin, hashes, pepper) {
  if (!pin || !pepper || !hashes) return null;
  const h = Buffer.from(keyed(pepper, pin));
  for (const door of ['lobby', 'front']) {
    const want = hashes[door] ? Buffer.from(String(hashes[door])) : null;
    if (want && want.length === h.length && crypto.timingSafeEqual(want, h)) return door;
  }
  return null;
}

// Whether wrong attempts at these times (ms) lock the feature at `now`.
function lockedOut(wrongTimes, now) {
  return wrongTimes.filter((t) => now - t <= LOCK_WINDOW_MS).length >= LOCK_AFTER;
}

module.exports = { DIGITS, LOCK_AFTER, LOCK_WINDOW_MS, fromText, fromEmail, keyed, doorFor, lockedOut };
