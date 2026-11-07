'use strict';
// The composition root: configuration, the two routers and the gate between them, every module made
// once with what it needs, then the server started. What each piece does is in its own file
// (docs/HUB-INTERNALS.md § 5 maps them); the order below is the order routes are registered in.
//
// First, so an error anywhere below reaches the ops responder (health/responder): uncaught exceptions,
// unhandled rejections and everything logged with console.error. An error logged with console.log is
// invisible to it, so log errors as errors.
const ops = require('./lib/report');
ops.install({ machine: 'fly', service: 'status-hub' });
const express = require('express');
const path = require('path');
const apns = require('./lib/apns');
const livemic = require('./lib/livemic');
const { createAuth, createGate, publishFallbackConfig } = require('./lib/auth');
const { etNowString, etStringAt } = require('./lib/dates');
const { lateMoment } = require('./lib/score');
const { timed } = require('./lib/timed');
const { createSettings } = require('./lib/settings');
const { createUsage } = require('./lib/usage');
const { createWatchBattery } = require('./lib/watchbattery');
const { createAlarmLog } = require('./lib/alarmlog');
const { createRowCache } = require('./lib/rowcache');
const { createDashboard } = require('./lib/dashboard');
const { createBadge } = require('./lib/badge');
const { createJobs } = require('./lib/jobs');
const { createRealtime } = require('./lib/realtime');
const { PING, sessionClients, sseClients, pushDay, pushLists, pushVoice } = require('./lib/streams');

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
publishFallbackConfig({ auth, supabaseUrl: SUPABASE_URL, supabaseKey: SUPABASE_KEY });
// Groq Whisper for the in-app voice button (same model the ESP/Jarvis path uses).
const GROQ_API_KEY = process.env.GROQ_API_KEY || '';
// Sentinel transcript the worker recognizes as "drop the resumed hub session" (manual reset).
// Must match RESET_SENTINEL in the voice-pipeline worker.
const VOICE_RESET_SENTINEL = '__RESET_CONTEXT__';
// A machine whose orchestrator has not beaten in this long is offline (lists and desk control).
const DESK_STALE_S = 90;   // 3 missed 30s beats

const app = express();
app.use(express.urlencoded({ extended: false }));
// EVERY ROUTE IS ON ONE OF TWO ROUTERS, and that choice is its auth: `pub` answers anyone, `gated`
// only a signed-in request (`hubGate`, lib/auth.js). They are mounted here, once, so where in a file a
// route is defined has no bearing on who may call it. A route belongs on `pub` only when it has to be
// reachable signed out, and test/auth.test.js holds the list of every public path.
const pub = express.Router();
const gated = express.Router();
app.use(pub);
app.use(createGate(auth));
app.use(gated);

const { SURF_HTML } = require('./routes/pages')({ gated });

const { sb, sbRange, sbWrite, sbInsert, putSetting, sbUpsert } = require('./lib/supa')({ SUPABASE_KEY, SUPABASE_URL });
const cache = createRowCache({ sb });
const settings = createSettings({ sb, onDirty: cache.bump });
const { settingsAll, dirtySettings } = settings;
const usage = createUsage({ sb });
const watchBattery = createWatchBattery({ sbUpsert });
const { alarmLog, noteRinger, ringerReport } = createAlarmLog({ sbWrite });

const { buildSurf, dirtySurfHist, liveBuoy, liveWind, pushSurfLive, surfAlarms } = require('./routes/surf')({
  PING, SUPABASE_KEY, SUPABASE_URL, SURF_HTML, alarmLog, etNowString, etStringAt, gated, pub, sb, sbRange,
  sbWrite, settingsAll,
});

const {
  HEAT_WEEKS, broadcast, buildStatus, maintenanceWithHistory, nutritionCore, paceOf, scoreOf, trainingCore,
} = createDashboard({
  buildSurf, buildUsage: usage.buildUsage, claudeUsageRow: usage.claudeUsageRow, etNowString,
  fetchDeskFocus: cache.fetchDeskFocus, groupRows: cache.groupRows, liveBuoy, liveWind,
  maintenanceMinDays: settings.maintenanceMinDays, maintenancePhase: settings.maintenancePhase,
  produceTargets: settings.produceTargets, routingConfig: settings.routingConfig, sb, sbRange, sbWrite, sseClients,
  statusEpoch: cache.epoch, surplusCal: settings.surplusCal,
});

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

require('./routes/auth')({ auth, gated });
require('./routes/reports')({ gated, sb });
// Static client assets (core.js, app.css, cards/*.js), behind the gate.
// no-cache (revalidate via ETag each load) so a deploy is never masked by a stale cached asset.
gated.use(serveStatic);

require('./routes/status')({ buildStatus, buildUsage: usage.buildUsage, claudeUsageRow: usage.claudeUsageRow, gated });

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
  dirtySettings, gated, noteRinger, pushVoice, putSetting, sb, sbWrite, settingsAll, watchBattery,
});

const { overdueCount, pushAll } = require('./routes/notify')({
  TV_TOKEN, auth, etNowString, gated, lateMoment, sb, sbInsert,
});

const { syncBadge } = createBadge({ apns, overdueCount, sb });

const { EPOCH, convOfRow, ensureLog, liveLine, notifyAnswer, numbered, rowConv, seedLaunch } = require('./routes/conversation')({
  cleanSaid, gated, pushAll, pushVoice, sb, sbWrite, sessionClients, settingsAll,
});

const { itemTitle } = require('./routes/lists')({
  DESK_STALE_S, broadcast, dirtyRows: cache.dirtyRows, etNowString, etStringAt, gated, lateMoment, overdueCount,
  pushLists, sb, sbWrite, settingsAll, syncBadge, timed,
});

const { TV_SIDEBAR_FONT, TV_SIDEBAR_WIDTH, tvPush } = require('./routes/tv')({ PING, gated, putSetting, sb, sbWrite, sessionClients });

const { MACHINE_NAME, deadLetter, followUpSession, machineAwake, pushSessions } = require('./routes/sessions')({
  DESK_STALE_S, EPOCH, TV_SIDEBAR_FONT, TV_SIDEBAR_WIDTH, cleanSaid, convOfRow, ensureLog, gated, liveLine,
  markSeen, numbered, rowConv, sb, sbInsert, sbWrite, seedLaunch, seenMsgIds, sessionClients, settingsAll,
  // Read on every build of the payload, by which time `prompts` below exists.
  pendingPrompt: (rowId) => prompts.pendingFor(rowId),
});

require('./routes/failures')({ MACHINE_NAME, gated, machineAwake, sb, sbWrite });
require('./routes/ci')({ MACHINE_NAME, SUPABASE_KEY, SUPABASE_URL, deadLetter, followUpSession, gated, machineAwake, pub, sb, sbWrite });

const prompts = require('./routes/prompts')({ auth, gated, pushAll, pushSessions, sb });

require('./routes/streams')({ gated });

const jobs = createJobs({
  SUPABASE_KEY, SUPABASE_URL, alarmLog, apns, broadcast, dirtyRows: cache.dirtyRows, etNowString, itemTitle,
  pushAll, pushLists, ringerReport, sb, sbInsert, sbWrite, settingsAll, syncBadge,
});

const realtime = createRealtime({
  MUTE_HOLD, SUPABASE_KEY, SUPABASE_URL, auth, broadcast, dirtyDesk: cache.dirtyDesk,
  dirtyDue: jobs.dirtyDue, dirtyHeatHistory, dirtyNutDay, dirtyRows: cache.dirtyRows, dirtySettings, dirtySurfHist,
  dirtyWorkoutDay, markLive, notifyAnswer, pushDay, pushLists, pushSessions, pushSurfLive, pushVoice, recomputeMute,
  reportTick: jobs.reportTick, requestView, sb, settleReply, surfAlarms, syncBadge, takeUsage: usage.take, tvPush,
});

const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`status-hub on :${PORT}`);
  realtime.start();
  // Time-based fields (pace drain, volume drop-off) change with the clock, not just on DB
  // edits — so re-push a fresh frame on a timer too. Push, not client polling; gated on
  // having connected clients so it's free when nobody's watching.
  setInterval(() => { if (sseClients.size) broadcast(); }, 30000);
});
livemic.attach(server, auth.authed);
// A watch recording streams to /api/voice-live for as long as it runs, and a locked one can run for
// many minutes. Node's default is to drop any request whose body takes more than five minutes.
server.requestTimeout = 30 * 60 * 1000;

jobs.start();
