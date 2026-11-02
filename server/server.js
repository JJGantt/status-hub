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
const { etNowString, etStringAt } = require('./lib/dates');
const livemic = require('./lib/livemic');
const { taskDeadline, lateMoment } = require('./lib/score');
const { createSettings, agentModeOn } = require('./lib/settings');
const { createUsage } = require('./lib/usage');
const { createAlarmLog } = require('./lib/alarmlog');
const { createRowCache } = require('./lib/rowcache');
const { createDashboard } = require('./lib/dashboard');
const { timed } = require('./lib/timed');
const { PING, sessionClients, sseClients, pushDay, pushLists, pushVoice } = require('./lib/streams');

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
const cache = createRowCache({ sb });
const settings = createSettings({ sb, onDirty: cache.bump });
const { settingsAll, dirtySettings } = settings;
const usage = createUsage({ sb });
const { claudeUsageRow, buildUsage, take: takeUsage } = usage;
const { alarmLog, noteRinger, ringerReport } = createAlarmLog({ sbWrite });

const { buildSurf, dirtySurfHist, liveBuoy, liveWind, pushSurfLive, surfAlarms } = require('./routes/surf')({
  PING, SUPABASE_KEY, SUPABASE_URL, SURF_HTML, alarmLog, etNowString, etStringAt, gated, pub, sb, sbRange,
  sbWrite, settingsAll,
});

const {
  HEAT_WEEKS, broadcast, buildStatus, maintenanceWithHistory, nutritionCore, paceOf, scoreOf, trainingCore,
} = createDashboard({
  buildSurf, buildUsage, claudeUsageRow, etNowString, fetchDeskFocus: cache.fetchDeskFocus,
  groupRows: cache.groupRows, liveBuoy, liveWind, maintenanceMinDays: settings.maintenanceMinDays,
  maintenancePhase: settings.maintenancePhase, produceTargets: settings.produceTargets,
  routingConfig: settings.routingConfig, sb, sbRange, sbWrite, sseClients, statusEpoch: cache.epoch,
  surplusCal: settings.surplusCal,
});
const { dirtyRows, dirtyDesk } = cache;

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
      (p) => { seen(); if (p.new) { takeUsage(p.new); } broadcast(); pushDay('usage'); })
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
        // backstop instead of the mechanism that keeps a cleared task from lingering on the user's phone.
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
        // The user's words the moment they exist: the worker writes the user's voice_messages row only beside the
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

require('./routes/auth')({ auth, gated });
require('./routes/reports')({ gated, sb });
// Static client assets (core.js, app.css, cards/*.js), behind the gate.
// no-cache (revalidate via ETag each load) so a deploy is never masked by a stale cached asset.
gated.use(serveStatic);

require('./routes/status')({ buildStatus, buildUsage, claudeUsageRow, gated });

const { dirtyWorkoutDay } = require('./routes/widgets')({
  gated, nutritionCore, paceOf, pushDay, sbRange, scoreOf, timed, trainingCore,
});

const { dirtyHeatHistory } = require('./routes/heathistory')({
  HEAT_WEEKS, gated, maintenanceWithHistory, nutritionCore, paceOf, sb, sbRange, timed,
});

const { MUTE_HOLD, recomputeMute } = require('./routes/settings')({
  GROQ_API_KEY, SUPABASE_KEY, SUPABASE_URL, dirtySettings, gated, putSetting, sb, settingsAll,
});

const { CLIENT_NOW_RE, dirtyNutDay } = require('./routes/logging')({
  dirtyWorkoutDay, gated, produceTargets: settings.produceTargets, pushDay, sb, sbRange, sbWrite,
  surplusCal: settings.surplusCal, timed,
});

const { markLive, requestView } = require('./routes/voicemessages')({
  VOICE_RESET_SENTINEL, gated, sb, sbWrite, settingsAll, settingsCached: settings.cached,
});

require('./routes/healthdata')({ SUPABASE_KEY, SUPABASE_URL, gated, sbWrite });

const { cleanSaid, markSeen, seenMsgIds, settleReply } = require('./routes/voice')({
  CLIENT_NOW_RE, GROQ_API_KEY, SUPABASE_KEY, SUPABASE_URL, VOICE_RESET_SENTINEL,
  dirtySettings, gated, noteRinger, pushVoice, putSetting, sb, sbWrite, settingsAll,
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

const { MACHINE_NAME, machineAwake, pushSessions } = require('./routes/sessions')({
  DESK_STALE_S, EPOCH, TV_SIDEBAR_FONT, TV_SIDEBAR_WIDTH, cleanSaid, convOfRow, ensureLog, gated,
  markSeen, numbered, rowConv, sb, sbInsert, sbWrite, seenMsgIds, sessionClients, settingsAll,
});

require('./routes/failures')({ MACHINE_NAME, gated, machineAwake, sb, sbWrite });

require('./routes/prompts')({ auth, gated, pushAll, sb });

require('./routes/streams')({ gated });

const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`status-hub on :${PORT}`);
  startRealtime();
  // Time-based fields (pace drain, volume drop-off) change with the clock, not just on DB
  // edits — so re-push a fresh frame on a timer too. Push, not client polling; gated on
  // having connected clients so it's free when nobody's watching.
  setInterval(() => { if (sseClients.size) broadcast(); }, 30000);
});
livemic.attach(server, authed);
// A watch recording streams to /api/voice-live for as long as it runs, and a locked one can run for
// many minutes. Node's default is to drop any request whose body takes more than five minutes.
server.requestTimeout = 30 * 60 * 1000;

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

// Exempt items close themselves once their moment has gone. A shift is not something the user finishes;
// it is something that happens and is then over, and leaving it on the list would make the user tidy up
// after the user's own calendar. Uses the SCORING deadline rather than the firing time, so an all-day
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
