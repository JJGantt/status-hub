'use strict';
// The lobby-door race's rules (docs/DOOR.md § Lobby door): which arrival reports count, and what a race
// came to. Pure, so the route stays thin and the rules are tested (test/lobby.test.js).

const PATHS = ['imessage', 'sms', 'email'];
const CODEWORD = 'open-lobby-7731';
// A nonce works this long after its race started: long enough for the slowest path, short enough that
// a forwarded or leaked message cannot open the door later.
const VALID_MS = 10 * 60e3;

/** The text every path sends for a race. */
const message = (nonce, path) => `${CODEWORD} ${nonce} ${path}`;

/**
 * Whether the phone's report of `path` for `race` counts, at `now` (ms). `arrivals` are the paths
 * already reported for it. Answers { ok, status, why }: status is the HTTP answer the route gives.
 */
function judgeArrival(race, path, arrivals, now) {
  if (!PATHS.includes(path)) return { ok: false, status: 404, why: 'unknown path' };
  if (!race) return { ok: false, status: 404, why: 'unknown code' };
  if (now - Date.parse(race.created_at) > VALID_MS) return { ok: false, status: 410, why: 'expired' };
  if (arrivals.includes(path)) return { ok: false, status: 409, why: 'already reported' };
  return { ok: true, status: 200, why: 'recorded' };
}

/**
 * What a race came to, from its row and its events: each path's send result and arrival latency
 * (seconds after the race started), and the winner, the first arrival.
 */
function summarize(race, events) {
  const t0 = Date.parse(race.created_at);
  const paths = {};
  for (const p of PATHS) paths[p] = { sent: null, error: null, skipped: false, arrived_s: null };
  for (const e of events) {
    const p = paths[e.path];
    if (!p) continue;
    if (e.kind === 'send') { p.sent = e.ok && !e.skipped; p.skipped = !!e.skipped; p.error = e.error || null; }
    else if (e.kind === 'arrive') p.arrived_s = Math.round((Date.parse(e.at) - t0) / 100) / 10;
  }
  const arrived = PATHS.filter((p) => paths[p].arrived_s != null).sort((a, b) => paths[a].arrived_s - paths[b].arrived_s);
  return { id: race.id, at: race.created_at, reason: race.reason || null, winner: arrived[0] || null, paths };
}

module.exports = { PATHS, CODEWORD, VALID_MS, message, judgeArrival, summarize };
