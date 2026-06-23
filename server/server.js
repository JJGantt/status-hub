'use strict';
const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');
const WebSocket = require('ws');
const { estimateMaintenance, macroTargets } = require('./lib/maintenance');
const pace = require('./lib/pace');
const { computeVolume } = require('./lib/volume');
const BODY_SVG = require('./lib/bodymap');
const { DAY_START_HOUR, localDate, nutritionWindow, lastNTrainingDays, dayBucketOf } = require('./lib/dates');
const { buildWorkoutHeatmap } = require('./lib/heatmap');
const { buildNutritionLog, calorieColor, targetCalFor } = require('./lib/nutritionlog');
const { buildVariants } = require('./lib/variants');
const apns = require('./lib/apns');
const weightReminder = require('./lib/weightReminder');

const PORT = process.env.PORT || 8080;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const HUB_PASSWORD = process.env.HUB_PASSWORD || 'changeme';
const TZ = process.env.TZ_DISPLAY || 'America/New_York';
// Cookie token derived from the password — set once per device, never expires (no logout).
const TOKEN = crypto.createHash('sha256').update('status-hub:' + HUB_PASSWORD).digest('hex');
// Device token for the Pi/TV kiosk: visiting any page with ?token=<TV_TOKEN> sets the hub
// cookie, so the wall display authenticates by URL without ever needing the password.
const TV_TOKEN = process.env.TV_TOKEN || '';
// Groq Whisper for the in-app voice button (same model the ESP/Jarvis path uses).
const GROQ_API_KEY = process.env.GROQ_API_KEY || '';
// Sentinel transcript the worker recognizes as "drop the resumed hub session" (manual reset).
// Must match RESET_SENTINEL in the voice-pipeline worker.
const VOICE_RESET_SENTINEL = '__RESET_CONTEXT__';

// Supabase client used only for the Realtime subscription (push). Data reads use sb() REST.
const supa = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: false },
  realtime: { transport: WebSocket },
});
const sseClients = new Set();
// Separate SSE pool for the /tv voice-conversation panel — these get raw voice_messages /
// voice_focus rows, not the assembled status frame, so they don't carry the heavy status payload.
const voiceClients = new Set();

// Dashboard HTML, read once from disk with the muscle-map SVG injected at the placeholder.
const DASHBOARD_HTML = fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8')
  .replace('<!--BODY_SVG-->', BODY_SVG);
// /tv serves the SAME real hub dashboard (core.js + cards over /api/stream) plus a voice column.
// Inject the body-map SVG just like the dashboard so the muscle map renders identically.
const TV_HTML = fs.readFileSync(path.join(__dirname, 'public', 'tv.html'), 'utf8')
  .replace('<!--BODY_SVG-->', BODY_SVG);

const app = express();
app.use(express.urlencoded({ extended: false }));

// ---- Supabase REST helper (service key, server-side only) ----
async function sb(path) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` },
  });
  if (!r.ok) throw new Error(`supabase ${path} -> ${r.status}`);
  return r.json();
}
// Paginated read — Supabase caps responses at 1000 rows (db-max-rows), so page via Range.
async function sbRange(path) {
  const out = [];
  for (let from = 0; ; from += 1000) {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
      headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, 'Range-Unit': 'items', Range: `${from}-${from + 999}` },
    });
    if (!r.ok && r.status !== 206) throw new Error(`supabase ${path} -> ${r.status}`);
    const chunk = await r.json();
    out.push(...chunk);
    if (chunk.length < 1000) break;
  }
  return out;
}
async function sbWrite(path, method, body) {
  const init = {
    method,
    headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json' },
  };
  if (body !== undefined) init.body = JSON.stringify(body);
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, init);
  if (!r.ok) throw new Error(`supabase ${method} ${path} -> ${r.status}`);
}

// Best-effort audit trail for every hub nutrition write (add/edit/delete). before/after are
// full row snapshots (or null) — enough to fully reverse any action. NEVER throws into the
// caller: a failed audit insert must not fail the user's action, so it logs and swallows.
async function audit(action, entryId, before, after) {
  try {
    await sbWrite('nutrition_audit', 'POST', {
      id: crypto.randomUUID(),
      at: new Date().toISOString(),
      action,
      entry_id: entryId,
      before: before || null,
      after: after || null,
    });
  } catch (e) { console.error('audit insert failed:', e.message); }
}

// Keep the stored nutrition_targets row in sync with the hub's live dynamic goal so the
// MCP (which reads that row) and the hub always agree. Writes only when the value changes;
// one row per day (updates today's row, else inserts). Fire-and-forget from buildStatus.
let lastSyncedTarget = null;
async function syncStoredTarget(m, today) {
  if (!m) return;
  const key = `${m.calories}/${m.protein_g}/${m.carbs_g}/${m.fat_g}`;
  if (key === lastSyncedTarget) return;
  const rows = await sb(`nutrition_targets?date=eq.${today}&select=id,calories,protein_g,carbs_g,fat_g`);
  const vals = { calories: m.calories, protein_g: m.protein_g, carbs_g: m.carbs_g, fat_g: m.fat_g };
  const existing = (rows || [])[0];
  if (existing && existing.calories === vals.calories && existing.protein_g === vals.protein_g
      && existing.carbs_g === vals.carbs_g && existing.fat_g === vals.fat_g) { lastSyncedTarget = key; return; }
  const logged_at = new Date().toISOString();
  if (existing) await sbWrite(`nutrition_targets?id=eq.${existing.id}`, 'PATCH', { ...vals, logged_at });
  else await sbWrite('nutrition_targets', 'POST', { ...vals, date: today, logged_at });
  lastSyncedTarget = key;
}

// Live dynamic maintenance calorie target (same adaptive estimate the dashboard shows). Used as
// the fallback for a day's historical target when no nutrition_targets snapshot precedes it.
async function currentMaintenanceCal() {
  const today = nutritionWindow().day;
  const histStart = localDate(new Date(Date.now() - 40 * 86400000));
  const [weightRows, histRows] = await Promise.all([
    sb('weight_log?select=date,weight_lbs&order=date.asc'),
    sb(`nutrition_entries?occurred_at=gte.${histStart}T00:00:00&staged=eq.false&select=occurred_at,calories`),
  ]);
  const intakeTotals = {};
  for (const e of histRows || []) {
    const d = dayBucketOf(e.occurred_at);
    if (d === today) continue;
    intakeTotals[d] = (intakeTotals[d] || 0) + (Number(e.calories) || 0);
  }
  const intakeByDay = Object.entries(intakeTotals).map(([date, calories]) => ({ date, calories }));
  const weights = (weightRows || []).map((r) => ({ date: String(r.date).slice(0, 10), weight: Number(r.weight_lbs) }));
  return estimateMaintenance({ weights, intakeByDay, today }).target_macros.calories;
}

// Current time as minutes into the 4am-origin day, in the display timezone.
function nowOffsetTZ() {
  const f = new Intl.DateTimeFormat('en-US', { timeZone: TZ, hour12: false, hour: '2-digit', minute: '2-digit' });
  const parts = f.formatToParts(new Date());
  const hh = Number(parts.find((p) => p.type === 'hour').value) % 24;
  const mm = Number(parts.find((p) => p.type === 'minute').value);
  return pace.offsetFromHM(hh, mm);
}

// ---- assemble dashboard data ----
// ---- surf: latest Surfline snapshot -> current + 7-day per-day rollup ----
// Data is collected by the Pi (repo JJGantt/surf-report) into surf_snapshots.
// Surfline's canonical rating palette (their default :root --conditions* scale).
const SURF_RATING_COLOR = {
  FLAT:'#4d8ba7', NONE:'#4d8ba7', VERY_POOR:'#98a2af', POOR:'#408fff',
  POOR_TO_FAIR:'#30d2e8', FAIR:'#1ad64c', FAIR_TO_GOOD:'#ffcd1e',
  GOOD:'#ff8900', EPIC:'#d54530',
};
const SURF_RATING_LABEL = {
  FLAT:'Flat', NONE:'Flat', VERY_POOR:'Very Poor', POOR:'Poor', POOR_TO_FAIR:'Poor–Fair',
  FAIR:'Fair', FAIR_TO_GOOD:'Fair–Good', GOOD:'Good', EPIC:'Epic',
};
const ratingColor = (k) => SURF_RATING_COLOR[k] || '#8b96a5';
const ratingLabel = (k) => SURF_RATING_LABEL[k] || k || '—';
const etDate    = (ts) => new Date(ts*1000).toLocaleDateString('en-CA', { timeZone:'America/New_York' });
const etWeekday = (ts) => new Date(ts*1000).toLocaleDateString('en-US', { weekday:'short', timeZone:'America/New_York' });
const etHour    = (ts) => (+new Date(ts*1000).toLocaleString('en-US', { hour:'numeric', hour12:false, timeZone:'America/New_York' })) % 24;
const hourLabel = (h) => h === 0 ? '12a' : h < 12 ? h + 'a' : h === 12 ? '12p' : (h - 12) + 'p';
const windShort = (h) => {
  const t = { Offshore:'Off', Onshore:'On', 'Cross-shore':'Cross' }[h.wType] || '';
  return h.wSpd != null ? `${t} ${Math.round(h.wSpd)}`.trim() : '—';
};

function buildSurf(row) {
  if (!row || !Array.isArray(row.rows) || !row.rows.length) return null;
  const rows = row.rows;
  const byDay = new Map();
  for (const h of rows) { const d = etDate(h.ts); (byDay.get(d) || byDay.set(d, []).get(d)).push(h); }
  // Aggregate a time-of-day bucket (inclusive ET hour range) -> best rating + size span.
  const bucket = (all, lo, hi) => {
    const b = all.filter(h => { const e = etHour(h.ts); return e >= lo && e <= hi; });
    if (!b.length) return null;
    const best = b.reduce((a, c) => ((c.rv ?? -1) > (a.rv ?? -1) ? c : a), b[0]);
    const mins = b.map(h => h.sMin).filter(Number.isFinite);
    const maxs = b.map(h => h.sMax).filter(Number.isFinite);
    return {
      ratingLabel: ratingLabel(best.rk), ratingColor: ratingColor(best.rk),
      hMin: mins.length ? Math.min(...mins) : null,
      hMax: maxs.length ? Math.max(...maxs) : null,
    };
  };
  const days = [...byDay.values()].slice(0, 7).map((all) => {
    const daylight = all.filter(h => { const e = etHour(h.ts); return e >= 8 && e <= 20; })
                        .sort((a, b) => a.ts - b.ts);
    return {
      weekday: etWeekday(all[0].ts),
      midday: bucket(all, 10, 14),     // 10a–2p
      late: bucket(all, 16, 19),       // 4p–7p
      hours: daylight.map(h => ({
        t: hourLabel(etHour(h.ts)),
        ratingLabel: ratingLabel(h.rk), ratingColor: ratingColor(h.rk),
        hMin: h.sMin, hMax: h.sMax,
        wind: windShort(h),
        airF: h.aT != null ? Math.round(h.aT) : null,
      })),
    };
  });
  const now = Date.now() / 1000;
  const cur = rows.reduce((a, b) => (Math.abs(b.ts - now) < Math.abs(a.ts - now) ? b : a), rows[0]);
  const wt = row.water_temp || null;
  return {
    spot: row.slug || 'mayport-poles',
    capturedAt: row.captured_at,
    waterTempF: wt ? Math.round((wt.min + wt.max) / 2) : null,
    current: cur ? {
      ratingLabel: ratingLabel(cur.rk), ratingColor: ratingColor(cur.rk),
      hMin: cur.sMin, hMax: cur.sMax, airF: cur.aT != null ? Math.round(cur.aT) : null,
    } : null,
    days,
  };
}

async function buildStatus() {
  const win = nutritionWindow();
  const today = win.day;
  const week = lastNTrainingDays(7);
  const histStart = localDate(new Date(Date.now() - 40 * 86400000)); // intake history for the maintenance trend
  const heatStart = localDate(new Date(Date.now() - 140 * 86400000)); // ~20 weeks for the workout volume heatmap

  const [deviceRows, entries, setRows, weightRows, histRows, muscleRows, heatRows, catalogRows, nutLogRows, targetRows, surfRows] = await Promise.all([
    sb('device_status?select=*'),
    sb(`nutrition_entries?occurred_at=gte.${win.start}&occurred_at=lt.${win.end}&staged=eq.false&select=calories,protein_g,carbs_g,fat_g`),
    sb(`sets?occurred_at=gte.${week[0]}T00:00:00&select=occurred_at,exercise,muscles_override`),
    sb('weight_log?select=date,weight_lbs&order=date.asc'),
    sb(`nutrition_entries?occurred_at=gte.${histStart}T00:00:00&staged=eq.false&select=occurred_at,calories`),
    sb('exercise_muscles?select=name,muscle,contribution'),
    sbRange(`sets?occurred_at=gte.${heatStart}T00:00:00&select=occurred_at&order=occurred_at`),
    sb('exercise_catalog?select=name,equipment'),
    sbRange(`nutrition_entries?occurred_at=gte.${localDate(new Date(Date.now() - 86 * 86400000))}T00:00:00&staged=eq.false&select=occurred_at,calories,protein_g&order=occurred_at`),
    sb('nutrition_targets?select=date,calories&order=date.asc'),
    sb('surf_snapshots?select=slug,water_temp,captured_at,rows&order=captured_at.desc&limit=1'),
  ]);

  const litter = (deviceRows || [])[0] || null;
  const surf = buildSurf((surfRows || [])[0]);

  const sum = (k) => (entries || []).reduce((a, e) => a + (Number(e[k]) || 0), 0);
  const nutrition = {
    calories: Math.round(sum('calories')),
    protein_g: Math.round(sum('protein_g')),
    carbs_g: Math.round(sum('carbs_g')),
    fat_g: Math.round(sum('fat_g')),
    target: null, // set to the dynamic goal once maintenance is computed below
  };

  // ---- adaptive maintenance estimate ----
  const intakeTotals = {};
  for (const e of histRows || []) {
    const d = dayBucketOf(e.occurred_at);
    if (d === today) continue; // exclude the in-progress day (partial intake biases low)
    intakeTotals[d] = (intakeTotals[d] || 0) + (Number(e.calories) || 0);
  }
  const intakeByDay = Object.entries(intakeTotals).map(([date, calories]) => ({ date, calories }));
  const weights = (weightRows || []).map((r) => ({ date: String(r.date).slice(0, 10), weight: Number(r.weight_lbs) }));
  const maintenance = estimateMaintenance({ weights, intakeByDay, today });
  nutrition.target = maintenance.target_macros; // the macro goal is the live dynamic target
  syncStoredTarget(maintenance.target_macros, today).catch((e) => console.error('target sync:', e.message));

  // ---- gamified intake pacing (drain bars) ----
  const eatWindow = pace.deriveWindow((histRows || []).map((r) => r.occurred_at));
  const paceData = pace.computePace({
    consumed: { calories: nutrition.calories, protein_g: nutrition.protein_g, carbs_g: nutrition.carbs_g, fat_g: nutrition.fat_g },
    goal: maintenance.target_macros,
    window: eatWindow,
    nowOff: nowOffsetTZ(),
  });
  paceData.window_label = pace.windowLabel(eatWindow);

  // ---- weekly per-muscle volume gauges ----
  const volume = computeVolume(setRows || [], muscleRows || [], week);
  volume.exercise_variants = buildVariants(catalogRows || []); // exercise → equipment variants + YouTube how-to links

  // ---- workout volume heatmap (GitHub-contribution style) ----
  const heatmap = buildWorkoutHeatmap(heatRows, 20, today); // 20 weeks + 4am `today`, matching the nutrition heatmap

  // ---- nutrition log: calorie-adherence calendar (per-day historical targets) + calorie/weight trend ----
  const nutrition_log = buildNutritionLog(nutLogRows || [], weights, maintenance.target, maintenance.maintenance, today, targetRows || [], 20);

  const last_set_at = (heatRows && heatRows.length) ? heatRows[heatRows.length - 1].occurred_at : null;
  return { today, litter, surf, nutrition, maintenance, pace: paceData, volume, heatmap, nutrition_log, last_set_at, generated_at: new Date().toISOString() };
}

// ---- realtime push: recompute + push to all connected browsers on any DB change ----
async function broadcast() {
  let frame;
  try { frame = 'data: ' + JSON.stringify(await buildStatus()) + '\n\n'; }
  catch (e) { console.error('broadcast build failed:', e.message); return; }
  for (const res of sseClients) { try { res.write(frame); } catch {} }
}

// Push a single voice event to every /tv client. Shape: { kind, row }. Kinds:
//   'message'  — a voice_messages row (append/update the conversation)
//   'focus'    — a voice_focus row (swap focus header / terminal view; row carries terminal_url)
//   'sessions' — the focusable session list changed; row is null, client re-fetches /api/voice-sessions
// The browser keys off kind.
function pushVoice(kind, row) {
  const frame = 'event: voice\ndata: ' + JSON.stringify({ kind, row }) + '\n\n';
  for (const res of voiceClients) { try { res.write(frame); } catch {} }
}

function startRealtime() {
  supa.channel('hub-changes')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'device_status' }, broadcast)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'nutrition_entries' }, broadcast)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'sets' }, broadcast)
    // Voice pipeline: stream inserts/updates straight to the /tv conversation panel. INSERT and
    // UPDATE both carry the new row in `payload.new` (UPDATE = a streamed row flipping done=true).
    .on('postgres_changes', { event: '*', schema: 'public', table: 'voice_messages' },
      (p) => { if (p.new) pushVoice('message', p.new); })
    .on('postgres_changes', { event: '*', schema: 'public', table: 'voice_focus' },
      (p) => { if (p.new) pushVoice('focus', p.new); })
    // Focusable Mac sessions list changed — signal /tv to re-fetch /api/voice-sessions. No
    // payload needed (re-fetch is simplest/robust); the row isn't carried.
    .on('postgres_changes', { event: '*', schema: 'public', table: 'voice_sessions' },
      () => pushVoice('sessions', null))
    .subscribe((status) => console.log('realtime channel:', status));
}

// ---- auth ----
function getCookie(req, name) {
  const m = (req.headers.cookie || '').match(new RegExp('(?:^|; )' + name + '=([^;]+)'));
  return m ? decodeURIComponent(m[1]) : null;
}
// Web uses the 'hub' cookie; the native app sends the same derived token as a header.
const authed = (req) => getCookie(req, 'hub') === TOKEN || req.headers['x-hub-token'] === TOKEN;

app.get('/healthz', (req, res) => res.send('ok'));  // public (before auth gate)
app.get('/login', (req, res) => res.type('html').send(loginHtml()));
app.post('/login', (req, res) => {
  if ((req.body.password || '') === HUB_PASSWORD) {
    res.setHeader('Set-Cookie',
      `hub=${TOKEN}; Max-Age=${60 * 60 * 24 * 3650}; Path=/; HttpOnly; SameSite=Lax`);
    return res.redirect('/');
  }
  res.type('html').send(loginHtml('Wrong password'));
});

// Auth gate — everything below requires the cookie (or x-hub-token header). The browser
// sends the cookie on same-origin module/css fetches automatically, so static assets are
// served behind this gate too.
app.use((req, res, next) => {
  if (authed(req)) return next();
  // Kiosk device-token: ?token=<TV_TOKEN> on any request authenticates and seeds the cookie
  // so the Pi's subsequent same-origin fetches (SSE, /api/*) are authorized too.
  if (TV_TOKEN && req.query.token === TV_TOKEN) {
    res.setHeader('Set-Cookie',
      `hub=${TOKEN}; Max-Age=${60 * 60 * 24 * 3650}; Path=/; HttpOnly; SameSite=Lax`);
    return next();
  }
  if (req.path.startsWith('/api')) return res.status(401).json({ error: 'unauthorized' });
  res.redirect('/login');
});

app.get('/', (req, res) => res.type('html').send(DASHBOARD_HTML));
// Pi/TV kiosk: near-black always-on wall display = the HUD + a live Claude-conversation panel.
// Behind the same auth cookie. no-cache so a deploy is never masked by a stale cached page.
app.get('/tv', (req, res) => {
  res.setHeader('Cache-Control', 'no-cache');
  res.type('html').send(TV_HTML);
});
// Static client assets (core.js, app.css, cards/*.js) — behind the auth gate above.
// no-cache (revalidate via ETag each load) so a deploy is never masked by a stale cached asset.
app.use(express.static(path.join(__dirname, 'public'), { setHeaders: (res) => res.setHeader('Cache-Control', 'no-cache') }));

app.get('/api/status', async (req, res) => {
  try { res.json(await buildStatus()); }
  catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});

// A single day's sets, grouped by exercise — for the heatmap day click-through.
app.get('/api/workout-day', async (req, res) => {
  try {
    const date = String(req.query.date || '').slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: 'bad date' });
    const rows = await sbRange(`sets?occurred_at=gte.${date}T00:00:00&occurred_at=lte.${date}T23:59:59&select=id,occurred_at,exercise,weight_lbs,reps&order=occurred_at`);
    const order = [], byEx = {};
    for (const r of rows) { if (!byEx[r.exercise]) { byEx[r.exercise] = []; order.push(r.exercise); } byEx[r.exercise].push({ id: r.id, weight_lbs: r.weight_lbs, reps: r.reps }); }
    res.json({ date, total: rows.length, exercises: order.map((n) => ({ name: n, sets: byEx[n] })) });
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});

// ---- app settings (voice routing mode + per-device trailing-silence). Read by the worker + devices;
// edited from the hub settings panel. Returns/accepts a flat {key: value} map. ----
app.get('/api/settings', async (req, res) => {
  try {
    const rows = await sb('app_settings?select=key,value');
    const out = {}; for (const r of rows) out[r.key] = r.value;
    res.json(out);
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});
app.post('/api/settings', express.json(), async (req, res) => {
  try {
    const b = req.body || {};
    const key = typeof b.key === 'string' ? b.key.trim() : '';
    if (!key) return res.status(400).json({ error: 'key required' });
    const value = b.value == null ? '' : String(b.value);
    const r = await fetch(`${SUPABASE_URL}/rest/v1/app_settings?on_conflict=key`, {
      method: 'POST',
      headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`,
                 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates' },
      body: JSON.stringify({ key, value, updated_at: new Date().toISOString() }),
    });
    if (!r.ok) throw new Error(`settings upsert -> ${r.status}`);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});

// Register a device's APNs token (sent by the native app, authed by x-hub-token). Upsert so a
// re-launch just refreshes last_seen rather than piling up rows.
app.post('/api/register-push', express.json(), async (req, res) => {
  try {
    const token = String((req.body && req.body.token) || '').trim();
    if (!/^[0-9a-fA-F]{16,}$/.test(token)) return res.status(400).json({ error: 'bad token' });
    const env = (req.body && req.body.environment) === 'production' ? 'production' : 'sandbox';
    const row = {
      token,
      platform: (req.body && req.body.platform) || 'ios',
      bundle_id: (req.body && req.body.bundle_id) || null,
      environment: env,
      last_seen: new Date().toISOString(),
    };
    const r = await fetch(`${SUPABASE_URL}/rest/v1/device_tokens?on_conflict=token`, {
      method: 'POST',
      headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`,
                 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify(row),
    });
    if (!r.ok) throw new Error(`device_tokens upsert -> ${r.status}`);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});

// A single 4am→4am nutrition day's food entries — for the nutrition-log day click-through.
app.get('/api/nutrition-day', async (req, res) => {
  try {
    const date = String(req.query.date || '').slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: 'bad date' });
    const hh = String(DAY_START_HOUR).padStart(2, '0');
    const next = localDate(new Date(Date.parse(date + 'T12:00:00Z') + 86400000));
    const isToday = date === nutritionWindow().day;
    const SEL = 'id,occurred_at,name,calories,protein_g,carbs_g,fat_g,ingredients,staged';
    const [committed, stagedRows, targetRows, fallbackCal, dayWeight] = await Promise.all([
      sbRange(`nutrition_entries?occurred_at=gte.${date}T${hh}:00:00&occurred_at=lt.${next}T${hh}:00:00&staged=eq.false&select=${SEL}&order=occurred_at`),
      // Staged meals (any day) always surface in the CURRENT day's list.
      isToday ? sbRange(`nutrition_entries?staged=eq.true&select=${SEL}&order=logged`) : Promise.resolve([]),
      sb('nutrition_targets?select=date,calories&order=date.asc'),
      currentMaintenanceCal(),
      sb(`weight_log?date=lte.${date}&select=weight_lbs&order=date.desc&limit=1`),  // bodyweight as of this day
    ]);
    // Day total counts ONLY committed (eaten) entries — staged meals never count.
    let total_cal = 0, total_protein = 0, total_carbs = 0, total_fat = 0;
    for (const e of committed) {
      total_cal += Number(e.calories) || 0; total_protein += Number(e.protein_g) || 0;
      total_carbs += Number(e.carbs_g) || 0; total_fat += Number(e.fat_g) || 0;
    }
    total_cal = Math.round(total_cal);
    // Newest first: staged meals on top, then committed entries reverse-chronologically.
    const entries = (stagedRows || []).concat(committed.slice().reverse());
    // historical target for this day: most-recent nutrition_targets snapshot with date <= day
    // (fallback = live maintenance) — same selection buildNutritionLog uses for the calendar.
    const targets = (targetRows || []).map((t) => ({ date: String(t.date).slice(0, 10), calories: Number(t.calories) || 0 }))
      .filter((t) => t.calories > 0).sort((a, b) => (a.date < b.date ? -1 : 1));
    const target_cal = Math.round(targetCalFor(date, targets, fallbackCal));
    const delta_color = target_cal > 0 ? calorieColor(total_cal / target_cal) : null;
    // Per-day macro GOALS, derived from this day's calorie target + bodyweight as of this day
    // (the same dynamic formula the live target uses, so each day has its own historical goal).
    const bw = (dayWeight && dayWeight[0] && Number(dayWeight[0].weight_lbs)) || null;
    const target_macros = target_cal > 0 ? macroTargets(target_cal, bw) : null;
    res.json({
      date,
      total_cal, total_protein: Math.round(total_protein),
      total_carbs: Math.round(total_carbs), total_fat: Math.round(total_fat),
      target_cal, target_macros, delta_color,
      entries,
    });
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});

// "now" as a naive-local wall-clock timestamp in the display TZ → "YYYY-MM-DDTHH:MM:SS"
// (the format nutrition_entries.occurred_at and sets.occurred_at are stored in).
function nowNaiveLocal() {
  const f = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const p = {}; for (const part of f.formatToParts(new Date())) p[part.type] = part.value;
  const hh = p.hour === '24' ? '00' : p.hour; // Intl can emit 24 for midnight
  return `${p.year}-${p.month}-${p.day}T${hh}:${p.minute}:${p.second}`;
}

// Repeat-a-set: log a new set for an exercise at the current time, reusing its weight and taking a
// fresh rep count. Body: {exercise, weight_lbs, reps}. Realtime on `sets` re-pushes the dashboard,
// so the heatmap, day detail, and rest timer all update live.
app.post('/api/log-set', express.json(), async (req, res) => {
  try {
    const b = req.body || {};
    const exercise = typeof b.exercise === 'string' ? b.exercise.trim() : '';
    const reps = Number(b.reps);
    const weight_lbs = Number(b.weight_lbs);
    if (!exercise) return res.status(400).json({ error: 'exercise required' });
    if (!Number.isInteger(reps) || reps <= 0) return res.status(400).json({ error: 'reps must be a positive integer' });
    if (!isFinite(weight_lbs) || weight_lbs < 0) return res.status(400).json({ error: 'weight_lbs must be ≥ 0' });
    const occurred_at = nowNaiveLocal();
    await sbWrite('sets', 'POST', { occurred_at, exercise, weight_lbs, reps });
    res.json({ ok: true, occurred_at });
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});

// Edit a single logged set's weight/reps by id. Body: {id, weight_lbs, reps}. Realtime on `sets`
// re-pushes the dashboard (heatmap, day detail). Exercise/time are left untouched.
app.patch('/api/log-set', express.json(), async (req, res) => {
  try {
    const b = req.body || {};
    const id = Number(b.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'id required' });
    const reps = Number(b.reps);
    const weight_lbs = Number(b.weight_lbs);
    if (!Number.isInteger(reps) || reps <= 0) return res.status(400).json({ error: 'reps must be a positive integer' });
    if (!isFinite(weight_lbs) || weight_lbs < 0) return res.status(400).json({ error: 'weight_lbs must be ≥ 0' });
    await sbWrite(`sets?id=eq.${id}`, 'PATCH', { weight_lbs, reps });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});

// Re-log a past food at the current wall-clock time — the hub's first write action.
// Body: {name, calories, protein_g, carbs_g, fat_g, ingredients?} with macros already
// scaled by the portion multiplier client-side. Stores occurred_at/logged as naive-local
// "now" in the display TZ and date = the 4am-bucket day for now (so a 1–4am add lands on
// the prior day, matching the rest of the hub).
app.post('/api/log-entry', express.json(), async (req, res) => {
  try {
    const b = req.body || {};
    const name = typeof b.name === 'string' ? b.name.trim() : '';
    const num = (v) => (v === null || v === undefined || v === '' || !isFinite(Number(v)) ? null : Number(v));
    const calories = num(b.calories), protein_g = num(b.protein_g), carbs_g = num(b.carbs_g), fat_g = num(b.fat_g);
    if (!name) return res.status(400).json({ error: 'name required' });
    if ([calories, protein_g, carbs_g, fat_g].some((v) => v === null)) {
      return res.status(400).json({ error: 'calories/protein_g/carbs_g/fat_g must be numeric' });
    }
    const occurred_at = nowNaiveLocal(); // naive-local wall-clock in the display TZ
    const row = {
      id: crypto.randomUUID(),
      date: dayBucketOf(occurred_at),
      occurred_at,
      logged: occurred_at,
      name,
      quantity: 1,
      calories: Math.round(calories),
      protein_g: Math.round(protein_g * 10) / 10,
      carbs_g: Math.round(carbs_g * 10) / 10,
      fat_g: Math.round(fat_g * 10) / 10,
    };
    if (Array.isArray(b.ingredients) && b.ingredients.length) {
      row.ingredients = b.ingredients.map((g) => {
        const o = {
          name: String(g.name || g.ingredient || ''),
          calories: Math.round(num(g.calories) || 0),
          protein_g: Math.round((num(g.protein_g) || 0) * 10) / 10,
          carbs_g: Math.round((num(g.carbs_g) || 0) * 10) / 10,
          fat_g: Math.round((num(g.fat_g) || 0) * 10) / 10,
        };
        if (g.food != null) o.food = String(g.food);
        if (g.unit != null) o.unit = String(g.unit);
        if (g.amount != null && isFinite(Number(g.amount))) o.amount = Math.round(Number(g.amount) * 1000) / 1000;
        return o;
      });
    }
    await sbWrite('nutrition_entries', 'POST', row);
    await audit('add', row.id, null, row); // `row` is the full inserted snapshot (id known client-side)
    res.status(204).end();
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});

// Edit an entry in place: PATCH {id, name?, calories, protein_g, carbs_g, fat_g, ingredients?}.
// Absolute values, computed client-side (the popup recovers the original 1× and re-scales), so the
// stored row and its name's "(N×)" suffix always reflect the real multiplier — never compounded.
app.patch('/api/log-entry', express.json(), async (req, res) => {
  try {
    const b = req.body || {};
    const id = typeof b.id === 'string' ? b.id : '';
    if (!id) return res.status(400).json({ error: 'id required' });
    const num = (v) => (v === null || v === undefined || v === '' || !isFinite(Number(v)) ? null : Number(v));
    const calories = num(b.calories), protein_g = num(b.protein_g), carbs_g = num(b.carbs_g), fat_g = num(b.fat_g);
    if ([calories, protein_g, carbs_g, fat_g].some((v) => v === null)) {
      return res.status(400).json({ error: 'calories/protein_g/carbs_g/fat_g must be numeric' });
    }
    const rows = await sb(`nutrition_entries?id=eq.${id}&select=*`);
    const before = (rows || [])[0];
    if (!before) return res.status(404).json({ error: 'not found' });
    const patch = {
      calories: Math.round(calories),
      protein_g: Math.round(protein_g * 10) / 10,
      carbs_g: Math.round(carbs_g * 10) / 10,
      fat_g: Math.round(fat_g * 10) / 10,
    };
    if (typeof b.name === 'string' && b.name.trim()) patch.name = b.name.trim();
    if (Array.isArray(b.ingredients)) {
      patch.ingredients = b.ingredients.map((g) => {
        const o = {
          name: String(g.name || g.ingredient || ''),
          calories: Math.round(num(g.calories) || 0),
          protein_g: Math.round((num(g.protein_g) || 0) * 10) / 10,
          carbs_g: Math.round((num(g.carbs_g) || 0) * 10) / 10,
          fat_g: Math.round((num(g.fat_g) || 0) * 10) / 10,
        };
        if (g.food != null) o.food = String(g.food);
        if (g.unit != null) o.unit = String(g.unit);
        if (g.amount != null && isFinite(Number(g.amount))) o.amount = Math.round(Number(g.amount) * 1000) / 1000;
        return o;
      });
    }
    await sbWrite(`nutrition_entries?id=eq.${id}`, 'PATCH', patch);
    await audit('edit', id, before, { ...before, ...patch });
    res.status(204).end();
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});

// Delete an entry: DELETE ?id=<uuid>. Snapshots the full row first so the audit `before`
// can fully re-insert it.
app.delete('/api/log-entry', async (req, res) => {
  try {
    const id = String(req.query.id || '');
    if (!id) return res.status(400).json({ error: 'id required' });
    const rows = await sb(`nutrition_entries?id=eq.${id}&select=*`);
    const before = (rows || [])[0];
    if (!before) return res.status(404).json({ error: 'not found' });
    await sbWrite(`nutrition_entries?id=eq.${id}`, 'DELETE', undefined);
    await audit('delete', id, before, null);
    res.status(204).end();
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});

// Commit a staged meal from the UI: flip staged→false and stamp it "now" so it logs as eaten and
// starts counting. Realtime on nutrition_entries re-pushes the dashboard.
app.post('/api/commit-staged', express.json(), async (req, res) => {
  try {
    const id = typeof (req.body && req.body.id) === 'string' ? req.body.id : '';
    if (!id) return res.status(400).json({ error: 'id required' });
    const rows = await sb(`nutrition_entries?id=eq.${id}&staged=eq.true&select=*`);
    const before = (rows || [])[0];
    if (!before) return res.status(404).json({ error: 'staged meal not found' });
    const occurred_at = nowNaiveLocal();
    const patch = { staged: false, occurred_at, logged: occurred_at, date: dayBucketOf(occurred_at) };
    await sbWrite(`nutrition_entries?id=eq.${id}`, 'PATCH', patch);
    await audit('edit', id, before, { ...before, ...patch });
    res.status(204).end();
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});

// Server-Sent Events: push assembled status to the browser, instantly on any DB change.
app.get('/api/stream', async (req, res) => {
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache',
            Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.flushHeaders();
  sseClients.add(res);
  try { res.write('data: ' + JSON.stringify(await buildStatus()) + '\n\n'); } catch {}
  const ka = setInterval(() => { try { res.write(': keepalive\n\n'); } catch {} }, 25000);  // SSE heartbeat (proxy idle)
  req.on('close', () => { clearInterval(ka); sseClients.delete(res); });
});

// Backfill recent voice_messages for a focus so the /tv panel populates on load before live
// updates arrive. Ordered created_at asc (oldest→newest, the render order). focus defaults to 'hub'.
app.get('/api/voice-messages', async (req, res) => {
  try {
    const focus = String(req.query.focus || 'hub');
    let limit = parseInt(req.query.limit, 10);
    if (!Number.isFinite(limit) || limit <= 0) limit = 50;
    limit = Math.min(limit, 500);
    const rows = await sb(`voice_messages?focus=eq.${encodeURIComponent(focus)}&order=created_at.asc&limit=${limit}&select=*`);
    res.json(rows || []);
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});

// The focusable Mac sessions (5 most recent), newest first — for the /tv focusable list.
// Pushed-to on change via the voice SSE (kind:'sessions'); this is the load/refresh fetch.
app.get('/api/voice-sessions', async (req, res) => {
  try {
    const rows = await sb('voice_sessions?order=last_active.desc&select=*');
    res.json(rows || []);
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});

// In-app voice button: the browser/app uploads a recorded clip; we transcribe it with the SAME
// Groq Whisper the ESP uses, then enqueue into voice_requests exactly like the Jarvis path. The
// Mac worker claims it and writes the user+assistant turns into voice_messages (focus 'hub') —
// the one shared conversation shown on the TV wall and in the app. Audio is never stored.
app.post('/api/voice-command', express.raw({ type: '*/*', limit: '25mb' }), async (req, res) => {
  try {
    if (!GROQ_API_KEY) return res.status(503).json({ error: 'transcription not configured' });
    const audio = req.body;
    if (!audio || !audio.length) return res.status(400).json({ error: 'no audio' });
    const ct = String(req.headers['content-type'] || 'audio/webm');
    const ext = ct.includes('mp4') || ct.includes('m4a') ? 'm4a'
              : ct.includes('mpeg') ? 'mp3' : ct.includes('wav') ? 'wav'
              : ct.includes('ogg') ? 'ogg' : 'webm';
    const form = new FormData();
    form.append('file', new Blob([audio], { type: ct }), `clip.${ext}`);
    form.append('model', 'whisper-large-v3-turbo');
    form.append('response_format', 'text');
    const gr = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
      method: 'POST', headers: { Authorization: `Bearer ${GROQ_API_KEY}` }, body: form });
    if (!gr.ok) return res.status(502).json({ error: `transcription failed (${gr.status})` });
    const transcript = (await gr.text()).trim();
    if (!transcript) return res.json({ transcript: '', enqueued: false });
    // The bottom-right quick-add FAB sends ?quick=1 → tag the request so the worker asks Jarvis for a
    // terse, fits-in-the-status-chip confirmation. The full conversation card omits it (verbose replies).
    const quick = String(req.query.quick || '') === '1';
    const tier = ['fast', 'power'].includes(String(req.query.tier || '')) ? String(req.query.tier) : null;
    await sbWrite('voice_requests', 'POST', { transcript, source: quick ? 'web-quick' : 'web', focus: 'hub', ...(tier ? { tier } : {}) });
    res.json({ transcript, enqueued: true });
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});

// Typed command from the Jarvis card — no audio, just enqueue the text like the voice path.
app.post('/api/voice-text', express.json(), async (req, res) => {
  try {
    const text = String((req.body && req.body.text) || '').trim();
    if (!text) return res.status(400).json({ error: 'empty' });
    const tier = ['fast', 'power'].includes(String((req.body && req.body.tier) || '')) ? String(req.body.tier) : null;
    await sbWrite('voice_requests', 'POST', { transcript: text, source: 'web', focus: 'hub', ...(tier ? { tier } : {}) });
    res.json({ enqueued: true });
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});

// Reset the shared hub conversation: clear the stored thread, tell every live surface (web card +
// TV panel) to clear, and enqueue a sentinel so the Mac worker drops its resumed Claude session —
// the next command starts with fresh context.
app.post('/api/voice-reset', async (req, res) => {
  try {
    await sbWrite('voice_messages?focus=eq.hub', 'DELETE');
    pushVoice('reset', null);
    await sbWrite('voice_requests', 'POST', { transcript: VOICE_RESET_SENTINEL, source: 'web', focus: 'hub' });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});

// Low-latency activity push from the Mac worker: transient "what Jarvis is doing right now" events
// (each tool call + args, and a done marker) relayed straight to the SSE clients, bypassing the
// Supabase-realtime hop so the on-screen activity bar tracks the run in real time. Not persisted.
app.post('/api/voice-activity', express.json(), (req, res) => {
  const b = req.body || {};
  pushVoice('activity', {
    text: String(b.text || '').slice(0, 400),
    state: b.state === 'done' ? 'done' : 'tool',
    focus: String(b.focus || 'hub'),
  });
  res.status(204).end();
});

// Voice SSE: streams `event: voice` frames ({kind:'message'|'focus', row}) to the /tv panel.
// Dedicated stream (not /api/stream) so the kiosk gets voice rows without the heavy status frame.
app.get('/api/voice-stream', (req, res) => {
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache',
            Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.flushHeaders();
  voiceClients.add(res);
  const ka = setInterval(() => { try { res.write(': keepalive\n\n'); } catch {} }, 25000);
  req.on('close', () => { clearInterval(ka); voiceClients.delete(res); });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`status-hub on :${PORT}`);
  startRealtime();
  // Time-based fields (pace drain, volume drop-off) change with the clock, not just on DB
  // edits — so re-push a fresh frame on a timer too. Push, not client polling; gated on
  // having connected clients so it's free when nobody's watching.
  setInterval(() => { if (sseClients.size) broadcast(); }, 30000);
});

// ---- daily weight-logging push reminder (APNs). Checks each minute; fires once/day at the
// configured time unless weight or food is already logged (see lib/weightReminder.js). ----
async function sbInsert(table, row) {
  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
      method: 'POST',
      headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`,
                 'Content-Type': 'application/json', Prefer: 'return=minimal' },
      body: JSON.stringify(row),
    });
    return r.ok;
  } catch (_) { return false; }
}
const reminderCtx = { sb, supaInsert: sbInsert, apns, log: (m) => console.log('[weight-reminder]', m) };
setInterval(() => weightReminder.tick(reminderCtx).catch((e) => console.log('[weight-reminder] error', e.message)), 60000);
weightReminder.tick(reminderCtx).catch(() => {});  // also evaluate once on boot
console.log(`[weight-reminder] armed (apns: ${apns.configured() ? 'configured, ' + apns.ENV : 'NOT configured'})`);

// ---- login page (server-rendered; public, no client modules) ----
function loginHtml(err) {
  return `<!doctype html><meta name=viewport content="width=device-width,initial-scale=1">
<title>Status Hub</title><style>
body{background:#0b0d10;color:#e8eaed;font:16px system-ui;display:grid;place-items:center;height:100vh;margin:0}
form{background:#151a20;padding:28px;border-radius:14px;width:280px;text-align:center}
input{width:100%;padding:12px;margin:10px 0;border-radius:8px;border:1px solid #2a313a;background:#0b0d10;color:#e8eaed;box-sizing:border-box}
button{width:100%;padding:12px;border:0;border-radius:8px;background:#3b82f6;color:#fff;font-weight:600;cursor:pointer}
.err{color:#f87171;font-size:14px;min-height:18px}</style>
<form method=post action=/login><h2>Status Hub</h2>
<div class=err>${err || ''}</div>
<input type=password name=password placeholder=Password autofocus>
<button>Enter</button></form>`;
}
