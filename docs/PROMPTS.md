# Permission prompts on the phone and the watch

A Claude session blocked on a permission dialog is pushed to the phone and the watch with **Approve**
and **Deny**, and the button answers the dialog. Every session on the Mac and the Pi, whoever opened it.

## The path

1. Claude Code shows the dialog and runs the `PermissionRequest` hook, `bin/permission-hook`, wired in
   claude-config's `mac/settings.json` and `pi/settings.json` (30-minute hook timeout). The dialog stays
   on screen the whole time: a key pressed in the terminal still answers it first.
2. The hook waits `PROMPT_PUSH_DELAY_MS` (10s). A dialog answered at the keyboard inside that never
   reaches the phone, so sitting at the Mac does not buzz the wrist.
3. It reports the dialog — `POST /api/session-prompts` with the conversation id, tool and input. The hub
   (`server/routes/prompts.js`) finds the RESIDENT `desk_sessions` row for that conversation and pushes
   `kind: 'prompt'`, category `SESSION_PROMPT`: titled with the session's name, the body the tool and
   its command / path / URL. No row means nobody to ask on its behalf (a headless SDK client, a
   subagent): 404, and the hook leaves the dialog alone.
4. The hook holds `GET /api/session-prompts/:id?wait=45` open, again and again, until a decision lands.
   It is a held request answered by the button press, not a poll: the hub settles every waiter the
   moment `POST /api/session-prompts/:id/decide` arrives.
5. The hook prints `{"behavior":"allow"}` or `deny`, and Claude Code acts on it.

The phone (`apps/Sources/Push.swift`) and the watch (`StatusHubWatchApp.swift`) register the same
category; each posts the decision itself as a background action. Tapping the banner opens the session.

## Things that are not obvious

- **Claude Code does not stop the hook when the dialog is answered at the keyboard.** It lets it run and
  ignores what it prints. So the hook watches the session's record (`~/.claude/sessions/<pid>.json`)
  with `fs.watch`, and the moment it stops saying `waiting` it posts `decision: 'gone'` and exits —
  which is what makes a later tap on a stale notification a no-op. Only a machine (the device token)
  may say `gone`.
- **Never answer the dialog with keystrokes.** It is the obvious route — the orchestrator already types
  follow-ups into ttys — and on the Mac it cannot deny: Terminal's `do script` appends a return to
  whatever it types, and a return in that dialog selects "Yes". Escape, Ctrl-C and four down-arrows,
  each followed by that return, were all tried against a live dialog and every one APPROVED it. Number
  keys are no better: option 2 is "No" on a two-option dialog and "Yes, and don't ask again" on a
  three-option one.
- **The first decision stands.** A second tap, from the other device or the same one, returns the
  first answer with `already: true`.
- **Prompts live in the hub's memory.** One per waiting hook, and the hub is one Fly machine. A deploy
  drops them: each hook's next request gets a 404, it exits printing nothing, and the dialog is left for
  the terminal. Nothing is lost that was not already waiting on a person.
- **Not gated by Settings → Push.** That switch is for replies; a blocked session is stalled until
  someone answers it.
- **Every failure prints nothing.** No token, hub unreachable, unknown session, timed out: the dialog
  behaves exactly as it would with no hook.

The notification carries no sentence of its own — the title is the session's name and the body is the
call itself. Any wording beyond that is Jared's to write.
