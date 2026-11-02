'use strict';
// The event streams that carry something other than the status frame, and the live microphone.
const livemic = require('../lib/livemic');
const { PING, dayClients, listClients, voiceClients } = require('../lib/streams');

module.exports = function (ctx) {
  const { gated } = ctx;

  // Voice SSE: streams `event: voice` frames ({kind:'message'|'focus', row}) to the /tv panel.
  // Dedicated stream (not /api/stream) so the kiosk gets voice rows without the heavy status frame.
  gated.get('/api/voice-stream', (req, res) => {
    res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache',
              Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.flushHeaders();
    voiceClients.add(res);
    const ka = setInterval(() => { try { res.write(PING); } catch {} }, 25000);
    req.on('close', () => { clearInterval(ka); voiceClients.delete(res); });
  });

  // Calendar SSE: one `event: lists` frame whenever a dated item or a list changes. Dedicated stream
  // (not /api/stream) so the standalone /calendar page does not have to take a full status frame on
  // connect just to learn about a reminder.
  gated.get('/api/list-stream', (req, res) => {
    res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache',
              Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.flushHeaders();
    listClients.add(res);
    const ka = setInterval(() => { try { res.write(PING); } catch {} }, 25000);
    req.on('close', () => { clearInterval(ka); listClients.delete(res); });
  });

  // Day SSE: a bodiless `event: nutrition` or `event: workout` frame whenever that day may have changed.
  // For a client that cannot take the full status frame on every push — the watch, which reloads the
  // page on screen when its kind arrives.
  gated.get('/api/day-stream', (req, res) => {
    res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache',
              Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.flushHeaders();
    dayClients.add(res);
    const ka = setInterval(() => { try { res.write(PING); } catch {} }, 25000);
    req.on('close', () => { clearInterval(ka); dayClients.delete(res); });
  });

  // The live microphone: a watch listening to what the phone hears (lib/livemic.js, docs/LIVE-MIC.md).
  // The phone's half is a WebSocket, attached to the server below.
  gated.get('/api/live-mic', livemic.listen);
};
