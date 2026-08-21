# Status Hub — Internals

How the hub UI is actually built: the data flow, the payload contract, the module map, the domain
engine, and the full API + settings surface. Read `ARCHITECTURE.md` first for the ecosystem view;
this is the map for working *inside* `status-hub` itself.

> Freshness: 2026-08-20. The individual code files carry detailed header comments — this doc is the
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

`todos` (reminders/lists/notes) is **not** in this payload — the todo card self-fetches `/api/todos`
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

**Cards (`public/cards/`)** — each exports `render(s)` and paints from its `s.*` slice:

`nutrition` (Cal/P/C/F pace rings + produce sub-rings) · `nutritionlog` (calorie+weight plot +
adherence calendar) · `maintviz` (4th phone swipe pane — the maintenance-window viz) · `todo` (5th
pane — reminders/lists/notes, self-fetches) · `muscle` (body map + volume gauges) · `workouts`
(heatmap + day detail) · `litter` · `feeder` · `surf` · `routing` (TV top strip) · `score` (TV right
column) · `mics` (page voice-liveness strip).

**Surfaces (same code, different chrome):** desktop `/page` = scrolling rows; phone = swipe panes on
`/` (chat · wall · misc · maint · todo); TV `/tv` = the wall + a voice panel (auth `?token=`); the
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
`/api/todos` · `/api/attachment`.

**Write:** `/api/settings` (GET/POST) · `/api/log-set` · `/api/log-entry` (POST/DELETE) ·
`/api/commit-staged` · `/api/feed` · `/api/todos/{add,complete}` · `/api/voice-command` (raw audio →
Groq Whisper → enqueue) · `/api/voice-text` (text → enqueue) · `/api/voice-reset` ·
`/api/voice-activity` · `/api/attach` (photo upload) · `/api/register-push` · `/api/notify` (APNs to
all devices) · `/api/clientlog`.

**Auth:** the hub password → `sha256("status-hub:"+password)`; sent as the `hub` cookie (web) or the
`X-Hub-Token` header (native app). The kiosk authenticates via `?token=<TV_TOKEN>` (also seeds the
cookie). Everything under the gate requires one of these; `/healthz` and `/login` are public.

---

## 6. Reminders / lists / notes

Voice/MCP writes them (data-layer tools); the hub surfaces them:
- **Card:** `public/cards/todo.js` — the 5th phone swipe pane. Self-fetches `/api/todos` (not part of
  the status stream), refreshes on mount / after edits / on focus.
- **Endpoints:** `GET /api/todos` (reminders + lists+items + notes) · `POST /api/todos/complete` ·
  `POST /api/todos/add` (service-key writes; list add auto-creates the list).
- **Reminder firing:** a 60s tick app-pushes any reminder whose local `due` has passed, deduped via a
  `notifications` row keyed `reminder:<id>` (date-only dues fire 9am). Shares `pushAll()` with
  `/api/notify`.

---

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

XcodeGen (`project.yml`) → `StatusHub` (iOS) + `StatusHubMac` + `StatusHubControls` (iOS-18 control
extension). More than a thin wrapper now:

- **`HubWebView`** (StatusHubApp.swift): WKWebView over `Auth.host`, seeds the `hub` cookie from the
  Keychain password; grants webview media capture; bridges JS dialogs to native alerts.
- **Voice entry points** (all land straight in "listening"): `statushub://record` URL scheme →
  `onOpenURL` → `RecordLaunch` fires the web voice FAB (`window.__startVoiceCommand`); `HubVoiceIntent`
  (Shared/, `openAppWhenRun`) drives it from a **Siri/Spotlight App Shortcut** (RecordIntent.swift) and
  the **Lock Screen / Control Center control** (Controls/RecordControl.swift). `HUB_APP` compile flag
  guards the app-only `RecordLaunch` call so the extension links without WebKit.
- **Build/install:** see the root `README.md` (xcodegen → xcodebuild → `devicectl device install`).
