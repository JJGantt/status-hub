'use strict';
const express = require('express');
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');
const WebSocket = require('ws');
const { estimateMaintenance } = require('./maintenance');
const pace = require('./pace');

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

// ---- workout category label ----
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
function categoryLabel(cats) {
  if (!cats || !cats.length) return null;
  const ppl = ['push', 'pull', 'legs'].filter((c) => cats.includes(c));
  const extra = cats.filter((c) => !['push', 'pull', 'legs'].includes(c));
  const parts = ppl.length === 3 ? ['Full body'] : ppl.map(cap);
  extra.forEach((c) => parts.push(cap(c)));
  return parts.join(' / ') || null;
}

// ---- assemble dashboard data ----
async function buildStatus() {
  const win = nutritionWindow();
  const today = win.day;
  const week = lastNDates(7);
  const histStart = localDate(new Date(Date.now() - 40 * 86400000)); // intake history for the maintenance trend

  const [deviceRows, entries, setRows, catRows, weightRows, histRows] = await Promise.all([
    sb('device_status?select=*'),
    sb(`nutrition_entries?occurred_at=gte.${win.start}&occurred_at=lt.${win.end}&select=calories,protein_g,carbs_g,fat_g`),
    sb(`sets?occurred_at=gte.${week[0]}T00:00:00&select=occurred_at,exercise`),
    sb('exercise_catalog?select=name,categories'),
    sb('weight_log?select=date,weight_lbs&order=date.asc'),
    sb(`nutrition_entries?occurred_at=gte.${histStart}T00:00:00&select=occurred_at,calories`),
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

  const catByName = {};
  for (const c of catRows || []) catByName[String(c.name).toLowerCase()] = c.categories || [];
  const byDay = {};
  for (const s of setRows || []) {
    const d = String(s.occurred_at).slice(0, 10);
    const set = byDay[d] || new Set();
    for (const c of (catByName[String(s.exercise).toLowerCase()] || [])) set.add(c);
    byDay[d] = set;
  }
  const workouts = week.map((d) => ({
    date: d,
    label: byDay[d] ? categoryLabel([...byDay[d]]) : null,
  }));

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

  return { today, litter, nutrition, maintenance, pace: paceData, workouts, generated_at: new Date().toISOString() };
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

app.listen(PORT, '0.0.0.0', () => { console.log(`status-hub on :${PORT}`); startRealtime(); });

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
<title>Status Hub</title><style>
*{box-sizing:border-box} body{background:#0b0d10;color:#e8eaed;font:16px/1.4 system-ui;margin:0;padding:18px}
.grid{display:grid;gap:18px;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));max-width:1100px;margin:0 auto}
.card{background:#151a20;border:1px solid #222a33;border-radius:16px;padding:20px}
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
.week{display:grid;grid-template-columns:repeat(7,1fr);gap:8px}
.day{background:#0e1318;border-radius:10px;padding:10px 6px;text-align:center;border-top:3px solid #2a313a}
.day .d{font-size:12px;color:#8b96a5}.day .w{font-size:13px;font-weight:600;margin-top:6px;min-height:32px;display:flex;align-items:center;justify-content:center}
.none{color:#3a434f}
.dot{display:inline-block;width:10px;height:10px;border-radius:50%;margin-right:8px;vertical-align:middle}
.foot{max-width:1100px;margin:14px auto 0;color:#566;font-size:12px;text-align:right}
</style></head><body>
<div class=grid>
  <div class=card id=litter><h2>Litter-Robot</h2><div class=big>…</div></div>
  <div class=card id=nutrition><h2>Today · Nutrition</h2><div class=big>…</div></div>
  <div class=card id=maintenance><h2>Maintenance · Goal</h2><div class=big>…</div></div>
  <div class=card id=workouts><h2>Workouts · Last 7 Days</h2><div>…</div></div>
</div>
<div class=foot id=foot></div>
<script>
const STATUS_LABEL={READY:'Ready',CLEAN_CYCLE:'Cleaning',CAT_SENSOR_INTERRUPTED:'Stuck (auto-resuming)',
 PAUSED:'Paused',CAT_DETECTED:'Cat detected',CAT_SENSOR_TIMING:'Waiting (post-cat)',
 CLEAN_CYCLE_COMPLETE:'Cycle complete',DRAWER_FULL:'Drawer full!',OFFLINE:'Offline',OFF:'Off'};
const STATUS_COLOR={READY:'#3b82f6',CLEAN_CYCLE:'#eab308',CAT_SENSOR_INTERRUPTED:'#f97316',
 PAUSED:'#f97316',DRAWER_FULL:'#ef4444',OFFLINE:'#ef4444',OFF:'#566'};
const CAT_COLOR={push:'#ef4444',pull:'#22c55e',legs:'#3b82f6'};
// hue gradient: t=0 green -> t=1 red, through real yellow at t=0.5
function hueColor(t){const h=120*(1-Math.max(0,Math.min(1,t)));return 'hsl('+h+',85%,55%)';}
function litterColor(v){return v==null?'#8b96a5':hueColor((90-v)/20);}  // 90% green -> 70% red
function drawerColor(v){return v==null?'#8b96a5':hueColor((v-75)/20);}  // 75% green -> 95% red
function ago(iso){if(!iso)return'—';const s=(Date.now()-new Date(iso))/1000;
 if(s<90)return Math.round(s)+'s ago';if(s<5400)return Math.round(s/60)+'m ago';return Math.round(s/3600)+'h ago';}
let last=null;
function fmtFoot(){if(!last)return;const L=last.litter||{};
 document.getElementById('foot').textContent='litter updated '+ago(L.updated_at)+' · '+new Date().toLocaleTimeString();}
function dayColor(label){if(!label)return'#2a313a';const l=label.toLowerCase();
 if(l.includes('full body'))return'#e8eaed';if(l.includes('push'))return CAT_COLOR.push;
 if(l.includes('pull'))return CAT_COLOR.pull;if(l.includes('legs'))return CAT_COLOR.legs;return'#a855f7';}
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
  '<div class=pnote>eating window '+(P.window_label||'—')+' · rings show grams off pace (− behind, + over)</div>';
 // maintenance
 const M=s.maintenance||{};const C=M.coverage||{};const live=M.source==='live';
 const tlw=M.trend_lb_per_week;
 const trendTxt=tlw==null?'—':(tlw>0?'▲ +':tlw<0?'▼ ':'± ')+tlw.toFixed(2)+' lb/wk';
 const trendCol=tlw==null?'#8b96a5':tlw>0?'#22c55e':tlw<0?'#f97316':'#8b96a5';
 let dataLine;
 if(live){dataLine='Live · measured from '+C.weighins+' weigh-ins & '+C.intake_days+' logged days'+(C.intake_days_excluded?' ('+C.intake_days_excluded+' under-logged ignored)':'');}
 else{const nW=Math.max(0,(C.need_weighins||0)-(C.weighins||0)),nI=Math.max(0,(C.need_intake_days||0)-(C.intake_days||0));
  dataLine='Calibrating — using cold-start anchor. Need '+nW+' more weigh-in'+(nW===1?'':'s')+', '+nI+' more logged day'+(nI===1?'':'s')+'.';}
 document.getElementById('maintenance').innerHTML='<h2>Maintenance · Goal</h2>'+
  '<div class=big>'+(M.maintenance||0)+'<span class=sub style="font-size:18px"> cal/day</span></div>'+
  '<div class=sub>estimated maintenance · '+(live?'measured':'cold-start anchor')+'</div>'+
  '<div class=row><span>Recommended goal</span><b>'+(M.target||0)+' cal <span class=sub style="font-weight:400">+'+(M.surplus||0)+'</span></b></div>'+
  '<div class=row><span>Weight trend</span><b style="color:'+trendCol+'">'+trendTxt+'</b></div>'+
  '<div class=sub style="margin-top:12px;'+(live?'':'color:#eab308')+'">'+dataLine+'</div>';
 // workouts
 const cells=(s.workouts||[]).map(d=>{
  const dow=new Date(d.date+'T12:00:00Z').toLocaleDateString('en-US',{weekday:'short'});
  const w=d.label?'<span class=w style="color:'+dayColor(d.label)+'">'+d.label+'</span>':'<span class="w none">—</span>';
  return '<div class=day style="border-top-color:'+dayColor(d.label)+'"><div class=d>'+dow+'</div>'+w+'</div>';
 }).join('');
 document.getElementById('workouts').innerHTML='<h2>Workouts · Last 7 Days</h2><div class=week>'+cells+'</div>';
 fmtFoot();
}
const es=new EventSource('/api/stream');
es.onmessage=e=>{try{render(JSON.parse(e.data));}catch(_){}};
setInterval(fmtFoot,1000);  // tick the "updated X ago" live against the real clock
</script></body></html>`;
}
