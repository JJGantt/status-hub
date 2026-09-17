# Jared's Life-Hub — Architecture

Central reference for the whole ecosystem (hub UI, voice pipeline, data layer, devices,
hosting). Lives in the `status-hub` repo because that's the most active/central repo, but it
documents **everything**, not just the hub. Keep it current as pieces change.

> For the hub UI's own internals (payload contract, module/card map, domain engine, API + settings
> catalog), see **[docs/HUB-INTERNALS.md](docs/HUB-INTERNALS.md)** — this file is the ecosystem view.

---

## 1. Guiding principles

- **The Mac is the primary hub.** 95% of work happens here. The voice *worker* is the exception —
  the Pi claims first, so voice-started work outlives the laptop closing (§6).
- **Supabase (cloud Postgres) is the single source of truth** for all life data. Everything
  reads/writes Supabase; nothing else is authoritative.
- **One web codebase, many surfaces.** The web hub (desktop / phone / TV) is one codebase, and the
  native iOS/macOS apps are WKWebView shells over it, so every screen shares the same UI. The Home
  Screen widgets and the watch app are the exceptions — they draw natively (§4).
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
| `messages-mcp` | JJGantt/messages-mcp | iMessage/SMS read + send MCP | Mac only (stdio, plus HTTP :27187 for the Pi) |
| `gmail-mcp` | JJGantt/gmail-mcp | Gmail read/label/draft/send MCP | anywhere (stdio) |
| `litter-robot` | JJGantt/litter-robot | Litter-Robot 4 auto-resume watcher | Fly `litter-robot-watcher` |

**Fly apps (four):**
- `jared-status-hub` — the hub server (web + TV + APIs + SSE + push scheduler). ← `status-hub`
- `jared-voice` — combined: ESP wake-word + Groq transcription **and** the fallback voice worker.
  ← `voice-pipeline/server`
- `litter-robot-watcher` — always-on Litter-Robot watcher (alerts via the hub's app push). ← `litter-robot`
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

## 2b. Messaging — email and iMessage

Two MCP servers, split because their availability differs and nothing can change that.

**`messages-mcp` is Mac-only and always will be.** Reading is a read-only SQLite open of
`~/Library/Messages/chat.db`; sending is AppleScript to Messages.app. Neither exists on the Pi or
on Fly, so anything touching iMessage needs this Mac awake and signed in. Two traps live in that
database and the server exists mostly to absorb them: `message.text` is NULL on about a third of
rows with the real content in `attributedBody` (an NSAttributedString typedstream, decoded through
Apple's own `NSUnarchiver`), and senders are raw phone numbers rather than names.

Contact names merge the Mac's local AddressBook **and** Google Contacts via the People API,
because neither is complete — measured here, 16 of 27 local handles were absent from Google and
183 Google handles were absent locally. It reads the refresh token from `gmail-mcp/.env` rather
than storing a second copy; missing credentials degrade to local-only.

Sending to a **group** requires `chat_id`, not a handle — a group has no single participant to
address, so it is reached by conversation guid.

**Files** are sent from paths on the Mac, whoever the caller is; a Pi session sends one of its own
files by uploading it first with `messages-mcp/bin/upload`, which prints the Mac path. Each file
lands in Messages' own Attachments folder before it is sent, because a file Messages cannot read is
not refused: it arrives as an empty bubble marked delivered. That copy is the attachment from then
on and is never cleaned up.

**`gmail-mcp` has no machine dependency.** It is HTTPS against the Gmail API with a stored refresh
token, so it runs on the Mac, the Pi or Fly identically and works while all of them are asleep.
Scopes are `gmail.modify` (read/label/draft/**send** — Google's own description) and
`contacts.readonly`. `mail.google.com` and `gmail.settings.*` are deliberately not requested, so
nothing here can delete mail past the trash or change filters, forwarding or send-as.

The OAuth app lives in Google Cloud project `status-hub-507320` and is published **in production,
unverified**. That is not cosmetic: an external app left in *Testing* is issued refresh tokens
Google revokes after 7 days. Production requires a homepage, privacy policy and terms on a
Search-Console-verified domain, which is why the hub serves `/privacy`, `/terms` and the
verification file publicly — `fly.dev` is on the Public Suffix List, so `jared-status-hub.fly.dev`
counts as a registrable domain and no domain purchase was needed.

Neither server watches for anything. They are on-demand tools; nothing reacts to a message or a
mail arriving, and nothing is mirrored off the Mac.

---

## 3. Data layer — Supabase (source of truth)

- Project `felyggqjjhltwokdfhop` ("life-data"). Service-role key in `data-layer/src/client.ts`.
- The **`data` MCP** (`data-layer/dist/mcp.js`) is how Claude reads/writes life data.
- **RLS** is on for every table. `00042` covered the 38 that existed then and `00074` the three
  added since (`reports`, `workset_reports`, `set_watcher`); tables created by SQL migration
  default to RLS **off**, so a new migration has to enable it or the table is reachable with the
  anon key — which is public, since it ships inside the Workset watch app. `workset_reports` and
  `set_watcher` carry policies granting anon exactly what that app does; everything else has no
  policy at all, which denies anon outright while service_role bypasses RLS as usual.
- **Realtime** is on. The `supabase_realtime` publication includes (at least): `voice_requests`,
  `voice_messages`, `voice_focus`, `voice_sessions`, `device_status`, `nutrition_entries`, `sets`,
  `desk_commands`. The hub server, the voice worker and the Mac orchestrator subscribe.

**Key tables:** `weight_log`, `nutrition_entries`, `nutrition_targets`, `sets`,
`workout_sessions`, `exercises`, `exercise_sets`, `health_profile`, `lists`, `list_items`,
`recipes`, `surf_snapshots`, plus the system tables below.

A list is keyed by `lists.id` ('l_grocery'), not by its name; `list_items.list_id` is the reference
and `list_items.list_name` is a derived copy maintained by trigger (data-layer `00094`).

There is **no `reminders` table and no `notes` table** — both were dissolved into `list_items`. A
reminder is a row with a `due` date, and any item on any list can carry one (data-layer migrations
`00056`/`00057`); a note is an undated row on the `notes` *list*, its name in `title` and its body in
`text` (`00092`/`00093`). Anything still reaching for either table is reading a dropped one.

There is likewise **no `repeat_every` column** (`00085`/`00086`). Recurrence is materialised: one
scheduling request writes one dated row per occurrence, sharing a `series_id`. Nothing advances a
`due` any more, so `due` and `scheduled_at` always agree.

`list_items.completed_at` is what the health bar's task band scores from — its VALUE, not merely its
presence, since how late it was is what the completion is worth. It holds a naive local wall-clock
reading, the same convention `due` uses, and both the hub's `/api/todos/complete` and the data
layer's `complete_item` accept a caller-supplied one (`at`) for something finished before it was
reported. A completed item is not deleted: it leaves every active surface but stays on the
**calendar**, ticked and struck through. Deleting is a separate act that scores nothing.

**System tables (machine plumbing, not life data):**
- `voice_requests` — the voice command queue (enqueue → worker claims → done).
- `voice_messages` — the shared "hub" conversation thread shown on every surface.
- `voice_focus` / `voice_sessions` — what the wall is focused on / session list.
- `worker_presence` — each worker's heartbeat (drives priority arbitration).
- `app_settings` — flat key/value settings (surplus/deficit, `maintenance_phase`, wake-free / inject /
  mute, weight-reminder, agent mode…). Full catalog: [docs/HUB-INTERNALS.md](docs/HUB-INTERNALS.md) §7.
- `litter_events` — the litter-watcher's persisted event stream (cycles, resets, alerts, presence).
- `repos` / `desk_commands` — the Mac's published projects, and the launch queue behind them (§9).
- `desk_sessions` / `desk_queue` / `desk_focus` — every Claude session on either machine (dispatched
  or adopted), work waiting for a Pi slot, and the pin: a session focused by name, or a dispatch still
  opening. Unpinned, a spoken follow-up goes to the most recently active session (docs/SESSIONS.md).
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
  scrolling rows; phone = swipe panes on `/` (chat · **home** · misc · **maint** · **lists** ·
  **repos** · **reports**), where the home pane is `phone-home.html` — everything the TV's home wall
  carries in ONE SCREEN, laid out in portrait at the phone's own scale rather than as a scaled-down
  wall; all off `/api/stream` (SSE). Served by the Node server.
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
  - **Macro Rings** — today's Cal/P/C/F **pace** rings (plus the health bar on medium — three bands:
    nutrition, training, tasks, each sent pre-divided so the widget never re-derives the weighting),
    from
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
- **Apple Watch** — `status-hub/apps/Watch/`, native (watchOS has no web view) and embedded in the
  iOS app. Four pages: the sessions, each opening to its last reply and live tool calls (with what it
  says between them) and taking a recorded follow-up; the shared hub thread, recorded into (clips go to
  `/api/voice-command` like the phone's microphone), with the running command's tool calls and
  in-between text live; the nutrition card's pace rings
  over today's log; and the home wall's rest clocks over today's sets. A complication and the Record control (watchOS 26, which an Ultra's
  Action button can run) open it straight into recording. See
  [docs/HUB-INTERNALS.md](docs/HUB-INTERNALS.md) §9c.
- **ESP32** — the voice mic (see §5).
- **iPhone push** — native APNs notifications (see §7).

---

## 5. Voice pipeline (`voice-pipeline/`)

End-to-end flow:

```
  ESP32 mic ──wss──▶ jared-voice (Fly)              Supabase                Mac/Fly worker
  (or Mac mic,        ├ openWakeWord ("Hey Rhasspy")  voice_requests  ◀──┐    claims request
   or web mic FAB)    ├ capture utterance             (the queue)        │    ├ warm Agent SDK (subscription)
                      └ Groq whisper-large-v3-turbo ──▶ INSERT ──────────┘    │  or claude -p (escalation)
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

`worker/run.sh` sets `WORKER_PRIORITY=pi,mac,fly` on every machine, so the order is **Pi → Mac →
Fly**: the Pi claims whenever it is up, and the Mac is the fallback. That inversion is deliberate —
work started by voice can run long, and closing the laptop must not kill it. (`worker.py`'s own
in-file default is `mac,pi`, which applies only if something starts it without `run.sh`.)

| Worker | `WORKER_ID` | Where | Runner |
|---|---|---|---|
| **Pi** | `pi` | systemd `voice-worker.service` | warm Agent SDK + `claude -p` (subscription) |
| **Mac** | `mac` | launchd `com.jaredgantt.voice-worker` | warm Agent SDK + `claude -p` (subscription) |
| **Fly** | `fly` | inside `jared-voice` | Anthropic API (no subscription login) |

A **live hub context window overrides priority**: it stays pinned to the worker that owns it until
the window resets or that worker goes silent, so a conversation isn't lost to a needless switch.

- **Claiming latency:** a **Supabase realtime listener** (`RealtimeWaker` in `worker.py`) wakes the
  loop the instant a `voice_requests` row is INSERTed; a slow poll (`IDLE_POLL_S`, 60s) is the
  backstop, and the claim socket is recycled every ~5 min to beat realtime half-open death. An idle
  cycle costs ONE read: whether anything is pending. Standby and the orphan-claim sweep answer
  nothing while there is nothing to claim, so they run on their own 60s clocks rather than per cycle.
- **Model routing — one dynamic route.** Every hub command runs **Sonnet first**, given only the SAFE
  read/actuator tools (`allowed_tools` on the warm SDK client); the gated data-WRITE tools are absent
  from that list, so Sonnet can see them and is *denied* them. If the turn needs one — it emits
  `__ESCALATE__`, or attempts a gated tool and is denied — it re-runs on a **fresh Opus** with the
  full toolset. Hub turns are fresh runs with the recent conversation replayed from `voice_messages`;
  only full-agent (coding) mode keeps a `--resume` CLI session, because a shared one let two models
  cross-contaminate each other's context. `voice_requests.tier` is still written by every capture
  path and read by nothing. Full detail: `voice-pipeline/docs/ROUTING.md`.
- **Subscription vs API key:** the CLI and the Agent SDK silently prefer `ANTHROPIC_API_KEY` over
  the subscription login, so `worker.py` pops it from the environment at import and no subprocess can
  inherit it. Only the `ApiRunner` — the funded fallback, and Fly's runner — reads the held key.
- **The Pi:** runs `worker.py` via systemd `voice-worker.service` (env in `~/.voice-worker.env`),
  from the checkout at **`~/voice-pipeline`**, venv at `~/voice-pipeline/.venv-worker`. There is a
  *second* clone at `~/repos/voice-pipeline` that the service does not use — pulling that one changes
  nothing. `git pull` in `~/voice-pipeline` + `sudo systemctl restart voice-worker` to update.

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
- **Anthropic** — Claude subscription (warm Agent SDK + `claude -p`) for the workers; the Console API
  key funds the fallback `ApiRunner` and Fly.
- **Apple** — APNs (push) + App Store Connect (ASC key on disk; Issuer ID not yet recorded).

---

## 9. Desk control — launching sessions from the phone

> The session system in full — data model, verbs, invariants, constants, gaps — is
> **[docs/SESSIONS.md](docs/SESSIONS.md)**. This section is the summary.


The hub's repo picker (and the Projects widget) starts a Claude session from anywhere: tap a project
→ a session opens there running `claude --remote-control <name>` → it waits in the Claude app, which
is where the work actually happens. The hub only *starts* it.

**Two consumers, one queue.** The Mac's orchestrator opens a Terminal tab; the Pi's `pi-desk` runs
the same job in tmux, so a session survives the laptop closing. Both publish the same two facts on a
30s tick — whether the session is still up, and the FINAL message of its last turn — so the follow-up
pointer and the sessions panel describe a Mac session as accurately as a Pi one. Only the Pi bounds
what it holds (a residency cap, and eviction to make room): that exists because a headless 4GB
machine has to decide what to close, and on the Mac the tabs are visible and Jared closes them
himself. Closing and resuming work identically on both. A command goes to the Pi when the hub
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
  done | error | expired) · `desk_dead_letters` (everything that never ran). Presence reuses
  `worker_presence` under `worker='desk'` / `'pi-desk'`.
- **A session can be moved to the other machine, conversation and all.** Both machines mirror the
  tail of every transcript to the `transcripts` bucket at the end of each turn, so a session is
  always pickable up elsewhere — including when the machine that ran it is asleep, which is the
  usual reason for asking. A transfer is claimed by the machine GIVING IT UP: it closes the session,
  flushes the mirror, then asks the destination to resume. One writer at a time, always — `--resume`
  on a live transcript forks the conversation into two copies with one id. When the source is
  unreachable there is nothing to close, so the destination resumes from the mirror as of the last
  completed turn. `transfer_session` by voice, the `→ Pi` / `→ Mac` button in the pane.
- **Sessions are numbered so they can be named out loud.** Active sessions, **most recently active
  first, running above parked, from 1** — the same rule in `data-layer/src/desk.ts` (`numberSessions`) and in `/api/sessions`,
  because "session three" has to mean one thing. The number is a position in the current list, never
  identity: closing one renumbers the rest, which is what keeps it 1..N over what is actually open.
  `end`, `resume` and `transfer` all take a number, a repo name, or an id; an ambiguous name is
  answered with the choices rather than a guess.
- **A session can be named**, by voice (`rename_session`) or from the pane. The name is sent as
  `/rename` into the live session, so it is the session's own name — tab title included — and comes
  back through the transcript rather than living only in our row.
- **Two closed states, and they are about what can be done.** `evicted` is parked WITH its
  transcript, so it resumes with the whole conversation — a new tab on the Mac, a new tmux session on
  the Pi. `ended` means no conversation was ever bound (claude never came up), so there is nothing to
  bring back. `transferred` means the conversation continues in another
  row on the other machine.
- **Nothing is kept for ever.** One retention rule, in `pi-desk` on the always-on machine: closed
  sessions (`ended`/`transferred`) go at 7 days, parked (`evicted`) at 14, the `desk_commands` log at
  30, and `voice_requests` — the raw captures — at 7. Dropping a row does not destroy a conversation;
  the transcript stays on disk and resumes by id. Dead letters are exempt.
- **Nothing dispatched is ever dropped.** The queue has no way to fail: a command written for a
  machine that is asleep is claimed by nobody and expires unread, while the caller has already been
  told a session started. So every entry point — the MCP, the repo picker, the sessions panel — checks
  the target machine is beating *before* it writes, and anything that still fails (expired, errored,
  or claimed by a machine that then stopped) is kept whole in `desk_dead_letters` with its payload.
  A dictated prompt is minutes of speech nobody can repeat; the launch is the cheap part.
  Deliberately **not** a retry queue — work that could not run when it was asked for has usually
  stopped being wanted by the time the machine returns. `GET /api/failures` lists them,
  `POST /api/failures/:id/{retry,dismiss}` acts on one.
- **A prompt reaches the Mac through a file, never the typed command line.** `do script` writes into
  the tab's tty, and a tty accepts **1024 bytes** and silently discards the rest: a 2500-character
  dispatch arrived as exactly 1024 characters, cut mid-word, leaving the shell on an unterminated
  quote and no session — with the command recorded as `done`. A **follow-up** cannot use the shell
  (it goes to Claude Code's composer), so over ~900 characters — or with any newline, which an
  AppleScript string literal cannot hold — it is stashed in `~/.claude-desk-prompts/` and the session
  is told to read it, **echo it back verbatim first**, then act. The echo is what keeps the words in
  the session rather than in a file nobody opens, which is why the file is disposable and swept after
  a day. The Pi needs none of this: tmux carries 3000 characters into a pane intact.
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

---

## 11. Getting a build onto the phone

**TestFlight is the route.** Dispatch `ios-testflight.yml` (or push an `ios-*` tag): a macOS runner
archives and uploads, Apple processes it, and the internal group `internal_main` on the App Store
Connect app "JaredHub" (id `6805268657`) receives every build, so the phone installs it from the
TestFlight app over the air — nothing has to be on the Mac's network. The watch app rides inside it.
A TestFlight build expires 90 days after upload. The runner bills at 10x, so dispatch it deliberately.

**When TestFlight says he is not a tester, that is membership, not the build.** TestFlight keeps
showing the app to an Apple ID that was ever a tester but refuses to install for one that is not in a
group now — which is what a new phone signed in to a different Apple ID looks like. `ios-testers.yml`
(Linux, 1x) answers it without a Mac or an interactive Apple ID login: `list` prints every group with
its members and public link, `builds` prints what TestFlight is offering and when it expires, and
`add` puts an address in a group. Two traps behind it:

- **The App Store Connect account carries four apps** — JaredHub, StrokeSaver, CapGrille and Watchset
  — and a group name is only unique within one, so groups are named `App/Group` here. `asc.mjs`
  walks all four for exactly that reason; the device and bundle-id commands are account-wide anyway.
- **An internal group can never have a public link.** Apple offers those on external groups only, and
  an external group's builds have to clear Beta App Review first, so "turn the link on" is not a
  setting away from an internal group. Of the four apps only CapGrille has one.

**A local build is for iterating on UI, never for installing.** A build signed on this Mac carries
`aps-environment: development` and registers a **sandbox** APNs token, which the hub's production
sends cannot reach, so installing one silences push until a production build replaces it. It also
needs the iOS device platform from Xcode → Settings → Components (CLAUDE.md).

There is no way to *push* an iOS app to an iPhone. Apple has no remote-install channel for a normal
(non-MDM, non-supervised) device, so every route ends either in a tap on the phone or in a machine
that the phone is already paired with. What follows is the Ad Hoc route, which needs neither
TestFlight nor any public hosting but does need the phone reachable from the Mac.

`ios-check.yml` is the fourth workflow and the one that runs most: it compiles the app and renders the
widget layouts to PNGs without shipping anything, so a machine with no Xcode can still find out
whether its Swift builds and what the widgets look like. `gh run download <id> -D shots` pulls the
images back.

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
