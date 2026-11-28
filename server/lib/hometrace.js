'use strict';
// The phone's near-home trace chunks (apps/Sources/HomeTrace.swift, docs/DOOR.md § Near-home trace):
// what a chunk must look like before it is stored in home_trace (data-layer 00221). Pure, tested in
// test/hometrace.test.js.

const STREAMS = { alt: 3, steps: 4, fixes: 8, activity: 3, modes: 2 };
const ACTIVITIES = new Set(['stationary', 'walking', 'running', 'automotive', 'cycling', 'unknown']);

/**
 * The row to insert for a posted chunk, or { error } saying what is wrong with it. Every stream is an
 * array of arrays of the stream's width whose first element is a number (seconds into the chunk).
 */
function chunkRow(b) {
  if (!b || typeof b !== 'object') return { error: 'body must be an object' };
  const started = Date.parse(b.started_at), ended = Date.parse(b.ended_at);
  if (!Number.isFinite(started) || !Number.isFinite(ended)) return { error: 'started_at and ended_at must be timestamps' };
  if (ended < started) return { error: 'ended_at is before started_at' };
  const row = { device: String(b.device || 'phone').slice(0, 20), started_at: new Date(started).toISOString(), ended_at: new Date(ended).toISOString() };
  for (const [name, width] of Object.entries(STREAMS)) {
    const s = b[name] ?? [];
    if (!Array.isArray(s)) return { error: `${name} must be an array` };
    for (const item of s) {
      if (!Array.isArray(item) || item.length !== width || typeof item[0] !== 'number') return { error: `${name}: each sample must be [t, …] with ${width} values` };
      if (name === 'activity' && !ACTIVITIES.has(item[1])) return { error: `activity: unknown kind ${item[1]}` };
      if (name === 'modes' && item[1] !== 'best' && item[1] !== 'low') return { error: `modes: unknown mode ${item[1]}` };
    }
    row[name] = s;
  }
  return { row };
}

module.exports = { chunkRow, STREAMS };
