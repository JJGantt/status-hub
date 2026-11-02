# Status Hub — Internals

How the hub UI is actually built: the data flow, the payload contract, the module map, the domain
engine, and the full API + settings surface. Read `ARCHITECTURE.md` first for the ecosystem view;
this is the map for working *inside* `status-hub` itself.

> The individual code files carry detailed header comments — this doc is the connective tissue
> (structure, contracts, catalogs) that no single file holds. `CLAUDE.md` covers what to know
> *before* editing anything here.

---

## 1. The one principle: server computes, clients render

Every derived value — maintenance math, dynamic macros, pace fill %, colors, labels, volume gauges,
heatmap cells, scores — is computed on the **server** and shipped in one payload. The clients
(`public/*`, the native WKWebView) only paint what they're handed. If you're tempted to compute a
display value in a card, it belongs in `server.js`/`lib/` instead.

Flow:

```
Supabase ──▶ server.js buildStatus() ──▶ /api/status payload ──▶ /api/stream (SSE)
   ▲              (calls lib/* to derive everything)                    │
   │                                                                    ▼
 writes ◀── /api/log-set, /api/log-entry, /api/todos, /api/settings … ◀ core.js → cards render(s)
```

- **Push model:** `/api/stream` is a Server-Sent-Events stream. `core.js` subscribes once; every
  ~30s (and on realtime-invalidated change) the server rebuilds the payload and pushes a `status`
  frame; `core.js` calls each card's `render(s)`.
- **`buildStatus()` is assembled from PIECES, and a feed that draws one card asks for that piece
  alone.** `nutritionCore()` (the day's rows, the goal settings, maintenance), `paceOf()` (the totals
  and rings at this instant — the only clock-driven piece, so computed per call), `trainingCore()`
  (the muscle gauges and set clocks), `scoreOf()` and `maintenanceWithHistory()` (the per-day replay,
  most of the build's CPU, drawn only by the weight views). `/api/rings`, `/api/workout-now`,
  `/api/weight-view`, `/api/nut-history` and `/api/heat-history` each call the pieces they draw;
  calling `buildStatus()` from a feed is the mistake that made the watch's rings cost the whole
  dashboard — the devices, the mics, the session focus, both heat maps — on every page open. Each
  derived value is `memo()`ised on the row arrays it came from, so it lives exactly as long as they do.
  Requests arriving during a build share it unless something was invalidated after it began
  (`statusEpoch`); `broadcast()` always builds its own (`composeStatus`), because a `device_status`
  change reaches it without invalidating any cache. Each feed logs its duration:
  `fly logs -a jared-status-hub | grep timing` (the broadcast logs only a build over 500ms).
- **Realtime:** the server subscribes to Supabase realtime on the tables that must invalidate the
  cached payload (nutrition, sets, app_settings, voice_*), so a voice/MCP write reflects in seconds
  rather than waiting for the tick. It also subscribes to `desk_sessions` / `desk_queue` / `desk_focus`
  and to `reports`, which do not invalidate a cache so much as PUSH: the first three build a `sessions`
  frame (see `pushSessions`, and §3 — it is why the walls no longer poll `/api/sessions`), and a new
  `reports` row fires `reportTick` directly.
- **Realtime invalidation is a fast path, never a cache's only refresh.** Every server-side cache
  needs an age check too. Events get dropped — CHANNEL_ERROR and half-open silence are both routine,
  which is what `REALTIME_SILENCE_LIMIT_MS` and the socket recycle exist for — and a cache that only
  clears on an event serves whatever it built on boot, forever, with a redeploy the only way out.
  `/api/surf/history` shipped that way and froze the surf card for 16 hours. Every cache here now
  pairs `dirty*()` with a `*_BACKSTOP_MS` age check; add both when you add a cache.
- **The silence watchdog cannot see a per-table delivery failure, which is why the freshness probe
  exists.** `REALTIME_SILENCE_LIMIT_MS` judges the socket by whether *any* event arrives, and
  `seen()` is fed by every subscription including `device_status` — written every couple of minutes
  by the litter and feeder watchers. So the one table with a permanent heartbeat vouches for all the
  others. On 2026-09-10 a meal logged at 09:26 reached no surface until the 15-minute backstop
  lapsed: the channel had been SUBSCRIBED since 08:17, device_status was flowing the whole time, and
  the watchdog logged nothing. It surfaced as "the hub is stuck on Wednesday", because a nutrition
  cell with no rows gets no `data-ndate` and so cannot be selected — a stale cache reads as a broken
  date.
  `FRESH_PROBE_MS` checks **function instead of liveness**: every two minutes it asks the database
  for a fingerprint — a row count per write-active table plus the newest `completed_at` — and if that
  moved while realtime announced nothing about those same tables, realtime dropped something. It
  refetches, recycles the socket (a miss is evidence the channel is lying), and **logs**, which the
  original failure never did. The probe costs ~147 bytes and ~340ms per run, about one extra heavy
  fetch a day, so it closes the window without undoing the caching it protects.
- **What "realtime announced nothing" is measured against is `rtEvents`, not the row cache's state.**
  Whether the cache is dirty looks like the right question and is not: `broadcast()` refetches, which
  makes it clean again, and `broadcast()` runs on every realtime event, so by the time the probe reads it, it has almost always been cleared by the
  very event the probe is asking about. Testing it made the probe fire after ORDINARY writes — a
  completion realtime delivered in under 20 seconds was declared missing 105 seconds later — and each
  firing recycled a healthy socket. That is not a harmless false positive: a recycle is a real
  `CLOSED` → `SUBSCRIBED` gap, so the watchdog for dropped events was manufacturing the windows in
  which events drop. `rtEvents` counts events on exactly the three tables the fingerprint can see
  (`nutrition_entries`, `sets`, `list_items`), lives outside `startRealtime` so a recycle does not
  reset it, and is sampled after the fingerprint read so an event landing during that read still
  counts. Subscribe to a new table the fingerprint covers and it needs `fpSeen()` too, or the probe
  will call its writes missing.
- **The probe has to recover the CLIENTS too, not just the server's caches.** A refetch fixes what
  the next request answers; it repaints nothing already on a screen. The calendar surfaces re-read on
  the `lists` frame and on nothing else but a transition minute they computed in advance, which can
  be hours out — so whenever the probe is the path that reconciles a `list_items` write rather than
  the subscription, every chip stays drawn from before it until that minute arrives. On 2026-09-17 a
  task completed at 18:42 held its next transition at 21:00 and sat red on the wall, the phone and
  the browser while `/api/calendar` answered `done`. The recovery branch therefore repeats the whole
  `list_items` handler — `pushLists()`, `dirtyDue()`, `syncBadge()` — on top of the refetch and the
  socket recycle. A subscription that PUSHES rather than invalidating a cache needs its push added
  here as well, or that surface goes stale in exactly the case the probe exists to catch.
- **The row cache is per GROUP, and a write dirties only the groups its table feeds**
  (`ROW_GROUPS`: intake, weigh-ins, targets, sets, the exercise catalog, surf, dated items).
  `dirtyRows(table)` with no table named dirties all of them, which is what the freshness probe does;
  a realtime handler passes `p.table`. A new cached query goes into a group whose table's subscription
  calls `changed`, or its edits wait for the 15-minute backstop.
- **A read may mark its row group clean only if no write was announced while it ran.**
  `dirtyRows()` bumps that group's `rowGen` and `groupRows` compares it once its queries return: a
  read that began before an invalidation still answers its own caller, but is not kept. Concurrent
  callers of one group share a single read. Every `list_items` event starts a read, and two writes a second apart are routine, so
  reads overlap. Without the check the earlier read clears the flag the later event set, and rows
  fetched before the second write sit marked clean until something unrelated dirties the cache. The
  gold band shows it: chips come live from `/api/calendar` and read `+7` at once, while the bar is
  built from this cache and lags a completion until the next list write. `broadcast()` numbers its
  builds and drops a frame once a later build has been sent, because builds finish out of order too.
  Both paths log when they fire (`[rowcache]`, `[broadcast]`); a hit there is this race, not a dropped
  realtime event.
- **Every stream goes through `liveStream()` (shared.js), never a bare `EventSource`.** An SSE
  connection can go half-open — `readyState` stays OPEN, no `error` fires, nothing arrives again —
  and the browser only retries a connection it saw CLOSE, so nothing reconnects it. A wall in that
  state looks perfectly healthy: cards hold their last frame and the rest/session clocks keep
  counting, because those are local intervals. `liveStream` judges the connection by whether frames
  ARRIVE: rebuild the socket after 75s of silence, and if the rebuilt one is deaf too, reload the
  page — but only once `/healthz` answers, since reloading into an unreachable hub lands on the
  browser error page where no JS is left to recover (the trap `.xinitrc` gates the kiosk against).
- **No self-initiated reload interrupts a recording.** The page reloads on its own after a deploy
  (core.js `goStale`, the `/healthz` build check in shared.js) and when a stream stays deaf, and a
  reload mid-command destroys the clip, which is only in the MediaRecorder's memory until stop. All of
  them go through `safeReload()`; `makeRecorder` holds it off (`holdReload`) whenever its state is not
  `idle` — arming, capturing, uploading — and the wanted reload happens 3s after the last hold lets go.
  A new reload site has to use `safeReload`, not `location.reload()`, or it reopens this hole.
- **The heartbeat is a `ping` EVENT, not a comment.** Every stream writes `event: ping` every 25s
  (`PING` in server.js). It used to be a `: keepalive` comment, which no client can observe — leaving
  no way to tell quiet from dead on `/api/voice-stream` and `/api/list-stream`, where hours can pass
  with no data. Named events never reach `onmessage`, so nothing else sees it.
- **Staleness is visible:** a 3px hairline along the top edge (`.stalebar`), invisible while frames
  arrive, amber while the watchdog is rebuilding, red once the rebuild has failed too. It is painted
  from a local timer and NEVER from `render(s)`, because a render is exactly what stops happening.
  `window.__hubStreamAge()` exposes the same number to the Pi's `kiosk-health.py`, which can already
  see a renderer that won't run JS but not one running fine over data that stopped.

---

## 2. The `/api/status` payload contract

`buildStatus()` (server.js) returns exactly these top-level keys. Each card reads its slice:

| Key | Feeds | Built by |
|---|---|---|
| `today` | the 4am-origin day string everything is scoped to | `lib/dates.nutritionWindow()` |
| `nutrition` | Today·Nutrition card (Cal/P/C/F pace rings + produce) | intake rollup + `lib/pace` |
| `pace` | the drain/refill state + colors for the rings, and the staged-meal arcs | `lib/pace.computePace()` |
| `maintenance` | the calorie-target card + the maintenance-window viz | `lib/maintenance` (§4) |
| `nutrition_log` | calorie-adherence calendar + calorie/weight trend plot | `lib/nutritionlog` |
| `volume` | per-muscle weekly volume gauges + the body map colors | `lib/volume` + `lib/bodymap` |
| `heatmap` | GitHub-style workout heatmap, a fixed `HEAT_WEEKS` window | `lib/heatmap` |
| `weight_plot` | the home wall's weekly weigh-in average, one point per heat-map week column | `lib/weightplot` |
| `litter` / `feeder` / `surf` | those device/status cards | Supabase rows (`device_status`, snapshots); litter through `buildLitter` |
| `weather` | the rain-chance grid beside surf — 7 days x 24 hours, the drawn window, the week's peak and the palette | `lib/weather` (NWS gridpoint from the `NWS_GRIDPOINT` env, e.g. `TOP/31,80`; unset leaves the grid empty; cached 15m; **the only outbound fetch in the frame**, and it never blocks it — `getWeather()` returns the last good copy and refreshes behind the caller) |
| `wind` | the live wind at the break — the dock's newest reading, its half-hour average, its type (onshore / offshore / cross-shore) and compass point, and beside it the forecast for this hour and the difference. The surf app's page draws it (`/api/surf/stream`) | `lib/livewind` (the MYPF1 dock via NOAA CO-OPS 8720218, read every 10m — a timer because the API pushes nothing) |
| `buoys` | the two wave buoys either side of Mayport (41112 Fernandina, 41117 St. Augustine): each one's newest reading — whole-sea height, period and direction, the SWELL and WIND-WAVE split, water — and its age | `lib/livebuoy` (NDBC `.txt` + `.spec`, read every 10m, kept in `wave_readings`) |
| `rep_watcher` | what the Apple-Watch rep watcher is logging as | `sets`/watcher state |
| `last_set_at` / `session_start_at` | the rest clock + "since last set" | derived from `sets` |
| `routing` / `mics` | voice liveness strip (ESP/Mac/Pi + always-on/inject) | `voice_presence`, `worker_presence`, `app_settings` |
| `score` | the weekly overall-score gauge | `lib/score` |
| `generated_at` | payload timestamp | — |

`todos` (lists) is **not** in this payload — the todo card self-fetches `/api/todos`
(so it isn't rebuilt on every 30s tick). See §6.

---

## 3. Client modules & cards (`public/`)

### A page loads ONE script, and it is built

Every page has a single `<script type=module src="dist/<page>.js">`. That bundle is built by
`build.js` (esbuild) from `public/pages/<page>.js`, which lists the modules that page runs, in order.
**To add or remove a module from a page, edit that entry file** — a new `<script>` tag in the HTML is
not how a module gets loaded any more.

The bundle is built inside the Docker image, not committed, so what a machine serves cannot be stale
against the source it was built from. Locally, `npm run build` before `npm start`.

One bundle PER PAGE, never one per entry module. Several pages share `core.js`, `shared.js` and
`voiceagent.js`, and those hold state that must exist exactly once on a page — the activity-popup
singleton, the held microphone, the `KIOSK` verdict. Separate bundles that shared a module would each
get their own copy of it, and two `KIOSK` verdicts is two halves of one decision disagreeing.

Why it is bundled at all: the client is dozens of modules in a three-level import graph, and a browser
cannot discover level two until level one has arrived. Served raw that is a full round trip per level
before any of it runs — measured at about 420ms on a phone-class connection, for a payload whose bytes
were never the problem.

**Top-level modules:**

| File | Role |
|---|---|
| `core.js` | Boot: opens the SSE stream, is the render orchestrator (calls every card's `render(s)`), then inits the layout. |
| `shared.js` | Shared helpers (`esc`, `state`, local-time formatting) + the `state.last` cache, `liveStream()` (every SSE connection on every page), `PIN_SVG` (the mark on a pinned session, used by every surface that shows focus), the staleness hairline, and `paintScrolled()` — how a card rebuilds sideways-scrolling content each frame without throwing away where it is scrolled to. |
| `navbar.js` | Bottom bar: settings gear, the calendar link (on `/calendar` itself, a back-to-the-wall toggle instead; on the phone's home page, the utilities sheet) + the single voice FAB (`wfab-fast`). Exposes `window.__startVoiceCommand` for the native launcher. |
| `voiceagent.js` | The in-app conversation pipeline: `makeRecorder` (mic → `/api/voice-command`), the activity popup, the conversation card, and the durable photo and voice outboxes (IndexedDB) that resend whatever a failed upload left on the phone. |
| `settings.js` | The gear panel — reads/writes `app_settings` via `/api/settings` (§7). |
| `tv-focus.js` | The sessions wall's mount, and nothing else — it hands `cards/sessions.js` its three elements and stops. The tab shape is CSS over the shared `.hw-row` markup (`tv-focus.css`), so the numbering, the pin, the unread mark and the activity line are the same ones every other surface draws. |
| `wall.js` | WALL-only: scales the 1920×1080 shell into a phone-sized canvas and drives the swipe panes around it. `/` serves `phone-home.html`, which is laid out at native size and needs none of this, so `wall.js` is what keeps a WALL openable on a phone, plus the Mac app's fit. |
| `phone-home.js` | The phone home page's own middle (`/`): mounts the day strip, the sessions list and the last exchange of the hub thread — and its swipe paging, which is all that is left of wall.js's job on a page that is not scaled. |
| `cards/daystrip.js` | TODAY LYING DOWN, and the days after it — the phone home page's day. Hours left to right, each item at its own time, packed into lanes so two titles never overlap (the one in the lane that frees soonest is truncated instead). It keeps going past midnight, which is why that page needs no separate look-ahead. Painted from the same `/api/calendar` response `cards/dayline.js` fetches, so there is one clock for both. |
| `expand.js` | Full-screen section sheets, each opened by tapping the thing that summarises it: the two heat maps, the surf plots, the body figures, the weigh-in plot (`bindTap`, which tells a tap from a drag on a scroller). On open it moves the elements into the sheet and re-runs that section's cards, because each one draws itself to the size and window its surface gives it — the grids pick up the sheet's fixed cell size and their history, and surf picks up the sheet's `--surf-*`. The heat sections then pin to the newest column; surf holds its own place, as a distance from the right-hand end. |
| `heathistory.js` | The heat-grid columns older than the status frame carries — fetched once from `/api/heat-history` and drawn only inside the sheet. |
| `tv.js` | KIOSK ONLY, and the guard matters: the activity popup and the heard-you pop, off `/api/voice-stream`. Every other surface boots `voiceagent.js`, which drives the same popup from the same stream — running both left the phone holding a second EventSource open for the life of the page. |
| `wallmode.js` | Follows `app_settings.wall_mode` so voice can switch the TV between the walls. Acts only on kiosk paths (`/tv`, `/tv-session-focus`, `/tv-calendar`, `/tv-home`), never on the phone's `/`. |
| `cards/month.js` | The month calendar: paints the server-computed month grid + day agenda from `/api/calendar`; tap a day, page months. Read-only — writes stay with voice and the lists. Mounted in the phone home page's calendar sheet and by `calendar.js` for the standalone `/calendar` page; each surface decides what makes it re-read (a push, never a timer). |
| `cards/weather.js` | The rain-chance grid, in the surf card on the home wall and in the phone's misc pane with it. Paints only: the grid, the drawn window, the peak and the colours are all decided in `lib/weather`. Carries no day letters and no sky icons — the leftmost column is today by definition, and in this climate NWS says "chance of showers and thunderstorms" six days in seven, so the icon discriminated nothing the colour did not. |
| `cards/dayline.js` | THE day column, on every surface that has one — and the look-ahead beside it, painted from the same response into the element `mount` was given as `ahead` — the calendar wall, the home wall, the phone's lists pane. `mount(null, {onload})` is a surface that wants the PAYLOAD and no column of its own: the phone's home page, which draws the same days as a horizontal strip (`cards/daystrip.js`) and still shares this one's fetch and clock. Owns the fetch, the clock and the reload rules: it re-reads on an `/api/list-stream` push and when the server says a chip changes state, and otherwise just moves the now-line against the clock (each hour row carries its 24h number). Mounts `#daycard` itself; the walls mount their column, because they choose the endpoint. |
| `tv-calendar.js` | The calendar wall's middle (only `tv-calendar.html` loads it): the month grid(s) out of the `/api/calendar?wall=1` payload that `dayline.js` fetched for the column beside them. Display-only. |
| `tv-home.js` | The home wall's own middle (only `tv-home.html` loads it): mounts the day column and the look-ahead column beside it, and paints the three most recently active sessions and the focused one's last answer (a pinned one carries the pin) from pushed `sessions` frames, with a 5-minute fetch behind them as the net. Display-only. |
| `mic.js` | The `/mic` standalone launcher page's script (its own recorder, reuses `voiceagent`). |

The activity element (`.ai-act`) renders the
`activity` frames the worker pushes to `/api/voice-activity`. One element, two mount points: it floats
as a popup on the page view, the phone wall and the Mac app, and on the TV kiosk it mounts into the
footer row's reserved lane (`#tv-act`) so it occupies space rather than covering a card. The choice is
made by `voiceagent.js`'s kiosk predicate, not by whether `#tv-act` exists — §6e says why. Same states
either way.
The phone's HOME page is the exception, and it takes the frames rather than the element: `.ai-act` is
`display:none` there, because a float over a surface laid out to fit exactly has nowhere to sit, and
`onActivity(fn)` in `voiceagent.js` hands the same frames to the conversation tail, which draws the
newest one as its own lowest line. Hub focus only — a session's frames are `/api/session-stream`,
which `cards/repos.js` holds. Any surface wanting live progress inside its own markup subscribes
there instead of restyling the popup.
The frames are: `working` (the prompt, once per command),
`tool` (each tool call + args), `text` (what the model said between tool calls, up to 2000 characters),
`error`, and `done`. Only these five states survive the relay; anything else is coerced to `tool`.
A `text` frame is only ever text a tool call FOLLOWED: every runner holds what the model says until the
next tool call and drops it if none comes, because the text after the last tool call is the reply and
arrives as the thread message. The bar shows a thought in its `busy` style. Nothing keeps them, which is
why both the hub model and every session are told their final message must restate anything it needs
from earlier in the turn (`HUB_SYSTEM`, `~/CLAUDE.md`).
On the kiosk the running states hold indefinitely; only a TERMINAL row (`done`, or a client-side
error) is on a timer, and it holds for `activity_hold_s` (default 60s) so a reply is still on screen
well after the turn ends. Off the kiosk the bar floats over the page with the conversation a swipe
away, so a terminal row holds only `phone_activity_hold_s` (default 8s), and a running row (anything
but Listening) hides after two minutes with no new frame. That ceiling is what keeps the phone's bar
from sticking: several worker paths never send `done` (a command injected into a focused session, a
context reset, a dropped duplicate, a crashed run), and a phone backgrounded mid-run never hears one
that was sent. A late frame from a slow run shows the bar again. Any new frame clears a pending hide
early — `show()` resets the timeout on every call — so each hold is a ceiling, never a floor. Both surfaces read it from the `/api/settings` fetch they already
make (`voiceagent.js`'s `boot()`, `tv.js`'s), handing it to `applyActivitySettings`.

**Cards (`public/cards/`)** — each exports `render(s)` and paints from its `s.*` slice:

`nutrition` (Cal/P/C/F pace rings + produce sub-rings) · `nutritionlog` (calorie+weight plot +
adherence calendar) · `maintviz` (the maintenance-window viz — the whole history at a fixed density, dragged by hand) · `todo` (dated items / lists,
self-fetches) · `repos` (the Mac's projects; tap to launch a Claude session there — and the sessions list, where a
row opens its session, §6b — self-fetches) ·
`reports` (a dispatched session's write-ups, self-fetches — §6c) · `muscle` (body map + volume
gauges) · `workouts` (heatmap + day detail) · `weightweeks` (home-wall weekly weigh-in plot) ·
`litter` · `feeder` · `surf` · `routing` (TV top strip)
· `deskfoot` (which session holds follow-ups, TV footer — §6b) · `score` (TV right column) · `mics`
(page voice-liveness strip).

**The litter card's state is the server's** (`buildLitter` in `server.js`). The robot is held in
Sleep Mode and the Fly watcher fires every clean itself, so the robot's own `status` is not the
state of the box — it reads `READY` through a queued clean, a phantom weight, a 30-minute lockout,
and a watcher that stopped reporting an hour ago. `buildLitter` folds that `status` together with
the driver state the watcher publishes in `device_status.data` (`sleeping`, `clean_pending`,
`clean_due_at`, `locked_out`, `scale_stuck`, `last_visit_at`, …) and the row's own age, worst-first,
into one `state` + `label` + `color` the card, the walls and the iOS `LitterCard` all just paint.
A row older than 25 minutes (the watcher refreshes every 10) is `STALE`, because a dead watcher and
an idle robot otherwise look identical. `SELF_CYCLING` means the robot left sleep mode: it is
cycling on its own and nothing here is driving it.

**Surfaces (same code, different chrome):** desktop `/page` = scrolling rows; phone = swipe panes on
`/`, in the markup order of `phone-home.html` — sessions · home · reports, landing on home (index 1).
Everything else is a sheet (`expand.js`): the weight page opens from the weigh-in plot, the calendar
and lists from the day strip, utilities from the navbar, the voice system at the bottom of Settings. No chat pane: the hub conversation is on the home pane, and the sessions
view takes the slot left of it; TV `/tv` = the home wall + a voice panel (auth: a one-time `?token=`, § Auth); the `/mic` page = a
minimal fullscreen voice launcher; `/calendar` = the standalone calendar page (the navbar's calendar
button gets there everywhere but the phone's home page, where the day strip opens the same month); `/tv-calendar` = the calendar wall (§ CLAUDE.md's walls note). The phone's page is
NOT a scaled wall — see CLAUDE.md, "The phone's home page is not a wall".

### The microphone is open only while something records

A recorder claims the one `getUserMedia` stream when a recording starts — a tap, or the always-on
listener being engaged — and lets go when it ends; the device closes when nothing holds it
(`claimMic`/`unclaimMic`). Keeping it warm while the page is up is the obvious way to make a tap
instant (iOS takes up to two seconds to hand over a capture device, 2,017ms measured on his phone),
and it breaks every sound the page plays: an open capture holds the audio session in
`.playAndRecord`, and it cut the alarm's ring to a blip. So each tap pays the acquisition, and
`arming` shows the tap at once so the wait reads as the mic opening.

**The capture is the device's built-in mic, never AirPods** (`acquireBuiltIn`). Opening an AirPods mic
drops the whole Bluetooth link into the hands-free profile — call-quality audio for the transcriber, a
clipped first second, degraded playback while held — so the built-in device is asked for by id and the
AirPods stay output only. Device labels are empty until permission is granted, so a first-ever capture
can come back on the default and is swapped. Each acquisition beacons `ev: "mic-device"` with the label
it got. The Mac's two capture paths (Hammerspoon dictation, voice-pipeline's mac-listener) pin the
built-in mic the same way, and the watch never opens a Bluetooth input at all.

It is dropped when the page is hidden, whoever holds it: iOS interrupts a backgrounded capture
anyway, and the recording indicator should not stay lit over another app. A track can also end
under us when something else takes the mic, so possession is decided by `readyState`, never by holding
a reference. `micStream`/`micPending` — and both outbox stores — are declared at the top of the file
with the rest of `boot()`'s state, because `boot()` runs above them and a binding it reaches before
its declaration is not yet initialised.

### The voice button has three states, and a tap lands on `pointerdown`

`makeRecorder` reports one state through `onState` — `armed`, `rec`, `idle` — and every caller paints
exactly that. `armed` is both "tapped, mic still opening" and "stopped, clip still uploading": a ring,
no fill. `rec` is the full fill, and it means audio is genuinely being captured, nothing less.

Both of those exist because a tap that shows nothing gets repeated, and this control is a toggle, so
a repeated tap is a state change nobody asked for. `getUserMedia` takes a beat (longer once the page
has been backgrounded) and the upload takes a second or two, and each of those windows used to look
identical to a dead button. `arming` and `sending` are set synchronously so the second tap can only
ever be a stop, or nothing.

The handler is on `pointerdown`, not `click`: click fires when the finger LIFTS, ~90ms later for a
mouse press and more for a finger. The click still arrives afterwards — `preventDefault` on
`pointerdown` does not reliably suppress it — so `bindTap` swallows it, and lets through only a click
with no `pointerdown` in front of it and `detail === 0`, which is a keyboard Enter or Space.

### Every press-to-talk button is press to start, press to send — nothing else ends or drops a clip

`makeRecorder` has no voice-activity detection and no timer. Every caller — the navbar button, the
chat sheet (`cardRec`), the session view (`at.rec`), the new-session dictation (`beginDictation`) and
the `/mic` page — records until the second press and then sends whatever it recorded. A clip with any
bytes in it always goes up; the hub's transcript is the only judge of whether it held words, and an
empty one comes back as the "Didn't catch that" status rather than as silence. **Do not add a VAD to
this path.** A VAD here ends a recording at a pause and discards any clip it judges silent without a
word, and on his phone it judges whole spoken commands silent — so the press records, throws the words
away and shows nothing. The one place a machine decides where speech ends is the always-on listener
(`makeListener`).

The cost is that an accidental press on a silent room uploads silence, and Whisper can answer that
with an invented phrase ("Thank you." is the usual one). That is accepted: a press is a deliberate act,
and losing a real command silently is the worse failure.

Three more ways a press can be lost, each handled in the recorder rather than in a caller:

- **A recording that ends underneath it is PAUSED, never sent half-said and never thrown away.** A
  timer or alarm going off, Siri or a call (the iOS app relays the audio session's interruption as
  `hub:audiointerrupt`, `AudioInterruption` in `StatusHubApp.swift`), the capture track going `mute`,
  the page hidden (which closes the mic) or a capture reset all end the MediaRecorder without `stop()`.
  `onstop` then HOLDS the clip so far (`held`, `paused` / `pause` in the tap trace), lets go of the
  mic, unmutes the room and paints `armed`. It carries on by itself when the interruption ends or the
  page is shown again, or at his next press — a press on a paused recording resumes it, it never sends
  it — and the press after he finishes sends the whole command. `cancel()` throws a paused one away.
  MediaRecorder files from two recordings cannot be joined, so each held part goes up as a dry
  transcription first (`deliverVoice`) and its words ride the last part as the `X-Voice-Prefix` header,
  which `/api/voice-command` puts in front of the transcript before enqueueing ONE command. The last
  part carries its own `dur` only, because the hub's damaged-capture check compares the clip against
  it. A held part lives in the page's memory until it is sent: a reload or a killed app loses it.
- **An upload that never answers.** Every clip goes through one serial outbox, so a hung request
  holds every mic button on the page in its sending state. `deliverVoice` aborts after `VOICE_SEND_MS`
  (two minutes); the clip stays in the outbox and the button is free.
- **A caller abandoning a recording** uses `cancel()`, which ends it WITHOUT sending. `stop()` always
  sends — that is what a stop press means — so leaving the session view or picking another project
  mid-recording cancels, and a clip already stopped still goes to the session it was spoken into.

### A recorded clip is kept until the server has it, and no command is too long

Every finished recording is written to IndexedDB (`hub-voice-outbox`) before it is uploaded, and
deleted only when the server confirms it: the command enqueued (from then on its transcript in
`voice_requests` is the durable copy), or a dictation's transcript handed back. A clip whose upload
fails stays on the phone and resends on the photo outbox's triggers — boot, return to the foreground,
`online`, `pageshow`. The resend carries the capture-time `client_now` and the clip's id as
`client_msg_id`, which the server de-dupes, so a send whose answer was lost is not enqueued twice.

Clips go oldest first. A network failure ends the pass, because everything behind it would fail the
same way and must not overtake it. A server refusal keeps the clip but lets later clips through, so one
the server can never take cannot hold every later command hostage. A dictation (`dryWhen` — the
composer with photos pending, the repos card's session prompt) is only sent while the recorder that
took it is alive; one stranded by a reload stays in the store unsent, since nothing else knows what it
was for.

A clip that cannot go is kept, never dropped, and there is deliberately no count of waiting clips on
screen: one should never pile up, and when one does, Jared looks at it with Claude. Every failed
attempt is in the hub log with its size, type, duration and the server's answer —
`fly logs -a jared-status-hub | grep voice-send-fail`.

There is no size or length limit on a command anywhere. `/api/voice-command` streams the body to a temp
file, and `lib/transcribe.js` sends it to Groq as recorded when it is under Groq's 25 MB direct-upload
cap, and otherwise re-encodes it (ffmpeg, installed by the Dockerfile) to 16 kHz mono Opus in half-hour
pieces. The cap is easy to hit: a phone clip has arrived at ~1.5 Mbps, which put a 137-second command
over it. Every clip logs `[voice-command] <bytes> <type> <secs>s <kbps> kbps`. The recorder asks for
96 kbps (`VOICE_BPS`). WebKit picks the audio bandwidth from that number: at 32 kbps it falls to
narrowband, which cost Whisper misheard words, and 48 kbps is the lowest that transcribed cleanly. 96 is
headroom over that cliff, not a tuned minimum — do not lower it to save bytes. (For MP4, WebKit ignores
anything under 64 kbps.)

---

## 4. The domain engine (`lib/`)

The math lives here; each file has a thorough header. Summary map:

| Module | What it derives |
|---|---|
| `maintenance.js` | Adaptive TDEE via energy balance (avg intake − trend·kcal/lb), the dynamic calorie+macro goal, and the **goal-phase** logic (window bounded by a bulk↔cut sign flip, with a seed held until the new phase has data). Also `estimateHistory` (per-day replay for the viz). |
| `pace.js` | Within-day intake pacing — the eating window (median first/last meal over the last **two weeks** of logs, IQR-trimmed), each macro's drain/refill fill + green→red/amber color vs the expected-by-now line, and the staged-meal arcs (below). |
| `nutritionlog.js` | The calorie/weight dual-axis plot, the diverging-color adherence calendar, and `buildGoalResolver` (per-day calorie goal, respecting stored targets + phases). |
| `volume.js` | Weekly per-muscle fractional-set volume (primary=1.0, secondary=0.5) vs that muscle's weekly set target — `TARGET_DEFAULT` 14, with the `TARGETS` overrides below it. |
| `bodymap.js` | The front/back body SVG (viewBox 0 0 72 93); volume colors paint onto it. |
| `heatmap.js` | Per-day set-count heatmap laid out as week columns. Shade is an **absolute** count — one level per 6 sets, topping out at 37+ — so a colour means the same thing in every window and on every surface. |
| `weightplot.js` | The mean of each week's weigh-ins, on the same Sunday-anchored columns as the two heat maps, plus the three axis values. Points carry x/y as fractions of the plot box. A week with no reading is **interpolated** between the nearest measured week either side (anchors may sit outside the window) and flagged `imputed` so the card draws the line through it but no dot; a gap with no measured week *after* it stays `null`, because that is extrapolation. The band is whole pounds, widened to an even span so the middle line has an integer to label, and the FIRST column is always blank — the axis values are written over it. Built at `HOME_HEAT_WEEKS`, since the plot means nothing away from the columns it is aligned to. |
| `score.js` | The health bar: `(training + nutrition + tasks)/3`, each band capped at a third. `tasksScore` also returns `loss_per_day` — the points a day the gold band is falling at right now, fading plus overdue, capped at what is left — and `loss_changes_at`, the next moment a completion ages out and the rate steps; `gained_today` and `today_ends_at` are the same pair for today's gain, at landed face value. Fading is each credit's face value over 7 days summed, not a point a day per completion: late, drained, overfilled and important credits all fade at their own rate. |
| `transcribe.js` | Not domain math — speech to text for a voice clip of any length. Under Groq's 25 MB cap it goes up as recorded; over it, ffmpeg re-encodes to 16 kHz mono Opus at constrained 24 kbps in half-hour pieces, transcribed in order. Each piece tries Groq (`whisper-large-v3-turbo`, or `whisper-large-v3` for a locked watch recording or `?model=large` — turbo can silently drop a whole stretch of a clip; a locked recording also has its long pauses shortened first, `docs/WATCH.md` § Sending it), then OpenAI's Whisper (`OPENAI_API_KEY`); when both fail it throws `allFailed`, and `/api/voice-command` then keeps the clip and queues the row `untranscribed` for the Mac worker's local Whisper, provided that worker is heartbeating (voice-pipeline `worker/README.md` § The last transcriber is the Mac). `/api/voice-command` also runs the OTHER Groq model on every enqueued clip in parallel (turbo beside large, large beside turbo), and when the two readings' words differ it stores the second as `voice_requests.alt_transcript`, which the worker puts in front of the model beside the first. Neither model is the better transcriber: each mishears words the other gets right (large-v3 heard "haircut" as "pair putt"; turbo heard "a to-do" as "to view"). |

**The task band starts empty and is earned.** Nutrition and training measure how well a thing is
going; the gold band measures whether dated list items get done. It has no neutral baseline on
purpose — a baseline would remove the only incentive the band exists to create, which is scheduling
things in the first place. Completing on time earns full value, later earns less and eventually
costs, and anything left sitting overdue drains for as long as it sits. Effects fade linearly to
nothing over the same seven days the other two bands look back over, so a hit's *size* is what
decides how long it is felt.

**The band is a bounded queue, not a running total.** It was a window sum with the cap applied only
to the *display*, and the number underneath ran uncapped — so a heavy week banked surplus that
silently held the bar full afterwards, and one neglected item dug a hole several completions had to
fill before anything moved at all. The bar was describing a number that was not the number.

Now completions are admitted to a fixed-capacity queue, each still aging out linearly on its own
clock. When admitting one would pass FULL, the **oldest** credits are pushed out to make room.
Draining works from the same end and stops at empty. So:

- The level can never exceed FULL or fall below zero, as *state* and not just as a rendering.
- **Work done while the bar is full still counts** — the newest always lands. An earlier attempt
  capped by refusing the surplus instead, which meant effort at full was worth literally nothing.
- Digging out of neglect shows on the first completion, because there is no debt below zero.

A burst does persist longer than steady work, since the queue holds the most *recent* effort and a
burst's contents are all fresh. That is not a buffer — both hit zero the same number of days after
the last activity — it is just more work being worth more.

Only **completing** scores. Deleting is worth nothing either way — it is a thing he decided not to
do, not a thing he failed at — so calling off a whole series is free and needs no special case.

`priority` carries three values, and the third is a kind rather than a weight:

| | | |
|---|---|---|
| `1` | important | counts double, both directions |
| `0` | normal | the default |
| `-1` | **exempt** | scores nothing, never badges, closes itself when its moment passes |

Exempt is for things that are on the schedule but are not tasks — a shift, an appointment, a
reservation. Nothing is owed, so there is nothing to earn for "completing" one and penalising him
for not ticking one off is worse than useless. `tasksScore` **branches** on it rather than relying on
`1 + priority` arriving at zero: a zero multiplier would still let the item count as overdue and
badge. `dueTick`'s `closeExempt()` marks them done once their moment has gone, using the SCORING
deadline, so an all-day one closes at the end of its day rather than at 9am when it notified. Their
`done` flag is suppressed on the calendar — passing is not an achievement.

**The drain rate is constant per overdue item and never stops**, so ignoring something for a week
costs more than ignoring it for a day. What bounds it is the floor at zero, not a cap on the item —
that distinction is the whole reason the queue exists.

Its inputs are ordinary `list_items` rows, not a ledger: a completed item persists, so it is its own
record. (`task_events` existed for one afternoon and was dropped in `00089` for exactly that reason.)

Every constant is in one block at the top of `score.js`. **`TASK_RATE` is the amplitude knob** —
completions/day that holds the band full — and `TASK_FULL_UNITS` derives from it, so one ordinary
on-time completion is worth `1 / (RATE · DECAY_DAYS / 2)` of the band. At 4 that is 7 points, about
2.3 of the overall bar.

Set it from the rate there is actually something to *earn* against, and that is what the late curve
leaves rather than the raw count — five completions run an hour or two past their deadlines land
about four units. A rate far above the real one leaves the gold unreachable no matter how well the
day goes, and a band that cannot be filled measures nothing, which is what 8 did. At 4, a steady two
a day settles the band at 50%, three at 77%, and four or more on time fills it. Stopping dead from
full runs 92 → 71 → 51 → 33 → 18 → 8 → 0 over the seven days of the decay window, so the first idle
day is the expensive one.

`TASK_DECAY_DAYS` is **not** a second amplitude knob, and it is the easy mistake here. The queue's
steady level is `RATE · DAYS / 2` and FULL is defined as that same product, so the completions/day
needed to hold the band full is `TASK_RATE` alone — shortening the decay makes each task worth more
*and* fade sooner, leaving the hold rate untouched. What it does change is memory: how fast a good
run stops counting. It matches the seven days training and nutrition look back over.

**Units are internal; POINTS are what is displayed, and the display is the truth.** The band holds
`TASK_FULL_UNITS` of the first and exactly 100 of the second. `bandPoints()` converts, and
`toPoints()` quantises to a whole point — every completion is scored *through* `toPoints()` before
it is admitted, so a chip's integer is not a rounding of the credit, it IS the credit. Verified
against the replay: a chip reading `+7` moves the bar by 7.000 from any starting level, `+5` by
5.000. Chips carry no suffix, because the number is already on the scale the bar is drawn against,
and anything under half a point is not rendered, since a `+0` chip says less than no chip.
`server.js` formats them once in `scoreFields`, for all three surfaces that draw them.

Quantising at the source is also what makes the POTENTIAL chip actionable. "Do it now for +5" holds
across the whole stretch of lateness that rounds to 5, so completing anywhere inside it pays exactly
5 — where a continuous value moved while it was being read.

**Do not clamp a chip to the band's remaining headroom.** It looks like the honest fix — a `+7` on a
band at 96 seems to promise points there is no room for — and it is wrong. Measured at 41%, at 85%,
and at a band held down by twelve completions a day: 7 points every time, then 6, 5, 4 … one a day
until it is gone at seven. A completion admitted over FULL pushes credit off the OLDEST end, and old
credit carries almost no remaining life, so next to nothing is destroyed; clipping removes *weighted*
units, so each one clipped costs a large amount of face credit and the queue self-limits in the high
90s rather than sitting against the ceiling. Clamping would report 0 for a task worth a week of
holding the bar up.

**The band is a stock, and being late takes points out of it.** No debt is recorded. The points are
destroyed once, the level is whatever is left, and the way back up is completing things. The bar
falls by exactly what was billed at the moment it is billed — 7 points per day overdue — and from
there the band behaves as it always does: what remains decays on its own clock, and completions add
to it. Measured: three completions while an item is still overdue move the bar +21.00, its full face
value.

**Both alternatives were built and measured, and each is wrong in the opposite direction.**

| shape | what it gets wrong |
|---|---|
| a running DEBT subtracted from the level | holds the bar down by a fixed amount that never lifts — one item finished late becomes a punishment with no end |
| a decaying NEGATIVE ENTRY | the reverse: the penalty shrinks back to nothing on its own (measured closing from 8.2 points to 1.4 over five idle days), so lateness can be waited out instead of worked off |

Destroying credit is neither. It also settles which end to take from: **the newest**. Points stay
coupled to events because the decay has to know when each point landed, so a debit has to name
credits — and the newest is the credit actually holding the level up. Taking from the oldest lets the
penalty eat credit that was hours from expiring anyway, which is how a day of neglect once cost the
bar 5 points instead of 7 and stopped biting after two days. Overfill still takes from the oldest,
and that asymmetry is deliberate: displacing the credit closest to ageing out is right when the queue
is merely full, and wrong when something is being taken away.

A destroyed point shares the fate of every other point in the band — worth 7 now and less later — so
a day of neglect measured a day *afterwards* shows as ~6.5 rather than 7. That is the same discount
a completion earns, not the penalty leaking away.

**A completed row still carries a drain span**, from its deadline to its `completed_at`, so finishing
something late does not un-bill the hours it sat: an item three days overdue reads 42.9 whether it is
still open or was just completed, against 59.1 had it never existed. **Deleting is the honest way
out** — it stops the charge without claiming the thing was done. And `completionValue` no longer goes
negative: it slides +1 → 0 over `TASK_LATE_ZERO_H` and stops, because lateness is billed by the hour
and a negative charged the same lateness a second time in a lump.

The floor at zero needs no special case. Credit that is not there cannot be destroyed and the
shortfall is not remembered, so neglect empties the band, never digs under it, and the next
completion moves the bar by its full value however long the neglect ran.

`TASK_RATE` moves the drain with it, since the drain rate is quantised through the same `toPoints()`.
That keeps one invariant that does not depend on the rate: **an item left overdue for a day cancels
exactly one on-time completion** — 7 against 7, in bar movement and not merely in bookkeeping. Change
the amplitude and that trade stays where it is.

**Staged meals on the rings.** A staged meal (`nutrition_entries.staged = true`) is food that exists
but has not been eaten, so it never touches `consumed`: every number, and the whole arc, reads
exactly as it would with nothing staged. `computePace()` takes the staged totals separately and adds
one number per macro — `staged_mark`, the position the arc would END at if the meal were committed
(the overflow position once that is past full, since the ring wraps). The clients draw it as a second
tick beside the white pace one, in cyan `#22d3ee`: the rings sweep hue 0–120 plus amber overflow and
the pace tick owns white, so cyan is the only mark that can never read as a ring state. Staged rows
carry no day (they belong to whichever day they are eaten on), so the query that sums them has no
window filter.

**Tick positions run with the arcs.** `markPts()` (card) and `PaceMark` (widget) both take turns
**clockwise from twelve**, the direction the arcs fill. The pace tick is drawn at `1 - frac` — where
the arc ends with nothing logged — which is the same point as `frac` counter-clockwise; the staged
tick is a genuine arc position and would land mirrored if fed to the older convention.

**Drain rate.** `pace.window_hours` and `pace.per_hour` (per macro) are the slope of the pace line —
the day's goal spread evenly across the eating window, i.e. how fast the rings drain with nothing
logged. Constant for the day; it moves only when the window or the goal moves. Nothing draws it yet:
it is computed and shipped (on `buildStatus()` and on `/api/rings`, once per response rather than per
frame) so a surface can pick it up without re-deriving it.
| `score.js` | Weekly overall score = 0.5·training + 0.5·nutrition. |
| `variants.js` | Exercise equipment variants + YouTube how-to links. |
| `dates.js` | The 4am-origin "day" + display-timezone helpers (`TZ_DISPLAY`, default America/New_York). |
| `apns.js` | Dependency-free APNs sender (HTTP/2 + ES256 `.p8` JWT), per-token sandbox/production. |
| `weightReminder.js` | The daily weigh-in push scheduler (§8). |

---

## 5. API surface (`server.js`)

**Pages:** `/` + `/phone` (the phone's home page — the home wall's content, in portrait and at the
phone's own scale) · `/tv` (the home wall, the TV default) · `/tv-health` (health wall — what
the health wall) · `/tv-session-focus` (sessions wall) · `/tv-calendar` (calendar wall) · `/calendar` (phone/desktop calendar) · `/page` (desktop dashboard) · `/mic` (voice
launcher) · `/reports` + `/report/:id` (§6c) · `/login` · `/healthz` · `/privacy` · `/terms`.

**Read:** `/api/status` (full payload) · `/api/stream` (SSE status) · `/api/voice-stream` (SSE voice
frames for the kiosk, and `request` frames for the TV sidebar) · `/api/voice-pending` (unfinished hub requests, the sidebar's reload) · `/api/list-stream` (SSE, one bodiless `lists` event whenever a dated item or
a list changes — the calendar surfaces' push path, separate from the status frame they don't render) · `/api/workout-day` · `/api/nutrition-day` ·
`/api/heat-history` (the heat-grid weeks OLDER than the frame's `HEAT_WEEKS` window, as a prefix the
expanded sheet draws in front of it — the frame is re-pushed on every realtime event and history only
grows, so it is fetched once by the one surface that can scroll through it) · `/api/voice-messages`
(`?mode=active` resolves `agent_mode` on the server, for a client with no settings of its own — the
watch; the current context, preceded by every answer still unread (`needs_read`, no `read_at`, any
age) with the question it answered, unless `?history=1`, which returns older contexts too with
`ctx_break` on the first row of each so the conversation card draws a divider there; live rows on
`/api/voice-stream` carry the same flag, by the same `opensContext()` rule) · `/api/voice-reply/:id` (held open until that command is `done` or `error`, settled by the
`voice_requests` realtime subscription; after 25s it answers `pending` and the client asks again) ·
`/api/day-stream` (SSE, a bodiless `nutrition` or `workout` frame whenever that day may have changed —
fired from `dirtyNutDay()` / `dirtyWorkoutDay()`, which every write path already calls; the watch's push
path) · `/api/nutrition-day` also takes `date=today`, so a client with no 4am-origin day of its own
gets the server's, and ships that day's own `produce` fill gauges beside its totals and targets so a
surface pointing the rings at a selected day moves all seven of them together ·
`/api/todos/alarm` (sets or clears a dated item's `alarm` mark; what rings is `docs/ALARMS.md`) ·
`/api/todos` (lists + the derived `due` view) · `/api/calendar` (month grid(s) of every
dated item — every occurrence is a real row, so nothing is projected; `?month=` pages, `?wall=1` adds
the day timeline and reads `calendar_months` for the spread, `?day=1` is the timeline alone and
`&full=1` makes it a rolling ±12h window instead of a calendar day — see the dial below, and
`&ahead=N` adds the N days after today as `ahead`) · `/api/badge` · `/api/repos` ·
**A session reply's notification is a SUMMARY**, written by the machine that produced the reply, not
by the hub. The orchestrator (voice-pipeline `sessionWatch.js`, `summarise`) runs the answer through
`claude -p --model haiku` on its own subscription, posts `done` at once with `summary_coming`, then a
`summary` frame that `notifySessionReply` pushes as the body. The hub holds no Anthropic key and makes
no model call. A host that sends no summary, or whose summariser failed, is notified from `done` with
the raw reply. Tapping it opens that session either way; the payload is untouched.
The same sentence is stored on the turn's `desk_turns.summary` (`storeSummary`, data-layer 00133),
which is what voice `get_sessions` shows as each session's last answer.

`/api/session-activity` (what a host's transcript watcher saw: `queued`/`said` for HIS words with the
prompt's id and, when the host typed them for a command, that command's id; `tool`; `text` for what
it says between calls; `done` with the whole reply and its prompt. **Each becomes one event of the
conversation's list** — `logFrame` — and goes out as an `ev` frame with its seq; see the event log
below) ·
`/api/repos/cmd/:id` · `/api/sessions` (live desk sessions + the follow-up `focus`; `?brief=1`, the watch's, drops every row's `last_reply`; each row carries
`unread`, a finished reply nobody has opened) · `/api/sessions/seen` (opening one stamps
`desk_sessions.seen_at`, which is what clears it on every surface) ·
`/api/session-stream` (SSE: `ev` — one event of a conversation's list, with its seq and the hub's
epoch; `sessions`, the whole `/api/sessions` payload, pushed whenever `desk_sessions`/`desk_queue`/
`desk_focus` change, which is what replaced the walls' 5s poll — see SESSIONS.md §10; and, until the
older watch build is gone, `session`) · `/api/sessions/:id/events?since=N` (the list after seq N,
what a client fetches when a frame's seq shows a gap) · `/api/reports`
(list only — `html` is never selected) · `/api/surf/history` (the whole hourly archive as one
character per hour; `defaultT0` marks the window the card lands on before it is scrolled back) ·
`/api/wind` (the frame's `wind`, plus the last few hours of six-minute readings) ·
`/api/surf/live` (the surf app's payload: the surf card's data, `wind`, `buoys`, and the forecast's next twelve hours ready to paint) · `/api/surf/stream` (the same, PUSHED on each wind reading, buoy reading or forecast) ·
`/api/attachment`.

**Widget feeds** (compact, one per widget — §9b): `/api/rings` (a timeline of per-minute pace frames,
not a snapshot; the watch reads it too) · `/api/workout-now` (the watch's workout page: the rest-clock
inputs, `sets_today`, and every exercise today — newest first by its last set — each with its muscles'
weekly sets and volume colour) · `/api/due-widget` (every dated item across every list) · `/api/repos-widget` (the
Mac's projects + desk presence). `/api/list-widget` returns one list's item titles and is the
per-list feed `/api/due-widget` replaced; nothing reads it.

**Write:** `/api/settings` (GET/POST) · `/api/log-set` · `/api/log-entry` (POST/DELETE) ·
`/api/commit-staged` · `/api/feed` · `/api/todos/{add,clear,snooze}` · `/api/repos/open` ·
`/api/sessions/:action` · `/api/voice-command` (raw audio of any size → Groq Whisper, English only →
enqueue; the clip is kept in the private `voice-clips` bucket and named in `voice_requests.audio`, both
deleted by pi-desk after 7 days; optional `lat`/`lon`/`acc`/`place` query → `voice_requests.location`) ·
`/api/voice-text` (text → enqueue, optional `location` object likewise; `shared: true` stamps source
`share`, see §9d; returns the request id, which `/api/voice-reply/:id` waits on) · `/api/voice-reset` (stamps `voice_reset_at`; the thread is kept) ·
`/api/voice-activity` · `/api/voice-mute` (take or give back one holder's mute) · `/api/attach`
(photo upload) · `/api/gestures` (the watch's gesture captures: POST one, GET the last week, GET `/<day>/<file>` for one; bucket `gesture-captures`) · `/api/register-push` · `/api/notify` (APNs to all devices) · `/api/clientlog`.

**Outside the gate:** `/api/cg/transcribe` — the restaurant watch app's voice input, raw audio → Groq
Whisper → `{transcript}`, nothing enqueued. That app ships to TestFlight testers, so it cannot hold the hub
token. Only the owner's device gets through, recognised by either `X-Owner-Token` (a dedicated random
token; Fly secret `CG_OWNER_TOKEN_SHA256` is its hash, and the token itself is in the Mac's
`~/.config/menu-app/owner-token`) or, from builds up to 44, `X-Owner-Key`: the owner's Anthropic key,
whose SHA-256 is `CG_OWNER_KEY_SHA256`, the same hash as `AppGate.ownerKeyHash` in CapitalGrilleApp. When
`X-Owner-Token` is sent it alone decides. `X-Owner-Key` goes once no build in use sends it. Every request writes one `[cg-transcribe]` line: size, time
and word count, or `REFUSED` / `FAILED` with the reason (`CLIENT GONE`, a plain line rather than an error,
when the watch hangs up mid-upload — its own `voice_*` rows record that side), and one `app_logs` row (`kind` `voice_hub`) under
the watch's `X-Interaction-Id`. The watch logs its own side of each question to
Supabase `app_logs` (`voice_*` rows, CapitalGrilleApp `VoiceLog`).

The same app's **order list** is outside the gate on the same key: `GET /api/cg/orders` (open orders plus
the two models), `POST /api/cg/orders` (items as heard), `POST /api/cg/orders/standardize` (each row
matched to the menu and renamed in place) and `POST /api/cg/orders/done` (`{id}` or `{all: true}`), over
Supabase `cg_orders`, which has no anon policy. A `POST /api/cg/orders` whose `interaction_id` already has rows answers with those rows and writes nothing, so a retried or fallback write never lists a recording twice. The watch's own model runs both passes; which model each
uses is `cg_orders_model_first` / `cg_orders_model_second` (§7).

**Auth** (`lib/auth.js`). Three credentials, each accepted as the `hub` cookie or in a header
(`X-Hub-Token`, or `Authorization: Bearer`):

- **A session**, `s.<id>.<secret>`: what `POST /login` sets, one `hub_sessions` row per browser
  (data-layer `00153`, only the secret's SHA-256 stored). Ten years, like every hub cookie. Held in
  memory, loaded at boot (a session cookie answers 503 until the load lands, never a bounce to
  /login) and kept current by realtime, so a revocation made in SQL applies at once.
- **The device token** `TV_TOKEN`: the kiosk, the bedroom TV, and every machine client, in the header.
  A browser that can only be given a URL (the Pi's kiosk) loads `?token=` once: the gate sets the
  DEVICE COOKIE (`d.` + an HMAC of `TV_TOKEN`) and 302s to the same URL without the token. A page
  load signed in by the header (the bedroom TV's sidebar web view) gets the same cookie for its own
  requests. On an API call `?token=` is still accepted for clients not yet moved to the header, and
  the gate logs `[auth] ?token= on <path>` once per boot per path (never the token) — when those lines
  stop appearing, that acceptance can be removed.
- **The password-derived token** `sha256("status-hub:"+password)`: what the native app derives from
  its Keychain password, sends as `X-Hub-Token`, seeds as its web view's cookie at every launch and
  hands the watch (whose `voice-fallback` path checks its hash). Browsers signed in before sessions
  existed hold it too; a BROWSER page load carrying it (a user agent with a browser's token in it,
  which WKWebView's lacks) is moved onto a session (`via = 'upgrade'`). It is a password equivalent
  and ends only when `HUB_PASSWORD` changes.

**Signing devices out**, without changing the password:

    bin/hub GET /api/auth/sessions                          # every session: id, created, user agent, ip
    bin/hub POST /api/auth/revoke '{"id":"<session id>"}'   # one device
    bin/hub POST /api/auth/revoke '{"all":true}'            # every browser session

Revoking ends sessions only. The device cookie ends when `TV_TOKEN` is rotated (every copy listed
below), and the password-derived token when `HUB_PASSWORD` is changed (the native app then asks
for it again).

Every comparison is constant-time (`safeEqual`). The server refuses to start without
`HUB_PASSWORD`. `POST /login` locks out an IP after 5 wrong passwords in 15 minutes (in memory, so a
restart clears it; `LOGIN_*` in server.js). There is no all-clients cap: anyone could trip it on purpose.

**From a shell, call it with `bin/hub <METHOD> <path> [json | @file]`** (`bin/hub GET /api/status`), on the
Mac or the Pi. It reads the kiosk token from `$HUB_TOKEN` or this repo's gitignored `.env` and hands
it to curl on a config descriptor, so the token is never in a command line, its output or `ps`. Do
not dig the token out of a file to build a curl by hand: Claude Code's safety check refuses a command
that would print a secret, and that refusal is what such a session runs into.

The kiosk token is `TV_TOKEN` on Fly, and its copies are:

- on each machine: `status-hub/.env`, `voice-pipeline/worker/.env` (`HUB_TOKEN`, which pi-desk also
  reads), `gmail-watcher/.env`, `~/.config/ops/env` (the responder), and `~/.config/google-tv/hub-token`
  (which `bin/tv sidebar token` pushes into the bedroom TV's companion app, where TvLink signs in with
  it; the app keeps the old one until that is run);
- on the Mac: the installed `com.jaredgantt.voice-orchestrator.plist` (`HUB_TOKEN`) and
  `~/.config/ops/hub_token`;
- on the Pi: the kiosk URL in `~/.xinitrc` (read once when X starts, so the X session has to restart:
  the relaunch loop reuses the old URL; `tv-ring` reads its token from the same line);
- on Fly: `HUB_TOKEN` on `jared-voice-worker`, `ops-responder` and `jared-desk-fly` (the Fly session
  machine, where `bin/hub` reads it from the environment; it is stopped, so set it with `--stage` and
  then `fly secrets deploy`), and `HUB_NOTIFY_TOKEN` on `litter-robot-watcher`.

A new token has to reach every one of them. None of them is in git.

Every route is registered on one of two routers, and that is its auth: **`gated`** (behind `hubGate`,
static assets included) or **`pub`**. Both are mounted once at the top of server.js, so where a route
is defined does not matter. Public: `/healthz`, `/login`, `/privacy`, `/terms`, the Search Console
verification file named by `GSC_VERIFICATION`, `/api/cg/*` (gated by their own owner check, above),
and the surf app's page with its bundle and stylesheets and `/api/surf/live`, `/stream`, `/history`.
`test/auth.test.js` reads every registration from the source: the public set must equal its list, and
every gated route must refuse a signed-out request. The legal pages
and the verification file have to be anonymous — Google fetches them as an unauthenticated
crawler, and behind the gate it would get the login page and fail every check.

---

## 6. Lists (and what used to be reminders, and notes)

**There is no reminders table.** A reminder is an item with a `due` date — nothing else distinguishes
one (data-layer migration `00056`). The two tables were already the same row shape and differed only
in that `reminders` had `due` and `list_items` had `list_name`; every behavioural difference followed
from `due` alone, and an undated reminder already behaved exactly like a to-do. Meanwhile `todo` was
never special either — it is one row in `lists` beside `grocery` and `Amazon`.

So `due` now lives on `list_items` and **any item on any list can carry one**. A dated Amazon item
fires and badges identically to a dated to-do; there are no classes of item. "Due" in the pane is a
derived cross-list *view*, not a stored list, so a dated item shows both there and on its own list
while being one row.

**A list is addressed by its id** (data-layer `00094`). `lists.id` is the key ('l_grocery'),
`list_items.list_id` the reference, and `list_name` on an item is a DERIVED copy kept by trigger —
draw it, never match or write on it. Grouping items by name would break the moment a list is renamed,
which is now a rename rather than a re-parenting of every row.

That also removed a fork this surface owned: `/api/todos/add` used to create a list on any
unrecognised name, matching case-sensitively, so `Grocery` made a second list where the data-layer
tools resolved it to `grocery`. Composers post the id they were drawn with, and the endpoint 404s on
anything else.

**There is no notes table either** (data-layer `00092`/`00093`). A note was the same row shape with
capability removed — `(name, content, updated)` against an item's `(title, text, updated)`, minus a
due date, a priority, completion, soft delete, and a seat in the realtime publication. It is now an
undated item on the `notes` list, name in `title` and body in `text`, and the pane needed no new code
to draw it: `bodyFor()` already expands an item whose `text` is longer than its label, which is what
a note is. Reading and writing one goes through `get_lists` / `add_to_list` / `remove_from_list`;
there are no note verbs.

Consequences worth knowing:

- **Badge** = every overdue item across every list (`overdueCount()`), not just one table's. It is
  PUSHED — from the `list_items` subscription and from `dueTick` when something fires — so its own
  timer is a 10-minute backstop rather than the thing keeping the icon honest.
- **Firing and overdue are different moments.** `dueMoment` is when an item notifies, and only
  `dueTick` reads it; a date-only item fires at 9am. `lateMoment` is when it stops being on time — the
  scoring deadline, which for a date-only item is the next day's 4am origin — and every surface that
  calls something overdue reads that one: chip red and dimming, the badge, the pane, both widgets. Mix
  them and an all-day chip goes red at 9:30am while it is still worth its full +7. data-layer's
  `isExpired` holds the same rule.
- **The scheduler** (`dueTick`) wakes every 60s but only SCANS when the next due moment has arrived or
  a `list_items` change dirtied it — a moment passing is not a row changing, so the clock stays and the
  query goes. It reads `list_items` where `due` is past, dedupes against
  `notifications.dedupe_key`, and hands off to a **named handler** in `DUE_HANDLERS` rather than
  calling `pushAll` directly. Only `push` exists today.
- **`kind` is gone** from `/api/todos/clear` — one table, one thing to clear.
- **Recurrence is materialised, not stored.** There is no `repeat_every` column (data-layer
  `00085`/`00086`). `add_to_list`'s `repeat_every` is an instruction executed once: it writes one
  dated row per occurrence out to `repeat_until` (default a month), all sharing a `series_id`. So
  `dueTick` re-arms nothing, and the calendar reads real rows instead of projecting future ones —
  a projected chip was a drawing of an item that did not exist and could not be tapped or cleared.
  `remove_from_list` with `series` clears what is left of one.
- **The dedupe key is `reminder:<id>:<due>`** — scoped to the occurrence, not the row. Each
  occurrence is its own row now, so the id alone would nearly do, except that **snooze** moves `due`
  on an existing row and must be allowed to fire again at its new moment; including the due gets
  that for free. The `reminder:` prefix stays because migration `00056` preserved item ids so that
  ledger rows written before the merge still match — rename it and every already-delivered item
  fires again.

### Done and deleted are different acts

An item has two ways off a list and they are not variants of each other:

| | what it means | where it goes | score |
|---|---|---|---|
| `completed_at` set | he did it | off the active lists, **stays on the calendar** | earns the gold band |
| `deleted = true` | he is not going to do it | gone; purged after 30 days | nothing |

Everything active — the pane, the widgets, the badge, `dueTick`, the drain — asks for
`deleted = false AND completed_at IS NULL`. The **calendar** is the one surface that also draws
completed items, with a tick and a struck-through label, because watching the day fill in with what
got finished is the second half of the reward.

The endpoints mirror that: `POST /api/todos/complete` (also takes `undo` and `at`) and
`POST /api/todos/clear`.

### `at` — a completion that did not happen just now

`completed_at` is not a bookkeeping stamp, it is the entire input to what the completion is worth:
full value inside the 30-minute grace, sliding to nothing by four hours, negative by a day. So a
thing finished at 10:15 and reported at two in the afternoon scored as four hours late, and the only
truthful option was not to report it at all. `at` says when it actually happened; omitting it stamps
the clock, which is what the pane's ✓ swipe, the widget's Done and every ordinary completion do.

`lib/score.js` `completionStamp` decides what is acceptable, and it lives there rather than beside
the route because the rule is the band's:

- **A zone on it is refused, not converted.** The band measures `completed_at` against `due` as naive
  wall-clock arithmetic — that is what makes a lateness one he experienced rather than one an offset
  invented. `score.js` has no timezone to convert with, so accepting a `Z` would mean guessing an
  offset, and a guessed offset puts a completion an hour from the deadline it is scored against.
- **The future is refused.** The replay walks up to now and skips anything past it, so a future stamp
  would take the item off every active surface and earn nothing — from the outside, identical to the
  band being broken. Refusing it is the only way that failure is visible.
- **The distant past is allowed.** Older than the 7-day decay window it earns nothing, but that is
  the decay working on a true record, not a bad input.

The data layer writes this column directly rather than through the hub, so `lists.checkCompletedAt`
enforces the same rule at that door. Two doors, one column; keep them saying the same thing.

Voice is the surface that uses this — the model works out the absolute time from the item's own
`due` (which `get_due` hands it) and passes it. There is no time parsing anywhere in the path, and
none should be added: `at` takes an exact stamp precisely so that no layer has to guess at what
"fifteen minutes after it started" meant.

**This was tried the other way round first and failed.** One verb, with the clock deciding whether a
removal counted as a completion, on the reasoning that "remove", "delete" and "check off" are not
separable in speech. The failure was immediate and was not the one predicted: with no completion
verb to land on, *"take the shirt off the list and put it back up at 1 for the dryer"* routed to
`set_due` and simply moved the item — two instructions collapsed into one reschedule. Distinct
outcomes need distinct verbs. Do not re-merge them.

Two more things that are easy to undo by accident:

- **`list_items` invalidates the row cache.** Its realtime handler calls `dirtyRows('list_items')` and
  `broadcast()`, not just `pushLists()`. Without that a completion would not reach the bar until the
  15-minute backstop — the one moment the reward is supposed to land.
- **Overdue rows escalate in colour** with a server-computed `heat` (1–3). The gold band floors at
  zero, so once it is pinned there a second neglected item cannot show on the bar at all — the bar
  shows what has been earned, the row shows what is owed.

### The wall's day timeline

`/api/calendar?wall=1` ships `dayline` fully laid out. Each hour is **two half-hour lines**, and the
second is *reserved* for `:30`–`:59` — a 4:30 item sits on the lower line even when 4:00 is empty,
because that placement is the only thing saying which half of the hour it is in: day chips carry no
time label and no repeat glyph, both of which were spending width that several chips now share.

**`?day=1&full=1` returns a rolling window, not a day**: twelve hours either side of the current
hour, crossing midnight in both directions, each carrying `t` — hours from today's midnight, which
may be negative or past 24. That is the coordinate the dial angles off, and it is what lets a client
draw a continuous timeline without knowing anything about dates.

It also puts **`tasks`** on `dayline` — `gained`, the points completions have landed since today's 4am
origin, and `loss_per_day`, the rate the task band is falling at — drawn at the end of the dial's date
line as `+gained (−loss/d)` rather than on the health bar, which is three bands. Two moments that
change neither number through a row are folded into `next_transition`: a completion ageing out, which
steps the rate, and the next 4am, which zeroes the gain.

And it ships **`overdue`**: every expired, unfinished item whatever day it was due, oldest first, each
a normal chip plus `when` — the time if it was due today (empty for an all-day item), the weekday if
within the last six days, `M/D` before that. It is read from the rows rather than the day buckets,
because the buckets stop at the month grid and an item left overdue for a month is still overdue.
With `full=1`, `allday` is empty: the dial draws no strip, and holds all-day items in the dock until
their day ends (from `ahead[0]`, which carries them) and in `overdue` after.

### The look-ahead (`?ahead=N`, home wall only)

`ahead` is the N days AFTER today, in order, each with `dow`, `day`, a `month` on the day the number
resets, its `items`, and the `more` the box could not hold. The server caps at
`LOOKAHEAD_MAX_PER_DAY` for the same reason it caps a half-line: the box is a sixth of a column of
known height, so how many chips fit is a fixed number, and two surfaces deciding it separately is two
surfaces that will disagree about which item got dropped.

**A day's box is a grid, and the chips size themselves to fill it.** `aheadGrid()` ships `rows` and
`cols` per day, the rows are `1fr`, and the chip's font is derived from the row it landed in — so no
box ever has a spare strip under it. This column exists because the wall is short of room; a fixed
chip size sitting in a box of unknown fullness is what leaves 14px of nothing under a full day.

| items | grid | text |
|---|---|---|
| 1–4 | 4 rows × 1 | 20px — the **ceiling**; nothing is bigger, or one item alone is a banner |
| 5 | 5 rows × 1 | 15px — the day column's own chip size |
| 6 | 6 rows × 1 | 12px — the **floor** for a full-width title |
| 7–10 | ⌈n/2⌉ rows × 2 | 15px, titles truncate |

Two things there are not obvious:

- **The second column starts at seven, not six.** Six in one column holds every title WHOLE and
  fills the box; six in two columns holds four characters of each and leaves two rows empty, because
  three rows of two cannot grow into the other two — an 85px chip has no use for 28px of text. Two
  truncated columns above a gap is worse than one full column.
- **A two-column chip is limited by its WIDTH, not its row**, so `[data-cols="2"]` caps the font at
  the five-row size. That is the one place a pixel number is written out rather than derived: the
  calc can see the row's height and cannot see the chip's width.

The font comes from `100cqh` on `.cw-witems` (`container-type:size`), so it is the same division the
row heights already are rather than a copy of the box's height that drifts the moment anything above
it changes. `--rows` is inherited from the day box; `data-cols` exists because CSS can lay a grid out
from a custom property but cannot branch on one.

Three things about it that are not obvious from the payload:

- **The expansion window is widened to reach it.** `byDay` is built over the month grids' span, which
  ends on the Saturday after the month's last day — and therefore ON that day when the month ends on
  a Saturday. The look-ahead then runs off the end of it, so `endKey` takes whichever of the two
  reaches further. Without that, a month ending on a Saturday shows six empty boxes.
- **It is a list, not a timeline.** Hour rows for a day nobody is living in yet would spend the box
  drawing empty hours; at a day's remove the question is only what is on the day.
- **Its chips carry their time**, which the day column's never do — there is no hour row under them
  to say it. That is `chip(it, true)`, the one place the second argument is passed.

### The dial (`cards/dayline.js` `project()`, home wall only)

The home wall draws the day as a drum turning behind the glass rather than as a list. It is the real
projection, not a shrinking effect: an hour `d` hours from now sits at θ = (d / 12)·90°, its position
is `R·sin θ`, and its height is whatever is left between its own two edges. Two properties fall out
of that, which is the reason to do it properly rather than taper the rows by hand:

- **now is the centre**, because sin 0 = 0 — nothing has to be offset or kept in sync as the clock moves;
- **the rows fill the column exactly**, because the ends are at ±90° and sin of that is ±1.

The hour numbers scale and fade with `cos θ`, which is the foreshortening a real drum shows and is
what makes it read as turning rather than as a list with small ends. Past the point where a chip can
be read it goes `.thin` and drops its words — **and nothing else**: same fill, same 4px coloured
left edge, a chip with no room for a title. `.sliver` takes the hour number too.

`.thin` used to invert the chip instead — border off, the list's colour flooding the whole width —
to keep a few-pixel item visible. It is an attractive idea and it is wrong: the colour that marks a
chip's left edge everywhere else became its entire body, so the rim of the dial read as coloured
bars belonging to no family on the wall, directly above the chips they were the small version of.
It also put the loudest mark in the column on the hours furthest from now, which is the dial's
emphasis backwards. Legibility at the rim is not worth a second visual language.

**`.thin` is decided from the half-line's measured height, not the row's.** An hour is two half-lines
whatever is in it, so a row-height threshold flattened a lone item at the same distance as a pair.
`project()` reads the occupied half's `clientHeight` back out of the layout in a second pass over the
rows — hence two loops, and hence a `--chiph` the CSS sizes the chip's text from. Reading it back
rather than recomputing it here is deliberate: the paddings and gaps live in the CSS, and a copy of
them in JS drifts. It is safe because a half's height comes from the row, never from what is in it,
so nothing `.thin` does feeds back into the measurement.

**An hour keeps its two half-lines only while both can hold a chip.** One number decides it —
`--chip-full`, declared on the dial in `tv-home.css` and read back by `project()`, so the CSS floor
and the JS decision cannot drift apart. Around now, where rows are 50-60px, both halves clear it and
the `:00` / `:30` placement reads normally. Below that the row cannot give two full chips, and which
way it gives depends on what is in it:

- **one half occupied** — it takes what it needs from the empty one, which shrinks away
  (`.cw-hitems:has(.cw-half:empty)` in `tv-home.css`);
- **both halves occupied** — there is nothing to borrow, so the two lines *merge* into one and the
  chips sit side by side, exactly as two items in the same half already do. Overflow past the line's
  two chips becomes the `+N`, counting each half's own `more` in. The merged line keeps an empty
  second half so the same floor applies to it — without that the chip stretches the whole row, and
  hours further from now end up with fatter chips than the ones at the axis.

Both are continuous at the crossover: the occupied half is *already* exactly the floor when the
regime changes, so what changes is the number of lines, never the size of a chip. In practice the
split survives about four hours either side of now, and a merged hour keeps its words out to about
nine. Below `CHIP_MIN` there is no room for words at all and the row goes `.thin`.

The decision reads the box's height, the gap and the floor — none of which depend on what it last
drew, unlike measuring the halves themselves, so it cannot oscillate against its own output.

**Both ends of the dial are covered, not shortened**, so the axis stays the middle: the dock over the
tail (which also holds today's all-day items), and over the head one opaque block (`.cw-top`) of
overdue rows and the date.
Which items those hold is decided after the projection (`paintEdges`): an item is shown on the dial
only if its row is not `.thin` and neither cover reaches it. A row a cover reaches is `.covered` and
blanked, so the cover's edge never cuts an hour number or a chip in half. CLAUDE.md § The day column
has the membership rules.

**`server/tools/dialtest.html` is the bench for all of this**: the column at its real size, a stubbed
payload, and a frozen clock, with `?case=` choosing what is in the hour and `?hour=` sliding it up
and down the drum. `?overdue=N` fills the top cover, `&allday=1` puts an all-day item in the dock,
and `&redcase=1` turns the items under
test red so `?hour=` shows the point where an overdue item leaves the dial for the cover. It is deliberately outside `public/`, so it is not in the image. Use it rather
than real rows — a dated item with a past `due` pushes a real notification.

**A calendar day cannot feed this** — that is what `full=1` exists for. Tried with one day, by 21:30
the dial had 21½ hours crushed above the line and 2½ below it, the column half empty. The window is
symmetric by construction whatever time it is.

Rows must be `box-sizing:border-box` with no padding: the projection writes an exact pixel height per
row, and content-box adds the padding and border on top of it — four pixels a row, eleven across the
column, which is the now-line missing the axis it is supposed to define.

**The now-line belongs to the column, not to an hour.** The payload marks the hour containing now and
draws the marker inside it, which is right for a list and wrong for a drum: that row slides, so the
marker slides with it, out of the row's `overflow:hidden` and out of sight a few minutes after every
hour. `project()` drops those and puts a single line on the box at the axis. For the same reason it
recomputes `.cur` from the live clock every tick rather than trusting the payload's — the server
decides that once, at fetch time, and the dial only re-fetches when the hour rolls.

That re-fetch is required, not an optimisation: the window is centred on the hour it was built for,
so without it the dial drifts an hour off its own data every hour.

Nothing may sit above the hours box in the flow, for the same reason. The axis is the middle of that
box, so a 44px date heading above it put the line 25px below the middle of the column — measurably
lopsided, and read as a fault in the projection rather than in the layout. The date is absolutely
positioned over the top instead, where the rows are 1-9px slivers twelve hours out.

Chips on a line sit **side by side** and split it equally (`flex:1 1 0`), so one spans the line and
three take thirds. How many fit is a property of the column rather than of the data, which makes it
the server's call: `DAYLINE_MAX_PER_HALF` caps them and the remainder rides along as `more`, drawn
as `+N` — a hidden item stays visible *as* hidden.

Splitting the row was chosen over letting busy hours grow taller. Height standing for something
other than time makes a packed hour read as the day running longer than it does.

The hour label is the bare integer at 30px bold. The spine runs in order from morning to night, so
am/pm was never ambiguous, and dropping the letter is what buys the digit enough width to read from
across the room.

Voice/MCP writes them (data-layer tools); the hub surfaces them:
- **Card:** `public/cards/todo.js` — the lists in the phone's calendar sheet (and a wall's `lists` pane at phone size). Self-fetches `/api/todos` (not part of
  the status stream), refreshes on mount / after edits / on focus.
- **Endpoints:** `GET /api/todos` (lists + items + the derived due view) ·
  `POST /api/todos/add` (service-key writes; takes a `list_id` and **404s** on one that does not
  exist — this surface creates no lists) ·
  `POST /api/todos/clear` · `POST /api/todos/snooze`. Checking off and deleting are **different
  acts** (data-layer `00088`) — see "Done and deleted are different acts" above. Both are soft; a
  cleared row survives a recovery window.

---

## 6b. Desk control — the repo picker

Start a Claude session on the Mac from the phone: tap a project, a Terminal opens there running
`claude --remote-control <name>`, and the session is waiting in the Claude app. The hub only starts
it; the work happens over Remote Control.

**Every directory in `~/repos` is listed, git checkout or not** — filtering on `.git` hid the most
active work, which can be a directory that is deliberately not a repo. Git is decoration: the
branch chip and dirty dot render only when the directory happens to be a checkout, and `last_active`
falls back to the directory's mtime.

This server is on Fly — it can't see the Mac's filesystem or reach it over the LAN — so Supabase
carries both directions and a daemon on the target machine owns everything local: the Mac's
**voice-orchestrator** (Terminal tabs) and the Pi's **pi-desk** (tmux, so a session outlives the
laptop closing). A command reaches the Pi when the hub targets it explicitly, or when it is
untargeted and the Mac's presence has gone stale.

```
orchestrator ──scan ~/repos (60s)──▶ repos table ──▶ GET /api/repos ──▶ cards/repos.js
cards/repos.js ──POST /api/repos/open──▶ desk_commands ──realtime──▶ orchestrator ──▶ Terminal
orchestrator ──beat(30s)──▶ worker_presence(worker='desk') ──▶ the list greys out when the Mac sleeps
```

- **Card:** `public/cards/repos.js` — the phone's sessions swipe pane, self-fetching. The age column doubles as
  launch feedback (blue → green/red) while it polls `/api/repos/cmd/:id`.
- **Endpoints:** `GET /api/repos` (repos + desk presence) · `POST /api/repos/open` (enqueue) ·
  `GET /api/repos/cmd/:id` (pending → running → done | error | expired) · `GET /api/failures` +
  `POST /api/failures/:id/{retry,dismiss}` (commands that never ran).
- **A launch is refused, not queued, when its machine is asleep** — 409 with a `saved` id. The
  payload lands in `desk_dead_letters` instead of a `desk_commands` row nobody will claim. Same for
  `/api/sessions/end` and `/resume`, which target the machine that OWNS the session (read from
  its `worker`).
- **Guardrail:** the client's path selects a published ROW; the row's own path is what gets enqueued,
  so a crafted request can't `cd` anywhere else. The orchestrator re-validates independently, and
  commands older than 120s expire rather than opening terminals when the Mac wakes.

---

> Sessions have a document of their own: **[SESSIONS.md](SESSIONS.md)** covers the whole system.
> What follows is the hub's part in it.

### Sessions nobody dispatched

`desk_sessions` also carries the sessions Jared opened himself on the Mac — a `claude` process in a
Terminal tab, found by the orchestrator rather than announced by anything. `origin` separates them
(`adopted` vs `dispatched`), and they get the same liveness and last-reply treatment, so the panel
describes everything running rather than only what was sent.

**Adoption never touches `desk_focus`.** A session appearing is not Jared choosing it; unpinned, focus
is computed from activity (below), so nothing about adopting a session has to move a pointer.

Retention is not per-origin: `sweepRetention` in `pi-desk` drops closed sessions at 7 days and parked
ones at 14, whoever made them.

### Numbering, and moving a session

`/api/sessions` stamps each active session with `n`: **most recently active first**, running and parked
interleaved — parking is not activity, so an evicted session keeps its place (`active_at`, the last turn boundary — SESSIONS.md § Numbering says why not
`last_seen` or `started`), from 1, one row per conversation (`claude_session_id`). **That rule is duplicated in `data-layer/src/desk.ts`
(`numberSessions`) and the two must agree** — it is how "move session three to the Mac" resolves to
the same row the pane is showing. The number is a position, not identity: closing one renumbers the
rest, which is the price of it being short enough to say.

`POST /api/sessions/transfer` hands a session to the other machine. The row says which machine it is
on now (`worker`), so the destination is implied. Two paths, matching the voice tool exactly: if the
source machine is up it closes the session and flushes the mirror first; if it is not, the
destination resumes from what was already mirrored and the old row is marked `transferred`. A
session with no `claude_session_id` has no transcript to carry, so it cannot be moved. No surface has a
move button: moving is asked of the voice tool (`transfer_session`) or of the session itself.

### Naming one

`POST /api/sessions/rename` sets `desk_sessions.label` at once, and — when the session is running —
enqueues `rename_session`, which the owning machine delivers as `/rename <name>` typed into the
session. That is the same command Jared would type, so Claude Code renames itself, its terminal tab
changes, and it writes the `custom-title` record the reconcile tick reads back. A parked session takes
the label alone; the name reaches the session only if it is resumed.

Writing the `custom-title` record ourselves also works for anything that reads the transcript, but a
running session never re-reads its own file and would keep the old tab title — which is why it goes
through the command instead.

### Following up on one session

`POST /api/sessions/followup` (`{id, text, client_msg_id}`) hands words to one session's conversation,
which is how the watch and the phone answer the session they are showing. Running, the words are typed in — the same
`desk_commands` `follow_up` the voice tool writes for the focused session. Parked, the session is
resumed with the words as its prompt: `resume_session` takes one on both machines, and a Pi with no
memory to spare hands it to the Mac (or queues it while the Mac is asleep). An asleep machine gets the words dead-lettered, like every desk command from the
hub, and a repeated `client_msg_id` returns the first command rather than sending them twice.

**It asks about the conversation, not the row** (`conversationNow`). A resume makes a new row and leaves
the parked one parked, and `claude --resume` keeps the conversation's id — so words for a parked row
whose conversation is running again go to the running row, and a resume still opening or queued
answers 409. A second resume would put two processes on one transcript and fork it; `POST /api/sessions/resume`
goes through the same check. Every case is an exact lookup: both machines stamp a resumed row
with the resume command's id, and the Pi publishes the conversation id at launch.

`GET /api/sessions/:id` returns one session with its `last_prompt`, whole `last_reply`,
`claude_session_id` and its last ten `turns` (§ The turns before the last one), under its own
projection, for a surface showing a single session rather than the list.

### One session, open on the phone

Tapping a row of the repos pane's sessions list opens that session in place of the list
(`openSession` in `cards/repos.js`), and `‹ Sessions` goes back — so does a rightward swipe
anywhere on the view (`swipeBack`), which this pane can take because it is the leftmost and the panes
scroller has nothing to do with a drag that way. It is claimed only once the drag is clearly
horizontal, and yields to anything inside already scrolled sideways (a wide code block). Either way
out, the list is painted at once from the last payload `load()` drew (kept current by the session
stream) and refetched behind it; waiting on the fetch left the pane black for most of a second. Each
row of that list leads its last line with how long ago its last prompt or reply was (`at`, the instant
the list is ordered by). It is the watch's session page at
phone size, with more room, and a composer — typed, or spoken through the pane's dry-transcribing
recorder — whose words go to `/api/sessions/followup`. A failed send shows the hub's own `error` and
leaves the words in the box; resending the same words reuses the `client_msg_id`.

**What it shows is the conversation's one list of events, and nothing else** — the same list the watch
draws by the same rule, which is what makes the two agree. `GET /api/sessions/:id` brings the whole
list with the hub's `epoch`; `ev` frames on `/api/session-stream` bring each new event with its seq.
The rule (`frame`): the next seq is appended, a gap is fetched (`/events?since=`), an old seq is
ignored, a different epoch is a restarted hub and the list is fetched afresh; a fetch and a frame are
merged by seq (`take`), so they cannot disagree. A prompt queued behind a running turn is one event at
two moments, same id — dimmed until the model reads it, and drawn where it read it (`shown`). His own
words show the instant they are sent as a PLACEHOLDER keyed by the message's own id, which the event
for them carries back as `cmd`; it is replaced by id. The caret shows while the last event is not a
reply. The header's facts (name, machine, status) come from the row, re-read only when the `sessions`
frame says the conversation moved to a new row (a resume) or its status changed.

It follows `/api/session-stream`, opened on the first open rather than at mount because
`#repospane` is in the kiosk's markup too. Everything is keyed by `claude_session_id`, as on the
watch, and an `ev` frame names its conversation, so a follow-up that resumes a parked session carries
the view over to the new row.

A reply renders through `md()` in shared.js, the one markdown renderer every surface uses (headings,
nested lists, code, quotes, rules, tables, bare URLs), escaped first. **Every link in it is
`target=_blank`, and that is load-bearing**: followed in place, a link replaces the hub in the app's
one web view with nothing on screen to come back by. A new-window request reaches the app's
`createWebViewWith` (`StatusHubApp.swift`), which hands the address to Safari. Inside the iOS app a
tap does not depend on that path: a document click listener in shared.js catches the link and posts
its address to the native `openURL` message handler, which opens Safari directly — taps on these links
in the app opened nothing through `target=_blank` alone. An app build without that handler falls back
to `createWebViewWith`. Only `http(s)` addresses become links.

While a session is open the pane carries `sv-open`, which stops the pane scrolling and gives the card
its whole height so the composer stays put — the chat pane's layout. Re-focusing the app re-reads the
open session rather than the list.

### The last thing a session said

`desk_sessions.last_reply` is the FINAL message of a turn, with `reply_at` for when it landed and
`working` for whether a newer turn is in flight — a reply is final only when `working` is false. It is
read from the transcript rather than inferred: Claude Code writes one record per content block, each
carrying the message's `stop_reason`, and a turn ends with `end_turn`. "The last assistant text" is
not the same thing — mid-turn that is a half-written thought.

`last_prompt` is the prompt that started that turn. `readTail` pairs the two and both machines write it
wherever they write the reply, so they are replaced together. A turn of tool calls is routinely several
megabytes against the 512KB `readTail` reads, so when the reply is in that window and the turn's
opening is not, it reads backwards for it — once per turn, cached, a miss included. It is blank, never
an older prompt, when the turn was not started by something he said: a background task finishing, or
Claude Code's own injected context and compaction summaries, which are passed over.

### The turns before the last one

`desk_turns` holds each conversation's finished turns (`conversation`, `at`, `prompt`, `reply`,
`events`), and `GET /api/sessions/:id` returns the last ten as `turns`, oldest first, the newest being
the row's own last turn. The row itself is written by no application code: a trigger on `desk_sessions`
(data-layer `00105`) records a turn whenever `reply_at`, `last_reply`, `last_prompt` or the
conversation id changes, in the same transaction as the row — so a client told the row changed can
already read the turn, and the four places a turn end is written (two machines, each from its watcher
and its tick) cannot disagree. It is keyed by `claude_session_id`, which is what carries the history
across a resume or a transfer, and it bounds itself: 20 turns a conversation, 30 days.

A turn carries what the row carried, so a reply is the same 20000 characters the machines cut
`last_reply` to. Every hop (pi-desk, the orchestrator, this server) has to agree on that number:
any one of them lower cuts a long reply off mid-word with nothing on screen saying it was cut.

`events` is the one column the hub writes (`storeTurn`, through the `desk_turn_events` function of
data-layer `00118`, one write a turn): the turn in the order it happened, every prompt where the
session took it, each tool call and what it said between them. It comes from the host's `done` frame,
which carries the turn as the transcript has it. The function inserts or updates `events` alone, so it
and the trigger can land in either order without one overwriting the other. Null on a turn recorded
before `00118`, which seeds as its prompt then its reply.

### The conversation as one list — the event log

**Everything a surface shows of a session is one ordered list of events** (`sessionLog` in server.js):
`prompt`, `tool`, `text` and `reply`, each with `seq` (its position, given here on arrival) and `id`.
A host's activity frame becomes one event (`logFrame`): `queued` and `said` are one prompt at two
moments with the id the host minted for it, the second marked `seen`; `done` becomes the `reply`,
with the whole text the host sends. A prompt this machine
typed for a hub command carries that command's id (`cmd`) — the sender's own `client_msg_id`, passed
to the host as `msg` in the follow-up payload — which is how the device that sent the words replaces
its own placeholder by id. A follow-up to a PARKED session is a `resume_session` carrying the same
`msg`, and the host registers it for the resumed session's first prompt (docs/WATCH.md § placeholders).

Kept in memory per conversation, 2000 events, dropped after a day untouched, and seeded on first
touch from `desk_turns` (each finished turn's `events`, then its reply) so a cold open or a restart
has the history in order.

**The turn in flight survives a restart because the host can say it again.** Every deploy empties this
list, and the running turn is in no table. A host numbers a turn's events (`turn`, the uuid of the
transcript record that opened it, and `n`, the position in it) and keeps the turn's whole list. The hub
tracks how far into that turn its list is (`log.cur`): an event that is not the next one is NOT
appended, the answer to it is `{ replay, have }`, and the host sends everything after `have` (state
`replay`) before its next frame; an event already held is ignored. `done` carries the whole turn, which
fills a list that heard none of it. A host that restarts mid-turn reads the turn's beginning back from
the transcript (`loadPrefix` in sessionWatch.js), so its numbering carries on. The trap this closes: a
prompt lost to a restart was re-added from `done` at the END of its turn, under the tool calls it had
started. `EPOCH` names this process and
rides in every frame and list: seq starts over on a restart, and a client holding an older epoch
fetches the list afresh rather than merging two numberings.

This replaces what the same facts used to travel as: the live frames on one road and the row plus
`desk_turns` on another, unordered against each other and with no identity linking a queued prompt
to its read, a `done` to the turn it ended, or a device's own words to their echo — which every
client then reconstructed from text and timing, each by its own rules. What remains of that is the
two seeds above and the `cmd` stamp, and nothing on a client compares text.

### Every finished reply is a notification

Each session's final reply of a turn — never the tool calls — is pushed to the phone, and from there
the watch, by `notifySessionReply`: both machines already report every turn end to
`/api/session-activity` (`sessionWatch.js` `reportTurnEnd` — the watcher the moment a turn ends, the
reconcile tick for one `fs.watch` dropped), so it is sent from there, for every session on either
machine, the one being typed in included. Kind `session`, `active` so it lights the watch; title the
session's name, body the reply. It is keyed `session-reply:<id>:<reply_at>` — the watcher sends the
turn's `at` — so one turn buzzes once even when its end is noticed twice, and `push_enabled` gates it. `relay.js` posts a hub dispatch's first reply into the hub thread but
sends no push of its own: this one covers it.

An orchestrator reply is pushed only when the model flagged it as worth reading
(`voice_messages.needs_read`, voice-pipeline `docs/ROUTING.md`): `notifyAnswer`, on the realtime
INSERT of that assistant row, kind `answer`, category `VOICE_ANSWER`, titled with the question it
answers and keyed `voice-answer:<id>`. The payload's `voice_message_id` is what a tap or a dismissal
marks read through `POST /api/voice-messages/read`, which stamps `read_at` once; the row's realtime
UPDATE carries it to every surface. What the watch does with it is `WATCH.md` § Unread answers.

The payload's `session_id` is what a tap opens: `SessionLaunch` → `window.__showSession` opens that
session on the repos pane (§ One session, open on the phone), or lands on the list when the row is
gone. It is a web-side function, so what a tap does changes with a deploy, not an app build. The `SESSION_REPLY`
category gives the watch an Open button (`WATCH.md`).

Both machines publish it through one shared module (`voice-pipeline/orchestrator/src/transcripts.js`),
which also finds the transcript a launch just created. Its `readTail` stats the path first and reads
only regular files: a row written before the tty had its own column carries a device path, and
`readFileSync` on a tty blocks the process for ever waiting for terminal input.

**`/api/sessions` does not ship every column, and `last_reply` mostly is not one of them.** The
response is an explicit projection — `id`, `n`, `label`, `custom_title`, `repo`, `worker`, `status`,
`working`, `claude_session_id` — plus `say`, a 120-character one-liner, which is all the repos pane
renders per row. The whole `last_reply` goes only to rows something can show in full: everything
resident, and the newest parked one, which is what the home wall falls back to when nothing is
running. **Adding a field to a session view means adding it to that projection**, or it arrives
`undefined`. Ninety-odd parked sessions carrying their full replies and five unread timestamps each
made this a 242KB response; it is 39KB.

### A prompt can carry three things that were never meant for him to read

`server.js`'s `cleanSaid`, applied to `last_prompt`, `say`, every turn's `prompt` and every activity
frame before any of them reach a client — the watch, the phone thread, the TV — strips three patterns,
all confirmed live in `desk_turns`, not theoretical:

- **The bracketed location line voice-dispatched prompts used to carry**, `\n\n[Where Jared was when he
  asked: lat, lon (within about N m)]`. Nothing appends it now — a session that needs his position calls
  the data MCP's `get_location` — but it is in turns already stored.
- **A format instruction older watch builds appended while replies were spoken**, `\n\n[This reply is
  read aloud. …]`. Nothing sends it now, but it is in turns already stored. Either this or the location
  line can come last, so `cleanSaid` peels both off the end until neither matches.
- **Speak mode's note**, ` <speak-mode>…</speak-mode>` (`SPEAK_NOTE`), which the hub appends to a watch
  follow-up sent in speak mode (`docs/WATCH.md` § Speak mode). `resolvePrompt` strips it before the
  prompt is stored or matched; `cleanSaid` carries the pattern as a backstop.
- **The stub a long message was once typed as, instead of itself**, naming the file the real words
  were parked in. Nothing types one now (a long message is simply pasted), but turns
  already stored hold it. Meant
  to be resolved back to those words before anything is stored (`transcripts.js`'s `resolvePrompt`,
  called from `turnStart` and from `sessionWatch`'s `queue-operation` handling) — `cleanSaid` is a
  backstop for the rare case that resolution did not happen (the stash file was swept, or the read
  raced it): found, at the time this was written, sitting unresolved in `desk_turns` from more than
  one session, shown as if he had typed an instruction to go read a file.

`cleanSaid` runs at FOUR points: every `/api/session-activity` frame (so a live `said`/`queued` line is
clean before it is kept or pushed), the list's `say`, a session's `last_prompt` and each of its
`turns[].prompt` (`/api/sessions/:id`), and `full()`'s `last_reply` (cleaned for consistency with `say`, though neither pattern is expected to
ever match a reply rather than a prompt). **A fourth source of exactly this failure mode — text that
looks like his words but is not — is `fromHim` in `transcripts.js`**: a message queued mid-turn is
checked against ONE wrapper tag, `<task-notification>`; a second one, `<agent-message` (a subagent's own
hand-back report to the turn that spawned it), was not excluded, and its own opening line — stating
plainly it is not from him — displayed on the wrist as if it were his prompt. Both tags are excluded
now (`NOT_HIM`); if a THIRD synthetic wrapper is ever added to the harness, it needs listing there too,
not discovered by watching it appear on his screen.

### Naming a session

Every name a session already has is derived from its checkout — the tmux id (`hub-status-hub-mta8y3ik`),
the Remote Control name (`status-hub-mta8y3ik`) and Claude Code's own derived name (`status-hub-9c`)
are all repo plus a timestamp suffix. None describes the work, so several jobs in one repo are
indistinguishable in any list.

`start_session` therefore takes a `label` — three to six words naming the WORK — written by the router
at dispatch, the only moment the request exists as language. `desk_sessions.label` and
`desk_queue.label` carry it (a queued job can wait a long time and must not lose its name). The panel
and the TV strip show the label and fall back to the repo.

One trap: `pi-desk`'s reconcile tick upserts with `resolution=merge-duplicates`, so any column it
sends overwrites — omitting `label` there would blank it on the next tick, which is why it is carried
through explicitly rather than left out.

### Which session holds follow-ups

The TV strip shows it as a small outlined box carrying the **repo name**, inline with the liveness
chips so it uses the strip's empty middle without changing the row height — the cards either side fix
that height. It renders only when a session is actually holding follow-ups; an empty box or the word
"none" is noise on a wall you glance at. The phone panel is where the fuller form lives.

`/api/sessions` returns `focus` — the session a SPOKEN follow-up would land in — and the panel marks
that row; the TV strip and the home wall show the same session. `pickFocus` in `server.js` decides it
by the same rule as `focusedSession` in data-layer, and the two must agree: a session Jared focused by
name while it runs, else nobody while a dispatch is still opening, else the most recently active running
session. The rule, and why it includes the session he is typing in, is SESSIONS.md § Focus.

It is worth showing because it moves: the session you last used holds follow-ups unless you pinned
one, so glancing at the strip answers where "tell it to…" will go. `pinned` (in `/api/sessions`, and
on the status payload's `desk_focus`) says which of the two it is, and every surface that shows focus
puts `PIN_SVG` from `shared.js` on a pinned session — a pin stays put, so it must not look automatic.

`focus` is null only while a dispatch is opening or when nothing is running. The panel says so
outright rather than leaving no row marked, which is indistinguishable from the marker failing to
render.

That depends on both machines reporting honestly, which is why each reconciles its own sessions every
30s — by the process a row belongs to (`pid`), since a tab outlives the process inside it. Keyed by
tab, a row closed the day before was kept running by the next session opened in its tab.

### The TV sidebar (`/tv-sidebar`)

One conversation down the strip: the focused session, or the voice orchestrator's conversation.
Which is the `tv_sidebar_view` setting (`session` | `orchestrator`, default session), written by
`tvPush` when a `sidebar` command carries `view` and delivered as `sidebar_view` on the sessions frame
the page already holds, so switching needs no new build of the TV app. That frame also carries `commit`,
and the page reloads when it changes, since it holds no status frame to learn of a deploy from.

Its size is two more settings a `sidebar` command can carry, each held until changed and delivered
on the same frame: `font_size` → `tv_sidebar_font` (the page's base size in px, default 17; every
other size in it is in `em`, so this scales the whole strip), and `width` → `tv_sidebar_width` (the
panel's MINIMUM, a fraction of the screen, default 0.35).

The width is never allowed to cut a response off, because nothing on the TV scrolls. `tvPush` sends
the app width 1 on every `sidebar` command, so its window spans the screen and is see-through
outside the panel, and the page draws the panel itself (`fit`): at the minimum when the latest reply
(or, mid-turn, the latest thing said) sits wholly below the top fade, otherwise just wide enough that
it does, found by bisection after every paint; the next shorter one brings it back. A reply that does
not fit even at full width leaves the panel full width. `bin/tv sidebar on <w>` talks to the app
directly, so its window is that width and the panel fills it.

The orchestrator view is the current context of the hub thread, fetched from
`/api/voice-messages?focus=hub&mode=active` (the watch's view) and refetched whenever `/api/voice-stream`
carries a `message` or `reset` frame, so which rows belong to the current context stays the server's
rule. After an idle gap or a reset it is empty under its header until he speaks again. A reply relayed
from a session (a row with `session_id`) is drawn in the teal (`#9fe3d3`) the phone and watch give it.

His words appear the moment the request exists, not when the conversation row does: the worker writes
his `voice_messages` row only beside the answer, up to half a minute later. Every `voice_requests`
insert or update for the hub conversation goes out on `/api/voice-stream` as a `request` frame
(`requestView`: id, transcript, status), and `/api/voice-pending` lists the unfinished ones for a
(re)load. The page draws them after the conversation until a row with that `request_id` arrives, and
drops one when its request is `done` or `error`, since a failed request may never get a row.

Neither view lists tool calls. While a turn is running the page draws only the call in progress above
the caret, each new one replacing the last (the session's latest `tool` event since its prompt; the
orchestrator's latest `activity` frame in state `tool`, cleared by `working`, `done` or `error`). Every
other surface lists them all; this is the TV's alone. The line is `toolParts`: the tool's name and the call's
`description`, with its arguments under it (a lone argument as its bare value), wrapped and clamped to
three lines. The arguments must be allowed to break anywhere (`.sb-args`, `word-break: break-all`):
the event text is one unbroken run of up to 400 characters, and the TV's WebView lays such a run out
without painting it, so unwrapped it shows as an empty gap.

The session view is the FOCUSED session (`pickFocus`), drawn narrow and see-through for the bedroom TV, whose companion
app overlays it on whatever is playing (google-tv repo, `SidebarService`). Its own small module
(`pages/tv-sidebar.js`) rather than `cards/repos.js`, which carries a composer, a recorder and a list
the TV has no use for. It reads `/api/sessions` for the focus, `/api/sessions/:id` for the
conversation, and `/api/session-stream` for every frame after: a `sessions` frame moves it to a new
focus, an `ev` frame for its conversation is appended, and a seq gap or new epoch refetches. The box
is anchored to its bottom with nothing scrolling, so the newest thing is always on screen. The page
background is transparent and the panel is `rgba(0,0,0,.55)`: the video shows through.

## 6c. Reports — a session's HTML write-up

A session dispatched from the phone or by voice answers in its transcript as usual; that is what
Remote Control shows and none of this touches it. A **report** is a second, richer output: the model
writes a self-contained HTML page, it lands as a push notification, and tapping it opens the page.

| piece | where |
|---|---|
| `publish_report(title, summary, html)` | data-layer MCP (`src/reports.ts`) — writes a `reports` row |
| the instruction to publish | `REPORT_DIRECTIVE`, appended to the prompt by `pi-desk` and the Mac orchestrator |
| the notification | `reportTick()` here — fired by realtime the moment a `reports` row is INSERTed, with a 10-minute backstop behind it |
| the page | `GET /report/:id`; every report at `GET /reports` |
| the way in | the **Reports pane** — the phone's last swipe pane, right of home |
| the pane's data | `GET /api/reports` (list only; `html` is never selected) → `cards/reports.js` |

**Why the directive lives in the prompt and not in `CLAUDE.md`:** it should apply to dispatched work
only. A session opened by hand at the keyboard has no business filing reports at you. Making it
optional later is a flag on the command rather than an edit to a file both machines share.

**Why `reports.notified` is a column and not an in-memory set:** the hub restarts on every deploy. An
in-memory ledger would either re-announce every past report or lose whatever was mid-flight. The flag
is also set when the push *fails* — `pushAll` has already logged that to `notifications`, and leaving
it false would re-buzz the phone every 20 seconds once APNs recovered.

### Where you read them

Reports get their own pane rather than a link inside another card. They sit next to the repo
launcher because it is one loop seen from both ends — that pane sends work out, this one is what
came back — and because a report is something you go looking for days later, which needs a
destination, not a link buried in a header.

The pane lists reports and opens one in a **sandboxed iframe filling the card**. Same document and
the same CSP either way (the `sandbox` directive gives an opaque origin whether the response is a
frame or a top-level page), so nothing is given up — but getting back to the list is a button
instead of a full reload of the hub and its event stream.

A notification tap lands in the same place. `ReportLaunch` polls for `window.__showReport` and hands
the id to the pane, so tapping a push puts you inside the app beside every other report rather than
on a lone document. If the bridge never appears — an older hub, no pane machinery — it navigates to
`/report/:id` outright; that fallback is why the web view enables back/forward gestures.

`statushub://pane/reports` also works with no extra wiring, since `__showPane` resolves panes by
class name.
### It is read on a phone

The tool description states the target explicitly — portrait, ~390px of usable width — because a
model given no dimensions writes for a desktop column and the result arrives as slivers. Tables are
capped at 2-3 short columns, SVG must carry a `viewBox` and `width="100%"`, and nothing gets a fixed
pixel width.

The stylesheet has to cooperate: a `display:block` table with `width:100%` squeezes its columns to
fit rather than overflowing, which is what produced the unreadable first one. `width:auto` with
`min-width:100%` lets it fill a narrow screen *and* grow past it, and a `min-width` on cells makes it
scroll rather than shrink to a word per line.

### The CSP is load-bearing

The HTML was written by a model and is opened inside the app's WKWebView, which is already
authenticated to this hub. Served plainly, script in that document would be same-origin with the
dashboard and could call `/api/*` — clearing todos, opening sessions — with Jared's own cookie.

So `/report/:id` sends a CSP that both sandboxes the response into an opaque origin **and** blocks
scripts outright via `default-src 'none'`. Two independent mechanisms, because this is the only place
in the system where untrusted markup meets an authenticated origin.

The visible consequence: **charts must be inline `<svg>`** — no chart library, no CDN `<link>`, no
`<script>`. Inline `<style>` and style attributes do work, and images work as `data:` or `https:`
URLs. The `publish_report` tool description states this, so the model does not discover it by having
a chart silently fail to render.

## 6d. Deploying, and confirming it shipped

**`server/deploy.sh`, from whichever machine changed the code.** Both machines have `flyctl`
authenticated, and both pull every 15 minutes, so neither ships a stale tree. `.github/workflows/`
covers iOS only, where a macOS runner is genuinely required — nothing there deploys the server, so a
push on its own ships nothing.

The script deploys and then verifies, because those are different things. `GET /healthz` returns
`ok <commit>` — the 7-char SHA stamped in by `flyctl deploy --env COMMIT=…`. It is public, so
checking costs nothing:

```
curl -s https://jared-status-hub.fly.dev/healthz     # -> ok 64ac2ca
git rev-parse --short origin/main                    # must match for server/ changes
```

`COMMIT` is stamped in at deploy time, so a deploy that did not happen is visible rather than
indistinguishable from one that did. `deploy.sh` polls `/healthz` after shipping and exits non-zero
if the running commit never becomes the one it built.

`pull-repos` also logs `DEPLOY DRIFT` when the two disagree, as a passive backstop.

## 6e. The wall's footer row, and why the machine never sleeps

the wall's third grid row — a real row in `body.tv .rows`, not an overlay, so the cards above shrink
to fit it. Adding it meant pinning the health bar's `grid-row` from `1/-1` to `1/3`, or it would have
swallowed the new row.

Left is the activity lane (`#tv-act`, §3). Right is `cards/deskfoot.js`: the repo name of whichever
session a spoken follow-up would land in, rendered only when there is one. The frame is permanent so
an empty lane reads as reserved space rather than as a gap.

**The Mac app loads this same markup** — and so does a wall opened at phone size — so `#tv-act`
exists there too, but the lane is
inside `.tv-shell`, which `wall.js` transform-scales to fit the screen, and a transformed ancestor
scales its descendants' text *and* becomes the containing block for their `position:fixed`. Mounting
the activity element into the lane wherever `#tv-act` existed rendered the phone's popup at about a
third of its size, pinned inside the shell. So `voiceagent.js` mounts into the lane only on the kiosk
(`body.tv`, not `body.mac`, ≥1400px — the predicate `wall.js` uses, since `body.phonewall` is not set
yet when the bar is created) and onto `<body>` everywhere else, and the row is simply `display:none`
off the kiosk.

### The Fly machine does not auto-stop

`server/fly.toml` sets `auto_stop_machines = false` and `min_machines_running = 1`. Leave it that way.

`fly launch`'s defaults suspend an app when traffic goes quiet, and this one has a wall display
depending on it around the clock. Suspending put a cold start in front of every phone visit and made
the hub briefly unreachable on each wake, which the Pi's reachability watchdog is built to react to.

That watchdog (`~/scripts/hub-reach-watch.sh`, started by `.xinitrc`) kills Chromium once the hub has
been unreachable and comes back, because Chromium otherwise sits on its own error page and the
relaunch loop never fires. It requires **three consecutive failed checks**, not one: a single failed
5s curl on a Wi-Fi machine is a blip, and reloading for it blinked the wall every few minutes with
nothing in any log to explain it. Both edges are logged under `kiosk-xinit`, so an unexplained reload
is traceable rather than guessed at.

### Three layers recover a frozen wall, and they are deliberately ordered

A wall showing an old frame is the hardest kiosk fault to notice, because it looks identical to a
working one — the cards hold their last frame and the rest/session clocks keep counting off local
intervals. So recovery is staged, each layer covering the previous one's failure:

| Layer | Fires at | Covers |
|---|---|---|
| `liveStream()` in `shared.js` (§1) | rebuild at 75s of silence, self-reload at 150s | a half-open socket — the common case |
| `kiosk-health.py` `'stale'` verdict (Pi) | 300s of silence, 3 consecutive checks | the page's own watchdog being what broke |
| `hub-reach-watch.sh` (Pi) | 3 failed reachability checks; on the down→up edge, reloads only if CDP no longer lists a tab on the hub URL | Chromium left on its own error page by a navigation that failed while the hub was gone |

The middle layer reads `window.__hubStreamAge()` over CDP — it is the only signal that separates "JS
is running fine" from "JS is running fine over data that stopped." It is gated on the hub answering,
because a stale wall during an outage is the truth, and killing Chromium then drops the `.xinitrc`
loop onto its reachability gate and leaves a black screen instead of a stale one. That case belongs
to the third layer, which is why the second one declines it.

The third layer does NOT reload a page that is still loaded. That page rides out the outage and
rebuilds its own stream when the hub answers; killing it anyway blanked the wall on every Wi-Fi blip,
every few minutes on a bad day.

## 6f. Incidents go to the ops responder

The hub starts no investigations of its own. Its errors, the page errors it relays from
`/api/clientlog`, and its heartbeat go to the ops responder (health/responder/README.md), which watches
every machine and service and starts the agent. That covers the machines' silence the hub used to read
from `worker_presence`, without depending on Supabase.

## 7. `app_settings` catalog (flat key/value)

`GET /api/settings` returns this map **minus `voiceprint`** — 24KB of base64 exemplar bank that no
client here reads, and 92% of the response before it came out. The voice pipeline reads that key from
`app_settings` directly with the service key. `settingsAll()` still hands everything to server-side
callers; only the HTTP response is filtered.

| Key | Controls |
|---|---|
| `surplus_cal` | Signed kcal over maintenance (+bulk / −cut / 0 maintenance). |
| `maintenance_min_days` | Aligned-window length before adaptive maintenance goes live (Settings "calibration window"). |
| `maintenance_phase` | JSON `{start, seed, sign, hold}` — the current goal phase (§4). Written on a `surplus_cal` sign flip. |
| `session_reset_s` | Idle gap that starts a new stretch of the hub thread as the surfaces show it, and bounds which worker owns the conversation. The agent itself is not bounded by it: it is replayed the whole day since 4 AM (voice-pipeline `recent_context`). |
| `voice_reset_at` | When the hub conversation was last reset by hand — a context boundary, like an idle gap. Written by `/api/voice-reset`. |
| `activity_hold_s` | Seconds a finished activity row (the reply, or an error) holds on the bar. Default 60. |
| `phone_activity_hold_s` | The same, off the kiosk (phone, Mac app panel). Default 8. |
| `wakefree_enabled` | Always-on (wake-free) voice on/off. |
| `voice_inject_mode` | Mac-mic speech injected into the focused window (ESP off). |
| `voice_muted` | Global mute — silences Mac mic + ESP while any command is being captured. Derived: the hub recomputes it from the `voice_mute_<holder>` keys (each the instant that holder took it, empty when given back, ignored after 15 min), which every capture path sets through `POST /api/voice-mute` `{holder, on}` (the Mac's listener writes its own key directly). |
| `voice_speak_replies` | Read the reply aloud. |
| `voiceid_threshold` / `voiceprint` | Wake-free speaker-ID — the "it's Jared" bar and the exemplar bank. |
| `wakefree_pause_s` | ESP only, and only until its voiceprint loads. Wake-free endpoints on Jared's verified presence, with a pause tolerance that scales with utterance length — neither mic consults this. |
| `phone_silence_s` / `watch_silence_s` / `mac_silence_s` / `esp_silence_s` | Trailing-silence cutoff, per capture source. All default to 3 when unset. |
| `watch_speech_mode` / `watch_speech_min` / `watch_speech_ratio` / `watch_voice_min` | What the watch counts as speech. `fixed` (default): 2.5x the room's floor and at least `watch_speech_min` (0.02 unset), which in a quiet room is the whole line. `room`: `watch_speech_ratio` (8 unset) times the floor, no fixed number. `voice`: Apple's on-device sound classifier, a window scored `speech` at least `watch_voice_min` (0.5 unset); no level line. Settings → Watch: speech line. |
| `watch_quick_s` | The watch's Hub Quick complication: seconds from the microphone opening after which the command sends whatever it has (5 unset). Settings → Watch: quick command. |
| `rewind_diarize` | `1` gives a rewind grab speaker labels (OpenAI `gpt-4o-transcribe-diarize`); anything else is plain Groq Whisper (`docs/REWIND.md`). No Settings control. |
| `cg_orders_model_first` / `_second` | The model id each pass of the restaurant app's order list uses (`claude-sonnet-5` unset), returned by `GET /api/cg/orders` (§5). No Settings control. |
| `watch_rewind_s` | Seconds the watch's rewind keeps (30 unset, 600 at most), read when it is engaged (`docs/REWIND.md`). No Settings control: write `app_settings` directly. |
| `agent_mode` / `agent_cwd` | Full-agent (coding) mode toggle + working dir for the worker. |
| `weight_reminder_enabled` / `_mode` / `_time` | The daily weigh-in push (On/Off, Manual/Dynamic, time). |
| `push_enabled` | Gates session-reply pushes and flagged-answer pushes (`notifyAnswer`). No other orchestrator reply is pushed, whatever it says. |
| `jaredbot_enabled` | JaredBot, the group-chat auto-replier in messages-mcp (`jaredbot.py`), which reads it before every decision. Also voice `set_jaredbot`. |

---

## 8. Push notifications (native iOS, APNs)

- **App** (`apps/Sources/Push.swift`): requests permission, registers, uploads the APNs token via a
  same-origin fetch inside the authed WebView; reports `environment` (Debug→sandbox, Release→production).
- **Server:** `POST /api/register-push` upserts `device_tokens`; `lib/apns.js` sends (HTTP/2 + `.p8`
  JWT, per-token gateway); `pushAll()` fans out to every iOS token and logs to `notifications`.
- **Firing use cases:** the daily weigh-in reminder (`lib/weightReminder.js`, skips if weight/food
  already logged) and due reminders (§6). Keys live in Fly secrets on `jared-status-hub`.

---

## 9. Native app (`apps/`)

XcodeGen (`project.yml`) → five targets: **`StatusHub`** (iOS 17+), **`StatusHubMac`** (macOS 13+,
shares `Sources/` + `Shared/Auth.swift` only), **`StatusHubControls`** (iOS 18+
widgetkit-extension, embedded by the iOS app — §9b), and **`StatusHubWatch`** with its complication
extension **`StatusHubWatchWidgets`** (watchOS 11+, embedded by the iOS app — `WATCH.md`). More than a thin
wrapper now:

- **`HubWebView`** (StatusHubApp.swift): WKWebView over `Auth.host`, seeds the `hub` cookie from the
  Keychain password; grants webview media capture; bridges JS dialogs to native alerts.
- **Voice entry points** (all land straight in "listening"): `statushub://record` URL scheme →
  `onOpenURL` → `RecordLaunch` fires the web voice FAB (`window.__startVoiceCommand`); `HubVoiceIntent`
  (Shared/, `openAppWhenRun`) drives it from a **Siri/Spotlight App Shortcut** (RecordIntent.swift) and
  the **Lock Screen / Control Center control** (Controls/RecordControl.swift). `HUB_APP` compile flag
  guards the app-only `RecordLaunch` call so the extension links without WebKit.
- **Page → native bridge** (`userContentController`): the page posts `badge` (icon badge count, set
  the instant a reminder is cleared *inside* the web view — a background push can't be relied on) and
  `reloadWidgets` (§9b).
- **Auth sharing** (`Shared/Auth.swift`): the hub password lives in the Keychain; `token()` derives
  the same `sha256("status-hub:"+password)` the web cookie uses and sends it as `X-Hub-Token`. The
  access group is written out explicitly (`XMH4AVFC78.com.jaredgantt.statushub`, declared in **both**
  targets' entitlements) because the extension has a different bundle id and so a different *default*
  keychain group — it is deliberately equal to the app's own implicit group, so the password stored
  before the extension existed still resolves and nothing has to be re-entered.
- **Build/install:** TestFlight, archived on the Mac with `apps/tools/testflight.sh` (CLAUDE.md, "A build
  signed for development cannot receive push").

---

## 9b. `StatusHubControls` — the Record control + the widgets

One iOS-18 widgetkit-extension (`apps/Controls/`, bundle `com.jaredgantt.statushub.controls`,
embedded by the app) hosts **all of them** — the Record control, the Macro Rings widget, the Due
widget and the Projects widget — in a single `WidgetBundle` (bottom of `RecordControl.swift`).
That is the intended shape — a bundle is meant to carry several widgets and controls.

**Record control** (`RecordControl.swift`) — a Lock Screen / Control Center button. It runs
`HubVoiceIntent`, so it needs none of the app's code: `openAppWhenRun` opens the app and `perform()`
executes *in the app process*, where `HUB_APP` is defined and `RecordLaunch` fires the web voice FAB.

**Macro Rings widget** (`RingsWidget.swift` = WidgetKit plumbing, `RingsView.swift` = drawing) —
today's Cal/P/C/F **pace** rings, drawn to match the hub's nutrition card. Not absolute progress: a
ring is full when on pace, drains as the clock runs ahead of what's been eaten, and grows an overflow
arc once ahead; the white tick is where the arc would end if you were exactly on pace, and a cyan one
is where it would end with a staged meal eaten. Families:

| Family | Layout |
|---|---|
| `systemSmall` | 2×2 grid of rings (a row of four would leave a square widget two-thirds empty) |
| `systemMedium` | health bar on top, then a row of four rings with `consumed / goal` under each |
| `accessoryCircular` | calories only |
| `accessoryRectangular` | four compact rings in a row |

Tapping opens `statushub://open` — any host but `record` just opens the app.

- **The server does the maths.** Every drawn value comes precomputed from `GET /api/rings`: arc
  lengths (`ring_base`/`ring_over`), colours, the signed deviation number, the marker positions
  (`frac` and `staged_mark`), and the health-bar fills. `lib/pace.js` and `cards/score.js` stay the only implementations
  — the Swift never re-derives them, so the widget can't quietly drift from the wall. The health-bar
  values arrive **already halved** (each side fills at most 50%) so the weighting isn't re-derived
  either.
- **Frames, not a clock.** A widget renders a static snapshot; it cannot tick. So `/api/rings` returns
  **61 per-minute frames** (`STEP_MIN = 1`, `SPAN_MIN = 60`, ≈37KB) and `getTimeline` maps frame `t`
  to an entry dated `now + t` minutes. WidgetKit pre-renders the whole timeline and swaps entries at
  their dates, so the arcs drain and the marker advances for an hour on **one** fetch — 61 frames cost
  one refresh, not 61. Per-minute is deliberate: the pace line moves ~3 cal/min, so a 10-minute step
  left the centre number up to ~31 cal behind and read as stuck (`b39c498`). Span is the other half of
  the trade — longer means less network, but `consumed` stays frozen at fetch time for that whole
  window, so an hour bounds how stale it can get on its own (`79a6941`, down from 4h).
- **Freshness.** A placed widget holds a *cached* timeline, so two things force a rebuild early:
  `applicationDidBecomeActive` (Push.swift — also covers "new widget code after a reinstall doesn't
  render until the old policy date rolls round") and the page itself — `core.js` `nudgeWidgets()`
  watches the SSE stream and posts `reloadWidgets` to the native shell when the four macro totals
  actually change, throttled to once a minute.
- **Never blank.** The last good payload is written to `rings-last.json` in the extension's caches
  directory and served whenever a fetch fails — no token yet, offline, or a background refresh that
  outlives its window. Slightly stale beats an empty widget (`378191a`).
- **Lock Screen caveat.** iOS renders the accessory families in a flattened tint, so the pace
  *colours* don't survive there — arc lengths and the tick do.

**Render harness** (`apps/tools/render-rings.swift`) — `RingsView.swift` is deliberately
WidgetKit-free so it compiles standalone on macOS. The harness draws the **same** views at real
device point sizes to PNGs, so ring geometry can be iterated without a
rebuild → reinstall → squint-at-the-phone loop:

```sh
cd apps
swiftc -O tools/render-rings.swift Controls/RingsView.swift -o /tmp/render && /tmp/render /tmp
# writes /tmp/{small,medium,rectangular}.png from a real /api/rings response baked into the tool
```

**Due widget** (`TodoWidget.swift` = WidgetKit plumbing, `TodoView.swift` = drawing + button
intents) — **everything with a due date, from every list**, ordered by when it was first scheduled.
Not one list at a time: "what needs dealing with" is never confined to a single list, which is why
`/api/due-widget` replaced the per-list feed. Home Screen families only (`systemSmall` 6 rows /
`systemMedium` 5 / `systemLarge` 10 — measured with the render harness, not guessed; the accessory
families are too small for a list).

- **Titles, not bodies.** Items carry a real `title` column (migration `00056`) and the feed prefers
  it; when it is absent the hub derives one — cutting at the first em dash or line break, capped at
  90 chars. Either way the hub decides what a row says, not the Swift. Rows are one line each, which
  is what makes the row counts above exact.
- **Expiry comes from the anchor.** The feed flags an item `expired` from `scheduled_at`, which now
  always equals `due` — nothing advances a due date any more. `repeating` says the item is one of a
  materialised series, not that it will come back.
- **Decode-optional flags.** `expired` and `repeating` are optional rather than defaulted: a
  defaulted `var` still makes the key required in the synthesised `init(from:)`, so a `due-last.json`
  written by an older build would fail to decode and turn the offline fallback into a blank widget —
  the one thing that cache exists to prevent.
- **Two taps.** A widget has *no gestures* — no swipe, no long press, only `Button`/`Toggle` taps. So
  tapping a row opens its two options in place: **open it in the app** (`OpenTodoItem`, which runs in
  the app process via `openAppWhenRun` and lands on the item) or **clear it** via the same
  `/api/todos/clear` every other surface uses. No single stray tap clears anything, which is the
  property the web pane's left-swipe was chosen for. `TapTodoItem` is one *toggling* intent because
  `Button(intent:)` takes a single concrete type and a ternary over two intent types doesn't compile.
- **The clear must be awaited.** A widget extension can be suspended the moment `perform()` returns,
  and without an App Group there is no background `URLSession` to outlive it. Awaiting silently made
  the tap feel dead, so `ClearTodoItem` paints a "clearing…" state first, then awaits, then removes
  the row from the cache so the rebuild redraws it gone with no second round-trip.
- **Arm state needs no App Group.** A widget's button intent runs in the *extension's own process* —
  the same one the timeline provider runs in — so `UserDefaults.standard` is shared ground between
  them (`ArmStore`). An App Group would mean a new entitlement and a regenerated provisioning
  profile, i.e. blocked. The arm expires after 20s, and the provider emits a second entry at that
  expiry so revealed options close themselves.
- **No frames.** Unlike the rings, this data doesn't move with the clock, so it's one snapshot per
  fetch. Freshness comes from reloads: WidgetKit rebuilds the timeline the moment a button is tapped,
  `applicationDidBecomeActive` covers foregrounding, and `cards/todo.js` posts `reloadWidgets` after
  any edit in the pane (unthrottled — unlike `core.js`'s macro nudge it only fires on a real tap).
  The 1-hour policy is just the backstop for a change made elsewhere (voice, the Mac).
- **Never blank.** Same cache fallback as the rings (`due-last.json`). "Can't reach the hub" and
  "All clear" are drawn as distinct states — only one of them means you're done.

Its harness is `tools/render-todo.swift` (same idea, `+ Shared/Auth.swift` for the intents' network
call, `Controls/RingsView.swift` for the shared palette):

```sh
cd apps
swiftc -O tools/render-todo.swift Controls/TodoView.swift Controls/RingsView.swift \
       Shared/Auth.swift Shared/OpenTodoItem.swift -o /tmp/render-todo && /tmp/render-todo /tmp
```

**Projects widget** (`ReposWidget.swift` = WidgetKit plumbing, `ReposView.swift` = drawing +
intents) — the Mac's projects from `/api/repos-widget`, most recently touched first, mirroring the
repos pane (§6b): a branch chip only when the branch is worth knowing, a dot when the checkout is
dirty, and the whole list greyed when desk presence is stale. Home Screen families only.

- **A tap does not launch a session.** Opening a bare session leaves you typing the actual request
  into a fresh prompt afterwards, so a tap dictates the session's **first message** instead. A widget
  extension has no microphone, so it hands the choice to the app (`statushub://repo/<path>`) and the
  recording happens on the repos pane: it starts on arrival, and tapping the row sends it.
- **Two taps, and the confirm matters more here.** Tap a row to select, tap ▶ to hand over. This one
  starts a process on a real machine; a stray tap that opens a terminal is worse than one that opens
  options. Same extension-local `UserDefaults` arm store, same 20s expiry with a second timeline
  entry so the confirm retracts itself.
- **A rebuild is not always a fetch.** Selecting a row is local state; making it wait on an HTTPS
  round-trip is what made the first interactive widget feel broken. A cached payload under 60s old
  (or any armed state) backs the redraw. The refresh policy is 30 minutes — the list is the Mac's own
  scan and only moves when work happens.

Harness: `tools/render-repos.swift`.

## 9d. `StatusHubShare` — the share sheet

`apps/Share/ShareViewController.swift`: "Status Hub" in the iPhone share sheet for images (up to 12 —
in practice a screenshot). The stock compose sheet shows the picture and a text field; Post uploads each
image to `/api/attach` (downscaled to 1568px JPEG through ImageIO) and sends one `/api/voice-text` with
the object names and `shared: true`. It lands in the hub conversation like a typed message, and the reply
comes back there.

`shared: true` matters: the server stamps the request source `share`, and the worker gives share
requests their own framing (`SHARE_DIRECTIVE` in voice-pipeline `worker.py`). Without it, a picture is
framed as ONE MEAL TO LOG, which is what the chat composer's camera is for.

The upload runs inside the extension before it completes, not in a background session — handing a
transfer to the app needs a shared container, i.e. App Groups, which this account cannot enable yet. It
authenticates with the app's stored password via the shared keychain group, as the widgets do, so the
app has to have been signed into once.

## 9c. `StatusHubWatch` — the watch app

The watch app and its complication extension have their own document: **[WATCH.md](WATCH.md)** — its
pages, recording (the silence endpoint, the lock, double tap), the always-on listener, scrolling, the
token handover, logging and the simulator.

## Replies read aloud (`/api/tts`)

The speaker button in the phone's session view (`public/speak.js`) and on the watch (`Speaker`) reads that session's last reply in
Groq's Orpheus voice (`tts_voice` on the Settings page, default `hannah`) (`lib/speech.js`). The server strips the markdown and splits the text into
sentence chunks, the first one a single sentence; the client fetches chunk 0, plays it the moment it
lands, and keeps two chunks ahead, scheduling each on one AudioContext so the joins are gapless.
While it plays the button is a pause, with a stop beside
it; pausing suspends the AudioContext, so everything scheduled waits in place and carries on from there.
Rendered chunks are cached in memory, so a replay costs nothing. Speed (`tts_speed`, default 1.2x) is ffmpeg's `atempo` on
the server, after the cache, because Orpheus ignores the API's `speed` field; changing it re-renders
nothing. The same ffmpeg pass shapes loudness (`shape`): a compressor, dynaudnorm and a limiter take
every chunk to about -14 LUFS at -0.3 dBFS peak, roughly 11 dB louder than Orpheus renders it, because
the watch's speaker is already at full volume and the audio is the only headroom left. A request with
`surface: 'watch'` (the watch sends it) also cuts below 250 Hz and lifts 3 kHz for that speaker. The account is on Groq's free tier,
1200 characters a minute — more than this voice speaks below about 1.3x (it speaks ~900 a minute at
1x), so a 429 is waited out on the server (it names the
wait) rather than failed, and the client's lead absorbs it. The free tier ALSO caps a day at 3600 characters and 100
requests — two or three replies — and a 429 for that names a wait of minutes or more, so it fails at
once rather than holding the play open. The first-sound delay and any stall
between chunks land in the hub log as `[tts-timing]`.

The model needs its terms accepted once on the Groq account
(console.groq.com/playground?model=canopylabs%2Forpheus-v1-english); until then every request is a 502
whose body says `model_terms_required`.

Kokoro on the Pi does not work for this, because it renders SLOWER than real time and streaming only
hides the wait while the generator stays ahead of playback. Measured with `kokoro-onnx` 0.5 in
`~/voice/pi/.venv-kokoro`: the full model renders at 0.8-0.9x real time after an 11 s load, the int8
model at 0.3-0.4x, and the process peaks at 740 MB.

## Claude usage bars

Two 2px bars pinned across the top of every `body.tv` page (the TV walls and the phone home): the
5-hour window on top, the weekly one below, filling left to right, amber from 75% and red from 90%
(the levels at which a dispatched session is reported, then held back; data-layer `desk.ts`). They are
fixed and overlaid, so nothing else on the page moves. The frame carries `claude_usage`
(`buildUsage`: each window's fill, reset time and minutes to reset) from the newest row of Supabase
`claude_usage`, which arrives over realtime; the 15-minute backstop re-reads it. A window whose reset
has passed paints empty until the next turn reports the new one.

## Fallback replies are coloured

A voice reply that a fallback engine wrote carries `voice_messages.engine` (`credits` at the
subscription's usage limit, `codex` when Claude cannot answer; null is the subscription), and every
surface colours the reply text by it: amber for credits, blue for Codex, the colours the usage bars and
the session list already use. Web: `ai-engine-*` in voiceagent.js, `eng-*` in phone-home.js; watch:
`ThreadRow.engine`.
