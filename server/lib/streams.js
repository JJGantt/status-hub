'use strict';
// The server-sent-event client pools, the heartbeat every stream sends, and the pushes that reach them.
// The routes that open these streams are routes/status.js (/api/stream) and routes/streams.js.

// SSE heartbeat, on every stream. It has to be a NAMED EVENT rather than the `: keepalive` comment
// it used to be, because a comment is invisible to the client: EventSource surfaces no callback for
// one, so the page cannot tell a silent-but-healthy stream from a dead one. A `ping` event is the
// same cost on the wire and lets shared.js judge liveness by whether frames actually arrive — which
// matters most on the voice and list streams, where hours can legitimately pass with no data.
// No existing consumer sees it: named events never reach `onmessage` or an unrelated addEventListener.
const PING = 'event: ping\ndata: {}\n\n';

const sseClients = new Set();
// Separate SSE pool for the /tv voice-conversation panel — these get raw voice_messages /
// voice_focus rows, not the assembled status frame, so they don't carry the heavy status payload.
const voiceClients = new Set();
// Third pool, same reasoning as the voice one: the calendar surfaces need to know that a dated item
// changed, and nothing else. They are not on the status frame (they render none of it) and building
// one to say "something moved" would ship the whole dashboard to a page showing a month grid.
const listClients = new Set();
// Wall clients watching live session activity. Its own channel, like listClients: a wall wants tool
// calls the instant they happen and nothing else, so it should not take a full status frame to get
// them, and the standalone pages should not receive them at all.
const sessionClients = new Set();
// /api/day-stream clients: told, with a bodiless `nutrition` or `workout` frame, when that day may have
// changed. Every path that can change one already dirties its day cache, so that is where they fire.
const dayClients = new Set();
function pushDay(kind) {
  for (const c of dayClients) { try { c.write(`event: ${kind}\ndata: {}\n\n`); } catch {} }
}

// Push a single voice event to every /tv client. Shape: { kind, row }. Kinds:
//   'message'  — a voice_messages row (append/update the conversation)
//   'request'  — a hub request before its conversation row exists (requestView, and heardStart above)
// (Transient 'activity'/'reset' events are pushed directly from the worker via /api/voice-activity.)
// The browser keys off kind.
function pushVoice(kind, row) {
  const frame = 'event: voice\ndata: ' + JSON.stringify({ kind, row }) + '\n\n';
  for (const res of voiceClients) { try { res.write(frame); } catch {} }
}

// A COMMAND THE HUB IS HEARING BUT HAS NOT ENQUEUED YET. From the moment /api/voice-command starts taking a
// pressed command's audio until its voice_requests row exists there is nothing in the database to show,
// and on the watch that stretch (the audio arriving, then transcription) is the longest wait in the
// whole command. So the hub announces it itself, as a `request` frame with no text and status
// `transcribing`, and every thread view draws a placeholder for it; the same request id then carries the
// transcript (`heardEnd` with the row's view) or, when nothing was enqueued, status `dropped`.
// `cmid` is the sender's client_msg_id, which is how the device that recorded it knows the frame is its own.
// Held here as well so /api/voice-pending can list them for a view that (re)loads mid-transcription.
const heard = new Map();   // request id -> its view
function heardStart(view) { heard.set(view.id, view); pushVoice('request', view); }
function heardEnd(id, view) {
  const was = heard.get(id);
  if (!was) return;
  heard.delete(id);
  pushVoice('request', view ? { ...view, cmid: was.cmid } : { id, cmid: was.cmid, text: '', status: 'dropped' });
}
const hearing = () => [...heard.values()];

// Tell every open calendar surface that dated items changed, so it re-reads /api/calendar. The
// signal carries no payload on purpose: what each surface needs back differs (the wall wants
// `calendar_months` months plus today's timeline, the phone wants whichever month it has paged to),
// so the fetch that follows is the only thing that knows what to ask for.
// `quiet` names an item that must stop ringing NOW (stopped, snoozed or deleted), so a ringer can go
// silent on the frame itself instead of after re-reading the feed, which can take seconds.
function pushLists(data = {}) {
  const frame = `event: lists\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of listClients) { try { res.write(frame); } catch {} }
}

module.exports = { PING, sseClients, voiceClients, listClients, sessionClients, dayClients, pushDay, pushVoice, pushLists,
  heardStart, heardEnd, hearing };
