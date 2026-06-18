'use strict';
const express = require('express');
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');
const WebSocket = require('ws');

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

// ---- date helpers (in the display timezone) ----
// A "day" runs DAY_START_HOUR→DAY_START_HOUR local, matching the data-layer's
// nutrition bucketing: a 1am snack counts toward the day that just ended.
const DAY_START_HOUR = 4;
function localDate(d = new Date()) {
  return d.toLocaleDateString('en-CA', { timeZone: TZ }); // YYYY-MM-DD
}
function bucketToday() {
  return localDate(new Date(Date.now() - DAY_START_HOUR * 3600000));
}
function lastNDates(n) {
  const today = bucketToday();
  const anchor = new Date(today + 'T12:00:00Z'); // noon-UTC anchor avoids day flips
  const out = [];
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(anchor.getTime() - i * 86400000);
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
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
  const today = bucketToday();
  const week = lastNDates(7);

  const [deviceRows, entries, targets, sessions] = await Promise.all([
    sb('device_status?select=*'),
    sb(`nutrition_entries?date=eq.${today}&select=calories,protein_g,carbs_g,fat_g`),
    sb('nutrition_targets?order=date.desc&limit=1'),
    sb(`workout_sessions?select=date,exercises(categories)&date=gte.${week[0]}&order=date.asc`),
  ]);

  const litter = (deviceRows || [])[0] || null;

  const sum = (k) => (entries || []).reduce((a, e) => a + (Number(e[k]) || 0), 0);
  const nutrition = {
    calories: Math.round(sum('calories')),
    protein_g: Math.round(sum('protein_g')),
    carbs_g: Math.round(sum('carbs_g')),
    fat_g: Math.round(sum('fat_g')),
    target: (targets || [])[0] || null,
  };

  const byDay = {};
  for (const s of sessions || []) {
    const d = String(s.date).slice(0, 10);
    const set = byDay[d] || new Set();
    for (const ex of s.exercises || []) for (const c of ex.categories || []) set.add(c);
    byDay[d] = set;
  }
  const workouts = week.map((d) => ({
    date: d,
    label: byDay[d] ? categoryLabel([...byDay[d]]) : null,
  }));

  return { today, litter, nutrition, workouts, generated_at: new Date().toISOString() };
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
    .on('postgres_changes', { event: '*', schema: 'public', table: 'workout_sessions' }, broadcast)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'exercises' }, broadcast)
    .subscribe((status) => console.log('realtime channel:', status));
}

// ---- auth ----
function getCookie(req, name) {
  const m = (req.headers.cookie || '').match(new RegExp('(?:^|; )' + name + '=([^;]+)'));
  return m ? decodeURIComponent(m[1]) : null;
}
const authed = (req) => getCookie(req, 'hub') === TOKEN;

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
 // nutrition
 const N=s.nutrition||{};const T=N.target||{};
 const macro=(n,v,t,u)=>'<div class=macro><div class=n>'+(v||0)+(u||'')+'</div><div class=l>'+n+(t!=null?' / '+t+(u||''):'')+'</div></div>';
 document.getElementById('nutrition').innerHTML='<h2>Today · Nutrition</h2>'+
  '<div class=big>'+(N.calories||0)+'<span class=sub style="font-size:18px"> '+(T.calories!=null?'/ '+T.calories:'')+' cal</span></div>'+
  '<div class=macros>'+macro('Protein',N.protein_g,T.protein_g,'g')+macro('Carbs',N.carbs_g,T.carbs_g,'g')+macro('Fat',N.fat_g,T.fat_g,'g')+'</div>';
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
