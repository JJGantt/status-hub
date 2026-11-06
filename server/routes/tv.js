'use strict';
const express = require('express');

module.exports = function (ctx) {
  const { PING, gated, putSetting, sb, sbWrite, sessionClients } = ctx;

  // Session SSE: one `event: session` frame per tool call or finished turn, from either machine.
  // ---- THE BEDROOM TV (google-tv repo, docs/VOICE.md) ----------------------------------------------
  // A command is a tv_commands row (the data MCP's `tv` tool writes it). The hub is subscribed to inserts
  // (startRealtime) and pushes each to the TV's companion app, which holds this stream open; the app does
  // it and posts the outcome to /api/tv/result, which fills the row, and the tool awaiting that update
  // returns it. The app authenticates with the hub's device token, like the kiosk.
  const tvClients = new Set();
  // A command older than this is not replayed to a TV that connects late: "volume up" an hour after it
  // was said is not what the user asked for. Long enough to cover a wake: the Pi's Wake-on-LAN, the screen
  // coming on, and the app's link reconnecting (google-tv docs/POWER.md).
  const TV_REPLAY_MS = 60 * 1000;
  // Ops that make sense to wake the TV for. While it is off the app is not connected, so these are held
  // for the replay on connect rather than failed; the Pi, subscribed to the same inserts, wakes the TV.
  const TV_WAKE_OPS = new Set(['open', 'launch', 'input']);
  // Done by the Pi over adb (power, its sleep timer, and remote keys, which an app cannot inject), never by the app, so
  // the hub leaves the row to it.
  const TV_PI_OPS = new Set(['power', 'key', 'sleep']);
  // The sidebar's look, kept as settings so a size chosen once holds until changed (§ The TV sidebar).
  // All three are the page's business, delivered on the sessions frame it already holds.
  const TV_SIDEBAR_FONT = 17;     // px, the page's base size
  const TV_SIDEBAR_WIDTH = 0.35;  // the panel's minimum, fraction of the screen
  async function tvPush(row) {
    if (!row || row.done_at || TV_PI_OPS.has(row.op)) return;
    if (row.op === 'sidebar') {
      const a = row.args = row.args || {};
      const put = (k, v) => putSetting(k, v).catch((e) => console.error('[tv] sidebar', k, e.message || e));
      if (a.view === 'session' || a.view === 'orchestrator') put('tv_sidebar_view', a.view);
      if (Number(a.font_size) > 0) put('tv_sidebar_font', Number(a.font_size));
      if (Number(a.width) > 0) put('tv_sidebar_width', Number(a.width));
      // The app's window spans the screen, see-through; the page draws the panel at the stored width as
      // a minimum and widens it to fit a long response.
      a.width = 1;
    }
    const frame = 'event: cmd\ndata: ' + JSON.stringify({ id: row.id, op: row.op, args: row.args || {} }) + '\n\n';
    for (const c of tvClients) { try { c.write(frame); } catch {} }
    if (!tvClients.size && !TV_WAKE_OPS.has(row.op)) {
      // Nobody to do it: answer the row now so the caller is not left waiting for the timeout.
      sbWrite(`tv_commands?id=eq.${row.id}`, 'PATCH',
        { done_at: new Date().toISOString(), result: { ok: false, error: 'the TV is off (its app is not connected)' } }).catch((e) => console.error('[tv] answer', e.message || e));
    }
  }
  gated.get('/api/tv/stream', async (req, res) => {
    res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache',
              Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.flushHeaders();
    tvClients.add(res);
    console.log(`[tv] connected (${tvClients.size})`);
    const ka = setInterval(() => { try { res.write(PING); } catch {} }, 25000);
    req.on('close', () => { clearInterval(ka); tvClients.delete(res); console.log(`[tv] disconnected (${tvClients.size})`); });
    try {
      const since = new Date(Date.now() - TV_REPLAY_MS).toISOString();
      for (const row of await sb(`tv_commands?done_at=is.null&created_at=gte.${since}&order=created_at`)) await tvPush(row);
    } catch {}
  });
  gated.post('/api/tv/result', express.json({ limit: '64kb' }), async (req, res) => {
    const id = String((req.body || {}).id || '');
    if (!/^[0-9a-f-]{36}$/i.test(id)) return res.status(400).json({ error: 'id required' });
    try {
      await sbWrite(`tv_commands?id=eq.${id}`, 'PATCH', { done_at: new Date().toISOString(), result: (req.body || {}).result ?? null });
      res.json({ ok: true });
    } catch (e) { res.status(502).json({ error: String(e.message || e) }); }
  });

  // The TV Guide's shelves (google-tv docs/GUIDE.md; data-layer tvGuide.ts writes them). The app reads
  // this whenever the screen comes up and on a `guide_refresh` command, which the tool sends after a write.
  gated.get('/api/tv/guide', async (req, res) => {
    try {
      const rows = await sb('tv_shelves?select=id,title,tv_shelf_items(id,title,image,url,package,position)'
        + '&order=position&tv_shelf_items.order=position');
      res.json({ shelves: rows.map((s) => ({ id: s.id, title: s.title,
        items: s.tv_shelf_items.map(({ position, ...it }) => it) })) });
    } catch (e) {
      console.error('[tv] guide', e.message || e);
      res.status(502).json({ error: String(e.message || e) });
    }
  });

  gated.get('/api/session-stream', (req, res) => {
    res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache',
              Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.flushHeaders();
    sessionClients.add(res);
    const ka = setInterval(() => { try { res.write(PING); } catch {} }, 25000);
    req.on('close', () => { clearInterval(ka); sessionClients.delete(res); });
  });

  return { TV_SIDEBAR_FONT, TV_SIDEBAR_WIDTH, tvPush };
};
