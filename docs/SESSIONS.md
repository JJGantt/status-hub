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
- **Never drops** an instruction. Anything that cannot run is kept, whole, for a later decision.

Everything below serves one of those five.

---

## 2. The pieces

```
     voice ──┐
     phone ──┼──▶  desk_commands  ──realtime──▶  orchestrator (Mac)   ──▶  Terminal tab
    the hub ─┘        (the queue)                pi-desk       (Pi)   ──▶  tmux session
                                                      │
                            both publish, both read   ▼
                                                desk_sessions ──▶ phone pane, TV strip, MCP tools
```

The hub runs on Fly and can reach neither machine. **Supabase is the only bus**, in both directions:
work goes out as rows in `desk_commands`, state comes back as rows in `desk_sessions`. Nothing
depends on SSH or on being on the same network — demonstrated the hard way on 2026-08-28, when mDNS
stopped resolving the Pi from the Mac and the whole system kept working, including doing a
config change ON the Pi by dispatching a session to it.

| Piece | Where | Does |
|---|---|---|
| `orchestrator/src/commands.js` | Mac (launchd) | drains the queue, opens Terminal tabs |
| `orchestrator/src/deskSessions.js` | Mac, every 30s | adopts, reports liveness, mirrors, starts watchers |
| `orchestrator/src/sessionWatch.js` | both, on file events | watches live transcripts: pushes tool calls + finished turns |
| `orchestrator/src/discover.js` | both | which conversation each `claude` process is in, from Claude Code's own record |
| `orchestrator/src/mirror.js` | both | uploads/downloads transcripts for a handover |
| `orchestrator/src/transcripts.js` | both | reads a transcript: final reply, working, title |
| `pi-desk/index.js` | Pi (systemd) | the same, plus residency limits and retention |
| `data-layer/src/desk.ts` | wherever the MCP runs | the verbs, as tools |
| `status-hub/server.js` | Fly | the API and the pane |

---

## 3. The data

### `desk_sessions` — one row per session

| column | meaning |
|---|---|
| `id` | the tmux name (`hub-<repo>-<ts>`) on the Pi, `mac-<cmd8>` on the Mac |
| `worker` | `pi-desk` or `desk` — which machine owns it |
| `origin` | `dispatched` (we started it) or `adopted` (Jared did) |
| `repo` / `label` | where it runs, and what it is called |
| `status` | see below |
| `claude_session_id` / `transcript_path` | the conversation, and where to read it. **This is the session's identity**: a resume makes a new row for the same conversation and `claude --resume` keeps this id, so the tools' permanent handle is `s-` plus its first eight characters (`sessionHandle` in data-layer), never the row `id` |
| `pid` | the Claude Code process the row belongs to — what liveness and the conversation are read from |
| `tty` | Mac only: the Terminal tab, and the handle a follow-up is typed into |
| `working` / `last_reply` / `reply_at` | is a turn in flight; the last COMPLETED answer, and when |
| `last_prompt` | the prompt that answer was to. A long message is recorded as `<pasted_content>…</pasted_content>` (how it was pasted in, voice-pipeline `handoff.js`), and `resolvePrompt` in the orchestrator's transcripts.js strips that back to his words. Turns recorded earlier hold a stub naming a file in `~/.claude-desk-prompts`, which the same function resolves until the file is swept at thirty days. Earlier turns are kept in `desk_turns`, by trigger (HUB-INTERNALS § The turns before the last one) |
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
| `transferred` | handed to the other machine, which continues it under its own row | no, follow the new row |

### The other tables

- **`desk_commands`** — the queue. `pending → running → done | error | expired`, with `claimed_by`
  so a machine can sweep only its own abandoned claims.
- **`desk_focus`** — a single row holding the pin (`session_id`, set by `focus_session`) and the
  dispatch still opening (`command_id`). Unpinned, focus is computed from `active_at`, not stored here.
- **`desk_queue`** — Pi only: work neither machine can take yet — the Pi has no memory to spare and the
  Mac is asleep — new sessions and resumes alike (`resume_id` names the conversation a resume
  continues). Never expires (unlike a command). When the Mac wakes, the next pass hands it there.
- **`desk_dead_letters`** — everything that could not run, with its whole payload.
- **`transcripts` bucket** — mirrored transcript tails, `<claude_session_id>/<offset>.part`. A
  conversation's parts are cleared in BOTH places that abandon it: when retention forgets the session,
  and when a `/clear` rebinds the row to a new conversation. The second one is easy to miss — from that
  instant the old parts are unreachable (the mirror is keyed by conversation id and the row now names a
  different one), and retention will never reach them either.

---

## 4. How a session gets here

**Dispatched.** `start_session` (voice) or the repo picker (phone) writes `open_session`. The target
machine claims it, pulls the repo, launches with `--remote-control`, and publishes the row as the most
recently active session. The Pi clones from GitHub if it has no checkout; the Mac uses the one it has.

**A dispatched session is told it IS the dispatch.** Its prompt is his words, and those can still begin
"start a session in X and have it…" when the router leaves the addressing in — which the new session
reads as an order and dispatches the same request again. So a fresh launch with a prompt carries
`voice-pipeline/orchestrator/dispatched-session.txt` as `--append-system-prompt` (both launchers read
that one file; a system prompt so every surface still shows only his words), and `start_session`
refuses a prompt the calling session was itself started with (`desk.redispatch`, keyed on
`HUB_SESSION_ID`, which only the launchers set).

**The model is named at launch on both machines** — `DESK_MODEL` in the orchestrator's config, and
`PI_DESK_MODEL` in pi-desk's `launch.sh`, both opus. Left to settings, a session takes whatever
`/model` last wrote to `~/.claude/settings.json`, and a wrong value there is invisible from an
interactive session in the home directory: `~/.claude/settings.local.json` is also the PROJECT
settings file for the project rooted at `~`, so it outranks the machine default for exactly the
sessions Jared opens himself, and for none of the ones dispatched into a repo.

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

Inferring the transcript from outside — birth times, the newest file in a project directory — is
what this used to do, and it cannot be made safe: every session opened in the home directory shares
one project directory, so each new session looked like a `/clear` in every older one. The Mac logged
336 rebinds against 42 adoptions that way, and rows were shown saying each other's words.

The Pi adopts nothing: sessions there are launched by `pi-desk` or they do not exist, unless Jared
attaches to tmux over SSH and starts one by hand, which is not tracked.

---

## 5. The verbs

| tool / action | who claims it | what happens |
|---|---|---|
| `start_session` | target machine | pull, launch, publish the row |
| `focus_session` | — | pins the follow-up pointer to a session that already exists |
| `unfocus_session` | — | releases the pin: follow-ups go to the most recently active session again |
| `follow_up` | machine owning the target session | text typed into the live session, busy or not; the target is the session he NAMED (`session` param), else the focused one. A named parked session is resumed with the words instead. Naming leaves the pin alone |
| `rename_session` | owning machine | `/rename <name>` typed in — the session renames itself |
| `end_session` | owning machine | close the tab / tmux session, park the row |
| `resume_session` | owning machine | `claude --resume <id>` in a new tab or tmux session, with an optional prompt; a Pi with no memory to spare hands it to the Mac with its conversation, like new work (§ Capacity). Aimed at a session that is still running, both machines type the prompt into it |
| `transfer_session` | machine GIVING IT UP | close, flush the mirror, ask the other to resume |
| `get_sessions` | — | the numbered list |

The hub's `POST /api/sessions/followup` (the watch's and the phone's session view) is `follow_up` addressed by session
id instead of by focus, and for a parked session it writes `resume_session` with the words as the
prompt instead — HUB-INTERNALS §6b.

`start_session`, `follow_up`, `resume_session` and `end_session` answer only once the machine has marked the command
`done` or `error` (`dispatchConfirmed` in data-layer, a realtime subscription opened before the
insert, up to 20s; past that the tool says it is unconfirmed, never sent). An insert always succeeds, so
answering at insert time reports delivery for commands the machine then refuses. For
`start_session` and `resume_session` the verdict also says whether the session LAUNCHED or was QUEUED (the
Pi's detail starts `queued`), and the tool says which — a queued session is not a started one. A Pi
detail of `handed to the Mac as <id>` is not a verdict either: `followHandoff` waits on that Mac command
and reports where the session really started.

### Focus — how a session gets spoken to

The session a spoken follow-up lands in — and the one the pane, the strip and the home wall show as
focused — is decided in this order, by `focusedSession` in `data-layer/src/desk.ts` and `pickFocus` in
the hub, which must agree:

1. **A session focused by name** (`focus_session`: "focus the status-hub session" — "pin" is the same
   verb), while it runs. It holds until he focuses another, releases it (`unfocus_session`: "unfocus",
   "unpin", "take the pin off", "go back to automatic"), dispatches
   new work, or it closes. "Focus the latest session" is a pin like any other — of whichever session
   is newest at that moment — which is why going back to automatic is a separate verb: when one tool
   did both, "latest" could be read either way.
2. **A dispatch whose session has not opened yet** (`desk_focus.command_id`, while that command is
   pending or running). Words said in those seconds are meant for it, so a follow-up is saved rather
   than sent to whatever was active a moment before.
3. **Otherwise the most recently active running session** (`active_at`), on either machine.

3 includes the session he is typing in at his keyboard. It used to be excluded, to keep dictation out
of the session he was typing in; that trade was reversed deliberately — the session he last used is the
one he means — and ambient speech is guarded where it always was, by `follow_up` demanding a handoff.

A pinned session carries a pin on every surface that shows focus — the home wall, the sessions wall,
the footer strip, the phone pane — and automatic focus carries none, because a pin stays put while
other sessions take turns. `/api/sessions` returns `pinned` beside `focus` for exactly this.

**Focusing is itself a handoff.** On a room-mic turn `follow_up` demands an explicit phrase ("send a
follow-up", "tell it to"), because the mic hears the whole room and forwarding ambient speech into a
session is the failure that rule prevents. On a deliberate turn (watch, phone, typed, the ESP's wake
word) a reply that plainly answers a session's message posted in the thread is a handoff too: the
worker names those messages by session in the replayed thread, and the model sends the reply there. Naming a session removes the ambiguity, so everything said after a
focus in the same turn goes to that session with no phrase required. That is the point: he talks to
it as though it were the same assistant he always talks to, says "you" about things another session
said, and never has to think about the handoff happening underneath.

The addressing directive in `worker.py` carries the same rule, and it has to: it tells the model that
development talk naming no destination belongs to a session that has already heard him. After a
focus, the destination IS named.

### Naming, in order of authority

1. **A name Jared chose** — `/rename <name>`, or ctrl-R in the session picker. Both make Claude Code
   write a `custom-title` record into the transcript, which the reconcile tick reads back.
2. **The router's label** — the few words `start_session` wrote at dispatch, naming the job.
3. **Claude Code's generated title** — for a session nobody dispatched and nobody named.

Generated titles describe content, so **two sessions doing similar work get the same name**: `'Pull
day workout log'` titles nineteen transcripts here. Naming one is the only way to tell them apart.

Renaming from the hub sends `/rename` into the live session rather than writing the record directly.
Both were tested: writing the record works for everything that READS the transcript, but the running
session never re-reads its own file, so its terminal tab keeps the old title.

### Numbering

Active sessions, **most recently active first, running and parked interleaved, numbered from 1** — which
is to say: the position in the list on screen. That is where "the second session" comes from; he reads
it off a surface and says it, and `get_sessions` hands the agent the same list in the same order.
**Parking is not activity**: a session evicted to free the Pi or replaced by a dispatch keeps the place
its last turn earned. Grouping running above parked is the attractive alternative and it breaks the list
— every eviction shoves a session below everything still open, however recently it was used. Every
surface therefore draws the rows in `n` order rather than the payload's `resident` then `evicted`, since
drawing those one after the other would print the numbers out of sequence. The rule is
implemented twice — `numberSessions` in `data-layer/src/desk.ts` and in `/api/sessions` — and **the
two must agree**, or "session three" means one thing to the pane and another to the voice tools.
**One entry per conversation**: rows sharing a `claude_session_id` are earlier stretches of one
session, so only the first after sorting is listed or numbered — the running row, else the most
recently active. Both copies apply that too.

**It is ordered by `active_at`, the last turn boundary** — a prompt sent or a turn finished. `last_seen`
was the obvious reading of "most recent" and it made the numbers unusable: every row was touched by its
reconcile tick every 30s, so the order reshuffled between two reads seconds apart — measured, and caught
when "focus the first session" landed on a session that had become first while the sentence was being
processed. `started` cured that and left a session in active use below newer idle ones. `active_at`
moves only when a session starts or finishes a turn, never on a tick, so a number said out loud can
still change before it is resolved — but only if a session does something in those few seconds.

A session can be named three ways, and `resolveSession` takes any of them: **the number** (digits or
spoken — "3", "fifth", "the third session"), **the repo** ("status-hub"), or **words from its name**
("golf", "session management"). Running sessions are matched first and the full list is only the
fallback, because parked ones linger for a fortnight and otherwise crowd every name — "golf" matched
a live session and a closed one from days ago; "status-hub" matched twelve. An ambiguous name is
still answered with the numbered choices rather than a guess.

Nothing about this is known to the SESSION itself. A session has no idea it is number three; the
number is computed when the list is read, from the rows, by whoever is reading.

The number is a POSITION, not identity: closing one renumbers the rest. That is what keeps the list
1..N over what is actually open, instead of counting upward for ever.

---

## 6. Moving a session between machines

A session is an append-only transcript plus a working directory, so moving one is copying the file
and resuming it. Proven before it was built: a Mac transcript resumed on the Pi with every absolute
path rewritten to the Pi's home, same session id, full recall of the conversation.

- **Mirroring** runs at the end of every turn, on both machines — the only moment a transcript is a
  complete thought. Only the tail is uploaded; one transcript here is 16MB and a turn adds tens of KB.
- **The rewrite** is the home directory: `/Users/jaredgantt` ↔ `/home/jaredgantt`. Without it the
  resumed session points at a directory that does not exist.
- **A transfer is claimed by the machine giving the session up.** It closes the session, flushes the
  last of the mirror, and only then asks the destination to resume.
- **When the source is unreachable** there is nothing to close and nothing left to flush, so the
  destination resumes from the mirror as of the last completed turn. That is the case the whole
  mechanism exists for: the laptop is shut and the work should carry on.

---

## 7. Invariants — the things that must not be broken

**One writer per transcript.** `claude --resume` on a transcript that is live elsewhere does not
reattach; it starts a second process replaying the same file, and the two diverge with one id between
them. Measured: the Pi's resume appended 16 records the Mac's copy never saw. Every path that resumes
closes the other side first, and the hub asks about the conversation before it resumes one
(`conversationNow`, HUB-INTERNALS §6b): a resume makes a new row and leaves the parked one parked, so
without that check a follow-up or a resume of the old row would start a second process on a
conversation already running again under the new one.

**`desk_focus` is written only by Jared's intent.** A dispatch, a resume and a dead-letter retry write
its `command_id`; `focus_session` writes its `session_id`; `unfocus_session` clears both. Adoption and
the reconcile ticks never touch
it — unpinned, focus is COMPUTED from activity, not stored. Every surface resolves it by the same rule,
and only a RESIDENT session can hold it, because that is what `follow_up` can actually reach.

**Nothing spoken is ever dropped.** The queue has no way to fail — a command for a sleeping machine
is claimed by nobody and expires unread — so every entry point checks the machine is beating BEFORE
writing, and anything that still fails is kept whole in `desk_dead_letters`. A new session also needs
the machine's `/login` alive (its heartbeat publishes the expiry): when the chosen machine is down or
expired it goes to the other one, the tool result says so and why, and an expired login starts one
session in the `health` repo to renew it (`health/runbooks/claude-login.md`). When both are out, it goes
to the Fly session machine (`fly-desk`, worker `fly-desk`, shown as `Fly`): stopped until a request to
its `/wake` starts it, no browser and no Remote Control, and the hub wakes it the same way before a
follow-up, resume or close aimed at one of its sessions (voice-pipeline `fly-desk/README.md`). It is deliberately not a
retry queue: work that could not run when it was asked for has usually stopped being wanted.

**A shell's command line takes 1024 bytes.** That is the tty's canonical-mode limit, and past it the
rest is dropped silently, so a launch prompt goes through a file the shell reads. A RUNNING session
holds its tty raw and has no such limit — 20,000 characters arrived intact — so follow-ups are typed
straight in. The Pi has neither limit; tmux carries any length.

**One utterance, one command.** Two mics endpoint at different pauses, so one spoken thing arrives as
several rows. Nothing is claimed while any mic still reports hearing him, and among the captures of
one utterance the longest transcript wins. Without this, a mid-sentence fragment ran as a command and
the complete capture was discarded as its duplicate.

---

## 8. Numbers

| | value | why |
|---|---|---|
| reconcile tick | 30s | both machines: liveness, mirror, and the BACKSTOP for last reply. **It writes only what changed** — an unconditional rewrite per resident row per tick was ~19k writes/day against ~6 sessions a day that did anything, and now that `desk_sessions` is published to realtime each such write is also a broadcast to every open screen. `last_seen` rides along with a real change or refreshes every 10 min; its only consumer is the 14-day sweep over parked rows, whose stamp freezes at eviction |
| session watch | on file events | `sessionWatch.js`: tool calls and finished turns, pushed as they land |
| `COMMAND_TTL_S` | 120s | a command older than this expires unrun (and is kept) |
| `CLAIM_STALE_S` | 900s | a claim held this long is treated as abandoned |
| `LAUNCH_GRACE_S` | 90s | a new session is not declared dead before this — and a row binds only a process that started within this of the row (Mac), which is what keeps a later `claude` in the same tab off an older row |
| `MIC_QUIET_S` | 2.5s | every mic silent this long before a command is claimed |
| `PI_DESK_SESSION_BUDGET_MB` / `_MAX_MB` | 800 / 1200 | Pi only: a session's `memory.high` (over it with anon memory = heavy work, moved to the Mac) and `memory.max` |
| `PI_DESK_RESERVE_MB` / `MAX_SWAP_PCT` | 300 / 70 | Pi only: free memory kept beyond every session's budget, and the swap ceiling, for admission |
| retention | 7 / 14 / 30 / 7 days | closed sessions / parked / command log / raw captures |

---

### Capacity

**The Pi is not for memory-heavy work.** It has no session count; memory is the one limit, and it is
enforced per session (`pi-desk/cgroups.js`). `pi-desk.service` is delegated (`Delegate=yes`,
`DelegateSubgroup=supervisor`): the daemon and tmux server sit in `supervisor/`, and each session in
`s/<tmux-name>/`, which `launch.sh` joins before exec'ing claude, so claude, its tool servers and every
command it runs are charged there.

- **Admission** (`makeRoom` / `shortfall`): a new session or resume starts on the Pi only if
  MemAvailable covers its whole budget, plus what every running session has left before reaching its
  own budget, plus the reserve — sessions grow after launch, so room is counted against budgets, not
  current use. Otherwise idle sessions are parked, least recently active first, until it fits; with
  every resident mid-turn the work goes to the Mac (a fresh `open_session`, or a resume through the
  transfer path with its prompt); only with the Mac asleep does it wait in `desk_queue`.
- **Heavy work moves** (`onHeavy`): the kernel rewrites a session's `memory.events` when it crosses
  `memory.high`, and inotify delivers that. If its anon memory (resident plus swapped) is over budget,
  the session is closed, everything in its cgroup is killed, and it resumes on the Mac with a system
  note (`orchestrator/moved-session.txt`) saying why. Waiting for the turn to end is not possible: the
  turn IS the heavy work. Whether a turn is restarted there depends on the process's own record, read
  before it is closed (`busy`, not `waiting`):
  - **mid-turn**: restarted with the prompt `[Moved from the Pi]`, and the note says the cut-off step
    is redone. The prompt must never be a word like `Continue`: it lands as the answer to whatever the
    conversation last said, and a session that had just proposed something would take it as approval.
    Closing it sends C-c, which Claude Code records as Jared rejecting the step in flight ("The user
    doesn't want to proceed... STOP what you are doing and wait") plus "[Request interrupted by user for
    tool use]". Those records outrank the note, so the session obeys them and stops. The Mac's
    `mirrorDown` therefore rewrites them in the cut-off turn (`unmarkMoveInterrupt` in
    `voice-pipeline/orchestrator/src/mirror.js`) to say the move cut the step off and to run it again.
  - **between turns** (a background job it left running grew after the turn ended, possibly on a
    question to Jared): resumed idle, no prompt at all, so it waits for him on the Mac.

  With the Mac asleep it stays, with `memory.high` lifted so it is not throttled.
- **A kill takes the command, not the session.** `tool.sh` is `CLAUDE_CODE_SHELL_PREFIX`: every Bash
  command and tool server runs at `oom_score_adj` 1000, above claude's 800 and the kiosk's -500, so at
  a session's `memory.max` or a machine-wide OOM the kernel picks the command.
- **Cleanup.** Closing a session (`evict`) kills its cgroup, so nothing it started outlives it. At
  startup, anything in the unit not descended from a live session, the daemon or the tmux server is
  killed as a leftover.
- Sessions are told in their system prompt (`pi-desk/pi-session.txt`) to run heavy work on the Mac
  over SSH.

A per-session `memory.high` crossing also counts page-cache reclaim, so a crossing acts only on anon
memory over budget. A process moved into a cgroup leaves its existing memory charged where it was, so
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

A turn's reply is written to the transcript the instant Claude Code finishes it, and for a long time
nothing noticed until the next reconcile tick — up to 30s of an answer sitting on disk while a wall
showed the previous one. The file changing is an event, so `sessionWatch.js` watches it on both
machines and pushes what it sees straight to the hub:

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

    /api/session-activity ─▶ ONE EVENT of the conversation's list (server.js `logFrame`: prompt, tool,
                             text, reply, each with a seq and an id) ─▶ SSE `ev` ─▶ watch, phone, wall

    Each event carries its turn and its position in it. A hub missing part of the turn (it restarted)
    answers `{ replay, have }` and the host re-sends from there, so the list's order is the transcript's.

    Every surface draws that list and nothing else (HUB-INTERNALS.md § The conversation as one list).

Note that the database write is no longer in the delivery path. It still happens, because the reply
has to outlive the moment, but the wall hears from the machine that has the answer rather than
waiting for a round trip through Postgres.

Only what is NEW is read — these transcripts reach tens of megabytes, so the watcher keeps a byte
offset and a trailing partial line. A watcher starts at the file's current end, never at zero, or
attaching to a running session would replay its whole history as though it were happening now.

**The tick still does both of these jobs**, and that is deliberate rather than leftover. Liveness
cannot be event-driven — nothing fires when a process stops existing — and `fs.watch` genuinely drops
events, since FSEvents coalesces on macOS and inotify misses under load. So the tick is the net, not
the mechanism. That includes the reply's phone notification: a tick that reads a finished turn newer
than the one the row records (and newer than the row itself, so a resume's inherited history does not
count) reports it with `reportTurnEnd`, the watcher's own call, and the hub pushes each turn once. The same is true one layer up: the wall keeps a 5-MINUTE poll of `/api/sessions` behind the
push, and only as a net. `desk_sessions`, `desk_queue` and `desk_focus` are in the realtime
publication (data-layer migration `00104`), so a session dying, the focus moving and the numbering
changing now do announce themselves — each pushes a fresh payload (`pushSessions` in the hub), built
by the same function that answers the endpoint so the two cannot disagree.

### A hub dispatch answers back once

A session started from the hub conversation posts its **first** finished reply into that thread, so
a question asked from the watch is answered on the watch. `voice-pipeline/orchestrator/src/relay.js`
does it on both machines, called from the watcher's `end_turn` and from the tick as the net:

    start_session (voice worker's data MCP, DATA_CALLER=hub) ─▶ desk_commands.payload.relay = true
    first end_turn ─▶ relayFirstReply ─▶ voice_messages {session_id, session_label} ─▶ thread

The push for that reply is the hub's, not the relay's: every session's finished reply is a notification
(HUB-INTERNALS §6b, `notifySessionReply`), and a second one from here would buzz twice.

Only that first reply. After it the session is an ordinary one: Jared reads it where it runs and
answers it with a follow-up, and a reply to the relayed message in the thread is a fresh hub command.
`voice_messages.session_id` is unique, so the watcher and the tick can both fire without a duplicate.
A session any other agent dispatches has no `relay` flag and stays out of the thread.

## 11. Where it is surfaced

| surface | what it shows | interaction |
|---|---|---|
| phone pane (`cards/repos.js`) | everything: running, parked, queued, numbers, machine, last reply | full — start, name, transfer, resume, close |
| the wall's footer (`cards/deskfoot.js`) | only the session holding follow-ups | none |
| **TV session focus** (`/tv-session-focus`) | the running sessions as tabs, and the focused one's reply | none — voice only |
| the home wall (`/tv`, `tv-home.js`) | three, most recently active first, each with a live line of what it is doing; the focused one's full reply below | none — voice only |
| the watch (`SessionsView`) | queued sessions on top, then every running and parked one, live off the `sessions` frames | open a session; a follow-up is always locked until the next press |
| voice (`get_sessions`) | the numbered list, and what each last said (the turn's one-sentence summary from `desk_turns.summary`, else the reply's first 200 characters) | every verb |
| the hub conversation (web `.ai-msg-session`, watch tint) | a hub-dispatched session's first reply, tinted and named by its label | reply is a fresh command |

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

The full lifecycle was exercised this way on 2026-08-28 — launch, close, resume, rename, close on the
Mac; launch, rename, read the name back, close on the Pi — plus a Pi→Mac transfer that carried a
phrase only the Pi had been told.
