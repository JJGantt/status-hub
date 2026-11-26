# Session tabs: what a session shows beside its conversation

The phone's session view is a strip of tabs: the conversation (`Session`, always there) and whatever
else the session has open. Each tab keeps its pane mounted while another is shown, so switching away
and back loses nothing. The kinds are `TAB_KINDS` in `public/cards/repos.js`:

| kind | what | opened by | ends |
|---|---|---|---|
| `handoff` | a screen the session handed him (docs/HANDOFFS.md) | `request_handoff` | itself, once it has shown how it ended |
| `screen` | the live Mac screen (docs/SCREEN.md) | its button | its share |
| `content` | a picture, a chart, a markdown or HTML page the session put up | the data MCP's `session_tab` | the session closes it, or the session ends |
| `chrome` | a live view of a Chrome tab the session drives, which he can tap and type into | the `chrome-live` hook, by itself | the browser tab closes, or the session ends |

`content` and `chrome` tabs are rows in `session_tabs` (data-layer migration 00197). A row belongs to a
CONVERSATION (`claude_session_id`), not to a `desk_sessions` row, so a resume keeps its tabs. The hub
keeps every open row in memory, loaded at start and kept by realtime (`routes/tabs.js`), and ships a
session's tabs as `tabs` on its row in `/api/sessions` and `/api/sessions/:id`; the session view mounts,
updates (a newer `v`) and drops tabs from that list. A `content` tab that appears while the session is
open comes to the front; a `chrome` tab never takes the front by itself, because it appears whenever the
session touches Chrome.

## Content tabs

`session_tab` (data-layer `src/sessionTabs.ts`) with `open` / `update` / `close` / `list`, scoped to the
caller's own conversation (`desk.selfConversation`, which finds the session's row by `HUB_SESSION_ID` or,
for a session opened by hand at the Mac, by the MCP server's parent pid). Not offered to a voice turn.

- **markdown** is fetched from `GET /api/tabs/:id` and drawn by `md()`, like a reply.
- **image** is stored in `shared-images` (`images.storeImage`) and shown from `/img/<name>`.
- **html** is a frame on `GET /tab/:id`, served under the same sandboxing CSP as a report
  (`lib/untrusted.js`): model-written markup in a web view already signed in to the hub. The frame also
  carries `sandbox` without `allow-scripts`; either alone keeps the page inert.

## Live Chrome

```
Claude session ──Chrome tools──► Chrome tab (its tab group)
     │ PostToolUse: bin/chrome-live claim                      ▲ chrome.debugger: screencast, input
     ▼                                                         │
hub POST /api/tabs/chrome/claim ──► session_tabs row    Hub Live extension (extensions/chrome-live)
                                                               │ one outbound websocket, /api/live/agent
phone session view ──ws /api/live/view?tab=<row>──► hub lib/liverelay.js ◄─┘
```

**Who owns which tab.** Every Claude in Chrome result names the session's tab ids (`tabId N`), the same
ids Chrome and any extension use. `bin/chrome-live claim` (a PostToolUse hook on `mcp__claude-in-chrome__.*`
in claude-config's `mac/` and `pi/` settings) claims an id the first time it sees it — a state file per
session in `~/.claude/chrome-live/` makes that one request per new tab, in the background. A partial
unique index on open `(machine, target)` makes a repeat claim a no-op. `chrome-live release` at
SessionEnd closes the session's live tabs.

Ownership is per TAB, not per Chrome lock. `claude-config/mac/bin/chrome-lock` decides which session may
drive Chrome right now and is released at the end of every turn; a session's tab group outlives that, and
it is exactly between turns that he wants to look at it. A live tab ends when its browser tab closes (the
extension reports `gone`, and on connect it reports every claimed tab that no longer exists, which covers
a browser restart renumbering tabs) or when its session ends.

**Nothing streams unless someone is watching.** The phone opens the viewer socket only while that tab's
pane is on screen and the app is in front. The first viewer of a tab makes the hub send its machine's
extension `watch`, the last one leaving sends `unwatch`, and the extension attaches and detaches with
them. That is also what keeps Chrome's bar away: while any extension has the debugger attached, Chrome
shows `"Hub Live" started debugging this browser` with a Cancel button across every window. The Claude
extension uses the same API and shows its own bar while it drives. Cancel detaches Hub Live, and the
viewer is told.

**A background tab paints nothing**, so a screencast of one sends no frames at all (measured, Chrome
158). `Emulation.setFocusEmulationEnabled` makes the page believe it is visible and focused; it then
streams at full rate behind other tabs, in an unfocused window and in a minimized one, several tabs at
once, while the tab really in front keeps its own focus. The extension turns it on while watching and off
on unwatch. So several sessions' tabs can each be watched at the same time, none of them in front.

**Two extensions can debug one tab.** Measured with two extensions attached to the same background tab:
both attached, and both screencast it at full rate. That is the case of Hub Live beside the Claude
extension, which holds the `debugger` permission too.

**Input never moves the real mouse.** Taps are `Input.dispatchMouseEvent` at the tab's CSS coordinates,
typing `Input.insertText`, keys `Input.dispatchKeyEvent`, a drag past the picture's edge a `mouseWheel`
— all into that tab through its debugger session, whatever is in front. A tap focuses a field in a
background tab and the typed text lands there.

**The wire.** A frame is one binary message, extension → hub → phone unchanged: a 4-byte big-endian
header length, `{ target, w, h }` (the viewport in CSS pixels, which is what input is scaled by), the
JPEG. Input goes back as JSON with positions as fractions of the frame. The agent proves itself with the
hub's device token in its first message, `{ op: 'hello', machine, token }`, because an extension cannot
put a header on a websocket and a token in a URL ends up in proxy logs. The hub messages it every 20s,
which keeps both Fly's proxy and the extension's MV3 service worker alive; a one-minute alarm restarts a
worker Chrome stopped anyway. A refused hello stops it retrying until it is reloaded.

**Bandwidth.** The extension caps a tab at 10 frames a second (it holds each screencast ack), scales to
1280px wide at JPEG quality 60, and a screencast sends only when the page paints: a still page costs one
frame. Measured through Fly: about 27KB a frame on a busy page, so a page scrolling continuously is about
270KB/s and a still one nothing. A viewer whose socket is backed up is skipped rather than queued, and so
is a frame the extension cannot send without queueing; the newest frame always wins.

**What is reported.** The hub logs as errors: a live tab opened with no extension connected for that
machine, no frame 15s after a `watch`, a refused hello, and anything the extension sends as `error` (an
attach that failed, Cancel on the bar). The phone shows `Offline` while the machine's extension is away.

### Installing the extension

`extensions/chrome-live/` is an unpacked MV3 extension. Its `config.js` (gitignored) holds the hub's
address, the machine name and the device token: write it with `bin/chrome-live-config` on each machine,
then reload the extension.

- **Mac**: Chrome, Profile 37 → `chrome://extensions` → Developer mode → Load unpacked →
  `~/repos/status-hub/extensions/chrome-live`. Branded Chrome ignores `--load-extension`, so this one
  step is by hand. Chrome remembers it across restarts.
- **Pi**: `pi-browser.service` and `bin/browser-session.sh` start Chromium with `--load-extension` on the
  same directory; `systemctl restart pi-browser` after changing it.

A change to `sw.js` reaches a browser only when the extension is reloaded (the Pi: a browser restart).

### Testing it without his browser

Branded Chrome can still load an unpacked extension into a THROWAWAY profile over a debugging pipe:
launch it with `--remote-debugging-pipe --enable-unsafe-extension-debugging --user-data-dir=<temp>` and
call `Extensions.loadUnpacked`. With a claim for that browser's tab id and a viewer socket carrying
`X-Hub-Token`, the whole path runs against the real hub. Use a conversation id no real session has, and
delete its rows after. A test extension saying hello as `mac` displaces his real one (the hub keeps one
socket per machine), and the two then take turns displacing each other until the throwaway browser is
closed, so keep the test short.
