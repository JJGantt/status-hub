'use strict';
// The login sessions, as the settings panel manages them. The gate itself is lib/auth.js.
const express = require('express');

module.exports = function (ctx) {
  const { auth, gated } = ctx;

  // The login sessions: list them, revoke one (`{id}`) or every one (`{all: true}`). lib/auth.js.
  gated.get('/api/auth/sessions', (req, res) => res.json({ sessions: auth.list(req) }));
  gated.post('/api/auth/revoke', express.json(), async (req, res) => {
    const b = req.body || {};
    if (!b.all && !b.id) return res.status(400).json({ error: 'id or all' });
    try { res.json({ revoked: await auth.revoke({ id: String(b.id || ''), all: !!b.all }) }); }
    catch (e) { console.error('[auth] revoke failed:', e.message); res.status(502).json({ error: String(e.message || e) }); }
  });
};
