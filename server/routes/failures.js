'use strict';
const crypto = require('crypto');
const express = require('express');

module.exports = function (ctx) {
  const { MACHINE_NAME, gated, machineAwake, sb, sbWrite } = ctx;

  // ---- commands that never ran ---------------------------------------------
  // Everything that could not be dispatched — machine asleep, expired unrun, launch errored, claimed
  // by a machine that then died — lands in desk_dead_letters with its whole payload. This is the
  // plumbing a retry button reads; nothing here decides anything on its own, because a prompt that
  // fires hours late is worse than one that never fired.
  gated.get('/api/failures', async (req, res) => {
    try {
      const all = String(req.query.all || '') === '1';
      const filter = all ? '' : '&retried=is.null&dismissed=is.null';
      res.json({ failures: await sb(`desk_dead_letters?select=*${filter}&order=created.desc&limit=50`) });
    } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
  });

  // Re-dispatch one, unchanged, if its machine is up now. The saved row is stamped rather than
  // deleted, so what was retried and when stays visible.
  gated.post('/api/failures/:id/retry', express.json(), async (req, res) => {
    try {
      const id = String(req.params.id || '');
      const rows = await sb(`desk_dead_letters?id=eq.${encodeURIComponent(id)}&select=*`);
      if (!rows.length) return res.status(404).json({ error: 'no such saved command' });
      const row = rows[0];
      if (row.retried) return res.status(409).json({ error: 'already retried' });
      const machine = row.machine === 'mac' ? 'mac' : 'pi';
      if (!(await machineAwake(machine))) {
        return res.status(409).json({ error: `the ${MACHINE_NAME[machine]} is still not responding` });
      }
      const cmdId = crypto.randomUUID();
      await sbWrite('desk_commands', 'POST',
        { id: cmdId, kind: row.kind, payload: { ...row.payload, target: machine } });
      await sbWrite(`desk_dead_letters?id=eq.${encodeURIComponent(id)}`, 'PATCH',
        { retried: new Date().toISOString(), retry_command_id: cmdId });
      // A re-sent dispatch is the session being talked to again, exactly as a fresh one would be.
      if (row.kind === 'open_session' || row.kind === 'resume_session') {
        // PATCH, not an upsert: the single 'current' row is created by the migration and always there,
        // and a plain POST onto an existing primary key is a 409.
        await sbWrite('desk_focus?id=eq.current', 'PATCH',
          { command_id: cmdId, session_id: null, machine, updated: new Date().toISOString() });
      }
      res.json({ id: cmdId });
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
