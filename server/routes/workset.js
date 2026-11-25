'use strict';
const express = require('express');

// The watch's Watchset page (apps/Packages/Watchset) reaches the data layer's `workset` edge function
// (data-layer supabase/functions/workset) through here, on the watch's own hub token. The function
// authorises a device token, which lives on the hub (`WORKSET_DEVICE_TOKEN`) rather than in the app.
// Routes and answers pass through unchanged: report (POST), report?id= (PATCH), watcher (POST),
// capture?session= (POST, text/csv, up to 20 MB).
const ROUTES = new Set(['report', 'watcher', 'capture']);

module.exports = function ({ SUPABASE_URL, gated }) {
  const base = `${SUPABASE_URL}/functions/v1/workset`;
  const body = express.raw({ type: () => true, limit: '21mb' });

  gated.all('/api/workset/:route', body, async (req, res) => {
    const token = process.env.WORKSET_DEVICE_TOKEN;
    if (!ROUTES.has(req.params.route)) return res.status(404).json({ error: 'unknown route' });
    if (!token) {
      console.error('[workset] WORKSET_DEVICE_TOKEN is not set; the watch cannot log a set');
      return res.status(503).json({ error: 'not configured' });
    }
    const query = req.originalUrl.includes('?') ? req.originalUrl.slice(req.originalUrl.indexOf('?')) : '';
    try {
      const r = await fetch(`${base}/${req.params.route}${query}`, {
        method: req.method,
        headers: { 'X-Device-Token': token, 'Content-Type': req.get('content-type') || 'application/json' },
        body: ['GET', 'HEAD'].includes(req.method) || !Buffer.isBuffer(req.body) || !req.body.length ? undefined : req.body,
      });
      const text = await r.text();
      if (r.status >= 500) console.error(`[workset] ${req.method} ${req.params.route}: ${r.status} ${text.slice(0, 200)}`);
      res.status(r.status).type(r.headers.get('content-type') || 'application/json').send(text);
    } catch (e) {
      console.error(`[workset] ${req.method} ${req.params.route} failed: ${e.message || e}`);
      res.status(502).json({ error: 'workset function unreachable' });
    }
  });
};
