'use strict';
const express = require('express');

module.exports = function (ctx) {
  const { followUpSession, gated, openSession, sb, sbWrite, sessionVerb, transferSession } = ctx;

  // ---- commands that never ran ---------------------------------------------
  // Everything no machine could run — every machine, Fly included, down or refusing it, a launch that
  // errored, a claim by a machine that then died — lands in desk_dead_letters with its whole payload.
  // This is the plumbing a retry button reads; nothing here decides anything on its own, because a prompt that
  // fires hours late is worse than one that never fired.
  gated.get('/api/failures', async (req, res) => {
    try {
      const all = String(req.query.all || '') === '1';
      const filter = all ? '' : '&retried=is.null&dismissed=is.null';
      res.json({ failures: await sb(`desk_dead_letters?select=*${filter}&order=created.desc&limit=50`) });
    } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
  });

  // Re-dispatch one, unchanged, through the same order a new one takes: its own machine, the other home
  // machine, then Fly (data-layer retryDeadLetter). A command addressed to a session goes through that
  // session's own path, which follows the session wherever it now lives. The saved row is stamped rather
  // than deleted, so what was retried and when stays visible, and only once a machine has it.
  gated.post('/api/failures/:id/retry', express.json(), async (req, res) => {
    try {
      const id = String(req.params.id || '');
      const rows = await sb(`desk_dead_letters?id=eq.${encodeURIComponent(id)}&select=*`);
      if (!rows.length) return res.status(404).json({ error: 'no such saved command' });
      const row = rows[0];
      if (row.retried) return res.status(409).json({ error: 'already retried' });
      const p = row.payload || {};
      const machine = row.machine === 'mac' ? 'mac' : row.machine === 'fly' ? 'fly' : 'pi';
      const session = p.session
        ? ((await sb(`desk_sessions?id=eq.${encodeURIComponent(String(p.session))}&select=*`)) || [])[0] : null;
      let r;
      if (row.kind === 'open_session') {
        const { target, ...payload } = p;
        const agent = p.agent === 'codex' ? 'codex' : 'claude';
        const o = await openSession(payload, machine === 'mac' ? 'mac' : 'pi', agent, undefined, { save: false });
        r = o.ok ? { status: 200, body: { id: o.id, machine: o.machine } } : { status: 409, body: { error: o.why } };
      } else if (session && (row.kind === 'follow_up' || (row.kind === 'resume_session' && p.prompt))) {
        r = await followUpSession(session, { text: String(p.prompt || ''), attachments: p.attachments || [], msgId: p.msg || '' });
      } else if (session && (row.kind === 'resume_session' || row.kind === 'end_session')) {
        r = await sessionVerb(session, row.kind);
      } else if (session && row.kind === 'transfer_session') {
        r = await transferSession(session);
      } else {
        return res.status(409).json({ error: p.session ? 'that session no longer exists' : `a saved ${row.kind} cannot be retried here` });
      }
      if (r.status !== 200 || !r.body.id) return res.status(r.status === 200 ? 409 : r.status).json({ error: `${r.body.error || 'it did not run'} — leaving it saved` });
      await sbWrite(`desk_dead_letters?id=eq.${encodeURIComponent(id)}`, 'PATCH',
        { retried: new Date().toISOString(), retry_command_id: r.body.id });
      res.json(r.body);
    } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
  });

  gated.post('/api/failures/:id/dismiss', express.json(), async (req, res) => {
    try {
      await sbWrite(`desk_dead_letters?id=eq.${encodeURIComponent(String(req.params.id || ''))}`, 'PATCH',
        { dismissed: new Date().toISOString() });
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
  });

  // Poll target for the launch button: pending -> running -> done | error | expired.
  gated.get('/api/repos/cmd/:id', async (req, res) => {
    try {
      const rows = await sb(`desk_commands?id=eq.${encodeURIComponent(req.params.id)}&select=status,detail`);
      if (!rows.length) return res.status(404).json({ error: 'not found' });
      res.json(rows[0]);
    } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
  });
};
