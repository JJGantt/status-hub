# Claude sessions as a managed system

Every Claude Code session running anywhere in this setup — dispatched by voice, started from the
phone, or opened by hand in a Terminal tab — is one row in one table, with one set of verbs. This is
what that system is, what holds it together, and what will break it.

`ARCHITECTURE.md` §9 is the summary. This is the whole thing.

---

## 1. What it does

- **Sees** every session on either machine, whether or not anything here started it.
- **Reports** whether each is running, and the final message of its last turn.
- **Acts** on them: start, follow up, rename, park, resume, move to the other machine, close.
- **Addresses** them the way they get talked about — "session three", "the status-hub one".
- **Never strands** an instruction. Work one machine cannot take goes to the next — the other home
  machine, then Fly — and only what no machine could run is kept, whole, for a later decision.

Everything below serves one of those five.

---

## 2. The pieces

```
     voice ──┐
     phone ──┼──▶  desk_commands  ──realtime──▶  orchestrator (Mac)   ──▶  Terminal tab (an incident session: tmux)
    the hub ─┘                                   pi-desk       (Pi)   ──▶  tmux session
                                                 pi-desk       (Fly)  ──▶  tmux session
                                                      │
                            both publish, both read   ▼
                                                desk_sessions ──▶ phone pane, TV strip, MCP tools
```

The hub runs on Fly and can reach none of the machines. **Supabase is the only bus**, in both directions:
work goes out as rows in `desk_commands`, state comes back as rows in `desk_sessions`. Nothing
depends on SSH or on being on the same network: with the Mac unable to reach the Pi at all, sessions
still dispatch to it and report back.

| Piece | Where | Does |
|---|---|---|
| `orchestrator/src/commands.js` | Mac (launchd) | drains `desk_commands`, opens Terminal tabs (incident sessions run headless in tmux) |
| `orchestrator/src/deskSessions.js` | Mac, every 30s | adopts, reports liveness, mirrors, starts watchers |
| `orchestrator/src/sessionWatch.js` | both, on file events | watches live transcripts: pushes tool calls + finished turns |
| `orchestrator/src/discover.js` | both | which conversation each `claude` process is in, from Claude Code's own record |
| `orchestrator/src/mirror.js` | all three | uploads/downloads transcripts for a handover |
| `orchestrator/src/route.js` | all three | where work goes when this machine cannot take it, and the handoff verdicts |
| `orchestrator/src/transcripts.js` | both | reads a transcript: final reply, working, title |
| `pi-desk/index.js` | Pi (systemd), Fly (`fly-desk`) | the same, plus residency limits and retention |
| `data-layer/src/desk.ts` | wherever the MCP runs | the verbs, as tools, and the failover order (`routeCommand`) |
| `status-hub/server.js`, `server/lib/failover.js` | Fly | the API and the pane; the same failover rules as desk.ts, restated because the hub has no dependency on data-layer |
| `health/responder` | Fly (`ops-responder`) | the fast liveness beat (`/live`) and `evacuate` (§ When a machine stops) |

---

## 3. The data

### `desk_sessions` — one row per session

| column | meaning |
|---|---|
| `id` | the tmux name (`hub-<repo>-<ts>`) on the Pi, `mac-<cmd8>` on the Mac |
| `worker` | `pi-desk`, `desk` or `fly-desk` — which machine owns it (Pi, Mac, Fly) |
| `agent` | `claude` (Claude Code) or `codex` (OpenAI's Codex CLI) — what runs in it; § Codex sessions |
| `origin` | `dispatched` (we started it) or `adopted` (opened by hand) |
| `repo` / `label` | where it runs, and what it is called |
| `status` | see below |
| `claude_session_id` / `transcript_path` | the conversation, and where to read it. **This is the session's identity**: a resume makes a new row for the same conversation and `claude --resume` keeps this id, so the tools' permanent handle is `s-` plus its first eight characters (`sessionHandle` in data-layer), never the row `id` |
| `pid` | the Claude Code process the row belongs to — what liveness and the conversation are read from |
| `tty` | Mac only: the Terminal tab (or an incident session's tmux pane), and the handle a follow-up is typed into |
| `working` / `last_reply` / `reply_at` | is a turn in flight; the last COMPLETED answer, and when |
| `last_prompt` | the prompt that answer was to. A long message is recorded as `<pasted_content>…</pasted_content>` (how it was pasted in, voice-pipeline `handoff.js`), and `resolvePrompt` in the orchestrator's transcripts.js strips that back to the typed words. Older turns hold a stub naming a file in `~/.claude-desk-prompts`, which the same function resolves until the file is swept at thirty days. Earlier turns are kept in `desk_turns`, by trigger (HUB-INTERNALS § The turns before the last one) |
| `active_at` | the last turn boundary (a prompt sent, a turn finished) — what orders, numbers and focuses sessions |
**A prompt typed while a turn is running is a `queue-operation`, not a `user` record.** Claude Code
queues it and writes the user record only when the turn consumes it, so a watcher looking at user
records alone learns of a mid-turn prompt minutes late or never — which is the one case a live view
most needs it. `sessionWatch` sends its `said` frame off the `enqueue` record and remembers the text,
so the user record that follows does not say it twice.

| `seen_at` | when the last reply was READ. A row is unread while `reply_at` is newer (or `seen_at` is null), which is what every session list flags. On the row rather than per device: the phone, the wall and the Mac share one list, so reading an answer on any of them has read it. Two things stamp it — opening the session in the hub (`POST /api/sessions/seen`), and its Terminal tab coming frontmost on the Mac (Hammerspoon `session-read.lua` → the orchestrator's `markTtyRead`) |
| `mirror_offset` / `mirror_at` | how much of the transcript is in the `transcripts` bucket |
| `command_id` | the dispatch or resume that created it — how a follow-up resolves its target |

**Statuses, and they are about what can be done:**

| status | means | resumable |
|---|---|---|
| `resident` | running now | — |
| `evicted` | closed, transcript recorded | **yes**, with its whole conversation |
| `ended` | closed, no transcript ever bound | no, there is nothing to bring back |
| `transferred` | handed to another machine, which continues it under its own row | no, follow the new row |

### The other tables

- **`desk_commands`** — the commands. `pending → running → done | error | expired`, with `claimed_by`
  so a machine can sweep only its own abandoned claims. A command a sender took back from a silent
  machine is `error` with a detail starting `rerouted:`.
- **`desk_pins`** — one row per pinned conversation, with when it was pinned (`pin_session` /
  `unpin_session`). The shown session is computed from these and `active_at`, not stored.
- **`desk_queue`** — inert: nothing writes it and nothing reads it but pi-desk's startup, which routes
  out any row left in it once, as a command (`drainQueue`). Do not write to it.
- **`desk_dead_letters`** — everything no machine, Fly included, could run, with its whole payload.
- **`transcripts` bucket** — mirrored transcript tails, `<claude_session_id>/<offset>.part`. Each
  machine uploads a transcript as it is written — the transcript watcher's file event, coalesced over a
  few seconds, with the reconcile tick's mirror as the net — and only WHOLE lines: `mirrorUp` cuts at the
  last newline, so a resume elsewhere never reads half a JSON record. A session with a prompt and no
  reply yet is mirrored too; its first line is enough to move it. So a session whose machine dies
  mid-turn resumes elsewhere from where its transcript stopped, not from the last finished turn. A
  conversation's parts are cleared in BOTH places that abandon it: when retention forgets the session,
  and when a `/clear` rebinds the row to a new conversation. The second one is easy to miss — from that
  instant the old parts are unreachable (the mirror is keyed by conversation id and the row now names a
  different one), and retention will never reach them either.

---

## 4. How a session gets here

**Dispatched.** `start_session` (voice) or the repo picker (phone) writes `open_session`. The target
machine claims it, pulls the repo, launches with `--remote-control`, and publishes the row as the most
recently active session. The Pi clones from GitHub if it has no checkout; the Mac uses the one it has.

**A dispatched session is told it IS the dispatch.** Its prompt is the user's words verbatim, and those can still begin
"start a session in X and have it…" when the router leaves the addressing in — which the new session
reads as an order and dispatches the same request again. So a fresh launch with a prompt carries
`voice-pipeline/orchestrator/dispatched-session.txt` as `--append-system-prompt` (both launchers read
that one file; a system prompt so every surface still shows only the user's words), and `start_session`
refuses a prompt the calling session was itself started with (`desk.redispatch`, keyed on
`HUB_SESSION_ID`, which only the launchers set).

**The model is named at launch on both machines** — `DESK_MODEL` in the orchestrator's config, and
`PI_DESK_MODEL` in pi-desk's `launch.sh`, both opus. Left to settings, a session takes whatever
`/model` last wrote to `~/.claude/settings.json`, and a wrong value there is invisible from an
interactive session in the home directory: `~/.claude/settings.local.json` is also the PROJECT
settings file for the project rooted at `~`, so it outranks the machine default for exactly the
sessions opened by hand there, and for none of the ones dispatched into a repo.

**Adopted.** Every 30s the Mac lists `claude` processes that have a controlling tty — which excludes
the voice worker's SDK client and the MCP children — and any process no row owns becomes a row.

**Which conversation a process is in is READ, never inferred.** Claude Code keeps a record for every
live process, `~/.claude/sessions/<pid>.json`, holding the conversation id (the transcript's filename)
and the working directory. It rewrites the id when `/clear` starts a new conversation and deletes the
file when the process exits, and it says whether a turn is in flight and when that last changed — which
is where `working` and `active_at` come from; the transcript is only the fallback, since one long turn
of tool calls can fill the window it is read through. `orchestrator/src/discover.js` reads it on both
machines — the Mac for
every process, the Pi for the tmux panes it launched (`launch.sh` `exec`s claude, so the pane's pid is
claude's) — so a row follows a `/clear` exactly, on both.

A row belongs to a PROCESS (`pid`), not a Terminal tab. A tab outlives the process inside it, and a
later `claude` typed into the same tab is a different session with a row of its own.

Inferring the transcript from outside — birth times, the newest file in a project directory — cannot
be made safe: every session opened in the home directory shares one project directory, so each new
session looks like a `/clear` in every older one, and rows end up showing each other's words.

The Pi adopts nothing: sessions there are launched by `pi-desk` or they do not exist, unless someone
attaches to tmux over SSH and starts one by hand, which is not tracked.

### Codex sessions

A session can run OpenAI's Codex CLI instead of Claude Code (`agent = 'codex'`), so dispatched work
still runs when Claude cannot take it — an outage, or the usage limit. Codex runs on the owner's ChatGPT plan
with the same MCP servers, approvals off and full access.

- **Who asks for one.** `start_session` takes `agent`. Omitted, it is Claude, except where the data MCP
  carries `DATA_AGENT=codex`: the voice worker's Codex fallback and its API-credits runner (a Claude
  session would hit the limit that put the worker there), and every Codex session (so work a Codex
  session hands on stays on Codex). A Codex dispatch skips the Claude usage gate and the login check.
- **Where it can run.** A machine whose heartbeat says `info.codex: true` (the CLI installed and signed
  in, `codexReady` in `orchestrator/src/codex.js`); the same Pi → Mac → Fly order as Claude otherwise.
  Each machine signs in to Codex on its own (`codex login --device-auth`).
- **Launch.** `pi-desk/launch-codex.sh`, in tmux on the Pi and Fly and in a Terminal tab on the Mac
  (`openCodexTab`). The prompt comes through a file as for Claude; the dispatched-session and machine
  notes go in as Codex `developer_instructions`. `HUB_SESSION_ID` and `DATA_AGENT` are forwarded to the
  data MCP by name (`mcp_servers.data.env_vars`), because Codex starts MCP servers with a scrubbed
  environment. Each machine's `~/.codex/config.toml` must give every MCP server
  `default_tools_approval_mode = "approve"`, or approvals-off refuses every tool call.
- **Which conversation.** Codex keeps no per-process record. Its native process holds its rollout
  (`$CODEX_HOME/sessions/…/rollout-<ts>-<thread id>.jsonl`) open for the whole session, so the thread is
  READ from the process's open files (`/proc/<pid>/fd` on Linux, `lsof` on the Mac), searching the
  launched pid and its children because `codex` is a node wrapper around the binary. The thread id is
  stored in `claude_session_id`.
- **Replies and live activity** come from the rollout: `task_started` / `task_complete` (with
  `last_agent_message`, the reply) bound a turn, and the user's words are the UserMessage item. `readTail` and
  `sessionWatch`'s `step` hand a rollout to codex.js, so the tick, the watcher, the relay and the hub
  treat both agents alike. A message typed mid-turn steers the running turn in Codex, so it arrives as
  `said` with no `queued` before it.
- **Follow-ups and closing** are typed exactly as for Claude (bracketed paste, then Enter; `/exit`).
- **Rename** writes `label` and `custom_title` on the row: Codex has no rename the rollout records.
- **Resume** is `codex resume <thread id>` on the machine that ran it, under the same row name on the Pi.
- **They do not move.** A Codex rollout is never mirrored, and `transfer_session` refuses one; the Pi
  neither hands a Codex session to the Mac when short of memory nor moves it for heavy work.
- **Not adopted.** A `codex` opened by hand on the Mac is not listed.
- **Shown blue** on every surface that shows an incident red (`isCodex` in status-hub `routes/sessions.js`; § 11).

---

## 5. The verbs

| tool / action | who claims it | what happens |
|---|---|---|
| `start_session` | target machine | pull, launch, publish the row |
| `pin_session` | — | pins a session (pins are a set): it heads every list and, most recently pinned, is the shown session |
| `unpin_session` | — | takes the pin off one session; the others stay |
| `follow_up` | machine owning the target session | text typed into the live session, busy or not; the target is ALWAYS the session named (`session`, required — there is no default target). A parked session is resumed with the words instead. **With the owning machine down, or silent for 20s, the session moves**: a `resume_mirrored` to the other home machine, else to Fly, carrying the words as its prompt, as a transfer from a dead source does. A session that cannot move (Codex, or nothing of it mirrored) gets the words as a NEW session in its repo, without the earlier conversation, and the answer says so; only no machine taking either dead-letters them. **Sent just after the session was handed on**, the words follow it: pi-desk writes the same follow-up for the row it went to and answers `handed to the Mac as <id>` (or the Pi, or Fly), which the sender follows to that machine's verdict (pi-desk `moved.js`) |
| `rename_session` | owning machine | `/rename <name>` typed in — the session renames itself |
| `end_session` | owning machine | close the tab / tmux session, park the row. With the owning machine down there is nothing to tell, so the sender parks the row itself (`evicted`, or `ended` with no transcript). A session ending ITSELF is not closed by a command: see below |
| `resume_session` | owning machine | `claude --resume <id>` in a new tab or tmux session, with an optional prompt; a Pi with no memory to spare hands it to the Mac with its conversation, else to Fly, like new work (§ Capacity). Aimed at a session that is still running, both machines type the prompt into it. With the owning machine down, the sender resumes it elsewhere from the mirror (`resume_mirrored`). The data MCP's `resume_session` also takes a `machine`: a parked session named onto the other machine is resumed there straight from the mirror (`resume_mirrored`, no command to its old machine), and a running one is moved there as `transfer_session` would |
| `transfer_session` | machine GIVING IT UP | close, flush the mirror, ask the destination to resume — the machine named, else the next in the order (Fly last). With the source down, the destination resumes from the mirror directly |
| `resume_mirrored` | the destination | resume a conversation from the `transcripts` bucket. The sender marks the old row `transferred` FIRST, atomically on the status it read, and puts it back if no machine takes the session, so two movers of one conversation never both resume it |
| `evacuate` | the machine the ops responder addressed | move every resident Claude session of a machine that has gone DOWN (§ When a machine stops) |
| `get_sessions` | — | the numbered list |
| `read_session` | — | one session's last few turns from `desk_turns` (his prompt and its reply, oldest first, up to the 20 kept): how voice finds something he "was talking about" in a session rather than to it |

The hub's `POST /api/sessions/followup` (the watch's and the phone's session view) is `follow_up` addressed by session
id instead of by focus, and for a parked session it writes `resume_session` with the words as the
prompt instead — HUB-INTERNALS §6b. It moves a session off a machine that is down or silent exactly as
`follow_up` does, carrying attachments and `msg` in the `resume_mirrored` payload; the two have to agree.
The hub's resume, close and transfer routes follow the same rules as the tools (`server/lib/failover.js`).

**A session that ends itself closes after its reply.** It calls `end_session` mid-turn, and closing
it then kills the process before the reply is written, so the watch and phone get nothing. So when the
named row is the caller's own (`HUB_SESSION_ID`, or on the Mac the data MCP's parent pid matching the
row's `pid`), data-layer stamps `desk_sessions.close_after_turn` and sends no command. The host closes
it once a turn that ended after that stamp has been reported to the hub and the transcript mirrored:
the transcript watcher's turn end triggers it (`onReported` in `sessionWatch.js`), and the reconcile
tick catches a turn end the watcher missed. `closeAfterTurn` in `deskSessions.js` (Mac) and
`pi-desk/index.js` (Pi and Fly).

Every verb that writes a command, from the tools and from the hub alike, answers only once a machine
has marked it `done` or `error` (`dispatchConfirmed` in data-layer, a realtime subscription opened
before the insert; in the hub a waiter fed by its realtime channel, with one read at the deadline for a
channel gone deaf). An insert always succeeds, so answering at insert time reports delivery for
commands the machine then refuses. A machine that has not answered in 20s has its command taken back
(`pending` → `error`, `rerouted: …`, written only while it is still `pending`, so a machine that
claimed it in that second keeps it, and the answer says it is running there unconfirmed), and the work
goes to the next machine; a refusal moves on the same way. A detail of `handed to the Mac as <id>`,
`handed to the Pi as <id>` or `handed to Fly as <id>` is not a verdict either: `settle` waits on that
command and reports where the work really ran. No consumer answers `queued`; one that did would be
treated as a refusal and routed around.

### Pins and the shown session

**Pins are a set** (`desk_pins`, one row per conversation with when it was pinned, data-layer migration
00164). `pin_session` adds one and `unpin_session` removes one; closing a session by hand removes its pin
too, and nothing automatic does — dispatching work, eviction, a resume or a move between machines all
leave it, since the pin is on the conversation, not a row. Pinned sessions head every list, most recently
pinned first: `desk_sessions_state()` numbers them that way, and every surface orders by the number. Each
row in `/api/sessions` carries `pinned`, and every list draws a pin beside its name.

**The SHOWN session** (`focus` in `/api/sessions`, `pinned` beside it when it is a pin) is the most
recently pinned one, else the most recently active running session. It is what a surface with room for
one session's answer shows: the home wall's reply column, the sessions wall's open tab, the footer strip.
The walls frame its row white, because the answer below belongs to it. The phone and the watch, which
show no answer beside the list, do not mark it.

**Follow-ups do not go to the shown session.** `follow_up` always names its target: the orchestrator holds
the conversation and knows which session the words are for, and a default target is how words land in
the wrong one. On a room-mic turn `follow_up` still demands an explicit handoff ("send a follow-up",
"tell it to"), because the mic hears the whole room; on a deliberate turn (watch, phone, typed, the ESP's
wake word) a reply that plainly answers a session's message posted in the thread is a handoff too — the
worker names those messages by session in the replayed thread, and the model sends the reply there.

**Nothing waits on one machine while another could run it.** Work goes to the machine asked for,
and when that one cannot take it NOW to the next: from the Pi the Mac, from the Mac the Pi, and Fly
last from either (`failoverOrder`). "Cannot take it" is any of: not beating (90s), its `/login` expired
(its heartbeat publishes the date), refusing it, or silent for 20s. Every sender — the tools, the hub's
routes, and each consumer handing on what it cannot run itself (`route.js`) — follows that order. The
Fly session machine (`fly-desk`, shown as `Fly`) is always there: stopped until a request to its
`/wake` starts it (Fly's proxy holds the request until the host is listening, so a 200 means it is
up), with no browser and no Remote Control, which is why it is last (voice-pipeline
`fly-desk/README.md`). On Fly nothing is refused for capacity: it launches anyway, and a shortage
there is a console.error. A command a consumer finds already older than `COMMAND_TTL_S`, or claimed and
never finished, is sent to Fly rather than dead-lettered (`flyCommandFor`). An expired login on the
machine asked for also starts one session in the `health` repo to renew it
(`health/runbooks/claude-login.md`). Only when Fly too fails is the work kept whole in
`desk_dead_letters`, with a console.error. It is deliberately not a retry queue: work that could not run
when it was asked for has usually stopped being wanted.

**An incident session never runs as an ordinary one.** A session whose label starts `Incident: ` was
dispatched by the ops responder and reads text anyone can write, so every launch of it (open, resume,
hand-over, an evacuation, the wall's focus pty) goes through `health/responder/bin/incident-claude`, which
gives it that agent's narrow permissions (health `responder/README.md` § The incident agent's
permissions): pi-desk `launch()` and the orchestrator's `incident.js`. The label is the marker because
every relaunch carries it; a launch that cannot find the launcher is refused rather than started plain,
and an incident session is never run as Codex.

**A shell's command line takes 1024 bytes.** That is the tty's canonical-mode limit, and past it the
rest is dropped silently, so a launch prompt goes through a file the shell reads. A RUNNING session
holds its tty raw and has no such limit — 20,000 characters arrived intact — so follow-ups are typed
straight in. The Pi has neither limit; tmux carries any length.

**One utterance, one command.** Two mics endpoint at different pauses, so one spoken thing arrives as
several rows. Nothing is claimed while any mic still reports hearing speech, and among the captures of
one utterance the longest transcript wins. Without this, a mid-sentence fragment runs as a command and
the complete capture is discarded as its duplicate.

### When a machine stops

A machine that is gone cannot say so, and the 90s presence beat is too slow to move a session someone
is waiting on. So pi-desk on the Pi and the Mac's orchestrator also POST `/live` to the ops responder
every 5s (`{"machine": "pi" | "mac"}`, fire and forget; no database write per beat). A machine that has
beaten and then misses 15s is DOWN, once per outage (health `responder/README.md`): the responder raises
the machine-silent incident at once, and writes an `evacuate` command — to the other home machine when
its `/live` is fresh, else to Fly after waking it. A sleeping Mac is suspended and stops beating, which
is meant: its sessions are frozen and move too.

`evacuate` (`{machine}`) takes each `resident` Claude row of that machine's worker that has a
conversation and something mirrored, marks it `transferred` (written only while it is still
`resident`, so two evacuations never both take one), and resumes it on the machine that claimed the
command from the mirror. A session that was mid-turn is resumed with a note saying its machine stopped
mid-session and to check what state the work is in before carrying on (`MOVED_DEAD_MARKER` in
`route.js`); an idle one gets no prompt. Codex sessions and ones with nothing mirrored cannot move, and
are named in a console.error and left. The answer is `evacuated N session(s) from <machine>: …; could
not move: …`.

**A machine that comes back does not keep what was moved.** Its reconcile tick closes any live session
whose row is `transferred`, or whose conversation is resident under another worker, and does not write
the row back to `resident`; each is logged once as a console.error ("… was moved to … while this machine
was away"). After a restart, a row still `resident` whose process is gone and which was mid-turn is not
quietly parked: unless another machine already took it, it is resumed there with a note that the
machine restarted mid-turn, and reported.

---

## 8. Numbers

| | value | why |
|---|---|---|
| reconcile tick | 30s | both machines: liveness, mirror, and the BACKSTOP for last reply. **It writes only what changed** — `desk_sessions` is published to realtime, so an unconditional rewrite per resident row per tick is a broadcast to every open screen. `last_seen` rides along with a real change or refreshes every 10 min; its only consumer is the 14-day sweep over parked rows, whose stamp freezes at eviction |
| session watch | on file events | `sessionWatch.js`: tool calls and finished turns, pushed as they land |
| `COMMAND_TTL_S` | 120s | a command older than this when a home machine first sees it is not run late there; it goes to Fly |
| `CLAIM_STALE_S` | 900s | a claim held this long is treated as abandoned, and its work goes to Fly |
| confirm | 20s | a command with no verdict this long is taken back and sent to the next machine |
| `/live` | 5s beat, DOWN at 15s | the responder's fast liveness for the Pi and the Mac (§ When a machine stops) |
| `LAUNCH_GRACE_S` | 90s | a new session is not declared dead before this — and a row binds only a process that started within this of the row (Mac), which is what keeps a later `claude` in the same tab off an older row |
| `MIC_QUIET_S` | 2.5s | every mic silent this long before a command is claimed |
| `PI_DESK_SESSION_BUDGET_MB` | 800 | Pi only: what admission reserves for one session |
| `PI_DESK_SESSION_HIGH_MB` / `_MAX_MB` | 1000 / 1200 | Pi only: a session's `memory.high` (the event that triggers the heavy-work check) and `memory.max` |
| `PI_DESK_COMMAND_BUDGET_MB` | 300 | Pi only: what a session's commands may hold before it is heavy work and moves to the Mac |
| `PI_DESK_RESERVE_MB` / `MAX_SWAP_PCT` | 300 / 70 | Pi only: free memory kept beyond every session's budget, and the swap ceiling, for admission |
| retention | 7 / 14 / 30 / 7 days | closed sessions / parked / command log / raw captures |

---

### Capacity

**The Pi is not for memory-heavy work, and it runs one session at a time while the Mac is awake.**
Memory is enforced per session (`pi-desk/cgroups.js`). `pi-desk.service` is delegated (`Delegate=yes`,
`DelegateSubgroup=supervisor`): the daemon and tmux server sit in `supervisor/`, and each session in
`s/<tmux-name>/`, which `launch.sh` joins before exec'ing claude, so claude, its tool servers and every
command it runs are charged there.

- **One at a time while the Mac is awake** (`preferMac`): with any session resident on the Pi and the
  Mac's desk beating, a new session or a resume goes to the Mac. One session fits beside the wall and
  the automation browser; a second is what runs the Pi into swap and gets sessions moved mid-turn.
  The Fly machine and Codex resumes (which cannot move) skip this.
- **Admission** (`makeRoom` / `shortfall`): otherwise, a new session or resume starts on the Pi only if
  MemAvailable covers its whole budget, plus what every running session has left before reaching its
  own budget, plus the reserve — sessions grow after launch, so room is counted against budgets, not
  current use. Otherwise idle sessions are parked, least recently active first, until it fits; with
  every resident mid-turn the work goes to the Mac (a fresh `open_session`, or a resume through the
  transfer path with its prompt), and with the Mac asleep or signed out to Fly. The command answers
  `handed to the Mac as <id>` or `handed to Fly as <id>`.
- **Heavy work moves** (`onHeavy`): the kernel rewrites a session's `memory.events` when it crosses
  `memory.high`, and inotify delivers that. If its COMMANDS hold `PI_DESK_COMMAND_BUDGET_MB` or more
  (`pi-desk/commands.js`: everything under a Bash-tool shell, found by the shell-snapshot path its
  command line sources; anon resident plus swapped), the session is closed, everything in its cgroup is killed, and it resumes elsewhere with a system
  note (`orchestrator/moved-session.txt`) saying why — on the Mac when it is awake, else on Fly. Waiting for the turn to end is not possible: the
  turn IS the heavy work. Whether a turn is restarted there depends on the process's own record, read
  before it is closed (`busy`, not `waiting`):
  - **mid-turn**: restarted with the prompt `[Moved from the Pi]`, and the note says the cut-off step
    is redone. The prompt must never be a word like `Continue`: it lands as the answer to whatever the
    conversation last said, and a session that had just proposed something would take it as approval.
    Closing it sends C-c, which Claude Code records as the user rejecting the step in flight ("The user
    doesn't want to proceed... STOP what you are doing and wait") plus "[Request interrupted by user for
    tool use]". Those records outrank the note, so the session obeys them and stops. The destination's
    `mirrorDown` therefore rewrites them in the cut-off turn (`unmarkMoveInterrupt` in
    `voice-pipeline/orchestrator/src/mirror.js`) to say the move cut the step off and to run it again.
  - **between turns** (a background job it left running grew after the turn ended, possibly on a
    question to the user): resumed idle, no prompt at all, so it waits for input where it lands.

  When Fly will not wake either, it stays, with `memory.high` lifted so it is not throttled.

  A crossing whose memory is the session's own — claude and its tool servers, ~575MB at launch and
  growing with the conversation — is not heavy work and moves nothing; `memory.high` is raised to
  the command budget above where the session stands, so a command that later grows that far still
  crosses it. The cgroup total cannot be the test: judged on it, sessions running `sed` and `grep`
  cross any line low enough to mean anything.
- **A kill takes the command, not the session.** `tool.sh` is `CLAUDE_CODE_SHELL_PREFIX`: every Bash
  command and tool server runs at `oom_score_adj` 1000, above claude's 800 and the kiosk's -500, so at
  a session's `memory.max` or a machine-wide OOM the kernel picks the command.
- **Cleanup.** Closing a session (`evict`) kills its cgroup, so nothing it started outlives it. At
  startup, anything in the unit not descended from a live session, the daemon or the tmux server is
  killed as a leftover.
- Sessions are told in their system prompt (`pi-desk/pi-session.txt`) to run heavy work on the Mac
  over SSH.

A per-session `memory.high` crossing also counts page-cache reclaim, which is why the check counts
only memory a command cannot give back. A process moved into a cgroup leaves its existing memory charged where it was, so
`sessionUsage` takes the larger of the cgroup count and its processes' RSS.

## 9. Known gaps

- **Sessions started by hand ON THE PI are invisible.** Adoption is Mac-only. Nothing watches for a
  `claude` someone starts over SSH.
- **Failed commands have no surface.** `GET /api/failures` lists them and `POST
  /api/failures/:id/{retry,dismiss}` acts on one; nothing renders it, and nothing notifies.
- **Mic handoff is not merged.** If one mic hears the first half of a sentence and another the second,
  the longer one wins and the rest is lost, rather than the two being stitched together.

---

## 10. Live activity

A turn's reply is written to the transcript the instant Claude Code finishes it. The file changing is
an event, so `sessionWatch.js` watches it on both machines and pushes what it sees straight to the hub:

    transcript append ─ fs.watch ─▶ sessionWatch ─┬─ a prompt ─┬─ patch desk_sessions.active_at, working
                                                  │            └─ POST /api/session-activity (`said`, or `queued` then
                                                  │                 `said`, one id; the command's id when this host typed it)
                                                  ├─ tool_use  ─▶ POST /api/session-activity
                                                  ├─ a step's words, just before its tool_use (state 'text') ─▶ the same
                                                  │    (its text, else its thinking summary: from 2.1.268
                                                  │     Claude Code stops recording text after a tool result)
                                                  └─ end_turn  ─┬─ POST /api/session-activity (`done`, the whole reply
                                                                │    and the turn's ordered events, which the hub stores)
                                                                └─ patch desk_sessions.last_reply, active_at  (durable)

    /api/session-activity ─▶ ONE EVENT of the conversation's list (routes/conversation.js `logFrame`: prompt, tool,
                             text, reply, each with a seq and an id) ─▶ SSE `ev` ─▶ watch, phone, wall

    Each event carries its turn and its position in it. A hub missing part of the turn (it restarted)
    answers `{ replay, have }` and the host re-sends from there, so the list's order is the transcript's.

    Every surface draws that list and nothing else (HUB-INTERNALS.md § The conversation as one list).

The database write is not in the delivery path. It still happens, because the reply has to outlive
the moment, but the wall hears from the machine that has the answer rather than
waiting for a round trip through Postgres.

Only what is NEW is read — these transcripts reach tens of megabytes, so the watcher keeps a byte
offset and a trailing partial line. A watcher starts at the file's current end, never at zero, or
attaching to a running session would replay its whole history as though it were happening now.
The reconcile pass is what attaches a watcher, so the launch path runs one the moment it binds a new
session to its transcript (`tickSoon` on the Mac, `reconcileSoon` in pi-desk) rather than leaving it to
the next interval: a 30s tick is as long as the hub waits for a launch's first frame
(`unconfirmedThread`, § 12), and a session noticed late is reported as empty. The watcher's first append
backfills the turn in progress from its start (`loadPrefix`), so nothing written before it attached is lost.

**The tick still does both of these jobs**, deliberately. Liveness
cannot be event-driven — nothing fires when a process stops existing — and `fs.watch` genuinely drops
events, since FSEvents coalesces on macOS and inotify misses under load. So the tick is the net, not
the mechanism. That includes the reply's phone notification: a tick that reads a finished turn newer
than the one the row records (and newer than the row itself, so a resume's inherited history does not
count) reports it with `reportTurnEnd`, the watcher's own call, and the hub pushes each turn once. The same is true one layer up: the wall keeps a 5-MINUTE poll of `/api/sessions` behind the
push, and only as a net. `desk_sessions` and `desk_pins` are in the realtime
publication (data-layer migration `00104`), so a session dying, the focus moving and the numbering
changing do announce themselves — each pushes a fresh payload (`pushSessions` in the hub), built
by the same function that answers the endpoint so the two cannot disagree.

### A hub dispatch answers back once

A session started from the hub conversation posts its **first** finished reply into that thread, so
a question asked from the watch is answered on the watch. `voice-pipeline/orchestrator/src/relay.js`
does it on both machines, called from the watcher's `end_turn` and from the tick as the net:

    start_session (voice worker's data MCP, DATA_CALLER=hub) ─▶ desk_commands.payload.relay = true
    first end_turn ─▶ relayFirstReply ─▶ voice_messages {session_id, session_label} ─▶ thread

The push for that reply is the hub's, not the relay's: every session's finished reply is a notification
(HUB-INTERNALS §6b, `notifySessionReply`), and a second one from here would buzz twice.

Only that first reply. After it the session is an ordinary one: the user reads it where it runs and
answers it with a follow-up, and a reply to the relayed message in the thread is a fresh hub command.
`voice_messages.session_id` is unique, so the watcher and the tick can both fire without a duplicate.
A session any other agent dispatches has no `relay` flag and stays out of the thread.

## 11. Where it is surfaced

| surface | what it shows | interaction |
|---|---|---|
| phone pane (`cards/repos.js`) | everything: running, parked, numbers, machine, last reply | full — start, name, transfer, resume, close |
| the wall's footer (`cards/deskfoot.js`) | only the shown session | none |
| **TV session focus** (`/tv-session-focus`) | the running sessions as tabs, and the shown one's reply | none — voice only |
| the home wall (`/tv`, `tv-home.js`) | three, the pinned one first and then most recently active, each with a live line of what it is doing; the shown one's full reply below | none — voice only |
| the watch (`SessionsView`) | every running and parked one, live off the `sessions` frames | open a session; a follow-up is always locked until the next press |
| voice (`get_sessions`, `read_session`) | the numbered list, and what each last said (the turn's one-sentence summary from `desk_turns.summary`, else the reply's first 200 characters); `read_session` gives one session's recent turns in full | every verb |
| the hub conversation (web `.ai-msg-session`, watch tint) | a hub-dispatched session's first reply, tinted and named by its label | reply is a fresh command |

A Codex session is outlined blue on a dark blue ground in every list above that draws rows (phone, both
walls, the watch) and framed blue while open, the treatment an incident run gets in red. The hub
decides it (`codex` on each row and on `/api/sessions/:id`), and an incident outranks it.

The phone card is the complex one and stays that way — it is the surface with a keyboard and a
pointer. Everything else is glanceable and driven by voice, which is why sessions need numbers and
names that can be said out loud.

## 12. Checking it is alive

Function, not liveness — ask it to do something and see whether it did:

    # both consumers beating (stale = down)
    curl -s "$SUPABASE_URL/rest/v1/worker_presence?select=worker,last_seen" -H "apikey: $KEY"

    # every running claude is on the wall as itself — exits 1 naming any mismatch, including a
    # Claude Code update that changed the ~/.claude/sessions record the machines read
    node ~/repos/voice-pipeline/orchestrator/check-sessions.mjs      # Pi: ~/voice-pipeline/…

    # what is running, and what each last said
    #   by voice: "what sessions are running"     by hand: GET /api/sessions

    # end to end, without SSH: dispatch a session and read its reply back
    #   "start a session in status-hub and reply with just: ready"

Two checks report on their own, to the ops responder:

- **A session never opens empty, and its host confirms it.** `GET /api/sessions/:id`, which every
  surface opens a session through, puts the row's launch prompt in an empty thread (`seedLaunch` in
  `server/routes/conversation.js`), so a session is never a blank page while it starts; the host's own
  copy of that prompt replaces the stand-in, matched by the dispatch command id or by its text starting
  with the stand-in's (the stored prompt can be a cut-down copy, and a replayed prompt has no command id;
  `echoesLaunch` in `server/lib/outcomes.js`). The route reports once per conversation when the thread
  still holds nothing from the host 30s after `started` although the row was told something
  (`unconfirmedThread`). A session launched before the hub process started is not checked: the thread is
  in memory, so after a deploy a turn in flight is back only when the host's next frame replays it, which
  can be minutes away inside a long tool call. Claude Code
  writes a launch prompt within about a second of the row, so that is a session every surface draws as
  its prompt and then nothing.
- **A turn in flight has its transcript.** The Mac's desk tick (voice-pipeline
  `orchestrator/src/deskSessions.js`) reports a session busy for over 15s whose `transcript_path` does
  not exist. Claude Code names a project directory by turning every character that is not a letter or
  digit into a dash (`projectDir` in `orchestrator/src/transcripts.js`); a path built any other way
  points at nothing, and every reader then sees an empty session.
