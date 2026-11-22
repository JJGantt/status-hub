'use strict';
// COMMANDS GETTING SLOWER IS A FAILURE, even when every one of them succeeds. Nothing throws when a
// stage that took 3s starts taking 14s — the damaged-capture probe did exactly that for days — so the
// only way to see it is to compare each command against the ones before it.
//
// Every command's stages are read from `voice_requests.timing` (HUB-INTERNALS.md § Command timing), plus
// the hub stage of a dictation, which has no row and is fed straight from /api/voice-command. When a
// stage's RECENT median (its last RECENT_N samples) is at least SLOW_RATIO times its BASELINE median
// (samples between one and fourteen days old) and at least SLOW_MIN_MS more, it is reported as an
// error, which makes the ops responder open an incident. Once per regression: it is reported again
// only after that stage has come back under RECOVER_RATIO. The thresholds are a first guess; the
// incident agent that investigates a false alarm is the one that tunes them.

const RECENT_N = 5;
const BASELINE_MIN_N = 10;
const SLOW_RATIO = 2;
const RECOVER_RATIO = 1.5;
const SLOW_MIN_MS = 1000;
const DAY = 86400000;
const BASELINE_FROM = 14 * DAY;   // oldest sample the baseline uses
const BASELINE_TO = DAY;          // the last day is "recent", never the baseline it is judged against
const KEEP = 2000;                // samples held per stage; far more than fourteen days of commands

const ms = (a, b) => {
  const x = Date.parse(a), y = Date.parse(b);
  return Number.isFinite(x) && Number.isFinite(y) && y >= x ? y - x : null;
};

// The stages of one command, as { stage: ms }. A stage is keyed by how the audio arrived, because a
// streamed command and an uploaded one take different paths through the hub.
function stagesOf(timing) {
  const t = timing || {};
  const out = {};
  if (Number.isFinite(t.hub_ms)) out[`hub:${t.audio_via || 'upload'}`] = t.hub_ms;
  const pickup = ms(t.hub_enqueued, t.worker_start);
  if (pickup != null) out.pickup = pickup;
  const first = ms(t.hub_received, t.first_output);
  if (first != null) out.first_output = first;
  return out;
}

const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b), m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

// `samples`: one stage's [{ at, ms }] oldest first. Answers { slow, recovered, recent, baseline, n }.
function judge(samples, now = Date.now()) {
  const recentS = samples.slice(-RECENT_N);
  const base = samples.slice(0, -RECENT_N)
    .filter((s) => now - s.at <= BASELINE_FROM && now - s.at >= BASELINE_TO).map((s) => s.ms);
  const recent = recentS.length === RECENT_N ? median(recentS.map((s) => s.ms)) : null;
  const baseline = base.length >= BASELINE_MIN_N ? median(base) : null;
  if (recent == null || baseline == null) return { slow: false, recovered: false, recent, baseline, n: base.length };
  return {
    slow: recent >= baseline * SLOW_RATIO && recent - baseline >= SLOW_MIN_MS,
    recovered: recent < baseline * RECOVER_RATIO,
    recent, baseline, n: base.length,
  };
}

function makeTracker({ report = (msg) => console.error(msg), now = () => Date.now() } = {}) {
  const series = new Map();   // stage → [{ at, ms }] oldest first
  const flagged = new Set();  // stages reported and not yet recovered
  const seenIds = new Set();  // a request's update arrives more than once

  function add(stage, at, value) {
    const s = series.get(stage) || [];
    s.push({ at, ms: value });
    if (s.length > KEEP) s.splice(0, s.length - KEEP);
    series.set(stage, s);
  }
  function check(stage) {
    const v = judge(series.get(stage) || [], now());
    if (v.slow && !flagged.has(stage)) {
      flagged.add(stage);
      report(`[latency] voice commands are slower: ${stage} median ${Math.round(v.recent)}ms over the last ` +
        `${RECENT_N}, against ${Math.round(v.baseline)}ms normally (${v.n} commands, 1-14 days old)`);
    } else if (flagged.has(stage) && v.recovered) {
      flagged.delete(stage);
      console.log(`[latency] ${stage} is back to normal: ${Math.round(v.recent)}ms against ${Math.round(v.baseline)}ms`);
    }
  }
  return {
    // History, oldest first, without judging it: what the process was started into.
    seed(rows) {
      for (const r of rows) {
        if (!r || !r.id || seenIds.has(r.id)) continue;
        const st = stagesOf(r.timing);
        if (!st.first_output && !Object.keys(st).some((k) => k.startsWith('hub:'))) continue;
        seenIds.add(r.id);
        const at = Date.parse(r.created_at) || now();
        for (const [k, v] of Object.entries(st)) add(k, at, v);
      }
    },
    // A voice_requests row as realtime delivers it. Counted once, when the worker has stamped its first
    // output (the run is far enough along that every stage is known).
    request(row) {
      if (!row || !row.id || seenIds.has(row.id) || !row.timing || !row.timing.first_output) return;
      seenIds.add(row.id);
      if (seenIds.size > KEEP * 4) seenIds.clear();
      const st = stagesOf(row.timing);
      for (const [k, v] of Object.entries(st)) add(k, now(), v);
      for (const k of Object.keys(st)) check(k);
    },
    // A dictation's hub stage, which writes no row.
    sample(stage, value) { add(stage, now(), value); check(stage); },
    _series: series,
  };
}

// The hub's one tracker: fed by realtime (lib/realtime.js) and by dictations (routes/voice.js).
const latency = makeTracker();

module.exports = { latency, stagesOf, judge, makeTracker, RECENT_N, BASELINE_MIN_N, SLOW_RATIO, SLOW_MIN_MS };
