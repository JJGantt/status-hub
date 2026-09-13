'use strict';
const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pipeline } = require('stream/promises');
const { createClient } = require('@supabase/supabase-js');
const WebSocket = require('ws');
const heicConvert = require('heic-convert');
const { estimateMaintenance, estimateHistory, macroTargets } = require('./lib/maintenance');
const pace = require('./lib/pace');
const { computeVolume } = require('./lib/volume');
const BODY_SVG = require('./lib/bodymap');
// Weeks of heat map the HOME wall shows, against the health wall's 20. Trimming is what makes the two
// maps NARROWER at an unchanged cell size, and that freed width is the muscle column beside them --
// the point is never to show less, it is to not widen the column (which oversizes surf under it and
// robs the sessions column). Cells are fluid, so a trim only helps if the stack keeps its cell size.
const HOME_HEAT_WEEKS = 15;
// Weeks of heat grid carried in the status frame. The frame is re-pushed on every realtime event,
// so this window is fixed; everything older is served on demand by /api/heat-history, which splits
// its prefix at exactly this boundary.
const HEAT_WEEKS = 20;
const MON_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const { getTZ, setTZ, DAY_START_HOUR, localDate, nutritionWindow, lastNTrainingDays, dayBucketOf } = require('./lib/dates');
const { buildWorkoutHeatmap } = require('./lib/heatmap');
const { buildWeightPlot } = require('./lib/weightplot');
const { getWeather } = require('./lib/weather');
const { transcribe } = require('./lib/transcribe');
const { buildNutritionLog, buildGoalResolver, calorieColor } = require('./lib/nutritionlog');
const { computeScore, taskDeadline, completionValue, completionStamp, bandPoints, toPoints, TASK_GRACE_MIN, TASK_LATE_ZERO_H, TASK_DRAIN_FULL_H } = require('./lib/score');

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
    // Which wall the TV should be showing. The kiosk cannot be told to navigate from outside — it is
    // a browser on a machine nothing can reach — so the page watches this and goes there itself.
    wall: (() => {
      const w = String(s.wall_mode ?? 'standard').toLowerCase();
      // 'home' is a second word for the default wall, not a fourth wall — voice reaches it either
      // way and one value is stored, so nothing has to decide which of two names is current.
      if (w === 'home') return 'standard';
      return ['sessions', 'calendar', 'health'].includes(w) ? w : 'standard';
    })(),
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
// SSE heartbeat, on every stream. It has to be a NAMED EVENT rather than the `: keepalive` comment
// it used to be, because a comment is invisible to the client: EventSource surfaces no callback for
// one, so the page cannot tell a silent-but-healthy stream from a dead one. A `ping` event is the
// same cost on the wire and lets shared.js judge liveness by whether frames actually arrive — which
// matters most on the voice and list streams, where hours can legitimately pass with no data.
// No existing consumer sees it: named events never reach `onmessage` or an unrelated addEventListener.
const PING = 'event: ping\ndata: {}\n\n';

const sseClients = new Set();
// Separate SSE pool for the /tv voice-conversation panel — these get raw voice_messages /
// voice_focus rows, not the assembled status frame, so they don't carry the heavy status payload.
const voiceClients = new Set();
// Third pool, same reasoning as the voice one: the calendar surfaces need to know that a dated item
// changed, and nothing else. They are not on the status frame (they render none of it) and building
// one to say "something moved" would ship the whole dashboard to a page showing a month grid.
const listClients = new Set();
// Wall clients watching live session activity. Its own channel, like listClients: a wall wants tool
// calls the instant they happen and nothing else, so it should not take a full status frame to get
// them, and the standalone pages should not receive them at all.
const sessionClients = new Set();

// Dashboard HTML, read once from disk with the muscle-map SVG injected at the placeholder.
const DASHBOARD_HTML = fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8')
  .replace('<!--BODY_SVG-->', BODY_SVG);
// THE DEFAULT WALL — the home wall, at `/` and `/tv`. The aggregate: the shared frame (status strip,
// rings, health bar, footer, voice column) around today's day column, the three heat maps, and the
// newest session's last answer. `tv-home.js` + `tv-home.css` are its own; every other card on it is
// one core.js already paints.
// Injects the body-map SVG like the health wall does. It is ONE 72x93 figure here too; cards/muscle.js
// splits it into the stacked front/back pair itself (tvStackFigures) on any wall, so this wall only has
// to give it a column to be thin in.
// Injects the body map like the health wall does: this wall runs it as a thin column beside its two
// heat maps. It is ONE 72x93 figure here too — cards/muscle.js splits it into the stacked front/back
// pair itself, so the wall only has to give it a column to be thin in.
const TV_HTML = fs.readFileSync(path.join(__dirname, 'public', 'tv-home.html'), 'utf8')
  .replace('<!--BODY_SVG-->', BODY_SVG);
// THE HEALTH WALL, at /tv-health. What used to be the default: nutrition, the muscle map and volume
// bars, the workout heatmap, each with the detail panel its heatmap fills. Too much to glance at,
// which is why the home wall took `/` from it, and still the only place all of it is on one screen.
// Injects the body-map SVG at its placeholder — this is the wall with the muscle map.
const TV_HEALTH_HTML = fs.readFileSync(path.join(__dirname, 'public', 'tv-health.html'), 'utf8')
  .replace('<!--BODY_SVG-->', BODY_SVG);
// THE SESSIONS WALL, at /tv-session-focus — always-on, no interaction, stripped down around the
// sessions list so it reads from across a room and eventually from a watch.
//
// Every wall is a separate FILE rather than a mode flag, so work on one cannot disturb another. They
// share their scripts until something has to diverge, and whatever diverges gets split at that point.
const TV_FOCUS_HTML = fs.readFileSync(path.join(__dirname, 'public', 'tv-session-focus.html'), 'utf8')
  .replace('<!--BODY_SVG-->', BODY_SVG);
// Minimal home-screen "Voice" launcher (Add to Home Screen → standalone fullscreen tap-to-talk button).
const MIC_HTML = fs.readFileSync(path.join(__dirname, 'public', 'mic.html'), 'utf8');
// THE CALENDAR, twice. /calendar is the phone/desktop page — standalone like mic.html, navbar,
// tappable days. /tv-calendar is THE CALENDAR WALL: the shared frame (status strip, rings, health
// bar, footer, voice column) with the freed middle holding a day timeline + month grid(s), so
// wallmode.js can put it on the TV when wall_mode says 'calendar'.
const CAL_HTML = fs.readFileSync(path.join(__dirname, 'public', 'calendar.html'), 'utf8');
const TV_CAL_HTML = fs.readFileSync(path.join(__dirname, 'public', 'tv-calendar.html'), 'utf8');

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
const SURF_RATING_LABEL = {
  FLAT:'Flat', NONE:'Flat', VERY_POOR:'Very Poor', POOR:'Poor', POOR_TO_FAIR:'Poor–Fair',
  FAIR:'Fair', FAIR_TO_GOOD:'Fair–Good', GOOD:'Good', EPIC:'Epic',
};
const ratingLabel = (k) => SURF_RATING_LABEL[k] || k || '—';

// ---- Litter-Robot display state -------------------------------------------------------------
// The robot is held in Sleep Mode and the Fly watcher fires every clean itself, so the robot's own
// `status` is not the state of the box: it reads READY through a queued clean, a phantom weight, a
// 30-minute lockout, and a watcher that died an hour ago. The watcher publishes what it is doing in
// device_status.data; fold the two into one verdict here so every surface paints the same thing.
const LITTER_STATUS_LABEL = { READY:'Ready', CLEAN_CYCLE_COMPLETE:'Ready', DRAWER_FULL:'Ready',
  CLEAN_CYCLE:'Cleaning', CAT_DETECTED:'Cat detected', CAT_SENSOR_TIMING:'Waiting (post-cat)',
  CAT_SENSOR_INTERRUPTED:'Stuck (auto-resuming)', PAUSED:'Stuck (auto-resuming)', OFF:'Off',
  OFFLINE:'Offline' };
const LITTER_STALE_MS = 25 * 60 * 1000;   // the watcher refreshes every 10 min; miss two and it is gone
const LITTER_DRAWER_FULL_PCT = 90;        // the robot's own flag trips at ~53% depth; trust the depth

function agoShort(ms) {
  if (ms == null) return null;
  const m = Math.round(ms / 60000);
  if (m < 1) return 'now';
  if (m < 60) return m + 'm';
  const h = Math.floor(m / 60);
  return h < 48 ? h + 'h' : Math.floor(h / 24) + 'd';
}

function buildLitter(row) {
  if (!row) return null;
  const d = row.data || {};
  const now = Date.now();
  const age = row.updated_at ? now - Date.parse(row.updated_at) : null;
  const cleanIn = d.clean_due_at ? Math.max(0, Date.parse(d.clean_due_at) - now) : null;
  const usedAgo = d.last_visit_at ? now - Date.parse(d.last_visit_at) : null;
  const cleanedAgo = d.last_clean_at ? now - Date.parse(d.last_clean_at) : null;
  const st = row.status || 'OFFLINE';
  let state, label;
  // Ordered worst-first: a fault outranks the cycle it interrupted, and both outrank a queued clean.
  if (age == null || age > LITTER_STALE_MS) { state = 'STALE'; label = 'Stale'; }
  else if (!row.online) { state = 'OFFLINE'; label = 'Offline'; }
  else if (st === 'CAT_SENSOR_INTERRUPTED' || st === 'PAUSED') { state = 'STUCK'; label = LITTER_STATUS_LABEL[st]; }
  else if (d.locked_out) { state = 'LOCKED_OUT'; label = 'Locked out'; }
  else if (d.scale_stuck) { state = 'SCALE_STUCK'; label = 'Scale stuck'; }
  else if (row.waste_drawer_pct >= LITTER_DRAWER_FULL_PCT) { state = 'DRAWER_FULL'; label = 'Drawer full!'; }
  else if (st === 'CLEAN_CYCLE') { state = 'CLEANING'; label = 'Cleaning'; }
  // Sleep mode is the whole model — out of it the robot auto-cycles and the watcher is a bystander.
  else if (d.sleeping === false) { state = 'SELF_CYCLING'; label = 'Self-cycling'; }
  else if (d.clean_pending) { state = 'CLEAN_QUEUED'; label = cleanIn ? 'Clean in ' + Math.ceil(cleanIn / 60000) + 'm' : 'Clean queued'; }
  else { state = 'READY'; label = LITTER_STATUS_LABEL[st] || st; }
  const color = { STALE:'#ef4444', OFFLINE:'#ef4444', STUCK:'#f97316', LOCKED_OUT:'#f97316',
    SCALE_STUCK:'#f97316', DRAWER_FULL:'#ef4444', CLEANING:'#eab308', SELF_CYCLING:'#f97316',
    CLEAN_QUEUED:'#a855f7', READY:'#3b82f6' }[state];
  return { ...row, state, label, color, clean_in_s: cleanIn == null ? null : Math.round(cleanIn / 1000),
    used_ago: agoShort(usedAgo), cleaned_ago: agoShort(cleanedAgo) };
}

// The header strip carries the rating and the current size, nothing else. Water and air both had
// chips here and no longer do; the water panel below the grids answers the first in far more detail
// than a single number could, which is what made the chip redundant rather than merely crowded.
function buildSurf(row) {
  if (!row || !Array.isArray(row.rows) || !row.rows.length) return null;
  const rows = row.rows;
  // Nearest hour to now, for the card's header strip. The per-day breakdown that used to live here
  // is gone: the two grids show every hour of every day, so a seven-row summary of the same data
  // was a second, coarser answer to a question already answered above it.
  const now = Date.now() / 1000;
  const cur = rows.reduce((a, b) => (Math.abs(b.ts - now) < Math.abs(a.ts - now) ? b : a), rows[0]);
  return {
    spot: row.slug || 'mayport-poles',
    capturedAt: row.captured_at,
    current: cur ? {
      // The dot wears the same band colour the grid and the key below it paint this rating, NOT
      // Surfline's own scale — those disagree (Surfline paints POOR blue, the band palette red),
      // and two colours for one rating in one card reads as two different readings.
      ratingLabel: ratingLabel(cur.rk), ratingColor: SURF_BAND_COLORS[surfBand(cur.rk)] || '#8b96a5',
      hMin: cur.sMin, hMax: cur.sMax,
    } : null,
  };
}

// ---- surf history: rating, size and water for the card's grids ----
// surf_hours grows by 24 rows a day. This is deliberately NOT in the 30s broadcast payload: that
// frame goes to every connected surface on every tick, and this would multiply it by an order of
// magnitude to redraw grids that change twice a day.
//
// Window: twice as much history as forecast, matching the near view in surf-report/plots.py. The
// whole archive would be a couple of pixels per column on a phone.
//
// Rating and size travel as strings, one character per hour from t0 — a band index, or '.' for an
// hour with no reading. That keeps ~700 hours near 1KB rather than tens of KB of JSON objects.
//
// Rating bands are a judgment, not a magnitude: red at or below Poor, yellow Poor-Fair, green Fair,
// blue Good, purple Epic. Everything at or below Poor is one band because the difference between
// Very Poor and Poor never changes whether it is worth going. Size stays a sequential ramp because
// it really is a magnitude: white for 0-1 ft, then blues from light to the darkest navy that still
// reads as blue, so every band above flat gets the whole blue range to itself.
const SURF_RATING_SCALE = ['FLAT','VERY_POOR','POOR','POOR_TO_FAIR','FAIR','FAIR_TO_GOOD','GOOD','EPIC'];
const SURF_BAND_COLORS  = ['#ff3b30', '#ffcc00', '#34c759', '#0a84ff', '#af52de'];
const SURF_BAND_LABELS  = ['Poor or below', 'Poor\u2013Fair', 'Fair', 'Good', 'Epic'];
// Size bands are derived from the data, not fixed. Surfline's bands are not uniform one-foot steps
// (4-5 and 4-6 both exist) and `plus` adds a half-step inside a band, so a hardcoded ladder drops
// anything outside the range one spot happens to produce.
const SURF_SIZE_FLAT = '#ffffff';     // every band topping out at 1 ft
const SURF_SIZE_FLAT_MAX = 1;
// The blues are spaced evenly in OKLCH lightness, not blended in RGB between fixed stops: RGB stops
// bunched the middle bands together, which is what made adjacent sizes hard to tell apart. Hue drifts
// toward pure blue as it darkens because a fixed hue goes grey-navy at the dark end. Chroma is the
// most sRGB can hold at each lightness, capped so the mid blues don't go neon.
const SURF_SIZE_L = [0.86, 0.20], SURF_SIZE_H = [252, 264], SURF_SIZE_CMAX = 0.17;

function oklchHex(L, C, h) {
  const hr = h * Math.PI / 180;
  const rgb = (c) => {
    const a = c * Math.cos(hr), b = c * Math.sin(hr);
    const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
    const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
    const s = (L - 0.0894841775 * a - 1.2914855480 * b) ** 3;
    return [4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
           -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
           -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s];
  };
  let lo = 0, hi = C;   // bisect for the largest chroma still inside sRGB
  for (let i = 0; i < 30; i++) {
    const c = (lo + hi) / 2;
    if (rgb(c).every((v) => v >= -1e-4 && v <= 1 + 1e-4)) lo = c; else hi = c;
  }
  const enc = (x) => x <= 0.0031308 ? 12.92 * x : 1.055 * Math.pow(x, 1 / 2.4) - 0.055;
  return '#' + rgb(lo).map((v) =>
    Math.round(Math.min(1, Math.max(0, enc(v))) * 255).toString(16).padStart(2, '0')).join('');
}

function sizeRamp(n) {
  return Array.from({ length: n }, (_, i) => {
    const t = n === 1 ? 0 : i / (n - 1);
    return oklchHex(SURF_SIZE_L[0] + (SURF_SIZE_L[1] - SURF_SIZE_L[0]) * t, SURF_SIZE_CMAX,
                    SURF_SIZE_H[0] + (SURF_SIZE_H[1] - SURF_SIZE_H[0]) * t);
  });
}

// An unknown key is dropped, never guessed.
function surfBand(rk) {
  const i = SURF_RATING_SCALE.indexOf(rk);
  if (i < 0) return null;
  if (i <= SURF_RATING_SCALE.indexOf('POOR')) return 0;
  if (i === SURF_RATING_SCALE.indexOf('POOR_TO_FAIR')) return 1;
  if (i <= SURF_RATING_SCALE.indexOf('FAIR_TO_GOOD')) return 2;
  if (i === SURF_RATING_SCALE.indexOf('GOOD')) return 3;
  return 4;
}

// Realtime is the fast path; this is the floor under it. A `surf_snapshots` event is a SINGLE
// delivery, and the socket drops them — CHANNEL_ERROR and half-open silence are both routine
// (`REALTIME_SILENCE_LIMIT_MS` exists for exactly that). Without an age check one missed event froze
// the whole surf history at whatever the process built on boot, with no way back but a redeploy: on
// 2026-09-07 the card served a 16-hour-old body and the measured water trace simply stopped at the
// previous evening. Every other cache here already reconciles on a backstop; this was the only one
// that could not.
const SURFHIST_BACKSTOP_MS = 15 * 60 * 1000;
let surfHistCache = { at: 0, body: null };
const dirtySurfHist = () => { surfHistCache = { at: 0, body: null }; };


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
  const taskWindowStart = localDate(new Date(Date.now() - 8 * 86400000));  // an effect is gone at 7 days; a day's slack costs nothing
  const key = [win.start, win.end, week[0], histStart, heatStart, nutLogStart, taskWindowStart].join('|');
  if (!rowCache.dirty && rowCache.rows && rowCache.key === key
      && Date.now() - rowCache.at < ROWCACHE_BACKSTOP_MS) return rowCache.rows;
  const [entries, stagedEntries, setRows, weightRows, histRows, muscleRows, heatRows, catalogRows, nutLogRows, targetRows, surfRows, taskEventRows, openTaskRows] = await Promise.all([
    sb(`nutrition_entries?occurred_at=gte.${win.start}&occurred_at=lt.${win.end}&staged=eq.false&select=calories,protein_g,carbs_g,fat_g,veg_g,dark_green_g,fruit_g`),
    // Staged meals carry no day: they are pending until committed, so there is no window to filter on
    // and every staged row belongs to whatever day it is eaten on. Sum them all.
    sb('nutrition_entries?staged=eq.true&select=calories,protein_g,carbs_g,fat_g'),
    sb(`sets?occurred_at=gte.${week[0]}T00:00:00&select=occurred_at,exercise,muscles_override`),
    sb('weight_log?select=date,weight_lbs&order=date.asc'),
    sbRange(`nutrition_entries?occurred_at=gte.${histStart}T00:00:00&staged=eq.false&select=occurred_at,calories&order=occurred_at`),
    sb('exercise_muscles?select=name,muscle,contribution'),
    sbRange(`sets?occurred_at=gte.${heatStart}T00:00:00&select=occurred_at&order=occurred_at`),
    sb('exercise_catalog?select=name,equipment'),
    sbRange(`nutrition_entries?occurred_at=gte.${nutLogStart}T00:00:00&staged=eq.false&select=occurred_at,calories,protein_g,fat_g&order=occurred_at`),
    sb('nutrition_targets?select=date,calories&order=date.asc'),
    sb('surf_snapshots?select=slug,captured_at,rows&order=captured_at.desc&limit=1'),
    // The gold band's two inputs, both ordinary `list_items` rows. A completed item persists — it
    // still draws on the calendar — so it is its own record and there is no separate ledger. The
    // drain is derived live from whatever is still outstanding, so there is no stored penalty to
    // fall out of step with the list.
    sb(`list_items?deleted=eq.false&completed_at=gte.${taskWindowStart}T00:00:00&due=not.is.null&select=scheduled_at,due,completed_at,priority`),
    sb('list_items?deleted=eq.false&completed_at=is.null&due=not.is.null&select=scheduled_at,due,priority'),
  ]);
  rowCache.rows = { entries, stagedEntries, setRows, weightRows, histRows, muscleRows, heatRows, catalogRows, nutLogRows, targetRows, surfRows, taskEventRows, openTaskRows };
  rowCache.key = key; rowCache.at = Date.now(); rowCache.dirty = false;
  return rowCache.rows;
}

async function buildStatus() {
  const win = nutritionWindow();
  const today = win.day;
  const week = lastNTrainingDays(7);
  const histStart = localDate(new Date(Date.now() - 210 * 86400000)); // intake history for the maintenance trend + per-day replay (viz paging)
  const heatStart = localDate(new Date(Date.now() - HEAT_WEEKS * 7 * 86400000)); // the frame's workout heatmap window

  const [{ entries, stagedEntries, setRows, weightRows, histRows, muscleRows, heatRows, catalogRows, nutLogRows, targetRows, surfRows, taskEventRows, openTaskRows }, deviceRows, presenceRows, workerRows] = await Promise.all([
    fetchStatusRows(win, week, histStart, heatStart),
    sb('device_status?select=*'),
    sb('voice_presence?select=source,alive_at'),
    sb('worker_presence?select=worker,last_seen,info'),
  ]);

  const litter = buildLitter((deviceRows || []).find((d) => d.device !== 'cat-feeder') || null);
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
  // rather than something you have to open a pane to learn. The same rule as /api/sessions
  // (pickFocus), so the strip, the wall and the behaviour cannot disagree.
  let deskFocus = null;
  try {
    const [fRows, sRows] = await Promise.all([
      sb('desk_focus?id=eq.current&select=command_id,session_id'),
      sb('desk_sessions?status=eq.resident&select=id,repo,label,command_id,status,active_at,reply_at,started'),
    ]);
    const { session: hit, pinned } = await pickFocus((fRows || [])[0], sRows);
    if (hit) deskFocus = { id: hit.id, repo: hit.repo, label: hit.label || null, pinned };
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
    // The Pi's own resources, as pi-desk sees them (it publishes them on its 30s heartbeat). On the
    // wall so the machine is not invisible until it falls over: it OOM-killed sessions daily for days
    // while every indicator up here stayed green, because none of them was about the machine.
    // Thresholds live here rather than in the card, so the colour cannot disagree between surfaces —
    // swap's amber is deliberately well under pi-desk's own 70% refuse-to-launch ceiling.
    host: (() => {
      const row = (workerRows || []).find((r) => r.worker === 'pi-desk');
      const i = (row && row.info) || {};
      if (!freshFor(row && row.last_seen) || i.mem_pct == null) return null;
      const band = (v, warn, crit) => (v >= crit ? 'crit' : v >= warn ? 'warn' : 'ok');
      return {
        mem: i.mem_pct, mem_state: band(i.mem_pct, 80, 92),
        swap: i.swap_pct ?? null, swap_state: i.swap_pct == null ? 'ok' : band(i.swap_pct, 40, 70),
        sessions: i.sessions ?? null, session_max: i.session_max ?? null,
      };
    })(),
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
  // What is staged but not eaten. Kept OUT of `nutrition` and out of `consumed` — it is what the day
  // would become, never what it is — and handed to the pace math separately so the rings can draw it
  // as a piece past the real arc.
  const stagedSum = (k) => Math.round((stagedEntries || []).reduce((a, e) => a + (Number(e[k]) || 0), 0));
  const stagedMacros = { calories: stagedSum('calories'), protein_g: stagedSum('protein_g'),
                         carbs_g: stagedSum('carbs_g'), fat_g: stagedSum('fat_g') };
  const paceData = pace.computePace({
    consumed: { calories: nutrition.calories, protein_g: nutrition.protein_g, carbs_g: nutrition.carbs_g, fat_g: nutrition.fat_g },
    goal: maintenance.target_macros,
    staged: stagedMacros,
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
  const heatmap = buildWorkoutHeatmap(heatRows, HEAT_WEEKS, today); // 4am `today`, matching the nutrition heatmap

  // ---- nutrition log: calorie-adherence calendar (per-day historical targets) + calorie/weight trend ----
  const nutrition_log = buildNutritionLog(nutLogRows || [], weights, maintenance.target, maintenance.maintenance, today, targetRows || [], HEAT_WEEKS, surplus, 150, paceData.fraction);


  // `months` is parallel to `weeks` and labels a column only where the month changes, so a slice can
  // begin on an unlabelled column; the first is relabelled from its own first day.
  const trimHeat = (h, n) => {
    const weeks = h.weeks.slice(-n);
    const months = h.months.slice(-n);
    if (weeks.length && !months[0]) months[0] = MON_ABBR[Number(weeks[0][0].date.slice(5, 7)) - 1];
    return { weeks, months };          // only what differs — the card spreads it over the full object
  };
  const heatmap_home = trimHeat(heatmap, HOME_HEAT_WEEKS);
  const nutrition_log_home = trimHeat(nutrition_log, HOME_HEAT_WEEKS);
  // Built at the HOME window because the home wall is the only surface that draws it: the plot is
  // meaningless away from the columns it is aligned to, so there is no full-window version to trim.
  const weight_plot = buildWeightPlot(weights, HOME_HEAT_WEEKS, today);

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
  // surplus signs the goal-aware calorie scoring; the task inputs are the gold band's ledger and the
  // still-open dated items it drains from.
  const score = computeScore({
    volume, days: scoreDays, surplus,
    taskEvents: taskEventRows || [], openTasks: openTaskRows || [], nowLocal: etNowString(),
  });

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
  // Sets logged so far in the current 4am-origin day — the same figure the day-detail panel heads
  // its list with, carried on the payload so the rest-timer block can show it without a second read.
  const sets_today = (heatRows || []).reduce((n, r) => n + (dayBucketOf(r.occurred_at) === today ? 1 : 0), 0);
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
  return { today, litter, feeder, surf, weather: getWeather(), nutrition, maintenance, pace: paceData, volume, heatmap, nutrition_log,
    heatmap_home, nutrition_log_home, weight_plot,
    last_set_at, session_start_at, sets_today, rep_watcher, routing, mics, score, desk_focus: deskFocus,
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

// Tell every open calendar surface that dated items changed, so it re-reads /api/calendar. The
// signal carries no payload on purpose: what each surface needs back differs (the wall wants
// `calendar_months` months plus today's timeline, the phone wants whichever month it has paged to),
// so the fetch that follows is the only thing that knows what to ask for.
function pushLists() {
  const frame = 'event: lists\ndata: {}\n\n';
  for (const res of listClients) { try { res.write(frame); } catch {} }
}

// What a session is doing RIGHT NOW, keyed by session id so each one draws on its own line.
// Transient by design — nothing is stored. A tool call is only interesting while it is happening,
// and the durable half of a turn (`last_reply`) goes to the database on its own path.
function pushSession(row) {
  const frame = 'event: session\ndata: ' + JSON.stringify(row) + '\n\n';
  for (const res of sessionClients) { try { res.write(frame); } catch {} }
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
  const changed = () => { seen(); dirtyRows(); dirtyNutDay(); dirtyWorkoutDay(); dirtyHeatHistory(); broadcast(); };
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
    // A new snapshot changes both the card's current reading and the heatmap behind it.
    .on('postgres_changes', { event: '*', schema: 'public', table: 'surf_snapshots' },
      (p) => { dirtySurfHist(); changed(p); })
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
      if (p.new && p.new.key === 'agent_mode') pushVoice('mode', { agent: agentModeOn(p.new.value) });
    })
    // Dated items and the lists that colour them. `list_items` DOES feed the status frame now — the
    // health bar's gold band is earned by clearing dated items and drained by leaving them — so a
    // change has to invalidate the row cache and rebuild, not merely notify the calendar surfaces.
    // Without the rebuild a completion would not show on the bar until the 15-minute backstop, which
    // is the one moment the reward is supposed to land.
    .on('postgres_changes', { event: '*', schema: 'public', table: 'list_items' },
      () => { seen(); dirtyRows(); pushLists(); broadcast(); })
    .on('postgres_changes', { event: '*', schema: 'public', table: 'lists' },
      () => { seen(); pushLists(); })
    // Voice pipeline: stream inserts/updates straight to the /tv conversation panel. INSERT and
    // UPDATE both carry the new row in `payload.new` (UPDATE = a streamed row flipping done=true).
    .on('postgres_changes', { event: '*', schema: 'public', table: 'voice_messages' },
      (p) => { seen(); if (p.new) pushVoice('message', p.new); })
    // A client waiting on its own command (/api/voice-reply/:id) is answered the moment the worker
    // marks the request finished.
    .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'voice_requests' },
      (p) => { seen(); if (p.new) settleReply(p.new); })
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

// The watchdog above judges the socket by whether ANY event arrives, and that is a proxy it cannot
// keep honest: `seen()` is fed by every subscription, and device_status is written every couple of
// minutes by the litter and feeder watchers. So the one table with a permanent heartbeat vouches for
// all the others, and a channel that reports SUBSCRIBED while delivering nothing for
// `nutrition_entries` looks perfectly alive. That is not hypothetical — on 2026-09-10 a meal logged
// at 09:26 did not reach any surface until the 15-minute backstop lapsed, the socket had been
// SUBSCRIBED since 08:17 with device_status flowing the whole time, and the watchdog logged nothing.
//
// So check FUNCTION, not liveness: ask the database directly whether anything has been written that
// the cache has not seen. The probe is a row COUNT per write-active table plus the newest completion
// stamp — a few hundred bytes, against the ~143KB of the real queries — so it can run often enough
// to close the window without undoing the caching it is protecting.
//
// A miss is also evidence the channel is lying, so it recycles the socket as well as refetching, and
// it LOGS. The failure it exists to catch produced no output at all, which is why it went unnoticed
// long enough to be reported as a date bug.
const FRESH_PROBE_MS = 2 * 60 * 1000;
// count=exact + a zero-row Range: PostgREST answers in the Content-Range header and sends no body.
async function tableCount(table) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${table}?select=id`, {
    headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`,
               'Range-Unit': 'items', Range: '0-0', Prefer: 'count=exact' },
  });
  if (!r.ok && r.status !== 206) throw new Error(`count ${table} -> ${r.status}`);
  const cr = r.headers.get('content-range') || '';
  return cr.slice(cr.indexOf('/') + 1);      // "0-0/1234" -> "1234"
}
async function freshnessFingerprint() {
  const [nutrition, sets, items, completed] = await Promise.all([
    tableCount('nutrition_entries'),
    tableCount('sets'),
    tableCount('list_items'),
    // Completing an item changes no count, and it is the write the gold band is built on.
    sb('list_items?completed_at=not.is.null&select=completed_at&order=completed_at.desc&limit=1')
      .then((r) => (r[0] && r[0].completed_at) || ''),
  ]);
  return [nutrition, sets, items, completed].join('|');
}
let lastFingerprint = null;
setInterval(async () => {
  let fp;
  try { fp = await freshnessFingerprint(); } catch (e) { console.log('freshness probe:', e.message); return; }
  if (lastFingerprint === null) { lastFingerprint = fp; return; }   // first run only establishes a baseline
  if (fp === lastFingerprint) return;
  lastFingerprint = fp;
  if (!rowCache.dirty) {
    // The cache was clean, so realtime should already have dirtied it and did not.
    console.log(`freshness probe: rows changed with no realtime event (${fp}) — refetching and recycling the socket`);
    dirtyRows(); dirtyNutDay(); dirtyWorkoutDay(); dirtyHeatHistory();
    try { if (hubChannel) supa.removeChannel(hubChannel); } catch (e) { console.log('removeChannel:', e.message); }
    lastRealtimeEvent = Date.now();
    try { startRealtime(); } catch (e) { console.log('resubscribe failed:', e.message); }
    broadcast();
  }
}, FRESH_PROBE_MS);

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

// Public, unauthenticated, and deliberately ABOVE the auth gate: Google has to fetch these
// as an anonymous crawler. Behind the gate it gets the login page and every check fails.
//
// Why the hub hosts them at all: publishing an OAuth app to production (which the Gmail
// integration needs, because an app left in "Testing" is issued refresh tokens Google
// revokes after 7 days) requires a homepage, privacy policy and terms on a domain verified
// in Search Console. fly.dev is on the Public Suffix List, so jared-status-hub.fly.dev is a
// registrable domain we control -- no domain purchase needed.
//
// GSC_VERIFICATION holds the filename Search Console issues, e.g. "google<hex>.html". Matching
// on it rather than answering any /google*.html means this cannot be used by anyone else to
// claim the domain in their own Search Console.
if (process.env.GSC_VERIFICATION) {
  app.get(`/${process.env.GSC_VERIFICATION}`, (req, res) =>
    res.type('text').send(`google-site-verification: ${process.env.GSC_VERIFICATION}`));
}

for (const doc of ['privacy', 'terms']) {
  app.get(`/${doc}`, (req, res) => {
    const file = path.join(__dirname, 'legal', `${doc}.html`);
    if (!fs.existsSync(file)) return res.status(404).type('text').send('not found');
    res.setHeader('Cache-Control', 'no-cache');
    res.type('html').send(fs.readFileSync(file, 'utf8'));
  });
}

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

// `/` AND `/tv` ARE NOT THE SAME PAGE, and this is the one thing to know before changing a wall.
//
// `/tv` is the TV — the Pi's kiosk loads it, and it serves whichever wall is being built. `/` is the
// PHONE: the iOS app loads it, wall.js scales the shell into a swipe pane and wraps its own pages
// around it. They shared one route until the home wall took over the TV, and the phone came along
// with it uninvited — a wall reflowed for a phone in portrait is a different piece of work from the
// wall itself, and pointing one route at a new file does not do it.
//
// So a new wall goes on `/tv` and `/` stays where it is until the phone side is actually done.
// The full detail page is '/page'. no-cache so a deploy is never masked by a stale cached page.
app.get('/tv', (req, res) => {
  res.setHeader('Cache-Control', 'no-cache');
  res.type('html').send(TV_HTML);
});
app.get('/', (req, res) => {
  res.setHeader('Cache-Control', 'no-cache');
  res.type('html').send(TV_HEALTH_HTML);
});
app.get('/tv-session-focus', (req, res) => {
  res.setHeader('Cache-Control', 'no-cache');
  res.type('html').send(TV_FOCUS_HTML);
});
app.get('/tv-health', (req, res) => {
  res.setHeader('Cache-Control', 'no-cache');
  res.type('html').send(TV_HEALTH_HTML);
});
app.get('/page', (req, res) => {
  res.setHeader('Cache-Control', 'no-cache');
  res.type('html').send(DASHBOARD_HTML);
});
app.get('/mic', (req, res) => {
  res.setHeader('Cache-Control', 'no-cache');
  res.type('html').send(MIC_HTML);
});
// Two pages on purpose: wallmode.js switches only kiosk paths, so a spoken "put the calendar on
// the TV" moves /tv-calendar and never yanks a phone sitting on /calendar.
app.get('/calendar', (req, res) => {
  res.setHeader('Cache-Control', 'no-cache');
  res.type('html').send(CAL_HTML);
});
app.get('/tv-calendar', (req, res) => {
  res.setHeader('Cache-Control', 'no-cache');
  res.type('html').send(TV_CAL_HTML);
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

// Sits below the auth gate on purpose: it was briefly above it, which left the whole surf
// archive readable by anyone with the URL.
app.get('/api/surf/history', async (req, res) => {
  try {
    if (surfHistCache.body && Date.now() - surfHistCache.at < SURFHIST_BACKSTOP_MS)
      return res.json(surfHistCache.body);
    const rows = await sbRange('surf_hours?select=ts,rk,s_min,s_max,s_plus,s_raw_max&order=ts.asc');
    if (!rows.length) return res.json({ t0: null, hours: 0 });

    const nowH = Math.floor(Date.now() / 3600000) * 3600;
    const ahead = Math.max(0, rows[rows.length - 1].ts - nowH);
    const etHour = (ts) => +new Intl.DateTimeFormat('en-US', {
      hour: 'numeric', hour12: false, timeZone: 'America/New_York' }).format(new Date(ts * 1000)) % 24;
    // The whole archive, because the card scrolls back through it. Both ends of a window have to
    // land on local midnight: the client buckets hours into day columns by local date, so a start
    // part-way through a day renders as a stub column. Forward at the archive's start (snapping
    // back would invent empty hours before the first reading), back at the default view's.
    const first = rows[0].ts, fh = etHour(first);
    const from = fh === 0 ? first : first + (24 - fh) * 3600;
    const win = rows.filter((r) => r.ts >= from);
    if (!win.length) return res.json({ t0: null, hours: 0 });
    // Where the card sits before anyone scrolls. Twelve days back plus whatever Surfline forecasts
    // ahead (about nine) is three weeks, which is what fills the wall's grid box at ~18px per day
    // now that weather has taken the right-hand third of the card. Widen this and the columns get
    // narrower rather than the card getting wider; the day is the unit that has to stay readable.
    const rough = nowH - 12 * 86400;
    const defaultT0 = Math.max(from, rough - etHour(rough) * 3600);

    const t0 = win[0].ts, tN = win[win.length - 1].ts;
    const hours = Math.floor((tN - t0) / 3600) + 1;
    const by = new Map(win.map((r) => [r.ts, r]));

    // Both water series come from `water_readings`, read at request time. The measured trace used to
    // ride on `surf_hours.water_f`, which surf-report's materialize step fills — so it could only
    // advance when a Surfline capture ran, every 3h, and the top of that hour races the buoy pull
    // that feeds it. The reading itself is half-hourly and owes nothing to Surfline, so tying its
    // freshness to a forecast scrape put the card hours behind a source that was already current.
    const sinceT0 = `&ts=gte.${new Date(t0 * 1000).toISOString()}&order=ts.asc`;
    let meas = [], fc = [];
    try {
      // Forecast water is a different claim from a measurement, so it stays a separate series rather
      // than being backfilled into the gap after now.
      [meas, fc] = await Promise.all([
        sbRange(`water_readings?select=ts,water_f&station=eq.41112${sinceT0}`),
        sbRange(`water_readings?select=ts,water_f&station=eq.open-meteo${sinceT0}`),
      ]);
    } catch (_) { /* the grids are still worth drawing without it */ }
    // Mean of every reading inside the hour, matching how plots.py draws the same buoy.
    const hourOfTs = (r) => Math.floor(Date.parse(r.ts) / 3600000) * 3600;
    const measAcc = new Map();
    for (const r of meas) {
      if (r.water_f == null) continue;
      const a = measAcc.get(hourOfTs(r)) || [0, 0];
      a[0] += r.water_f; a[1]++;
      measAcc.set(hourOfTs(r), a);
    }
    const fcBy = new Map(fc.map((r) => [hourOfTs(r), r.water_f]));

    // Distinct size bands present in this window, ordered by real height where we have it and by
    // the label for rows predating 00083.
    const combos = new Map();
    for (const r of win) {
      if (r.s_max == null) continue;
      const key = `${r.s_min}|${r.s_max}|${r.s_plus ? 1 : 0}`;
      const mag = r.s_raw_max == null ? null : r.s_raw_max;
      const prev = combos.get(key);
      if (!prev) combos.set(key, { min: r.s_min, max: r.s_max, plus: !!r.s_plus, mag });
      else if (mag != null) prev.mag = prev.mag == null ? mag : Math.max(prev.mag, mag);
    }
    const order = [...combos.entries()].sort((a, b) => {
      const ka = a[1].mag ?? (a[1].max + (a[1].plus ? .5 : 0));
      const kb = b[1].mag ?? (b[1].max + (b[1].plus ? .5 : 0));
      return ka - kb || a[1].max - b[1].max || (a[1].plus ? 1 : 0) - (b[1].plus ? 1 : 0);
    });
    const sizeIdx = new Map(order.map(([k], i) => [k, i]));
    const nFlat = order.filter(([, v]) => v.max <= SURF_SIZE_FLAT_MAX).length;  // sorted, so a prefix
    const sizeColors = Array(nFlat).fill(SURF_SIZE_FLAT).concat(sizeRamp(order.length - nFlat));
    const sizeLabels = order.map(([, v]) => `${v.min}\u2013${v.max}${v.plus ? '+' : ''} ft`);

    let rating = '', size = '';
    const water = [], waterFc = [];
    for (let t = t0, i = 0; i < hours; t += 3600, i++) {
      const r = by.get(t);
      const b = r ? surfBand(r.rk) : null;
      rating += b == null ? '.' : String(b);
      const sk = r && r.s_max != null ? sizeIdx.get(`${r.s_min}|${r.s_max}|${r.s_plus ? 1 : 0}`) : undefined;
      size += sk == null ? '.' : sk.toString(36);      // base36 so more than ten bands still fit one char
      const m = measAcc.get(t);
      water.push(m ? Math.round((m[0] / m[1]) * 10) / 10 : null);
      const f = fcBy.get(t);
      waterFc.push(f == null ? null : Math.round(f * 10) / 10);
    }

    const body = { t0, hours, defaultT0, rating, size, water, waterFc,
                   bandColors: SURF_BAND_COLORS, bandLabels: SURF_BAND_LABELS,
                   sizeColors, sizeLabels };
    surfHistCache = { at: Date.now(), body };
    res.json(body);
  } catch (_) {
    res.status(502).json({ error: 'could not read surf history' });
  }
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
// /api/day-stream clients: told, with a bodiless `nutrition` or `workout` frame, when that day may have
// changed. Every path that can change one already dirties its day cache, so that is where they fire.
const dayClients = new Set();
function pushDay(kind) {
  for (const c of dayClients) { try { c.write(`event: ${kind}\ndata: {}\n\n`); } catch {} }
}
const dirtyWorkoutDay = () => { workoutDayCache.clear(); pushDay('workout'); };
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
    const consumed = {}, goal = {}, staged = {};
    for (const k of KEYS) { consumed[k] = m[k]?.consumed ?? 0; goal[k] = m[k]?.goal ?? 0; staged[k] = m[k]?.staged ?? 0; }

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
      const f = pace.computePace({ consumed, goal, staged, window: P.window, nowOff: (P.nowOff ?? 0) + t });
      const macros = {};
      for (const k of KEYS) {
        const x = f.macros[k];
        macros[k] = {
          consumed: x.consumed, goal: x.goal, dev_g: x.dev_g,
          ring_base: x.ring_base, ring_over: x.ring_over,
          base_color: x.base_color, over_color: x.over_color,
          staged_mark: x.staged_mark,
          // Matches the card's own rule for the number under the glyph (cards/nutrition.js tickRings).
          dev_color: x.dev_g < 0 ? '#f87171' : x.dev_g > 0 ? (x.over_color || '#22c55e') : '#22c55e',
        };
      }
      frames.push({ t, frac: f.frac, macros });
    }
    // The health bar that sits with the rings on the wall (cards/score.js): one gauge split three
    // ways — nutrition, training, tasks — since overall = (n + t + k)/3, so each can fill at most a
    // third and together they reach the overall figure. Sent as the already-divided fills the bar
    // draws, rather than raw percentages, so the widget doesn't re-derive the weighting and drift
    // from the wall.
    const sc = st.score || {};
    const third = (v) => Math.max(0, Math.min(100 / 3, (Number(v) || 0) / 3));
    res.json({
      step_min: STEP_MIN,
      // Constant for the day, so it rides once on the response rather than on all 61 frames.
      window_hours: P.window_hours, per_hour: P.per_hour,
      score: { nutrition: third(sc.nutrition?.pct), training: third(sc.training?.pct),
               tasks: third(sc.tasks?.pct),
               overall: Math.max(0, Math.min(100, Number(sc.overall) || 0)) },
      frames,
    });
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});

async function workoutDay(date) {
    const hit = workoutDayCache.get(date);
    if (hit && Date.now() - hit.at < WORKOUTDAY_BACKSTOP_MS) return hit.body;
    const rows = await sbRange(`sets?occurred_at=gte.${date}T00:00:00&occurred_at=lte.${date}T23:59:59&select=id,occurred_at,exercise,weight_lbs,reps&order=occurred_at`);
    const order = [], byEx = {}, lastAt = {};
    for (const r of rows) {
      if (!byEx[r.exercise]) { byEx[r.exercise] = []; order.push(r.exercise); }
      byEx[r.exercise].push({ id: r.id, weight_lbs: r.weight_lbs, reps: r.reps });
      lastAt[r.exercise] = r.occurred_at;   // rows are in time order, so this ends on the exercise's last set
    }
    // Which exercise was logged LAST, by the clock — not the group that appears last, which is the
    // one whose FIRST set came latest. Going back to an earlier exercise for another set has to move
    // this, or the wall shows the wrong grouping for the set that just happened.
    const recent = rows.length ? rows[rows.length - 1].exercise : null;
    const body = { date, total: rows.length, recent, exercises: order.map((n) => ({ name: n, sets: byEx[n], last_at: lastAt[n] })) };
    workoutDayCache.set(date, { body, at: Date.now() });
    return body;
}
app.get('/api/workout-day', async (req, res) => {
  try {
    const date = String(req.query.date || '').slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: 'bad date' });
    res.json(await workoutDay(date));
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});

// Compact feed for the watch's workout page: the inputs to the home wall's rest/session clocks and set
// tally, and EVERY exercise logged today, each with its muscles' WEEKLY sets in that muscle's volume
// colour (the wall's `data-recent` row, muscle.js exerciseVolumeChips). Newest first by each
// exercise's last set, so the one a set just went onto is at the top and the rest scroll below it.
// buildStatus() has all of it, but as the whole dashboard.
app.get('/api/workout-now', async (req, res) => {
  try {
    const st = await buildStatus();
    const day = await workoutDay(st.today);
    const V = st.volume || {}, ix = {};
    for (const g of V.groups || []) for (const m of g.muscles) ix[m.muscle] = m;
    const muscles = (name) => ((V.exercise_muscles || {})[name] || []).filter((e) => ix[e.muscle]).map((e) => ({
      label: ix[e.muscle].label, sets: ix[e.muscle].sets, color: ix[e.muscle].color, primary: e.contribution >= 1,
    }));
    const exercises = (day.exercises || []).slice()
      .sort((a, b) => String(b.last_at).localeCompare(String(a.last_at)))
      .map((ex) => ({ name: ex.name, sets: ex.sets.map((x) => ({ weight_lbs: x.weight_lbs, reps: x.reps })),
                      muscles: muscles(ex.name) }));
    res.json({
      last_set_at: st.last_set_at, session_start_at: st.session_start_at, sets_today: st.sets_today, exercises,
    });
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});

// ---- heat-grid history, for the phone's expanded sheet ----
// The status frame carries a fixed HEAT_WEEKS window because it is re-pushed on every realtime
// event, and history only grows — so everything older is fetched once, on demand, by the one surface
// that can scroll back through it.
//
// This returns the older PREFIX, not the whole grid: the client draws it in front of the live window
// it already has, which keeps that window authoritative. Today's cell and any edit still arrive on
// the frame as they always did, with no cell-by-cell merging to get wrong.
//
// `join_month` is the label the live window's FIRST column takes once a prefix sits in front of it.
// It is only ever different from the one on the frame: months label a column when the month changes
// from the column to its left, and on the frame that column has nothing to its left.
const heatHistCache = { body: null, at: 0 };
const HEATHIST_BACKSTOP_MS = 15 * 60 * 1000;
const dirtyHeatHistory = () => { heatHistCache.body = null; };

// Week columns from the one containing `first` through the one containing `today`, Sunday-aligned
// exactly as the builders align them.
function weeksSpanning(first, today) {
  if (!first || first > today) return 0;
  const sunday = (ds) => { const d = new Date(ds + 'T12:00:00Z'); return d.getTime() - d.getUTCDay() * 86400000; };
  return Math.round((sunday(today) - sunday(first)) / (7 * 86400000)) + 1;
}
// Split a full-span grid into what the frame does NOT carry. Empty when the whole history already
// fits inside the window, which is the nutrition calendar's case today.
function heatPrefix(full) {
  const extra = full.weeks.length - HEAT_WEEKS;
  if (extra <= 0) return { weeks: [], months: [], join_month: null };
  return { weeks: full.weeks.slice(0, extra), months: full.months.slice(0, extra), join_month: full.months[extra] };
}

app.get('/api/heat-history', async (req, res) => {
  try {
    if (heatHistCache.body && Date.now() - heatHistCache.at < HEATHIST_BACKSTOP_MS) return res.json(heatHistCache.body);
    const today = nutritionWindow().day;
    const [firstSet, firstNut] = await Promise.all([
      sb('sets?select=occurred_at&order=occurred_at.asc&limit=1'),
      sb('nutrition_entries?staged=eq.false&select=occurred_at&order=occurred_at.asc&limit=1'),
    ]);
    const setWeeks = weeksSpanning(firstSet[0] && dayBucketOf(firstSet[0].occurred_at), today);
    const nutWeeks = weeksSpanning(firstNut[0] && dayBucketOf(firstNut[0].occurred_at), today);

    // Nothing older than the window on either map — say so without reading a row of history.
    const empty = { weeks: [], months: [], join_month: null };
    if (setWeeks <= HEAT_WEEKS && nutWeeks <= HEAT_WEEKS) {
      const body = { today, window_weeks: HEAT_WEEKS, heatmap: empty, nutrition_log: empty };
      heatHistCache.body = body; heatHistCache.at = Date.now();
      return res.json(body);
    }

    // The nutrition calendar's colour is intake against that day's GOAL, which is maintenance-derived
    // and phase-aware. Those numbers come off buildStatus() rather than being recomputed here, so a
    // day cannot be one colour on the card and another in the expanded view.
    const st = nutWeeks > HEAT_WEEKS ? await buildStatus() : null;
    const [setRows, nutRows, weightRows, targetRows] = await Promise.all([
      setWeeks > HEAT_WEEKS ? sbRange('sets?select=occurred_at&order=occurred_at') : [],
      st ? sbRange('nutrition_entries?staged=eq.false&select=occurred_at,calories,protein_g,fat_g&order=occurred_at') : [],
      st ? sb('weight_log?select=date,weight_lbs&order=date.asc') : [],
      st ? sb('nutrition_targets?select=date,calories&order=date.asc') : [],
    ]);

    const heatmap = setWeeks > HEAT_WEEKS ? heatPrefix(buildWorkoutHeatmap(setRows, setWeeks, today)) : empty;
    let nutrition_log = empty;
    if (st) {
      const weights = (weightRows || []).map((r) => ({ date: String(r.date).slice(0, 10), weight: Number(r.weight_lbs) }));
      nutrition_log = heatPrefix(buildNutritionLog(nutRows, weights, st.maintenance.target, st.maintenance.maintenance,
        today, targetRows || [], nutWeeks, await surplusCal(), 150, st.pace.fraction));
    }
    const body = { today, window_weeks: HEAT_WEEKS, heatmap, nutrition_log };
    heatHistCache.body = body; heatHistCache.at = Date.now();
    res.json(body);
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});

// ---- app settings (voice routing mode + per-device trailing-silence). Read by the worker + devices;
// edited from the hub settings panel. Returns/accepts a flat {key: value} map. ----
// Settings a browser has no use for. `voiceprint` is a 24KB base64 exemplar bank for speaker ID: the
// voice pipeline reads it from app_settings directly with the service key and it has never been read
// by any client here, but it was 92% of this response, fetched twice on every cold load.
const SETTINGS_SERVER_ONLY = new Set(['voiceprint']);
app.get('/api/settings', async (req, res) => {
  try {
    const all = await settingsAll();   // realtime-invalidated cache — see settingsAll()
    res.json(Object.fromEntries(Object.entries(all).filter(([k]) => !SETTINGS_SERVER_ONLY.has(k))));
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});
// TEMPORARY. The voice button's stop tap misbehaves only on his phone, so the phone reports what it
// actually saw — every pointer event and every state change — into this log. Read it with
// `fly logs -a jared-status-hub | grep tap`. Delete this route and its caller once that is understood.
app.post('/api/tapdebug', express.json({ limit: '8kb' }), (req, res) => {
  const ua = String(req.headers['user-agent'] || '');
  const surface = ua.includes('StatusHub') ? 'app' : /iPhone|iPad/.test(ua) ? 'ios-safari' : 'other';
  console.log('[tap]', surface, JSON.stringify(req.body));
  res.json({ ok: true });
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
const dirtyNutDay = () => { nutDayCache.clear(); pushDay('nutrition'); };
app.get('/api/nutrition-day', async (req, res) => {
  try {
    // date=today lets a client that has no 4am-origin day of its own (the watch) ask for the current one.
    const asked = String(req.query.date || '').slice(0, 10);
    const date = asked === 'today' ? nutritionWindow().day : asked;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: 'bad date' });
    const cacheKey = date + '|' + nutritionWindow().day;   // window day flips at 4am → isToday changes
    const hit = nutDayCache.get(cacheKey);
    if (hit && Date.now() - hit.at < NUTDAY_BACKSTOP_MS) return res.json(hit.body);
    const hh = String(DAY_START_HOUR).padStart(2, '0');
    const next = localDate(new Date(Date.parse(date + 'T12:00:00Z') + 86400000));
    const isToday = date === nutritionWindow().day;
    const SEL = 'id,occurred_at,name,calories,protein_g,carbs_g,fat_g,ingredients,staged,logged';
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
    // The most recent ADDITION to the log, staged or eaten — what the home wall's recent line shows.
    // Ordered by `logged` (when the row was written) rather than occurred_at: a staged meal's
    // occurred_at is the moment it was staged and means nothing about when it will be eaten, and a
    // meal logged now for this morning would otherwise never be the newest thing. Both columns are
    // naive-local strings in the same format, so they sort as text.
    const addedAt = (e) => String(e.logged || e.occurred_at || '').slice(0, 19);
    const recent = entries.length
      ? entries.reduce((a, e) => (addedAt(e) > addedAt(a) ? e : a))
      : null;
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
      entries, recent,
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
// app_settings.agent_mode is stored as text; these are the values that mean "on".
const agentModeOn = (v) => ['1', 'true', 'on', 'yes'].includes(String(v ?? '0').toLowerCase());
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
  const ka = setInterval(() => { try { res.write(PING); } catch {} }, 25000);
  req.on('close', () => { clearInterval(ka); sseClients.delete(res); });
});

// Backfill recent voice_messages for a focus so the panel populates on load before live updates
// arrive. We want the MOST RECENT `limit` turns — so fetch newest-first then reverse to oldest→newest
// (the render order). The old asc+limit returned the OLDEST 50, hiding the recent thread. focus='hub'.
app.get('/api/voice-messages', async (req, res) => {
  try {
    const focus = String(req.query.focus || 'hub');
    // mode=active resolves to whichever mode agent_mode selects — the watch has no settings frame to
    // read it from, and asking it to fetch one would put that rule in a second place.
    const want = String(req.query.mode || 'hub');
    const mode = want === 'active' ? (agentModeOn((await settingsAll()).agent_mode) ? 'agent' : 'hub')
      : want === 'agent' ? 'agent' : 'hub';
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

// De-dupe resent sends: the durable outboxes (photos, and every voice clip) re-POST when a screen-lock
// or a dropped connection killed the ack after the server had already enqueued. A client_msg_id turns
// that retry into a no-op instead of a duplicate command. In-memory suffices — the hub runs a single
// instance and the retry window is seconds to minutes; the map is bounded so it can't grow without limit.
const seenMsgIds = new Map();   // client_msg_id -> the voice_requests id it enqueued (null if none returned)
function markSeen(msgId, requestId = null) {
  if (!msgId) return;
  seenMsgIds.set(msgId, requestId);
  if (seenMsgIds.size > 1000) seenMsgIds.delete(seenMsgIds.keys().next().value);
}

// In-app voice button: the browser/app uploads a recorded clip; we transcribe it with the SAME
// Groq Whisper the ESP uses, then enqueue into voice_requests exactly like the Jarvis path. The
// Mac worker claims it and writes the user+assistant turns into voice_messages (focus 'hub') —
// the one shared conversation shown on the TV wall and in the app.
//
// There is NO size or length limit on a command. The body streams to a temp file rather than into
// memory (a long uncompressed phone clip would not fit in this 256 MB machine), and lib/transcribe.js
// re-encodes and splits anything too big for Groq. The file is deleted as soon as the request ends.
app.post('/api/voice-command', async (req, res) => {
  const tmp = path.join(os.tmpdir(), 'voice-' + crypto.randomUUID());
  try {
    if (!GROQ_API_KEY) { req.resume(); return res.status(503).json({ error: 'transcription not configured' }); }
    // ?dry=1 → transcribe only, no enqueue. The chat composer uses this while photos are pending: the
    // transcript lands in the text box so the user sends text + photos together when they're ready.
    const dry = String(req.query.dry || '') === '1';
    const msgId = String(req.query.client_msg_id || '').slice(0, 64);
    if (!dry && msgId && seenMsgIds.has(msgId)) { req.resume(); return res.json({ enqueued: true, duplicate: true }); }
    await pipeline(req, fs.createWriteStream(tmp));
    const { size } = await fs.promises.stat(tmp);
    if (!size) return res.status(400).json({ error: 'no audio' });
    const ct = String(req.headers['content-type'] || 'audio/webm');
    const { transcript, segments } = await transcribe(tmp, ct, GROQ_API_KEY);
    // Bytes per second of speech is what decides whether a clip fits Groq's cap, and it is set by the
    // recording device, not by us — so every clip reports it.
    const dur = parseFloat(req.query.dur);
    console.log(`[voice-command] ${size} bytes ${ct}` +
      (dur > 0 ? ` ${dur.toFixed(1)}s ${Math.round(size * 8 / dur / 1000)} kbps` : '') +
      (segments ? ` re-encoded into ${segments} segment(s)` : ''));
    if (!transcript) return res.json({ transcript: '', enqueued: false });
    if (dry) return res.json({ transcript, enqueued: false });
    // The bottom-right quick-add FAB sends ?quick=1 → tag the request so the worker asks Jarvis for a
    // terse, fits-in-the-status-chip confirmation. The full conversation card omits it (verbose replies).
    const quick = String(req.query.quick || '') === '1';
    const client_now = CLIENT_NOW_RE.test(String(req.query.client_now || '')) ? String(req.query.client_now) : null;
    await sbWrite('voice_requests', 'POST', { transcript, source: quick ? 'web-quick' : 'web', focus: 'hub',
      ...(client_now ? { client_now } : {}) });
    markSeen(msgId);
    res.json({ transcript, enqueued: true });
  } catch (e) {
    res.status(e.status || 500).json({ error: String(e.message || e) });
  } finally {
    fs.promises.unlink(tmp).catch(() => {});
  }
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
// A client_msg_id de-dupes a resent send (see seenMsgIds above /api/voice-command).
app.post('/api/voice-text', express.json(), async (req, res) => {
  try {
    const text = String((req.body && req.body.text) || '').trim();
    const attachments = Array.isArray(req.body && req.body.attachments)
      ? req.body.attachments.map(String).filter(attName).slice(0, 12) : [];
    if (!text && !attachments.length) return res.status(400).json({ error: 'empty' });
    const msgId = String((req.body && req.body.client_msg_id) || '').slice(0, 64);
    if (msgId && seenMsgIds.has(msgId)) return res.json({ enqueued: true, duplicate: true, id: seenMsgIds.get(msgId) });
    const client_now = CLIENT_NOW_RE.test(String((req.body && req.body.client_now) || '')) ? String(req.body.client_now) : null;
    const id = crypto.randomUUID();   // chosen here so the caller can wait on it (/api/voice-reply/:id)
    await sbWrite('voice_requests', 'POST', { id, transcript: text, source: 'web', focus: 'hub',
      ...(attachments.length ? { attachments } : {}), ...(client_now ? { client_now } : {}) });
    markSeen(msgId, id);
    res.json({ enqueued: true, id });
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});

// Wait for one command to finish: held open until voice_requests row :id is done or error, then
// answered with its outcome. The watch sends with /api/voice-text and waits here rather than
// polling. Settled by the voice_requests realtime subscription; the read on entry covers a row that
// finished before the wait began, and the waiter is registered BEFORE that read so a finish landing
// between the two cannot be missed. A wait that runs out answers `pending` and the client asks
// again — REPLY_WAIT_MS is only a bound on one HTTP request, kept under Fly's proxy idle timeout.
const REPLY_WAIT_MS = 25000;
const replyWaiters = new Map();   // request id -> Set of settle fns
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function settleReply(row) {
  if (!row || (row.status !== 'done' && row.status !== 'error')) return;
  const waiting = replyWaiters.get(row.id);
  if (waiting) for (const settle of [...waiting]) settle(row);
}
app.get('/api/voice-reply/:id', async (req, res) => {
  const id = String(req.params.id);
  if (!UUID_RE.test(id)) return res.status(400).json({ error: 'bad id' });
  let waiting = replyWaiters.get(id);
  if (!waiting) replyWaiters.set(id, (waiting = new Set()));
  let over = false;
  const finish = (send) => {
    if (over) return;
    over = true;
    clearTimeout(timer);
    waiting.delete(settle);
    if (!waiting.size && replyWaiters.get(id) === waiting) replyWaiters.delete(id);
    send();
  };
  const settle = (row) => finish(() => res.json({ status: row.status, result: row.result ?? null, error: row.error ?? null }));
  waiting.add(settle);
  const timer = setTimeout(() => finish(() => res.json({ status: 'pending' })), REPLY_WAIT_MS);
  req.on('close', () => finish(() => {}));
  try {
    const rows = await sb(`voice_requests?id=eq.${id}&select=id,status,result,error`);
    if (!rows || !rows.length) return finish(() => res.status(404).json({ error: 'no such request' }));
    settleReply(rows[0]);
  } catch (e) {
    finish(() => res.status(500).json({ error: String(e.message || e) }));
  }
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
// Live session activity, pushed by the orchestrator on BOTH machines the moment a transcript grows.
// The same shape as /api/voice-activity and for the same reason: the machine running the work knows
// what it is doing, so it says so, rather than the hub asking on a timer. Nothing here is stored —
// the orchestrator writes `last_reply` to Supabase separately, for durability, off this path.
//
//   state 'tool'  — a tool call, `text` is its one-line description
//   state 'done'  — the turn finished, `text` is the reply (truncated for the row it lands on)
app.post('/api/session-activity', express.json(), (req, res) => {
  const b = req.body || {};
  const session = String(b.session || '');
  if (!session) return res.status(400).json({ error: 'session required' });
  pushSession({
    session,
    state: b.state === 'done' ? 'done' : 'tool',
    text: String(b.text || '').slice(0, 400),
  });
  res.status(204).end();
});

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
    const rows = await sb('list_items?deleted=eq.false&completed_at=is.null&due=not.is.null&select=due,scheduled_at,priority');
    const nowET = etNowString();
    // Exempt items (a shift, an appointment) owe nothing, so they can never be overdue and must
    // never badge — a red count he cannot clear by doing anything is just noise.
    return rows.filter((r) => (r.priority || 0) >= 0 && dueMoment(r.scheduled_at || r.due) <= nowET).length;
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

// ---- lists surface. Voice/MCP writes them; this is the visual pane. ----
//
// `due` is sent as a normal field on every item, and `due` collects the dated ones from ALL lists
// into one soonest-first view. That view is what used to be the reminders table — it is now derived,
// not stored, so an item appears in it and on its own list at once without being duplicated.
// How hard an overdue row should read: 0 not overdue, then escalating. The health bar cannot carry
// this on its own — the gold band floors at zero, so once it is pinned there a second neglected item
// looks identical to the first. The bar shows what has been earned; the row shows what is owed.
// Computed here rather than in the cards because three surfaces draw these rows and a rule they each
// re-derive is a rule they will eventually disagree about.
function overdueHeat(item, nowLocal) {
  const st = chipState(item, nowLocal);
  if (st === 'upcoming') return 0;
  if (st === 'grace') return 1;                    // due, but still free — warm, not hot
  const at = dueMoment(item.scheduled_at || item.due);
  const hrs = (Date.parse(nowLocal.replace(' ', 'T') + 'Z') - Date.parse(at.replace(' ', 'T') + 'Z')) / 3600000;
  return hrs >= 72 ? 4 : hrs >= 24 ? 3 : 2;
}

app.get('/api/todos', async (req, res) => {
  try {
    const [listNames, items] = await Promise.all([
      sb('lists?select=id,name,emoji&order=name'),
      sb('list_items?deleted=eq.false&completed_at=is.null&select=id,list_id,list_name,text,title,due,scheduled_at,priority,series_id&order=created.asc'),
    ]);
    const all = items || [];
    // Grouped by `list_id`, and the id is sent on so the composer can post it back. `list_name` is a
    // derived copy (data-layer 00094) — fine to display, never the thing to match or write on.
    const lists = (listNames || []).map((l) => ({ id: l.id, name: l.name, emoji: l.emoji, items: all.filter((i) => i.list_id === l.id) }));
    // Longest outstanding first, then upcoming.
    const nowET = etNowString();
    const due = all.filter((i) => i.due)
      .map((i) => ({ ...i, expired: dueMoment(i.scheduled_at || i.due) <= nowET, heat: overdueHeat(i, nowET) }))
      .sort((a, b) => dueMoment(a.scheduled_at || a.due) < dueMoment(b.scheduled_at || b.due) ? -1 : 1);
    res.json({ lists, due });
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});
// Compact feed for the iOS to-do widget. Deliberately NOT /api/todos: that one carries every list
// and the full body of every item, and the widget draws one list's item titles.
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
      sb('list_items?deleted=eq.false&completed_at=is.null&due=not.is.null&select=id,list_name,text,title,due,scheduled_at,priority,series_id&order=scheduled_at.asc'),
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
      expired: dueMoment(r.scheduled_at || r.due) <= nowET,
      heat: overdueHeat(r, nowET),
      priority: r.priority || 0,
      when: r.scheduled_at || r.due,
      repeating: !!r.series_id,
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
    const rows = await sb(`list_items?deleted=eq.false&completed_at=is.null&list_name=eq.${encodeURIComponent(name)}` +
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

// ---- calendar: a month of dated items as a finished grid, for /calendar and the calendar wall ----
//
// The whole grid is computed HERE — week rows, day cells, per-item chip colors, time labels — and the
// client only paints it. Read-only by design: writes stay with voice/MCP and the todo pane, which is
// what keeps this away from the reminder dedupe key and the scheduled_at anchor entirely.
//
// Only the FUTURE is dense: clearing an item is a soft delete (purged after 30 days) and a repeater
// stores only its next `due`, so past days are naturally sparse. That matches what the surface is
// for — what's coming — and is why there is no attempt at a history view here.
//
// Chip colors are hashed from the list name, not assigned by row order, so a list keeps its color
// when lists are added or removed. Collisions are possible and acceptable at this list count.
const CAL_COLORS = ['#e5484d', '#f76b15', '#ffb224', '#46a758', '#12a594',
                    '#0091ff', '#6e56cf', '#d6409f', '#b0e64c', '#00b8d9'];
// A list can also be PINNED to a colour, which then wins over the hash. The hash exists so nobody
// has to choose, not to stop anyone choosing — and `todo` carries most of what is ever on a day, so
// it is the one worth naming. Keyed lowercase; the hash still covers everything else.
const CAL_COLOR_PINNED = { todo: '#ffd60a' };
function listColor(name) {
  const pinned = CAL_COLOR_PINNED[String(name || '').toLowerCase()];
  if (pinned) return pinned;
  let h = 5381;
  for (const c of String(name || '')) h = ((h * 33) ^ c.charCodeAt(0)) >>> 0;
  return CAL_COLORS[h % CAL_COLORS.length];
}
// '...THH:MM' → '9a' / '3:30p'; date-only → null (an all-day chip). Same compaction as the todo
// pane's fmtDue, minus the date half.
function calTimeLabel(occ) {
  const m = String(occ).match(/T(\d{2}):(\d{2})/);
  if (!m) return null;
  const h = +m[1]; const mm = m[2]; const h12 = h % 12 || 12;
  return `${h12}${mm === '00' ? '' : ':' + mm}${h < 12 ? 'a' : 'p'}`;
}
// Add minutes to a local-naive stamp WITHOUT going near a timezone. Date.parse of a naive string
// treats it as UTC, and formatting the result back through etStringAt then applies the display zone
// on top — a double conversion that moved a 13:59 deadline to 10:29. UTC getters over naive
// components is the same trick the month math uses: no zone is ever applied, so nothing can shift.
function plusMinutes(naiveLocal, mins) {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?/.exec(String(naiveLocal || ''));
  if (!m) return naiveLocal;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0)) + mins * 60000);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`
       + `T${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
}

// due -> grace (still on time, costs nothing) -> expired (draining). One place, so the calendar and
// the pane cannot disagree about when something starts costing.
function chipState(item, nowLocal) {
  const at = dueMoment(item.scheduled_at || item.due);
  if (!at || at > nowLocal) return 'upcoming';
  return plusMinutes(at, TASK_GRACE_MIN) > nowLocal ? 'grace' : 'expired';
}

// How far ahead to look for the next change in a chip's NUMBER. Past four hours late an item is in
// the slow half of its drain, where the figure moves by a tenth every couple of hours; probing
// further buys a re-read nothing else would have missed. Every day column re-reads on its own well
// inside this — the dial when the hour rolls, the others when the now-line leaves the rendered range.
const SCORE_LOOKAHEAD_MIN = 6 * 60;

// The client's clock is minute-precision ('YYYY-MM-DDTHH:MM', see cards/dayline.js `stamp`) and it
// compares these as strings, so a stamp carrying seconds is one it cannot match until the minute
// AFTER the one meant — which is why grace used to end a minute late while the due moment, having no
// seconds on it, landed on time. Cutting every candidate to the minute makes them all exact.
const toMinute = (s) => (s ? String(s).slice(0, 16) : s);

/**
 * When this item's chip would show a DIFFERENT NUMBER, or null if not within the lookahead.
 *
 * Everything else about a chip changes in steps whose moments are known — it comes due, it leaves
 * grace, it expires. The number does not. From the end of grace it slides continuously, and it is
 * the one thing on the chip that claims to describe THIS moment: complete it now and get this. So
 * it was the one thing with no transition of its own, and it was only ever re-read when something
 * unrelated forced a re-read. On the wall that meant the hour boundary, which is how a task thirty
 * minutes past its grace still offered the full +1.0 that completing it would no longer have earned.
 *
 * Found by asking `scoreFields` rather than by inverting it. Within each regime the rendered value
 * moves one way only, and the two regimes disagree in both sign and kind, so "renders what it
 * renders now" is true up to some moment and false from there on — which is exactly what makes a
 * binary search over the minute exact rather than approximate. Inverting the curve instead would put
 * a second copy of it here, to drift from the first the next time the tuning block is touched.
 */
function nextScoreChange(item, nowLocal) {
  const shownAt = (mins) => JSON.stringify(scoreFields(item, plusMinutes(nowLocal, mins)));
  const now = shownAt(0);
  if (shownAt(SCORE_LOOKAHEAD_MIN) === now) return null;
  let lo = 0, hi = SCORE_LOOKAHEAD_MIN;          // invariant: shownAt(lo) === now, shownAt(hi) !== now
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (shownAt(mid) === now) lo = mid; else hi = mid;
  }
  return toMinute(plusMinutes(nowLocal, hi));
}

// When the next chip changes, so a wall can re-read exactly then instead of polling. Without it
// nothing re-renders as time passes: the minute tick only moves the now-line, so an item would
// silently go overdue and keep its old colour until some unrelated edit touched the lists.
function nextChipTransition(rows, nowLocal) {
  let next = null;
  const consider = (m) => { if (m && m > nowLocal && (next === null || m < next)) next = m; };
  for (const r of rows || []) {
    if (r.completed_at) continue;                // a finished item's chip is settled; nothing moves
    const at = dueMoment(r.scheduled_at || r.due);
    if (!at) continue;
    consider(toMinute(at));                      // it comes due
    consider(toMinute(plusMinutes(at, TASK_GRACE_MIN)));   // it stops being free
    consider(nextScoreChange(r, nowLocal));      // its number moves
  }
  return next;
}

// What an item is worth, as a number to put on its chip. ONE number, and its sign says which kind it
// is — which is the rule the band already follows: a negative has always already happened, while a
// positive is only potential until the thing is actually done.
//
//   completed            what it landed at        realised   (+1, or negative if very late)
//   overdue, <4h late    what it is still worth   POTENTIAL  (doing it now still pays)
//   overdue, >=4h        what it has cost so far  realised   (completing it can no longer pay)
//   upcoming / grace     nothing — it costs nothing yet and the full +1 is still there
//   exempt               nothing — it never scores in either direction
//
// The switch at LATE_ZERO_H is where those two swap importance: before it, "you can still get 0.86"
// is the useful fact; after it, the only useful fact is what it is taking.
//
// The overdue figure is the item's OWN accrued cost at its rate, which is what the bar moves by too
// unless the band has bottomed out — an hour that would take the level below zero is never charged,
// so at zero the figure keeps climbing while the bar cannot fall. An item pinning the band at zero
// is still costing him everything he earns, so its own rate stays the truer statement of what it is
// doing.
function chipScore(item, nowLocal, state) {
  const mult = 1 + Math.max(0, Number(item.priority) || 0);
  if ((item.priority || 0) < 0) return null;                       // exempt
  const deadline = taskDeadline(item.scheduled_at || item.due);
  if (deadline == null) return null;
  const ms = (stamp) => Date.parse(String(stamp).replace(' ', 'T') + 'Z');
  // A COMPLETED item is what finishing paid MINUS every hour it sat before that. Those are different
  // things and the chip has to be their sum, because the sum is what the item did to the band: an
  // on-time completion is a clean +7, and one finished three days late is roughly −21 however
  // promptly it was eventually ticked off. Showing only what finishing paid would print "+0" over an
  // item that cost twenty points.
  //
  // Only the first half goes through toPoints(). The drain accrues by the hour and is a continuous
  // quantity, so a chip carrying one is a rounded reading rather than the exact credit — true of the
  // 'lost' branch already. An item completed inside its grace has no drain at all, and there the
  // integer is still exactly what the bar moved by.
  if (item.completed_at) {
    const done = ms(item.completed_at);
    const paid = toPoints(completionValue(done - deadline) * mult);
    const sat = Math.max(0, done - (deadline + TASK_GRACE_MIN * 60000));
    return { value: paid - (sat / (TASK_DRAIN_FULL_H * 3600000)) * toPoints(mult), kind: 'earned' };
  }
  if (state !== 'expired') return null;                            // upcoming or still in grace
  const late = ms(nowLocal) - deadline;
  if (late < TASK_LATE_ZERO_H * 3600000) {
    return { value: toPoints(completionValue(late) * mult), kind: 'potential' };
  }
  // Accrued cost, at the same quantised rate the replay bills it at. Not itself a whole point: the
  // drain accrues by the hour, so this is a readout of something still moving. It keeps climbing
  // while the item sits, and completing the item stops it rather than clearing it.
  const draining = late - TASK_GRACE_MIN * 60000;
  return { value: -(draining / (TASK_DRAIN_FULL_H * 3600000)) * toPoints(mult), kind: 'lost' };
}

// Two chips to a half-hour line, each at a fixed half width whether or not there is a second one.
// Letting a lone chip stretch made the line's shape depend on how busy it happened to be, so a
// glance could not tell one item from two without reading it. A fixed grid reads at a distance.
// Anything past the cap becomes a count, so a hidden item is still visible AS hidden.
const DAYLINE_MAX_PER_HALF = 2;
const dayHalf = (items) => ({
  items: items.slice(0, DAYLINE_MAX_PER_HALF),
  more: Math.max(0, items.length - DAYLINE_MAX_PER_HALF),
});

// A look-ahead day's box holds this many chips, and the rest become its +N. Decided here rather than
// in the wall for the same reason the half-line's cap is: the box is a sixth of a column of known
// height, so how many chips fit is a fixed number, and two surfaces working it out separately is two
// surfaces that will eventually disagree about which item was the one dropped.
//
// HOW A LOOK-AHEAD DAY'S BOX IS LAID OUT. The box is a sixth of a column of known height, so this is
// geometry and it is decided here, the way the month grid's `cols` is — a client working it out
// separately is a client that will eventually disagree about which item got dropped.
//
// The box holds a grid of `rows × cols` chips, each row an equal share of its height, so the chips
// grow and shrink to FILL it rather than sitting at a fixed size above a spare strip. Two steps,
// and the reason there are only two:
//
//   1-4 items    4 rows, one column   — four filling the box is the CEILING. Nothing is bigger than
//                                       that however empty the day, or one item alone is a banner.
//   5-6 items    n rows, one column   — shrink rather than drop one, down to ~12px at six.
//   7-10 items   2 columns, ceil(n/2) rows, text capped at the five-row size — read across then
//                                       down, the way text is. Titles truncate; nothing else fits.
//
// WHY THE SECOND COLUMN STARTS AT SEVEN and not at six. A six-item day in one column holds every
// title WHOLE and fills the box; in two it holds four characters of each and leaves two rows empty,
// because six items need three rows of two and the chips cannot grow into the other two — an 85px
// chip has no use for 28px of text. Two truncated columns above a gap is worse than one full
// column, so the split waits until one column would be under ~12px, which is at seven.
//
// Ten is the cap; the rest become the day's +N.
const LOOKAHEAD_ROWS = 5;                 // rows at the small end of a single column
const LOOKAHEAD_ROWS_MIN = 4;             // the ceiling: chips never larger than four filling the box
const LOOKAHEAD_ONE_COL_MAX = 6;          // most a single column can hold and still show a title
const LOOKAHEAD_MAX_PER_DAY = LOOKAHEAD_ROWS * 2;

// The grid one day's chips are laid out in — geometry, so it is decided here.
function aheadGrid(n) {
  const cols = n > LOOKAHEAD_ONE_COL_MAX ? 2 : 1;
  return {
    cols,
    rows: cols === 2 ? Math.min(LOOKAHEAD_ROWS, Math.ceil(n / cols))
                     : Math.max(LOOKAHEAD_ROWS_MIN, n),
  };
}

// The occurrences of one item falling inside [startKey, endKey] (inclusive 'YYYY-MM-DD' bounds) —
// which is now at most one, its own `due`. A recurring thing is materialised as an independent row
// per occurrence (data-layer migration 00085), so the grid reads real rows rather than projecting
// future ones from a repeat rule. That is what lets a chip on a future day be tapped, cleared, or
// scored: a projection was a drawing of an item that did not exist yet.
// Rendered here, not in the cards: three surfaces draw these chips and a format they each re-derive
// is a format they will eventually disagree about.
// The number is in the band's POINTS, not its internal units — the gold band is 100 points and this
// says how many of them the item is worth, so it is the same scale the bar is read on and needs no
// suffix to say so. It is whole because the SCORING is whole: a completion is quantised to a point
// by toPoints() before it is admitted, so this rounds nothing on the earned and potential branches
// and the integer here is exactly what the bar moves by. Only the drain readout is a rounding, and
// only because a drain is a continuous thing with no moment of landing. Anything under half a point
// is not rendered at all, since a `+0` chip is worse than no chip.
function scoreFields(item, nowLocal) {
  const sc = chipScore(item, nowLocal, chipState(item, nowLocal));
  if (!sc) return {};
  const n = Math.round(Math.abs(bandPoints(sc.value)));
  if (n < 1) return {};
  // Sign rides separately so the clients colour on it without parsing the string back apart.
  return { score: (sc.value > 0 ? '+' : '\u2212') + n, score_kind: sc.kind,
           score_sign: sc.value > 0 ? 'pos' : 'neg' };
}

function calOccurrences(item, startKey, endKey) {
  const day = String(item.due).slice(0, 10);
  return day >= startKey && day <= endKey ? [item.due] : [];
}
// Two callers, one endpoint. The PHONE page pages one month at a time (?month=YYYY-MM). The WALL
// (?wall=1) instead gets `calendar_months` months from the current one — the count is an
// app_settings key so voice can resize the view ("show the full year") the same way it switches
// walls — plus `dayline`, the server-laid-out timeline of today for the wall's day column.
app.get('/api/calendar', async (req, res) => {
  try {
    const nowET = etNowString();
    const todayKey = nowET.slice(0, 10);
    const wall = req.query.wall === '1';
    // The phone's day card wants the timeline and nothing else. Same computation — the day buckets
    // come out of the month expansion either way — but it does not ship a month of grid it will not
    // draw. One endpoint, so the two surfaces cannot disagree about a chip's state.
    const dayOnly = req.query.day === '1';
    const full = req.query.full === '1';
    let count = 1;
    if (wall) {
      let s = {};
      try { s = await settingsAll(); } catch (_) {}
      const n = Number(s.calendar_months);
      count = Number.isInteger(n) && n >= 1 && n <= 12 ? n : 1;
    }
    const startYm = wall || !/^\d{4}-(0[1-9]|1[0-2])$/.test(String(req.query.month || ''))
      ? todayKey.slice(0, 7) : String(req.query.month);
    const [y0, mo0] = startYm.split('-').map(Number);

    // All month math in UTC getters over naive components, so no zone ever shifts a wall-clock date. Each grid runs Sunday-aligned from before the 1st to after the last.
    const DAY = 86400000;
    const pad = (n) => String(n).padStart(2, '0');
    const keyOf = (ms) => { const d = new Date(ms); return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`; };
    const bounds = [];
    for (let k = 0; k < count; k++) {
      const first = Date.UTC(y0, mo0 - 1 + k, 1);
      const last = Date.UTC(y0, mo0 + k, 0);
      bounds.push({ first, gridStart: first - new Date(first).getUTCDay() * DAY, gridEnd: last + (6 - new Date(last).getUTCDay()) * DAY });
    }
    // `ahead=N` asks for the N days AFTER today as well, each with what is on it — the home wall's
    // look-ahead column. It can reach past the last month's grid, which ends on the Saturday after
    // the month's last day and so ends ON that day when the month ends on a Saturday. Widening the
    // expansion window is the whole fix: the month grids read from their own bounds, so the extra
    // day buckets cost nothing to anyone who did not ask for them.
    const aheadDays = Math.max(0, Math.min(14, Math.trunc(Number(req.query.ahead)) || 0));
    const todayMs = Date.parse(`${todayKey}T00:00:00Z`);
    // One expansion over the whole span; every month's grid then reads from the same day buckets.
    const startKey = keyOf(bounds[0].gridStart);
    const gridEndKey = keyOf(bounds[count - 1].gridEnd);
    const aheadEndKey = keyOf(todayMs + aheadDays * DAY);
    const endKey = aheadEndKey > gridEndKey ? aheadEndKey : gridEndKey;

    const [listRows, rows] = await Promise.all([
      sb('lists?select=name,emoji'),
      // The one surface that draws COMPLETED items as well as outstanding ones. Seeing a day fill in
      // with things that got done is half the point of marking them done; every other surface is a
      // list of what is left, and a finished item on it is noise.
      sb('list_items?deleted=eq.false&due=not.is.null&select=id,list_name,text,title,due,scheduled_at,priority,series_id,completed_at'),
    ]);
    const emojiOf = {};
    for (const l of listRows || []) emojiOf[l.name] = l.emoji;

    const byDay = {};
    for (const r of rows || []) {
      for (const occ of calOccurrences(r, startKey, endKey)) {
        (byDay[occ.slice(0, 10)] ??= []).push({
          _occ: occ,   // sort key only, stripped below — date-only sorts before any 'T…' same-day
          id: r.id,
          title: itemTitle(r),
          list: r.list_name,
          emoji: emojiOf[r.list_name] || null,
          color: listColor(r.list_name),
          time: calTimeLabel(occ),
          // `past`: this occurrence's moment has gone by (dims the chip). `expired`: it is overdue
          // and uncleared, which is also what is draining his score for as long as it stays that way.
          past: dueMoment(occ) <= nowET,
          // `done` means he finished a task. An exempt item closes itself when its moment passes,
          // which is not the same thing and must not read as an achievement — it just becomes past.
          done: !!r.completed_at && (r.priority || 0) >= 0,
          exempt: (r.priority || 0) < 0,
          // Three states, and they line up with what the SCORE is doing rather than with the clock
          // alone: `grace` is due-but-still-free (the 30 minutes that score as on time), `expired` is
          // past that and actively draining. Colouring them the same made a chip go red while it was
          // still costing nothing, and gave no signal at the moment the cost actually starts.
          grace: !r.completed_at && (r.priority || 0) >= 0 && chipState(r, nowET) === 'grace',
          expired: !r.completed_at && (r.priority || 0) >= 0 && chipState(r, nowET) === 'expired',
          priority: r.priority || 0,
          ...scoreFields(r, nowET),
          repeating: !!r.series_id,
        });
      }
    }
    for (const k of Object.keys(byDay)) {
      byDay[k].sort((a, b) => (a._occ < b._occ ? -1 : 1));
      for (const it of byDay[k]) delete it._occ;
    }

    const ymStr = (yy, mm) => { const d = new Date(Date.UTC(yy, mm - 1, 1)); return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}`; };
    const months = bounds.map((b, k) => {
      const ym = keyOf(b.first).slice(0, 7);
      const weeks = [];
      for (let ms = b.gridStart; ms <= b.gridEnd; ms += 7 * DAY) {
        const week = [];
        for (let i = 0; i < 7; i++) {
          const date = keyOf(ms + i * DAY);
          const d = new Date(ms + i * DAY);
          week.push({
            date,
            day: d.getUTCDate(),
            label: d.toLocaleDateString('en-US', { timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric' }),
            inMonth: date.slice(0, 7) === ym,
            today: date === todayKey,
            items: byDay[date] || [],
          });
        }
        weeks.push(week);
      }
      return {
        month: ym,
        label: new Date(b.first).toLocaleDateString('en-US', { timeZone: 'UTC', month: 'long', year: 'numeric' }),
        prev: ymStr(y0, mo0 + k - 1),
        next: ymStr(y0, mo0 + k + 1),
        weeks,
      };
    });

    // The wall's day column: today's items laid onto hour slots, with the now-line's position
    // computed here (which hour row, and how far down it). Hour range covers at least 7a–10p and
    // stretches to hold the current hour and any item outside it.
    let dayline = null;
    if (wall || dayOnly) {
      const todayItems = byDay[todayKey] || [];
      const allday = todayItems.filter((i) => !i.time);
      const timed = todayItems.filter((i) => i.time);
      const clockOf = (t) => {
        const m = String(t).match(/^(\d+)(?::(\d+))?([ap])$/);
        let h = +m[1] % 12; if (m[3] === 'p') h += 12;
        return { h, m: +(m[2] || 0) };
      };
      const nowH = +nowET.slice(11, 13); const nowM = +nowET.slice(14, 16);
      // `full` asks for a ROLLING WINDOW instead of a calendar day: WINDOW hours either side of the
      // current hour, crossing midnight in both directions. It exists for the dial, which puts now
      // at the middle of the column — a day cannot feed that, because by evening there is almost
      // nothing below the line and the whole morning is crushed above it. A window always has as
      // much on one side as the other. Only that surface asks; the calendar wall and the phone keep
      // the day they were built around.
      const WINDOW = 12;
      const dayMs = 86400000;
      const baseMs = Date.parse(`${todayKey}T00:00:00Z`);
      const loT = full ? nowH - WINDOW : Math.min(7, nowH, ...timed.map((i) => clockOf(i.time).h));
      const hiT = full ? nowH + WINDOW : Math.max(22, nowH, ...timed.map((i) => clockOf(i.time).h));
      const hours = [];
      for (let t = loT; t <= hiT; t++) {
        // `t` is hours from TODAY's midnight and may be negative or past 24. The client projects on
        // it directly, which is what lets a continuous timeline be drawn without it knowing dates.
        const dayOff = Math.floor(t / 24);
        const h = ((t % 24) + 24) % 24;
        const onDay = dayOff === 0 ? timed
          : (byDay[keyOf(baseMs + dayOff * dayMs)] || []).filter((i) => i.time);
        const inHour = onDay.filter((i) => clockOf(i.time).h === h);
        hours.push({
          t,   // position on the timeline; the dial angles every row off this
          h,   // 24h number: the wall matches the clock against this to move the now-line itself
          // Just the number. The spine runs in order from morning to night, so am/pm is never in
          // doubt, and dropping the letter is what buys the digit enough size to read across a room.
          label: String(h % 12 || 12),
          // Each hour is two lines: :00-:29 and :30-:59. The second is RESERVED for the back half of
          // the hour, so a 4:30 item sits on it even when nothing is at 4:00 — the line a chip
          // occupies is what says which half of the hour it is in, since the chips carry no time of
          // their own. Splitting the row this way also doubles capacity without making a busy hour
          // physically taller, which would misread as the day running longer than it does.
          halves: [0, 1].map((half) => dayHalf(inHour.filter((i) => (clockOf(i.time).m >= 30 ? 1 : 0) === half))),
          now: t === nowH ? Math.round((nowM / 60) * 100) : null,
        });
      }
      const todayCell = months[0].weeks.flat().find((c) => c.date === todayKey);
      dayline = { date: todayKey, label: todayCell ? todayCell.label : todayKey, allday, hours };
    }

    // THE LOOK-AHEAD — one box per day, in order, and it STARTS AT TODAY. It is a list rather than a
    // timeline: the useful fact about a day you are not inside is what is on it, not where in it.
    //
    // It used to start at tomorrow, on the reasoning that the dial already had today. The dial does
    // not. The dial is a rolling window centred on now and it foreshortens hard, so its READABLE band
    // is roughly -9h to +8h — narrower than the +-12h it spans, and far narrower than a day. Just
    // after midnight that band ends around breakfast, so an item at noon sat on a ONE-PIXEL row and
    // everything later was outside the window entirely: the day rolled over and its whole contents
    // left the wall.
    //
    // A threshold would close most of that gap — hold today in the list until the dial reaches it —
    // and it was rejected twice over. It still drops the day at a moment the dial cannot yet read,
    // and the hour it turns on is a function of the column's height and CHIP_MIN, so it goes quietly
    // wrong the next time either moves. Starting at today costs one day off the far end and needs no
    // number at all.
    let ahead = null;
    if (aheadDays) {
      ahead = [];
      for (let k = 0; k < aheadDays; k++) {
        const d = new Date(todayMs + k * DAY);
        const date = keyOf(todayMs + k * DAY);
        const items = byDay[date] || [];
        const shown = items.slice(0, LOOKAHEAD_MAX_PER_DAY);
        ahead.push({
          date,
          dow: d.toLocaleDateString('en-US', { timeZone: 'UTC', weekday: 'short' }),
          day: d.getUTCDate(),
          // First of the month gets its month said; nothing else does. Six weekday names running
          // forward already fix where you are, and the one place that stops being true is the day
          // the number resets.
          month: d.getUTCDate() === 1 ? d.toLocaleDateString('en-US', { timeZone: 'UTC', month: 'short' }) : null,
          items: shown,
          more: Math.max(0, items.length - LOOKAHEAD_MAX_PER_DAY),
          ...aheadGrid(shown.length),
        });
      }
    }

    if (dayOnly) return res.json({ today: todayKey, dayline, ...(ahead ? { ahead } : {}), next_transition: nextChipTransition(rows, nowET) });
    res.json({
      today: todayKey,
      dow: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'],
      count,
      // How many mini-month columns the wall lays the grid out in — geometry is decided here, not
      // in the client, like every other display value.
      cols: count === 1 ? 1 : count <= 4 ? 2 : count <= 6 ? 3 : 4,
      months,
      ...(dayline ? { dayline } : {}),
      ...(ahead ? { ahead } : {}),
      next_transition: nextChipTransition(rows, nowET),
    });
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});

// Clear an item. There is ONE cleared state — checking off and deleting are the same act — and it's
// soft, so the row survives for the recovery window before being purged. No `kind` any more: dated
// and undated items live in the same table, so there is only one thing to clear.
// Mark done. Distinct from /clear, which deletes: this one keeps the item (the calendar draws it as
// something that happened) and moves the health bar's gold band. Every surface that can finish a
// task calls this — the pane's ✓ swipe, the widget's Done, and voice through the data MCP.
//
// `at` says WHEN it was done, for the case where that is not now — "I finished that at 10:15", or
// finishing a 10am thing a quarter of an hour in. Omitting it stamps the clock, which is what every
// button on every surface does and what almost every completion is. The value is a local wall-clock
// reading in the same shape `due` is stored in; completionStamp is what decides that, because the
// band is what has to read it back.
app.post('/api/todos/complete', express.json(), async (req, res) => {
  try {
    const b = req.body || {};
    const id = String(b.id || '');
    if (!id) return res.status(400).json({ error: 'id required' });
    let completedAt = null;
    if (!b.undo) {
      if (b.at == null || b.at === '') completedAt = etNowString();
      else {
        const s = completionStamp(b.at, etNowString());
        if (!s.ok) return res.status(400).json({ error: `at ${s.reason}` });
        completedAt = s.value;
      }
    }
    const now = new Date().toISOString();
    await sbWrite(`list_items?id=eq.${encodeURIComponent(id)}`, 'PATCH',
      { completed_at: completedAt, updated: now });
    res.json({ ok: true, completed_at: completedAt });
    syncBadge().catch(() => {});   // don't make the caller wait on APNs
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});
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
    const list_id = String(b.list_id || '').trim() || 'l_todo';
    const due = String(b.due || '').trim() || null;
    const title = String(b.title || '').trim() || null;
    // Importance is score-only: an important item earns more for being done on time and drains more
    // for being ignored, and notifies exactly like anything else.
    const priority = Number(b.priority) > 0 ? 1 : 0;
    // This surface does NOT create lists. It used to, on any unrecognised name — the same silent fork
    // the data layer removed in 00094, and worse here, because this match was case-SENSITIVE where the
    // tools' was not. Composers post an id that came from this same payload, so a miss is a bug.
    const exists = await sb(`lists?id=eq.${encodeURIComponent(list_id)}&select=id&limit=1`);
    if (!exists.length) return res.status(404).json({ error: `no list with id ${list_id}` });
    // This surface writes one item. Recurrence is materialised rather than stored (data-layer
    // migration 00085), so "every day" is a scheduling instruction that expands to one row per
    // occurrence — which is `add_to_list`'s job, not a text box's.
    await sbWrite('list_items', 'POST', { id: crypto.randomUUID(), list_id, text, title, due, scheduled_at: due, priority, deleted: false, created: now, updated: now });
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
// When a session last did something: its last turn boundary (`active_at` — a prompt sent or a turn
// finished), falling back for rows written before that column existed. Sessions are ordered, numbered
// and focused by it everywhere. Not `last_seen`, which every reconcile tick touches (the list would
// reshuffle every 30s), and not `started`, which kept a session in use below newer idle ones.
const sessionActivity = (s) => new Date(s.active_at || s.reply_at || s.started).getTime();
const byActivity = (a, b) => sessionActivity(b) - sessionActivity(a);

// The session a spoken follow-up lands in, and the one every surface shows as focused. THE RULE IS
// SHARED WITH `focusedSession` IN data-layer's desk.ts and the two must agree, or the wall shows one
// session as focused while a follow-up lands in another:
//   1. a session Jared focused BY NAME, while it is still running;
//   2. a dispatch whose session has not opened yet — null here, so nothing claims focus in that gap;
//   3. otherwise the most recently active running session, on either machine.
// → { session, pinned }. `pinned` says the focus is 1 — his explicit pin — rather than automatic, and
// every surface marks a pinned session differently, because a pin stays put while other sessions take
// turns and automatic focus does not.
async function pickFocus(focusRow, sessions) {
  const f = focusRow || {};
  const running = (sessions || []).filter((s) => s.status === 'resident');
  if (f.session_id) {
    const hit = running.find((s) => s.id === f.session_id);
    if (hit) return { session: hit, pinned: true };
  }
  if (f.command_id && !(sessions || []).some((s) => s.command_id === f.command_id)) {
    // Only while it can still become a session: a command that failed or expired never will.
    const cmd = await sb(`desk_commands?id=eq.${encodeURIComponent(f.command_id)}&select=status`);
    const st = cmd && cmd[0] && cmd[0].status;
    if (st === 'pending' || st === 'running') return { session: null, pinned: false };
  }
  return { session: running.sort(byActivity)[0] || null, pinned: false };
}

app.get('/api/sessions', async (req, res) => {
  try {
    const [sessions, queue, focusRows] = await Promise.all([
      sb('desk_sessions?select=*&order=last_seen.desc'),
      sb('desk_queue?claimed=is.null&select=*&order=created.asc'),
      sb('desk_focus?id=eq.current&select=command_id,session_id'),
    ]);
    const { session: focusHit, pinned } = await pickFocus((focusRows || [])[0], sessions);
    const focus = focusHit ? focusHit.id : null;
    // The number Jared says out loud. THE RULE IS SHARED WITH `numberSessions` IN data-layer's
    // desk.ts and both have to agree, or "session three" means one thing to the pane and another to
    // the voice tools: active sessions only, MOST RECENTLY ACTIVE FIRST, numbered from 1.
    // RUNNING FIRST, then parked, by activity within each — the number is the POSITION IN THE LIST,
    // which is where "the second session" comes from, and every surface draws running above parked.
    const rank = (s) => (s.status === 'resident' ? 0 : 1);
    const numbered = new Map((sessions || [])
      .filter((s) => s.status === 'resident' || s.status === 'evicted')
      .sort((a, b) => rank(a) - rank(b) || byActivity(a, b))
      .map((s, i) => [s.id, i + 1]));
    // Only the fields something renders. A desk_sessions row carries transcript paths, command ids and
    // five timestamps that no surface here reads — 97 rows of them was most of what was left of this
    // response after the replies came out of it. Adding a field to a session view means adding it here.
    const withN = (s) => ({
      id: s.id, n: numbered.get(s.id) || null,
      label: s.label, custom_title: s.custom_title, repo: s.repo,
      worker: s.worker, status: s.status, working: s.working,
      claude_session_id: s.claude_session_id,      // presence of a transcript = the transfer button
    });
    // One line of what the session last said, for the rows that only ever show one line. The repos
    // pane cuts `last_reply` to 90 characters for every row it lists; sending the whole reply so it
    // can be thrown away cost 155KB of a 242KB response over 95 parked sessions, which is most of
    // what a phone downloads on a cold load.
    const SAY = 120;
    const say = (s) => (s.last_reply || s.prompt || '').replace(/\s+/g, ' ').slice(0, SAY);
    const brief = (s) => ({ ...withN(s), say: say(s) });
    // The whole reply goes only to rows something can render in full: everything resident, plus the
    // most recently active parked one, which is what the home wall falls back to when nothing runs.
    const full = (s) => ({ ...brief(s), last_reply: s.last_reply });
    const evicted = (sessions || []).filter((s) => s.status === 'evicted').sort(byActivity);
    res.json({
      // Resident = running now, reachable over Remote Control. Evicted = closed to free the machine
      // but resumable with full context, which is the distinction the panel has to make obvious.
      resident: (sessions || []).filter((s) => s.status === 'resident').sort(byActivity).map(full),
      evicted: evicted.map((s, i) => (i === 0 ? full(s) : brief(s))),
      queued: queue || [],
      focus,
      pinned,
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
  const ka = setInterval(() => { try { res.write(PING); } catch {} }, 25000);
  req.on('close', () => { clearInterval(ka); voiceClients.delete(res); });
});

// Calendar SSE: one `event: lists` frame whenever a dated item or a list changes. Dedicated stream
// (not /api/stream) so the standalone /calendar page does not have to take a full status frame on
// connect just to learn about a reminder.
app.get('/api/list-stream', (req, res) => {
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache',
            Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.flushHeaders();
  listClients.add(res);
  const ka = setInterval(() => { try { res.write(PING); } catch {} }, 25000);
  req.on('close', () => { clearInterval(ka); listClients.delete(res); });
});

// Day SSE: a bodiless `event: nutrition` or `event: workout` frame whenever that day may have changed.
// For a client that cannot take the full status frame on every push — the watch, which reloads the
// page on screen when its kind arrives.
app.get('/api/day-stream', (req, res) => {
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache',
            Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.flushHeaders();
  dayClients.add(res);
  const ka = setInterval(() => { try { res.write(PING); } catch {} }, 25000);
  req.on('close', () => { clearInterval(ka); dayClients.delete(res); });
});

// Session SSE: one `event: session` frame per tool call or finished turn, from either machine.
app.get('/api/session-stream', (req, res) => {
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache',
            Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.flushHeaders();
  sessionClients.add(res);
  const ka = setInterval(() => { try { res.write(PING); } catch {} }, 25000);
  req.on('close', () => { clearInterval(ka); sessionClients.delete(res); });
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

// ---- what happens when a dated item comes due ----
//
// The scheduler below finds due items; it does not deliver them. Delivery is a named handler, so a
// second channel is a new entry here rather than surgery on the loop. Today there is exactly one —
// APNs — and this seam is worth its ten lines only because the second one is already written down:
// AlarmKit (docs/TODO.md), which fires on-device and breaks through Focus.
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
  try { rows = await sb('list_items?deleted=eq.false&completed_at=is.null&due=not.is.null&select=id,list_name,text,title,due,scheduled_at,priority,series_id'); } catch (_) { return; }
  if (!rows.length) return;
  // One lookup for the whole tick rather than one per item — a handful of lists, read at most once a
  // minute, and only when something is actually dated.
  let emojiOf = {};
  try { for (const l of await sb('lists?select=name,emoji')) emojiOf[l.name] = l.emoji; } catch (_) {}
  for (const r of rows) {
    if (dueMoment(r.due) > nowET) continue;                           // not due yet
    // Scoped to the occurrence rather than the row. Each occurrence is its own row now, so the id
    // alone would do — except for snoozing, which moves `due` on an existing row and must be allowed
    // to fire again at its new moment. Including the due gets that for free instead of needing the
    // old ledger row deleted by hand. Do not shorten this key: see the note in CLAUDE.md.
    const dk = `reminder:${r.id}:${r.due}`;
    try { if ((await sb(`notifications?dedupe_key=eq.${encodeURIComponent(dk)}&select=id&limit=1`)).length) continue; } catch (_) { continue; }
    const handler = DUE_HANDLERS.push;
    if (handler === DUE_HANDLERS.push && !apns.configured()) continue;   // nothing to deliver through
    await handler({ ...r, emoji: emojiOf[r.list_name] }, dk);
    console.log(`[due] fired ${r.id} [${r.list_name}] "${String(r.title || r.text).slice(0, 40)}"`);
    // Nothing to re-arm. Every occurrence of a recurring thing is its own row with its own due
    // (data-layer migration 00085), so each one fires once and then stays put — which is also what
    // lets it sit there visibly overdue and drain the score until it is dealt with.
  }
  await closeExempt(nowET);
}

// Exempt items close themselves once their moment has gone. A shift is not something he finishes;
// it is something that happens and is then over, and leaving it on the list would make him tidy up
// after his own calendar. Uses the SCORING deadline rather than the firing time, so an all-day
// exempt item closes at the end of its day instead of at 9am when it notified.
async function closeExempt(nowET) {
  const now = Date.parse(nowET.replace(' ', 'T') + 'Z');
  let rows;
  try {
    rows = await sb('list_items?deleted=eq.false&completed_at=is.null&due=not.is.null&priority=lt.0'
                    + '&select=id,due,scheduled_at,title,text');
  } catch (_) { return; }
  for (const r of rows || []) {
    const deadline = taskDeadline(r.scheduled_at || r.due);
    if (deadline == null || deadline > now) continue;
    try {
      await sbWrite(`list_items?id=eq.${encodeURIComponent(r.id)}`, 'PATCH',
        { completed_at: etNowString(), updated: new Date().toISOString() });
      console.log(`[due] closed exempt ${r.id} "${String(r.title || r.text).slice(0, 40)}"`);
    } catch (e) { console.log('[due] closeExempt:', e.message); }
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
