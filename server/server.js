'use strict';
const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');
const WebSocket = require('ws');
const heicConvert = require('heic-convert');
const { estimateMaintenance, estimateHistory, macroTargets } = require('./lib/maintenance');
const pace = require('./lib/pace');
const { computeVolume } = require('./lib/volume');
const BODY_SVG = require('./lib/bodymap');
const { getTZ, setTZ, DAY_START_HOUR, localDate, nutritionWindow, lastNTrainingDays, dayBucketOf } = require('./lib/dates');
const { buildWorkoutHeatmap } = require('./lib/heatmap');
const { buildNutritionLog, buildGoalResolver, calorieColor } = require('./lib/nutritionlog');
const { computeScore } = require('./lib/score');

// Settings cache: app_settings is read several times per status build but only changes on explicit
// writes, which the realtime subscription announces (→ dirtySettings). One whole-table fetch serves
// every reader; the 15-min backstop covers a silently dropped realtime event.
const settingsCache = { map: null, at: 0 };
const SETTINGS_BACKSTOP_MS = 15 * 60 * 1000;
const dirtySettings = () => { settingsCache.map = null; };

// Upsert one app_settings row. app_settings is keyed, so this needs the merge-duplicates Prefer
// header — a plain POST on an existing key 409s (which is why sbWrite, having no Prefer, can't
// be used here). Throws on failure.
async function putSetting(key, value) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/app_settings?on_conflict=key`, {
    method: 'POST',
    headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`,
               'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates' },
    body: JSON.stringify({ key, value, updated_at: new Date().toISOString() }),
  });
  if (!r.ok) throw new Error(`settings upsert ${key} -> ${r.status}`);
}
async function settingsAll() {
  if (settingsCache.map && Date.now() - settingsCache.at < SETTINGS_BACKSTOP_MS) return settingsCache.map;
  const rows = await sb('app_settings?select=key,value');
  settingsCache.map = Object.fromEntries((rows || []).map((r) => [r.key, r.value]));
  settingsCache.at = Date.now();
  if (setTZ(settingsCache.map.display_tz)) console.log(`[tz] display timezone -> ${getTZ()}`);
  return settingsCache.map;
}

// Current surplus/deficit setting (signed kcal over maintenance; default +150 lean-bulk). Drives the
// live daily goal and the active run's goal on the plot/heatmap. Editable in the settings panel.
const SURPLUS_LIMIT = 1000; // clamp: nobody runs a surplus/deficit beyond ~1000 kcal; guards typos
// Daily produce goals (vegetables / dark green vegetables / fruit). FIXED constants in app_settings — nothing
// recalculates them, unlike the macro targets which the maintenance engine re-derives every build.
// veg INCLUDES dark_green (dark green is a floor within the vegetable goal), so the two are never added.
const PRODUCE_TARGET_DEFAULTS = { veg_g: 300, dark_green_g: 150, fruit_g: 250 };
async function produceTargets() {
  try {
    const s = await settingsAll();
    const pick = (key, dflt) => {
      const v = parseFloat(s[key]);
      return Number.isFinite(v) && v > 0 ? v : dflt;
    };
    return {
      veg_g: pick('produce_target_veg_g', PRODUCE_TARGET_DEFAULTS.veg_g),
      dark_green_g: pick('produce_target_dark_green_g', PRODUCE_TARGET_DEFAULTS.dark_green_g),
      fruit_g: pick('produce_target_fruit_g', PRODUCE_TARGET_DEFAULTS.fruit_g),
    };
  } catch { return { ...PRODUCE_TARGET_DEFAULTS }; }
}

async function surplusCal() {
  try {
    const v = parseInt((await settingsAll()).surplus_cal, 10);
    if (!Number.isFinite(v)) return 150;
    return Math.max(-SURPLUS_LIMIT, Math.min(SURPLUS_LIMIT, v));
  } catch { return 150; }
}
// Idle gap (seconds) after which the hub agent resets its context — the worker's `session_reset_s`
// setting (default 30min). Used to scope the conversation panel to the current context.
async function sessionResetS() {
  try {
    const v = parseFloat((await settingsAll()).session_reset_s);
    return Number.isFinite(v) && v > 0 ? v : 1800;
  } catch { return 1800; }
}
// Min length (days) of the aligned intake-tracking window before adaptive maintenance goes live.
// Editable in settings; default 14, clamped to a sane 7–60.
async function maintenanceMinDays() {
  try {
    const v = parseInt((await settingsAll()).maintenance_min_days, 10);
    return Number.isFinite(v) && v >= 7 && v <= 60 ? v : 14;
  } catch { return 14; }
}
// Current goal phase: { start, seed, sign, hold }. A phase begins when surplus_cal flips sign
// (bulk↔cut); its start caps the maintenance window and `seed` holds the pre-flip maintenance until the
// new phase has enough of its own data. Stored as JSON in app_settings.maintenance_phase.
async function maintenancePhase() {
  try {
    const raw = (await settingsAll()).maintenance_phase;
    if (!raw) return null;
    const p = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!p || !p.start) return null;
    return { start: String(p.start).slice(0, 10), seed: p.seed != null ? Number(p.seed) : null,
             sign: Number(p.sign) || 0, hold: !!p.hold };
  } catch { return null; }
}
// Voice state for the TV strip + the mic-liveness check: whether always-on (wake-free) voice and inject
// mode are on. Routing is fixed now (standard Sonnet→Opus), so there's no model/route to resolve here.
async function routingConfig() {
  let s = {};
  try { s = await settingsAll(); } catch { /* fall through to defaults */ }
  return {
    wake: ['1', 'true', 'on', 'yes'].includes(String(s.wakefree_enabled ?? '0').toLowerCase()),
    inject: ['1', 'true', 'on', 'yes'].includes(String(s.voice_inject_mode ?? '0').toLowerCase()),
  };
}
const { buildVariants } = require('./lib/variants');
const apns = require('./lib/apns');
const weightReminder = require('./lib/weightReminder');

const PORT = process.env.PORT || 8080;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const HUB_PASSWORD = process.env.HUB_PASSWORD || 'changeme';
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
// The SECOND wall, served at /tv2. It starts as a byte-identical copy of tv.html and is where the
// always-on, no-interaction display is being built — the one that has to read from across a room and,
// eventually, from a watch. It is a separate FILE rather than a mode flag so the wall the Pi is
// showing today cannot be disturbed by work on it; the two share their scripts until something has to
// diverge, and whatever diverges gets split at that point.
const TV2_HTML = fs.readFileSync(path.join(__dirname, 'public', 'tv2.html'), 'utf8')
  .replace('<!--BODY_SVG-->', BODY_SVG);
// Minimal home-screen "Voice" launcher (Add to Home Screen → standalone fullscreen tap-to-talk button).
const MIC_HTML = fs.readFileSync(path.join(__dirname, 'public', 'mic.html'), 'utf8');

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


// Current time as minutes into the 4am-origin day, in the display timezone.
function nowOffsetTZ() {
  const f = new Intl.DateTimeFormat('en-US', { timeZone: getTZ(), hour12: false, hour: '2-digit', minute: '2-digit' });
  const parts = f.formatToParts(new Date());
  const hh = Number(parts.find((p) => p.type === 'hour').value) % 24;
  const mm = Number(parts.find((p) => p.type === 'minute').value);
  return pace.offsetFromHM(hh, mm);
}

// A moment as local wall-clock in the display timezone, 'YYYY-MM-DDTHH:MM:SS'. Reminder due times
// are stored as local-naive ISO strings, so rendering into the same shape lets them be compared (and
// written) as plain strings with no UTC offset math anywhere.
function etStringAt(d) {
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: getTZ(), hour12: false, year: 'numeric', month: '2-digit',
    day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(d);
  const g = (t) => p.find((x) => x.type === t).value;
  const hh = g('hour') === '24' ? '00' : g('hour');
  return `${g('year')}-${g('month')}-${g('day')}T${hh}:${g('minute')}:${g('second')}`;
}
const etNowString = () => etStringAt(new Date());

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

// ---- dashboard source-row cache ------------------------------------------------------------
// The 30s broadcast tick exists to advance clock-derived fields (pace drain, session clock) — but
// the DB rows it renders only change on writes, and realtime already announces every write. So the
// heavy queries are fetched once and reused for every rebuild; a refetch happens only when
// (a) realtime dirtied the cache, (b) the date windows embedded in the queries rolled over, or
// (c) the 15-min reconciliation backstop lapses (covers a silently dropped realtime event).
// Presence and device_status rows are NOT cached — they're tiny (~200B/~1KB) and are WRITTEN every
// couple of minutes by design (worker heartbeats, litter/feeder state mirrors); caching them would
// make those routine writes dirty the cache and drag the 11 heavy queries along ~720×/day.
// This took Supabase egress from ~143KB × every 30s (≈0.5GB/day, the free-plan quota blowout) to
// effectively zero at idle.
const rowCache = { rows: null, key: '', at: 0, dirty: true };
const ROWCACHE_BACKSTOP_MS = 15 * 60 * 1000;
const dirtyRows = () => { rowCache.dirty = true; };

async function fetchStatusRows(win, week, histStart, heatStart) {
  const nutLogStart = localDate(new Date(Date.now() - 86 * 86400000));
  const key = [win.start, win.end, week[0], histStart, heatStart, nutLogStart].join('|');
  if (!rowCache.dirty && rowCache.rows && rowCache.key === key
      && Date.now() - rowCache.at < ROWCACHE_BACKSTOP_MS) return rowCache.rows;
  const [entries, setRows, weightRows, histRows, muscleRows, heatRows, catalogRows, nutLogRows, targetRows, surfRows] = await Promise.all([
    sb(`nutrition_entries?occurred_at=gte.${win.start}&occurred_at=lt.${win.end}&staged=eq.false&select=calories,protein_g,carbs_g,fat_g,veg_g,dark_green_g,fruit_g`),
    sb(`sets?occurred_at=gte.${week[0]}T00:00:00&select=occurred_at,exercise,muscles_override`),
    sb('weight_log?select=date,weight_lbs&order=date.asc'),
    sbRange(`nutrition_entries?occurred_at=gte.${histStart}T00:00:00&staged=eq.false&select=occurred_at,calories&order=occurred_at`),
    sb('exercise_muscles?select=name,muscle,contribution'),
    sbRange(`sets?occurred_at=gte.${heatStart}T00:00:00&select=occurred_at&order=occurred_at`),
    sb('exercise_catalog?select=name,equipment'),
    sbRange(`nutrition_entries?occurred_at=gte.${nutLogStart}T00:00:00&staged=eq.false&select=occurred_at,calories,protein_g,fat_g&order=occurred_at`),
    sb('nutrition_targets?select=date,calories&order=date.asc'),
    sb('surf_snapshots?select=slug,water_temp,captured_at,rows&order=captured_at.desc&limit=1'),
  ]);
  rowCache.rows = { entries, setRows, weightRows, histRows, muscleRows, heatRows, catalogRows, nutLogRows, targetRows, surfRows };
  rowCache.key = key; rowCache.at = Date.now(); rowCache.dirty = false;
  return rowCache.rows;
}

async function buildStatus() {
  const win = nutritionWindow();
  const today = win.day;
  const week = lastNTrainingDays(7);
  const histStart = localDate(new Date(Date.now() - 210 * 86400000)); // intake history for the maintenance trend + per-day replay (viz paging)
  const heatStart = localDate(new Date(Date.now() - 140 * 86400000)); // ~20 weeks for the workout volume heatmap

  const [{ entries, setRows, weightRows, histRows, muscleRows, heatRows, catalogRows, nutLogRows, targetRows, surfRows }, deviceRows, presenceRows, workerRows] = await Promise.all([
    fetchStatusRows(win, week, histStart, heatStart),
    sb('device_status?select=*'),
    sb('voice_presence?select=source,alive_at'),
    sb('worker_presence?select=worker,last_seen'),
  ]);

  const litter = (deviceRows || []).find((d) => d.device !== 'cat-feeder') || null;
  const feeder = (deviceRows || []).find((d) => d.device === 'cat-feeder') || null;
  const surf = buildSurf((surfRows || [])[0]);

  const sum = (k) => (entries || []).reduce((a, e) => a + (Number(e[k]) || 0), 0);
  const nutrition = {
    calories: Math.round(sum('calories')),
    protein_g: Math.round(sum('protein_g')),
    carbs_g: Math.round(sum('carbs_g')),
    fat_g: Math.round(sum('fat_g')),
    // Produce grams. veg_g ALREADY includes dark_green_g — the data layer rolls dark greens into both, so these
    // are summed straight across and must never be added together.
    veg_g: Math.round(sum('veg_g')),
    dark_green_g: Math.round(sum('dark_green_g')),
    fruit_g: Math.round(sum('fruit_g')),
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
  const surplus = await surplusCal();   // current surplus/deficit setting
  const routing = await routingConfig();   // agent model / thinking / runner / wake (TV routing panel)

  // The session a spoken follow-up would land in — shown on the TV strip so the answer is ambient
  // rather than something you have to open a pane to learn. Resolved exactly as the MCP resolves it,
  // through desk_focus.command_id to the session that command created, so the wall and the behaviour
  // cannot disagree. Null when the pointer names a session that has since been closed, which is a
  // real state and is rendered as such.
  let deskFocus = null;
  try {
    const [fRows, sRows] = await Promise.all([
      sb('desk_focus?id=eq.current&select=command_id'),
      sb('desk_sessions?status=eq.resident&select=id,repo,label,command_id'),
    ]);
    const cmd = (fRows || [])[0]?.command_id || null;
    const hit = cmd ? (sRows || []).find((r) => r.command_id === cmd) : null;
    if (hit) deskFocus = { id: hit.id, repo: hit.repo, label: hit.label || null };
  } catch (_) { /* the strip simply shows nothing rather than failing the whole payload */ }

  // ---- mic / worker liveness ----
  // Mics beacon voice_presence.alive_at every 30s WHILE audio frames are flowing (not merely while the
  // process exists); workers heartbeat worker_presence.last_seen every 10s. Stale = down. The Mac mic is
  // keyed on whichever process OWNS the mic: wakefree.py when always-on voice is on, the wake-word
  // listener otherwise — so a dead owner can't hide behind its healthy sibling.
  const LIVENESS_STALE_S = 90;   // 3 missed 30s beacons
  const freshFor = (ts) => !!ts && (Date.now() - new Date(ts).getTime()) / 1000 <= LIVENESS_STALE_S;
  const aliveBy = Object.fromEntries((presenceRows || []).map((r) => [r.source, r.alive_at]));
  const beatBy = Object.fromEntries((workerRows || []).map((r) => [r.worker, r.last_seen]));
  const mics = {
    esp: freshFor(aliveBy.esp),
    mac: freshFor(aliveBy[routing.wake ? 'mac-wakefree' : 'mac-listener']),
    workers: { mac: freshFor(beatBy.mac), pi: freshFor(beatBy.pi), fly: freshFor(beatBy.fly) },
  };
  const minAlignedDays = await maintenanceMinDays();
  const phase = await maintenancePhase();   // caps the live window at the current goal phase; NOT passed to
  const maintenance = estimateMaintenance({ weights, intakeByDay, today, surplus, minAlignedDays, phase });
  // estimateHistory — the per-day replay stays phase-less so past goals are never backfilled.
  if (maintenance.viz) maintenance.viz.series = estimateHistory({ weights, intakeByDay, today, surplus, minAlignedDays });
  // ...but the replay's FINAL point still reflects the old straddled calc, so override ONLY today's point
  // with the live phase-aware number — the on-plot curve + its labels then agree with the header/math,
  // while every prior day stays frozen (no backfill).
  if (maintenance.viz && maintenance.viz.series && maintenance.viz.series.length && maintenance.source !== 'calibrating') {
    const lastPt = maintenance.viz.series[maintenance.viz.series.length - 1];
    if (lastPt && lastPt.date === today) {
      lastPt.avg = maintenance.avg_intake;
      lastPt.maintenance = maintenance.maintenance;
      lastPt.target = maintenance.target;
    }
  }
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
  // Produce rings are NOT paced. The macro rings are drain gauges (full = on-pace, draining with the
  // clock); produce starts EMPTY each day and simply fills toward a fixed goal. No window, no marker,
  // no time term at all — so it goes through computeFill(), never computePace().
  paceData.produce = pace.computeFill(
    { veg_g: nutrition.veg_g, dark_green_g: nutrition.dark_green_g, fruit_g: nutrition.fruit_g },
    await produceTargets(),
  );

  // ---- weekly per-muscle volume gauges ----
  const volume = computeVolume(setRows || [], muscleRows || [], week);
  volume.exercise_variants = buildVariants(catalogRows || []); // exercise → equipment variants + YouTube how-to links

  // ---- workout volume heatmap (GitHub-contribution style) ----
  const heatmap = buildWorkoutHeatmap(heatRows, 20, today); // 20 weeks + 4am `today`, matching the nutrition heatmap

  // ---- nutrition log: calorie-adherence calendar (per-day historical targets) + calorie/weight trend ----
  const nutrition_log = buildNutritionLog(nutLogRows || [], weights, maintenance.target, maintenance.maintenance, today, targetRows || [], 20, surplus, 150, paceData.fraction);

  // ---- overall score (0.5·training + 0.5·nutrition over the rolling week) ----
  const { goalForDay } = buildGoalResolver({ rows: nutLogRows || [], weights, targets: targetRows || [], today, surplus, fallbackMaint: maintenance.maintenance });
  const dayCPF = {};   // 4am-day bucket -> {cal, protein, fat} actuals
  for (const e of nutLogRows || []) {
    const d = dayBucketOf(e.occurred_at);
    const x = (dayCPF[d] = dayCPF[d] || { cal: 0, protein: 0, fat: 0 });
    x.cal += Number(e.calories) || 0; x.protein += Number(e.protein_g) || 0; x.fat += Number(e.fat_g) || 0;
  }
  const wForDay = (ds) => { let w = null; for (const x of weights) { if (x.date <= ds) w = x.weight; else break; } return w; };  // weights are date-asc
  const scoreDays = week.map((d) => {
    const a = dayCPF[d] || { cal: 0, protein: 0, fat: 0 };
    const calGoal = goalForDay(d);
    const mt = macroTargets(calGoal, wForDay(d));
    return { date: d, isToday: d === today, fraction: paceData.fraction, cal: a.cal, protein: a.protein, fat: a.fat,
             calGoal, proteinFloor: mt.protein_g, fatTarget: mt.fat_g };
  });
  const score = computeScore({ volume, days: scoreDays, surplus });   // surplus signs the goal-aware calorie scoring

  // The rep watcher: what the Apple Watch app's counted sets are currently being
  // logged as. Shown under the rest clock so it is visible at a glance whether a set
  // about to be performed will actually be recorded — knowing that BEFORE the set is
  // the only time it helps. Ten minutes with no set clears it, mirrored from the SQL
  // so the UI and the trigger agree on what "live" means.
  let rep_watcher = null;
  try {
    const rw = (await sb('set_watcher?id=eq.1&select=exercise,weight_lbs,armed_at,last_set_at'))[0];
    if (rw && rw.exercise) {
      const stamp = rw.last_set_at || rw.armed_at;
      if (stamp && Date.now() - new Date(stamp).getTime() < 10 * 60 * 1000) {
        rep_watcher = { exercise: rw.exercise, weight_lbs: rw.weight_lbs };
      }
    }
  } catch (_) { /* watcher is a nicety; never fail the dashboard over it */ }

  const last_set_at = (heatRows && heatRows.length) ? heatRows[heatRows.length - 1].occurred_at : null;
  // session_start_at: the first set of the trailing run where consecutive sets are <=20min apart. The
  // client shows (now - session_start) as the session clock while the last set is <20min old, and lets
  // it reset to zero once a 20min gap opens (the session ended). A >20min gap breaks the run, so a new
  // workout's first set becomes the new session start.
  const SESSION_GAP_MS = 20 * 60 * 1000;
  let session_start_at = last_set_at;
  if (heatRows && heatRows.length) {
    for (let i = heatRows.length - 1; i > 0; i--) {
      const gap = new Date(heatRows[i].occurred_at).getTime() - new Date(heatRows[i - 1].occurred_at).getTime();
      if (gap <= SESSION_GAP_MS) session_start_at = heatRows[i - 1].occurred_at;
      else break;
    }
  }
  return { today, litter, feeder, surf, nutrition, maintenance, pace: paceData, volume, heatmap, nutrition_log,
    last_set_at, session_start_at, rep_watcher, routing, mics, score, desk_focus: deskFocus,
    generated_at: new Date().toISOString() };
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
// (Transient 'activity'/'reset' events are pushed directly from the worker via /api/voice-activity.)
// The browser keys off kind.
function pushVoice(kind, row) {
  const frame = 'event: voice\ndata: ' + JSON.stringify({ kind, row }) + '\n\n';
  for (const res of voiceClients) { try { res.write(frame); } catch {} }
}

// Last time ANY realtime event arrived. The socket can sit reporting SUBSCRIBED while
// delivering nothing — it has done exactly that on the voice server and the Mac
// listener, and the only symptom is that things stop appearing. Nothing in the client
// notices, so liveness has to be judged by whether events are actually arriving.
let lastRealtimeEvent = Date.now();
let hubChannel = null;

// device_status is mirrored roughly every two minutes by other devices, so in normal
// operation this channel is never quiet for long. Silence well past that is the
// signature of a dead socket rather than a quiet house.
const REALTIME_SILENCE_LIMIT_MS = 6 * 60 * 1000;

function startRealtime() {
  // A change to any cached source table dirties the row cache, then rebuilds + pushes. The extra
  // subscriptions (weight_log … surf_snapshots) exist for the cache: without them an edit would sit
  // invisible until the 15-min backstop refetch.
  const seen = () => { lastRealtimeEvent = Date.now(); };
  const changed = () => { seen(); dirtyRows(); dirtyNutDay(); dirtyWorkoutDay(); broadcast(); };
  hubChannel = supa.channel('hub-changes')
    // device_status is fetched live per build (not cached) — its routine ~2-min state mirrors must
    // rebuild the frame but must NOT drag the heavy cached queries along. Plain broadcast only.
    .on('postgres_changes', { event: '*', schema: 'public', table: 'device_status' },
      () => { seen(); broadcast(); })
    .on('postgres_changes', { event: '*', schema: 'public', table: 'nutrition_entries' }, changed)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'sets' }, changed)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'weight_log' }, changed)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'nutrition_targets' }, changed)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'exercise_catalog' }, changed)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'exercise_muscles' }, changed)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'surf_snapshots' }, changed)
    // The rep watcher, so setting it appears at once rather than on the next periodic
    // frame. Its whole value is confirming BEFORE a set that sets are being logged as
    // the right thing, and a delay there defeats the purpose. workset_reports is NOT
    // subscribed: every report writes a row to `sets`, which is, so the push already
    // happens and adding reports would only duplicate it.
    .on('postgres_changes', { event: '*', schema: 'public', table: 'set_watcher' }, changed)
    // Settings (routing model/thinking/runner, wake toggle, nutrition goal): rebuild so the TV routing
    // panel reflects an MCP/voice/settings change near-instantly instead of waiting for the 30s tick.
    .on('postgres_changes', { event: '*', schema: 'public', table: 'app_settings' }, (p) => {
      seen();
      dirtySettings();
      dirtyNutDay();   // surplus_cal shapes the day header's goal figures
      broadcast(p);
      // When the agent_mode toggle flips (from anywhere — voice, another device), tell the voice panel to
      // switch to that mode's conversation live, so the on-screen context always matches the active mode.
      if (p.new && p.new.key === 'agent_mode') {
        const agent = ['1', 'true', 'on', 'yes'].includes(String(p.new.value).toLowerCase());
        pushVoice('mode', { agent });
      }
    })
    // Voice pipeline: stream inserts/updates straight to the /tv conversation panel. INSERT and
    // UPDATE both carry the new row in `payload.new` (UPDATE = a streamed row flipping done=true).
    .on('postgres_changes', { event: '*', schema: 'public', table: 'voice_messages' },
      (p) => { seen(); if (p.new) pushVoice('message', p.new); })
    .subscribe((status) => {
      console.log('realtime channel:', status);
      // SUBSCRIBED means the handshake completed, not that events will flow. Treat it
      // only as "the clock starts now" so a channel that comes back deaf still trips
      // the watchdog instead of looking healthy forever.
      if (status === 'SUBSCRIBED') lastRealtimeEvent = Date.now();
    });
}

// Recycle a socket that has gone quiet.
//
// A half-open realtime connection reports SUBSCRIBED and delivers nothing. The
// visible effect is that a set logged on the watch does not reach the screen until
// the 15-minute cache backstop lapses, which reads as "the hub is slow" rather than
// as a fault. Reconnecting is cheap and the check costs one comparison a minute.
setInterval(() => {
  const quiet = Date.now() - lastRealtimeEvent;
  if (quiet < REALTIME_SILENCE_LIMIT_MS) return;
  console.log(`realtime silent for ${Math.round(quiet / 1000)}s — recycling the socket`);
  try { if (hubChannel) supa.removeChannel(hubChannel); } catch (e) { console.log('removeChannel:', e.message); }
  lastRealtimeEvent = Date.now();   // give the new channel a full window before retrying
  try { startRealtime(); } catch (e) { console.log('resubscribe failed:', e.message); }
}, 60000);

// ---- auth ----
function getCookie(req, name) {
  const m = (req.headers.cookie || '').match(new RegExp('(?:^|; )' + name + '=([^;]+)'));
  return m ? decodeURIComponent(m[1]) : null;
}
// Web uses the 'hub' cookie; the native app sends the same derived token as a header.
const authed = (req) => getCookie(req, 'hub') === TOKEN || req.headers['x-hub-token'] === TOKEN;

// Public (before the auth gate). Reports the commit this instance is RUNNING, which is the only way
// to tell a deploy that shipped from one that silently never ran — a push whose workflow never fired
// looks identical to a successful one from the outside, and did exactly that twice on 2026-08-26.
// COMMIT is stamped at deploy time; 'dev' locally.
app.get('/healthz', (req, res) => res.type('text').send('ok ' + (process.env.COMMIT || 'dev')));
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

// Wall view is the DEFAULT everywhere — both '/' and '/tv' serve it (the app loads '/'; the Pi loads '/tv').
// The full detail page moves to '/page'. Each view's bottom-bar toggle flips between them. no-cache so a
// deploy is never masked by a stale cached page.
app.get(['/', '/tv'], (req, res) => {
  res.setHeader('Cache-Control', 'no-cache');
  res.type('html').send(TV_HTML);
});
app.get('/tv2', (req, res) => {
  res.setHeader('Cache-Control', 'no-cache');
  res.type('html').send(TV2_HTML);
});
app.get('/page', (req, res) => {
  res.setHeader('Cache-Control', 'no-cache');
  res.type('html').send(DASHBOARD_HTML);
});
app.get('/mic', (req, res) => {
  res.setHeader('Cache-Control', 'no-cache');
  res.type('html').send(MIC_HTML);
});

// ---- reports: a dispatched session's HTML write-up of finished work -------------------------
//
// SECURITY, and it is the whole reason this route looks the way it does. The HTML in `reports.html`
// was written by a model, and it is opened inside the app's WKWebView, which is already authenticated
// to this hub. Served plainly, script in that document would be same-origin with the dashboard and
// could call /api/* — clearing todos, opening sessions — using Jared's own cookie.
//
// So the response is sandboxed by CSP into an opaque origin AND scripts are blocked outright by
// `default-src 'none'`. Two independent mechanisms, because this is the one place where untrusted
// markup meets an authenticated origin. Inline SVG needs no script, which is why the tool tells the
// model to draw with it; inline styles are allowed because a report with no styling is unreadable.
const REPORT_CSP = [
  'sandbox allow-popups allow-popups-to-escape-sandbox allow-top-navigation-by-user-activation',
  "default-src 'none'",
  'img-src data: https:',
  "style-src 'unsafe-inline'",
  'font-src data:',
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');

const escHtml = (v) => String(v == null ? '' : v)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// Deliberately plain and readable rather than styled to match the dashboard: a report is a document
// you read, not a control surface. Follows the phone's light/dark setting.
const REPORT_CSS = `
:root{color-scheme:light dark;--bg:#fff;--fg:#18181b;--mut:#71717a;--line:#e4e4e7;--acc:#2563eb;--code:#f4f4f5}
@media (prefers-color-scheme:dark){:root{--bg:#0b0b0e;--fg:#e8e8ea;--mut:#a1a1aa;--line:#27272a;--acc:#7aa2f7;--code:#18181b}}
*{box-sizing:border-box}
body{margin:0;padding:22px 18px 64px;background:var(--bg);color:var(--fg);
 font:16px/1.62 -apple-system,BlinkMacSystemFont,'SF Pro Text',system-ui,sans-serif;
 -webkit-text-size-adjust:100%;overflow-wrap:anywhere}
header{border-bottom:1px solid var(--line);padding-bottom:14px;margin-bottom:22px}
h1{font-size:24px;line-height:1.25;margin:0 0 6px}
.meta{color:var(--mut);font-size:13px}
h2{font-size:19px;margin:32px 0 10px;line-height:1.3}
h3{font-size:16px;margin:22px 0 8px}
p,ul,ol{margin:0 0 14px}
ul,ol{padding-left:22px}
li{margin:4px 0}
a{color:var(--acc)}
code{background:var(--code);padding:1.5px 5px;border-radius:4px;font-size:13.5px;
 font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
pre{background:var(--code);padding:13px 14px;border-radius:9px;overflow-x:auto;font-size:13px;line-height:1.5}
pre code{background:none;padding:0;font-size:inherit}
table{border-collapse:collapse;width:auto;min-width:100%;margin:0 0 16px;font-size:14.5px;display:block;overflow-x:auto;-webkit-overflow-scrolling:touch}
th,td{border:1px solid var(--line);padding:7px 10px;text-align:left;vertical-align:top;min-width:92px}
th{background:var(--code);font-weight:600}
blockquote{margin:0 0 14px;padding-left:14px;border-left:3px solid var(--line);color:var(--mut)}
img,svg{max-width:100%;height:auto}
hr{border:0;border-top:1px solid var(--line);margin:26px 0}`;

const when = (iso) => {
  try {
    return new Date(iso).toLocaleString('en-US',
      { timeZone: 'America/New_York', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  } catch (_) { return ''; }
};

app.get('/report/:id', async (req, res) => {
  let rows;
  try { rows = await sb(`reports?id=eq.${encodeURIComponent(req.params.id)}&select=*`); }
  catch (e) { return res.status(502).type('text').send('could not read report'); }
  const r = rows && rows[0];
  if (!r) return res.status(404).type('text').send('no such report');
  const where = [r.repo, when(r.created)].filter(Boolean).join(' · ');
  res.setHeader('Content-Security-Policy', REPORT_CSP);
  res.setHeader('Cache-Control', 'no-cache');
  res.type('html').send(`<!doctype html><html><head><meta charset=utf-8>
<meta name=viewport content="width=device-width,initial-scale=1">
<title>${escHtml(r.title)}</title><style>${REPORT_CSS}</style></head><body>
<header><h1>${escHtml(r.title)}</h1><div class=meta>${escHtml(where)}</div></header>
${r.html || ''}
</body></html>`);
});

// The index as JSON, for the phone's reports pane. `html` is deliberately not selected: a list of a
// hundred reports would otherwise carry every page's full markup to a screen that renders none of it.
app.get('/api/reports', async (req, res) => {
  try {
    res.json({ reports: await sb('reports?select=id,title,summary,repo,created&order=created.desc&limit=100') || [] });
  } catch (_) {
    res.status(502).json({ error: 'could not read reports' });
  }
});

// Every report, newest first — the way back to something you read last week.
app.get('/reports', async (req, res) => {
  let rows = [];
  try { rows = await sb('reports?select=id,title,summary,repo,created&order=created.desc&limit=100'); }
  catch (_) {}
  const items = rows.map((r) =>
    `<li><a href="/report/${escHtml(r.id)}">${escHtml(r.title)}</a>` +
    `<div class=meta>${escHtml([r.repo, when(r.created)].filter(Boolean).join(' · '))}</div>` +
    (r.summary ? `<div class=sum>${escHtml(r.summary)}</div>` : '') + '</li>').join('');
  res.setHeader('Cache-Control', 'no-cache');
  res.type('html').send(`<!doctype html><html><head><meta charset=utf-8>
<meta name=viewport content="width=device-width,initial-scale=1">
<title>Reports</title><style>${REPORT_CSS}
ul{list-style:none;padding:0}li{padding:14px 0;border-bottom:1px solid var(--line)}
li a{font-size:17px;font-weight:600;text-decoration:none}
.sum{color:var(--fg);font-size:14.5px;margin-top:4px}
.meta{margin-top:2px}</style></head><body>
<header><h1>Reports</h1></header>
${items ? `<ul>${items}</ul>` : '<p class=meta>Nothing published yet.</p>'}
</body></html>`);
});
// Static client assets (core.js, app.css, cards/*.js) — behind the auth gate above.
// no-cache (revalidate via ETag each load) so a deploy is never masked by a stale cached asset.
app.use(express.static(path.join(__dirname, 'public'), { setHeaders: (res) => res.setHeader('Cache-Control', 'no-cache') }));

app.get('/api/status', async (req, res) => {
  try { res.json(await buildStatus()); }
  catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});

// A single day's sets, grouped by exercise — for the heatmap day click-through.
// Cached like /api/nutrition-day: the client re-fetches the open day on every SSE frame, which
// re-queried the day's sets ~every 30s all day. Sets only change on writes — realtime (`sets` is in
// changed()) covers external writers, and the hub's own set writes dirty it synchronously.
const workoutDayCache = new Map();   // date -> { body, at }
const WORKOUTDAY_BACKSTOP_MS = 15 * 60 * 1000;
const dirtyWorkoutDay = () => workoutDayCache.clear();
// Compact feed for the iOS home/lock-screen widget. buildStatus() is heavy (many Supabase reads),
// so the widget gets only the four numbers it draws rather than the whole dashboard payload.
// Per-minute frames put it around 37KB, once an hour — the frames dominate, and the alternative
// (coarser steps) is what made the centre number look stuck.
app.get('/api/rings', async (req, res) => {
  try {
    const st = await buildStatus();
    const P = st.pace || {};
    const m = P.macros || {};
    const KEYS = ['calories', 'protein_g', 'carbs_g', 'fat_g'];
    const consumed = {}, goal = {};
    for (const k of KEYS) { consumed[k] = m[k]?.consumed ?? 0; goal[k] = m[k]?.goal ?? 0; }

    // A widget renders a STATIC snapshot — it can't tick a clock the way the hub card does. So the
    // server returns a series of future frames and WidgetKit steps through them on schedule. The
    // pace arcs drain and the marker advances without another network call, and, more importantly,
    // the pace maths stays here in lib/pace.js instead of being re-implemented in Swift where the
    // two copies would quietly drift apart.
    // Span is a straight trade: longer means the arcs keep moving without spending WidgetKit refresh
    // budget, but the CONSUMED figures stay frozen at fetch time for that whole window. 4 hours made
    // it look live while showing hours-old numbers. An hour keeps the movement and bounds how stale
    // the data can get on its own; the app also forces a reload whenever the data changes.
    //
    // STEP is what the deviation NUMBER moves on, and it was the visible flaw at 10 minutes: the
    // pace line advances goal/window per minute — about 3 cal/min — so the centre figure sat up to
    // ~31 cal behind the truth and read as stuck. On the arcs a tenth of a step is invisible; on a
    // number it isn't. Per-minute frames make it track continuously. WidgetKit pre-renders the whole
    // timeline and swaps entries at their dates, so 61 frames cost one fetch, not 61.
    const STEP_MIN = 1, SPAN_MIN = 60;
    const frames = [];
    for (let t = 0; t <= SPAN_MIN; t += STEP_MIN) {
      const f = pace.computePace({ consumed, goal, window: P.window, nowOff: (P.nowOff ?? 0) + t });
      const macros = {};
      for (const k of KEYS) {
        const x = f.macros[k];
        macros[k] = {
          consumed: x.consumed, goal: x.goal, dev_g: x.dev_g,
          ring_base: x.ring_base, ring_over: x.ring_over,
          base_color: x.base_color, over_color: x.over_color,
          // Matches the card's own rule for the number under the glyph (cards/nutrition.js tickRings).
          dev_color: x.dev_g < 0 ? '#f87171' : x.dev_g > 0 ? (x.over_color || '#22c55e') : '#22c55e',
        };
      }
      frames.push({ t, frac: f.fraction, macros });
    }
    // The health bar that sits with the rings on the wall (cards/score.js): one gauge split into a
    // nutrition and a training contribution. overall = W_TRAIN*training + (1-W_TRAIN)*nutrition, so
    // each side can fill at most half the bar and the two together reach the overall figure. Sent as
    // the already-halved fills the bar draws, rather than raw percentages, so the widget doesn't
    // re-derive the weighting and drift from the wall.
    const sc = st.score || {};
    const half = (v) => Math.max(0, Math.min(50, (Number(v) || 0) * 0.5));
    res.json({
      step_min: STEP_MIN,
      score: { nutrition: half(sc.nutrition?.pct), training: half(sc.training?.pct),
               overall: Math.max(0, Math.min(100, Number(sc.overall) || 0)) },
      frames,
    });
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});

app.get('/api/workout-day', async (req, res) => {
  try {
    const date = String(req.query.date || '').slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: 'bad date' });
    const hit = workoutDayCache.get(date);
    if (hit && Date.now() - hit.at < WORKOUTDAY_BACKSTOP_MS) return res.json(hit.body);
    const rows = await sbRange(`sets?occurred_at=gte.${date}T00:00:00&occurred_at=lte.${date}T23:59:59&select=id,occurred_at,exercise,weight_lbs,reps&order=occurred_at`);
    const order = [], byEx = {};
    for (const r of rows) { if (!byEx[r.exercise]) { byEx[r.exercise] = []; order.push(r.exercise); } byEx[r.exercise].push({ id: r.id, weight_lbs: r.weight_lbs, reps: r.reps }); }
    const body = { date, total: rows.length, exercises: order.map((n) => ({ name: n, sets: byEx[n] })) };
    workoutDayCache.set(date, { body, at: Date.now() });
    res.json(body);
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});

// ---- app settings (voice routing mode + per-device trailing-silence). Read by the worker + devices;
// edited from the hub settings panel. Returns/accepts a flat {key: value} map. ----
app.get('/api/settings', async (req, res) => {
  try {
    res.json(await settingsAll());   // realtime-invalidated cache — see settingsAll()
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});
app.post('/api/settings', express.json(), async (req, res) => {
  try {
    const b = req.body || {};
    const key = typeof b.key === 'string' ? b.key.trim() : '';
    if (!key) return res.status(400).json({ error: 'key required' });
    const value = b.value == null ? '' : String(b.value);
    const prevSurplus = key === 'surplus_cal' ? (await settingsAll()).surplus_cal : null;   // before the write
    await putSetting(key, value);
    dirtySettings();   // synchronous — a write-then-read client must not race the realtime round-trip
    // A goal sign-flip (bulk↔cut) starts a NEW maintenance phase, seeded with the maintenance measured
    // robustly up to now (= today's synced target − the OLD surplus) and held until the new phase has its
    // own data. Same-sign magnitude tweaks (e.g. +150→+250) do NOT reset the phase.
    if (key === 'surplus_cal') {
      const oldS = parseInt(prevSurplus, 10), newS = parseInt(value, 10);
      const oldSign = Number.isFinite(oldS) ? Math.sign(oldS) : 0;
      const newSign = Number.isFinite(newS) ? Math.sign(newS) : 0;
      if (newSign !== 0 && newSign !== oldSign) {
        const today = nutritionWindow().day;
        const trows = await sb(`nutrition_targets?date=eq.${today}&select=calories`);
        const curTarget = trows && trows[0] ? Number(trows[0].calories) : null;
        const seed = (curTarget != null && Number.isFinite(oldS)) ? Math.round(curTarget - oldS) : null;
        const phaseRec = { start: today, seed, sign: newSign, hold: false };
        await putSetting('maintenance_phase', JSON.stringify(phaseRec));
        dirtySettings();
        console.log(`[phase] goal sign flip ${oldSign}→${newSign}; new phase start=${today} seed=${seed}`);
      }
    }
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});

// Register a device's APNs token (sent by the native app, authed by x-hub-token). Upsert so a
// re-launch just refreshes last_seen rather than piling up rows.
//
// The phone also reports its IANA timezone here, which is how the hub knows where Jared is. It is
// the best available proxy: the phone travels with him, and it re-registers on every launch. Stored
// in app_settings.display_tz and picked up by the next settings read (see settingsAll).
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

    // Follow the phone's timezone. Validated by setTZ (which rejects anything Intl won't accept), and
    // only written when it actually changed, so this isn't a Supabase write on every app launch.
    const tz = String((req.body && req.body.tz) || '').trim();
    if (setTZ(tz)) {                       // false when unchanged or not a real IANA zone
      console.log(`[tz] phone reports ${tz} — persisting`);
      try { await putSetting('display_tz', tz); dirtySettings(); }
      catch (e) { console.log('[tz] persist failed:', e.message); }   // in-memory zone still moved
    }
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});

// A single 4am→4am nutrition day's food entries — for the nutrition-log day click-through.
// Cached: the client re-fetches the open day on EVERY SSE status frame (its "live-refresh"), which
// re-ran five Supabase queries — one of them a full-history scan — every ~30s all day. The response
// only changes when nutrition data changes, and every path that changes it dirties this cache:
// realtime events cover external writers (voice/MCP), and the hub's own write endpoints dirty it
// synchronously so their immediate client re-fetch can't race the realtime round-trip.
const nutDayCache = new Map();   // `${date}|${window day}` -> { body, at }
const NUTDAY_BACKSTOP_MS = 15 * 60 * 1000;
const dirtyNutDay = () => nutDayCache.clear();
app.get('/api/nutrition-day', async (req, res) => {
  try {
    const date = String(req.query.date || '').slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: 'bad date' });
    const cacheKey = date + '|' + nutritionWindow().day;   // window day flips at 4am → isToday changes
    const hit = nutDayCache.get(cacheKey);
    if (hit && Date.now() - hit.at < NUTDAY_BACKSTOP_MS) return res.json(hit.body);
    const hh = String(DAY_START_HOUR).padStart(2, '0');
    const next = localDate(new Date(Date.parse(date + 'T12:00:00Z') + 86400000));
    const isToday = date === nutritionWindow().day;
    const SEL = 'id,occurred_at,name,calories,protein_g,carbs_g,fat_g,ingredients,staged';
    const today = nutritionWindow().day;
    const [committed, stagedRows, targetRows, allIntake, weightRows, surplus] = await Promise.all([
      sbRange(`nutrition_entries?occurred_at=gte.${date}T${hh}:00:00&occurred_at=lt.${next}T${hh}:00:00&staged=eq.false&select=${SEL}&order=occurred_at`),
      // Staged meals (any day) always surface in the CURRENT day's list.
      isToday ? sbRange(`nutrition_entries?staged=eq.true&select=${SEL}&order=logged`) : Promise.resolve([]),
      sb('nutrition_targets?select=date,calories&order=date.asc'),
      sbRange('nutrition_entries?staged=eq.false&select=occurred_at,calories&order=occurred_at'), // full history → clusters + per-day maintenance
      sb('weight_log?select=date,weight_lbs&order=date.asc'),
      surplusCal(),
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
    // This day's GOAL via the SAME cluster-aware resolver the calendar + plot use, so the header
    // agrees with them: active run → maintenance+surplus (or stored target); an older cut →
    // maintenance−deficit; untracked → maintenance.
    const weights = (weightRows || []).map((r) => ({ date: String(r.date).slice(0, 10), weight: Number(r.weight_lbs) }));
    const { goalForDay } = buildGoalResolver({ rows: allIntake, weights, targets: targetRows, today, surplus });
    const target_cal = goalForDay(date);
    const delta_color = target_cal > 0 ? calorieColor(total_cal / target_cal) : null;
    // Per-day macro GOALS = this day's calorie goal split by bodyweight as of this day.
    const wAsOf = weights.filter((w) => w.date <= date);
    const bw = wAsOf.length ? wAsOf[wAsOf.length - 1].weight : null;
    const target_macros = target_cal > 0 ? macroTargets(target_cal, bw) : null;
    const body = {
      date,
      total_cal, total_protein: Math.round(total_protein),
      total_carbs: Math.round(total_carbs), total_fat: Math.round(total_fat),
      target_cal, target_macros, delta_color,
      entries,
    };
    nutDayCache.set(cacheKey, { body, at: Date.now() });
    res.json(body);
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});

// "now" as a naive-local wall-clock timestamp in the display TZ → "YYYY-MM-DDTHH:MM:SS"
// (the format nutrition_entries.occurred_at and sets.occurred_at are stored in).
function nowNaiveLocal() {
  const f = new Intl.DateTimeFormat('en-CA', {
    timeZone: getTZ(), hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const p = {}; for (const part of f.formatToParts(new Date())) p[part.type] = part.value;
  const hh = p.hour === '24' ? '00' : p.hour; // Intl can emit 24 for midnight
  return `${p.year}-${p.month}-${p.day}T${hh}:${p.minute}:${p.second}`;
}

// occurred_at is intentionally naive (no UTC offset) — a pure wall-clock reading, e.g.
// "2026-07-04T10:43:14", with NO timezone concept attached at all. It should read whatever the
// clock said on whatever device was actually doing the logging, wherever that was — never
// converted to/from any zone. Browser writes (log-set, nutrition stage/commit) send their own
// current wall clock as `client_now` (shared.js localNowNaive()); this only falls back to the
// server's own naive-local reading when the client didn't supply one (e.g. an automated caller).
const CLIENT_NOW_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/;
function resolveNow(body) {
  const c = body && body.client_now;
  return typeof c === 'string' && CLIENT_NOW_RE.test(c) ? c : nowNaiveLocal();
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
    const occurred_at = resolveNow(b);
    await sbWrite('sets', 'POST', { occurred_at, exercise, weight_lbs, reps });
    dirtyWorkoutDay();   // synchronous — the client re-fetches the day immediately after this returns
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
    dirtyWorkoutDay();   // synchronous — the client re-fetches the day immediately after this returns
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});

// Nutrition invariant (mirrors the data-layer): every entry stores ≥1 ingredient and its totals are
// the SUM of those ingredients. Each ingredient's calories = stated, else Atwater (4/4/9) from its
// macros. A simple food collapses to one name-only ingredient. Enforced server-side so the stored
// row can never drift from its breakdown, regardless of what a client sends.
function atwaterCals(p, c, f) { return Math.round(((p || 0) * 4) + ((c || 0) * 4) + ((f || 0) * 9)); }
function rollEntry(macros, rawIngredients, name) {
  const r10 = (v) => Math.round((Number(v) || 0) * 10) / 10;
  const norm = (g) => {
    const p = r10(g.protein_g), c = r10(g.carbs_g), f = r10(g.fat_g);
    const cal = (g.calories === null || g.calories === undefined || g.calories === '') ? atwaterCals(p, c, f) : Math.round(Number(g.calories) || 0);
    const o = { name: String(g.name || g.ingredient || name || ''), calories: cal, protein_g: p, carbs_g: c, fat_g: f };
    if (g.food != null) o.food = String(g.food);
    if (g.unit != null) o.unit = String(g.unit);
    if (g.amount != null && isFinite(Number(g.amount))) o.amount = Math.round(Number(g.amount) * 1000) / 1000;
    // Produce classification rides along with the ingredient. Both fields travel together or neither
    // does — a half-set pair would silently drop grams out of the day's produce total.
    if (PRODUCE_TYPES.includes(g.produce_type) && isFinite(Number(g.produce_g)) && Number(g.produce_g) >= 0) {
      o.produce_type = g.produce_type;
      o.produce_g = r10(g.produce_g);
    }
    return o;
  };
  const ings = (Array.isArray(rawIngredients) && rawIngredients.length)
    ? rawIngredients.map(norm)
    : [norm({ name, ...macros })];
  const t = ings.reduce((a, g) => ({
    calories: a.calories + g.calories, protein_g: a.protein_g + g.protein_g,
    carbs_g: a.carbs_g + g.carbs_g, fat_g: a.fat_g + g.fat_g,
  }), { calories: 0, protein_g: 0, carbs_g: 0, fat_g: 0 });
  return { calories: Math.round(t.calories), protein_g: r10(t.protein_g), carbs_g: r10(t.carbs_g), fat_g: r10(t.fat_g), ...produceRoll(ings), ingredients: ings };
}

// Produce rollup — mirrors data-layer's produceRollup() exactly. Leafy greens count toward BOTH
// dark_green_g and veg_g (dark green is a floor WITHIN the vegetable goal, not a separate bucket), so the
// two are never summed together downstream.
const PRODUCE_TYPES = ['dark_green_vegetable', 'other_vegetable', 'fruit'];
function produceRoll(ings) {
  const r10 = (v) => Math.round((Number(v) || 0) * 10) / 10;
  const t = { veg_g: 0, dark_green_g: 0, fruit_g: 0 };
  for (const g of ings) {
    const grams = Number(g.produce_g) || 0;
    if (!grams || !g.produce_type) continue;
    if (g.produce_type === 'dark_green_vegetable') { t.dark_green_g += grams; t.veg_g += grams; }
    else if (g.produce_type === 'other_vegetable') t.veg_g += grams;
    else if (g.produce_type === 'fruit') t.fruit_g += grams;
  }
  return { veg_g: r10(t.veg_g), dark_green_g: r10(t.dark_green_g), fruit_g: r10(t.fruit_g) };
}

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
    const occurred_at = resolveNow(b); // this device's own wall clock, wherever it is
    const row = {
      id: crypto.randomUUID(),
      date: dayBucketOf(occurred_at),
      occurred_at,
      logged: occurred_at,
      name,
      quantity: 1,
    };
    // Totals = SUM of the ingredients; a simple food becomes one name-only ingredient.
    const rolled = rollEntry({ calories, protein_g, carbs_g, fat_g }, b.ingredients, name);
    row.calories = rolled.calories; row.protein_g = rolled.protein_g;
    row.carbs_g = rolled.carbs_g; row.fat_g = rolled.fat_g;
    row.veg_g = rolled.veg_g; row.dark_green_g = rolled.dark_green_g; row.fruit_g = rolled.fruit_g;
    row.ingredients = rolled.ingredients;
    await sbWrite('nutrition_entries', 'POST', row);
    dirtyNutDay();   // synchronous — the client re-fetches the day immediately after this returns
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
    const newName = (typeof b.name === 'string' && b.name.trim()) ? b.name.trim() : before.name;
    // Totals = SUM of ingredients (the popup sends them; if absent, the macros become one ingredient).
    const rolled = rollEntry({ calories, protein_g, carbs_g, fat_g }, b.ingredients, newName);
    const patch = { calories: rolled.calories, protein_g: rolled.protein_g, carbs_g: rolled.carbs_g, fat_g: rolled.fat_g, veg_g: rolled.veg_g, dark_green_g: rolled.dark_green_g, fruit_g: rolled.fruit_g, ingredients: rolled.ingredients };
    if (typeof b.name === 'string' && b.name.trim()) patch.name = b.name.trim();
    await sbWrite(`nutrition_entries?id=eq.${id}`, 'PATCH', patch);
    dirtyNutDay();   // synchronous — the client re-fetches the day immediately after this returns
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
    dirtyNutDay();   // synchronous — the client re-fetches the day immediately after this returns
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
    const occurred_at = resolveNow(req.body);
    const patch = { staged: false, occurred_at, logged: occurred_at, date: dayBucketOf(occurred_at) };
    await sbWrite(`nutrition_entries?id=eq.${id}`, 'PATCH', patch);
    dirtyNutDay();   // synchronous — the client re-fetches the day immediately after this returns
    await audit('edit', id, before, { ...before, ...patch });
    res.status(204).end();
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});

// Feed the cat feeder. The feeder is LAN-only and this server runs on Fly, so we can't dispense
// directly — enqueue a command the Pi collector (on the LAN) claims and executes within seconds.
app.post('/api/feed', express.json(), async (req, res) => {
  try {
    let portions = parseInt(req.body && req.body.portions, 10);
    if (!Number.isFinite(portions) || portions < 1) portions = 1;
    portions = Math.min(12, portions);
    await sbWrite('feeder_commands', 'POST', { action: 'feed', portions, source: 'hub-web', status: 'pending' });
    res.status(202).json({ ok: true, portions });
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

// Backfill recent voice_messages for a focus so the panel populates on load before live updates
// arrive. We want the MOST RECENT `limit` turns — so fetch newest-first then reverse to oldest→newest
// (the render order). The old asc+limit returned the OLDEST 50, hiding the recent thread. focus='hub'.
app.get('/api/voice-messages', async (req, res) => {
  try {
    const focus = String(req.query.focus || 'hub');
    const mode = String(req.query.mode || 'hub') === 'agent' ? 'agent' : 'hub';
    let limit = parseInt(req.query.limit, 10);
    if (!Number.isFinite(limit) || limit <= 0) limit = 50;
    limit = Math.min(limit, 500);
    // Mode filter — legacy rows (mode NULL) predate the split and count as 'hub'.
    const modeFilter = mode === 'agent' ? '&mode=eq.agent' : '&or=(mode.is.null,mode.eq.hub)';
    const rows = (await sb(`voice_messages?focus=eq.${encodeURIComponent(focus)}${modeFilter}&order=created_at.desc&limit=${limit}&select=*`) || []).reverse();
    // Full-agent context never resets on an idle gap, so its whole thread is one context — show it all.
    if (mode === 'agent') { res.json(rows); return; }
    // Hub mode scopes to the CURRENT context: the trailing run with no idle gap longer than session_reset_s.
    // After a longer gap the hub starts a fresh context, so older turns it no longer remembers aren't shown.
    const gapMs = (await sessionResetS()) * 1000;
    let start = rows.length ? rows.length - 1 : 0;
    for (let i = rows.length - 1; i > 0; i--) {
      if (Date.parse(rows[i].created_at) - Date.parse(rows[i - 1].created_at) <= gapMs) start = i - 1;
      else break;
    }
    res.json(rows.slice(start));   // current context only, oldest→newest
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
    // ?dry=1 → transcribe only, no enqueue. The chat composer uses this while photos are pending: the
    // transcript lands in the text box so the user sends text + photos together when they're ready.
    if (String(req.query.dry || '') === '1') return res.json({ transcript, enqueued: false });
    // The bottom-right quick-add FAB sends ?quick=1 → tag the request so the worker asks Jarvis for a
    // terse, fits-in-the-status-chip confirmation. The full conversation card omits it (verbose replies).
    const quick = String(req.query.quick || '') === '1';
    const client_now = CLIENT_NOW_RE.test(String(req.query.client_now || '')) ? String(req.query.client_now) : null;
    await sbWrite('voice_requests', 'POST', { transcript, source: quick ? 'web-quick' : 'web', focus: 'hub',
      ...(client_now ? { client_now } : {}) });
    res.json({ transcript, enqueued: true });
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});

// Photo attachments: the chat composer uploads each image here (raw body, one per request); it lands
// in the private voice-attachments bucket and the returned flat object name (uuid.ext) rides the
// voice_request, so whichever worker claims it (Mac/Pi) pulls the bytes down for the model to view.
// The daily sweep below reaps objects after 7 days — photos exist to make ONE log entry, not to keep.
const ATT_BUCKET = 'voice-attachments';
const ATT_TYPES = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif' };
// iOS cameras hand back HEIC/HEIF, which neither browsers (the chat thumbnails) nor Claude's vision API
// can read. The client normally shrinks to JPEG in-canvas, but a fallback upload (when that canvas can't
// decode the capture) can still arrive as HEIC — convert it to JPEG here so the pipeline never breaks on format.
const ATT_HEIC = new Set(['image/heic', 'image/heif', 'image/heic-sequence', 'image/heif-sequence']);
const attName = (p) => /^[\w.\-]+$/.test(p);   // flat bucket — reject anything path-like
// Phones report unreliable (sometimes empty) content-types — especially on the shrink-failed fallback
// that uploads the raw camera file — so identify the real format from the file's own magic bytes and
// ignore the header. HEIC/HEIF is then converted to JPEG (browsers + the vision API can't read it).
function sniffImageType(b) {
  if (!b || b.length < 12) return null;
  if (b[0] === 0xFF && b[1] === 0xD8 && b[2] === 0xFF) return 'image/jpeg';
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4E && b[3] === 0x47) return 'image/png';
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return 'image/gif';
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'image/webp';
  if (b[4] === 0x66 && b[5] === 0x74 && b[6] === 0x79 && b[7] === 0x70) {   // ISO-BMFF 'ftyp' box → HEIC/HEIF family
    const brand = b.toString('latin1', 8, 12);
    if (['heic', 'heix', 'hevc', 'heim', 'heis', 'hevm', 'hevs', 'mif1', 'msf1', 'heif'].includes(brand)) return 'image/heic';
  }
  return null;
}
app.post('/api/attach', express.raw({ type: () => true, limit: '30mb' }), async (req, res) => {
  try {
    if (!req.body || !req.body.length) return res.status(400).json({ error: 'empty upload' });
    let body = req.body;
    let ct = sniffImageType(body) || String(req.headers['content-type'] || '').split(';')[0].trim();
    if (ATT_HEIC.has(ct)) {
      try {
        body = Buffer.from(await heicConvert({ buffer: req.body, format: 'JPEG', quality: 0.85 }));
        ct = 'image/jpeg';
      } catch (e) { return res.status(415).json({ error: 'could not read HEIC image' }); }
    }
    const ext = ATT_TYPES[ct];
    if (!ext) return res.status(415).json({ error: `unsupported image type (${ct || 'unknown'}, ${body.length}b)` });
    const name = `${crypto.randomUUID()}.${ext}`;
    const r = await fetch(`${SUPABASE_URL}/storage/v1/object/${ATT_BUCKET}/${name}`, {
      method: 'POST',
      headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, 'Content-Type': ct },
      body,
    });
    if (!r.ok) return res.status(502).json({ error: `storage upload failed (${r.status})` });
    res.json({ path: name });
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});

// Client error sink: the phone POSTs a failed quick-photo's real reason here (step, file type/size,
// server error) so a failure that's otherwise invisible in the phone's console lands in the app log.
app.post('/api/clientlog', express.json({ limit: '16kb' }), (req, res) => {
  try { console.log('[clientlog]', JSON.stringify(req.body).slice(0, 900)); } catch (_) {}
  res.status(204).end();
});

// Thumbnails for the chat thread — proxies the private bucket behind the hub auth gate.
app.get('/api/attachment', async (req, res) => {
  try {
    const name = String(req.query.path || '');
    if (!attName(name)) return res.status(400).json({ error: 'bad path' });
    const r = await fetch(`${SUPABASE_URL}/storage/v1/object/${ATT_BUCKET}/${name}`, {
      headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` },
    });
    if (!r.ok) return res.status(404).end();
    res.setHeader('Content-Type', r.headers.get('content-type') || 'image/jpeg');
    res.setHeader('Cache-Control', 'private, max-age=86400');   // object content never changes
    res.send(Buffer.from(await r.arrayBuffer()));
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});

async function sweepAttachments() {
  try {
    const r = await fetch(`${SUPABASE_URL}/storage/v1/object/list/${ATT_BUCKET}`, {
      method: 'POST',
      headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ prefix: '', limit: 1000, sortBy: { column: 'created_at', order: 'asc' } }),
    });
    if (!r.ok) return;
    const cutoff = Date.now() - 7 * 24 * 3600 * 1000;
    const old = (await r.json()).filter((o) => o.name && Date.parse(o.created_at) < cutoff).map((o) => o.name);
    if (!old.length) return;
    await fetch(`${SUPABASE_URL}/storage/v1/object/${ATT_BUCKET}`, {
      method: 'DELETE',
      headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ prefixes: old }),
    });
    console.log(`attachment sweep: deleted ${old.length} object(s) older than 7 days`);
  } catch (e) { console.log('attachment sweep failed:', e.message || e); }
}
setInterval(sweepAttachments, 24 * 3600 * 1000);
sweepAttachments();

// Typed command from the Jarvis card — no audio, just enqueue the text like the voice path.
// Photo attachments (object names from /api/attach) ride along; a photo-only send (no text) is valid —
// the worker's framing directive tells the model the intent is to log what the photos show.
// De-dupe resent sends: the durable photo outbox may re-POST if a screen-lock killed the ack before the
// client marked the send done. A client_msg_id turns that retry into a no-op instead of a duplicate log.
// In-memory suffices — the hub runs a single instance and the retry window is seconds to minutes; the map
// is bounded so it can't grow without limit.
const seenMsgIds = new Map();   // client_msg_id -> first-seen ts
app.post('/api/voice-text', express.json(), async (req, res) => {
  try {
    const text = String((req.body && req.body.text) || '').trim();
    const attachments = Array.isArray(req.body && req.body.attachments)
      ? req.body.attachments.map(String).filter(attName).slice(0, 12) : [];
    if (!text && !attachments.length) return res.status(400).json({ error: 'empty' });
    const msgId = String((req.body && req.body.client_msg_id) || '').slice(0, 64);
    if (msgId && seenMsgIds.has(msgId)) return res.json({ enqueued: true, duplicate: true });
    const client_now = CLIENT_NOW_RE.test(String((req.body && req.body.client_now) || '')) ? String(req.body.client_now) : null;
    await sbWrite('voice_requests', 'POST', { transcript: text, source: 'web', focus: 'hub',
      ...(attachments.length ? { attachments } : {}), ...(client_now ? { client_now } : {}) });
    if (msgId) { seenMsgIds.set(msgId, Date.now()); if (seenMsgIds.size > 1000) seenMsgIds.delete(seenMsgIds.keys().next().value); }
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
    // Preserve 'working' (the command's transcript, once per command), 'done', and 'escalate' (the
    // Sonnet→Opus hop mid-run); everything else is a tool call. 'working' is what the TV keys the
    // heard-you pop off, so it must survive intact.
    state: ['done', 'working', 'escalate'].includes(b.state) ? b.state : 'tool',
    focus: String(b.focus || 'hub'),
  });
  res.status(204).end();
});

// Native push to Jared's phone (APNs). The voice worker POSTs the past-tense result of a completed
// voice command here so it lands as a phone notification — same proven sender + device tokens as the
// weight reminder, just ad-hoc text. Gated on the kiosk token. Fans out to every registered iOS token
// on its own push environment (sandbox vs production), and logs the result to `notifications`.
// Push a notification to every registered iOS device; records one `notifications` row (with an optional
// dedupe_key so a caller can guarantee once-only delivery). Shared by /api/notify and reminder firing.
// Every notification from this app shows the SAME icon, so the sound is what tells them apart
// without looking. Sounds are .caf files bundled in the iOS app (apps/Sounds/); an unknown kind
// falls back to the system default. 'passive' keeps voice acks from buzzing — they're confirmations
// you'll read later, not things to interrupt you.
// Sound distinguishes these by ear, the emoji distinguishes them by eye — the app icon is identical
// on every one, so without a marker in the title a reminder and a voice confirmation look the same
// in a stacked list. 'time-sensitive' is what lets a reminder through a Focus; a voice ack is
// 'passive' so it lands in the list without lighting the screen.
const NOTIFY_STYLE = {
  reminder: { emoji: '⏰', sound: 'reminder.caf', interruptionLevel: 'time-sensitive' },
  voice:    { emoji: '🎙️', interruptionLevel: 'passive' },
  // A finished piece of dispatched work. 'active' rather than 'time-sensitive': it is worth seeing
  // when you pick the phone up, but a build that finished is not worth breaking a Focus for.
  report:   { emoji: '📄', interruptionLevel: 'active' },
};

// The home-screen badge = every EXPIRED item: not cleared, dated, and past the moment it was FIRST
// scheduled for — on ANY list. A dated Amazon item counts exactly like a dated todo, because they
// are the same kind of thing (migration 00056).
//
// Measured against `scheduled_at`, not `due`, and that is the whole point: a repeating item's `due`
// jumps into the future the instant it fires, so counting `due` would empty the badge at exactly the
// moment the item became outstanding. Expired means "its moment came and it still hasn't been dealt
// with", which is true of a one-shot and a repeater alike and stops being true only when the item is
// cleared. Undated items never badge.
//
// Returns null if the count can't be read — the push then omits the badge rather than clearing it to
// a wrong number.
async function overdueCount() {
  try {
    const rows = await sb('list_items?deleted=eq.false&due=not.is.null&select=due,scheduled_at');
    const nowET = etNowString();
    return rows.filter((r) => dueMoment(r.scheduled_at || r.due) <= nowET).length;
  } catch (_) { return null; }
}

async function pushAll(kind, title, body, dedupe_key, extra = {}) {
  const base = { kind, title, body, ...(dedupe_key ? { dedupe_key } : {}) };
  const { emoji, ...style } = { ...(NOTIFY_STYLE[kind] || {}), ...extra };   // copy: never mutate the shared constant
  if (emoji && !String(title).startsWith(emoji)) title = `${emoji} ${title}`;
  const badge = await overdueCount();
  if (Number.isInteger(badge)) style.badge = badge;
  if (!apns.configured()) { await sbInsert('notifications', { ...base, ok: false, detail: 'apns not configured' }); return { ok: false, detail: 'apns not configured' }; }
  let tokens = [];
  try { tokens = await sb('device_tokens?platform=eq.ios&select=token,environment'); } catch (_) {}
  if (!tokens.length) { await sbInsert('notifications', { ...base, ok: false, detail: 'no device tokens' }); return { ok: false, detail: 'no device tokens' }; }
  const details = []; let anyOk = false;
  for (const { token, environment } of tokens) {
    const r = await apns.send(token, { title, body, environment, ...style });
    if (r.ok) anyOk = true;
    details.push(`${token.slice(0, 8)}=${r.status}${r.ok ? '' : '(' + (r.detail || '').slice(0, 60) + ')'}`);
  }
  await sbInsert('notifications', { ...base, ok: anyOk, detail: details.join(' ') });
  return { ok: anyOk, detail: details.join(' ') };
}

app.post('/api/notify', express.json(), async (req, res) => {
  if (TV_TOKEN && req.query.token !== TV_TOKEN) return res.status(403).json({ error: 'forbidden' });
  const b = req.body || {};
  const title = String(b.title || 'Hub').slice(0, 100);
  const body = String(b.body || '').trim().slice(0, 300);
  const kind = String(b.kind || 'voice').slice(0, 40);
  if (!body) return res.status(400).json({ error: 'body required' });
  const r = await pushAll(kind, title, body);
  if (r.detail === 'apns not configured') return res.status(503).json({ error: 'apns not configured' });
  res.json(r);
});

// ---- lists / notes surface. Voice/MCP writes them; this is the visual pane. ----
//
// `due` is sent as a normal field on every item, and `due` collects the dated ones from ALL lists
// into one soonest-first view. That view is what used to be the reminders table — it is now derived,
// not stored, so an item appears in it and on its own list at once without being duplicated.
app.get('/api/todos', async (req, res) => {
  try {
    const [listNames, items, notes] = await Promise.all([
      sb('lists?select=name,emoji&order=name'),
      sb('list_items?deleted=eq.false&select=id,list_name,text,title,due,repeat_every,scheduled_at&order=created.asc'),
      sb('notes?select=name,content&order=name'),
    ]);
    const all = items || [];
    const lists = (listNames || []).map((l) => ({ name: l.name, emoji: l.emoji, items: all.filter((i) => i.list_name === l.name) }));
    // Ordered by the ANCHOR, not by `due`: a repeating item's due jumps into the future the instant it
    // fires, which would sort it to the bottom exactly when it most needs attention. Longest
    // outstanding first, then upcoming. `expired` is likewise anchor-based and says nothing about
    // whether the item repeats.
    const nowET = etNowString();
    const due = all.filter((i) => i.due)
      .map((i) => ({ ...i, expired: dueMoment(i.scheduled_at || i.due) <= nowET }))
      .sort((a, b) => dueMoment(a.scheduled_at || a.due) < dueMoment(b.scheduled_at || b.due) ? -1 : 1);
    res.json({ lists, due, notes: notes || [] });
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});
// Compact feed for the iOS to-do widget. Deliberately NOT /api/todos: that one carries every list,
// every reminder and the full text of every note, and the widget draws one list's item titles.
//
// Items carry a real `title` now (migration 00056), so this prefers it and only derives one when it
// is absent. The derivation is the fallback for everything written before the column existed: items
// written by voice routinely carry the gist, an em dash, then the reasoning ("Replace the Pi thumb
// drive with a USB SSD — the 32GB one is a corruption risk under 24/7 writes"), and a widget row has
// space for the first half only. Either way the hub decides what a row says, not the Swift.
const LIST_WIDGET_MAX = 12;          // the large family draws ~10; a couple spare costs nothing
function itemTitle(row) {
  const explicit = String(row.title || '').trim();
  if (explicit) return explicit.length > 90 ? explicit.slice(0, 89).trimEnd() + '…' : explicit;
  const first = String(row.text || '').split('\n')[0];
  const derived = first.split(' — ')[0].trim() || first.trim();
  return derived.length > 90 ? derived.slice(0, 89).trimEnd() + '…' : derived;
}
// The widget's feed: every dated item, across every list, anchor-ordered. This replaces the
// per-list widget feed — one surface showing everything that has a time on it, rather than one list
// at a time, because "what needs dealing with" is never confined to a single list.
app.get('/api/due-widget', async (req, res) => {
  try {
    const [rows, listRows] = await Promise.all([
      sb('list_items?deleted=eq.false&due=not.is.null&select=id,list_name,text,title,due,scheduled_at,repeat_every&order=scheduled_at.asc'),
      sb('lists?select=name,emoji'),
    ]);
    const emojiOf = {};
    for (const l of listRows || []) emojiOf[l.name] = l.emoji;
    const nowET = etNowString();
    const items = (rows || []).slice(0, LIST_WIDGET_MAX).map((r) => ({
      id: r.id,
      title: itemTitle(r),
      list: r.list_name,
      emoji: emojiOf[r.list_name] || null,
      // Anchor-based, so a repeating item stays expired after it fires instead of resetting itself.
      expired: dueMoment(r.scheduled_at || r.due) <= nowET,
      when: r.scheduled_at || r.due,
      repeating: !!r.repeat_every,
    }));
    res.json({ items });
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});

// The repo widget's feed. Mirrors what cards/repos.js decides — which branch is worth showing, how
// old "old" reads — so the two surfaces can't disagree about the same project.
const REPOS_WIDGET_MAX = 12;
function repoAgo(iso) {
  if (!iso) return '';
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 90) return 'now';
  if (s < 3600) return Math.round(s / 60) + 'm';
  if (s < 86400) return Math.round(s / 3600) + 'h';
  return Math.round(s / 86400) + 'd';
}
// Nearly everything sits on main, so that chip would be a column of identical noise.
const notableBranch = (b) => !!b && b !== 'main' && b !== 'master';
app.get('/api/repos-widget', async (req, res) => {
  try {
    const [repos, presence] = await Promise.all([
      sb(`repos?select=path,name,branch,dirty,last_active&order=last_active.desc.nullslast&limit=${REPOS_WIDGET_MAX}`),
      sb('worker_presence?worker=eq.desk&select=last_seen'),
    ]);
    const seen = (presence && presence[0] && presence[0].last_seen) || null;
    const online = !!seen && (Date.now() - new Date(seen).getTime()) / 1000 <= DESK_STALE_S;
    res.json({
      online,
      repos: (repos || []).map((r) => ({
        path: r.path, name: r.name, dirty: !!r.dirty,
        branch: notableBranch(r.branch) ? r.branch : null,
        age: repoAgo(r.last_active),
      })),
    });
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});

app.get('/api/list-widget', async (req, res) => {
  try {
    const name = String(req.query.list || 'todo');
    const rows = await sb(`list_items?deleted=eq.false&list_name=eq.${encodeURIComponent(name)}` +
                          `&select=id,text,title,due&order=created.asc&limit=${LIST_WIDGET_MAX}`);
    const nowET = etNowString();
    res.json({ list: name, items: (rows || []).map((r) => ({
      id: r.id,
      title: itemTitle(r),
      // Dated items live on ordinary lists now, so the widget marks the ones that have come due.
      overdue: !!r.due && dueMoment(r.due) <= nowET,
    })) });
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});

// Clear an item. There is ONE cleared state — checking off and deleting are the same act — and it's
// soft, so the row survives for the recovery window before being purged. No `kind` any more: dated
// and undated items live in the same table, so there is only one thing to clear.
app.post('/api/todos/clear', express.json(), async (req, res) => {
  try {
    const b = req.body || {};
    const id = String(b.id || '');
    if (!id) return res.status(400).json({ error: 'id required' });
    await sbWrite(`list_items?id=eq.${encodeURIComponent(id)}`, 'PATCH', { deleted: true, updated: new Date().toISOString() });
    // Answer on the WRITE, not on a recount. This used to await overdueCount() before responding,
    // which meant a second sequential Supabase round-trip from Fly on the one path a person is
    // actually watching — the widget's ✕ can't redraw until this returns. Nothing needed that
    // number here: the pane re-reads /api/badge after every load anyway, and syncBadge() pushes the
    // authoritative count to the devices a moment later.
    res.json({ ok: true });
    syncBadge().catch(() => {});   // don't make the caller wait on APNs
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});
// Snooze: push an item's due time out by N hours from NOW (not from its old due, which may be long
// past). It stays un-cleared — snoozing is deferral, not completion — but it stops being overdue, so
// it correctly drops off the badge until it comes round again. Works on any list. No dedupe-row
// surgery needed: the ledger key includes the due (see dueTick), so moving the date is already a new
// occupancy and the item can fire again on its own.
app.post('/api/todos/snooze', express.json(), async (req, res) => {
  try {
    const b = req.body || {};
    const id = String(b.id || '');
    const hours = Number(b.hours);
    if (!id) return res.status(400).json({ error: 'id required' });
    if (!Number.isFinite(hours) || hours <= 0 || hours > 24 * 30) return res.status(400).json({ error: 'hours out of range' });
    const due = etStringAt(new Date(Date.now() + hours * 3600 * 1000));
    await sbWrite(`list_items?id=eq.${encodeURIComponent(id)}`, 'PATCH', { due, updated: new Date().toISOString() });
    res.json({ ok: true, due, badge: await overdueCount() });
    syncBadge().catch(() => {});
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});

// The app reads this when it comes to the foreground, so the badge is right even if a silent
// background push never landed.
app.get('/api/badge', async (req, res) => {
  const n = await overdueCount();
  res.json({ badge: Number.isInteger(n) ? n : 0 });
});

app.post('/api/todos/add', express.json(), async (req, res) => {
  try {
    const b = req.body || {};
    const text = String(b.text || '').trim();
    if (!text) return res.status(400).json({ error: 'text required' });
    const now = new Date().toISOString();
    // No list named means the default one. A due date is just another field — supplying it is what
    // makes the item fire, whichever list it lands on.
    const list = String(b.list || '').trim() || 'todo';
    const due = String(b.due || '').trim() || null;
    const title = String(b.title || '').trim() || null;
    // Repeating is opt-in. Dating something does NOT make it recur: the expired state (a passed
    // scheduled_at, kept until the item is cleared) is the persistent "still needs dealing with"
    // signal, and a daily re-fire on top of it is noise on every appointment that has simply been
    // and gone. A recurrence with no due has nothing to recur from, so it only applies alongside one.
    const repeat_every = due ? (String(b.repeat_every || '').trim() || null) : null;
    const exists = await sb(`lists?name=eq.${encodeURIComponent(list)}&select=name&limit=1`);
    if (!exists.length) await sbWrite('lists', 'POST', { name: list });
    await sbWrite('list_items', 'POST', { id: crypto.randomUUID(), list_name: list, text, title, due, scheduled_at: due, repeat_every, deleted: false, created: now, updated: now });
    res.json({ ok: true, badge: await overdueCount() });
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});

// ---- desk control: repo picker -> a fresh Claude session on the Mac ----
// This server can't touch the Mac (it's on Fly), so it only reads what the Mac's orchestrator
// publishes and enqueues work for it: `repos` is scanned + written there, `desk_commands` is
// drained there. See voice-pipeline/orchestrator.
const DESK_STALE_S = 90;   // 3 missed 30s beats
const DESK_WORKER = { pi: 'pi-desk', mac: 'desk' };

/** Is the machine that would run this actually beating right now? */
async function machineAwake(machine) {
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

app.get('/api/repos', async (req, res) => {
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
app.get('/api/sessions', async (req, res) => {
  try {
    const [sessions, queue, focusRows] = await Promise.all([
      sb('desk_sessions?select=*&order=last_seen.desc'),
      sb('desk_queue?claimed=is.null&select=*&order=created.asc'),
      sb('desk_focus?id=eq.current&select=command_id'),
    ]);
    // Which session a spoken follow-up would land in. Resolved the same way the MCP resolves it —
    // through the COMMAND that created the session, never "the busiest session" — so what the panel
    // shows and what a follow-up actually does cannot drift apart.
    //
    // Null is a real and useful answer, not a gap: the pointer survives the session it named, so
    // after that session is closed a follow-up has nowhere to go. Showing nothing marked is how you
    // find that out before speaking, rather than after.
    const focusCmd = (focusRows || [])[0]?.command_id || null;
    // RESIDENT ONLY, because that is what a follow-up can actually reach: `followUp` refuses when the
    // session it points at is not running, saves the words and says so. Marking a closed session as
    // holding follow-ups said the opposite of what would happen — and the wall strip, which has
    // always filtered on resident, disagreed with the pane about the same pointer.
    const focus = focusCmd
      ? ((sessions || []).find((s) => s.command_id === focusCmd && s.status === 'resident')?.id || null)
      : null;
    // The number Jared says out loud. THE RULE IS SHARED WITH `numberSessions` IN data-layer's
    // desk.ts and both have to agree, or "session three" means one thing to the pane and another to
    // the voice tools: active sessions only, most recent first, numbered from 1. The number is a
    // position in the current list rather than identity — closing one renumbers the rest, which is
    // what keeps it 1..N over what is actually open.
    const numbered = new Map((sessions || [])
      .filter((s) => s.status === 'resident' || s.status === 'evicted')
      .sort((a, b) => new Date(b.last_seen).getTime() - new Date(a.last_seen).getTime())
      .map((s, i) => [s.id, i + 1]));
    const withN = (s) => ({ ...s, n: numbered.get(s.id) || null });
    res.json({
      // Resident = running now, reachable over Remote Control. Evicted = closed to free the machine
      // but resumable with full context, which is the distinction the panel has to make obvious.
      resident: (sessions || []).filter((s) => s.status === 'resident').map(withN),
      evicted: (sessions || []).filter((s) => s.status === 'evicted').map(withN),
      queued: queue || [],
      focus,
    });
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});

// Act on one: 'end' closes it for good, 'resume' brings an evicted one back, 'forget' drops the row
// without touching the machine (the transcript stays on disk; it just stops being offered).
app.post('/api/sessions/:action', express.json(), async (req, res) => {
  try {
    const action = String(req.params.action || '');
    const id = String((req.body || {}).id || '');
    if (!id) return res.status(400).json({ error: 'id required' });
    if (action === 'forget') {
      await sbWrite(`desk_sessions?id=eq.${encodeURIComponent(id)}`, 'DELETE');
      return res.json({ ok: true });
    }
    const rowsFull = await sb(`desk_sessions?id=eq.${encodeURIComponent(id)}&select=*`);
    if (!rowsFull.length) return res.status(404).json({ error: 'no such session' });

    // Hand it to the other machine, carrying the conversation. Same two paths as the voice tool, and
    // they have to stay the same: the source closes and flushes when it is up, and when it is not,
    // the destination resumes from what was already mirrored. (data-layer's transferSession.)
    if (action === 'transfer') {
      const row = rowsFull[0];
      const from = row.worker === 'desk' ? 'mac' : 'pi';
      const to = from === 'mac' ? 'pi' : 'mac';
      if (!row.claude_session_id) return res.status(400).json({ error: 'no transcript recorded for that session' });
      if (!(await machineAwake(to))) {
        const saved = await deadLetter('transfer_session', { session: id, target: from, to }, to,
                                       `the ${to === 'mac' ? 'Mac' : 'Pi'} is not responding`);
        return res.status(409).json({ error: `the ${to === 'mac' ? 'Mac' : 'Pi'} is not responding`, saved });
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

    // Name the session itself when it is running — `/rename` typed into it, the same command Jared
    // would — and always set the row, so the pane changes now rather than a tick later. A parked
    // session has no process to type into and takes the name in the row alone.
    if (action === 'rename') {
      const row = rowsFull[0];
      const name = String((req.body || {}).name || '').replace(/[\r\n]+/g, ' ').trim().slice(0, 60);
      if (!name) return res.status(400).json({ error: 'name required' });
      await sbWrite(`desk_sessions?id=eq.${encodeURIComponent(id)}`, 'PATCH', { label: name });
      const from = row.worker === 'desk' ? 'mac' : 'pi';
      if (row.status !== 'resident' || !(await machineAwake(from))) return res.json({ name, live: false });
      const cmdId = crypto.randomUUID();
      await sbWrite('desk_commands', 'POST',
        { id: cmdId, kind: 'rename_session', payload: { session: id, name, target: from } });
      return res.json({ id: cmdId, name, live: true });
    }

    const kind = action === 'resume' ? 'resume_session' : action === 'end' ? 'end_session' : null;
    if (!kind) return res.status(400).json({ error: 'unknown action' });
    // The machine that OWNS the session, read from its row. Hardcoding 'pi' sent every Mac session's
    // command to a consumer that rejects the id, while the Mac's never saw it at all.
    const machine = rowsFull[0].worker === 'desk' ? 'mac' : 'pi';
    const payload = { session: id, target: machine };
    if (!(await machineAwake(machine))) {
      const saved = await deadLetter(kind, payload, machine, `the ${machine === 'mac' ? 'Mac' : 'Pi'} is not responding`);
      return res.status(409).json({ error: `the ${machine === 'mac' ? 'Mac' : 'Pi'} is not responding`, saved });
    }
    // Routed through desk_commands like everything else, because this server is on Fly and cannot
    // reach either machine directly — Supabase carries both directions.
    const cmdId = crypto.randomUUID();
    await sbWrite('desk_commands', 'POST', { id: cmdId, kind, payload });
    res.json({ id: cmdId });
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});

app.post('/api/repos/open', express.json(), async (req, res) => {
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
      const saved = await deadLetter('open_session', payload, machine, `the ${machine === 'mac' ? 'Mac' : 'Pi'} is not responding`);
      return res.status(409).json({ error: `the ${machine === 'mac' ? 'Mac' : 'Pi'} is not responding`, saved });
    }
    const id = crypto.randomUUID();
    await sbWrite('desk_commands', 'POST', { id, kind: 'open_session', payload });
    res.json({ id });
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});

// ---- commands that never ran ---------------------------------------------
// Everything that could not be dispatched — machine asleep, expired unrun, launch errored, claimed
// by a machine that then died — lands in desk_dead_letters with its whole payload. This is the
// plumbing a retry button reads; nothing here decides anything on its own, because a prompt that
// fires hours late is worse than one that never fired.
app.get('/api/failures', async (req, res) => {
  try {
    const all = String(req.query.all || '') === '1';
    const filter = all ? '' : '&retried=is.null&dismissed=is.null';
    res.json({ failures: await sb(`desk_dead_letters?select=*${filter}&order=created.desc&limit=50`) });
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});

// Re-dispatch one, unchanged, if its machine is up now. The saved row is stamped rather than
// deleted, so what was retried and when stays visible.
app.post('/api/failures/:id/retry', express.json(), async (req, res) => {
  try {
    const id = String(req.params.id || '');
    const rows = await sb(`desk_dead_letters?id=eq.${encodeURIComponent(id)}&select=*`);
    if (!rows.length) return res.status(404).json({ error: 'no such saved command' });
    const row = rows[0];
    if (row.retried) return res.status(409).json({ error: 'already retried' });
    const machine = row.machine === 'mac' ? 'mac' : 'pi';
    if (!(await machineAwake(machine))) {
      return res.status(409).json({ error: `the ${machine === 'mac' ? 'Mac' : 'Pi'} is still not responding` });
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

app.post('/api/failures/:id/dismiss', express.json(), async (req, res) => {
  try {
    await sbWrite(`desk_dead_letters?id=eq.${encodeURIComponent(String(req.params.id || ''))}`, 'PATCH',
      { dismissed: new Date().toISOString() });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});

// Poll target for the launch button: pending -> running -> done | error | expired.
app.get('/api/repos/cmd/:id', async (req, res) => {
  try {
    const rows = await sb(`desk_commands?id=eq.${encodeURIComponent(req.params.id)}&select=status,detail`);
    if (!rows.length) return res.status(404).json({ error: 'not found' });
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
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
const reminderCtx = { sb, supaInsert: sbInsert, apns, settingsAll, log: (m) => console.log('[weight-reminder]', m) };
setInterval(() => weightReminder.tick(reminderCtx).catch((e) => console.log('[weight-reminder] error', e.message)), 60000);
weightReminder.tick(reminderCtx).catch(() => {});  // also evaluate once on boot
console.log(`[weight-reminder] armed (apns: ${apns.configured() ? 'configured, ' + apns.ENV : 'NOT configured'})`);

// ---- reminder firing: app-push a reminder once its due time (local) has passed. Dedupe via a
// `notifications` row keyed `reminder:<id>` so it fires exactly once. Date-only dues fire at 9am local.
// A date-only due means 9am local that day; otherwise the stored local-naive timestamp is the moment.
function dueMoment(due) {
  const d = String(due);
  return /T\d/.test(d) ? d : d.slice(0, 10) + 'T09:00:00';
}

// ---- recurrence ----
//
// '<n> <unit>' — '1 day', '2 hours', '1 month'. Null/unparseable means one-shot; there is no separate
// is_repeating flag, because a second field carrying the same fact is a second field that can
// contradict it (see migration 00058).
const REPEAT_MS = { minute: 60000, hour: 3600000, day: 86400000, week: 604800000 };
function parseRepeat(spec) {
  const m = String(spec || '').trim().toLowerCase().match(/^(\d+)\s*(minute|hour|day|week|month|year)s?$/);
  if (!m) return null;
  const n = Number(m[1]);
  return n >= 1 ? { n, unit: m[2] } : null;
}

// The next occurrence strictly after `notBefore`, counted from the item's ANCHOR rather than from its
// current due — see the month-clamp note below for why that distinction matters.
//
// Arithmetic is on the WALL-CLOCK components, not on an instant: `due` is local-naive text, so "every
// day at 9am" must stay 9am across a DST boundary rather than sliding to 8 or 10. Working in UTC
// getters/setters on a value that is really local is the trick that makes that true — no zone is ever
// applied, so nothing can shift.
function advanceDue(anchor, spec, notBefore) {
  const per = parseRepeat(spec);
  const m = String(anchor || '').match(/^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?/);
  if (!per || !m) return null;
  const hasTime = m[4] != null;
  const pad = (n) => String(n).padStart(2, '0');
  const fmt = (d) => {
    const day = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
    return hasTime ? `${day}T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}` : day;
  };
  let d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0)));
  const domWanted = d.getUTCDate();
  const step = () => {
    if (per.unit === 'month' || per.unit === 'year') {
      const months = per.unit === 'year' ? per.n * 12 : per.n;
      d.setUTCDate(1);                                   // avoid Jan 31 + 1 month landing in March
      d.setUTCMonth(d.getUTCMonth() + months);
      const lastDom = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
      d.setUTCDate(Math.min(domWanted, lastDom));        // clamp to the real end of a short month
      // The clamp does NOT accumulate, because every advance starts from `scheduled_at` — the date
      // the item was FIRST due — rather than from whatever the previous advance produced. A monthly
      // item anchored on the 31st therefore hits Feb 28 and then March 31, instead of degrading to
      // the 28th permanently. (This was a known wart until 00060 added the anchor.)
    } else {
      d = new Date(d.getTime() + per.n * REPEAT_MS[per.unit]);
    }
  };
  // Skip whole missed windows rather than firing once per window. A daily item that went unfired for
  // three days (server asleep, machine suspended) should come due once, tomorrow — not three times in
  // a row the moment the hub wakes up. The guard bounds a pathological spec.
  let guard = 0;
  do { step(); } while (dueMoment(fmt(d)) <= notBefore && ++guard < 2000);
  return fmt(d);
}

// ---- what happens when a dated item comes due ----
//
// The scheduler below finds due items; it does not deliver them. Delivery is a named handler, so a
// second channel is a new entry here rather than surgery on the loop. Today there is exactly one —
// APNs — and this seam is worth its ten lines only because the second one is already written down:
// AlarmKit (docs/TODO.md), which fires on-device and breaks through Focus. Telegram would be a third.
//
// Handlers receive the whole item and the dedupe key. They must be idempotent-safe to skip: the
// ledger check happens before dispatch, not inside them.
// A dated item now comes from a named list, so the notification leads with WHICH:
//
//     ⏰ Amazon — Order water filter
//     Order the replacement before the current one runs out
//
// One headline, list first, em dash, then what the thing is. The old fixed "Reminder" title carried
// no information at all — it was only ever there because reminders had no list to come from.
const listLabel = (name) => {
  const n = String(name || '').trim();
  return n ? n.charAt(0).toUpperCase() + n.slice(1) : 'Reminder';
};
const notifyHeadline = (item) => `${listLabel(item.list_name)} \u2014 ${itemTitle(item)}`;

// The body carries the DETAIL, and only when there is any: itemTitle() is already the short label
// (the explicit `title`, or the text up to its first em dash), so repeating the whole text under a
// headline that says the same thing is just noise. Empty is fine — apns.js only treats a push as
// silent when title AND body are both absent.
const NOTIFY_BODY_MAX = 180;
const itemBody = (item) => {
  const full = String(item.text || '').trim();
  const label = itemTitle(item);
  if (!full || full === label) return '';
  // When the label was DERIVED from this text (cut at the first em dash), the body is what the cut
  // removed — not the whole string again with the headline repeated at the front of it.
  const rest = full.startsWith(label) ? full.slice(label.length).replace(/^\s*[\u2014-]\s*/, '').trim() : full;
  if (!rest) return '';
  return rest.length > NOTIFY_BODY_MAX ? rest.slice(0, NOTIFY_BODY_MAX - 1).trimEnd() + '\u2026' : rest;
};

const DUE_HANDLERS = {
  // category + the row id give the notification its Done / 1 hour / Tomorrow buttons and tell the
  // app which item an action refers to. `reminder_id` keeps its name: the app's notification
  // actions and the APNs category are built around it, and renaming it would break every
  // notification already sitting in Notification Centre on the phone.
  push: (item, dedupeKey) =>
    // `emoji` overrides NOTIFY_STYLE.reminder's clock — pushAll merges `extra` over the style, so a
    // list's own mark wins and a list without one falls back to ⏰ automatically.
    pushAll('reminder', notifyHeadline(item), itemBody(item), dedupeKey,
            { category: 'REMINDER', payload: { reminder_id: item.id },
              ...(item.emoji ? { emoji: item.emoji } : {}) }),
};

async function dueTick() {
  const nowET = etNowString();
  let rows;
  // Every list, not just todo — "reminder" is a predicate (has a due), not a place.
  try { rows = await sb('list_items?deleted=eq.false&due=not.is.null&select=id,list_name,text,title,due,repeat_every,scheduled_at'); } catch (_) { return; }
  if (!rows.length) return;
  // One lookup for the whole tick rather than one per item — a handful of lists, read at most once a
  // minute, and only when something is actually dated.
  let emojiOf = {};
  try { for (const l of await sb('lists?select=name,emoji')) emojiOf[l.name] = l.emoji; } catch (_) {}
  for (const r of rows) {
    if (dueMoment(r.due) > nowET) continue;                           // not due yet
    // Scoped to the OCCURRENCE, not just the row: a repeating item fires under the same id again and
    // again, so a key of `reminder:<id>` alone would suppress every occurrence after the first. Adding
    // the due makes each occurrence its own ledger entry. It also means a snooze — which moves `due` —
    // gets a fresh key for free, instead of having to delete the old ledger row by hand.
    const dk = `reminder:${r.id}:${r.due}`;
    try { if ((await sb(`notifications?dedupe_key=eq.${encodeURIComponent(dk)}&select=id&limit=1`)).length) continue; } catch (_) { continue; }
    const handler = DUE_HANDLERS.push;
    if (handler === DUE_HANDLERS.push && !apns.configured()) continue;   // nothing to deliver through
    await handler({ ...r, emoji: emojiOf[r.list_name] }, dk);
    console.log(`[due] fired ${r.id} [${r.list_name}] "${String(r.title || r.text).slice(0, 40)}"`);
    // Re-arm a repeating item for its next occurrence. Done AFTER delivery so a failed send leaves the
    // row due and it retries next tick, rather than silently rolling forward and skipping one.
    if (r.repeat_every) {
      const next = advanceDue(r.scheduled_at || r.due, r.repeat_every, nowET);
      if (next) {
        await sbWrite(`list_items?id=eq.${encodeURIComponent(r.id)}`, 'PATCH', { due: next, updated: new Date().toISOString() });
        console.log(`[due] ${r.id} repeats every ${r.repeat_every} → next ${next}`);
      }
    }
  }
}
setInterval(() => dueTick().catch((e) => console.log('[due] error', e.message)), 60000);

// A published report announces itself on the phone.
//
// The ledger is the row's own `notified` column, not an in-memory set: the hub restarts on every
// deploy, and an in-memory set would either re-announce everything or lose whatever was in flight.
// A report is therefore announced exactly once, whatever happens to this process.
async function reportTick() {
  let rows = [];
  try { rows = await sb('reports?notified=eq.false&select=id,title,summary&order=created&limit=5'); }
  catch (_) { return; }
  for (const r of rows) {
    const body = String(r.summary || '').trim() || 'Tap to read the write-up.';
    // report_id rides in the APNs payload so tapping the notification opens that page rather than
    // dumping you on the dashboard to go find it.
    await pushAll('report', r.title || 'Report', body, `report:${r.id}`,
      { payload: { report_id: r.id, url: `/report/${r.id}` } });
    // Flip the flag even when the push failed. pushAll has already logged the failure to
    // `notifications`, and leaving it false would re-buzz the phone every tick once APNs recovers.
    try {
      await fetch(`${SUPABASE_URL}/rest/v1/reports?id=eq.${encodeURIComponent(r.id)}`, {
        method: 'PATCH',
        headers: {
          apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`,
          'Content-Type': 'application/json', Prefer: 'return=minimal',
        },
        body: JSON.stringify({ notified: true }),
      });
    } catch (_) {}
  }
}
setInterval(() => reportTick().catch((e) => console.log('[report] error', e.message)), 20000);
reportTick().catch(() => {});
dueTick().catch(() => {});
console.log('[due] firing armed');

// ---- badge sync. A reminder can be completed from anywhere — the hub UI, a voice command, the
// data MCP — and none of those go through this server, so polling the count is the one mechanism
// that covers every path. Only pushes when the number actually CHANGES, so it's silent no-ops most
// ticks. Badge-only pushes show nothing; they just correct the icon.
let lastBadge = null;
async function syncBadge() {
  if (!apns.configured()) return;
  const n = await overdueCount();
  if (!Number.isInteger(n) || n === lastBadge) return;
  lastBadge = n;
  let tokens = [];
  try { tokens = await sb('device_tokens?platform=eq.ios&select=token,environment'); } catch (_) { return; }
  for (const { token, environment } of tokens) await apns.send(token, { environment, badge: n });
  console.log(`[badge] -> ${n}`);
}
setInterval(() => syncBadge().catch((e) => console.log('[badge] error', e.message)), 60000);
syncBadge().catch(() => {});

// ---- retention. Clearing is a SOFT delete so it can be undone, but that's only tenable if the rows
// don't pile up forever. Anything cleared longer ago than the window is hard-deleted. Hourly is
// plenty for a 30-day horizon; exactness doesn't matter here.
const PURGE_AFTER_DAYS = 30;
async function purgeCleared() {
  const cutoff = new Date(Date.now() - PURGE_AFTER_DAYS * 86400000).toISOString();
  try {
    await sbWrite(`list_items?deleted=eq.true&updated=lt.${encodeURIComponent(cutoff)}`, 'DELETE');
  } catch (e) { console.log('[purge] list_items:', e.message); }
}
setInterval(() => purgeCleared().catch(() => {}), 3600000);
purgeCleared().catch(() => {});

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
