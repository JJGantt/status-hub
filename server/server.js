'use strict';
const express = require('express');
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');
const WebSocket = require('ws');
const { estimateMaintenance } = require('./maintenance');
const pace = require('./pace');
const { computeVolume } = require('./volume');
const BODY_SVG = require('./bodymap');

const PORT = process.env.PORT || 8080;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const HUB_PASSWORD = process.env.HUB_PASSWORD || 'changeme';
const TZ = process.env.TZ_DISPLAY || 'America/New_York';
// Cookie token derived from the password — set once per device, never expires (no logout).
const TOKEN = crypto.createHash('sha256').update('status-hub:' + HUB_PASSWORD).digest('hex');

// Supabase client used only for the Realtime subscription (push). Data reads use sb() REST.
const supa = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: false },
  realtime: { transport: WebSocket },
});
const sseClients = new Set();

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
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method,
    headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`supabase ${method} ${path} -> ${r.status}`);
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

// ---- date helpers (in the display timezone) ----
// A nutrition "day" runs DAY_START_HOUR→DAY_START_HOUR local time, so a late-night
// snack (before 4am) counts toward the day that just ended. This is a display-only
// window over the real occurred_at timestamps — storage is never touched, so changing
// this one number instantly re-groups all history with no migration.
const DAY_START_HOUR = 4;
function localDate(d = new Date()) {
  return d.toLocaleDateString('en-CA', { timeZone: TZ }); // YYYY-MM-DD
}
// [start, end) occurred_at bounds for the nutrition day currently in progress.
function nutritionWindow() {
  const hh = String(DAY_START_HOUR).padStart(2, '0');
  const dayStart = localDate(new Date(Date.now() - DAY_START_HOUR * 3600000)); // pre-4am → prior day
  const dayEnd = localDate(new Date(Date.parse(dayStart + 'T12:00:00Z') + 86400000));
  return { day: dayStart, start: `${dayStart}T${hh}:00:00`, end: `${dayEnd}T${hh}:00:00` };
}
function lastNDates(n) {
  const today = localDate();
  const anchor = new Date(today + 'T12:00:00Z'); // noon-UTC anchor avoids day flips
  const out = [];
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(anchor.getTime() - i * 86400000);
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
}
// Current time as minutes into the 4am-origin day, in the display timezone.
function nowOffsetTZ() {
  const f = new Intl.DateTimeFormat('en-US', { timeZone: TZ, hour12: false, hour: '2-digit', minute: '2-digit' });
  const parts = f.formatToParts(new Date());
  const hh = Number(parts.find((p) => p.type === 'hour').value) % 24;
  const mm = Number(parts.find((p) => p.type === 'minute').value);
  return pace.offsetFromHM(hh, mm);
}
// Which 4am-day a naive-local occurred_at timestamp belongs to (matches nutritionWindow()).
function dayBucketOf(ts) {
  const m = String(ts).match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?/);
  if (!m) return String(ts).slice(0, 10);
  const d = new Date(+m[1], +m[2] - 1, +m[3], +m[4] - DAY_START_HOUR, +m[5], +(m[6] || 0));
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// ---- workout volume heatmap: per-day set counts laid out as week-columns (GitHub style) ----
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function buildWorkoutHeatmap(rows, weeks = 18) {
  const counts = {};
  for (const r of rows || []) { const d = String(r.occurred_at).slice(0, 10); counts[d] = (counts[d] || 0) + 1; }
  const today = localDate();
  const anchor = new Date(today + 'T12:00:00Z');
  const dow = anchor.getUTCDay(); // 0=Sun .. 6=Sat
  const startMs = anchor.getTime() - dow * 86400000 - (weeks - 1) * 7 * 86400000;
  // self-scaling intensity: your busiest day = brightest, the rest scale relative to it
  let maxCount = 0; for (const k in counts) if (k <= today && counts[k] > maxCount) maxCount = counts[k];
  const level = (c) => (c <= 0 ? 0 : Math.min(4, Math.max(1, Math.ceil((4 * c) / (maxCount || 1)))));
  const cols = [], months = [];
  let prevMon = -1;
  for (let w = 0; w < weeks; w++) {
    const col = [];
    for (let d = 0; d < 7; d++) {
      const ds = new Date(startMs + (w * 7 + d) * 86400000).toISOString().slice(0, 10);
      const c = counts[ds] || 0;
      col.push({ date: ds, count: c, level: ds > today ? -1 : level(c), today: ds === today });
    }
    const m = Number(col[0].date.slice(5, 7)) - 1;       // month of this column's first day
    months.push(m !== prevMon ? MON[m] : '');            // label only when the month changes
    prevMon = m;
    cols.push(col);
  }
  return { weeks: cols, months, maxCount };
}

// ---- assemble dashboard data ----
async function buildStatus() {
  const win = nutritionWindow();
  const today = win.day;
  const week = lastNDates(7);
  const histStart = localDate(new Date(Date.now() - 40 * 86400000)); // intake history for the maintenance trend
  const heatStart = localDate(new Date(Date.now() - 140 * 86400000)); // ~20 weeks for the workout volume heatmap

  const [deviceRows, entries, setRows, weightRows, histRows, muscleRows, heatRows] = await Promise.all([
    sb('device_status?select=*'),
    sb(`nutrition_entries?occurred_at=gte.${win.start}&occurred_at=lt.${win.end}&select=calories,protein_g,carbs_g,fat_g`),
    sb(`sets?occurred_at=gte.${week[0]}T00:00:00&select=occurred_at,exercise,muscles_override`),
    sb('weight_log?select=date,weight_lbs&order=date.asc'),
    sb(`nutrition_entries?occurred_at=gte.${histStart}T00:00:00&select=occurred_at,calories`),
    sb('exercise_muscles?select=name,muscle,contribution'),
    sbRange(`sets?occurred_at=gte.${heatStart}T00:00:00&select=occurred_at&order=occurred_at`),
  ]);

  const litter = (deviceRows || [])[0] || null;

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

  // ---- workout volume heatmap (GitHub-contribution style) ----
  const heatmap = buildWorkoutHeatmap(heatRows);

  return { today, litter, nutrition, maintenance, pace: paceData, volume, heatmap, generated_at: new Date().toISOString() };
}

// ---- realtime push: recompute + push to all connected browsers on any DB change ----
async function broadcast() {
  let frame;
  try { frame = 'data: ' + JSON.stringify(await buildStatus()) + '\n\n'; }
  catch (e) { console.error('broadcast build failed:', e.message); return; }
  for (const res of sseClients) { try { res.write(frame); } catch {} }
}

function startRealtime() {
  supa.channel('hub-changes')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'device_status' }, broadcast)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'nutrition_entries' }, broadcast)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'sets' }, broadcast)
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

app.use((req, res, next) => {
  if (authed(req)) return next();
  if (req.path.startsWith('/api')) return res.status(401).json({ error: 'unauthorized' });
  res.redirect('/login');
});

app.get('/', (req, res) => res.type('html').send(dashboardHtml()));
app.get('/api/status', async (req, res) => {
  try { res.json(await buildStatus()); }
  catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});

// A single day's sets, grouped by exercise — for the heatmap day click-through.
app.get('/api/workout-day', async (req, res) => {
  try {
    const date = String(req.query.date || '').slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: 'bad date' });
    const rows = await sbRange(`sets?occurred_at=gte.${date}T00:00:00&occurred_at=lte.${date}T23:59:59&select=occurred_at,exercise,weight_lbs,reps&order=occurred_at`);
    const order = [], byEx = {};
    for (const r of rows) { if (!byEx[r.exercise]) { byEx[r.exercise] = []; order.push(r.exercise); } byEx[r.exercise].push({ weight_lbs: r.weight_lbs, reps: r.reps }); }
    res.json({ date, total: rows.length, exercises: order.map((n) => ({ name: n, sets: byEx[n] })) });
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

app.listen(PORT, '0.0.0.0', () => {
  console.log(`status-hub on :${PORT}`);
  startRealtime();
  // Time-based fields (pace drain, volume drop-off) change with the clock, not just on DB
  // edits — so re-push a fresh frame on a timer too. Push, not client polling; gated on
  // having connected clients so it's free when nobody's watching.
  setInterval(() => { if (sseClients.size) broadcast(); }, 30000);
});

// ---- HTML ----
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

function dashboardHtml() {
  return `<!doctype html><html><head><meta charset=utf-8>
<meta name=viewport content="width=device-width,initial-scale=1">
<title>Status Hub</title>
<link href="https://cdn.jsdelivr.net/npm/gridstack@10.3.1/dist/gridstack.min.css" rel="stylesheet">
<script src="https://cdn.jsdelivr.net/npm/gridstack@10.3.1/dist/gridstack-all.js"></script>
<style>
*{box-sizing:border-box} body{background:#0b0d10;color:#e8eaed;font:16px/1.4 system-ui;margin:0;padding:12px}
.grid-stack{max-width:1240px;margin:0 auto}
.grid-stack-item-content{overflow:visible}
.drag-handle{position:absolute;top:9px;right:11px;z-index:6;cursor:move;color:#3a434f;font-size:15px;line-height:1;user-select:none}
.drag-handle:hover{color:#8b96a5}
.card{height:100%;overflow:auto;background:#151a20;border:1px solid #222a33;border-radius:16px;padding:20px}
.card h2{margin:0 0 14px;font-size:14px;letter-spacing:.08em;text-transform:uppercase;color:#8b96a5;font-weight:600}
.big{font-size:40px;font-weight:700;line-height:1}
.sub{color:#8b96a5;font-size:14px;margin-top:6px}
.row{display:flex;justify-content:space-between;padding:6px 0;border-top:1px solid #222a33}
.macros{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-top:14px}
.macro{background:#0e1318;border-radius:10px;padding:10px;text-align:center}
.macro .n{font-size:22px;font-weight:700}.macro .l{font-size:12px;color:#8b96a5}
.rings{display:flex;justify-content:space-around;gap:8px;margin-bottom:18px}
.ring svg{display:block}
.ring text.rg{font-size:15px;font-weight:700;fill:#c7ced8}
.ring text.rd{font-size:13px;font-weight:700}
.obars{display:flex;flex-direction:column;gap:11px}
.obar-l{display:flex;justify-content:space-between;font-size:13px;margin-bottom:5px}
.obar-l span:first-child{color:#c7ced8;font-weight:600}.obar-l span:last-child{color:#8b96a5}
.obar-track{position:relative;display:flex;height:12px;background:#0e1318;border-radius:6px;overflow:hidden;border:1px solid #222a33}
.obar-fill{height:100%;background:#3b82f6;transition:width .4s ease}
.obar-over{height:100%;background:#d946ef;transition:width .4s ease}
.pnote{color:#8b96a5;font-size:12px;margin-top:14px}
.vgrp h3{font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:#6b7686;margin:12px 0 6px;font-weight:600}
.vrow{margin-bottom:8px}
.vrow-l{display:flex;justify-content:space-between;font-size:12px;margin-bottom:3px}
.vrow-l .nm{color:#c7ced8}.vrow-l .vl{color:#8b96a5}
.vtrack{display:flex;height:10px;background:#0e1318;border-radius:5px;overflow:hidden;border:1px solid #222a33}
.vstable{height:100%;transition:width .4s ease}
.vdrop{height:100%;background:repeating-linear-gradient(45deg,#4b5563,#4b5563 3px,#39414d 3px,#39414d 6px)}
#body .bodysvg{width:100%;height:auto;max-height:520px;display:block;margin-top:4px}
#body .bodysvg path{fill:#222a33;stroke:#0b0d10;stroke-width:0.25;transition:fill .4s ease}
.hmonths{display:flex;gap:2.5px;font-size:9px;color:#8b96a5;margin-left:30px;height:13px}
.hm{flex:1 1 0;min-width:0;white-space:nowrap}
.hbody{display:flex;gap:4px}
.hdows{display:flex;flex-direction:column;gap:2.5px;width:26px;flex:none}
.hd{flex:1;font-size:9px;color:#8b96a5;text-align:right;padding-right:5px;display:flex;align-items:center;justify-content:flex-end}
.heat{display:flex;gap:2.5px;flex:1 1 0}
.hcol{display:flex;flex-direction:column;gap:2.5px;flex:1 1 0;min-width:0}
.hcell{aspect-ratio:1;width:100%;border-radius:2px;background:#2a313a}
#daymodal{display:none;position:fixed;inset:0;background:rgba(0,0,0,.6);place-items:center;z-index:50;padding:18px}
.modal-card{background:#151a20;border:1px solid #222a33;border-radius:14px;padding:22px;max-width:440px;width:100%;max-height:80vh;overflow:auto;position:relative}
.modal-close{position:absolute;top:12px;right:16px;color:#8b96a5;cursor:pointer;font-size:18px}
.modal-card h3{margin:0 0 12px;font-size:16px}
.dex{padding:9px 0;border-top:1px solid #222a33}
.dex-n{font-weight:600;margin-bottom:5px}
.dset{display:inline-block;background:#0e1318;border-radius:6px;padding:3px 8px;margin:2px 5px 2px 0;font-size:12px;color:#c7ced8}
.dot{display:inline-block;width:10px;height:10px;border-radius:50%;margin-right:8px;vertical-align:middle}
.foot{max-width:1100px;margin:14px auto 0;color:#566;font-size:12px;text-align:right}
</style></head><body>
<div class="grid-stack">
  <div class="grid-stack-item" gs-id="litter" gs-w="4" gs-h="3"><div class="grid-stack-item-content"><span class=drag-handle>⠿</span><div class=card id=litter><h2>Litter-Robot</h2><div class=big>…</div></div></div></div>
  <div class="grid-stack-item" gs-id="nutrition" gs-w="4" gs-h="6"><div class="grid-stack-item-content"><span class=drag-handle>⠿</span><div class=card id=nutrition><h2>Today · Nutrition</h2><div class=big>…</div></div></div></div>
  <div class="grid-stack-item" gs-id="body" gs-w="4" gs-h="9"><div class="grid-stack-item-content"><span class=drag-handle>⠿</span><div class=card id=body><h2>Muscle Map · 7-Day</h2>${BODY_SVG}</div></div></div>
  <div class="grid-stack-item" gs-id="volume" gs-w="4" gs-h="8"><div class="grid-stack-item-content"><span class=drag-handle>⠿</span><div class=card id=volume><h2>Muscle Volume · 7-Day</h2><div>…</div></div></div></div>
  <div class="grid-stack-item" gs-id="workouts" gs-w="8" gs-h="4"><div class="grid-stack-item-content"><span class=drag-handle>⠿</span><div class=card id=workouts><h2>Workout Volume</h2><div>…</div></div></div></div>
</div>
<div class=foot id=foot></div>
<div id=daymodal><div class=modal-card><div class=modal-close id=dayclose>✕</div><div id=daycontent></div></div></div>
<script>
const STATUS_LABEL={READY:'Ready',CLEAN_CYCLE:'Cleaning',CAT_SENSOR_INTERRUPTED:'Stuck (auto-resuming)',
 PAUSED:'Paused',CAT_DETECTED:'Cat detected',CAT_SENSOR_TIMING:'Waiting (post-cat)',
 CLEAN_CYCLE_COMPLETE:'Cycle complete',DRAWER_FULL:'Drawer full!',OFFLINE:'Offline',OFF:'Off'};
const STATUS_COLOR={READY:'#3b82f6',CLEAN_CYCLE:'#eab308',CAT_SENSOR_INTERRUPTED:'#f97316',
 PAUSED:'#f97316',DRAWER_FULL:'#ef4444',OFFLINE:'#ef4444',OFF:'#566'};
// hue gradient: t=0 green -> t=1 red, through real yellow at t=0.5
function hueColor(t){const h=120*(1-Math.max(0,Math.min(1,t)));return 'hsl('+h+',85%,55%)';}
function litterColor(v){return v==null?'#8b96a5':hueColor((90-v)/20);}  // 90% green -> 70% red
function drawerColor(v){return v==null?'#8b96a5':hueColor((v-75)/20);}  // 75% green -> 95% red
function ago(iso){if(!iso)return'—';const s=(Date.now()-new Date(iso))/1000;
 if(s<90)return Math.round(s)+'s ago';if(s<5400)return Math.round(s/60)+'m ago';return Math.round(s/3600)+'h ago';}
let last=null;
function fmtFoot(){if(!last)return;const L=last.litter||{};
 document.getElementById('foot').textContent='litter updated '+ago(L.updated_at)+' · '+new Date().toLocaleTimeString();}
// Map a vulovix body-map region id → one of our tracked muscles.
function muscleForId(id){
 if(id.indexOf('shoulder-front')===0)return'front_delts';
 if(id.indexOf('shoulder-side')===0)return'side_delts';
 if(id.indexOf('deltoid-rear')===0)return'rear_delts';
 if(id.indexOf('biceps')===0)return'biceps';
 if(id.indexOf('forearm')===0)return'forearms';
 if(id.indexOf('chest-upper')===0)return'upper_chest';
 if(id.indexOf('chest-lower')===0)return'lower_chest';
 if(id.indexOf('abs-')===0)return'abs';
 if(id.indexOf('obliques')===0)return'abs'; // asset mislabels the central six-pack as "obliques" — it's rectus abdominis
 if(id.indexOf('traps-upper')===0)return'upper_traps';
 if(id.indexOf('traps-mid')===0||id.indexOf('traps-lower')===0)return'mid_back';
 if(id.indexOf('lats-')===0)return'lats';
 if(id.indexOf('triceps-long')===0)return'triceps_long';
 if(id.indexOf('triceps-lateral')===0)return'triceps_lateral';
 if(id.indexOf('quads')===0)return'quads';
 if(id.indexOf('gluteus')===0)return'glutes';
 if(id.indexOf('calves')===0)return'gastrocnemius';
 if(id.indexOf('tibialis')===0)return'gastrocnemius';
 if(id.indexOf('hamstrings')===0)return'hamstrings';
 if(id.indexOf('lower-back')===0)return'erectors';
 if(id.indexOf('adductors')===0)return'adductors';
 if(id.indexOf('hip-flexor')===0)return'hip_flexors';
 return null;
}
function render(s){
 if(!s||s.error){return;}
 last=s;
 // litter
 const L=s.litter||{};const st=L.status||'OFFLINE';
 document.getElementById('litter').innerHTML='<h2>Litter-Robot</h2>'+
  '<div class=big><span class=dot style="background:'+(STATUS_COLOR[st]||'#8b96a5')+'"></span>'+(STATUS_LABEL[st]||st)+'</div>'+
  '<div class=row><span>Litter level</span><b style="color:'+litterColor(L.litter_level_pct)+'">'+(L.litter_level_pct!=null?L.litter_level_pct+'%':'—')+'</b></div>'+
  '<div class=row><span>Waste drawer</span><b style="color:'+drawerColor(L.waste_drawer_pct)+'">'+(L.waste_drawer_pct!=null?L.waste_drawer_pct+'%':'—')+'</b></div>';
 // nutrition — pace rings (P/C/F: deviation from pace, drain/overfill) + overall progress bars
 const P=s.pace||{};const PM=P.macros||{};
 const RC=2*Math.PI*34; // ring circumference (r=34)
 const ring=(glyph,m)=>{if(!m)return'';
  const base=(m.ring_base||0)*RC, over=(m.ring_over||0)*RC, dev=m.dev_g||0;
  const sign=dev>0?'+':'', numCol=dev<0?'#f87171':dev>0?(m.over_color||'#f59e0b'):'#22c55e';
  const arc=(len,col)=>'<circle cx="40" cy="40" r="34" fill="none" stroke="'+col+'" stroke-width="7" stroke-dasharray="'+len+' '+(RC-len)+'" stroke-linecap="round" transform="rotate(-90 40 40)" />';
  return '<div class="ring"><svg viewBox="0 0 80 80" width="82" height="82">'+
   '<circle cx="40" cy="40" r="34" fill="none" stroke="#0e1318" stroke-width="7" />'+
   arc(base,m.base_color)+(over>0?arc(over,m.over_color):'')+
   '<text x="40" y="37" text-anchor="middle" class="rg">'+glyph+'</text>'+
   '<text x="40" y="54" text-anchor="middle" class="rd" fill="'+numCol+'">'+sign+dev+'g</text>'+
   '</svg></div>';};
 const obar=(nm,m,unit)=>{if(!m)return'';
  const pct=Math.min(1,m.progress||0)*100, over=Math.max(0,(m.progress||0)-1), overpct=Math.min(1,over)*100;
  return '<div class=obar><div class=obar-l><span>'+nm+'</span>'+
   '<span>'+(m.consumed||0)+(unit||'')+' / '+(m.goal||0)+(unit||'')+'</span></div>'+
   '<div class=obar-track><div class=obar-fill style="width:'+pct+'%"></div>'+
   (over>0?'<div class=obar-over style="width:'+overpct+'%"></div>':'')+'</div></div>';};
 document.getElementById('nutrition').innerHTML='<h2>Today · Nutrition</h2>'+
  '<div class=rings>'+ring('P',PM.protein_g)+ring('C',PM.carbs_g)+ring('F',PM.fat_g)+'</div>'+
  '<div class=obars>'+obar('Calories',PM.calories,'')+obar('Protein',PM.protein_g,'g')+
   obar('Carbs',PM.carbs_g,'g')+obar('Fat',PM.fat_g,'g')+'</div>'+
  '<div class=pnote>'+(P.window_label||'')+'</div>';
 // workout volume heatmap (GitHub-contribution style: month labels top, weekdays left, today outlined)
 const H=s.heatmap||{weeks:[],months:[]};
 const HC=['#2a313a','#0e4429','#006d32','#26a641','#39d353']; // [0]=empty (visible vs the card bg)
 const monthRow=(H.months||[]).map(m=>'<div class=hm>'+m+'</div>').join('');
 const grid=(H.weeks||[]).map(col=>'<div class=hcol>'+col.map(d=>{
   const bg=d.level<0?'transparent':HC[d.level];
   const out=d.today?';outline:1.5px solid #e8eaed;outline-offset:-1px':'';
   const click=d.level>=0?' data-date="'+d.date+'"':'';
   const cur=d.level>=0?';cursor:pointer':'';
   return '<div class=hcell'+click+' title="'+d.date+': '+d.count+' set'+(d.count===1?'':'s')+'" style="background:'+bg+out+cur+'"></div>';
 }).join('')+'</div>').join('');
 const dowLabels=['','Mon','','Wed','','Fri',''].map(x=>'<div class=hd>'+x+'</div>').join('');
 document.getElementById('workouts').innerHTML='<h2>Workout Volume</h2>'+
  '<div class=hmonths>'+monthRow+'</div>'+
  '<div class=hbody><div class=hdows>'+dowLabels+'</div><div class=heat>'+grid+'</div></div>';
 // muscle volume gauges
 const V=s.volume||{};
 const vgroups=(V.groups||[]).map(g=>{
  const rows=g.muscles.map(m=>{
   const stable=Math.round((m.stable_fill||0)*100), drop=Math.round((m.drop_fill||0)*100);
   const dropTxt=m.dropping>0?' <span style="color:#6b7686">(−'+m.dropping+' tmrw)</span>':'';
   // at zero, show a tiny red sliver (not an empty track) so "uh-oh" is visible
   const bars=(stable+drop===0)
    ? '<div class=vstable style="width:4%;background:'+m.color+'"></div>'
    : '<div class=vstable style="width:'+stable+'%;background:'+m.color+'"></div><div class=vdrop style="width:'+drop+'%"></div>';
   return '<div class=vrow><div class=vrow-l><span class=nm>'+m.label+'</span><span class=vl>'+m.sets+' / '+m.target+dropTxt+'</span></div>'+
    '<div class=vtrack>'+bars+'</div></div>';
  }).join('');
  return '<div class=vgrp><h3>'+g.group+'</h3>'+rows+'</div>';
 }).join('');
 document.getElementById('volume').innerHTML='<h2>Muscle Volume · 7-Day</h2>'+vgroups;
 // body map: paint each fine region by its mapped muscle's color
 const MC=(V.muscle_colors)||{};
 document.querySelectorAll('#body path[data-r]').forEach(p=>{const m=muscleForId(p.getAttribute('data-r'));if(m&&MC[m])p.style.fill=MC[m];});
 fmtFoot();
}
const es=new EventSource('/api/stream');
es.onmessage=e=>{try{render(JSON.parse(e.data));}catch(_){}};
setInterval(fmtFoot,1000);  // tick the "updated X ago" live against the real clock
async function openDay(date){
 let j; try{ j=await (await fetch('/api/workout-day?date='+date)).json(); }catch(_){ return; }
 const dd=document.getElementById('daycontent');
 if(!j.exercises||!j.exercises.length){ dd.innerHTML='<h3>'+date+'</h3><div class=sub>No sets logged.</div>'; }
 else{ let h='<h3>'+date+' · '+j.total+' sets</h3>';
  for(const ex of j.exercises){ h+='<div class=dex><div class=dex-n>'+ex.name+'</div>'+ex.sets.map(s=>'<span class=dset>'+(s.weight_lbs===0?'BW':(s.weight_lbs+' lb'))+' × '+s.reps+'</span>').join('')+'</div>'; }
  dd.innerHTML=h; }
 document.getElementById('daymodal').style.display='grid';
}
document.addEventListener('click',e=>{
 const cell=e.target.closest('.hcell');
 if(cell&&cell.dataset.date){ openDay(cell.dataset.date); return; }
 if(e.target.id==='daymodal'||e.target.id==='dayclose'){ document.getElementById('daymodal').style.display='none'; }
});
// draggable / resizable dashboard — drag by the grip handle, resize from the corner; layout saved per device
const grid=GridStack.init({column:12,cellHeight:74,margin:8,handle:'.drag-handle',float:false,columnOpts:{breakpoints:[{w:768,c:1}]}});
const SAVED=localStorage.getItem('hublayout');
if(SAVED){try{grid.load(JSON.parse(SAVED));}catch(_){}}
grid.on('change',()=>{try{localStorage.setItem('hublayout',JSON.stringify(grid.save(false)));}catch(_){}});
</script></body></html>`;
}
