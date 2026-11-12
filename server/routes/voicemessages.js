'use strict';
// The hub conversation's history as the surfaces load it, the requests still in flight, the read mark,
// and where a context begins.
const express = require('express');
const { DAY_START_HOUR, localDate } = require('../lib/dates');
const { hearing } = require('../lib/streams');

module.exports = function (ctx) {
  const { VOICE_RESET_SENTINEL, gated, sb, sbWrite, settingsAll, settingsCached } = ctx;

  // Whether a message at `at` opens a new conversation context after one at `prev` (both epoch ms). The
  // SAME boundary the worker replays to the model (voice-pipeline `recent_context`): the hub agent is
  // handed the whole day since 4 AM in the display zone, so a new 4am-day starts a context, and so does
  // a manual reset (voice_reset_at) in between. An idle
  // gap does NOT: drawing a break at an hour of quiet hid a thread the model could still see.
  // The one rule behind both the history endpoint and the live stream.
  const DAY_MS = DAY_START_HOUR * 3600 * 1000;
  const dayOf = (t) => localDate(new Date(t - DAY_MS));
  function opensContext(prev, at, s) {
    const resetAt = Date.parse((s || {}).voice_reset_at || '');
    return dayOf(prev) !== dayOf(at)
      || (Number.isFinite(resetAt) && prev < resetAt && resetAt <= at);
  }

  // Rows written in the old coding mode (mode 'agent') are not part of the hub conversation; legacy rows
  // with no mode count as hub.
  const HUB_ROWS = 'or=(mode.is.null,mode.eq.hub)';

  // The last message time, so a live row is flagged as opening a new context by the same rule
  // /api/voice-messages applies to history. Seeded from the table at boot; a row that arrives before the
  // seed is simply not flagged.
  let lastVoiceAt = null;
  function markLive(row) {
    if ((row.focus || 'hub') !== 'hub' || !row.created_at || row.mode === 'agent') return row;
    const at = Date.parse(row.created_at), prev = lastVoiceAt;
    if (prev === null || at > prev) lastVoiceAt = at;
    return prev !== null && opensContext(prev, at, settingsCached()) ? { ...row, ctx_break: true } : row;
  }
  async function seedLastVoiceAt() {
    try {
      const r = await sb(`voice_messages?focus=eq.hub&${HUB_ROWS}&order=created_at.desc&limit=1&select=created_at`);
      if (r && r[0] && lastVoiceAt === null) lastVoiceAt = Date.parse(r[0].created_at);
    } catch (_) {}
  }
  seedLastVoiceAt();

  // Backfill recent voice_messages for a focus so the panel populates on load before live updates
  // arrive. We want the MOST RECENT `limit` turns — so fetch newest-first then reverse to oldest→newest
  // (the render order). The old asc+limit returned the OLDEST 50, hiding the recent thread. focus='hub'.
  gated.get('/api/voice-messages', async (req, res) => {
    try {
      const focus = String(req.query.focus || 'hub');
      // Every `mode` a client sends (the watch asks for 'active') reads the hub thread.
      let limit = parseInt(req.query.limit, 10);
      if (!Number.isFinite(limit) || limit <= 0) limit = 50;
      limit = Math.min(limit, 500);
      const modeFilter = `&${HUB_ROWS}`;
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
        return !!prev && opensContext(Date.parse(prev.created_at), Date.parse(r.created_at), s);
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
      // a reset or twenty newer exchanges cannot bury it (docs/WATCH.md, "The inbox").
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

  // THE INBOX (docs/WATCH.md § The inbox): every reply flagged worth reading, newest
  // first, read or not, kept for good. A row is named by its `label` (the orchestrator's few words for
  // the question, or a relayed session's job label), else by the question's own words cut short.
  // ?before=<iso> pages further back.
  async function questionsFor(rows) {
    const asks = rows.map((r) => r.request_id).filter(Boolean);
    const words = asks.length
      ? (await sb(`voice_messages?role=eq.user&request_id=in.(${asks.map(encodeURIComponent).join(',')})&select=request_id,text`) || [])
      : [];
    return new Map(words.map((w) => [w.request_id, String(w.text || '').trim()]));
  }
  const clip = (t, n) => { const s = String(t || '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
  function inboxRow(r, q) {
    return { id: r.id, at: r.created_at, read: !!r.read_at,
      label: r.label || clip(q || r.session_label || r.text, 80),
      session_id: r.session_id || null, session_label: r.session_label || null };
  }
  gated.get('/api/voice-inbox', async (req, res) => {
    try {
      let limit = parseInt(req.query.limit, 10);
      if (!Number.isFinite(limit) || limit <= 0 || limit > 200) limit = 60;
      const beforeMs = Date.parse(String(req.query.before || ''));
      const before = Number.isFinite(beforeMs) ? `&created_at=lt.${encodeURIComponent(new Date(beforeMs).toISOString())}` : '';
      const rows = await sb(`voice_messages?focus=eq.hub&role=eq.assistant&needs_read=is.true${before}&order=created_at.desc&limit=${limit}&select=id,created_at,read_at,label,request_id,session_id,session_label,text`) || [];
      const qs = await questionsFor(rows);
      res.json({ unread: rows.some((r) => !r.read_at), rows: rows.map((r) => inboxRow(r, qs.get(r.request_id))) });
    } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
  });
  // One inbox entry opened on its own: the whole question and the whole answer. A follow-up spoken from
  // it names it (`about` on /api/voice-text and /api/voice-command), and the worker hands the model both.
  gated.get('/api/voice-inbox/:id', async (req, res) => {
    try {
      const id = String(req.params.id || '');
      if (!/^[0-9a-f-]{36}$/i.test(id)) return res.status(400).json({ error: 'bad id' });
      const [r] = await sb(`voice_messages?id=eq.${id}&select=*`) || [];
      if (!r) return res.status(404).json({ error: 'not found' });
      const qs = await questionsFor([r]);
      res.json({ ...inboxRow(r, qs.get(r.request_id)), question: qs.get(r.request_id) || '', answer: r.text || '', engine: r.engine || null });
    } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
  });

  // A request as every thread view draws it before its voice_messages row exists; null for one that is not
  // the user's words to the hub conversation (another focus, the reset sentinel) or has no words yet. A row
  // queued `untranscribed` (the Mac's Whisper is doing it) is drawn as `transcribing`, like a command the
  // hub is still hearing (lib/streams.js heardStart). `always_on` marks a listener's capture, which may
  // turn out to be room noise: the watch and the phone leave those out.
  function requestView(r) {
    if ((r.focus || 'hub') !== 'hub' || r.transcript === VOICE_RESET_SENTINEL) return null;
    if (!r.transcript && r.status !== 'untranscribed') return null;
    return { id: r.id, text: r.transcript || '', status: r.transcript ? r.status : 'transcribing',
      created_at: r.created_at, ...(r.always_on ? { always_on: true } : {}) };
  }

  // Requests not yet finished, and commands still being heard: what a thread view shows ahead of their
  // rows on (re)load.
  gated.get('/api/voice-pending', async (req, res) => {
    try {
      const rows = await sb('voice_requests?focus=eq.hub&status=not.in.(done,error)&order=created_at&select=id,transcript,status,focus,created_at,always_on') || [];
      const listed = rows.map(requestView).filter(Boolean);
      const have = new Set(listed.map((r) => r.id));
      res.json(listed.concat(hearing().filter((h) => !have.has(h.id))));
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
