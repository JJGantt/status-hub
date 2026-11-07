'use strict';
const { NOTHING_SAID } = require('../lib/transcribe');
const { unconfirmedThread } = require('../lib/outcomes');
const crypto = require('crypto');
const express = require('express');

module.exports = function (ctx) {
  const {
    DESK_STALE_S, EPOCH, TV_SIDEBAR_FONT, TV_SIDEBAR_WIDTH, cleanSaid, convOfRow, ensureLog, gated, liveLine,
    markSeen, numbered, rowConv, sb, sbInsert, sbWrite, seedLaunch, seenMsgIds, sessionClients, settingsAll, pendingPrompt,
  } = ctx;

  // ---- desk control: repo picker -> a fresh Claude session on the Mac ----
  // This server can't touch the Mac (it's on Fly), so it only reads what the Mac's orchestrator
  // publishes and enqueues work for it: `repos` is scanned + written there, `desk_commands` is
  // drained there. See voice-pipeline/orchestrator.
  // 'fly' is the last-resort session machine (voice-pipeline fly-desk/), which only data-layer's
  // startSession sends work to. It is stopped almost always, so "awake" means it answered a wake request:
  // Fly's proxy starts it and holds the request until its host is listening.
  const DESK_WORKER = { pi: 'pi-desk', mac: 'desk', fly: 'fly-desk' };
  const MACHINE_NAME = { pi: 'Pi', mac: 'Mac', fly: 'Fly machine' };
  const MACHINE_COLOR = { mac: '#7d848f', pi: '#4fae72', fly: '#9a7fe0' };
  const machineOf = (worker) => (worker === 'desk' ? 'mac' : worker === 'fly-desk' ? 'fly' : 'pi');

  /** Is the machine that would run this actually beating right now? */
  async function machineAwake(machine) {
    if (machine === 'fly') {
      try { return (await fetch('https://jared-desk-fly.fly.dev/wake', { signal: AbortSignal.timeout(45000) })).ok; }
      catch { return false; }
    }
    try {
      const rows = await sb(`worker_presence?worker=eq.${DESK_WORKER[machine]}&select=last_seen`);
      const t = rows?.[0]?.last_seen;
      return !!t && (Date.now() - new Date(t).getTime()) / 1000 <= DESK_STALE_S;
    } catch { return false; }   // cannot tell → treat as down, and keep the command rather than lose it
  }

  /**
   * Keep a command that could not run.
   *
   * A dispatched prompt is often minutes of dictated speech that cannot be repeated, so a machine
   * being asleep must never silently swallow one: the payload is parked, and the caller is told it did
   * not run. Deliberately not a retry queue — see migration 00067.
   */
  async function deadLetter(kind, payload, machine, reason) {
    const id = crypto.randomUUID();
    const ok = await sbInsert('desk_dead_letters',
      { id, kind, payload, machine, reason, source: 'hub' });
    return ok ? id : null;
  }

  gated.get('/api/repos', async (req, res) => {
    try {
      const [repos, presence] = await Promise.all([
        sb('repos?select=path,name,branch,dirty,last_active&order=last_active.desc.nullslast'),
        sb('worker_presence?worker=in.(desk,pi-desk)&select=worker,last_seen'),
      ]);
      const fresh = (w) => {
        const row = (presence || []).find((p) => p.worker === w);
        const t = row && row.last_seen;
        return !!t && (Date.now() - new Date(t).getTime()) / 1000 <= DESK_STALE_S;
      };
      // Reported per machine so each button can be enabled on its own: the Pi is nearly always up while
      // the Mac sleeps, and one `online` flag could not express that.
      const desk = { online: fresh('desk'), seen: ((presence || []).find((p) => p.worker === 'desk') || {}).last_seen || null };
      res.json({ repos: repos || [], desk, machines: { mac: fresh('desk'), pi: fresh('pi-desk') } });
    } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
  });

  // Live and parked Claude sessions on the Pi. This is the ambient indicator: what is being worked on,
  // and on which repo — answered by selecting rows rather than by any separate bookkeeping.
  // When a session last did something: its last turn boundary (`active_at` — a prompt sent or a turn
  // finished), falling back for rows written before that column existed. Sessions are ordered, numbered
  // and focused by it everywhere. Not `last_seen`, which every reconcile tick touches (the list would
  // reshuffle every 30s), and not `started`, which kept a session in use below newer idle ones.
  const sessionActivity = (s) => new Date(s.active_at || s.reply_at || s.started).getTime();
  const byActivity = (a, b) => sessionActivity(b) - sessionActivity(a);

  // The session payload every surface renders — built in one place so the endpoint and the push cannot
  // drift into disagreeing about what a session list is.
  //
  // THE SURFACES DO NOT POLL THIS. `desk_sessions`, `desk_queue` and `desk_pins` are in the realtime
  // publication (data-layer migration 00104), so a change to any of them pushes a fresh payload the
  // moment it happens; a client's own fetch is only the net under a dropped frame or a deaf socket.
  // An ops-responder incident run, drawn as an alert rather than as ordinary work on every surface that
  // shows a session — the lists AND the open session. The responder labels every session it dispatches
  // `Incident: <title>` (health/responder/server.js `dispatch`), and every launcher carries the label
  // across resumes and moves, so the label is the mark.
  const isIncident = (s) => /^Incident: /.test((s && s.label) || '');
  // A session running on Codex rather than Claude (desk_sessions.agent, data-layer 00148), drawn blue on
  // every surface that marks an incident red, so it is plain at a glance that Claude is not doing the work.
  // An incident outranks it: one row carries one alert, and the red one is the louder fact.
  const isCodex = (s) => !!s && s.agent === 'codex' && !isIncident(s);

  async function buildSessions({ brief: allBrief = false } = {}) {
    // The NUMBER the user says out loud, the PINS and the SHOWN session (`focus`: the most recently pinned,
    // else the most recently active running one — what a wall's reply column shows) are
    // desk_sessions_state() in Postgres (data-layer 00164), the one definition the voice tools read too.
    // Pins are a set and head the list; each row says whether it is one. `pinned` says the shown session
    // is a pin rather than automatic.
    const [sessions, queue, state] = await Promise.all([
      sb('desk_sessions?select=*&order=last_seen.desc'),
      sb('desk_queue?claimed=is.null&select=*&order=created.asc'),
      sb('rpc/desk_sessions_state'),
    ]);
    for (const s of sessions || []) rowConv.set(s.id, s.claude_session_id || s.id);
    const focus = (state && state.focus && state.focus.session_id) || null;
    const pinned = !!(state && state.focus && state.focus.pinned);
    const pins = new Set((state && state.pins) || []);
    const numbers = (state && state.numbers) || {};
    const numbered = new Map(Object.entries(numbers));
    // One row per conversation, in number order: the rows that have a number.
    // Less the ones the user dismissed (`hide`, below) — but only while nothing newer has happened in
    // them, so a new prompt or reply brings one back without anyone un-hiding it. The voice tools read
    // desk_sessions themselves and never see this filter: hiding is for the surfaces, not the orchestrator.
    const hidden = (s) => !!s.hidden_at && Date.parse(s.hidden_at) >= sessionActivity(s);
    const listed = (sessions || []).filter((s) => numbered.has(s.id) && !hidden(s)).sort((a, b) => numbered.get(a.id) - numbered.get(b.id));
    // Only the fields something renders. A desk_sessions row carries transcript paths, command ids and
    // five timestamps that no surface here reads — 97 rows of them was most of what was left of this
    // response after the replies came out of it. Adding a field to a session view means adding it here.
    const withN = (s) => ({
      id: s.id, n: numbered.get(s.id) || null,
      label: s.label, custom_title: s.custom_title, repo: s.repo,
      // Only a running session can be mid-turn. A parked row can still say `working` if whatever parked
      // it forgot to clear it, and then the sweep runs on a session that has nothing to show.
      worker: s.worker, status: s.status, working: s.status === 'resident' && !!s.working,
      // What a turn in flight is on right now — its newest tool call, the text between two, or the prompt
      // it started from — so a list opened mid-turn says that rather than the reply to the turn before.
      live: s.status === 'resident' && s.working ? liveLine(s.claude_session_id || s.id) : null,
      claude_session_id: s.claude_session_id,      // presence of a transcript = the transfer button
      // The last prompt or reply — the same instant the list is ordered by, so the times read down in order.
      at: new Date(sessionActivity(s)).toISOString(),
      // UNREAD: a final reply has landed and nobody has opened it since. Tool calls and thoughts do not
      // set `reply_at`, so this marks a finished answer and nothing else — which is the only thing on a
      // session that is actually owed attention. Decided here rather than in the cards because three
      // surfaces draw these rows, and a rule they each re-derive is one they will disagree about.
      unread: !!s.reply_at && (!s.seen_at || Date.parse(s.reply_at) > Date.parse(s.seen_at)),
      incident: isIncident(s),
      codex: isCodex(s),
      // Which machine holds it, as the colour of the thin bar on the right of every row. Decided here so
      // the phone, the walls and the watch paint one colour: gray for the Mac (the common case, so it
      // reads as the default), green for the Pi, violet for Fly — none of them amber, red, blue or white,
      // which the unread edge, incidents, Codex and the focus already mean.
      pinned: pins.has(s.id),
      // A permission dialog it is stopped on, `{ id, line }` (routes/prompts.js): every session view
      // offers Approve / Deny while it is here, and every row marks it.
      prompt: pendingPrompt(s.id),
      machine: machineOf(s.worker),
      machine_color: MACHINE_COLOR[machineOf(s.worker)],
    });
    // One line of what the session last said, for the rows that only ever show one line. The repos
    // pane cuts `last_reply` to 90 characters for every row it lists; sending the whole reply so it
    // can be thrown away cost 155KB of a 242KB response over 95 parked sessions, which is most of
    // what a phone downloads on a cold load.
    const SAY = 120;
    const say = (s) => cleanSaid(s.last_reply || s.last_prompt || '').replace(/\s+/g, ' ').slice(0, SAY);
    // A turn in flight says what it is on now (`live`), the same line the phone's rows draw.
    const brief = (s) => { const w = withN(s); return { ...w, say: w.live ? w.live.text.slice(0, SAY) : say(s) }; };
    // The whole reply goes only to rows something can render in full: everything resident, plus the
    // most recently active parked one, which is what the home wall falls back to when nothing runs.
    // Cleaned the same way `say` is: the two are the same field, and a reply is not where the two
    // patterns above are expected, but a client showing the whole reply should never be the one place
    // that regresses if one ever does match a reply.
    // `?brief=1` (the watch) gets every row as `brief`: it draws one line per row and opens a session
    // through `/api/sessions/:id`, so a whole reply here is bytes it decodes past.
    const full = allBrief ? brief : (s) => ({ ...brief(s), last_reply: cleanSaid(s.last_reply) });
    const evicted = listed.filter((s) => s.status === 'evicted').sort(byActivity);
    return {
      // Resident = running now, reachable over Remote Control. Evicted = closed to free the machine
      // but resumable with full context, which is the distinction the panel has to make obvious.
      resident: listed.filter((s) => s.status === 'resident').sort(byActivity).map(full),
      evicted: evicted.map((s, i) => (i === 0 ? full(s) : brief(s))),
      queued: queue || [],
      focus,
      pinned,
      // What the bedroom TV's sidebar shows (§ The TV sidebar): the focused session, or the voice
      // orchestrator's conversation. Here so the sidebar learns a change from the frame it already holds.
      sidebar_view: ['orchestrator', 'content'].includes((await settingsAll()).tv_sidebar_view) ? (await settingsAll()).tv_sidebar_view : 'session',
      // What the agent put on the panel, shown when sidebar_view is `content`.
      sidebar_content: String((await settingsAll()).tv_sidebar_content || ''),
      sidebar_font: Number((await settingsAll()).tv_sidebar_font) || TV_SIDEBAR_FONT,
      sidebar_width: Number((await settingsAll()).tv_sidebar_width) || TV_SIDEBAR_WIDTH,
      // The build, so a page that holds only this stream (the TV sidebar) reloads on a deploy, as every
      // page holding the status frame already does.
      commit: process.env.COMMIT || 'dev',
    };
  }

  // Opening a session's conversation is what reads its reply. Stamped from whichever surface opened it,
  // because the list is one list — reading an answer on the phone means it has been read, and the wall
  // should stop flagging it.
  gated.post('/api/sessions/seen', express.json(), async (req, res) => {
    try {
      const id = String((req.body && req.body.id) || '');
      if (!id) return res.status(400).json({ error: 'id required' });
      await sbWrite(`desk_sessions?id=eq.${encodeURIComponent(id)}`, 'PATCH', { seen_at: new Date().toISOString() });
      res.json({ ok: true });
      pushSessions();   // the mark clears on every open list, not just the one that read it
    } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
  });

  gated.get('/api/sessions', async (req, res) => {
    try { res.json(await buildSessions({ brief: req.query.brief === '1' })); }
    catch (e) { res.status(500).json({ error: String(e.message || e) }); }
  });

  // One `event: sessions` frame carrying the whole payload, to the wall pool.
  //
  // COALESCED on purpose: opening a session writes `desk_sessions` and `desk_queue`
  // within a few milliseconds of each other, and a frame per change would build and ship the same
  // payload three times. Skipped entirely when nobody is watching, so a dark TV costs nothing.
  let sessionsPushTimer = null;
  function pushSessions() {
    if (!sessionClients.size || sessionsPushTimer) return;
    sessionsPushTimer = setTimeout(async () => {
      sessionsPushTimer = null;
      if (!sessionClients.size) return;
      let payload;
      try { payload = await buildSessions(); }
      catch (e) { console.error('[sessions] push build failed:', e.message); return; }
      const frame = 'event: sessions\ndata: ' + JSON.stringify(payload) + '\n\n';
      for (const res of sessionClients) { try { res.write(frame); } catch {} }
    }, 150);
  }

  // Where words for a session's CONVERSATION should go right now. A resume makes a new row and leaves the
  // parked one parked, and `claude --resume` keeps the conversation's id — so it is the conversation,
  // not the row, that has to be asked about. Resuming one that is already running again would start a
  // second process on one transcript, which forks it (SESSIONS.md, one writer). Both machines stamp a
  // resumed row with the resume command's id, and the Pi publishes its conversation id at launch, so
  // every case below is an exact lookup rather than a guess.
  //   { live }    running now — this row, or the one a resume made: type into it
  //   { opening } a resume is still starting, or queued for a Pi slot: nothing to type into yet
  //   { parked }  nothing running: resume it
  async function conversationNow(row) {
    if (row.status === 'resident') return { live: row };
    const cid = row.claude_session_id;
    if (cid) {
      const live = await sb(`desk_sessions?claude_session_id=eq.${encodeURIComponent(cid)}&status=eq.resident&select=id,worker,status&limit=1`);
      if (live && live.length) return { live: live[0] };
      const queued = await sb(`desk_queue?resume_id=eq.${encodeURIComponent(cid)}&select=id&limit=1`);
      if (queued && queued.length) return { opening: true };
    }
    const cmds = await sb(`desk_commands?kind=eq.resume_session&payload->>session=eq.${encodeURIComponent(row.id)}` +
      '&select=id,status&order=created.desc&limit=1');
    const last = cmds && cmds[0];
    if (last && (last.status === 'pending' || last.status === 'running')) return { opening: true };
    if (last && last.status === 'done') {
      const made = await sb(`desk_sessions?command_id=eq.${encodeURIComponent(last.id)}&status=eq.resident&select=id,worker,status&limit=1`);
      if (made && made.length) return { live: made[0] };
    }
    return { parked: row };
  }

  // Conversations already reported for opening with nothing from the host (lib/outcomes unconfirmedThread), so one stays one incident.
  const reportedEmpty = new Set();

  // One session in full, for a surface that shows a single session rather than the list — the watch's
  // session page and the phone's (openSession in cards/repos.js). `/api/sessions` sends most parked
  // sessions' replies only as the one-line `say`. The conversation itself is `events` (see above).
  gated.get('/api/sessions/:id', async (req, res) => {
    try {
      const rows = await sb(`desk_sessions?id=eq.${encodeURIComponent(String(req.params.id))}` +
        '&select=id,label,custom_title,repo,worker,status,working,claude_session_id,last_prompt,last_reply,reply_at,agent,started,prompt,command_id');
      if (!rows || !rows.length) return res.status(404).json({ error: 'no such session' });
      // `prompt` is the launch prompt; the payload's `prompt` is the waiting permission dialog.
      const { started, prompt: launch_prompt, command_id, ...row } = rows[0];
      if (row.last_prompt) row.last_prompt = cleanSaid(row.last_prompt);
      const conv = row.claude_session_id || row.id;
      rowConv.set(row.id, conv);
      const log = await ensureLog(conv);
      seedLaunch(conv, row.id, log, launch_prompt, command_id);
      if (!reportedEmpty.has(conv) && unconfirmedThread({ ...row, started, launch_prompt }, log.events)) {
        reportedEmpty.add(conv);
        console.error(`[sessions] ${row.id} opened with nothing from its host in the thread (conversation ${conv})`);
      }
      res.json({ ...row, incident: isIncident(row), codex: isCodex(row), prompt: pendingPrompt(row.id), epoch: EPOCH, events: log.events });
    } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
  });

  // The list, or the part of it after `since` — what a client fetches when a frame's seq shows a gap.
  gated.get('/api/sessions/:id/events', async (req, res) => {
    try {
      const conv = await convOfRow(String(req.params.id));
      const log = await ensureLog(conv);
      const since = Number(req.query.since);
      const events = Number.isFinite(since) && since > 0 ? log.events.filter((e) => e.seq > since) : log.events;
      res.json({ epoch: EPOCH, conversation: conv, events });
    } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
  });

  // Appended to a follow-up sent in speak mode. Written for the model, not shown to anyone: the tag is
  // stripped from the prompt everywhere it is displayed.
  const SPEAK_NOTE = '<speak-mode>This reply will be read aloud on his watch. Keep it complete, but as succinct as the content allows, and written for the ear: no tables, code blocks, file paths or URLs unless they are the answer. Do not summarise away anything he needs.</speak-mode>';

  // Words for a session, given any row of its conversation: typed into it while it runs, resumed with
  // them while it is parked, moved to an awake machine with them when its own is asleep. The phone's
  // follow-up route and CI failures (routes/ci.js) both send through this.
  async function followUpSession(row, { text = '', attachments = [], spoken = false, msgId = '', seenKey = '' } = {}) {
    const reply = (status, body) => ({ status, body });
    const now = await conversationNow(row);
    if (now.opening) return reply(409, { error: 'that session is still opening' });
    const target = now.live || now.parked;
    if (!now.live && !target.claude_session_id) {
      return reply(409, { error: 'that session has no conversation to resume' });
    }
    const machine = machineOf(target.worker);
    const kind = now.live ? 'follow_up' : 'resume_session';
    // Speak mode on the watch (docs/WATCH.md § Speak mode): the reply will be read aloud, so the
    // session is asked to answer for the ear. One line, since it is typed into a terminal, and in a
    // tag that resolvePrompt (voice-pipeline transcripts.js) strips, so every surface shows the user's words.
    const prompt = spoken && text ? `${text} ${SPEAK_NOTE}` : text;
    const payload = { session: target.id, prompt, target: machine,
                      ...(attachments.length ? { attachments } : {}),
                      // The sender's own message id, which the host stamps on the prompt these words
                      // become (sessionWatch.js `expectPrompt`), so the sender can replace its
                      // placeholder for them by id when they come back as an event.
                      ...(msgId ? { msg: msgId } : {}) };
    if (!(await machineAwake(machine))) {
      // The words are for the SESSION, not the machine: with its machine asleep (a closed laptop),
      // the conversation moves to the other machine from what was mirrored and is resumed there with
      // them as its next prompt — data-layer's followUpElsewhere, and the two have to agree.
      // `now.live` carries only id/worker/status; the conversation's own fields are on the full row.
      const conv = { ...row, ...target };
      // The other home machine first, then Fly, the last resort; waking Fly is the slow check.
      let dest = null;
      if (conv.claude_session_id && conv.agent !== 'codex') {
        const order = machine === 'mac' ? ['pi', 'fly'] : machine === 'pi' ? ['mac', 'fly'] : ['pi', 'mac'];
        for (const m of order) if (await machineAwake(m)) { dest = m; break; }
      }
      if (dest) {
        const cmdId = crypto.randomUUID();
        await sbWrite('desk_commands', 'POST', { id: cmdId, kind: 'resume_mirrored',
          payload: { target: dest, claude_session_id: conv.claude_session_id, repo: conv.repo,
                     label: conv.label || null, origin: conv.origin || 'dispatched', from: machine,
                     prompt, ...(attachments.length ? { attachments } : {}), ...(msgId ? { msg: msgId } : {}) } });
        await sbWrite(`desk_sessions?id=eq.${encodeURIComponent(target.id)}`, 'PATCH',
          { status: 'transferred', ended: new Date().toISOString(), working: false });
        markSeen(seenKey, cmdId);
        return reply(200, { id: cmdId, session: target.id, resumed: true, moved: dest });
      }
      const saved = await deadLetter(kind, payload, machine, `the ${MACHINE_NAME[machine]} is not responding`);
      return reply(409, { error: `the ${MACHINE_NAME[machine]} is not responding`, saved });
    }
    const cmdId = crypto.randomUUID();
    await sbWrite('desk_commands', 'POST', { id: cmdId, kind, payload });
    markSeen(seenKey, cmdId);
    return reply(200, { id: cmdId, session: target.id, resumed: !now.live });
  }

  // Act on one: 'hide' takes it off the surfaces' lists, 'end' closes it for good, 'resume' brings an evicted one back, 'forget' drops the row
  // without touching the machine (the transcript stays on disk; it just stops being offered), and
  // 'followup' types words into a running one (see below).
  gated.post('/api/sessions/:action', express.json(), async (req, res) => {
    try {
      const action = String(req.params.action || '');
      const id = String((req.body || {}).id || '');
      if (!id) return res.status(400).json({ error: 'id required' });
      // Dismiss it from every surface's list (buildSessions) without touching the session: it keeps
      // running or stays parked, and the orchestrator still lists it.
      if (action === 'hide') {
        await sbWrite(`desk_sessions?id=eq.${encodeURIComponent(id)}`, 'PATCH', { hidden_at: new Date().toISOString() });
        res.json({ ok: true });
        pushSessions();
        return;
      }
      if (action === 'forget') {
        await sbWrite(`desk_sessions?id=eq.${encodeURIComponent(id)}`, 'DELETE');
        return res.json({ ok: true });
      }
      const rowsFull = await sb(`desk_sessions?id=eq.${encodeURIComponent(id)}&select=*`);
      if (!rowsFull.length) return res.status(404).json({ error: 'no such session' });

      // Words for a session. Running, they are typed in — data-layer's followUp, addressed by id instead
      // of by focus, so the watch and the phone can answer the session they are showing. Parked, it is resumed with the
      // words as its prompt, which both machines accept (a full Pi queues it for a slot). conversationNow
      // decides which, so a conversation already running again under a newer row gets the words there
      // rather than a second process. An asleep machine gets them dead-lettered, as everywhere else, and
      // client_msg_id makes a resend after a lost answer return the first command.
      if (action === 'followup') {
        const text = String((req.body || {}).text || '').trim();
        // PICTURES: object names from /api/attach, the same bucket the chat composer fills. They ride to
        // the machine that owns the session, which pulls the bytes down and hands the session a local
        // path — a tty can be typed into, and an image cannot be typed. A picture alone is a message.
        const attachments = (Array.isArray((req.body || {}).attachments) ? (req.body || {}).attachments : [])
          .map(String).filter((n) => /^[\w.-]+$/.test(n)).slice(0, 8);
        if (!text && !attachments.length) return res.status(400).json({ error: 'text or attachments required' });
        // Only "thank you" asks the session for nothing, and from a microphone it is Whisper hearing
        // silence (lib/transcribe.js). Never typed into a session.
        if (!attachments.length && NOTHING_SAID.test(text)) return res.json({ ignored: true });
        const msgId = String((req.body || {}).client_msg_id || '').slice(0, 64);
        const seenKey = msgId ? 'followup:' + msgId : '';
        if (seenKey && seenMsgIds.has(seenKey)) return res.json({ id: seenMsgIds.get(seenKey), duplicate: true });
        const r = await followUpSession(rowsFull[0], { text, attachments, spoken: (req.body || {}).spoken === true, msgId, seenKey });
        return res.status(r.status).json(r.body);
      }

      // Hand it to the other machine, carrying the conversation. Same two paths as the voice tool, and
      // they have to stay the same: the source closes and flushes when it is up, and when it is not,
      // the destination resumes from what was already mirrored. (data-layer's transferSession.)
      if (action === 'transfer') {
        const row = rowsFull[0];
        const from = machineOf(row.worker);
        const to = from === 'pi' ? 'mac' : 'pi';
        if (!row.claude_session_id) return res.status(400).json({ error: 'no transcript recorded for that session' });
        if (!(await machineAwake(to))) {
          const saved = await deadLetter('transfer_session', { session: id, target: from, to }, to,
                                         `the ${MACHINE_NAME[to]} is not responding`);
          return res.status(409).json({ error: `the ${MACHINE_NAME[to]} is not responding`, saved });
        }
        const cmdId = crypto.randomUUID();
        if (await machineAwake(from)) {
          await sbWrite('desk_commands', 'POST',
            { id: cmdId, kind: 'transfer_session', payload: { session: id, target: from, to } });
        } else {
          await sbWrite('desk_commands', 'POST', { id: cmdId, kind: 'resume_mirrored',
            payload: { target: to, claude_session_id: row.claude_session_id, repo: row.repo,
                       label: row.label || null, origin: row.origin || 'dispatched', from } });
          await sbWrite(`desk_sessions?id=eq.${encodeURIComponent(id)}`, 'PATCH',
            { status: 'transferred', ended: new Date().toISOString(), working: false });
        }
        return res.json({ id: cmdId, to });
      }

      // Name the session itself when it is running — `/rename` typed into it, the same command the user
      // would — and always set the row, so the pane changes now rather than a tick later. A parked
      // session has no process to type into and takes the name in the row alone.
      if (action === 'rename') {
        const row = rowsFull[0];
        const name = String((req.body || {}).name || '').replace(/[\r\n]+/g, ' ').trim().slice(0, 60);
        if (!name) return res.status(400).json({ error: 'name required' });
        await sbWrite(`desk_sessions?id=eq.${encodeURIComponent(id)}`, 'PATCH', { label: name });
        const from = machineOf(row.worker);
        if (row.status !== 'resident' || !(await machineAwake(from))) return res.json({ name, live: false });
        const cmdId = crypto.randomUUID();
        await sbWrite('desk_commands', 'POST',
          { id: cmdId, kind: 'rename_session', payload: { session: id, name, target: from } });
        return res.json({ id: cmdId, name, live: true });
      }

      // Resuming a conversation that is already running again, or still opening, would start a second
      // process on one transcript (see conversationNow).
      if (action === 'resume') {
        const now = await conversationNow(rowsFull[0]);
        if (!now.parked) {
          return res.status(409).json({ error: now.live ? 'that session is already running' : 'that session is still opening' });
        }
      }
      const kind = action === 'resume' ? 'resume_session' : action === 'end' ? 'end_session' : null;
      if (!kind) return res.status(400).json({ error: 'unknown action' });
      // The machine that OWNS the session, read from its row. Hardcoding 'pi' sent every Mac session's
      // command to a consumer that rejects the id, while the Mac's never saw it at all.
      const machine = machineOf(rowsFull[0].worker);
      const payload = { session: id, target: machine };
      if (!(await machineAwake(machine))) {
        const saved = await deadLetter(kind, payload, machine, `the ${MACHINE_NAME[machine]} is not responding`);
        return res.status(409).json({ error: `the ${MACHINE_NAME[machine]} is not responding`, saved });
      }
      // Routed through desk_commands like everything else, because this server is on Fly and cannot
      // reach either machine directly — Supabase carries both directions.
      const cmdId = crypto.randomUUID();
      await sbWrite('desk_commands', 'POST', { id: cmdId, kind, payload });
      res.json({ id: cmdId });
    } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
  });

  gated.post('/api/repos/open', express.json(), async (req, res) => {
    try {
      const wantPath = String((req.body || {}).path || '');
      // Launch only a path the machine itself published: the client's string picks a ROW, it never
      // becomes the command's payload. (Each consumer independently re-checks the same thing.)
      const rows = await sb(`repos?path=eq.${encodeURIComponent(wantPath)}&select=path,name`);
      if (!rows.length) return res.status(400).json({ error: 'unknown repo' });
      // The dictated first message. Free text by nature — it is a prompt — so it is NOT validated here;
      // the orchestrator shell-quotes it when building the command, which is where quoting belongs.
      // Capped only so a runaway transcription can't produce an unusable command line.
      const prompt = String((req.body || {}).prompt || '').trim().slice(0, 2000) || null;
      // Which machine runs it. The Pi is the default deliberately: work dispatched this way is
      // long-running, and it must not die because a laptop lid closed. 'mac' is chosen explicitly —
      // by the voice router, or by tapping the Apple button in the pane — and is worth choosing for
      // iOS work, where the local compile loop is the whole advantage.
      const machine = String((req.body || {}).target || '').toLowerCase() === 'mac' ? 'mac' : 'pi';
      const payload = { path: rows[0].path, name: rows[0].name, target: machine, ...(prompt ? { prompt } : {}) };
      // A command written for a machine that is asleep is claimed by nobody and expires unread. Say so
      // now, and keep the prompt, rather than reporting a launch that will never happen.
      if (!(await machineAwake(machine))) {
        const saved = await deadLetter('open_session', payload, machine, `the ${MACHINE_NAME[machine]} is not responding`);
        return res.status(409).json({ error: `the ${MACHINE_NAME[machine]} is not responding`, saved });
      }
      const id = crypto.randomUUID();
      await sbWrite('desk_commands', 'POST', { id, kind: 'open_session', payload });
      res.json({ id });
    } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
  });

  return { MACHINE_NAME, deadLetter, followUpSession, machineAwake, pushSessions };
};
