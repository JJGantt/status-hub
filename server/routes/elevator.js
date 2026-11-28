// The phone's elevator-unlock pane (public/cards/elevator.js, docs/DOOR.md): the latest stored rides, and
// the near-home trace (apps/Sources/HomeTrace.swift): its chunks in, a summary out. The live state comes
// from the app itself, not from here.
const express = require('express');
const ops = require('../lib/report');
const { chunkRow } = require('../lib/hometrace');

module.exports = function ({ gated, sb, sbWrite }) {
  // One chunk of the trace (about 30 s), stored as one home_trace row (data-layer 00221). A bad chunk is a
  // bug in the app and is reported; a failed write is ours, reported, and answered 502 so the app keeps
  // the chunk and sends it again.
  gated.post('/api/home-trace', express.json({ limit: '2mb' }), async (req, res) => {
    const { row, error } = chunkRow(req.body);
    if (error) {
      ops.report(`Near-home trace chunk refused: ${error}`, { service: 'status-hub:home-trace' });
      return res.status(400).json({ error });
    }
    try {
      await sbWrite('home_trace', 'POST', row);
      res.json({ ok: true });
    } catch (e) {
      console.error('[home-trace] storing a chunk failed:', e);
      ops.report(`Storing a near-home trace chunk failed: ${e.message || e}`, { service: 'status-hub:home-trace' });
      res.status(502).json({ error: 'failed' });
    }
  });

  // For the pane: when the last chunk arrived and how many arrived today (UTC day boundary is fine here).
  gated.get('/api/home-trace/summary', async (req, res) => {
    try {
      const last = (await sb('home_trace?select=received_at,ended_at&order=received_at.desc&limit=1'))[0] || null;
      const since = new Date(Date.now() - 24 * 3600e3).toISOString();
      const rows = await sb(`home_trace?select=id&received_at=gte.${since}`);
      res.json({ last_chunk: last ? last.received_at : null, chunks_24h: rows.length });
    } catch (e) {
      console.error('[home-trace] reading the summary failed:', e);
      res.status(502).json({ error: 'unreachable' });
    }
  });

  gated.get('/api/elevator/rides', async (req, res) => {
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 10, 1), 50);
    try {
      res.json({ rides: await sb(`elevator_rides?select=id,at,started_at,outcome,rise_m,ride_s,steps_in_ride,steps_after,unlock_ms,error&order=at.desc&limit=${limit}`) });
    } catch (e) {
      console.error('[elevator] reading rides failed:', e);
      res.status(502).json({ error: 'unreachable' });
    }
  });
};
