'use strict';
// Which of the watch's and the phone's log lines are FAILURES, reported to the ops responder (routes/voice.js
// /api/clientlog), and what each report says.
//
// A failure is reported by default. A line is one when the device marks it (`level: 'error'`, which the
// watch's `Hub.fail`, Watchset's `WatchsetHost.fail`, the watch widgets' door reporter and the iPhone
// app's `ClientLog.fail` all set), when it
// is the watch's `error` line, or when its name says so (`…-failed`, `…-broken`), so a new failure path
// on the watch is reported without anything here naming it. Two kinds are dropped because they are
// already reported elsewhere, never because they look harmless:
//   - `also`: the watch's transport already sent a `request-failed` line for the same error, and this is
//     the call site's line saying what the request was for (apps/Watch/Hub.swift `line`).
//   - a 5xx from the hub: the hub reported its own failure when it answered it (lib/httpfail.js).

const FAILURE_NAME = /-(failed|broken)$/;
const HUB_5XX = /status\(5\d\d\)|HTTP 5\d\d/;

const clip = (v, n = 160) => String(v == null ? '' : v).slice(0, n);

const SOURCES = new Set(['watch', 'phone']);

/** A watch or phone line that is a failure → `{ service, message, context }` to report; else null. */
function clientFailure(l) {
  if (!l || !SOURCES.has(l.src) || typeof l.ev !== 'string') return null;
  const who = l.src;
  const ev = l.ev;
  if (!(l.level === 'error' || ev === 'error' || FAILURE_NAME.test(ev))) return null;
  if (l.also) return null;
  const why = l.error ?? l.why ?? l.msg ?? '';
  if (HUB_5XX.test(String(why))) return null;
  const look = `client_log where src=${who} around that time${who === 'watch' ? ' (docs/WATCH.md)' : ''}`;
  const context = { at: l.t, build: l.build, look };
  let message;
  if (ev === 'error') {
    message = `${who}: ${clip(l.msg || 'error', 300)}`;
  } else if (ev === 'request-failed') {
    // The path without its query, so one failing route is one incident; the whole path is in context.
    message = `${who} request failed: ${l.method || 'GET'} ${String(l.path || '').split('?')[0]}: ${clip(l.error)}`;
    context.path = l.path;
  } else if (ev === 'send-failed' || ev === 'command-failed' || ev === 'live-broken') {
    message = `${who} ${l.view === 'session' ? 'follow-up' : 'command'} ${ev}: ${clip(l.error)}`;
    Object.assign(context, { id: l.id, view: l.view });
  } else if (ev === 'door-read-failed' || ev === 'door-set-failed') {
    message = `${who} ${l.via === 'control' ? 'door control' : 'door sheet'} ${ev === 'door-set-failed' ? 'could not set' : 'could not read'} the lock: ${clip(l.error)}`;
  } else {
    // Every other field the line carried goes with it: they are what the watch knew at that moment.
    const { src, ev: _e, t, build, level, error, why: _w, msg, page, ...rest } = l;
    message = `${who} ${ev}${page ? ` (${page})` : ''}${why ? `: ${clip(why)}` : ''}`;
    if (Object.keys(rest).length) context.fields = rest;
  }
  return { service: who, message, context };
}

module.exports = { clientFailure };
