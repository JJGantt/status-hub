# Handoffs: a session hands Jared the screen it is stuck on

One of the capabilities in the shared `~/CLAUDE.md` § What each machine can do (claude-config `shared/CLAUDE.md`), which lists the rest.

A session can also drive a screen itself with `drive_screen` (`handoffs.driver = 'session'`): the same
rows and agents, pushed to his phone so he can watch, but nothing is asked of him (data-layer `README.md`
§ Driving a screen). When that session then hands him the same screen, the row is handed over in place
(`driver` cleared) and pushed again, so one screen is one handoff on his phone.

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
| phone, session view | a **Handoff tab** beside the conversation (`cards/repos.js`, session tabs): it comes to the front when the handoff arrives while the session is open, but opening the session lands on the conversation (only the notification opens it on the handoff); he can switch to the Session tab to read something (a number to type) and back without losing either; the tab closes itself once the handoff ends |
| phone, notification | the banner opens the handoff's session on its Handoff tab (`Push.swift` → `PageLaunch.handoff` → `window.__openHandoff` → `__openHandoffTab`) |
| phone, Mac targets | `mac-screen` and `mac-chrome` show the Mac's screen LIVE in the tab (`public/screen.js`, docs/SCREEN.md), framed on `focus`, with Cancel and Done ending the handoff; when no picture comes within 25 s it falls back to the tap screen |
| phone, tap screen | `public/handoff.js`, drawn inside the tab: the whole screen, framed at first on the part that matters; one finger pans, two pinch to zoom, a tap that did not move clicks there; the session's suggested values as buttons that fill the box; the box and Type to type; Enter, Tab, Refresh, Cancel, Done |
| browser | `/handoff/:id`, the same tap screen as a page; with no sessions pane (the kiosk) a notification draws it over everything |
| watch | the session page's card (`handoffCard` in `SessionsView.swift`; the notification opens the session); full screen in `HandoffView.swift`: tap to click, the crown zooms, a drag pans, a double tap fits, buttons for keyboard, Enter, Refresh, Cancel, Done |

**He starts on the part that matters.** The agent captures the whole screen (`mac-screen` and
`mac-chrome`: the display the app is on, with the app brought to the front; `pi-browser`: the
viewport) and stores it as `full_image`, with `focus`: the session's `region` (fractions of the
screen or page) or, on the Pi, a CSS `selector`'s element, followed as the page changes, as
fractions of it. The phone draws `full_image` framed on `focus` and pinches out to the rest. The watch
has no room for that, so `image` is the focus cropped out (`cropPng`), and its expand glyph sends the
`view` action, which flips `whole` and makes `image` the whole screen.

A tap is sent as fractions (0-1) of the picture it was made on, so it lands in the same place whatever
size the picture is drawn at: the phone's carry `full` (fractions of `full_image`), the watch's do not
(fractions of `image`).

**Suggested values.** The session passes `suggest` ([{label, text}]: his email, a card number he gave
it) with the request; the phone shows each as a button that fills the text box, and he presses Type
himself. Never a password or a one-time code. The agent clears `suggest` when the handoff ends. The session chooses them from what the screen asks for. In the live Mac view
(`screen.js`) the same values are buttons above the keys, and one tap types the value on the Mac.

## Things that are not obvious

- **What he types never reaches the session.** It goes device → hub → `handoff_actions.text` → the agent,
  which nulls it once typed. The session is told only how many times he typed.
- **The open handoffs live in the hub's memory as a cache** of the `handoffs` table, loaded at start and
  kept by realtime. Every held request reads the row itself first, so a deaf realtime channel delays an
  answer by at most one request's 40 s, never loses one.
- **The notification is sent once**, when the row first turns `open`.
- **Done and Cancel ignore taps for 0.7 s after the keyboard closes** (the box loses focus or the visible
  area resizes). Closing the keyboard shifts the screen under the finger, and the same tap can land on a
  Done that slid beneath it, which ends the handoff and wakes the session.
- **Each action records the device that sent it** (`handoff_actions.source`, the request's user agent), so
  an action nobody remembers sending can be traced to the phone or the watch.
