# Jared's Life-Hub — Architecture

Central reference for the whole ecosystem (hub UI, voice pipeline, data layer, devices,
hosting). Lives in the `status-hub` repo because that's the most active/central repo, but it
documents **everything**, not just the hub. Keep it current as pieces change.

> Verified state as of 2026-08-24. Lines marked **(verify)** are inferred and worth re-checking.
> For the hub UI's own internals (payload contract, module/card map, domain engine, API + settings
> catalog), see **[docs/HUB-INTERNALS.md](docs/HUB-INTERNALS.md)** — this file is the ecosystem view.

---

## 1. Guiding principles

- **The Mac is the primary hub.** 95% of work happens here; the primary voice worker runs here.
- **Supabase (cloud Postgres) is the single source of truth** for all life data. Everything
  reads/writes Supabase; nothing else is authoritative.
- **One web codebase, many surfaces.** The web hub (desktop / phone / TV) is one codebase; the
  native iOS/macOS apps are thin WKWebView wrappers of it, so every screen shares the same UI.
- **The Pi is an active service host.** It runs the voice worker as a middle-priority fallback
  (between Mac and Fly) and can host other services. Supabase remains the *data* source of truth,
  but that's about storage, not about what runs on the Pi.

---

## 2. Repos & hosting at a glance

| Repo | GitHub | What it is | Deployed as |
|---|---|---|---|
| `status-hub` | JJGantt/status-hub | Hub web UI + Node server + native app wrappers | Fly `jared-status-hub` |
| `voice-pipeline` | (private) | ESP wake-word → transcription → worker → Supabase | Fly `jared-voice` (+ Mac launchd) |
| `data-layer` | JJGantt/data-layer | Supabase schema (migrations) + the `data` MCP | Supabase `felyggqjjhltwokdfhop` |
| `govee-mcp` | JJGantt/mcp-govee | Govee light control MCP (LAN + cloud) | runs inside workers |
| `litter-robot` | JJGantt/litter-robot | Litter-Robot 4 auto-resume watcher | Fly `litter-robot-watcher` |

**Fly apps (four; verified 2026-08-23):**
- `jared-status-hub` — the hub server (web + TV + APIs + SSE + push scheduler). ← `status-hub`
- `jared-voice` — combined: ESP wake-word + Groq transcription **and** the fallback voice worker.
  ← `voice-pipeline/server`
- `litter-robot-watcher` — always-on Litter-Robot watcher (Telegram alerts). ← `litter-robot`
- `nutrition-track` — **suspended** since 2026-07-19. ← `~/repos/nutrition-track`

Every Fly-deployed app is built from a repo in `~/repos` on the Mac, so all four are reachable from
the hub's picker.

**There are TWO Supabase projects, not one** — a distinction the CLI hides, because it only ever
talks to the linked one:

| Project | Ref | Used by | Edge functions |
|---|---|---|---|
| `life-data` | `felyggqjjhltwokdfhop` | everything in this doc | none |
| `GolfTracker` | `oumnicnvayqrbfbljgyl` | `GolfTracker*` repos | `golfcourse-search`, `resolve-hole-heights` |

Both edge functions' sources live in `GolfTracker-SwingDetection/supabase/functions/` and are
committed + pushed; the deployed copies match (they only differ by Supabase's deploy-time TypeScript
stripping). Nothing runs in Supabase that isn't in a repo. Checking one project and reporting it as
"Supabase" is the easy mistake here — `supabase functions list` silently scopes to whichever project
the working directory is linked to.

---

## 3. Data layer — Supabase (source of truth)

- Project `felyggqjjhltwokdfhop` ("life-data"). Service-role key in `data-layer/src/client.ts`.
- The **`data` MCP** (`data-layer/dist/mcp.js`) is how Claude reads/writes life data.
- **Realtime** is on. The `supabase_realtime` publication includes (at least):
  `voice_requests` (added 2026-06-22), `voice_messages`, `voice_focus`, `voice_sessions`,
  `device_status`, `nutrition_entries`, `sets`. The hub server and the voice worker subscribe.

**Key tables:** `weight_log`, `nutrition_entries`, `nutrition_targets`, `sets`,
`workout_sessions`, `exercises`, `exercise_sets`, `health_profile`, `lists`, `list_items`,
`reminders`, `notes`, `recipes`, `wines`, `surf_snapshots`, plus the system tables below.

**System tables (machine plumbing, not life data):**
- `voice_requests` — the voice command queue (enqueue → worker claims → done).
- `voice_messages` — the shared "hub" conversation thread shown on every surface.
- `voice_focus` / `voice_sessions` — what the wall is focused on / session list.
- `worker_presence` — each worker's heartbeat (drives priority arbitration).
- `app_settings` — flat key/value settings (surplus/deficit, `maintenance_phase`, wake-free / inject /
  mute, weight-reminder, agent mode…). Full catalog: [docs/HUB-INTERNALS.md](docs/HUB-INTERNALS.md) §7.
- `litter_events` — the litter-watcher's persisted event stream (cycles, resets, alerts, presence).
- Produce tracking: `nutrition_entries.ingredients` carry `produce_type` (`leafy`/`vegetable`/`fruit`)
  + `produce_g`; the server rolls them into `veg_g` / `leafy_g` / `fruit_g` (leafy ⊂ veg). Reminders /
  lists / notes now have both MCP tools **and** a hub surface (`/api/todos` + the todo pane).
- `govee_devices` — auto-discovered Govee lights (synced from the cloud API).
- `device_tokens` — APNs tokens for push (with per-token `environment`).
- `notifications` — push send-log + per-day dedupe.

---

## 4. Surfaces (all share the web hub codebase)

- **Web hub** — `status-hub/server/public/` (`core.js`, `cards/*`, `app.css`). Desktop `/page` =
  scrolling rows; phone = swipe panes on `/` (chat · wall · misc · **maint** · **todo** · **repos**); all off
  `/api/stream` (SSE). Served by the Node server. (Card/module map: [docs/HUB-INTERNALS.md](docs/HUB-INTERNALS.md).)
- **`/mic`** — a minimal fullscreen tap-to-talk launcher page (Add-to-Home-Screen web-clip); reuses
  the same recorder + pipeline as the in-app voice FAB.
- **TV / kiosk wall** — `/tv` (same dashboard + a live voice-conversation panel). Auth by
  `?token=<TV_TOKEN>`. Near-black always-on display.
- **Native iOS / macOS app** — `status-hub/apps/` (`StatusHub` iOS + `StatusHubMac` +
  `StatusHubControls`), xcodegen-generated (`project.yml`). A WKWebView shell over the web hub that
  seeds the auth cookie from the Keychain password (`Auth.swift`) and adds **push** (`Push.swift`) —
  **plus native voice entry points**: a `statushub://record` URL scheme, a Siri/Spotlight **App
  Shortcut**, and an iOS-18 **Lock Screen / Control Center control** that all open the app straight
  into "listening" (fire the web voice FAB via `RecordLaunch`). No longer just a thin wrapper — see
  [docs/HUB-INTERNALS.md](docs/HUB-INTERNALS.md) §9.
- **Home Screen widgets** — the only surfaces that are *not* the web hub: native SwiftUI drawing in
  the same `StatusHubControls` extension as the Record control, each fed by its own compact endpoint
  so the hub keeps computing and the widget only renders.
  - **Macro Rings** — today's Cal/P/C/F **pace** rings (plus the health bar on medium), from
    `/api/rings`: a feed of **per-minute future frames**, so the arcs drain and the pace marker
    advances on the Home Screen for an hour per fetch while `lib/pace.js` stays the only place that
    maths lives. Also offered on the Lock Screen (accessory families).
  - **To-do** — the `todo` list's item titles from `/api/list-widget`, and **interactive**: tap a row
    to arm it, tap the ✕ to clear it through the same `/api/todos/clear` every other surface uses.
  - See [docs/HUB-INTERNALS.md](docs/HUB-INTERNALS.md) §9b.
- **ESP32** — the voice mic (see §5).
- **iPhone push** — native APNs notifications (see §7).

---

## 5. Voice pipeline (`voice-pipeline/`)

End-to-end flow:

```
  ESP32 mic ──wss──▶ jared-voice (Fly)              Supabase                Mac/Fly worker
  (or Mac mic,        ├ openWakeWord ("Hey Rhasspy")  voice_requests  ◀──┐    claims request
   or web mic FAB)    ├ capture utterance             (the queue)        │    ├ claude -p (subscription)
                      └ Groq whisper-large-v3-turbo ──▶ INSERT ──────────┘    │  or warm Agent SDK
                                                                              ├ runs MCP tools (data/voice/govee)
   hub UI ◀── SSE ◀── status-hub ◀── voice_messages ◀───────────────────────┘  writes the reply
```

**Directories:**
- `server/` — **Fly app `jared-voice`**. The wake-word + Groq transcription server (`server.py`)
  AND the fallback worker (`worker.py`) AND the Govee MCP + `sync_devices`, all started by
  `entrypoint.sh`. Always-on 1GB machine. Wake word deployed = **`hey_rhasspy`** (the README's
  `hey_jarvis` default is stale).
- `worker/` — the **Mac worker** (`worker.py` via `run.sh`, launchd `com.jaredgantt.voice-worker`,
  `WORKER_ID=mac`). The primary processor.
- `mac-listener/` — Mac-mic openWakeWord listener (`listener.py`, plist
  `com.jaredgantt.voice-mac-listener`). **(verify)** Not necessarily loaded — needs mic grant.
- `orchestrator/` — Mac service (launchd `com.jaredgantt.voice-orchestrator`, `localhost:7682`).
  Injects a transcript into a focused Mac session's live `claude --resume` pty (for non-"hub"
  focus). This is the **warm-subscription-via-terminal** path. It also runs **desk control** (§9):
  publishing `~/repos` and opening terminals when the hub asks.
- `mcp-voice/` — the voice-control MCP (`set_focus` / `list_sessions`) so voice can switch what
  the wall shows.
- `firmware/` — ESP32 (PlatformIO). A dumb PCM pump: streams the I2S mic, no on-device logic.
- `fly-worker/` — ⚠️ **DEAD ORPHAN.** A stale staging copy (no `fly.toml`/`Dockerfile`, not
  deployable, nothing pushes it). The real Fly worker is in `server/`. **Should be deleted.**

**Request sources** (the `source` field on `voice_requests`): `fly` (ESP), `mac` (Mac listener),
`web-quick` (hub mic FAB), typed web text.

---

## 6. Workers & priority arbitration

Multiple machines run the **same** `worker.py`; only one processes each request. Each worker
heartbeats into `worker_presence`; a worker only claims a request if **no higher-priority worker
has a fresh heartbeat** (`HEARTBEAT_FRESH_S`).

| Worker | `WORKER_ID` | Where | Priority | Runner | Status |
|---|---|---|---|---|---|
| **Mac** | `mac` | launchd on the Mac | highest (`mac,pi`) | `claude -p` (subscription) | ✅ live, primary |
| **Pi** | `pi` | systemd `voice-worker.service` | middle (`mac,pi,fly`) | `claude -p` (subscription) | ✅ live, fallback |
| **Fly** | `fly` | inside `jared-voice` | lowest (`mac,pi,fly`) | Anthropic API (no subscription login) | ✅ live, fallback |

- **Claiming latency:** a **Supabase realtime listener** (`RealtimeWaker` in `worker.py`) wakes the
  loop the instant a `voice_requests` row is INSERTed; a short poll (`IDLE_POLL_S`, ~15s) is the
  backstop, and the claim socket is recycled every ~5 min to beat realtime half-open death.
- **Model routing — single dynamic route (2026-08 overhaul):** the old two-route / "brain" button /
  custom model+thinking+runner selection is **gone**. Every hub command runs **Sonnet first** (a fast
  first-responder given only SAFE read/actuator tools via `--allowedTools`; the gated data-WRITE tools
  are absent, so in `-p` mode it's *denied* them and physically can't corrupt data). If the turn needs
  a gated write — it emits `__ESCALATE__`, or attempts a gated tool and is denied — it re-runs on a
  **fresh Opus** with the full toolset. Hub turns use **fresh runs with the recent conversation
  replayed** from `voice_messages` (no shared `--resume` session — that caused model/schema
  cross-contamination); only full-agent (coding) mode keeps a `--resume` CLI session. The `tier` field
  and the `set_model`/`set_thinking`/`set_runner` voice tools were removed with this.
- **Subscription vs API key:** `claude -p` (subscription) must NOT have `ANTHROPIC_API_KEY` in its
  environment or the CLI silently bills the API instead — so `run_claude` strips it for that
  subprocess; the SDK path keeps it. (The service env carries the key so `sdk` mode works.)
- **The Pi:** runs `worker.py` via systemd `voice-worker.service` (env in `~/.voice-worker.env`),
  code cloned at `~/repos/voice-pipeline`, venv at `worker/.venv`. `git pull` + `sudo systemctl
  restart voice-worker` to update. Heartbeats as the middle-priority fallback; claims when the Mac
  is down.

---

## 7. Push notifications (native iOS, APNs) — added 2026-06-22

- **iOS app** (`apps/Sources/Push.swift`): requests permission, registers for remote
  notifications, and uploads the APNs device token via a **same-origin fetch inside the
  authenticated WebView** (so it rides the hub login). Reports its `environment`
  (Debug→`sandbox`, Release→`production`).
- **Server** (`status-hub/server`): `POST /api/register-push` upserts `device_tokens`;
  `lib/apns.js` is a dependency-free APNs sender (HTTP/2 + ES256 `.p8` JWT) that targets the
  sandbox or production gateway **per token's environment**; `lib/weightReminder.js` is an
  in-process scheduler.
- **Weight reminder** (first use case): once/day at the configured time (Settings → Weight
  reminder: On/Off, Manual/Dynamic, default Manual 08:00). **Skips** if weight *or* food is
  already logged that day. Deduped via `notifications` (survives restarts).
- **Reminder firing** (2026-08): a 60s tick also app-pushes any user reminder whose local `due` has
  passed (deduped via a `notifications` row keyed `reminder:<id>`; date-only dues fire 9am). Shares the
  `pushAll()` fan-out with `/api/notify`.
- **APNs key** lives in Fly secrets on `jared-status-hub` (`APNS_KEY_ID`, `APNS_KEY_P8`,
  `APNS_ENV`) — **not** in Supabase. Key file stashed at `~/.appstoreconnect/private_keys/`.
- **Sandbox vs production:** dev (Xcode) builds → sandbox tokens; TestFlight/App Store builds →
  production tokens. The per-token `environment` lets both coexist. **(TODO: TestFlight build —
  needs paid Developer Program + ASC Issuer ID.)**

---

## 8. External services

- **Fly.io** — hosting (3 apps above). CLI `fly`, authed as jaredgantt@gmail.com.
- **Supabase** — Postgres + realtime (source of truth).
- **Groq** — `whisper-large-v3-turbo` STT (key is a Fly secret on `jared-voice`).
- **Anthropic** — Claude subscription (`claude -p`) + Agent SDK (API credit) for the workers.
- **Apple** — APNs (push) + App Store Connect (ASC key on disk; Issuer ID not yet recorded).
- **Telegram** — `@jaredpi_bot` for ad-hoc messages (used by the litter-robot watcher).

---

## 9. Desk control — launching Mac sessions from the phone

The hub's repo picker (6th phone pane) starts a Claude session on the Mac from anywhere: tap a
project → a Terminal opens there running `claude --remote-control <name>` → the session is waiting
in the Claude app, which is where the work actually happens. The hub only *starts* it.

**Every directory under `~/repos` is listed, not just git checkouts.** Filtering on `.git` hid the
most active work on the Mac, which can be a working directory that is deliberately not a
repo. Git is decoration: branch + dirty when present, and `last_active` is the
HEAD commit date for a repo, the directory's mtime otherwise.

The hub server is on Fly, so it can neither see the Mac's disk nor reach it over the LAN. Supabase
is the bus; the Mac's orchestrator daemon owns everything local:

```
  orchestrator ──scan ~/repos (60s, change-gated)──▶ repos ──▶ hub lists them
  hub tap ──INSERT──▶ desk_commands ──realtime──▶ orchestrator ──▶ Terminal + claude --remote-control
  orchestrator ──beat (30s)──▶ worker_presence('desk') ──▶ hub greys the list out when the Mac sleeps
```

- **Tables:** `repos` (path PK, branch, dirty, HEAD date) · `desk_commands` (pending → running →
  done | error | expired). Presence reuses `worker_presence` under `worker='desk'`.
- **Two guards on the launch path:** the target must be a repo the orchestrator itself published (so
  a crafted or stale row can't `cd` anywhere else on disk), and commands older than `COMMAND_TTL_S`
  (120s) expire unrun — a Mac waking from sleep must not open every terminal queued while it was out.
- **Terminal has no scriptable "new tab"** — only a Cmd-T keystroke via System Events, which needs
  Accessibility permission a launchd daemon may not hold ("not allowed to send keystrokes (1002)").
  Both launch paths fall back to a plain `do script` new window, which needs only Automation.
- **The workspace-trust prompt has to be pre-accepted** (`orchestrator/src/trust.js`), or the session
  opens onto "Do you trust the files in this folder?" and waits for a click nobody is there to make —
  the hub reports success while the session is stuck. Trust is keyed by absolute path in
  `~/.claude.json`, so it is per-directory (only 3 of 26 were trusted) and **moving a repo resets
  it**. No CLI flag exists (`-p` skips the dialog only by being non-interactive), so the daemon
  writes the same state the dialog writes, immediately before launching. Every live Claude session
  writes that file too, hence the mtime re-check + atomic rename.
- **Scope:** `REPO_ROOTS` defaults to `~/repos` only. What lives loose in `~` (`.hammerspoon`,
  `voice`, `whisper.cpp`) is deliberately out — runtime assets and vendor checkouts, not things you
  open a session in. Projects that were loose in `~` (`health`, `mcp-session`, `data-layer-proxy`)
  and `CapitalGrilleApp` (a repo nested inside the `~/workspace` scratch drawer) were consolidated
  into `~/repos` on 2026-08-23 so the picker can see them.

---

## 10. Known cruft / open items

- ⚠️ Delete `voice-pipeline/fly-worker/` — dead orphan that misleads (the real Fly worker is
  `voice-pipeline/server/`).
- ✅ Pi worker is live (`voice-worker.service`, 2026-06-22) — middle-priority fallback, both
  routing modes. (`mac-listener` plist on the Mac is still the one `(verify)` item below.)
- 🔜 **TestFlight migration** (longevity). Push works *now* on an Ad Hoc production build (~1yr).
  The only blocker to permanent TestFlight is **Jared creating the App Store Connect app record**
  (the ASC API can't create apps); after that Claude uploads + finishes. The App-Store `.ipa` and the
  production entitlement are already prepared.
- **(verify)** `mac-listener` launchd state (mic permission).
- Wake word README says `hey_jarvis`; deployed value is `hey_rhasspy`.
