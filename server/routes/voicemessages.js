'use strict';
// The hub conversation's history as the surfaces load it, the requests still in flight, the read mark,
// and where a context begins.
const express = require('express');
const { DAY_START_HOUR, localDate } = require('../lib/dates');
const { agentModeOn } = require('../lib/settings');

module.exports = function (ctx) {
  const { VOICE_RESET_SENTINEL, gated, sb, sbWrite, settingsAll, settingsCached } = ctx;

  // Whether a message at `at` opens a new conversation context after one at `prev` (both epoch ms). The
  // SAME boundary the worker replays to the model (voice-pipeline `recent_context`): the hub agent is
  // handed the whole day since 4 AM in the display zone, so a new 4am-day starts a context (hub only;
  // full-agent never resets on its own), and so does a manual reset (voice_reset_at) in between. An idle
  // gap does NOT: drawing a break at an hour of quiet hid a thread the model could still see.
  // The one rule behind both the history endpoint and the live stream.
  const DAY_MS = DAY_START_HOUR * 3600 * 1000;
  const dayOf = (t) => localDate(new Date(t - DAY_MS));
  function opensContext(prev, at, mode, s) {
    const resetAt = Date.parse((s || {}).voice_reset_at || '');
    return (mode === 'hub' && dayOf(prev) !== dayOf(at))
      || (Number.isFinite(resetAt) && prev < resetAt && resetAt <= at);
  }

  // The last message time per mode, so a live row is flagged as opening a new context by the same rule
  // /api/voice-messages applies to history. Seeded from the table at boot; a row that arrives before the
  // seed is simply not flagged.
  const lastVoiceAt = { hub: null, agent: null };
  function markLive(row) {
    if ((row.focus || 'hub') !== 'hub' || !row.created_at) return row;
    const mode = row.mode === 'agent' ? 'agent' : 'hub';
    const at = Date.parse(row.created_at), prev = lastVoiceAt[mode];
    if (prev === null || at > prev) lastVoiceAt[mode] = at;
    return prev !== null && opensContext(prev, at, mode, settingsCached()) ? { ...row, ctx_break: true } : row;
  }
  async function seedLastVoiceAt() {
    for (const [mode, filter] of [['hub', 'or=(mode.is.null,mode.eq.hub)'], ['agent', 'mode=eq.agent']]) {
      try {
        const r = await sb(`voice_messages?focus=eq.hub&${filter}&order=created_at.desc&limit=1&select=created_at`);
        if (r && r[0] && lastVoiceAt[mode] === null) lastVoiceAt[mode] = Date.parse(r[0].created_at);
      } catch (_) {}
    }
  }
  seedLastVoiceAt();

  // Backfill recent voice_messages for a focus so the panel populates on load before live updates
  // arrive. We want the MOST RECENT `limit` turns — so fetch newest-first then reverse to oldest→newest
  // (the render order). The old asc+limit returned the OLDEST 50, hiding the recent thread. focus='hub'.
  gated.get('/api/voice-messages', async (req, res) => {
    try {
      const focus = String(req.query.focus || 'hub');
      // mode=active resolves to whichever mode agent_mode selects — the watch has no settings frame to
      // read it from, and asking it to fetch one would put that rule in a second place.
      const want = String(req.query.mode || 'hub');
      const mode = want === 'active' ? (agentModeOn((await settingsAll()).agent_mode) ? 'agent' : 'hub')
        : want === 'agent' ? 'agent' : 'hub';
      let limit = parseInt(req.query.limit, 10);
      if (!Number.isFinite(limit) || limit <= 0) limit = 50;
      limit = Math.min(limit, 500);
      // Mode filter — legacy rows (mode NULL) predate the split and count as 'hub'.
      const modeFilter = mode === 'agent' ? '&mode=eq.agent' : '&or=(mode.is.null,mode.eq.hub)';
      // ?before=<iso> pages further back: the rows older than that moment (the conversation box loads
      // the previous stretch this way as the user scrolls up past the start of the current one).
      const beforeMs = Date.parse(String(req.query.before || ''));
      const before = Number.isFinite(beforeMs) ? `&created_at=lt.${encodeURIComponent(new Date(beforeMs).toISOString())}` : '';
      // One row past the limit, so the first row returned can be judged against the one before it.
      const got = (await sb(`voice_messages?focus=eq.${encodeURIComponent(focus)}${modeFilter}${before}&order=created_at.desc&limit=${limit + 1}&select=*`) || []).reverse();
      const extra = got.length > limit ? got[0] : null;
      const rows = extra ? got.slice(1) : got;
      // Where each context begins, by opensContext() — the same rule the live stream marks rows with.
      const s = await settingsAll();
      const breaks = rows.map((r, i) => {
        const prev = i > 0 ? rows[i - 1] : extra;
        return !!prev && opensContext(Date.parse(prev.created_at), Date.parse(r.created_at), mode, s);
      });
      // ?history=1 (the conversation card) → every row, the first of each context flagged so the card can
      // draw a divider there. Older contexts are the record of what the user said and what came of it; hiding
      // them made a failed command look like it had never been sent.
      if (String(req.query.history || '') === '1') {
        res.json(rows.map((r, i) => (breaks[i] ? { ...r, ctx_break: true } : r)));
        return;
      }
      // Every other surface (watch, wall) shows the current context only.
      let start = Math.max(0, breaks.lastIndexOf(true));
      const resetAt = Date.parse(s.voice_reset_at || '');
      if (Number.isFinite(resetAt) && rows.length && Date.parse(rows[rows.length - 1].created_at) < resetAt) {
        start = rows.length;   // reset since the last message: nothing belongs to the new context yet
      }
      // An answer still unread stays in however old it is, with the words that asked for it, so a gap,
      // a reset or twenty newer exchanges cannot bury it (docs/WATCH.md, "Unread answers").
      // The first row of the context keeps its flag, so a surface that pages back can draw the divider.
      const shown = rows.slice(start).map((r, i) => (i === 0 && breaks[start] ? { ...r, ctx_break: true } : r));
      const have = new Set(shown.map((r) => r.id));
      const unread = (await sb(`voice_messages?focus=eq.${encodeURIComponent(focus)}${modeFilter}&role=eq.assistant&needs_read=is.true&read_at=is.null&order=created_at.desc&limit=20&select=*`) || [])
        .filter((r) => !have.has(r.id));
      const asks = unread.map((r) => r.request_id).filter(Boolean);
      const words = asks.length
        ? (await sb(`voice_messages?role=eq.user&request_id=in.(${asks.map(encodeURIComponent).join(',')})&select=*`) || [])
        : [];
      const older = [...unread, ...words.filter((r) => !have.has(r.id))]
        .sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));
      res.json([...older, ...shown]);   // oldest→newest
    } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
  });

  // A request as the TV sidebar draws it before its voice_messages row exists; null for one that is not
  // the user's words to the hub conversation (another focus, the reset sentinel) or has no transcript yet.
  function requestView(r) {
    if ((r.focus || 'hub') !== 'hub' || !r.transcript || r.transcript === VOICE_RESET_SENTINEL) return null;
    return { id: r.id, text: r.transcript, status: r.status, created_at: r.created_at };
  }

  // Requests not yet finished: what the TV sidebar shows ahead of their rows on (re)load.
  gated.get('/api/voice-pending', async (req, res) => {
    try {
      const rows = await sb('voice_requests?focus=eq.hub&status=not.in.(done,error)&order=created_at&select=id,transcript,status,focus,created_at') || [];
      res.json(rows.map(requestView).filter(Boolean));
    } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
  });

  // An answer has been shown (the watch: on screen, wrist up, a couple of seconds). Stamped once; the
  // row's UPDATE reaches every surface through the voice stream, so the mark clears everywhere.
  gated.post('/api/voice-messages/read', express.json(), async (req, res) => {
    try {
      const id = String((req.body && req.body.id) || '');
      if (!id) return res.status(400).json({ error: 'id required' });
      await sbWrite(`voice_messages?id=eq.${encodeURIComponent(id)}&read_at=is.null`, 'PATCH', { read_at: new Date().toISOString() });
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
  });

  return { markLive, requestView };
};
