'use strict';
const crypto = require('crypto');
const express = require('express');

module.exports = function (ctx) {
  const {
    cleanSaid, gated, pushAll, pushVoice, sb, sbWrite, sessionClients, settingsAll,
  } = ctx;

  // ---- A CONVERSATION IS ONE ORDERED LIST OF EVENTS ---------------------------------------------
  //
  // Everything a surface shows of a session — the watch's session page, the phone's — is this list and
  // nothing else: `prompt`, `tool`, `text` (what it says between tool calls) and `reply`, in the order
  // they happened, each with a position (`seq`, given here on arrival) and an identity (`id`). A prompt
  // queued behind a running turn and later read by the model is ONE event at two moments, same id, the
  // second occurrence marking it `seen`; a client draws it where the model took it. A prompt this
  // machine typed for a hub command carries that command's id (`cmd`, from the sender's own
  // `client_msg_id` when it had one), which is how the device that sent the words recognises them
  // coming back and replaces its own placeholder — by id, never by text.
  //
  // Before this, the same facts reached a client down two roads that were not ordered against each
  // other (the live frames, and the row plus `desk_turns`), with no identity linking them, and every
  // consumer reconstructed "what happened, in what order, have I got this already" from text and timing
  // — three of them, each with its own rules, disagreeing in thirteen places. The rule now is the same
  // three lines on every client: the next seq is appended, a gap is fetched, an old seq is ignored.
  //
  // Kept in memory per conversation, capped, and seeded on first touch from `desk_turns` (the finished
  // turns, each in the order it happened) so a cold open or a hub restart has the history; the turn in
  // flight comes back from the host (`logFrame`). `EPOCH` names this process: a client
  // holding events numbered by an earlier one sees a different epoch on the next frame and fetches the
  // list afresh, since seq starts over.
  const EPOCH = Date.now().toString(36);
  const LOG_MAX = 2000;                        // events kept per conversation
  const LOG_IDLE_MS = 24 * 3600 * 1000;        // a conversation nobody has touched this long is dropped
  const sessionLog = new Map();                // conversation -> { seq, events, touched }
  const rowConv = new Map();                   // row id -> conversation (claude_session_id, else the row id)
  const flatText = (t) => String(t || '').replace(/\s+/g, ' ').trim();
  const EVENT_KINDS = ['prompt', 'text', 'tool'];   // what a turn holds before its reply

  async function convOfRow(rowId) {
    if (rowConv.has(rowId)) return rowConv.get(rowId);
    let conv = rowId;
    try {
      const rows = await sb(`desk_sessions?id=eq.${encodeURIComponent(rowId)}&select=id,claude_session_id`);
      if (rows && rows[0]) conv = rows[0].claude_session_id || rows[0].id;
    } catch (_) { /* the row id stands in until the list names its conversation */ }
    rowConv.set(rowId, conv);
    return conv;
  }

  function sweepLogs() {
    if (sessionLog.size < 50) return;
    const cutoff = Date.now() - LOG_IDLE_MS;
    for (const [conv, log] of sessionLog) if (log.touched < cutoff) sessionLog.delete(conv);
  }

  // How many finished turns a log is seeded with, from `desk_turns` (filled by a trigger on
  // `desk_sessions`, data-layer 00105), keyed by conversation so the history survives a resume or transfer.
  const SESSION_TURNS = 10;
  async function ensureLog(conv) {
    let log = sessionLog.get(conv);
    if (log) { log.touched = Date.now(); return log; }
    log = { seq: 0, events: [], touched: Date.now() };
    sessionLog.set(conv, log);
    try {
      const turns = ((await sb(`desk_turns?conversation=eq.${encodeURIComponent(conv)}` +
        `&select=at,prompt,reply,events&order=at.desc&limit=${SESSION_TURNS}`)) || []).reverse();
      for (const t of turns) {
        // The turn in the order it happened, where it was stored that way (`storeTurn`); a turn from
        // before that has only what opened it.
        const stored = Array.isArray(t.events) ? t.events.filter((e) => e && EVENT_KINDS.includes(e.kind) && e.text) : [];
        for (const e of stored) {
          log.events.push({ seq: ++log.seq, id: e.id || crypto.randomUUID(), kind: e.kind, text: e.text, at: t.at,
                            ...(e.kind === 'prompt' ? { seen: e.seen !== false, ...(e.cmd ? { cmd: e.cmd } : {}) } : {}) });
        }
        if (!stored.length && t.prompt) log.events.push({ seq: ++log.seq, id: crypto.randomUUID(), kind: 'prompt', text: cleanSaid(t.prompt), seen: true, at: t.at });
        if (t.reply) log.events.push({ seq: ++log.seq, id: crypto.randomUUID(), kind: 'reply', text: cleanSaid(t.reply), at: t.at });
      }
    } catch (e) { console.error('[sessions] seed:', e.message); }
    sweepLogs();
    return log;
  }

  function appendEvent(conv, rowId, log, ev) {
    ev.seq = ++log.seq;
    log.events.push(ev);
    if (log.events.length > LOG_MAX) log.events.splice(0, log.events.length - LOG_MAX);
    log.touched = Date.now();
    const frame = 'event: ev\ndata: ' + JSON.stringify({ conversation: conv, session: rowId, epoch: EPOCH, ev }) + '\n\n';
    for (const res of sessionClients) { try { res.write(frame); } catch {} }
  }

  /** The events of the turn in flight: everything after the last reply. */
  function sinceLastReply(log) {
    let i = log.events.length;
    while (i > 0 && log.events[i - 1].kind !== 'reply') i--;
    return log.events.slice(i);
  }

  // THE LIST SURVIVES A RESTART BECAUSE THE HOST CAN SAY IT AGAIN.
  //
  // This list is in memory, and every deploy empties it. Seeding from `desk_turns` brings back the
  // FINISHED turns; the one in flight exists only on the machine running it, in the transcript. So a
  // host numbers a turn's events (`turn`, the turn's key, and `n`, the position in it — sessionWatch.js
  // in voice-pipeline), and this tracks how far into the current turn the list is (`log.cur`). An event
  // that is not the next one is not appended: the answer is `{ replay, have }`, and the host sends
  // everything after `have` before anything else. An event already held is ignored. Order is therefore
  // the host's, whatever was lost in between.
  //
  // `done` carries the whole turn, which covers a restart with no event after it, and is what is
  // stored: the turn as the transcript has it, not as much of it as this process happened to hear.

  /** A host's frame as the list's event, or null when it is not one or says nothing. */
  function hostEvent(e) {
    const kind = e.state === 'said' || e.state === 'queued' ? 'prompt' : EVENT_KINDS.includes(e.state) ? e.state : null;
    if (!kind) return null;
    // A thought or a dictated prompt can run to a paragraph; a tool line never needs more than 400.
    const text = cleanSaid(String(e.text || '')).slice(0, kind === 'tool' ? 400 : 20000);
    if (!text) return null;
    const ev = { id: kind === 'prompt' && typeof e.id === 'string' && e.id ? e.id.slice(0, 64) : crypto.randomUUID(), kind, text };
    if (kind === 'prompt') { ev.seen = e.state === 'said'; if (e.cmd) ev.cmd = String(e.cmd).slice(0, 64); }
    return ev;
  }

  const numbered = (e) => e && typeof e.turn === 'string' && e.turn && Number.isInteger(e.n) && e.n > 0;
  const heldOf = (log, turn) => (log.cur && log.cur.turn === turn ? log.cur.n : 0);

  /** Append a turn's numbered events past what the list holds, in the host's order. */
  function takeEvents(conv, rowId, log, turn, events) {
    let have = heldOf(log, turn);
    for (const e of events.filter((x) => x && Number.isInteger(x.n)).sort((x, y) => x.n - y.n)) {
      if (e.n <= have) continue;
      const ev = hostEvent(e);
      if (ev) appendEvent(conv, rowId, log, ev);
      have = e.n;
    }
    log.cur = { turn, n: have };
  }

  /** The turn's one-sentence summary onto its `desk_turns` row (data-layer 00133), where get_sessions reads it. */
  async function storeSummary(rowId, at, reply, summary) {
    try { await sbWrite('rpc/desk_turn_summary', 'POST', { conv: await convOfRow(rowId), turn_at: at, turn_reply: reply, turn_summary: summary }); }
    catch (e) { console.error('[sessions] store summary:', e.message); }
  }

  /** The finished turn, in order, onto its `desk_turns` row (data-layer 00118). One write a turn. */
  function storeTurn(conv, at, reply, events) {
    const stored = events.map(({ id, kind, text, seen, cmd }) => ({
      id, kind, text, ...(kind === 'prompt' ? { seen: seen !== false, ...(cmd ? { cmd } : {}) } : {}) }));
    if (!stored.length) return;
    sbWrite('rpc/desk_turn_events', 'POST', { conv, turn_at: at, turn_reply: reply, turn_events: stored })
      .catch((e) => console.error('[sessions] store turn:', e.message));
  }

  /**
   * One activity frame from a host, appended to its conversation's list as the event it is. Returns
   * what the host is told: `{ replay, have }` when the list is missing part of the turn before this.
   */
  async function logFrame(rowId, b, state, text, at) {
    const conv = await convOfRow(rowId);
    const log = await ensureLog(conv);
    const live = sinceLastReply(log);
    if (state === 'replay') {
      if (typeof b.turn === 'string' && Array.isArray(b.events)) takeEvents(conv, rowId, log, b.turn, b.events);
      return {};
    }
    if (state === 'queued' || state === 'said' || state === 'text' || state === 'tool') {
      if (numbered(b)) {
        const have = heldOf(log, b.turn);
        if (b.n > have + 1) return { replay: true, have };
        takeEvents(conv, rowId, log, b.turn, [b]);
        return {};
      }
      // A host that numbers nothing (older than the above): appended as it arrives.
      if (!text) return {};
      if (state === 'text' || state === 'tool') { appendEvent(conv, rowId, log, { id: crypto.randomUUID(), kind: state, text }); return {}; }
      appendEvent(conv, rowId, log, { id: typeof b.id === 'string' && b.id ? b.id.slice(0, 64) : crypto.randomUUID(),
                                      kind: 'prompt', text, seen: state === 'said',
                                      ...(b.cmd ? { cmd: String(b.cmd).slice(0, 64) } : {}) });
      return {};
    }
    if (state === 'done') {
      const whole = typeof b.turn === 'string' && Array.isArray(b.events);
      if (whole) takeEvents(conv, rowId, log, b.turn, b.events);
      else {
        // The tick's report of a turn end the watcher missed carries no list. A turn whose prompt never
        // came as a frame still has it here, from the host's read of the transcript.
        const prompt = typeof b.prompt === 'string' ? cleanSaid(b.prompt).slice(0, 20000) : '';
        if (prompt && !live.some((e) => e.kind === 'prompt' && flatText(e.text) === flatText(prompt))) {
          appendEvent(conv, rowId, log, { id: crypto.randomUUID(), kind: 'prompt', text: prompt, seen: true });
        }
      }
      const reply = typeof b.reply === 'string' && b.reply ? cleanSaid(b.reply).slice(0, 20000) : text;
      if (!reply) return {};
      // The watcher and the tick can both report one turn end; `at` is the turn.
      const last = log.events[log.events.length - 1];
      if (last && last.kind === 'reply' && at && last.at === at) return {};
      const turn = sinceLastReply(log);
      appendEvent(conv, rowId, log, { id: crypto.randomUUID(), kind: 'reply', text: reply, ...(at ? { at } : {}) });
      if (at) storeTurn(conv, at, reply, whole ? b.events.map(hostEvent).filter(Boolean) : turn);
    }
    return {};
  }

  gated.post('/api/session-activity', express.json({ limit: '8mb' }), async (req, res) => {   // `done` and `replay` carry a whole turn
    const b = req.body || {};
    const session = String(b.session || '');
    if (!session) return res.status(400).json({ error: 'session required' });
    // `said` is THE USER'S WORDS arriving mid-turn — a prompt typed or dictated into a session while it is
    // still working. It has to survive as its own state: collapsed into 'tool' it would be drawn as a
    // tool call, and dropped it would reach the view only when the turn ended, where it renders above
    // steps that had already happened before the user said it.
    // `said` is the user's words at the moment the model SAW them; `queued` is the user's words sent but not yet seen,
    // which a view holds apart rather than placing among steps it was never read between.
    const state = ['done', 'text', 'said', 'queued', 'summary', 'replay'].includes(b.state) ? b.state : 'tool';
    const done = state === 'done';
    // A thought or a dictated prompt can run to a paragraph; a tool line or a row's reply never needs
    // more than 400.
    const text = cleanSaid(String(b.text || '')).slice(0, ['text', 'said', 'queued'].includes(state) ? 20000 : 400);
    const at = typeof b.at === 'string' ? b.at : null;
    // THE NOTIFICATION IS A SENTENCE, and the machine that produced the reply writes it — it already
    // runs Claude, so no key lives anywhere for this. That takes seconds, and `done` cannot wait: it is
    // what stops a live view showing the caret. So the host sends `done` at once with `summary_coming`,
    // and this holds the push for the `summary` frame behind it. A host that sends no summary (or one
    // whose summariser failed) omits the flag and is notified from `done` exactly as before.
    if (state === 'summary') {
      const summary = typeof b.summary === 'string' && b.summary.trim() ? b.summary.trim() : null;
      if (text) notifySessionReply(session, text, at, summary);
      if (text && summary && at) storeSummary(session, at, text, summary);
      return res.status(204).end();          // not a step: nothing on a wall should draw it
    }
    let answer = {};
    try { answer = await logFrame(session, b, state, text, at); }
    catch (e) { console.error('[sessions] log:', e.message); }
    if (done && text && b.summary_coming !== true) notifySessionReply(session, text, at);
    res.json(answer);
  });

  // Every session's finished reply, pushed to the phone (and from there the watch) — the final message
  // of each turn, never the tool calls in between. Sent from here because both machines already report
  // every turn end to this endpoint. Keyed by the turn's reply time: the watcher can notice one turn end
  // more than once, and a restart must not buzz again for a reply already delivered (the text hash covers
  // a host that does not send `at` yet). The payload's session_id is what tapping it opens, on the phone
  // and on the watch; SESSION_REPLY is the watch's category with the Open action. Gated by the
  // Settings → Push switch. Of orchestrator replies only a flagged answer is pushed (`notifyAnswer`).
  const sentSessionReplies = new Set();
  async function notifySessionReply(sessionId, text, at, summary) {
    try {
      if (pushOff(await settingsAll())) return;
      const turn = at || crypto.createHash('sha1').update(text).digest('hex').slice(0, 16);
      const key = `session-reply:${sessionId}:${turn}`;
      if (sentSessionReplies.has(key)) return;
      sentSessionReplies.add(key);
      if (sentSessionReplies.size > 500) sentSessionReplies.delete(sentSessionReplies.values().next().value);
      const seen = await sb(`notifications?dedupe_key=eq.${encodeURIComponent(key)}&select=id&limit=1`);
      if (seen && seen.length) return;
      const [row] = (await sb(`desk_sessions?id=eq.${encodeURIComponent(sessionId)}&select=label,custom_title,repo`)) || [];
      const title = (row && (row.custom_title || row.label || row.repo)) || 'Session';
      // The sentence if there is one, the reply's opening if not. Tapping it opens that session either
      // way — the payload is what the app reads and it is unchanged.
      const body = (typeof summary === 'string' && summary.trim()) ? summary.trim() : text;
      await pushAll('session', title, body, key, { category: 'SESSION_REPLY', payload: { session_id: sessionId } });
    } catch (e) { console.error('[session-push]', e.message); }
  }

  // The Settings → Push switch, which every reply push obeys.
  function pushOff(s) {
    return s.push_enabled !== undefined
      && ['0', 'false', 'off', 'no', ''].includes(String(s.push_enabled).trim().toLowerCase());
  }

  // An orchestrator answer flagged worth reading (voice_messages.needs_read, docs/WATCH.md "Unread
  // answers") is pushed as it lands; no other orchestrator reply ever is. Titled with the user's own words, the
  // answer as the body. Once per row, by its dedupe key, however many times realtime delivers the insert.
  // VOICE_ANSWER is the category both apps register: tapping or dismissing it marks the answer read, and
  // the watch drops it unshown while home is in front with the wrist up.
  async function notifyAnswer(row) {
    // A relayed session reply is flagged too (it is in the inbox), but notifySessionReply already
    // pushed it; a second push would buzz twice for one reply.
    if (row.role !== 'assistant' || !row.needs_read || row.read_at || row.session_id) return;
    try {
      if (pushOff(await settingsAll())) return;
      const key = `voice-answer:${row.id}`;
      if ((await sb(`notifications?dedupe_key=eq.${encodeURIComponent(key)}&select=id&limit=1`)).length) return;
      const [ask] = row.request_id
        ? (await sb(`voice_messages?role=eq.user&request_id=eq.${encodeURIComponent(row.request_id)}&select=text&limit=1`)) || []
        : [];
      const words = String((ask && ask.text) || '').trim();
      const title = words.length > 80 ? words.slice(0, 79) + '…' : words || 'Hub';
      await pushAll('answer', title, String(row.text || '').slice(0, 1500), key,
        { category: 'VOICE_ANSWER', payload: { voice_message_id: row.id } });
    } catch (e) { console.error('[answer-push]', e.message); }
  }

  gated.post('/api/voice-activity', express.json(), (req, res) => {
    const b = req.body || {};
    pushVoice('activity', {
      // A thought (state 'text') can run to a paragraph; everything else is a line.
      text: String(b.text || '').slice(0, b.state === 'text' ? 2000 : 400),
      // Preserve 'working' (the command's transcript, once per command), 'done', 'text' (what the model
      // said between tool calls) and 'error' (a command
      // it could not act on, shown as a failure); everything else is a tool call. 'working' is what the TV
      // keys the heard-you pop off, so it must survive intact.
      state: ['done', 'working', 'text', 'error'].includes(b.state) ? b.state : 'tool',
      focus: String(b.focus || 'hub'),
    });
    res.status(204).end();
  });

  return { EPOCH, convOfRow, ensureLog, notifyAnswer, numbered, rowConv };
};
