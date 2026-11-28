// A pressed recording's stream went unacknowledged (public/voiceagent.js, apps NativeRec.swift). The
// recording carries on, so every stall is an occurrence. A stall at this process's own start is the
// deploy restart that caused it and is counted under its own fingerprint, so its watch can follow how
// often the hub is deployed while the plain one stays tight for stalls the network caused.
const RESTART_WINDOW_MS = 60_000; // a deploy's restart plus the six seconds a chunk waits for its ack

function stallMessage(l, bootMs, nowMs = Date.now()) {
  const at = Date.parse(l.t);
  const when = Number.isFinite(at) ? at : nowMs;
  const restart = when >= bootMs - 15_000 && when <= bootMs + RESTART_WINDOW_MS;
  return `${l.src || 'client'} recording: the hub stopped acknowledging its stream${restart ? ' during a hub restart' : ''}; recording carried on`;
}

module.exports = { stallMessage, RESTART_WINDOW_MS };
