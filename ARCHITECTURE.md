# Jared's Life-Hub — Architecture

Central reference for the whole ecosystem (hub UI, voice pipeline, data layer, devices,
hosting). Lives in the `status-hub` repo because that's the most active/central repo, but it
documents **everything**, not just the hub. Keep it current as pieces change.

> Verified state as of 2026-06-22. Lines marked **(verify)** are inferred and worth re-checking.

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

**Fly apps (the only three):**
- `jared-status-hub` — the hub server (web + TV + APIs + SSE + push scheduler).
- `jared-voice` — combined: ESP wake-word + Groq transcription **and** the fallback voice worker.
- `litter-robot-watcher` — always-on Litter-Robot watcher (Telegram alerts).

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
- `app_settings` — flat key/value settings (routing mode, trailing-silence, weight-reminder…).
- `govee_devices` — auto-discovered Govee lights (synced from the cloud API).
- `device_tokens` — APNs tokens for push (with per-token `environment`).
- `notifications` — push send-log + per-day dedupe.

---

## 4. Surfaces (all share the web hub codebase)

- **Web hub** — `status-hub/server/public/` (`core.js`, `cards/*`, `app.css`). Desktop = scrolling
  rows; phone = swipe pages; both off `/api/stream` (SSE). Served by the Node server at `/`.
- **TV / kiosk wall** — `/tv` (same dashboard + a live voice-conversation panel). Auth by
  `?token=<TV_TOKEN>`. Near-black always-on display.
- **Native iOS / macOS app** — `status-hub/apps/` (`StatusHub` iOS + `StatusHubMac`),
  xcodegen-generated (`project.yml`). A thin WKWebView wrapper of the web hub; seeds the auth
  cookie from the Keychain password (`Auth.swift`). iOS adds **push** (`Push.swift`).
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
  focus). This is the **warm-subscription-via-terminal** path.
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

| Worker | `WORKER_ID` | Where | Priority | Routing | Status |
|---|---|---|---|---|---|
| **Mac** | `mac` | launchd on the Mac | highest (`mac,pi`) | `subscription` (default) or `sdk` | ✅ live, primary |
| **Pi** | `pi` | systemd `voice-worker.service` | middle (`mac,pi,fly`) | `subscription` (default) or `sdk` | ✅ live, fallback |
| **Fly** | `fly` | inside `jared-voice` | lowest (`mac,pi,fly`) | forced `sdk` (API only) | ✅ live, fallback |

- **Claiming latency:** workers used to poll every 1s. Now a **Supabase realtime listener**
  (`RealtimeWaker` in `worker.py`, added 2026-06-22) wakes the loop the instant a `voice_requests`
  row is INSERTed; the 1s poll remains as a fallback if the socket drops.
- **`routing_mode`** (`app_settings`): `subscription` = cold `claude -p` on your Claude
  subscription (free); `sdk` = a warm `ClaudeSDKClient` (MCPs stay connected) on Anthropic API /
  Agent-SDK credit. Fly is always `sdk` (no subscription login); the Mac can opt into `sdk` for a
  warm fast lane.
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

## 9. Known cruft / open items

- ⚠️ Delete `voice-pipeline/fly-worker/` — dead orphan that misleads (the real Fly worker is
  `voice-pipeline/server/`).
- ✅ Pi worker is live (`voice-worker.service`, 2026-06-22) — middle-priority fallback, both
  routing modes. (`mac-listener` plist on the Mac is still the one `(verify)` item below.)
- 🔜 TestFlight/production build for the iOS app (longevity; dev builds expire in 7 days).
- **(verify)** `mac-listener` launchd state (mic permission).
- Wake word README says `hey_jarvis`; deployed value is `hey_rhasspy`.
