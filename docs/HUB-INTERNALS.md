# Status Hub — Internals

How the hub UI is actually built: the data flow, the payload contract, the module map, the domain
engine, and the full API + settings surface. Read `ARCHITECTURE.md` first for the ecosystem view;
this is the map for working *inside* `status-hub` itself.

> Freshness: 2026-08-24. The individual code files carry detailed header comments — this doc is the
> connective tissue (structure, contracts, catalogs) that no single file holds.

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

---

## 2. The `/api/status` payload contract

`buildStatus()` (server.js) returns exactly these top-level keys. Each card reads its slice:

| Key | Feeds | Built by |
|---|---|---|
| `today` | the 4am-origin day string everything is scoped to | `lib/dates.nutritionWindow()` |
| `nutrition` | Today·Nutrition card (Cal/P/C/F pace rings + produce) | intake rollup + `lib/pace` |
| `pace` | the drain/refill state + colors for the rings | `lib/pace.computePace()` |
| `maintenance` | the calorie-target card + the maintenance-window viz | `lib/maintenance` (§4) |
| `nutrition_log` | calorie-adherence calendar + calorie/weight trend plot | `lib/nutritionlog` |
| `volume` | per-muscle weekly volume gauges + the body map colors | `lib/volume` + `lib/bodymap` |
| `heatmap` | GitHub-style workout heatmap | `lib/heatmap` |
| `litter` / `feeder` / `surf` | those device/status cards | Supabase rows (`device_status`, snapshots) |
| `rep_watcher` | what the Apple-Watch rep watcher is logging as | `sets`/watcher state |
| `last_set_at` / `session_start_at` | the rest clock + "since last set" | derived from `sets` |
| `routing` / `mics` | voice liveness strip (ESP/Mac/Pi + always-on/inject) | `voice_presence`, `worker_presence`, `app_settings` |
| `score` | the weekly overall-score gauge | `lib/score` |
| `generated_at` | payload timestamp | — |

`todos` (lists/notes) is **not** in this payload — the todo card self-fetches `/api/todos`
(so it isn't rebuilt on every 30s tick). See §6.

---

## 3. Client modules & cards (`public/`)

**Top-level modules:**

| File | Role |
|---|---|
| `core.js` | Boot: opens the SSE stream, is the render orchestrator (calls every card's `render(s)`), then inits the layout. |
| `shared.js` | Shared helpers (`esc`, `state`, local-time formatting) + the `state.last` cache. |
| `navbar.js` | Bottom bar: settings gear + the single voice FAB (`wfab-fast`). Exposes `window.__startVoiceCommand` for the native launcher. |
| `voiceagent.js` | The in-app conversation pipeline: `makeRecorder` (mic → `/api/voice-command`), the activity popup, the conversation card. |
| `settings.js` | The gear panel — reads/writes `app_settings` via `/api/settings` (§7). |
| `wall.js` | Phone "wall mode": scales the 1920×1080 `/tv` shell to fit a phone; drives the swipe panes. |
| `expand.js` | Phone-wall expand icons → full-screen section sheets. |
| `tv.js` | TV/kiosk-only: the voice-conversation panel + session terminal layered on the wall. |
| `mic.js` | The `/mic` standalone launcher page's script (its own recorder, reuses `voiceagent`). |

The activity popup (`.ai-act`, shared by the page view, the phone wall and the TV kiosk) renders the
`activity` frames the worker pushes to `/api/voice-activity`: `working` (the prompt, once per command),
`tool` (each tool call + args), `escalate`, and `done`. **`escalate` is the Sonnet→Opus hop**: the worker
sends one when a hub turn leaves the fast path (it needed a full-access tool, or Sonnet errored), and the
bar shows it as its own violet row *and* lights an `OPUS` chip that persists for the rest of the run —
later tool rows replace the text, but the fact that this turn changed models stays on screen until the
command finishes. Only these four states survive the relay; anything else is coerced to `tool`.

**Cards (`public/cards/`)** — each exports `render(s)` and paints from its `s.*` slice:

`nutrition` (Cal/P/C/F pace rings + produce sub-rings) · `nutritionlog` (calorie+weight plot +
adherence calendar) · `maintviz` (4th phone swipe pane — the maintenance-window viz) · `todo` (5th
pane — reminders/lists/notes, self-fetches) · `repos` (6th pane — the Mac's projects; tap to launch a
Claude session there, self-fetches) · `muscle` (body map + volume gauges) · `workouts`
(heatmap + day detail) · `litter` · `feeder` · `surf` · `routing` (TV top strip) · `score` (TV right
column) · `mics` (page voice-liveness strip).

**Surfaces (same code, different chrome):** desktop `/page` = scrolling rows; phone = swipe panes on
`/` (chat · wall · misc · maint · todo · repos); TV `/tv` = the wall + a voice panel (auth `?token=`); the
`/mic` page = a minimal fullscreen voice launcher.

---

## 4. The domain engine (`lib/`)

The math lives here; each file has a thorough header. Summary map:

| Module | What it derives |
|---|---|
| `maintenance.js` | Adaptive TDEE via energy balance (avg intake − trend·kcal/lb), the dynamic calorie+macro goal, and the **goal-phase** logic (window bounded by a bulk↔cut sign flip, with a seed held until the new phase has data). Also `estimateHistory` (per-day replay for the viz). |
| `pace.js` | Within-day intake pacing — the eating window (derived from history), and each macro's drain/refill fill + green→red/amber color vs the expected-by-now line. |
| `nutritionlog.js` | The calorie/weight dual-axis plot, the diverging-color adherence calendar, and `buildGoalResolver` (per-day calorie goal, respecting stored targets + phases). |
| `volume.js` | Weekly per-muscle fractional-set volume (primary=1.0, secondary=0.5) vs the ~10–20 sets/week target. |
| `bodymap.js` | The front/back body SVG (viewBox 0 0 72 93); volume colors paint onto it. |
| `heatmap.js` | Per-day set-count heatmap laid out as week columns. |
| `score.js` | Weekly overall score = 0.5·training + 0.5·nutrition. |
| `variants.js` | Exercise equipment variants + YouTube how-to links. |
| `dates.js` | The 4am-origin "day" + display-timezone helpers (`TZ_DISPLAY`, default America/New_York). |
| `apns.js` | Dependency-free APNs sender (HTTP/2 + ES256 `.p8` JWT), per-token sandbox/production. |
| `weightReminder.js` | The daily weigh-in push scheduler (§8). |

---

## 5. API surface (`server.js`)

**Pages:** `/` · `/tv` (wall) · `/page` (desktop dashboard) · `/mic` (voice launcher) · `/login` · `/healthz`.

**Read:** `/api/status` (full payload) · `/api/stream` (SSE status) · `/api/voice-stream` (SSE voice
frames for the kiosk) · `/api/workout-day` · `/api/nutrition-day` · `/api/voice-messages` ·
`/api/todos` (lists + notes + the derived `due` view) · `/api/badge` · `/api/repos` · `/api/repos/cmd/:id` · `/api/attachment` · `/api/rings` (the iOS
widget's compact pace feed — a timeline of frames, not a snapshot; see §9b) · `/api/list-widget`
(one list's item *titles* for the to-do widget; `?list=` defaults to `todo`).

**Write:** `/api/settings` (GET/POST) · `/api/log-set` · `/api/log-entry` (POST/DELETE) ·
`/api/commit-staged` · `/api/feed` · `/api/todos/{add,clear,snooze}` · `/api/repos/open` · `/api/voice-command` (raw audio →
Groq Whisper → enqueue) · `/api/voice-text` (text → enqueue) · `/api/voice-reset` ·
`/api/voice-activity` · `/api/attach` (photo upload) · `/api/register-push` · `/api/notify` (APNs to
all devices) · `/api/clientlog`.

**Auth:** the hub password → `sha256("status-hub:"+password)`; sent as the `hub` cookie (web) or the
`X-Hub-Token` header (native app). The kiosk authenticates via `?token=<TV_TOKEN>` (also seeds the
cookie). Everything under the gate requires one of these; `/healthz` and `/login` are public.

---

## 6. Lists / notes (and what used to be reminders)

**There is no reminders table.** A reminder is an item with a `due` date — nothing else distinguishes
one (data-layer migration `00056`). The two tables were already the same row shape and differed only
in that `reminders` had `due` and `list_items` had `list_name`; every behavioural difference followed
from `due` alone, and an undated reminder already behaved exactly like a to-do. Meanwhile `todo` was
never special either — it is one row in `lists` beside `grocery` and `Amazon`.

So `due` now lives on `list_items` and **any item on any list can carry one**. A dated Amazon item
fires and badges identically to a dated to-do; there are no classes of item. "Due" in the pane is a
derived cross-list *view*, not a stored list, so a dated item shows both there and on its own list
while being one row.

Consequences worth knowing:

- **Badge** = every overdue item across every list (`overdueCount()`), not just one table's.
- **The scheduler** (`dueTick`, every 60s) scans `list_items` where `due` is past, dedupes against
  `notifications.dedupe_key`, and hands off to a **named handler** in `DUE_HANDLERS` rather than
  calling `pushAll` directly. Only `push` exists today; the seam earns its ten lines because the
  second handler is already scheduled — AlarmKit ([TODO.md](TODO.md)), which fires on-device and
  breaks through Focus.
- **The dedupe key is still `reminder:<id>`.** Migration 00056 preserved item ids precisely so the
  ledger rows written before the merge still match. Renaming the key would orphan them and every
  already-delivered item would fire a second time.
- **`kind` is gone** from `/api/todos/clear` — one table, one thing to clear.
- **Repeats** live in `repeat_every` (`'1 day'`, `'2 hours'`, `'1 month'`, …). One nullable column,
  not a boolean plus a period: null already means "one-shot", and a second field carrying the same
  fact is a second field that can contradict it — the shape migration `00053` removed when `done` and
  `deleted` both meant "dealt with". `advanceDue()` computes the next occurrence on the **wall-clock
  components** rather than an instant, so "every day at 9am" survives a DST boundary; it skips whole
  missed windows (a daily item unfired for three days comes due once, not three times) and clamps
  month-ends (Jan 31 + 1 month → Feb 28, not Mar 3). Re-arming happens *after* delivery, so a failed
  send leaves the row due and retries rather than rolling forward and skipping an occurrence.
- **The dedupe key is `reminder:<id>:<due>`** — scoped to the occurrence, not the row. A repeating
  item fires under one id repeatedly, so the id alone would suppress everything after the first
  occurrence. It also makes snooze self-cleaning: moving the due is already a new key, so the endpoint
  no longer deletes the old ledger row by hand.

Voice/MCP writes them (data-layer tools); the hub surfaces them:
- **Card:** `public/cards/todo.js` — the 5th phone swipe pane. Self-fetches `/api/todos` (not part of
  the status stream), refreshes on mount / after edits / on focus.
- **Endpoints:** `GET /api/todos` (reminders + lists+items + notes) · `POST /api/todos/complete` ·
  `POST /api/todos/add` (service-key writes; list add auto-creates the list).
- **Reminder firing:** a 60s tick app-pushes any reminder whose local `due` has passed, deduped via a
  `notifications` row keyed `reminder:<id>` (date-only dues fire 9am). Shares `pushAll()` with
  `/api/notify`.

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
carries both directions and the Mac's **voice-orchestrator** daemon owns everything local:

```
orchestrator ──scan ~/repos (60s)──▶ repos table ──▶ GET /api/repos ──▶ cards/repos.js
cards/repos.js ──POST /api/repos/open──▶ desk_commands ──realtime──▶ orchestrator ──▶ Terminal
orchestrator ──beat(30s)──▶ worker_presence(worker='desk') ──▶ the list greys out when the Mac sleeps
```

- **Card:** `public/cards/repos.js` — 6th phone swipe pane, self-fetching. The age column doubles as
  launch feedback (blue → green/red) while it polls `/api/repos/cmd/:id`.
- **Endpoints:** `GET /api/repos` (repos + desk presence) · `POST /api/repos/open` (enqueue) ·
  `GET /api/repos/cmd/:id` (pending → running → done | error | expired).
- **Guardrail:** the client's path selects a published ROW; the row's own path is what gets enqueued,
  so a crafted request can't `cd` anywhere else. The orchestrator re-validates independently, and
  commands older than 120s expire rather than opening terminals when the Mac wakes.

---

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

## 7. `app_settings` catalog (flat key/value)

| Key | Controls |
|---|---|
| `surplus_cal` | Signed kcal over maintenance (+bulk / −cut / 0 maintenance). |
| `maintenance_min_days` | Aligned-window length before adaptive maintenance goes live (Settings "calibration window"). |
| `maintenance_phase` | JSON `{start, seed, sign, hold}` — the current goal phase (§4). Written on a `surplus_cal` sign flip. |
| `session_reset_s` | Idle gap before the hub voice conversation resets context. |
| `wakefree_enabled` | Always-on (wake-free) voice on/off. |
| `voice_inject_mode` | Mac-mic speech injected into the focused window (ESP off). |
| `voice_muted` | Global mute (PTT/FAB) — silences Mac mic + ESP. |
| `voice_speak_replies` | Read the reply aloud. |
| `wakefree_pause_s` / `voiceid_threshold` / `voiceprint` | Wake-free endpointing + speaker-ID (ESP). |
| `phone_silence_s` | Trailing-silence cutoff for the phone recorder. |
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

XcodeGen (`project.yml`) → three targets: **`StatusHub`** (iOS 17+), **`StatusHubMac`** (macOS 13+,
shares `Sources/` + `Shared/Auth.swift` only), and **`StatusHubControls`** (iOS 18+
widgetkit-extension, embedded by the iOS app — §9b). More than a thin wrapper now:

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

## 9b. `StatusHubControls` — the Record control + the widgets

One iOS-18 widgetkit-extension (`apps/Controls/`, bundle `com.jaredgantt.statushub.controls`,
embedded by the app) hosts **all of them** — the Record control, the Macro Rings widget and the
to-do widget — in a single `WidgetBundle` (bottom of `RecordControl.swift`).
That is the intended shape — a bundle is meant to carry several widgets and controls — and it also
avoids a **new bundle id**, which would need a new provisioning profile, which the rejected Xcode
account session can't issue ([TODO.md](TODO.md) § Blocked on Jared).

**Record control** (`RecordControl.swift`) — a Lock Screen / Control Center button. It runs
`HubVoiceIntent`, so it needs none of the app's code: `openAppWhenRun` opens the app and `perform()`
executes *in the app process*, where `HUB_APP` is defined and `RecordLaunch` fires the web voice FAB.

**Macro Rings widget** (`RingsWidget.swift` = WidgetKit plumbing, `RingsView.swift` = drawing) —
today's Cal/P/C/F **pace** rings, drawn to match the hub's nutrition card. Not absolute progress: a
ring is full when on pace, drains as the clock runs ahead of what's been eaten, and grows an overflow
arc once ahead; the white tick is where the arc would end if you were exactly on pace. Families:

| Family | Layout |
|---|---|
| `systemSmall` | 2×2 grid of rings (a row of four would leave a square widget two-thirds empty) |
| `systemMedium` | health bar on top, then a row of four rings with `consumed / goal` under each |
| `accessoryCircular` | calories only |
| `accessoryRectangular` | four compact rings in a row |

Tapping opens `statushub://open` — any host but `record` just opens the app.

- **The server does the maths.** Every drawn value comes precomputed from `GET /api/rings`: arc
  lengths (`ring_base`/`ring_over`), colours, the signed deviation number, the marker position
  (`frac`), and the health-bar fills. `lib/pace.js` and `cards/score.js` stay the only implementations
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

**To-do widget** (`TodoWidget.swift` = WidgetKit plumbing, `TodoView.swift` = drawing + button
intents) — the `todo` list's item titles, Home Screen families only (`systemSmall` 6 rows /
`systemMedium` 5 / `systemLarge` 10; the accessory families are too small for a list, and a ✕ that
small is a mis-tap waiting to happen).

- **Titles, not bodies.** Items carry a real `title` column (migration `00056`), and
  `/api/list-widget` prefers it. When it's absent the hub derives one — cutting at the first em dash
  or line break, capped at 90 chars — which covers everything written before the column existed.
  Either way the hub decides what a row says, not the Swift. Rows are one line each, which is what
  makes the row counts above exact rather than hopeful.
- **Overdue rows are marked.** Dated items sit on ordinary lists now, so any row can be overdue; the
  feed sends a per-item `overdue` flag and the widget paints those amber, matching the pane's due
  chip. It decodes as optional so a `todo-last.json` cached before the field existed still loads —
  a fallback cache that fails to decode is a blank widget, which is what it exists to prevent.
- **Two taps to clear.** A widget has *no gestures* — no swipe, no long press, only `Button`/`Toggle`
  taps. So tapping a row arms it (its ✕ appears) and tapping the ✕ clears it via the same
  `/api/todos/clear` the web pane uses. That preserves the property the pane's left-swipe was chosen
  for — no single stray tap deletes anything — with the only mechanism widgets offer. Tapping an
  armed row again disarms it; `TapTodoItem` is one *toggling* intent because `Button(intent:)` takes
  a single concrete type and a ternary over two intent types doesn't compile.
- **Arm state needs no App Group.** A widget's button intent runs in the *extension's own process* —
  the same one the timeline provider runs in — so `UserDefaults.standard` is shared ground between
  them (`ArmStore`). An App Group would mean a new entitlement and a regenerated provisioning
  profile, i.e. blocked. The arm expires after 20s, and the provider emits a second entry at that
  expiry so a revealed ✕ closes itself.
- **No frames.** Unlike the rings, this data doesn't move with the clock, so it's one snapshot per
  fetch. Freshness comes from reloads: WidgetKit rebuilds the timeline the moment a button is tapped,
  `applicationDidBecomeActive` covers foregrounding, and `cards/todo.js` posts `reloadWidgets` after
  any edit in the pane (unthrottled — unlike `core.js`'s macro nudge it only fires on a real tap).
  The 1-hour policy is just the backstop for a change made elsewhere (voice, the Mac).
- **Never blank.** Same `todo-last.json` cache fallback as the rings. "Can't reach the hub" and
  "All clear" are drawn as distinct states — only one of them means you're done.

Its harness is `tools/render-todo.swift` (same idea, `+ Shared/Auth.swift` for the intents' network
call, `Controls/RingsView.swift` for the shared palette):

```sh
cd apps
swiftc -O tools/render-todo.swift Controls/TodoView.swift Controls/RingsView.swift \
       Shared/Auth.swift -o /tmp/render-todo && /tmp/render-todo /tmp
```
