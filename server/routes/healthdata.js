'use strict';
const express = require('express');

module.exports = function (ctx) {
  const { SUPABASE_KEY, SUPABASE_URL, gated, sbWrite } = ctx;

  // ---- SLEEP: Apple Watch sleep, as the iPhone app reads it from Apple Health (docs/SLEEP.md) -------
  // The app posts what its anchored HealthKit query returned since the last post: `samples` added or
  // changed, `deleted` UUIDs removed in Health. Keyed by HealthKit UUID, so a resend after a failed post
  // is harmless. Every column is sent, because a merge-duplicates upsert nulls what it omits.
  const SLEEP_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const SLEEP_STAGES = new Set(['in_bed', 'asleep_unspecified', 'awake', 'core', 'deep', 'rem']);
  gated.post('/api/health/sleep', express.json({ limit: '1mb' }), async (req, res) => {
    const samples = Array.isArray(req.body?.samples) ? req.body.samples : [];
    const deleted = (Array.isArray(req.body?.deleted) ? req.body.deleted : []).filter((u) => SLEEP_UUID.test(u));
    const rows = samples
      .filter((s) => SLEEP_UUID.test(s.id) && SLEEP_STAGES.has(s.stage) && s.start && s.end)
      .map((s) => ({ id: s.id, start_at: s.start, end_at: s.end, stage: s.stage, source: s.source || null, received_at: new Date().toISOString() }));
    try {
      if (rows.length) {
        const r = await fetch(`${SUPABASE_URL}/rest/v1/sleep_samples?on_conflict=id`, {
          method: 'POST',
          headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json',
            Prefer: 'resolution=merge-duplicates,return=minimal' },
          body: JSON.stringify(rows),
        });
        if (!r.ok) throw new Error(`supabase upsert sleep_samples -> ${r.status} ${await r.text()}`);
      }
      if (deleted.length) await sbWrite(`sleep_samples?id=in.(${deleted.join(',')})`, 'DELETE');
      console.log(`[sleep] +${rows.length} -${deleted.length} (sent ${samples.length})`);
      res.json({ ok: true, stored: rows.length, deleted: deleted.length });
    } catch (e) {
      console.error('[sleep] write failed:', e.message);
      res.status(502).json({ ok: false });
    }
  });

  // ---- HEALTH: every other Apple Health type, the same way (docs/HEALTH.md) --------------------------
  // Same contract as sleep: `samples` added or changed since the app's last anchor, `deleted` UUIDs, a
  // UUID-keyed upsert so a resend is harmless. Generic rows — type, value, unit — so a type Health adds
  // later lands here with no change on this side.
  // PACED. A page of N rows earns the next page a gap of N / HEALTH_ROWS_PER_S seconds, stretched to
  // HEALTH_SLOWDOWN x the write's own duration when the database is slow; a page that arrives inside the
  // gap gets 503 + Retry-After before Supabase is touched. The phone commits its anchor only on a 200 and
  // waits out Retry-After, so a refused page costs nothing. Live deliveries are a few rows and never wait;
  // the first full-history read is millions of rows, and unpaced it wrote ~1.3M in twenty minutes and
  // starved the database's disk until Postgres stopped answering (every random-UUID insert dirties its
  // own index page, so writes cost far more I/O than the bytes suggest).
  const HEALTH_ROWS_PER_S = 100;
  const HEALTH_SLOWDOWN = 10;
  let healthNextAt = 0;
  // A lone failed write during the full-history read is the database pushing back, and the minute's
  // backoff below is the answer to it; only failures that keep coming after that are reported as errors.
  const HEALTH_FAILS_TO_REPORT = 3;
  let healthFails = 0;
  gated.post('/api/health/samples', express.json({ limit: '4mb' }), async (req, res) => {
    const wait = healthNextAt - Date.now();
    if (wait > 0) {
      res.set('Retry-After', String(Math.ceil(wait / 1000)));
      return res.status(503).json({ ok: false, retry_after: Math.ceil(wait / 1000) });
    }
    const samples = Array.isArray(req.body?.samples) ? req.body.samples : [];
    const deleted = (Array.isArray(req.body?.deleted) ? req.body.deleted : []).filter((u) => SLEEP_UUID.test(u));
    const now = new Date().toISOString();
    const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
    const rows = samples
      .filter((s) => SLEEP_UUID.test(s.id) && typeof s.type === 'string' && s.type && s.start && s.end)
      .map((s) => ({ id: s.id, type: s.type, value: num(s.value), unit: s.unit || null, label: s.label || null,
        start_at: s.start, end_at: s.end, source: s.source || null,
        metadata: s.metadata && typeof s.metadata === 'object' ? s.metadata : null, received_at: now }));
    const began = Date.now();
    // Reserved before the write, so a second page arriving while this one is in flight is refused too.
    healthNextAt = began + ((rows.length + deleted.length) / HEALTH_ROWS_PER_S) * 1000;
    try {
      if (rows.length) {
        const r = await fetch(`${SUPABASE_URL}/rest/v1/health_samples?on_conflict=id`, {
          method: 'POST',
          headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json',
            Prefer: 'resolution=merge-duplicates,return=minimal' },
          body: JSON.stringify(rows),
        });
        if (!r.ok) throw new Error(`supabase upsert health_samples -> ${r.status} ${await r.text()}`);
      }
      // In slices, because the ids ride in the URL and a full page of them is past what a URL can carry.
      for (let i = 0; i < deleted.length; i += 200) {
        await sbWrite(`health_samples?id=in.(${deleted.slice(i, i + 200).join(',')})`, 'DELETE');
      }
      const took = Date.now() - began;
      healthFails = 0;
      healthNextAt = Math.max(healthNextAt, Date.now() + took * HEALTH_SLOWDOWN);
      console.log(`[health] +${rows.length} -${deleted.length} (sent ${samples.length}) ${took}ms`);
      res.json({ ok: true, stored: rows.length, deleted: deleted.length });
    } catch (e) {
      // A failed write is the database saying it is in trouble: back off a minute, not a page's gap.
      healthNextAt = Math.max(healthNextAt, Date.now() + 60_000);
      healthFails += 1;
      (healthFails >= HEALTH_FAILS_TO_REPORT ? console.error : console.warn)(`[health] write failed (${healthFails} in a row):`, e.message);
      res.status(502).json({ ok: false });
    }
  });

  // ---- LOCATION HISTORY (docs/LOCATION.md) ---------------------------------------------------------------
  // Batches of fixes from the phone, the watch and the Mac, stored as they came into location_points
  // (data-layer 00139). Upserted on (device, at), so a batch resent after a lost reply changes nothing.
  const LOCATION_DEVICES = new Set(['phone', 'watch', 'mac']);
  gated.post('/api/location/points', express.json({ limit: '4mb' }), async (req, res) => {
    const device = req.body?.device;
    if (!LOCATION_DEVICES.has(device)) return res.status(400).json({ ok: false });
    const points = Array.isArray(req.body?.points) ? req.body.points : [];
    const now = new Date().toISOString();
    const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
    const seen = new Set();
    const rows = points
      .filter((p) => num(p.lat) != null && num(p.lon) != null && typeof p.at === 'string' && !Number.isNaN(Date.parse(p.at)))
      .map((p) => ({ device, at: new Date(p.at).toISOString(), lat: p.lat, lon: p.lon, h_acc: num(p.h_acc), alt: num(p.alt),
        v_acc: num(p.v_acc), speed: num(p.speed), course: num(p.course),
        floor: Number.isInteger(p.floor) ? p.floor : null, received_at: now }))
      // One upsert cannot touch a row twice, and two fixes stamped the same millisecond would.
      .filter((r) => !seen.has(r.at) && seen.add(r.at));
    try {
      if (rows.length) {
        const r = await fetch(`${SUPABASE_URL}/rest/v1/location_points?on_conflict=device,at`, {
          method: 'POST',
          headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json',
            Prefer: 'resolution=merge-duplicates,return=minimal' },
          body: JSON.stringify(rows),
        });
        if (!r.ok) throw new Error(`supabase upsert location_points -> ${r.status} ${await r.text()}`);
      }
      console.log(`[location] ${device} +${rows.length} (sent ${points.length})`);
      res.json({ ok: true, stored: rows.length });
    } catch (e) {
      console.error('[location] write failed:', e.message);
      res.status(502).json({ ok: false });
    }
  });
};
