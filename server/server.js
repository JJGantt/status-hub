'use strict';
// First, so an error anywhere below reaches the ops responder (health/responder): uncaught exceptions,
// unhandled rejections and everything logged with console.error. An error logged with console.log is
// invisible to it, so log errors as errors.
const ops = require('./lib/report');
ops.install({ machine: 'fly', service: 'status-hub' });
const express = require('express');
const crypto = require('crypto');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');
const WebSocket = require('ws');
const { estimateMaintenance, estimateHistory, macroTargets } = require('./lib/maintenance');
const pace = require('./lib/pace');
const { computeVolume } = require('./lib/volume');
// Weeks of heat map the HOME wall shows, against the health wall's 20. Trimming is what makes the two
// maps NARROWER at an unchanged cell size, and that freed width is the muscle column beside them --
// the point is never to show less, it is to not widen the column (which oversizes surf under it and
// robs the sessions column). Cells are fluid, so a trim only helps if the stack keeps its cell size.
const HOME_HEAT_WEEKS = 15;
// The PHONE's home page trims no heat map: its maps SCROLL, so what is visible is decided by the box
// they sit in and everything either side of that is one drag away. Its weigh-in plot scrolls with
// them, which is why it is built on the frame's own window rather than a shorter one — it needs a
// point over every column the food map has, not just the ones on screen.
// Weeks of heat grid carried in the status frame. The frame is re-pushed on every realtime event,
// so this window is fixed; everything older is served on demand by /api/heat-history, which splits
// its prefix at exactly this boundary.
const HEAT_WEEKS = 20;
const MON_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const { getTZ, setTZ, DAY_START_HOUR, localDate, nutritionWindow, lastNTrainingDays, dayBucketOf } = require('./lib/dates');
const { buildWorkoutHeatmap } = require('./lib/heatmap');
const { buildWeightPlot } = require('./lib/weightplot');
const { getWeather } = require('./lib/weather');
const livemic = require('./lib/livemic');
const { buildNutritionLog, buildGoalResolver } = require('./lib/nutritionlog');
const { computeScore, taskDeadline } = require('./lib/score');

// Settings cache: app_settings is read several times per status build but only changes on explicit
// writes, which the realtime subscription announces (→ dirtySettings). One whole-table fetch serves
// every reader; the 15-min backstop covers a silently dropped realtime event.
const settingsCache = { map: null, at: 0 };
const SETTINGS_BACKSTOP_MS = 15 * 60 * 1000;
const dirtySettings = () => { settingsCache.map = null; statusEpoch++; };

// The Claude subscription's usage windows (data-layer 00144: one row per change, newest = current),
// for the two thin bars along the top of every wall. A new row arrives over realtime (→ usageCache.row),
// so the read here is a boot fill and the 15-min backstop behind a dropped event.
const usageCache = { row: null, at: 0 };
const USAGE_BACKSTOP_MS = 15 * 60 * 1000;
async function claudeUsageRow() {
  if (usageCache.row && Date.now() - usageCache.at < USAGE_BACKSTOP_MS) return usageCache.row;
  const rows = await sb('claude_usage?select=five_hour_pct,five_hour_resets_at,seven_day_pct,seven_day_resets_at,observed_at&order=observed_at.desc&limit=1');
  usageCache.row = (rows || [])[0] || null;
  usageCache.at = Date.now();
  return usageCache.row;
}
// Fills 0-100 for the bars, and the minutes to each reset for whatever later shows them. A window whose
// reset has passed is empty until the next turn reports the new one.
function buildUsage(r) {
  if (!r) return null;
  const win = (pct, resets) => {
    const ms = resets ? Date.parse(resets) - Date.now() : null;
    const over = ms !== null && ms <= 0;
    return { pct: over ? 0 : Math.max(0, Math.min(100, Number(pct) || 0)),
             resets_at: over ? null : resets, resets_in_min: over || ms === null ? null : Math.round(ms / 60000) };
  };
  return { five_hour: win(r.five_hour_pct, r.five_hour_resets_at), seven_day: win(r.seven_day_pct, r.seven_day_resets_at),
           observed_at: r.observed_at };
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
// Whether a message at `at` opens a new conversation context after one at `prev` (both epoch ms). The
// SAME boundary the worker replays to the model (voice-pipeline `recent_context`): the hub agent is
// handed the whole day since 4 AM in the display zone, so a new 4am-day starts a context (hub only;
// full-agent never resets on its own), and so does a manual reset (voice_reset_at) in between. An idle
// gap does NOT: drawing a break at an hour of quiet hid a thread the model could still see.
// The one rule behind both the history endpoint and the live stream.
const DAY_MS = DAY_START_HOUR * 3600 * 1000;
const dayOf = (t) => localDate(new Date(t - DAY_MS));
function opensContext(prev, at, mode, s) {
  const resetAt = Date.parse((s || {}).voice_reset_at || '');
  return (mode === 'hub' && dayOf(prev) !== dayOf(at))
    || (Number.isFinite(resetAt) && prev < resetAt && resetAt <= at);
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
// mode are on. Routing is fixed (every turn is Opus), so there's no model/route to resolve here.
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
const { createAuth, isNavigation, isBrowser, stripToken } = require('./lib/auth');

const PORT = process.env.PORT || 8080;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const HUB_PASSWORD = process.env.HUB_PASSWORD;
// No default: a fallback password would be a public one.
if (!HUB_PASSWORD) {
  console.error('HUB_PASSWORD is not set; refusing to start');
  process.exit(1);
}
// Device token: the kiosk, the bedroom TV and every machine client (lib/auth.js says how each sends it).
const TV_TOKEN = process.env.TV_TOKEN || '';
const auth = createAuth({ password: HUB_PASSWORD, deviceToken: TV_TOKEN, supabaseUrl: SUPABASE_URL, supabaseKey: SUPABASE_KEY });
auth.start();
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


const app = express();
app.use(express.urlencoded({ extended: false }));
// EVERY ROUTE IS ON ONE OF TWO ROUTERS, and that choice is its auth: `pub` answers anyone, `gated`
// only a signed-in request (`hubGate`, lib/auth.js). They are mounted here, once, so where in a file a
// route is defined has no bearing on who may call it. A route belongs on `pub` only when it has to be
// reachable signed out, and test/auth.test.js holds the list of every public path.
const pub = express.Router();
const gated = express.Router();
app.use(pub);
app.use(hubGate);
app.use(gated);

const { SURF_HTML } = require('./routes/pages')({ gated });


const { sb, sbRange, sbWrite, sbInsert, putSetting } = require('./lib/supa')({ SUPABASE_KEY, SUPABASE_URL });

// ---- the alarm log (data-layer 00113) ---------------------------------------------------------
// What happened to every alarm, durably. Stdout here is a buffer of about a hundred lines, and an
// alarm is audited the morning after — so without this the phone's half of any alarm was gone
// within the hour. EVENTS only: a beacon that says nothing new writes nothing (noteRinger). Never
// throws into the caller.
function alarmLog(source, ev, detail = {}, itemId = null) {
  sbWrite('alarm_log', 'POST', { source, ev, item_id: itemId, detail })
    .catch((e) => console.error('[alarm-log] write failed:', e.message));
}

// THE RINGERS' LAST WORD. Every alarm clock — the TV's tv-ring and each page running alarmclock.js —
// beacons its state once a minute. Held here per source so the log records a CHANGE, or a ringer
// coming back after a silence, rather than every beat; and so an alarm's due moment can say what
// each ringer last reported, which is the question every audit starts with.
const RINGER_SILENCE_MS = 5 * 60 * 1000;
const ringers = new Map();   // source -> { at, state }
function ringerSource(b, req) {
  if (b.ev === 'tvring') return 'tv';
  const ua = String(req.get('user-agent') || '');
  // The Pi's kiosk Chromium reports itself as `X11; CrOS x86_64`, not as Linux.
  const device = /iPhone|iPad/.test(ua) ? 'iphone' : /Macintosh/.test(ua) ? 'mac' : /X11|Linux/.test(ua) ? 'pi' : 'other';
  return `${b.surface || 'page'}@${device}`;
}
function ringerState(b) {
  if (b.ev === 'tvring') return { next: b.next, ringing: b.ringing, player: b.player, tone: b.tone };
  return { next: b.next, armed: b.armed, ringing: b.ringing, guided: b.guided, visible: b.visible,
           lock: b.lock, audio: b.audio, loaded: b.media >= 2, tone: b.tone };
}
function noteRinger(b, req) {
  const source = ringerSource(b, req);
  // Something the ringer reports AS an event — a ring, a stop, the sound failing — is logged as itself.
  const beat = b.ev === 'tvring' ? b.at === 'beat' : !b.at;
  if (!beat) {
    const { ev, at, ...detail } = b;
    return alarmLog(source, at, detail, b.id || null);
  }
  const state = ringerState(b);
  const now = Date.now();
  const prev = ringers.get(source);
  ringers.set(source, { at: now, state });
  // First heard since the hub started: the user agent rides along once, so a source named from it
  // can be traced to the actual device.
  if (!prev) return alarmLog(source, 'state', { ...state, ua: String(req.get('user-agent') || '').slice(0, 160) });
  if (now - prev.at > RINGER_SILENCE_MS) return alarmLog(source, 'resumed', { silent_s: Math.round((now - prev.at) / 1000), ...state });
  const changed = Object.keys(state).filter((k) => state[k] !== prev.state[k]);
  if (changed.length) alarmLog(source, 'state', { changed, ...state });
}
function ringerReport() {
  const now = Date.now();
  return Object.fromEntries([...ringers].map(([s, r]) => [s, { heard_s_ago: Math.round((now - r.at) / 1000), ...r.state }]));
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

const {
  SURF_BAND_COLORS, dirtySurfHist, liveBuoy, liveWind, pushSurfLive, surfAlarms, surfBand,
} = require('./routes/surf')({
  PING, SUPABASE_KEY, SUPABASE_URL, SURF_HTML, alarmLog, buildSurf, etNowString, etStringAt, gated,
  pub, ratingLabel, sb, sbRange, sbWrite, settingsAll,
});

// ---- dashboard source rows, cached by GROUP ---------------------------------------------------
// The 30s broadcast tick exists to advance clock-derived fields (pace drain, session clock) — but
// the DB rows it renders only change on writes, and realtime already announces every write. So the
// heavy queries are fetched once and reused for every rebuild; a refetch happens only when
// (a) a write to that group's table dirtied it, (b) the date window in its queries rolled over, or
// (c) the 15-min reconciliation backstop lapses (covers a silently dropped realtime event).
// Presence and device_status rows are NOT cached — they're tiny (~200B/~1KB) and are WRITTEN every
// couple of minutes by design (worker heartbeats, litter/feeder state mirrors); caching them would
// make those routine writes dirty the cache and drag the heavy queries along ~720×/day.
// This took Supabase egress from ~143KB × every 30s (≈0.5GB/day, the free-plan quota blowout) to
// effectively zero at idle.
//
// A write dirties only the groups its TABLE feeds: a checked-off list item refetches the two task
// reads, not the 210 days of intake behind the maintenance estimate. And a group is read on its own,
// so an endpoint that needs only the rings never touches the surf, task or catalog rows.
const ROW_GROUPS = {
  nut: ['nutrition_entries'], weight: ['weight_log'], targets: ['nutrition_targets'],
  train: ['sets', 'exercise_muscles', 'exercise_catalog', 'muscle_volume_targets'], catalog: ['exercise_catalog', 'exercise_muscles'], surf: ['surf_snapshots'],
  tasks: ['list_items'],
};
const ROWCACHE_BACKSTOP_MS = 15 * 60 * 1000;
const rowCache = new Map();   // group -> { rows, key, at, gen, pending, pendingGen, pendingKey }
// `rowGen[g]` lets a read that began before an invalidation see that it has been overtaken.
const rowGen = Object.fromEntries(Object.keys(ROW_GROUPS).map((g) => [g, 0]));
// Moves on every invalidation of anything a status build reads from a cache, so a build in flight can
// tell whether it is still current enough to share (buildStatus).
let statusEpoch = 0;
// Dirty the groups fed by these tables — or every group, with none named (the freshness probe, which
// cannot say what moved).
function dirtyRows(...tables) {
  statusEpoch++;
  const named = tables.filter(Boolean);
  for (const [g, ts] of Object.entries(ROW_GROUPS)) {
    if (!named.length || ts.some((t) => named.includes(t))) rowGen[g]++;
  }
}
// One group's rows. Concurrent callers share one read — several endpoints opening together is the
// ordinary case, since a page asks for all of its parts at once — and a read overtaken by a write is
// served but not kept.
function groupRows(group, key, read) {
  const c = rowCache.get(group) || {};
  const gen = rowGen[group];
  if (c.rows && c.gen === gen && c.key === key && Date.now() - c.at < ROWCACHE_BACKSTOP_MS) return Promise.resolve(c.rows);
  if (c.pending && c.pendingGen === gen && c.pendingKey === key) return c.pending;
  const settle = () => { const now = rowCache.get(group); if (now && now.pending === pending) now.pending = null; };
  const pending = read().then((rows) => {
    settle();
    if (rowGen[group] === gen) rowCache.set(group, { rows, key, at: Date.now(), gen });
    else console.log(`[rowcache] ${group}: a write was announced mid-read: serving this read, leaving it dirty`);
    return rows;
  }, (e) => { settle(); throw e; });
  rowCache.set(group, { ...c, pending, pendingGen: gen, pendingKey: key });
  return pending;
}

// The status strip's session fields, on the same terms as the row cache above. These two reads ran on
// EVERY frame — and a frame is rebuilt on every realtime event as well as every 30s — to answer a
// question whose answer changes a handful of times a day. `desk_sessions` and `desk_focus` are in the
// publication now (data-layer 00104), so a change dirties this directly instead of being discovered.
const deskCache = { rows: null, at: 0, dirty: true };
const DESKCACHE_BACKSTOP_MS = 15 * 60 * 1000;
const dirtyDesk = () => { deskCache.dirty = true; statusEpoch++; };

async function fetchDeskRows() {
  if (!deskCache.dirty && deskCache.rows && Date.now() - deskCache.at < DESKCACHE_BACKSTOP_MS) {
    return deskCache.rows;
  }
  const rows = await Promise.all([
    sb('desk_focus?id=eq.current&select=command_id,session_id'),
    sb('desk_sessions?status=eq.resident&select=id,repo,label,command_id,status,active_at,reply_at,started'),
  ]);
  deskCache.rows = rows; deskCache.at = Date.now(); deskCache.dirty = false;
  return rows;
}


// The date windows the status queries are cut to. Every one is derived from the clock, so each is
// also part of its group's cache key: a window rolling over is a refetch.
function statusWindows() {
  const win = nutritionWindow();
  return {
    win, today: win.day,
    week: lastNTrainingDays(7),
    // Intake history for the maintenance trend + per-day replay (viz paging).
    histStart: localDate(new Date(Date.now() - 210 * 86400000)),
    // The frame's workout heatmap window.
    heatStart: localDate(new Date(Date.now() - HEAT_WEEKS * 7 * 86400000)),
    // The food map's rows must reach back as far as its grid does — HEAT_WEEKS columns, the first
    // starting on a Sunday up to six days before that. A fixed day count here outlives the grid it was
    // sized for, and every day it falls short draws as an empty cell, which reads exactly like deleted
    // entries.
    nutLogStart: localDate(new Date(Date.now() - (HEAT_WEEKS * 7 + 7) * 86400000)),
    taskWindowStart: localDate(new Date(Date.now() - 8 * 86400000)),  // an effect is gone at 7 days; a day's slack costs nothing
  };
}

const rowsOf = {
  nut: (w) => groupRows('nut', [w.win.start, w.win.end, w.histStart, w.nutLogStart].join('|'), async () => {
    const [entries, stagedEntries, histRows, nutLogRows] = await Promise.all([
      sb(`nutrition_entries?occurred_at=gte.${w.win.start}&occurred_at=lt.${w.win.end}&staged=eq.false&select=calories,protein_g,carbs_g,fat_g,veg_g,dark_green_g,fruit_g`),
      // Staged meals carry no day: they are pending until committed, so there is no window to filter on
      // and every staged row belongs to whatever day it is eaten on. Sum them all.
      sb('nutrition_entries?staged=eq.true&select=calories,protein_g,carbs_g,fat_g'),
      sbRange(`nutrition_entries?occurred_at=gte.${w.histStart}T00:00:00&staged=eq.false&select=occurred_at,calories&order=occurred_at`),
      sbRange(`nutrition_entries?occurred_at=gte.${w.nutLogStart}T00:00:00&staged=eq.false&select=occurred_at,calories,protein_g,fat_g&order=occurred_at`),
    ]);
    return { entries, stagedEntries, histRows, nutLogRows };
  }),
  weight: () => groupRows('weight', '', async () => ({ weightRows: await sb('weight_log?select=date,weight_lbs&order=date.asc') })),
  targets: () => groupRows('targets', '', async () => ({ targetRows: await sb('nutrition_targets?select=date,calories&order=date.asc') })),
  train: (w) => groupRows('train', [w.week[0], w.heatStart].join('|'), async () => {
    // The week's muscle volume comes computed: muscle_volume() is its one definition (lib/volume.js).
    const [volRows, heatRows] = await Promise.all([
      sb('rpc/muscle_volume?p_days=7'),
      sbRange(`sets?occurred_at=gte.${w.heatStart}T00:00:00&select=occurred_at&order=occurred_at`),
    ]);
    return { volRows, heatRows };
  }),
  catalog: () => groupRows('catalog', '', async () => {
    const [muscleRows, catalogRows] = await Promise.all([
      sb('exercise_muscles?select=name,muscle,contribution'),
      sb('exercise_catalog?select=name,equipment'),
    ]);
    return { muscleRows, catalogRows };
  }),
  surf: () => groupRows('surf', '', async () => ({ surfRows: await sb('surf_snapshots?select=slug,captured_at,rows&order=captured_at.desc&limit=1') })),
  // The gold band's two inputs, both ordinary `list_items` rows. A completed item persists — it still
  // draws on the calendar — so it is its own record and there is no separate ledger. The drain is
  // derived live from whatever is still outstanding, so there is no stored penalty to fall out of step
  // with the list.
  tasks: (w) => groupRows('tasks', w.taskWindowStart, async () => {
    const [taskEventRows, openTaskRows] = await Promise.all([
      sb(`list_items?deleted=eq.false&completed_at=gte.${w.taskWindowStart}T00:00:00&due=not.is.null&select=scheduled_at,due,completed_at,priority`),
      sb('list_items?deleted=eq.false&completed_at=is.null&due=not.is.null&select=scheduled_at,due,priority'),
    ]);
    return { taskEventRows, openTaskRows };
  }),
};

// Recompute only when an input changed. Inputs are compared by IDENTITY, which is what a cached row
// group hands out: the same array until that group is refetched. So a derived value lives exactly as
// long as the rows it was derived from, with no invalidation of its own to forget.
function memo(fn) {
  let deps = null, val;
  return (...args) => {
    if (deps && deps.length === args.length && deps.every((d, i) => d === args[i])) return val;
    val = fn(...args); deps = args;
    return val;
  };
}

// ---- the dashboard, in PIECES ------------------------------------------------------------------
// buildStatus() is every card on every wall, and a surface that draws one card must not pay for the
// rest: the watch's rings used to cost a whole dashboard — 210 days of maintenance replayed day by
// day, both heat maps, the devices, the mics, the session focus — to send four arcs. Each endpoint
// below asks for the pieces it draws, and buildStatus is those same pieces put together, so a number
// cannot come out one way on the wall and another on the wrist.

// Maintenance and the eating window: a function of the intake history, the weigh-ins and the goal
// settings, so recomputed only when one of them moves. NOT the per-day replay (`historyOf`), which is
// most of the cost and which only the weight views draw.
const maintenanceOf = memo((weightRows, histRows, today, surplus, minAlignedDays, phaseKey) => {
  const intakeTotals = {};
  for (const e of histRows || []) {
    const d = dayBucketOf(e.occurred_at);
    if (d === today) continue; // exclude the in-progress day (partial intake biases low)
    intakeTotals[d] = (intakeTotals[d] || 0) + (Number(e.calories) || 0);
  }
  const intakeByDay = Object.entries(intakeTotals).map(([date, calories]) => ({ date, calories }));
  const weights = (weightRows || []).map((r) => ({ date: String(r.date).slice(0, 10), weight: Number(r.weight_lbs) }));
  const phase = JSON.parse(phaseKey);   // caps the live window at the current goal phase
  const maintenance = estimateMaintenance({ weights, intakeByDay, today, surplus, minAlignedDays, phase });
  const eatWindow = pace.deriveWindow((histRows || []).map((r) => r.occurred_at));
  return { weights, intakeByDay, maintenance, eatWindow };
});

// What every nutrition surface starts from: the day's rows, the goal settings and maintenance.
async function nutritionCore() {
  const w = statusWindows();
  const [nut, { weightRows }, { targetRows }, surplus, minAlignedDays, phase, produceGoal] = await Promise.all([
    rowsOf.nut(w), rowsOf.weight(), rowsOf.targets(),
    surplusCal(), maintenanceMinDays(), maintenancePhase(), produceTargets(),
  ]);
  const m = maintenanceOf(weightRows, nut.histRows, w.today, surplus, minAlignedDays, JSON.stringify(phase ?? null));
  return { w, today: w.today, ...nut, weightRows, targetRows, surplus, minAlignedDays, produceGoal, ...m };
}

// The day's totals and the pace rings at THIS instant — the one piece that moves with the clock, so
// it is computed per call; it is a few arithmetic passes.
function paceOf(core) {
  const sum = (k) => (core.entries || []).reduce((a, e) => a + (Number(e[k]) || 0), 0);
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
    target: core.maintenance.target_macros, // the macro goal is the live dynamic target
  };
  // ---- gamified intake pacing (drain bars) ----
  // What is staged but not eaten. Kept OUT of `nutrition` and out of `consumed` — it is what the day
  // would become, never what it is — and handed to the pace math separately so the rings can draw it
  // as a piece past the real arc.
  const stagedSum = (k) => Math.round((core.stagedEntries || []).reduce((a, e) => a + (Number(e[k]) || 0), 0));
  const stagedMacros = { calories: stagedSum('calories'), protein_g: stagedSum('protein_g'),
                         carbs_g: stagedSum('carbs_g'), fat_g: stagedSum('fat_g') };
  const paceData = pace.computePace({
    consumed: { calories: nutrition.calories, protein_g: nutrition.protein_g, carbs_g: nutrition.carbs_g, fat_g: nutrition.fat_g },
    goal: core.maintenance.target_macros,
    staged: stagedMacros,
    window: core.eatWindow,
    nowOff: nowOffsetTZ(),
  });
  paceData.window_label = pace.windowLabel(core.eatWindow);
  // Produce rings are NOT paced. The macro rings are drain gauges (full = on-pace, draining with the
  // clock); produce starts EMPTY each day and simply fills toward a fixed goal. No window, no marker,
  // no time term at all — so it goes through computeFill(), never computePace().
  paceData.produce = pace.computeFill(
    { veg_g: nutrition.veg_g, dark_green_g: nutrition.dark_green_g, fruit_g: nutrition.fruit_g }, core.produceGoal);
  return { nutrition, paceData };
}

// The per-day replay of maintenance and target, for the surfaces that draw the weight page.
const historyOf = memo((weights, intakeByDay, today, surplus, minAlignedDays) =>
  // Phase-less, so past goals are never backfilled.
  estimateHistory({ weights, intakeByDay, today, surplus, minAlignedDays }));
function maintenanceWithHistory(core) {
  const m = core.maintenance;
  if (!m.viz) return m;
  let series = historyOf(core.weights, core.intakeByDay, core.today, core.surplus, core.minAlignedDays);
  // ...but the replay's FINAL point still reflects the old straddled calc, so override ONLY today's point
  // with the live phase-aware number — the on-plot curve + its labels then agree with the header/math,
  // while every prior day stays frozen (no backfill). On a copy: the replay is cached.
  const last = series && series[series.length - 1];
  if (last && last.date === core.today && m.source !== 'calibrating') {
    series = series.slice(0, -1).concat({ ...last, avg: m.avg_intake, maintenance: m.maintenance, target: m.target });
  }
  return { ...m, viz: { ...m.viz, series } };
}

const volumeOf = memo((volRows, muscleRows, catalogRows) => {
  // ---- weekly per-muscle volume gauges ----
  const volume = computeVolume(volRows, muscleRows || []);
  volume.exercise_variants = buildVariants(catalogRows || []); // exercise → equipment variants + YouTube how-to links
  return volume;
});
const setClocksOf = memo((heatRows, today) => {
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
  return { last_set_at, session_start_at, sets_today };
});

// The week's training: the muscle gauges and the set clocks.
async function trainingCore() {
  const w = statusWindows();
  const [{ volRows, heatRows }, { muscleRows, catalogRows }] = await Promise.all([rowsOf.train(w), rowsOf.catalog()]);
  return { w, today: w.today, heatRows,
    volume: volumeOf(volRows, muscleRows, catalogRows),
    ...setClocksOf(heatRows, w.today) };
}

const goalResolverOf = memo((nutLogRows, weights, targetRows, today, surplus, fallbackMaint) =>
  buildGoalResolver({ rows: nutLogRows || [], weights, targets: targetRows || [], today, surplus, fallbackMaint }));

// ---- overall score (training, nutrition and tasks over the rolling week) ----
async function scoreOf(core, paceData, train) {
  const { taskEventRows, openTaskRows } = await rowsOf.tasks(core.w);
  const { goalForDay } = goalResolverOf(core.nutLogRows, core.weights, core.targetRows, core.today, core.surplus,
    core.maintenance.maintenance);
  const dayCPF = {};   // 4am-day bucket -> {cal, protein, fat} actuals
  for (const e of core.nutLogRows || []) {
    const d = dayBucketOf(e.occurred_at);
    const x = (dayCPF[d] = dayCPF[d] || { cal: 0, protein: 0, fat: 0 });
    x.cal += Number(e.calories) || 0; x.protein += Number(e.protein_g) || 0; x.fat += Number(e.fat_g) || 0;
  }
  const weights = core.weights;
  const wForDay = (ds) => { let w = null; for (const x of weights) { if (x.date <= ds) w = x.weight; else break; } return w; };  // weights are date-asc
  const scoreDays = core.w.week.map((d) => {
    const a = dayCPF[d] || { cal: 0, protein: 0, fat: 0 };
    const calGoal = goalForDay(d);
    const mt = macroTargets(calGoal, wForDay(d));
    return { date: d, isToday: d === core.today, fraction: paceData.fraction, cal: a.cal, protein: a.protein, fat: a.fat,
             calGoal, proteinFloor: mt.protein_g, fatTarget: mt.fat_g };
  });
  // surplus signs the goal-aware calorie scoring; the task inputs are the gold band's ledger and the
  // still-open dated items it drains from.
  return computeScore({
    volume: train.volume, days: scoreDays, surplus: core.surplus,
    taskEvents: taskEventRows || [], openTasks: openTaskRows || [], nowLocal: etNowString(),
  });
}

// The whole dashboard. Requests that arrive while one is being built share it, unless something it
// reads was invalidated after it began; the broadcast always builds its own (`composeStatus`), because
// a device_status change reaches it without invalidating any cache and must not be answered with a
// build that started before it.
let statusBuild = null;
function buildStatus() {
  if (statusBuild && statusBuild.epoch === statusEpoch) return statusBuild.promise;
  const build = { epoch: statusEpoch, promise: null };
  build.promise = composeStatus().finally(() => { if (statusBuild === build) statusBuild = null; });
  statusBuild = build;
  return build.promise;
}

async function composeStatus() {
  const [core, train, { surfRows }, deviceRows, presenceRows, workerRows, watcherRows, usageRow] = await Promise.all([
    nutritionCore(), trainingCore(), rowsOf.surf(),
    sb('device_status?select=*'),
    sb('voice_presence?select=source,alive_at'),
    sb('worker_presence?select=worker,last_seen,info'),
    // Alongside the other live reads rather than after the build: it is one more round trip, and
    // serially it was the frame's second.
    sb('set_watcher?id=eq.1&select=exercise,weight_lbs,armed_at,last_set_at').catch(() => []),
    claudeUsageRow().catch((e) => { console.error('[usage] read failed:', e.message); return null; }),
  ]);
  const { today } = core;

  const litter = buildLitter((deviceRows || []).find((d) => d.device !== 'cat-feeder') || null);
  const feeder = (deviceRows || []).find((d) => d.device === 'cat-feeder') || null;
  const surf = buildSurf((surfRows || [])[0]);

  const routing = await routingConfig();   // agent model / thinking / runner / wake (TV routing panel)

  // The session a spoken follow-up would land in — shown on the TV strip so the answer is ambient
  // rather than something you have to open a pane to learn. The same rule as /api/sessions
  // (pickFocus), so the strip, the wall and the behaviour cannot disagree.
  let deskFocus = null;
  try {
    const [fRows, sRows] = await fetchDeskRows();
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
        sessions: i.sessions ?? null,
      };
    })(),
  };
  const maintenance = maintenanceWithHistory(core);
  syncStoredTarget(maintenance.target_macros, today).catch((e) => console.error('target sync:', e.message));
  const { nutrition, paceData } = paceOf(core);
  const { volume } = train;
  const { weights, surplus } = core;

  // ---- workout volume heatmap (GitHub-contribution style) ----
  const heatmap = buildWorkoutHeatmap(train.heatRows, HEAT_WEEKS, today); // 4am `today`, matching the nutrition heatmap

  // ---- nutrition log: calorie-adherence calendar (per-day historical targets) + calorie/weight trend ----
  const nutrition_log = buildNutritionLog(core.nutLogRows || [], weights, maintenance.target, maintenance.maintenance, today, core.targetRows || [], HEAT_WEEKS, surplus, 150, paceData.fraction);


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
  // The phone's plot spans the map's WHOLE window, not the part of it on screen: there it scrolls
  // with the map under it, so it has to have a point over every column the map has.
  const weight_plot_phone = buildWeightPlot(weights, HEAT_WEEKS, today);


  const score = await scoreOf(core, paceData, train);

  // The rep watcher: what the Apple Watch app's counted sets are currently being
  // logged as. Shown under the rest clock so it is visible at a glance whether a set
  // about to be performed will actually be recorded — knowing that BEFORE the set is
  // the only time it helps. Ten minutes with no set clears it, mirrored from the SQL
  // so the UI and the trigger agree on what "live" means.
  // The watcher is a nicety; a failed read is no watcher, never a failed dashboard.
  let rep_watcher = null;
  const rw = (watcherRows || [])[0];
  if (rw && rw.exercise) {
    const stamp = rw.last_set_at || rw.armed_at;
    if (stamp && Date.now() - new Date(stamp).getTime() < 10 * 60 * 1000) {
      rep_watcher = { exercise: rw.exercise, weight_lbs: rw.weight_lbs };
    }
  }

  const { last_set_at, session_start_at, sets_today } = train;
  return { today, litter, feeder, surf, wind: liveWind.view((surfRows || [])[0]), buoys: liveBuoy.view(), weather: getWeather(), nutrition, maintenance, pace: paceData, volume, heatmap, nutrition_log,
    heatmap_home, nutrition_log_home, weight_plot, weight_plot_phone,
    last_set_at, session_start_at, sets_today, rep_watcher, routing, mics, score, desk_focus: deskFocus,
    claude_usage: buildUsage(usageRow),
    // THE BUILD THIS FRAME CAME FROM. A page that has been open for hours never re-requests its own
    // bundle, so a deploy reaches the server and not the screen — which is how a phone spends an
    // afternoon running code that was replaced. Every client remembers the first commit it sees and
    // reloads when it changes. Push, not a version check on a timer: a deploy restarts the server,
    // every stream reconnects, and the next frame carries the new one.
    commit: process.env.COMMIT || 'dev',
    generated_at: new Date().toISOString() };
}

// ---- realtime push: recompute + push to all connected browsers on any DB change ----
let frameSeq = 0, frameSent = 0;
async function broadcast() {
  const seq = ++frameSeq;
  let frame;
  const t0 = Date.now();
  try { frame = 'data: ' + JSON.stringify(await composeStatus()) + '\n\n'; }
  catch (e) { console.error('broadcast build failed:', e.message); return; }
  // Only a slow one: this runs every 30s and on every write, and a line per build is noise.
  if (Date.now() - t0 > 500) console.log(`[timing] broadcast build ${Date.now() - t0}ms`);
  if (seq < frameSent) { console.log('[broadcast] dropped a frame a later build already sent'); return; }
  frameSent = seq;
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

// The last message time per mode, so a live row is flagged as opening a new context by the same rule
// /api/voice-messages applies to history. Seeded from the table at boot; a row that arrives before the
// seed is simply not flagged.
const lastVoiceAt = { hub: null, agent: null };
function markLive(row) {
  if ((row.focus || 'hub') !== 'hub' || !row.created_at) return row;
  const mode = row.mode === 'agent' ? 'agent' : 'hub';
  const at = Date.parse(row.created_at), prev = lastVoiceAt[mode];
  if (prev === null || at > prev) lastVoiceAt[mode] = at;
  return prev !== null && opensContext(prev, at, mode, settingsCache.map) ? { ...row, ctx_break: true } : row;
}
async function seedLastVoiceAt() {
  for (const [mode, filter] of [['hub', 'or=(mode.is.null,mode.eq.hub)'], ['agent', 'mode=eq.agent']]) {
    try {
      const r = await sb(`voice_messages?focus=eq.hub&${filter}&order=created_at.desc&limit=1&select=created_at`);
      if (r && r[0] && lastVoiceAt[mode] === null) lastVoiceAt[mode] = Date.parse(r[0].created_at);
    } catch (_) {}
  }
}
seedLastVoiceAt();

// What the watch's fallback needs from this server, handed over while it is up: the HASH of the device
// token, so the `voice-fallback` edge function (data-layer supabase/functions) can check the watch's
// X-Hub-Token when THIS server cannot be reached. Written at every boot rather than copied by hand, so a
// changed password reaches it at the next deploy. Service-role only (data-layer 00124).
async function publishFallbackConfig() {
  const row = { key: 'hub_token_sha256', value: crypto.createHash('sha256').update(auth.PASSWORD_TOKEN).digest('hex'),
                updated_at: new Date().toISOString() };
  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/fallback_config?on_conflict=key`, {
      method: 'POST',
      headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json',
                 Prefer: 'resolution=merge-duplicates' },
      body: JSON.stringify(row),
    });
    if (!r.ok) throw new Error(`-> ${r.status}`);
  } catch (e) { console.error('[fallback-config] could not publish:', e.message); }
}
publishFallbackConfig();

// Tell every open calendar surface that dated items changed, so it re-reads /api/calendar. The
// signal carries no payload on purpose: what each surface needs back differs (the wall wants
// `calendar_months` months plus today's timeline, the phone wants whichever month it has paged to),
// so the fetch that follows is the only thing that knows what to ask for.
function pushLists() {
  const frame = 'event: lists\ndata: {}\n\n';
  for (const res of listClients) { try { res.write(frame); } catch {} }
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

// Realtime events on exactly the three tables the freshness fingerprint below can see. The probe
// asks "did the database move without realtime saying so", and this counter is the "saying so" half.
// Module scope, not inside startRealtime: a recycle rebuilds the handlers and must not reset it.
let rtEvents = 0;
const fpSeen = () => { rtEvents++; };

function startRealtime() {
  // A change to any cached source table dirties the row cache, then rebuilds + pushes. The extra
  // subscriptions (weight_log … surf_snapshots) exist for the cache: without them an edit would sit
  // invisible until the 15-min backstop refetch.
  const seen = () => { lastRealtimeEvent = Date.now(); };
  // `p.table` names what moved, so only the row groups that table feeds are refetched.
  const changed = (p) => { seen(); dirtyRows(p && p.table); dirtyNutDay(); dirtyWorkoutDay(); dirtyHeatHistory(); broadcast(); };
  hubChannel = supa.channel('hub-changes')
    // device_status is fetched live per build (not cached) — its routine ~2-min state mirrors must
    // rebuild the frame but must NOT drag the heavy cached queries along. Plain broadcast only.
    .on('postgres_changes', { event: '*', schema: 'public', table: 'device_status' },
      () => { seen(); broadcast(); })
    .on('postgres_changes', { event: '*', schema: 'public', table: 'nutrition_entries' },
      (p) => { fpSeen(); changed(p); })
    .on('postgres_changes', { event: '*', schema: 'public', table: 'sets' },
      (p) => { fpSeen(); changed(p); })
    .on('postgres_changes', { event: '*', schema: 'public', table: 'weight_log' }, changed)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'nutrition_targets' }, changed)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'exercise_catalog' }, changed)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'exercise_muscles' }, changed)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'muscle_volume_targets' }, changed)
    // A new snapshot changes both the card's current reading and the heatmap behind it.
    .on('postgres_changes', { event: '*', schema: 'public', table: 'surf_snapshots' },
      (p) => { dirtySurfHist(); changed(p); surfAlarms.tick('snapshot'); pushSurfLive(); })
    .on('postgres_changes', { event: '*', schema: 'public', table: 'surf_alarms' },
      () => { seen(); surfAlarms.tick('rule'); })
    // A TV command, pushed to the TV's app the moment it is written (tvPush).
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'tv_commands' },
      (p) => { seen(); tvPush(p.new).catch((e) => console.error('[tv] push', e.message || e)); })
    // The rep watcher, so setting it appears at once rather than on the next periodic
    // frame. Its whole value is confirming BEFORE a set that sets are being logged as
    // the right thing, and a delay there defeats the purpose. workset_reports is NOT
    // subscribed: every report writes a row to `sets`, which is, so the push already
    // happens and adding reports would only duplicate it.
    .on('postgres_changes', { event: '*', schema: 'public', table: 'set_watcher' }, changed)
    // A new usage reading (the table only gains a row when a number moves).
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'claude_usage' },
      (p) => { seen(); if (p.new) { usageCache.row = p.new; usageCache.at = Date.now(); } broadcast(); pushDay('usage'); })
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
      if (p.new && ['tv_sidebar_view', 'tv_sidebar_font', 'tv_sidebar_width'].includes(p.new.key)) pushSessions();
      // A holder written straight into the table (the Mac's listener) is a mute taken or given back.
      if (p.new && String(p.new.key || '').startsWith(MUTE_HOLD)) recomputeMute().catch((e) => console.error('[mute]', e.message || e));
    })
    // Dated items and the lists that colour them. `list_items` DOES feed the status frame now — the
    // health bar's gold band is earned by clearing dated items and drained by leaving them — so a
    // change has to invalidate the row cache and rebuild, not merely notify the calendar surfaces.
    // Without the rebuild a completion would not show on the bar until the 15-minute backstop, which
    // is the one moment the reward is supposed to land.
    .on('postgres_changes', { event: '*', schema: 'public', table: 'list_items' },
      (p) => {
        fpSeen();
        seen(); dirtyRows('list_items'); pushLists(); broadcast();
        // A dated item added, snoozed, completed or cleared changes both when the next thing is due
        // and what the icon should read. Pushing the badge here is what lets its own poll be a
        // backstop instead of the mechanism that keeps a cleared task from lingering on his phone.
        dirtyDue();
        syncBadge().catch((e) => console.error('[badge] error', e.message));
      })
    .on('postgres_changes', { event: '*', schema: 'public', table: 'lists' },
      () => { seen(); pushLists(); })
    // Voice pipeline: stream inserts/updates straight to the /tv conversation panel. INSERT and
    // UPDATE both carry the new row in `payload.new` (UPDATE = a streamed row flipping done=true).
    .on('postgres_changes', { event: '*', schema: 'public', table: 'voice_messages' },
      (p) => {
        seen();
        if (!p.new) return;
        pushVoice('message', p.eventType === 'INSERT' ? markLive(p.new) : p.new);
        if (p.eventType === 'INSERT') notifyAnswer(p.new);
      })
    // A client waiting on its own command (/api/voice-reply/:id) is answered the moment the worker
    // marks the request finished.
    .on('postgres_changes', { event: '*', schema: 'public', table: 'voice_requests' },
      (p) => {
        seen();
        if (!p.new) return;
        if (p.eventType === 'UPDATE') settleReply(p.new);
        // His words the moment they exist: the worker writes his voice_messages row only beside the
        // answer, which can be half a minute later. The TV sidebar shows them from this.
        const r = requestView(p.new);
        if (r) pushVoice('request', r);
      })
    // The three tables a session view is assembled from. These are why the walls no longer poll
    // /api/sessions every 5s: a session starting, ending, being renamed, finishing a turn, being
    // focused or queueing behind another one all land here, and each pushes a fresh payload.
    // dirtyDesk on the two that feed the status strip, so the NEXT frame is fresh. Deliberately no
    // broadcast() here: a frame still costs four uncached presence reads, so pushing one per desk
    // change would spend more than the poll it replaced.
    .on('postgres_changes', { event: '*', schema: 'public', table: 'desk_sessions' },
      () => { seen(); dirtyDesk(); pushSessions(); })
    .on('postgres_changes', { event: '*', schema: 'public', table: 'desk_queue' },
      () => { seen(); pushSessions(); })
    .on('postgres_changes', { event: '*', schema: 'public', table: 'desk_focus' },
      () => { seen(); dirtyDesk(); pushSessions(); })
    // A written report announces itself rather than being discovered: reportTick's timer is now only
    // the net under this, instead of the fastest database timer on the server.
    .on('postgres_changes', { event: '*', schema: 'public', table: 'hub_sessions' }, (p) => { seen(); auth.onChange(p); })
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'reports' },
      () => { seen(); reportTick().catch((e) => console.error('[report] error', e.message)); })
    .subscribe((status) => {
      console.log('realtime channel:', status);
      // SUBSCRIBED means the handshake completed, not that events will flow. Treat it
      // only as "the clock starts now" so a channel that comes back deaf still trips
      // the watchdog instead of looking healthy forever.
      if (status === 'SUBSCRIBED') lastRealtimeEvent = Date.now();
      // Whatever arrived while the socket was down was missed, so re-decide from the current state.
      if (status === 'SUBSCRIBED') surfAlarms.tick('subscribe');
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
  try { startRealtime(); } catch (e) { console.error('resubscribe failed:', e.message); }
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
// `rtEvents` as of the end of the previous run. Anything realtime announced since then is credited to
// whatever move this run finds, so the question the probe asks is exactly: the database changed, did
// realtime mention it?
let rtMark = 0;
setInterval(async () => {
  let fp;
  try { fp = await freshnessFingerprint(); } catch (e) { console.error('freshness probe:', e.message); return; }
  // Sampled AFTER the read, so an event arriving during it still counts, and consumed on every run —
  // including the quiet ones — so credit cannot accumulate across intervals.
  const announced = rtEvents !== rtMark;
  rtMark = rtEvents;
  if (lastFingerprint === null) { lastFingerprint = fp; return; }   // first run only establishes a baseline
  if (fp === lastFingerprint) return;
  lastFingerprint = fp;
  if (!announced) {
    // The database moved and realtime said nothing about any of the three tables this fingerprint can
    // see. That is the miss the probe exists for.
    //
    // It tested `rowCache.dirty` before, which cannot tell a dropped event from a handled one:
    // `broadcast()` is what CLEARS that flag and it runs on every realtime event, so by the time the
    // probe looked the flag had almost always been cleared by the very event it was checking for. It
    // therefore fired after ORDINARY writes — on 2026-09-17 a completion realtime delivered in under
    // 20 seconds was declared missing 105 seconds later — and every firing tore down a healthy
    // socket. A recycle is a real CLOSED→SUBSCRIBED gap, so a watchdog for dropped events was
    // manufacturing the windows in which events drop.
    console.log(`freshness probe: rows changed with no realtime event (${fp}) — refetching and recycling the socket`);
    dirtyRows(); dirtyNutDay(); dirtyWorkoutDay(); dirtyHeatHistory();
    try { if (hubChannel) supa.removeChannel(hubChannel); } catch (e) { console.log('removeChannel:', e.message); }
    lastRealtimeEvent = Date.now();
    try { startRealtime(); } catch (e) { console.error('resubscribe failed:', e.message); }
    broadcast();
    // Then everything the `list_items` subscription does, because the write this probe just caught
    // may well have been one of its — the fingerprint counts list_items rows and carries the newest
    // completion stamp precisely so it can see them.
    //
    // A rebuilt status frame does not repaint a chip. The calendar surfaces re-read on the `lists`
    // frame and on nothing else but a transition minute they computed in advance, which can be hours
    // out. So whenever this probe is the path that reconciles a list write rather than the
    // subscription, every chip stays drawn from before it: on 2026-09-17 a task completed at 18:42
    // held its next transition at 21:00 and sat red on the wall, the phone and the browser while
    // /api/calendar answered `done`. Recovering the server's caches without re-announcing to the
    // clients fixes only the half nobody is looking at.
    pushLists();
    dirtyDue();
    syncBadge().catch((e) => console.error('[badge] error', e.message));
  }
}, FRESH_PROBE_MS);

// ---- auth (lib/auth.js) ----
const authed = auth.authed;

require('./routes/public')({
  GROQ_API_KEY, HUB_PASSWORD, SUPABASE_KEY, SUPABASE_URL, auth, pub, sb, sbWrite,
  settingsAll,
});

// THE SURF APP'S PAGE AND FEEDS ARE PUBLIC, and deliberately: Gnarcast (the surf-app repo) shows them
// with nothing to sign in to, and nothing in them is personal — a surf forecast, the wind and the
// buoys, all of it public NOAA and Surfline data. The page's bundle and stylesheets ride along,
// because it cannot render without them. The routes themselves are on `pub` where they are defined.
const serveStatic = express.static(path.join(__dirname, 'public'), { setHeaders: (res) => res.setHeader('Cache-Control', 'no-cache') });
pub.get(['/app.css', '/surf.css', '/dist/surf.js'], serveStatic);

// The auth gate (mounted between `pub` and `gated`, at the top). A credential is any of lib/auth.js's
// three, in the `hub` cookie or a header. The browser sends the cookie on same-origin module/css
// fetches automatically, so the static assets on `gated` need nothing more.
// The token never stays in a URL: a page load carrying `?token=` (the Pi's kiosk, which can only be
// given a URL) is signed in with the device cookie and redirected to the same URL without it, and the
// token is never logged.
const queryTokenSeen = new Set();
async function hubGate(req, res, next) {
  const q = typeof req.query.token === 'string' ? req.query.token : '';
  const nav = isNavigation(req);
  const who = auth.identify(req);
  if (who && who.kind === 'pending') return res.status(503).type('text').send('starting');
  if (nav && q && (who || auth.isDeviceToken(q))) {
    if (auth.isDeviceToken(q)) auth.setDeviceCookie(res);
    return res.redirect(302, stripToken(req.originalUrl));
  }
  if (who) {
    if (nav && who.from === 'header' && who.kind === 'device') auth.setDeviceCookie(res);
    else if (nav && who.from === 'cookie' && who.kind === 'password' && isBrowser(req)) await auth.upgrade(req, res);
    return next();
  }
  // A machine client still sending `?token=`. Accepted until each has moved to the header; the path
  // (never the token) is logged once per boot so the stragglers can be found.
  if (q && auth.isDeviceToken(q)) {
    if (!queryTokenSeen.has(req.path)) { queryTokenSeen.add(req.path); console.log(`[auth] ?token= on ${req.method} ${req.path}`); }
    return next();
  }
  if (req.path.startsWith('/api')) return res.status(401).json({ error: 'unauthorized' });
  res.redirect('/login');
}

// The login sessions: list them, revoke one (`{id}`) or every one (`{all: true}`). lib/auth.js.
gated.get('/api/auth/sessions', (req, res) => res.json({ sessions: auth.list(req) }));
gated.post('/api/auth/revoke', express.json(), async (req, res) => {
  const b = req.body || {};
  if (!b.all && !b.id) return res.status(400).json({ error: 'id or all' });
  try { res.json({ revoked: await auth.revoke({ id: String(b.id || ''), all: !!b.all }) }); }
  catch (e) { console.error('[auth] revoke failed:', e.message); res.status(502).json({ error: String(e.message || e) }); }
});

require('./routes/reports')({ gated, sb });
// Static client assets (core.js, app.css, cards/*.js), behind the gate.
// no-cache (revalidate via ETag each load) so a deploy is never masked by a stale cached asset.
gated.use(serveStatic);

gated.get('/api/status', async (req, res) => {
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
// How long a heavy read took, in the hub's log: `fly logs -a jared-status-hub | grep timing`.
function timed(handler) {
  return (req, res) => {
    const t0 = Date.now();
    res.on('finish', () => console.log(`[timing] ${req.path} ${Date.now() - t0}ms`));
    return handler(req, res);
  };
}

require('./routes/widgets')({
  WORKOUTDAY_BACKSTOP_MS, gated, nutritionCore, paceOf, sbRange, scoreOf, timed, trainingCore,
  workoutDayCache,
});

const { dirtyHeatHistory } = require('./routes/heathistory')({
  HEAT_WEEKS, gated, maintenanceWithHistory, nutritionCore, paceOf, sb, sbRange, timed,
});

const { MUTE_HOLD, recomputeMute } = require('./routes/settings')({
  GROQ_API_KEY, SUPABASE_KEY, SUPABASE_URL, dirtySettings, gated, putSetting, sb, settingsAll,
});

// app_settings.agent_mode is stored as text; these are the values that mean "on".
const agentModeOn = (v) => ['1', 'true', 'on', 'yes'].includes(String(v ?? '0').toLowerCase());

const { CLIENT_NOW_RE, dirtyNutDay } = require('./routes/logging')({
  audit, dirtyWorkoutDay, gated, produceTargets, pushDay, sb, sbRange, sbWrite, surplusCal, timed,
});

// Server-Sent Events: push assembled status to the browser, instantly on any DB change.
gated.get('/api/stream', async (req, res) => {
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
gated.get('/api/voice-messages', async (req, res) => {
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
    // ?before=<iso> pages further back: the rows older than that moment (the conversation box loads
    // the previous stretch this way as he scrolls up past the start of the current one).
    const beforeMs = Date.parse(String(req.query.before || ''));
    const before = Number.isFinite(beforeMs) ? `&created_at=lt.${encodeURIComponent(new Date(beforeMs).toISOString())}` : '';
    // One row past the limit, so the first row returned can be judged against the one before it.
    const got = (await sb(`voice_messages?focus=eq.${encodeURIComponent(focus)}${modeFilter}${before}&order=created_at.desc&limit=${limit + 1}&select=*`) || []).reverse();
    const extra = got.length > limit ? got[0] : null;
    const rows = extra ? got.slice(1) : got;
    // Where each context begins, by opensContext() — the same rule the live stream marks rows with.
    const s = await settingsAll();
    const breaks = rows.map((r, i) => {
      const prev = i > 0 ? rows[i - 1] : extra;
      return !!prev && opensContext(Date.parse(prev.created_at), Date.parse(r.created_at), mode, s);
    });
    // ?history=1 (the conversation card) → every row, the first of each context flagged so the card can
    // draw a divider there. Older contexts are the record of what he said and what came of it; hiding
    // them made a failed command look like it had never been sent.
    if (String(req.query.history || '') === '1') {
      res.json(rows.map((r, i) => (breaks[i] ? { ...r, ctx_break: true } : r)));
      return;
    }
    // Every other surface (watch, wall) shows the current context only.
    let start = Math.max(0, breaks.lastIndexOf(true));
    const resetAt = Date.parse(s.voice_reset_at || '');
    if (Number.isFinite(resetAt) && rows.length && Date.parse(rows[rows.length - 1].created_at) < resetAt) {
      start = rows.length;   // reset since the last message: nothing belongs to the new context yet
    }
    // An answer still unread stays in however old it is, with the words that asked for it, so a gap,
    // a reset or twenty newer exchanges cannot bury it (docs/WATCH.md, "Unread answers").
    // The first row of the context keeps its flag, so a surface that pages back can draw the divider.
    const shown = rows.slice(start).map((r, i) => (i === 0 && breaks[start] ? { ...r, ctx_break: true } : r));
    const have = new Set(shown.map((r) => r.id));
    const unread = (await sb(`voice_messages?focus=eq.${encodeURIComponent(focus)}${modeFilter}&role=eq.assistant&needs_read=is.true&read_at=is.null&order=created_at.desc&limit=20&select=*`) || [])
      .filter((r) => !have.has(r.id));
    const asks = unread.map((r) => r.request_id).filter(Boolean);
    const words = asks.length
      ? (await sb(`voice_messages?role=eq.user&request_id=in.(${asks.map(encodeURIComponent).join(',')})&select=*`) || [])
      : [];
    const older = [...unread, ...words.filter((r) => !have.has(r.id))]
      .sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));
    res.json([...older, ...shown]);   // oldest→newest
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});

// A request as the TV sidebar draws it before its voice_messages row exists; null for one that is not
// his words to the hub conversation (another focus, the reset sentinel) or has no transcript yet.
function requestView(r) {
  if ((r.focus || 'hub') !== 'hub' || !r.transcript || r.transcript === VOICE_RESET_SENTINEL) return null;
  return { id: r.id, text: r.transcript, status: r.status, created_at: r.created_at };
}

// Requests not yet finished: what the TV sidebar shows ahead of their rows on (re)load.
gated.get('/api/voice-pending', async (req, res) => {
  try {
    const rows = await sb('voice_requests?focus=eq.hub&status=not.in.(done,error)&order=created_at&select=id,transcript,status,focus,created_at') || [];
    res.json(rows.map(requestView).filter(Boolean));
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});

// An answer has been shown (the watch: on screen, wrist up, a couple of seconds). Stamped once; the
// row's UPDATE reaches every surface through the voice stream, so the mark clears everywhere.
gated.post('/api/voice-messages/read', express.json(), async (req, res) => {
  try {
    const id = String((req.body && req.body.id) || '');
    if (!id) return res.status(400).json({ error: 'id required' });
    await sbWrite(`voice_messages?id=eq.${encodeURIComponent(id)}&read_at=is.null`, 'PATCH', { read_at: new Date().toISOString() });
    res.json({ ok: true });
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
// Where Jared was when he spoke, if the device sent it: numbers from the watch's or the browser's
// location fix, and a place name only when the device produced one itself. Nothing here looks a
// position up, so a command never sends his location to a third party. It is stored on the request
// row, and a trigger there keeps `locations` current (data-layer 00129), which a model reads through
// `get_location` only when a request depends on where he is.
function parseLocation(src) {
  const lat = parseFloat(src && src.lat), lon = parseFloat(src && src.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  const acc = parseFloat(src.acc);
  const place = typeof src.place === 'string' ? src.place.trim().slice(0, 160) : '';
  return { lat: +lat.toFixed(5), lon: +lon.toFixed(5),
           ...(Number.isFinite(acc) ? { acc: Math.round(acc) } : {}), ...(place ? { place } : {}) };
}

// The recording behind a phone command, kept in the voice-clips bucket for as long as its voice_requests
// row (pi-desk's sweepRetention deletes both after KEEP_REQUEST_DAYS). Without it a bad transcription
// leaves nothing to go on: a clip heard as Icelandic can only be understood by listening to it, and the
// temp file is gone when this handler ends. Runs after the reply and swallows its own failure, so it can
// neither slow a command down nor fail one.
const CLIP_BUCKET = 'voice-clips';

require('./routes/healthdata')({ SUPABASE_KEY, SUPABASE_URL, gated, sbWrite });

const { cleanSaid, settleReply } = require('./routes/voice')({
  CLIENT_NOW_RE, CLIP_BUCKET, GROQ_API_KEY, SUPABASE_KEY, SUPABASE_URL, VOICE_RESET_SENTINEL,
  dirtySettings, gated, markSeen, noteRinger, parseLocation, pushVoice, putSetting, sb, sbWrite,
  seenMsgIds, settingsAll,
});

const { overdueCount, pushAll } = require('./routes/notify')({
  TV_TOKEN, auth, etNowString, gated, lateMoment, sb, sbInsert,
});

const { EPOCH, convOfRow, ensureLog, notifyAnswer, numbered, rowConv } = require('./routes/conversation')({
  cleanSaid, gated, pushAll, pushVoice, sb, sbWrite, sessionClients, settingsAll,
});


// A machine whose orchestrator has not beaten in this long is offline (lists and desk control).
const DESK_STALE_S = 90;   // 3 missed 30s beats

const { itemTitle } = require('./routes/lists')({
  DESK_STALE_S, broadcast, dirtyRows, etNowString, etStringAt, gated, lateMoment, overdueCount,
  pushLists, sb, sbWrite, settingsAll, syncBadge, timed,
});

const { TV_SIDEBAR_FONT, TV_SIDEBAR_WIDTH, tvPush } = require('./routes/tv')({ PING, gated, putSetting, sb, sbWrite, sessionClients });

const { MACHINE_NAME, machineAwake, pickFocus, pushSessions } = require('./routes/sessions')({
  DESK_STALE_S, EPOCH, TV_SIDEBAR_FONT, TV_SIDEBAR_WIDTH, cleanSaid, convOfRow, ensureLog, gated,
  markSeen, numbered, rowConv, sb, sbInsert, sbWrite, seenMsgIds, sessionClients, settingsAll,
});

require('./routes/failures')({ MACHINE_NAME, gated, machineAwake, sb, sbWrite });

// Voice SSE: streams `event: voice` frames ({kind:'message'|'focus', row}) to the /tv panel.
// Dedicated stream (not /api/stream) so the kiosk gets voice rows without the heavy status frame.
gated.get('/api/voice-stream', (req, res) => {
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
gated.get('/api/list-stream', (req, res) => {
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
// The watch's usage page: the same two windows as the walls' hairline bars. A new reading is announced
// as a `usage` frame on /api/day-stream.
gated.get('/api/usage', async (req, res) => {
  try {
    const u = buildUsage(await claudeUsageRow());
    if (!u) return res.status(404).json({ error: 'no usage reading yet' });
    res.json(u);
  } catch (e) { console.error('[usage] /api/usage:', e.message); res.status(500).json({ error: e.message }); }
});

gated.get('/api/day-stream', (req, res) => {
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache',
            Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.flushHeaders();
  dayClients.add(res);
  const ka = setInterval(() => { try { res.write(PING); } catch {} }, 25000);
  req.on('close', () => { clearInterval(ka); dayClients.delete(res); });
});

// The live microphone: a watch listening to what the phone hears (lib/livemic.js, docs/LIVE-MIC.md).
// The phone's half is a WebSocket, attached to the server below.
gated.get('/api/live-mic', livemic.listen);


const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`status-hub on :${PORT}`);
  startRealtime();
  // Time-based fields (pace drain, volume drop-off) change with the clock, not just on DB
  // edits — so re-push a fresh frame on a timer too. Push, not client polling; gated on
  // having connected clients so it's free when nobody's watching.
  setInterval(() => { if (sseClients.size) broadcast(); }, 30000);
});
livemic.attach(server, authed);

// ---- daily weight-logging push reminder (APNs). Checks each minute; fires once/day at the
// configured time unless weight or food is already logged (see lib/weightReminder.js). ----
const reminderCtx = { sb, supaInsert: sbInsert, apns, settingsAll, log: (m) => console.log('[weight-reminder]', m) };
setInterval(() => weightReminder.tick(reminderCtx).catch((e) => console.error('[weight-reminder] error', e.message)), 60000);
weightReminder.tick(reminderCtx).catch((e) => console.error('[weight-reminder]', e.message || e));  // also evaluate once on boot
console.log(`[weight-reminder] armed (apns: ${apns.configured() ? 'configured, ' + apns.ENV : 'NOT configured'})`);

// ---- reminder firing: app-push a reminder once its due time (local) has passed. Dedupe via a
// `notifications` row keyed `reminder:<id>` so it fires exactly once. Date-only dues fire at 9am local.
// A date-only due FIRES at 9am local that day; otherwise the stored local-naive timestamp is the moment.
// This is when it notifies and nothing else — whether it is late is `lateMoment`.
function dueMoment(due) {
  const d = String(due);
  return /T\d/.test(d) ? d : d.slice(0, 10) + 'T09:00:00';
}

// When a dated item stops being on time: the SCORING deadline, as a local-naive stamp. A timed item is
// late at its own moment; a date-only one is on time for its whole day and late at the next day's 4am
// origin. Everything that calls an item overdue reads this — chip colour and dimming, the badge, the
// pane's red, both widgets — so red means exactly what the score means by it. Reading `dueMoment`
// instead turned an all-day chip red at 9:30am while it was still worth its full +7.
function lateMoment(due) {
  const at = taskDeadline(due);
  return at == null ? null : new Date(at).toISOString().slice(0, 19);
}

// ---- what happens when a dated item comes due ----
//
// The scheduler below finds due items; it does not deliver them. Delivery is a named handler, so a
// second channel is a new entry here rather than surgery on the loop. Today there is exactly one —
// APNs.
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
  // category + the row id give the notification its Done button and tell the
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

// THE NEXT MOMENT anything here has to happen, spelled the way everything below compares — an ET
// `YYYY-MM-DDTHH:MM:SS` string. Between now and then there is nothing to do, so the minute tick costs
// no queries at all; a `list_items` change dirties it through the realtime subscription. The clock
// stays because a moment arriving is not a row changing — but the QUERY goes: this read every open
// dated item 1,440 times a day, overwhelmingly to learn that 9am has still not come.
let dueNextAt = '';
let dueDirty = true;
const dirtyDue = () => { dueDirty = true; };
const earlierOf = (a, b) => (!a ? (b || '') : (!b || a <= b ? a : b));

async function dueTick() {
  const nowET = etNowString();
  if (!dueDirty && (!dueNextAt || nowET < dueNextAt)) return;
  let rows;
  // Every list, not just todo — "reminder" is a predicate (has a due), not a place.
  try { rows = await sb('list_items?deleted=eq.false&completed_at=is.null&due=not.is.null&select=id,list_name,text,title,due,scheduled_at,priority,series_id,alarm'); } catch (_) { return; }
  // Only once the read succeeded: a failed read must leave the state dirty so the next tick retries.
  dueDirty = false;
  dueNextAt = '';
  if (!rows.length) return;
  // One lookup for the whole tick rather than one per item — a handful of lists, read at most once a
  // minute, and only when something is actually dated.
  let emojiOf = {};
  try { for (const l of await sb('lists?select=name,emoji')) emojiOf[l.name] = l.emoji; } catch (_) {}
  for (const r of rows) {
    if (dueMoment(r.due) > nowET) {                                   // not due yet
      dueNextAt = earlierOf(dueNextAt, dueMoment(r.due));             // …so wake for the soonest one
      continue;
    }
    // Scoped to the occurrence rather than the row. Each occurrence is its own row now, so the id
    // alone would do — except for snoozing, which moves `due` on an existing row and must be allowed
    // to fire again at its new moment. Including the due gets that for free instead of needing the
    // old ledger row deleted by hand. Do not shorten this key: see the note in CLAUDE.md.
    const dk = `reminder:${r.id}:${r.due}`;
    // AN ALARM NOTIFIES TOO, always. The TV and the open hub page are what make noise; this is the
    // layer under them, and a redundant notification costs a buzz where a missing one costs the morning.
    try { if ((await sb(`notifications?dedupe_key=eq.${encodeURIComponent(dk)}&select=id&limit=1`)).length) continue; } catch (_) { continue; }
    const handler = DUE_HANDLERS.push;
    if (handler === DUE_HANDLERS.push && !apns.configured()) continue;   // nothing to deliver through
    await handler({ ...r, emoji: emojiOf[r.list_name] }, dk);
    console.log(`[due] fired ${r.id} [${r.list_name}] "${String(r.title || r.text).slice(0, 40)}"`);
    if (r.alarm) alarmLog('hub', 'due', { title: itemTitle(r), due: r.due, ringers: ringerReport() }, r.id);
    // Nothing to re-arm. Every occurrence of a recurring thing is its own row with its own due
    // (data-layer migration 00085), so each one fires once and then stays put — which is also what
    // lets it sit there visibly overdue and drain the score until it is dealt with.
  }
  dueNextAt = earlierOf(dueNextAt, await closeExempt(nowET, rows));
  // The badge follows what just fired or closed. It is pushed from the `list_items` subscription too,
  // so its own timer can be a backstop rather than the thing that keeps the icon honest.
  syncBadge().catch((e) => console.error('[badge] error', e.message));
}

// Exempt items close themselves once their moment has gone. A shift is not something he finishes;
// it is something that happens and is then over, and leaving it on the list would make him tidy up
// after his own calendar. Uses the SCORING deadline rather than the firing time, so an all-day
// exempt item closes at the end of its day instead of at 9am when it notified.
// Takes the rows `dueTick` has already read rather than reading them again: that query was this same
// open-dated-item set filtered to `priority=lt.0`, and the caller's rows carry `priority` already.
// Returns the next exempt deadline still in the future, so the caller knows when to wake.
async function closeExempt(nowET, rows) {
  const now = Date.parse(nowET + 'Z');   // both sides are naive ET, compared in one pseudo-UTC space
  let next = '';
  for (const r of rows || []) {
    if (!(Number(r.priority) < 0)) continue;   // exempt items only — what the old query's filter said
    // An ALARM is never closed here. The page rings it until STOP, and STOP is what completes it;
    // closing it on time would silence the alarm in the minute it starts.
    if (r.alarm) continue;
    const deadline = taskDeadline(r.scheduled_at || r.due);
    if (deadline == null) continue;
    if (deadline > now) {
      next = earlierOf(next, new Date(deadline).toISOString().slice(0, 19));
      continue;
    }
    try {
      await sbWrite(`list_items?id=eq.${encodeURIComponent(r.id)}`, 'PATCH',
        { completed_at: etNowString(), updated: new Date().toISOString() });
      console.log(`[due] closed exempt ${r.id} "${String(r.title || r.text).slice(0, 40)}"`);
    } catch (e) { console.error('[due] closeExempt:', e.message); }
  }
  return next;
}
// The hub's heartbeat comes from this loop: it runs every minute doing real work, so a hub whose event
// loop is wedged goes quiet to the responder the same way a dead one does.
setInterval(() => { ops.beat(60); dueTick().catch((e) => console.error('[due] error', e.message)); }, 60000);
ops.beat(60);   // at boot too, so a restart does not leave a minute's gap on top of the deploy's own

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
// A BACKSTOP, not the mechanism — an INSERT on `reports` fires reportTick directly (startRealtime).
// This only covers an event the subscription missed while deaf, so it is minutes rather than the 20s
// that made it the fastest database timer here.
const REPORT_BACKSTOP_MS = 10 * 60 * 1000;
setInterval(() => reportTick().catch((e) => console.error('[report] error', e.message)), REPORT_BACKSTOP_MS);
reportTick().catch((e) => console.error('[report]', e.message || e));
dueTick().catch((e) => console.error('[due]', e.message || e));
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

// A BACKSTOP. The badge is pushed by the `list_items` subscription and by `dueTick` when something
// fires, so this only catches a change that arrived while the socket was deaf. It was a 60s count of
// every open dated item, and the count changes a handful of times a day.
const BADGE_BACKSTOP_MS = 10 * 60 * 1000;
setInterval(() => syncBadge().catch((e) => console.error('[badge] error', e.message)), BADGE_BACKSTOP_MS);
syncBadge().catch((e) => console.error('[badge]', e.message || e));

// ---- retention. Clearing is a SOFT delete so it can be undone, but that's only tenable if the rows
// don't pile up forever. Anything cleared longer ago than the window is hard-deleted. Hourly is
// plenty for a 30-day horizon; exactness doesn't matter here.
const PURGE_AFTER_DAYS = 30;
async function purgeCleared() {
  const cutoff = new Date(Date.now() - PURGE_AFTER_DAYS * 86400000).toISOString();
  try {
    await sbWrite(`list_items?deleted=eq.true&updated=lt.${encodeURIComponent(cutoff)}`, 'DELETE');
  } catch (e) { console.error('[purge] list_items:', e.message); }
}
setInterval(() => purgeCleared().catch((e) => console.error('[purge]', e.message || e)), 3600000);
purgeCleared().catch((e) => console.error('[purge]', e.message || e));
