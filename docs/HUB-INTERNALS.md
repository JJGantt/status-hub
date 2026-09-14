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
- **Realtime:** the server subscribes to Supabase realtime on the tables that must invalidate the
  cached payload (nutrition, sets, app_settings, voice_*), so a voice/MCP write reflects in seconds
  rather than waiting for the tick.
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
  moved while the cache was clean, realtime dropped something. It refetches, recycles the socket
  (a miss is evidence the channel is lying), and **logs**, which the original failure never did. The
  probe costs ~147 bytes and ~340ms per run, about one extra heavy fetch a day, so it closes the
  window without undoing the caching it protects.
- **Every stream goes through `liveStream()` (shared.js), never a bare `EventSource`.** An SSE
  connection can go half-open — `readyState` stays OPEN, no `error` fires, nothing arrives again —
  and the browser only retries a connection it saw CLOSE, so nothing reconnects it. A wall in that
  state looks perfectly healthy: cards hold their last frame and the rest/session clocks keep
  counting, because those are local intervals. `liveStream` judges the connection by whether frames
  ARRIVE: rebuild the socket after 75s of silence, and if the rebuilt one is deaf too, reload the
  page — but only once `/healthz` answers, since reloading into an unreachable hub lands on the
  browser error page where no JS is left to recover (the trap `.xinitrc` gates the kiosk against).
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
| `weather` | the rain-chance grid beside surf — 7 days x 24 hours, the drawn window, the week's peak and the palette | `lib/weather` (NWS gridpoint, cached 15m; **the only outbound fetch in the frame**, and it never blocks it — `getWeather()` returns the last good copy and refreshes behind the caller) |
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
| `navbar.js` | Bottom bar: settings gear, the calendar link (on `/calendar` itself, a back-to-the-wall toggle instead) + the single voice FAB (`wfab-fast`). Exposes `window.__startVoiceCommand` for the native launcher. |
| `voiceagent.js` | The in-app conversation pipeline: `makeRecorder` (mic → `/api/voice-command`), the activity popup, the conversation card, and the durable photo and voice outboxes (IndexedDB) that resend whatever a failed upload left on the phone. |
| `settings.js` | The gear panel — reads/writes `app_settings` via `/api/settings` (§7). |
| `wall.js` | Phone "wall mode": scales the 1920×1080 `/tv` shell to fit a phone; drives the swipe panes. |
| `expand.js` | Phone-wall expand icons → full-screen section sheets. On open it re-runs the two cards (so their grid picks up the sheet's fixed cell size and its history), loads `heathistory.js`, and pins the grid to its newest column. |
| `heathistory.js` | The heat-grid columns older than the status frame carries — fetched once from `/api/heat-history` and drawn only inside the sheet. |
| `tv.js` | KIOSK ONLY, and the guard matters: the activity popup and the heard-you pop, off `/api/voice-stream`. Every other surface boots `voiceagent.js`, which drives the same popup from the same stream — running both left the phone holding a second EventSource open for the life of the page. |
| `wallmode.js` | Follows `app_settings.wall_mode` so voice can switch the TV between the walls. Acts only on kiosk paths (`/tv`, `/tv-session-focus`, `/tv-calendar`, `/tv-home`), never on the phone's `/`. |
| `calendar.js` | The `/calendar` page: paints the server-computed month grid + day agenda from `/api/calendar`; tap a day, page months. Read-only — writes stay with voice and the todo pane. Re-reads on an `/api/list-stream` push, never on a timer. |
| `cards/weather.js` | The rain-chance grid, in the surf card on the home wall and in the phone's misc pane with it. Paints only: the grid, the drawn window, the peak and the colours are all decided in `lib/weather`. Carries no day letters and no sky icons — the leftmost column is today by definition, and in this climate NWS says "chance of showers and thunderstorms" six days in seven, so the icon discriminated nothing the colour did not. |
| `cards/dayline.js` | THE day column, on every surface that has one — and the home wall's look-ahead beside it, painted from the same response into the element `mount` was given as `ahead` — the calendar wall, the home wall, the phone's lists pane. Owns the fetch, the clock and the reload rules: it re-reads on an `/api/list-stream` push and when the server says a chip changes state, and otherwise just moves the now-line against the clock (each hour row carries its 24h number). Mounts `#daycard` itself; the walls mount their column, because they choose the endpoint. |
| `tv-calendar.js` | The calendar wall's middle (only `tv-calendar.html` loads it): the month grid(s) out of the `/api/calendar?wall=1` payload that `dayline.js` fetched for the column beside them. Display-only. |
| `tv-home.js` | The home wall's own middle (only `tv-home.html` loads it): mounts the day column and the look-ahead column beside it, and polls `/api/sessions` for the three most recently active sessions and the focused one's last answer (a pinned one carries the pin). Display-only. |
| `mic.js` | The `/mic` standalone launcher page's script (its own recorder, reuses `voiceagent`). |

The activity element (`.ai-act`) renders the
`activity` frames the worker pushes to `/api/voice-activity`. One element, two mount points: it floats
as a popup on the page view, the phone wall and the Mac app, and on the TV kiosk it mounts into the
footer row's reserved lane (`#tv-act`) so it occupies space rather than covering a card. The choice is
made by `voiceagent.js`'s kiosk predicate, not by whether `#tv-act` exists — §6e says why. Same states
either way.
The frames are: `working` (the prompt, once per command),
`tool` (each tool call + args), `text` (what the model said between tool calls, up to 2000 characters),
`escalate`, and `done`. **`escalate` is the Sonnet→Opus hop**: the worker
sends one when a hub turn leaves the fast path (it needed a full-access tool, or Sonnet errored), and the
bar shows it as its own violet row *and* lights an `OPUS` chip that persists for the rest of the run —
later tool rows replace the text, but the fact that this turn changed models stays on screen until the
command finishes. Only these five states survive the relay; anything else is coerced to `tool`.
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
self-fetches) · `repos` (the Mac's projects; tap to launch a Claude session there, self-fetches) ·
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
`/`, in markup order in the wall page it loads — `tv-home.html` is chat · wall · misc · maint · todo
· repos · reports, landing on the wall; TV `/tv` = the wall + a voice panel (auth `?token=`); the `/mic` page = a
minimal fullscreen voice launcher; `/calendar` = the standalone calendar page (navbar's calendar
button gets there); `/tv-calendar` = the calendar wall (§ CLAUDE.md's walls note).

### The microphone is held open, not acquired per recording

`holdMic()` warms one `getUserMedia` stream when a recording surface comes up and keeps it for as long
as the page is visible; a recording is a MediaRecorder over a device that is already open. iOS takes up
to two seconds to hand over a capture device — 2,017ms measured on his phone — and acquiring per
recording put that wait between every tap and the red fill. Warm, it is 1ms.

It is released when the page is hidden and re-warmed when it returns: iOS interrupts a backgrounded
capture anyway, and the recording indicator should not stay lit over another app. A track can also end
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

The VAD's noise floor is the quietest frame heard so far, tracked across the whole recording, not the
mean of an opening calibration window. A window assumes a pause before speaking; talk immediately and
your own voice sets the threshold above itself, so the clip never registers as speech — no
trailing-silence stop, just a hang until the grace timer gives up. That floor is also what makes it
safe to DROP a clip the VAD watched end to end without once crossing it. Dropping matters because
Whisper does not return an empty string for silence: it invents a plausible phrase — "Thank you." is
the usual one — and the worker then acts on it as a command.

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
| `heatmap.js` | Per-day set-count heatmap laid out as week columns. Shade is an **absolute** count — one level per 6 sets, topping out at 25+ — so a colour means the same thing in every window and on every surface. |
| `weightplot.js` | The mean of each week's weigh-ins, on the same Sunday-anchored columns as the two heat maps, plus the three axis values. Points carry x/y as fractions of the plot box. A week with no reading is **interpolated** between the nearest measured week either side (anchors may sit outside the window) and flagged `imputed` so the card draws the line through it but no dot; a gap with no measured week *after* it stays `null`, because that is extrapolation. The band is whole pounds, widened to an even span so the middle line has an integer to label, and the FIRST column is always blank — the axis values are written over it. Built at `HOME_HEAT_WEEKS`, since the plot means nothing away from the columns it is aligned to. |
| `score.js` | The health bar: `(training + nutrition + tasks)/3`, each band capped at a third. |
| `transcribe.js` | Not domain math — speech to text for a voice clip of any length. Under Groq's 25 MB cap it goes up as recorded; over it, ffmpeg re-encodes to 16 kHz mono Opus at constrained 24 kbps in half-hour pieces, transcribed in order. |

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

**Pages:** `/` · `/tv` (both serve the home wall, the default) · `/tv-health` (health wall — what
used to be the default) · `/tv-session-focus` (sessions wall) · `/tv-calendar` (calendar wall) · `/calendar` (phone/desktop calendar) · `/page` (desktop dashboard) · `/mic` (voice
launcher) · `/reports` + `/report/:id` (§6c) · `/login` · `/healthz` · `/privacy` · `/terms`.

**Read:** `/api/status` (full payload) · `/api/stream` (SSE status) · `/api/voice-stream` (SSE voice
frames for the kiosk) · `/api/list-stream` (SSE, one bodiless `lists` event whenever a dated item or
a list changes — the calendar surfaces' push path, separate from the status frame they don't render) · `/api/workout-day` · `/api/nutrition-day` ·
`/api/heat-history` (the heat-grid weeks OLDER than the frame's `HEAT_WEEKS` window, as a prefix the
expanded sheet draws in front of it — the frame is re-pushed on every realtime event and history only
grows, so it is fetched once by the one surface that can scroll through it) · `/api/voice-messages`
(`?mode=active` resolves `agent_mode` on the server, for a client with no settings of its own — the
watch) · `/api/voice-reply/:id` (held open until that command is `done` or `error`, settled by the
`voice_requests` realtime subscription; after 25s it answers `pending` and the client asks again) ·
`/api/day-stream` (SSE, a bodiless `nutrition` or `workout` frame whenever that day may have changed —
fired from `dirtyNutDay()` / `dirtyWorkoutDay()`, which every write path already calls; the watch's push
path) · `/api/nutrition-day` also takes `date=today`, so a client with no 4am-origin day of its own
gets the server's ·
`/api/todos` (lists + the derived `due` view) · `/api/calendar` (month grid(s) of every
dated item — every occurrence is a real row, so nothing is projected; `?month=` pages, `?wall=1` adds
the day timeline and reads `calendar_months` for the spread, `?day=1` is the timeline alone and
`&full=1` makes it a rolling ±12h window instead of a calendar day — see the dial below, and
`&ahead=N` adds the N days after today as `ahead`) · `/api/badge` · `/api/repos` ·
`/api/repos/cmd/:id` · `/api/sessions` (live desk sessions + the follow-up `focus`) ·
`/api/session-stream` (SSE, one `session` frame per tool call, in-between text or finished turn, pushed by the
orchestrator on either machine — see SESSIONS.md §10) · `/api/reports`
(list only — `html` is never selected) · `/api/surf/history` (the whole hourly archive as one
character per hour; `defaultT0` marks the window the card lands on before it is scrolled back) ·
`/api/attachment`.

**Widget feeds** (compact, one per widget — §9b): `/api/rings` (a timeline of per-minute pace frames,
not a snapshot; the watch reads it too) · `/api/workout-now` (the watch's workout page: the rest-clock
inputs, `sets_today`, and every exercise today — newest first by its last set — each with its muscles'
weekly sets and volume colour) · `/api/due-widget` (every dated item across every list) · `/api/repos-widget` (the
Mac's projects + desk presence). `/api/list-widget` returns one list's item titles and is the
per-list feed `/api/due-widget` replaced; nothing reads it.

**Write:** `/api/settings` (GET/POST) · `/api/log-set` · `/api/log-entry` (POST/DELETE) ·
`/api/commit-staged` · `/api/feed` · `/api/todos/{add,clear,snooze}` · `/api/repos/open` ·
`/api/sessions/:action` · `/api/voice-command` (raw audio of any size → Groq Whisper → enqueue;
optional `lat`/`lon`/`acc`/`place` query → `voice_requests.location`) ·
`/api/voice-text` (text → enqueue, optional `location` object likewise; returns the request id, which
`/api/voice-reply/:id` waits on) · `/api/voice-reset` · `/api/voice-activity` · `/api/attach`
(photo upload) · `/api/register-push` · `/api/notify` (APNs to all devices) · `/api/clientlog`.

**Auth:** the hub password → `sha256("status-hub:"+password)`; sent as the `hub` cookie (web) or the
`X-Hub-Token` header (native app). The kiosk authenticates via `?token=<TV_TOKEN>` (also seeds the
cookie). The gate is one `app.use` and it protects **everything defined below it**, static assets
included. Declared **above** it, and therefore public: `/healthz`, `/login`, `/privacy`,
`/terms`, and the Search Console verification file named by `GSC_VERIFICATION`. The legal pages
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

- **Badge** = every overdue item across every list (`overdueCount()`), not just one table's.
- **The scheduler** (`dueTick`, every 60s) scans `list_items` where `due` is past, dedupes against
  `notifications.dedupe_key`, and hands off to a **named handler** in `DUE_HANDLERS` rather than
  calling `pushAll` directly. Only `push` exists today; the seam earns its ten lines because the
  second handler is already scheduled — AlarmKit ([TODO.md](TODO.md)), which fires on-device and
  breaks through Focus.
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

- **`list_items` invalidates the row cache.** Its realtime handler calls `dirtyRows()` and
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

**`server/tools/dialtest.html` is the bench for all of this**: the column at its real size, a stubbed
payload, and a frozen clock, with `?case=` choosing what is in the hour and `?hour=` sliding it up
and down the drum. It is deliberately outside `public/`, so it is not in the image. Use it rather
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
- **Card:** `public/cards/todo.js` — the 5th phone swipe pane. Self-fetches `/api/todos` (not part of
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

- **Card:** `public/cards/repos.js` — 6th phone swipe pane, self-fetching. The age column doubles as
  launch feedback (blue → green/red) while it polls `/api/repos/cmd/:id`.
- **Endpoints:** `GET /api/repos` (repos + desk presence) · `POST /api/repos/open` (enqueue) ·
  `GET /api/repos/cmd/:id` (pending → running → done | error | expired) · `GET /api/failures` +
  `POST /api/failures/:id/{retry,dismiss}` (commands that never ran).
- **A launch is refused, not queued, when its machine is asleep** — 409 with a `saved` id. The
  payload lands in `desk_dead_letters` instead of a `desk_commands` row nobody will claim. Same for
  the sessions panel's end/resume, which now also target the machine that OWNS the session (read from
  its `worker`) rather than always the Pi.
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

`/api/sessions` stamps each active session with `n`: running above parked, **most recently active
first** within each (`active_at`, the last turn boundary — SESSIONS.md § Numbering says why not
`last_seen` or `started`), from 1. **That rule is duplicated in `data-layer/src/desk.ts`
(`numberSessions`) and the two must agree** — it is how "move session three to the Mac" resolves to
the same row the pane is showing. The number is a position, not identity: closing one renumbers the
rest, which is the price of it being short enough to say.

`POST /api/sessions/transfer` hands a session to the other machine. The row says which machine it is
on now (`worker`), so the destination is implied. Two paths, matching the voice tool exactly: if the
source machine is up it closes the session and flushes the mirror first; if it is not, the
destination resumes from what was already mirrored and the old row is marked `transferred`. The
button is absent for a session with no `claude_session_id`, since there is no transcript to carry.

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
which is how the watch answers the session it is showing. Running, the words are typed in — the same
`desk_commands` `follow_up` the voice tool writes for the focused session. Parked, the session is
resumed with the words as its prompt: `resume_session` takes one on both machines, and a full Pi
queues it for a slot. An asleep machine gets the words dead-lettered, like every desk command from the
hub, and a repeated `client_msg_id` returns the first command rather than sending them twice.

**It asks about the conversation, not the row** (`conversationNow`). A resume makes a new row and leaves
the parked one parked, and `claude --resume` keeps the conversation's id — so words for a parked row
whose conversation is running again go to the running row, and a resume still opening or queued
answers 409. A second resume would put two processes on one transcript and fork it; the phone's Resume
button goes through the same check. Every case is an exact lookup: both machines stamp a resumed row
with the resume command's id, and the Pi publishes the conversation id at launch.

`GET /api/sessions/:id` returns one session with its `last_prompt`, whole `last_reply` and
`claude_session_id`, under its own projection, for a surface showing a single session rather than the
list.

### The last thing a session said

`desk_sessions.last_reply` is the FINAL message of a turn, with `reply_at` for when it landed and
`working` for whether a newer turn is in flight — a reply is final only when `working` is false. It is
read from the transcript rather than inferred: Claude Code writes one record per content block, each
carrying the message's `stop_reason`, and a turn ends with `end_turn`. "The last assistant text" is
not the same thing — mid-turn that is a half-written thought.

`last_prompt` is the prompt that started that turn. `readTail` pairs the two and both machines write it
wherever they write the reply, so they are replaced together; it is blank, not an older prompt, when
the turn's opening has scrolled out of the window `readTail` reads.

### Every finished reply is a notification

Each session's final reply of a turn — never the tool calls — is pushed to the phone, and from there
the watch, by `notifySessionReply`: both machines already report every turn end to
`/api/session-activity` (`sessionWatch.js` `reportTurnEnd` — the watcher the moment a turn ends, the
reconcile tick for one `fs.watch` dropped), so it is sent from there, for every session on either
machine, the one being typed in included. Kind `session`, `active` so it lights the watch; title the
session's name, body the reply. It is keyed `session-reply:<id>:<reply_at>` — the watcher sends the
turn's `at` — so one turn buzzes once even when its end is noticed twice, and `push_enabled` gates it
as it gates the voice worker. `relay.js` posts a hub dispatch's first reply into the hub thread but
sends no push of its own: this one covers it.

The payload's `session_id` is what a tap opens: `SessionLaunch` → `window.__showSession` lands on the
sessions pane with that row scrolled into view and marked (`cards/repos.js`). The `SESSION_REPLY`
category gives the watch an Open button (§9c).

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

## 6c. Reports — a session's HTML write-up

A session dispatched from the phone or by voice answers in its transcript as usual; that is what
Remote Control shows and none of this touches it. A **report** is a second, richer output: the model
writes a self-contained HTML page, it lands as a push notification, and tapping it opens the page.

| piece | where |
|---|---|
| `publish_report(title, summary, html)` | data-layer MCP (`src/reports.ts`) — writes a `reports` row |
| the instruction to publish | `REPORT_DIRECTIVE`, appended to the prompt by `pi-desk` and the Mac orchestrator |
| the notification | `reportTick()` here, every 20s |
| the page | `GET /report/:id`; every report at `GET /reports` |
| the way in | the **Reports pane** — the last swipe pane, right after the repo launcher |
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

**The phone and the Mac app load this same markup**, so `#tv-act` exists there too — but the lane is
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
| `hub-reach-watch.sh` (Pi) | 3 failed reachability checks, reloads on the down→up edge | the hub actually being gone |

The middle layer reads `window.__hubStreamAge()` over CDP — it is the only signal that separates "JS
is running fine" from "JS is running fine over data that stopped." It is gated on the hub answering,
because a stale wall during an outage is the truth, and killing Chromium then drops the `.xinitrc`
loop onto its reachability gate and leaves a black screen instead of a stale one. That case belongs
to the third layer, which is why the second one declines it.

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
| `session_reset_s` | Idle gap before the hub voice conversation resets context. |
| `activity_hold_s` | Seconds a finished activity row (the reply, or an error) holds on the bar. Default 60. |
| `phone_activity_hold_s` | The same, off the kiosk (phone, Mac app panel). Default 8. |
| `wakefree_enabled` | Always-on (wake-free) voice on/off. |
| `voice_inject_mode` | Mac-mic speech injected into the focused window (ESP off). |
| `voice_muted` | Global mute (PTT/FAB) — silences Mac mic + ESP. |
| `voice_speak_replies` | Read the reply aloud. |
| `voiceid_threshold` / `voiceprint` | Wake-free speaker-ID — the "it's Jared" bar and the exemplar bank. |
| `wakefree_pause_s` | ESP only, and only until its voiceprint loads. Wake-free endpoints on Jared's verified presence, with a pause tolerance that scales with utterance length — neither mic consults this. |
| `phone_silence_s` / `mac_silence_s` / `esp_silence_s` | Trailing-silence cutoff, per capture source. |
| `agent_mode` / `agent_cwd` | Full-agent (coding) mode toggle + working dir for the worker. |
| `weight_reminder_enabled` / `_mode` / `_time` | The daily weigh-in push (On/Off, Manual/Dynamic, time). |
| `push_enabled` | Master push toggle. |

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
extension **`StatusHubWatchWidgets`** (watchOS 11+, embedded by the iOS app — §9c). More than a thin
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
- **Build/install:** see the root `README.md` (xcodegen → xcodebuild → `devicectl device install`).

---

The remaining Swift in `apps/Sources/` is the pre-webview native UI, still compiled and still used by
the widgets' data path:

| file | holds |
|---|---|
| `HubModel.swift` | `HubModel` — fetches `/api/status`, publishes it to the SwiftUI views |
| `Models.swift` | the payload decoded: `Status`, `Litter`, `Macros`, `Nutrition` |
| `Views.swift` | the shared card vocabulary — `CardBox`, `StatRow`, `MacroTile`, `LitterCard` |
| `Theme.swift` | a `Color` extension; the palette both the app and the widgets draw from |

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
  recording happens on the repos pane.
- **Two taps, and the confirm matters more here.** Tap a row to select, tap ▶ to hand over. This one
  starts a process on a real machine; a stray tap that opens a terminal is worse than one that opens
  options. Same extension-local `UserDefaults` arm store, same 20s expiry with a second timeline
  entry so the confirm retracts itself.
- **A rebuild is not always a fetch.** Selecting a row is local state; making it wait on an HTTPS
  round-trip is what made the first interactive widget feel broken. A cached payload under 60s old
  (or any armed state) backs the redraw. The refresh policy is 30 minutes — the list is the Mac's own
  scan and only moves when work happens.

Harness: `tools/render-repos.swift`.

## 9c. `StatusHubWatch` — the watch app

A watchOS 11+ app (`apps/Watch/`, bundle `com.jaredgantt.statushub.watch`) embedded by the iOS app,
plus its widget extension (`apps/WatchWidgets/`, `com.jaredgantt.statushub.watch.widgets`): the
complication and, on watchOS 26, the Record control. It is native SwiftUI, not a web view: watchOS
has no WKWebView.

- **Four pages, swiped left to right:** the sessions page, the prompt (where the app opens), the
  nutrition page and the workout page. A page loads when it comes on screen and holds its event
  stream open only while it is showing, reloading after every reconnect, since a change may have gone
  by. `Hub.listen` reads all three streams; every frame the hub sends has a `data:` line, keepalives
  included, and that is what it dispatches on.
- **The prompt page.** The shared hub thread on black — `/api/voice-messages?focus=hub&mode=active`, the
  same current-context thread the phone and the TV show, in whichever mode `agent_mode` selects. It
  follows `/api/voice-stream`: a `message` frame reloads the thread, and the worker's `activity` frames
  draw the running command's tool calls under it, and what the model says between them in full, in
  plain text rather than the tool calls' grey monospace (`ActivityLines`). The hub stores none of those, so they show only
  while the page is watching and clear when the next command starts (`working`) or this one ends
  (`done`). A tap anywhere on it, or the double-tap gesture, starts recording; the next tap sends.
  Cancel throws the clip away.
- **The sessions page** lists `/api/sessions` one row per conversation — running first, then parked,
  most recently active first within each, the order `n` counts in — and follows `/api/session-stream`.
  Each row is its name over up to three lines of what it last said: the list's `say`, which the hub
  already cuts to 120 characters, drawn smaller and grey with its markdown's bold and code dropped.
  Everything it keeps is keyed by `claude_session_id`, not by row: a resume makes a new row for the
  same conversation, and keyed by row the page would lose a session the moment it resumed. A session
  opens to its last prompt and the whole reply to it (`GET /api/sessions/:id`) and the tool calls of
  the turn it is running, as its machine reports them. A tap records a reply: the hub transcribes it
  without enqueueing anything (`/api/voice-command?dry=1`), and `POST /api/sessions/followup` types the
  words in, or resumes a parked session with them (§6b). His words stay under the reply until the
  conversation's next `done`.
- **One microphone.** `Watch/Capture.swift` owns the recorder for both pages. `owner` says whose
  recording it is, so a page cannot start one over another's, and only the owner draws or sends it.
- **Double tap pages before it records.** A reply is read from its top: the prompt page scrolls the
  newest reply's top to the top of the screen, and a session page does the same when a new reply lands.
  The prompt page holds that spot (`pinned`) from the moment the app opens or comes back to the front
  until he scrolls or pages, re-aiming on every change in the content's height — a single jump on a
  cold launch lands short while the thread is still laying out. The thread is the newest 40 rows,
  about twenty exchanges.
  While more is below the screen, a small chevron sits at the bottom edge and holds the double-tap
  gesture (`PageDownMarker`, `handGestureShortcut(_:isEnabled:)`). Text scrolls to the screen's very
  edge, so the marker fades it out of a 28pt strip there and the chevron sits in that strip. A page
  moves the last line showing above the strip to the top edge of the screen. At the bottom — or while
  recording — the page's record button holds the gesture again. Where the view stands comes from
  `onScrollGeometryChange` (`trackScroll` in `Watch/WatchUI.swift`). A finger tap on the thread still
  records from anywhere; only the gesture pages.
  The paging math rests on things measured in the watchOS 26.5 simulator, all easy to get wrong.
  The same scroll view reports its geometry in two frames depending on how it was last moved: after
  a jump to a view (`ScrollViewReader`, which every open and pin uses) `visibleRect` is the safe area
  alone with zero `contentInsets`; after `ScrollPosition.scrollTo(y:)` it is the whole screen with the
  strips as insets. Math on `contentOffset` and the insets was right in one frame and wrong in the
  other: a short first page, the chevron drawn mid-screen, and a last page aimed where the view
  could not go, so double tap never reached the bottom. `ScrollState` therefore keeps only the safe
  area's edges (`visibleRect` less the insets, the same in both frames), and the strips' height comes
  from the screen (`WKInterfaceDevice.screenBounds`). `scrollTo(y:)` puts y at the safe area's top, so
  a page's target is the new top edge plus the strip under the clock. The marker is a full-height
  column that ignores the bottom safe area, which lands it on the physical edge in either frame.
  **Being at the bottom is not read from the scroll geometry at all.** On his watch (not reproducible
  in the 46mm simulator) the geometry kept reporting content below after the view had stopped at its
  end, so each double tap asked for a scroll that could not happen, the view jiggled, and recording
  never got the gesture. A 1pt view after the last content (`scrollEnd`) reports where it really is
  on screen, and the page is at the bottom when that is within a line of the screen's bottom edge —
  true by construction whenever the view has stopped at its end. The sessions list ends with the build
  number (`CFBundleVersion`, which CI sets to the TestFlight build), so a fix that has not been
  installed is not mistaken for one that failed.
  Both pages scroll through one component, `PagedScroll` (`Watch/WatchUI.swift`), so paging, the
  bottom and the double-tap handover cannot differ between them. It owns the scroll state and hands
  its page only `atBottom`: the prompt page used to hold the per-frame state itself and rebuilt its
  whole thread every frame of a page. Thread rows are their own view (`ThreadRow`) for the same reason.
- **The watch logs what it does to the hub.** `Hub.log` posts to `/api/clientlog`, which prints one
  `[clientlog]` line per event: `fly logs -a jared-status-hub | grep '"src":"watch"'`. Events: `thread`
  and `detail` (what a page loaded), `page` / `paged` / `bottom` (the scroll state around each double
  tap), `record`, `stream-open` / `stream-end` / `stream-error`, and `frame` (each stream frame for the
  session on screen, to see whether the stream reaches the wrist live). Read it before guessing at a
  report from the wrist.
- **The real watch app runs in a simulator against the live hub.** Simulator-only code, compiled out
  of device builds: the token comes from `SIMCTL_CHILD_HUB_TOKEN` (the kiosk's, sent as `?token=`),
  `-autopage chat|session` stands in for double tap every two seconds, and `-opensession <row id>`
  opens a session as its notification would. The built app needs `WKWatchOnly` and no
  `WKCompanionAppBundleIdentifier` (then an ad-hoc `codesign`) to install on an unpaired watch
  simulator. Use an SE 3 device type for his watch: the 46mm geometry differs.
- **A session's reply notification opens it** (§6b). `WatchAppDelegate` registers the `SESSION_REPLY`
  category with one foreground action, Open — the button double tap presses on a watch notification —
  and answers it, or a tap on the notification itself, with `Sessions.open(rowId:)`: the app lands on
  the sessions page with that conversation pushed (`Sessions.path`), a row the list has not loaded yet
  (a resumed session's new one) included, and it fetches that conversation's reply itself. Left to the
  view's own load, the reply stayed old: a conversation already on screen does not appear again, and an
  app in the background missed the stream's `done`. For the same reason the page refetches the
  on-screen conversation whenever it becomes active. The category is registered at launch, so the watch app has
  to have run once for the button to appear.
- **A command is a recorded clip, sent the way the phone's microphone sends one.** `Watch/Recorder.swift`
  records AAC, mono, 16 kHz, and `Hub.sendAudio` uploads the file to `/api/voice-command` (source
  `web`): the hub transcribes it with the same Groq Whisper, and the worker treats it as push-to-talk —
  no addressing gate, no duplicate-drop, no spoken reply on the TV. The hub answers with the
  transcript, shown until the turn lands, and the request id, and the watch waits on
  `/api/voice-reply/:id`. No id means the hub heard no words: nothing is enqueued and the watch buzzes.
- **Recording sets `voice_muted`**, as the phone's microphone does, so the Mac and the ESP do not
  enqueue the same sentence a second time. The flag has no expiry, so every way out of a recording
  (send, Cancel) writes the unmute, and the writes are chained so an unmute cannot land ahead of its
  mute.
- **Retry.** The clip is kept until its command has run, and the `client_msg_id` across a Retry, so a
  resend after a dropped connection gets the first send's id back instead of running twice. Once the
  id is known, Retry only waits again; after a worker error it uploads the clip as a new attempt.
  **Cancel stops waiting — a command the hub already has still runs.**
- **Two launchers, one request.** The complication (circular and corner) opens `statushub://record`.
  The Record control (`RecordControl`, watchOS 26 — Control Center, the Smart Stack, and the Action
  button on an Ultra) runs `RecordIntent`, an `OpenIntent`, which launches the app and runs
  `perform()` in it: the file is compiled into both targets, and `WATCH_APP` gates the app-only call.
  Both set `Chat.recordRequested`; the app switches to the prompt page and records as soon as it is
  active. Without an Action button, the no-touch path is the Smart Stack: with Settings → Gestures →
  Double Tap → Smart Stack set to Select and Record pinned, two double taps from the watch face open
  it recording (verified on an SE 3, watchOS 26.5). An app holding a workout session (Watchset while
  it captures) sits above even pinned items.
- **The nutrition page** is the hub nutrition card's four pace rings (no produce rings) over today's
  log. The rings are `cards/nutrition.js`'s SVG redrawn in a Canvas to the same geometry and colours.
  The card recomputes them every second from the browser clock; the watch instead takes
  `/api/rings`'s per-minute frames and blends between the two either side of now each second. Between
  two minutes the arcs, both ticks and the deviation number all move linearly, so the blend reproduces
  the card's drain without a copy of `lib/pace.js` in Swift. Colours come from a frame, never derived.
  This is why a frame's `frac` is sent to four places: at two it moved the tick in ~8-minute jumps.
  The watch compiles `Controls/RingsView.swift` for the `/api/rings` types and the palette; the
  widget's own views in it go unused. The log is `cards/nutritionlog.js`'s day list (band, then
  entries newest first, staged on top), display only, with the chips wrapping instead of scrolling.
- **The workout page** is the home wall's `#resttimer` (Last set · Session · Sets, ticking each
  second off naive wall-clock digits exactly as `workouts.js` does) over every exercise logged today,
  each drawn as the wall's `data-recent` row — the one a set just went onto at the top, the rest
  scrolling below — fed by `/api/workout-now`. The strip stays one line as on the wall, stepping
  smaller, and wraps only when one line would be unreadable.
- **The token comes from the phone.** The watch has no web view to sign in with and shares neither
  cookies nor Keychain with the phone. `Sources/WatchLink.swift` reads the `hub` cookie from the web
  view's cookie store (falling back to the Keychain password) and sends it as WatchConnectivity
  application context on activation, when the watch app is installed (`sessionWatchStateDidChange` —
  context sent before that is refused), and on every cookie change. The watch keeps it in its own
  Keychain and, whenever it has none, asks with a message, which wakes the phone app in the
  background. A 401 drops the stored token and asks again.
- **It ships inside the iOS app**, so it reaches the watch with a TestFlight build of the app. Do not install a
  local build of the iOS app to try the watch: that build cannot receive push (CLAUDE.md).
