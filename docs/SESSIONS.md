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
| `orchestrator/src/deskSessions.js` | Mac, every 30s | adopts, reports liveness + last reply, mirrors |
| `orchestrator/src/discover.js` | Mac | finds sessions nobody dispatched |
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
| `claude_session_id` / `transcript_path` | the conversation, and where to read it |
| `tty` | Mac only: the Terminal tab, and the handle a follow-up is typed into |
| `working` / `last_reply` / `reply_at` | is a turn in flight; the last COMPLETED answer, and when |
| `mirror_offset` / `mirror_at` | how much of the transcript is in the `transcripts` bucket |
| `command_id` | the dispatch that created it — how a follow-up resolves its target |

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
- **`desk_focus`** — a single row naming the dispatch a spoken follow-up belongs to.
- **`desk_queue`** — Pi only: work waiting for a residency slot. Never expires (unlike a command).
- **`desk_dead_letters`** — everything that could not run, with its whole payload.
- **`transcripts` bucket** — mirrored transcript tails, `<claude_session_id>/<offset>.part`.

---

## 4. How a session gets here

**Dispatched.** `start_session` (voice) or the repo picker (phone) writes `open_session`. The target
machine claims it, pulls the repo, launches with `--remote-control`, and publishes the row. The Pi
clones from GitHub if it has no checkout; the Mac uses the one it has.

**Adopted.** Every 30s the Mac lists `claude` processes that have a controlling tty — which excludes
the worker's headless `claude -p` and the MCP children — finds each one's working directory with
`lsof`, and matches it to a transcript. **The match is by birth order**: processes oldest-first, each
taking the earliest unclaimed transcript in its project directory born within three minutes of its
start. "Newest transcript since this process started" is what the LAUNCH path uses safely (it looks
the instant it launches) and is wrong here — two live sessions in one repo both claimed the same file
when tried, and each was then reported saying the other's words. No confident match means no row.

The Pi adopts nothing: sessions there are launched by `pi-desk` or they do not exist, unless Jared
attaches to tmux over SSH and starts one by hand, which is not tracked.

---

## 5. The verbs

| tool / action | who claims it | what happens |
|---|---|---|
| `start_session` | target machine | pull, launch, publish the row |
| `focus_session` | — | points the follow-up pointer at a session that already exists |
| `follow_up` | machine owning the focused session | text typed into the live session |
| `rename_session` | owning machine | `/rename <name>` typed in — the session renames itself |
| `end_session` | owning machine | close the tab / tmux session, park the row |
| `resume_session` | owning machine | `claude --resume <id>` in a new tab or tmux session |
| `transfer_session` | machine GIVING IT UP | close, flush the mirror, ask the other to resume |
| `get_sessions` | — | the numbered list |

All seven are on the fast path (`SAFE_TOOLS`): they route prompts and manage what is running, and
none of them invents a value.

### Focus — how a session gets spoken to

`desk_focus` has two sources and they mean different things:

- **`command_id`** — set automatically by a dispatch. "Start a session in X" points the follow-up
  there, because that is obviously what he is now talking to.
- **`session_id`** — set by `focus_session`, deliberately: "focus the status-hub session". It CLEARS
  `command_id` and wins over it everywhere the pointer is read.

Focusing is what makes voice-only surfaces work. Without it the pointer only ever named the last
dispatch, so there was no way to go back to something — and on a wall or a watch there is no other
way to say which of five sessions is meant.

**Focusing is itself a handoff.** `follow_up` normally demands an explicit phrase ("send a follow-up",
"tell it to"), because the mic hears the whole room and forwarding ambient speech into a session is
the failure that rule prevents. Naming a session removes the ambiguity, so everything said after a
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

Active sessions (resident + evicted), **most recent first, numbered from 1**. The rule is implemented
twice — `numberSessions` in `data-layer/src/desk.ts` and in `/api/sessions` — and **the two must
agree**, or "session three" means one thing to the pane and another to the voice tools. Ordering by
`last_seen` also floats running sessions above parked ones without a second rule.

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
closes the other side first.

**The follow-up pointer moves only on a dispatch.** `desk_focus` is set by `start_session`, by a
resume, and by a dead-letter retry — never by adoption, never by "the most recently active session".
Jared talks to sessions at his keyboard all day; a dictated follow-up must never land in one of those.
The pane marks only a RESIDENT session as holding follow-ups, because that is what `follow_up` can
actually reach.

**Nothing spoken is ever dropped.** The queue has no way to fail — a command for a sleeping machine
is claimed by nobody and expires unread — so every entry point checks the machine is beating BEFORE
writing, and anything that still fails is kept whole in `desk_dead_letters`. It is deliberately not a
retry queue: work that could not run when it was asked for has usually stopped being wanted.

**A tty takes 1024 bytes.** Writing to a Terminal tab drops everything past that, silently. Launch
prompts therefore go through a file the shell reads; follow-ups over ~900 characters are stashed and
the session is told to read the file back. The Pi is unaffected — tmux carried 3000 characters intact.

**One utterance, one command.** Two mics endpoint at different pauses, so one spoken thing arrives as
several rows. Nothing is claimed while any mic still reports hearing him, and among the captures of
one utterance the longest transcript wins. Without this, a mid-sentence fragment ran as a command and
the complete capture was discarded as its duplicate.

---

## 8. Numbers

| | value | why |
|---|---|---|
| reconcile tick | 30s | both machines: liveness, last reply, mirror |
| `COMMAND_TTL_S` | 120s | a command older than this expires unrun (and is kept) |
| `CLAIM_STALE_S` | 900s | a claim held this long is treated as abandoned |
| `LAUNCH_GRACE_S` | 90s | a new session is not declared dead before this |
| `MIC_QUIET_S` | 2.5s | every mic silent this long before a command is claimed |
| `TTY_INPUT_MAX` | 900 | above this a follow-up goes by file |
| `RESIDENT_MAX` / `WORKING_MAX` | 3 / 2 | Pi only: memory bound, CPU bound |
| `MIN_FREE_MB` | 900 | Pi only: below this, launching would OOM the wall display |
| retention | 7 / 14 / 30 / 7 days | closed sessions / parked / command log / raw captures |

---

## 9. Known gaps

- **Sessions started by hand ON THE PI are invisible.** Adoption is Mac-only. Nothing watches for a
  `claude` someone starts over SSH.
- **The Pi does not follow a `/clear`** to the new transcript the way the Mac does. It cannot happen
  unattended — compaction stays in the same file, and only `/clear` starts a new one — so this
  matters only if Jared attaches to a tmux session and clears it himself.
- **Failed commands have no surface.** `GET /api/failures` lists them and `POST
  /api/failures/:id/{retry,dismiss}` acts on one; nothing renders it, and nothing notifies.
- **Mic handoff is not merged.** If one mic hears the first half of a sentence and another the second,
  the longer one wins and the rest is lost, rather than the two being stitched together.

---

## 10. Where it is surfaced

| surface | what it shows | interaction |
|---|---|---|
| phone pane (`cards/repos.js`) | everything: running, parked, queued, numbers, machine, last reply | full — start, name, transfer, resume, close |
| the wall's footer (`cards/deskfoot.js`) | only the session holding follow-ups | none |
| **TV session focus** (`/tv-session-focus`) | being built: the active sessions, nothing else | none — voice only |
| voice (`get_sessions`) | the numbered list, and what each last said | every verb |

The phone card is the complex one and stays that way — it is the surface with a keyboard and a
pointer. Everything else is glanceable and driven by voice, which is why sessions need numbers and
names that can be said out loud.

## 11. Checking it is alive

Function, not liveness — ask it to do something and see whether it did:

    # both consumers beating (stale = down)
    curl -s "$SUPABASE_URL/rest/v1/worker_presence?select=worker,last_seen" -H "apikey: $KEY"

    # what is running, and what each last said
    #   by voice: "what sessions are running"     by hand: GET /api/sessions

    # end to end, without SSH: dispatch a session and read its reply back
    #   "start a session in status-hub and reply with just: ready"

The full lifecycle was exercised this way on 2026-08-28 — launch, close, resume, rename, close on the
Mac; launch, rename, read the name back, close on the Pi — plus a Pi→Mac transfer that carried a
phrase only the Pi had been told.
