# Jared's Life-Hub — Architecture

Central reference for the whole ecosystem (hub UI, voice pipeline, data layer, devices,
hosting). Lives in the `status-hub` repo because that's the most active/central repo, but it
documents **everything**, not just the hub. Keep it current as pieces change.

> For the hub UI's own internals (payload contract, module/card map, domain engine, API + settings
> catalog), see **[docs/HUB-INTERNALS.md](docs/HUB-INTERNALS.md)** — this file is the ecosystem view.

---

## 1. Guiding principles

- **The Mac is the primary hub.** 95% of work happens here; the primary voice worker runs here.
- **Supabase (cloud Postgres) is the single source of truth** for all life data. Everything
  reads/writes Supabase; nothing else is authoritative.
- **One web codebase, many surfaces.** The web hub (desktop / phone / TV) is one codebase, and the
  native iOS/macOS apps are WKWebView shells over it, so every screen shares the same UI. The Home
  Screen widgets are the one exception — they draw natively (§4).
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

**Fly apps (four):**
- `jared-status-hub` — the hub server (web + TV + APIs + SSE + push scheduler). ← `status-hub`
- `jared-voice` — combined: ESP wake-word + Groq transcription **and** the fallback voice worker.
  ← `voice-pipeline/server`
- `litter-robot-watcher` — always-on Litter-Robot watcher (Telegram alerts). ← `litter-robot`
- `nutrition-track` — **suspended**. ← `~/repos/nutrition-track`

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
- **Realtime** is on. The `supabase_realtime` publication includes (at least): `voice_requests`,
  `voice_messages`, `voice_focus`, `voice_sessions`, `device_status`, `nutrition_entries`, `sets`,
  `desk_commands`. The hub server, the voice worker and the Mac orchestrator subscribe.

**Key tables:** `weight_log`, `nutrition_entries`, `nutrition_targets`, `sets`,
`workout_sessions`, `exercises`, `exercise_sets`, `health_profile`, `lists`, `list_items`,
`notes`, `recipes`, `wines`, `surf_snapshots`, plus the system tables below.

There is **no `reminders` table** — a reminder is a `list_items` row with a `due` date, and any item
on any list can carry one (data-layer migrations `00056`/`00057`). Anything still reaching for a
`reminders` table is reading a dropped one.

**System tables (machine plumbing, not life data):**
- `voice_requests` — the voice command queue (enqueue → worker claims → done).
- `voice_messages` — the shared "hub" conversation thread shown on every surface.
- `voice_focus` / `voice_sessions` — what the wall is focused on / session list.
- `worker_presence` — each worker's heartbeat (drives priority arbitration).
- `app_settings` — flat key/value settings (surplus/deficit, `maintenance_phase`, wake-free / inject /
  mute, weight-reminder, agent mode…). Full catalog: [docs/HUB-INTERNALS.md](docs/HUB-INTERNALS.md) §7.
- `litter_events` — the litter-watcher's persisted event stream (cycles, resets, alerts, presence).
- `repos` / `desk_commands` — the Mac's published projects, and the launch queue behind them (§9).
- `desk_sessions` / `desk_queue` / `desk_focus` — live dispatched sessions, work waiting for a slot,
  and the pointer to whichever session a spoken follow-up lands in.
- `reports` — the HTML write-ups a dispatched session publishes (`/report/:id`).
- `govee_devices` — auto-discovered Govee lights (synced from the cloud API).
- `device_tokens` — APNs tokens for push (with per-token `environment`).
- `notifications` — push send-log + per-day dedupe.

Produce tracking rides on nutrition rather than its own table: `nutrition_entries.ingredients` carry
`produce_type` (`leafy`/`vegetable`/`fruit`) + `produce_g`, and the server rolls them into `veg_g` /
`leafy_g` / `fruit_g` (leafy ⊂ veg).

---

## 4. Surfaces (all share the web hub codebase)

- **Web hub** — `status-hub/server/public/` (`core.js`, `cards/*`, `app.css`). Desktop `/page` =
  scrolling rows; phone = swipe panes on `/` (chat · wall · misc · **maint** · **todo** · **repos** ·
  **reports**); all off `/api/stream` (SSE). Served by the Node server.
  (Card/module map: [docs/HUB-INTERNALS.md](docs/HUB-INTERNALS.md).)
- **`/mic`** — a minimal fullscreen tap-to-talk launcher page (Add-to-Home-Screen web-clip); reuses
  the same recorder + pipeline as the in-app voice FAB.
- **TV / kiosk wall** — `/tv` (same dashboard + a live voice-conversation panel). Auth by
  `?token=<TV_TOKEN>`. Near-black always-on display.
- **Native iOS / macOS app** — `status-hub/apps/` (`StatusHub` iOS + `StatusHubMac` +
  `StatusHubControls`), xcodegen-generated (`project.yml`). A WKWebView shell over the web hub that
  seeds the auth cookie from the Keychain password (`Auth.swift`) and adds **push** (`Push.swift`) —
  **plus native voice entry points**: a `statushub://record` URL scheme, a Siri/Spotlight **App
  Shortcut**, and an iOS-18 **Lock Screen / Control Center control** that all open the app straight
  into "listening" (fire the web voice FAB via `RecordLaunch`). More than a thin wrapper — see
  [docs/HUB-INTERNALS.md](docs/HUB-INTERNALS.md) §9.
- **Home Screen widgets** — the only surfaces that are *not* the web hub: native SwiftUI drawing in
  the same `StatusHubControls` extension as the Record control, each fed by its own compact endpoint
  so the hub keeps computing and the widget only renders.
  - **Macro Rings** — today's Cal/P/C/F **pace** rings (plus the health bar on medium), from
    `/api/rings`: a feed of **per-minute future frames**, so the arcs drain and the pace marker
    advances on the Home Screen for an hour per fetch while `lib/pace.js` stays the only place that
    maths lives. Also offered on the Lock Screen (accessory families).
  - **Due** — everything with a due date, across every list, from `/api/due-widget`, and
    **interactive**: tap a row for its two options — open it in the app, or clear it through the same
    `/api/todos/clear` every other surface uses.
  - **Projects** — the Mac's repos from `/api/repos-widget`. Tapping a row and confirming hands the
    path to the app (`statushub://repo/<path>`), which lands on the repos pane and starts dictating
    the session's first message — a widget extension has no microphone of its own.
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
  `entrypoint.sh`. Always-on 1GB machine. Wake word: **`hey_rhasspy`**.
- `worker/` — the **Mac worker** (`worker.py` via `run.sh`, launchd `com.jaredgantt.voice-worker`,
  `WORKER_ID=mac`). The primary processor.
- `mac-listener/` — Mac-mic openWakeWord listener (`listener.py`, launchd
  `com.jaredgantt.voice-mac-listener`). Needs a mic grant to do anything, so check it is actually
  running (`launchctl list | grep voice-mac-listener`) before concluding the Mac mic is dead.
- `orchestrator/` — Mac service (launchd `com.jaredgantt.voice-orchestrator`, `localhost:7682`).
  Injects a transcript into a focused Mac session's live `claude --resume` pty (for non-"hub"
  focus). This is the **warm-subscription-via-terminal** path. It also runs **desk control** (§9):
  publishing `~/repos` and opening terminals when the hub asks.
- `pi-desk/` — the Pi's desk-command consumer (systemd, tmux sessions). The half of the repo picker
  that still works when the Mac is off; §9.
- `mcp-voice/` — the voice-control MCP (`set_focus` / `list_sessions`) so voice can switch what
  the wall shows.
- `voice-id/` — on-device speaker verification (ECAPA-TDNN) and the wake-free capture it gates.
- `mac-synth/` — a warm Kokoro TTS server on the Mac (launchd `com.jaredgantt.mac-synth`); the
  worker POSTs reply text and gets PCM back far faster than the Pi's CPU ONNX Kokoro.
- `pi-audio/` — the Pi service that plays the spoken reply out of the TV via PipeWire.
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
- **Sandbox vs production:** dev (Xcode) builds → sandbox tokens; Ad Hoc / TestFlight / App Store
  builds → production tokens. The per-token `environment` lets both coexist.
- **This is the trap when building the app anywhere other than CI.** The laptop's keychain holds
  only an *Apple Development* identity, so a build made there must declare
  `aps-environment=development` and registers a **sandbox** token — which the hub, sending to the
  production gateway, cannot deliver to (`BadDeviceToken`). The distribution certificate that keeps
  `aps-environment=production` exists only in the `status-hub` repo's GitHub secrets, so any build
  meant to receive real notifications has to be archived by `ios-adhoc.yml` or `ios-testflight.yml`.

---

## 8. External services

- **Fly.io** — hosting (3 apps above). CLI `fly`, authed as jaredgantt@gmail.com.
- **Supabase** — Postgres + realtime (source of truth).
- **Groq** — `whisper-large-v3-turbo` STT (key is a Fly secret on `jared-voice`).
- **Anthropic** — Claude subscription (`claude -p`) + Agent SDK (API credit) for the workers.
- **Apple** — APNs (push) + App Store Connect (ASC key on disk; Issuer ID not yet recorded).
- **Telegram** — `@jaredpi_bot` for ad-hoc messages (used by the litter-robot watcher).

---

## 9. Desk control — launching sessions from the phone

The hub's repo picker (and the Projects widget) starts a Claude session from anywhere: tap a project
→ a session opens there running `claude --remote-control <name>` → it waits in the Claude app, which
is where the work actually happens. The hub only *starts* it.

**Two consumers, one queue.** The Mac's orchestrator opens a Terminal tab; the Pi's `pi-desk` runs
the same job in tmux, so a session survives the laptop closing. A command goes to the Pi when the hub
targets it explicitly, or when it has no target and the Mac's presence is stale — the staleness check
is what makes the Pi a fallback rather than a race for untargeted work. The Pi clones from GitHub and
pulls before every session, because it has no local checkout to be authoritative.

**Every directory under `~/repos` is listed, not just git checkouts.** Filtering on `.git` hid the
most active work on the Mac, which can be a working directory that is deliberately not a
repo. Git is decoration: branch + dirty when present, and `last_active` is the
HEAD commit date for a repo, the directory's mtime otherwise.

The hub server is on Fly, so it can neither see the Mac's disk nor reach it over the LAN. Supabase
is the bus; the daemon on each machine owns everything local:

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
  open a session in. Projects that were loose in `~` (`health`, `mcp-session`)
  and `CapitalGrilleApp` (a repo nested inside the `~/workspace` scratch drawer) were consolidated
  into `~/repos` so the picker can see them — a project outside a repo root is invisible to it.

---

## 10. Known cruft / open items

- ⚠️ `voice-pipeline/fly-worker/` is a dead orphan — no `fly.toml`, no `Dockerfile`, nothing deploys
  it. The real Fly worker is `voice-pipeline/server/`. Delete it rather than reading it.
- 🔜 **TestFlight migration** (longevity — an Ad Hoc profile expires after a year and the app then
  refuses to launch). Push works today on an Ad Hoc production build, which `ios-adhoc.yml` produces;
  see §11. The remaining blocker is **Jared creating the App Store Connect app record**, which the
  ASC API cannot do; after that the upload finishes from here. The App-Store `.ipa` and the
  production entitlement are already prepared.

---

## 11. Getting a build onto the phone

**From the Mac, build locally — do not dispatch Actions for this.** The Mac has Xcode, an Apple
Development identity, and the phone paired over Wi-Fi, so the round trip is about ninety seconds:

    cd ~/repos/status-hub/apps && xcodegen generate
    xcodebuild -project StatusHub.xcodeproj -scheme StatusHub -configuration Debug \
      -destination 'generic/platform=iOS' -derivedDataPath /tmp/sh-devbuild \
      -allowProvisioningUpdates \
      -authenticationKeyPath ~/.appstoreconnect/private_keys/AuthKey_P8Y337A8RC.p8 \
      -authenticationKeyID P8Y337A8RC \
      -authenticationKeyIssuerID 141a8ead-b829-4e58-b9ff-b8c95f8c4ed9 \
      DEVELOPMENT_TEAM=XMH4AVFC78 CODE_SIGN_STYLE=Automatic build
    xcrun devicectl device install app --device "Jared's iPhone" \
      /tmp/sh-devbuild/Build/Products/Debug-iphoneos/StatusHub.app

The catch is not expiry — the team development profile is good for a year (the one on the phone runs
to 2027-06-22). It is that a build signed here carries `aps-environment: development` and so
registers a **sandbox** APNs token, which the hub's production sends cannot reach. Local builds are
for iterating on UI; a build that must receive push has to be archived by the workflows below.

**Everything below is the route for when the Mac is unreachable**, where a macOS runner is the only
machine that can compile. It bills at 10x, so dispatch it deliberately.

There is no way to *push* an iOS app to an iPhone. Apple has no remote-install channel for a normal
(non-MDM, non-supervised) device, so every route ends either in a tap on the phone or in a machine
that the phone is already paired with. What follows is the route that needs neither TestFlight nor
any public hosting.

1. **`ios-devices.yml`** (Linux, 1x, effectively free) — lists the UDIDs registered with Apple, and
   registers new ones. Run it *first*. An Ad Hoc `.ipa` bakes the device list into its embedded
   profile at signing time, so a phone registered afterwards cannot install a build made before, and
   the failure shows up on the device as a bare "Unable to Install".
2. **`ios-adhoc.yml`** (macOS, 10x — deliberate dispatch only) — archives, exports with method
   `release-testing`, and prints what the resulting profile is actually signed for. Comes back as
   the `statushub-adhoc-<run>` artifact.
3. **Install it from the laptop.** The phone is paired to the laptop over Wi-Fi, so this needs no
   cable and no interaction on the phone at all:

       gh run download <run-id> -R JJGantt/status-hub -n statushub-adhoc-<run> -D ipa
       scp ipa/export/StatusHub.ipa jaredgantt@Jareds-MacBook-Air.local:/tmp/
       ssh jaredgantt@Jareds-MacBook-Air.local \
         'xcrun devicectl device install app --device "Jared’s iPhone" /tmp/StatusHub.ipa'

   `xcrun devicectl list devices` shows whether the phone is reachable — `available (paired)` means
   this will work; if it is offline, wait or wake it.

The fallback, if the laptop is asleep, is an `itms-services://` OTA link — but that needs the `.ipa`
and a manifest on HTTPS that iOS's `installd` can fetch **without cookies** (it does not share
Safari's session), which the hub's auth gate would have to be opened up for. The pairing route
avoids all of that, so prefer it.
