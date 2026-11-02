'use strict';
// The dashboard itself: the status payload, its stream, and the Claude usage windows.
const { PING, sseClients } = require('../lib/streams');

module.exports = function (ctx) {
  const { buildStatus, buildUsage, claudeUsageRow, gated } = ctx;

  gated.get('/api/status', async (req, res) => {
    try { res.json(await buildStatus()); }
    catch (e) { res.status(500).json({ error: String(e.message || e) }); }
  });

  // Server-Sent Events: push assembled status to the browser, instantly on any DB change.
  gated.get('/api/stream', async (req, res) => {
    res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache',
              Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.flushHeaders();
    sseClients.add(res);
    try { res.write('data: ' + JSON.stringify(await buildStatus()) + '\n\n'); } catch {}
    const ka = setInterval(() => { try { res.write(PING); } catch {} }, 25000);
    req.on('close', () => { clearInterval(ka); sseClients.delete(res); });
  });

  // The watch's usage page: the same two windows as the walls' hairline bars. A new reading is announced
  // as a `usage` frame on /api/day-stream.
  gated.get('/api/usage', async (req, res) => {
    try {
      const u = buildUsage(await claudeUsageRow());
      if (!u) return res.status(404).json({ error: 'no usage reading yet' });
      res.json(u);
    } catch (e) { console.error('[usage] /api/usage:', e.message); res.status(500).json({ error: e.message }); }
  });
};
