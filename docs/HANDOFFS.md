# Handoffs: a session hands Jared the screen it is stuck on

A session blocked on something only Jared can do (a sign-in, a 2FA code, a captcha, a choice that is
his) calls the data MCP's `request_handoff(target, note)`. He gets the screenshot on his phone and
watch; where he taps is clicked on the real screen, what he types is typed there, and a fresh
screenshot follows each action until he presses Done or Cancel. The tool call is held open the whole
time and answers with how it ended. The data side (tables, targets, the agents, the Mac's grants) is
data-layer README § Handoffs.

## The path

1. `request_handoff` inserts a `handoffs` row (`session` = the caller's `HUB_SESSION_ID`).
2. The agent on the machine that owns the target screenshots it into `shared-images` and sets the row
   `open`, `seq` 1.
3. The hub (`server/routes/handoffs.js`) hears that over realtime and:
   - pushes `kind: 'handoff'` with `handoff_id` and `session_id` (titled with the session's name, the
     body the session's note);
   - puts the handoff on its session's row (`handoff` in `/api/sessions` and `/api/sessions/:id`), as a
     permission prompt is, so the session view shows it for as long as it waits.
4. He taps or types: `POST /api/handoffs/:id/act` inserts a `handoff_actions` row; the agent acts on the
   screen, clears any typed text, screenshots, and bumps `seq`.
5. Each client holds `GET /api/handoffs/:id?after=<seq>&wait=40` open; the hub answers it the moment the
   row's `seq` passes `after` or it ends. A held request answered by the agent's update, not a poll; the
   40 s only bounds one request, and the client asks again.
6. Done or Cancel ends the row, which ends the session's held tool call.

## Where he sees it

| surface | what |
|---|---|
| phone, notification | the banner opens the tap screen (`Push.swift` → `PageLaunch.handoff` → `window.__openHandoff`) |
| phone, session view | a blue bar with the screenshot and the note (`cards/repos.js`, `paintHandoff`); a tap opens the tap screen |
| phone, tap screen | `public/handoff.js`: tap the screenshot to click; the box and Type to type; Enter, Tab, Zoom, Refresh, Cancel, Done |
| browser | `/handoff/:id`, the same tap screen as a page |
| watch | the session page's card (`handoffCard` in `SessionsView.swift`; the notification opens the session); full screen in `HandoffView.swift`: tap to click, the crown zooms, a drag pans, a double tap fits, buttons for keyboard, Enter, Refresh, Cancel, Done |

A tap is sent as fractions (0-1) of the screenshot, so it lands in the same place whatever size the
screenshot is drawn at.

## Things that are not obvious

- **What he types never reaches the session.** It goes device → hub → `handoff_actions.text` → the agent,
  which nulls it once typed. The session is told only how many times he typed.
- **The open handoffs live in the hub's memory as a cache** of the `handoffs` table, loaded at start and
  kept by realtime. Every held request reads the row itself first, so a deaf realtime channel delays an
  answer by at most one request's 40 s, never loses one.
- **The notification is sent once**, when the row first turns `open`.
