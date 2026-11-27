'use strict';
// Which of the watch's log lines are FAILURES, reported to the ops responder (routes/voice.js
// /api/clientlog), and what each report says.
//
// A failure is reported by default. A line is one when the watch marks it (`level: 'error'`, which
// `Hub.fail`, Watchset's `WatchsetHost.fail` and the widget extension's door reporter all set), when it
// is the watch's `error` line, or when its name says so (`…-failed`, `…-broken`), so a new failure path
// on the watch is reported without anything here naming it. Two kinds are dropped because they are
// already reported elsewhere, never because they look harmless:
//   - `also`: the watch's transport already sent a `request-failed` line for the same error, and this is
//     the call site's line saying what the request was for (apps/Watch/Hub.swift `line`).
//   - a 5xx from the hub: the hub reported its own failure when it answered it (lib/httpfail.js).

const FAILURE_NAME = /-(failed|broken)$/;
const HUB_5XX = /status\(5\d\d\)|HTTP 5\d\d/;

const clip = (v, n = 160) => String(v == null ? '' : v).slice(0, n);

/** A watch line that is a failure → `{ message, context }` to report; anything else → null. */
function watchFailure(l) {
  if (!l || l.src !== 'watch' || typeof l.ev !== 'string') return null;
  const ev = l.ev;
  if (!(l.level === 'error' || ev === 'error' || FAILURE_NAME.test(ev))) return null;
  if (l.also) return null;
  const why = l.error ?? l.why ?? l.msg ?? '';
  if (HUB_5XX.test(String(why))) return null;
  const look = 'client_log where src=watch around that time (docs/WATCH.md)';
  const context = { at: l.t, build: l.build, look };
  let message;
  if (ev === 'error') {
    message = `watch: ${clip(l.msg || 'error', 300)}`;
  } else if (ev === 'request-failed') {
    // The path without its query, so one failing route is one incident; the whole path is in context.
    message = `watch request failed: ${l.method || 'GET'} ${String(l.path || '').split('?')[0]}: ${clip(l.error)}`;
    context.path = l.path;
  } else if (ev === 'send-failed' || ev === 'command-failed' || ev === 'live-broken') {
    message = `watch ${l.view === 'session' ? 'follow-up' : 'command'} ${ev}: ${clip(l.error)}`;
    Object.assign(context, { id: l.id, view: l.view });
  } else if (ev === 'door-read-failed' || ev === 'door-set-failed') {
    message = `watch ${l.via === 'control' ? 'door control' : 'door sheet'} ${ev === 'door-set-failed' ? 'could not set' : 'could not read'} the lock: ${clip(l.error)}`;
  } else {
    // Every other field the line carried goes with it: they are what the watch knew at that moment.
    const { src, ev: _e, t, build, level, error, why: _w, msg, page, ...rest } = l;
    message = `watch ${ev}${page ? ` (${page})` : ''}${why ? `: ${clip(why)}` : ''}`;
    if (Object.keys(rest).length) context.fields = rest;
  }
  return { message, context };
}

module.exports = { watchFailure };
