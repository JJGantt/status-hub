# Handoffs: a session hands Jared the screen it is stuck on

A session blocked on something only Jared can do (a sign-in, a 2FA code, a captcha, a choice that is
his) calls the data MCP's `request_handoff(target, note)`. He gets the screenshot on his phone and
watch; where he taps is clicked on the real screen, what he types is typed there, and a fresh
screenshot follows each action until he presses Done or Cancel. The tool call returns as soon as the
screenshot is up; when he finishes, the session is sent a follow-up saying how it ended, which starts its
next turn. Nothing waits on him in between. The data side (tables, targets, the agents, the Mac's grants) is
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
6. Done or Cancel ends the row, and the agent sends the session a follow-up (`[Handoff <id>] …`) saying
   how it ended; that message wakes the session. A tap or typing is acted on only while the screen still
   matches the screenshot it was made on (data-layer README § Handoffs); otherwise he is sent the screen as
   it is now.

## Where he sees it

| surface | what |
|---|---|
| phone, session view | a **Handoff tab** beside the conversation (`cards/repos.js`, session tabs): it opens in front when the handoff arrives, and he can switch to the Session tab to read something (a number to type) and back without losing either; the tab closes itself once the handoff ends |
| phone, notification | the banner opens the handoff's session on its Handoff tab (`Push.swift` → `PageLaunch.handoff` → `window.__openHandoff` → `__openHandoffTab`) |
| phone, tap screen | `public/handoff.js`, drawn inside the tab: tap the screenshot to click; the box and Type to type; Full/Crop, Enter, Tab, Zoom, Refresh, Cancel, Done |
| browser | `/handoff/:id`, the same tap screen as a page; with no sessions pane (the kiosk) a notification draws it over everything |
| watch | the session page's card (`handoffCard` in `SessionsView.swift`; the notification opens the session); full screen in `HandoffView.swift`: tap to click, the crown zooms, a drag pans, a double tap fits, buttons for keyboard, Enter, Refresh, Cancel, Done |

**The screenshot is the part that matters, not the whole screen.** `mac-screen` captures one app's
window (on whichever display it is), `mac-chrome` Chrome's front window, `pi-browser` the page; the
session can crop further to a `region` (fractions of the window or page) or, on the Pi, a CSS
`selector`, whose element is followed as the page changes. A cropped handoff has `framed` set, and the
tap screen offers Full / Crop (watch: the expand glyph), the `view` action, which flips `whole`.

A tap is sent as fractions (0-1) of the screenshot, so it lands in the same place whatever size the
screenshot is drawn at.

## Things that are not obvious

- **What he types never reaches the session.** It goes device → hub → `handoff_actions.text` → the agent,
  which nulls it once typed. The session is told only how many times he typed.
- **The open handoffs live in the hub's memory as a cache** of the `handoffs` table, loaded at start and
  kept by realtime. Every held request reads the row itself first, so a deaf realtime channel delays an
  answer by at most one request's 40 s, never loses one.
- **The notification is sent once**, when the row first turns `open`.
