'use strict';
const crypto = require('crypto');
const express = require('express');

// PERMISSION PROMPTS: a session blocked on a dialog is answered from the phone or the watch.
//
// Claude Code runs a `PermissionRequest` hook while its dialog is on screen, and the hook's decision
// answers the dialog — the terminal keeps showing it the whole time, and a key pressed there still
// answers it first. That hook is `bin/permission-hook` (wired in claude-config's settings on both
// machines). It reports the dialog here, holds a request open until a decision arrives, and prints it.
// So nothing is typed into a terminal: keystrokes cannot deny safely on the Mac, where Terminal's
// `do script` always appends a return, and a return in that dialog is "Yes" (docs/PROMPTS.md).
//
// State is in memory, on purpose. A prompt lives only as long as the hook that is waiting on it, and
// the hub is one machine; a restart drops every waiter, each hook then finds its prompt gone and exits
// with no decision, and the dialog is left for the terminal — the same as before this existed.
//
// A prompt is also ON THE SESSION, not only in a notification: `pendingFor` hands it to the session
// payload (routes/sessions.js), and every change to it re-pushes that payload, so the phone's and the
// watch's session views show Approve / Deny for as long as the dialog is waiting. A notification is
// swiped away by habit; the session is where the user goes to see why it stopped.
module.exports = function (ctx) {
  const { auth, gated, pushAll, sb } = ctx;
  // Called, not captured: routes/sessions.js is built after this module.
  const pushSessions = () => ctx.pushSessions && ctx.pushSessions();

  const prompts = new Map();   // id -> { session, title, tool, input, decision, waiters: Set<fn>, at }
  const PROMPT_TTL_MS = 30 * 60 * 1000;

  function sweep() {
    const now = Date.now();
    for (const [id, p] of prompts) if (now - p.at > PROMPT_TTL_MS && !p.waiters.size) prompts.delete(id);
  }

  // What the call is, in one line: the tool and the part of its input a person decides on.
  function summarise(tool, input) {
    const i = input && typeof input === 'object' ? input : {};
    const what = i.command || i.file_path || i.url || i.pattern || i.path || i.query
      || (Object.keys(i).length ? JSON.stringify(i) : '');
    return `${tool}${what ? `: ${String(what)}` : ''}`.replace(/\s+/g, ' ').trim().slice(0, 400);
  }

  function settle(p, decision) {
    p.decision = decision;
    for (const w of p.waiters) w();
    p.waiters.clear();
    pushSessions();
  }

  // The waiting prompt of a session row, for the session payload: `{ id, line }`, or null. Only one
  // can be waiting per session (a dialog blocks its session), so the newest undecided one is it.
  function pendingFor(rowId) {
    let best = null;
    for (const [id, p] of prompts) {
      if (p.session === rowId && !p.decision && (!best || p.at > best.at)) best = { id, line: p.line, at: p.at };
    }
    return best && { id: best.id, line: best.line };
  }

  // A hook that dies without saying so (killed, its 25 minutes up, the session closed under it) leaves
  // its prompt undecided with nobody waiting on it, and the session view would offer buttons that
  // answer nothing. The hook is always either holding a request or about to re-send one within seconds,
  // so a prompt with no waiter for HOOK_GONE_MS is one whose hook has gone: it is dropped and the
  // session payload re-pushed. Armed by the waiter's request closing, which is the event that says so.
  const HOOK_GONE_MS = 70 * 1000;
  function watchForHook(id) {
    setTimeout(() => {
      const p = prompts.get(id);
      if (!p || p.decision || p.waiters.size || Date.now() - p.polled < HOOK_GONE_MS) return;
      prompts.delete(id);
      console.error(`[prompts] hook for prompt ${id} (${p.title}) went quiet without a decision; dropped`);
      pushSessions();
    }, HOOK_GONE_MS + 1000);
  }

  // The hook reports a dialog. Only a session the hub knows is pushed: a headless or unadopted Claude
  // process has no row, and nobody to ask on its behalf, so the hook gets a 404 and leaves the dialog.
  gated.post('/api/session-prompts', express.json(), async (req, res) => {
    if (!auth.deviceRequest(req)) return res.status(403).json({ error: 'forbidden' });
    const b = req.body || {};
    const claudeId = String(b.claude_session_id || '');
    const tool = String(b.tool_name || '').slice(0, 80);
    if (!/^[\w-]{8,64}$/.test(claudeId) || !tool) return res.status(400).json({ error: 'claude_session_id and tool_name required' });
    try {
      const rows = await sb(`desk_sessions?claude_session_id=eq.${encodeURIComponent(claudeId)}&status=eq.resident` +
                            '&select=id,label,custom_title,repo&order=last_seen.desc.nullslast&limit=1');
      const row = rows && rows[0];
      if (!row) return res.status(404).json({ error: 'no running session with that conversation' });
      sweep();
      const id = crypto.randomUUID();
      const title = row.custom_title || row.label || row.repo || 'Session';
      const line = summarise(tool, b.tool_input);
      prompts.set(id, { session: row.id, title, line, decision: null, waiters: new Set(), at: Date.now(), polled: Date.now() });
      pushSessions();
      watchForHook(id);
      // Not deduped against `notifications`: each dialog is its own prompt with its own id.
      pushAll('prompt', title, line, null,
              { category: 'SESSION_PROMPT', payload: { prompt_id: id, session_id: row.id } })
        .catch((e) => console.error('[prompts] push:', e.message));
      res.json({ id, session: row.id });
    } catch (e) {
      console.error('[prompts] create:', e.message);
      res.status(500).json({ error: e.message });
    }
  });

  // The hook waits here. Answers the moment a decision lands, or `{decision:null}` after `wait`
  // seconds so the hook can re-check its own dialog and come back. 404 means the hub no longer has it.
  gated.get('/api/session-prompts/:id', (req, res) => {
    if (!auth.deviceRequest(req)) return res.status(403).json({ error: 'forbidden' });
    const p = prompts.get(req.params.id);
    if (!p) return res.status(404).json({ error: 'no such prompt' });
    p.polled = Date.now();
    if (p.decision) return res.json({ decision: p.decision });
    const waitS = Math.min(Math.max(Number(req.query.wait) || 0, 0), 50);
    if (!waitS) return res.json({ decision: null });
    let done = false;
    const answer = () => {
      if (done) return; done = true;
      clearTimeout(t); p.waiters.delete(answer);
      if (!res.writableEnded) res.json({ decision: p.decision || null });
    };
    const t = setTimeout(answer, waitS * 1000);
    p.waiters.add(answer);
    req.on('close', () => {
      if (!done) { done = true; clearTimeout(t); p.waiters.delete(answer); }
      p.polled = Date.now();
      if (!p.decision && !p.waiters.size) watchForHook(req.params.id);
    });
  });

  // A decision, from the phone's or the watch's notification button. First one wins; a later tap, or
  // one for a dialog the terminal already answered (the hook reports that as `gone`), changes nothing.
  gated.post('/api/session-prompts/:id/decide', express.json(), (req, res) => {
    const p = prompts.get(req.params.id);
    if (!p) return res.status(404).json({ error: 'no such prompt' });
    const d = String((req.body || {}).decision || '');
    if (d !== 'allow' && d !== 'deny' && d !== 'gone') return res.status(400).json({ error: 'decision must be allow or deny' });
    if (d === 'gone' && !auth.deviceRequest(req)) return res.status(403).json({ error: 'forbidden' });
    if (p.decision) return res.json({ decision: p.decision, already: true });
    settle(p, d);
    res.json({ decision: d });
  });

  return { pendingFor, summarise };
};
