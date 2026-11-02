# Status Hub

One product, many faces, one brain. A personal status dashboard (litter robot, nutrition +
adaptive maintenance goal, workouts, lists, surf, Claude sessions, voice) served by a Node hub and
rendered by a web UI (desktop, phone, TV wall), native iOS/macOS apps that wrap it, and a native
watch app.

**Architecture principle: server computes, clients render.** All logic and derived display
values (maintenance math, dynamic macros, colors, labels, pace state) live in the hub payload;
the clients only paint. [CLAUDE.md](CLAUDE.md) is what to know before editing;
[IDEAS.md](IDEAS.md) is the roadmap.

## Layout

```
server/   Node/Express hub — the brain. Computes everything, serves the web UI + JSON API
          + SSE stream. Deployed to Fly (app: jared-status-hub). The web client is server/public/.
apps/     Native SwiftUI apps (XcodeGen): iOS + macOS sharing one source tree, the iOS widget
          extension, and the watch app with its complication extension.
docs/     Subsystem docs (internals, sessions, watch, alarms, live mic, ...) and TODO.md.
IDEAS.md  Backlog / roadmap for the whole product.
```

## Server (`server/`)

```sh
cd server
npm install
npm run build                  # bundles the client into public/dist (generated, not committed)
npm test                       # the suite (below); run it before pushing
npm start                      # local run on :8080
./deploy.sh                    # deploy to Fly, then verify /healthz reports this commit
```

Key files: `server.js` (Express, SSE, auth, page HTML), `lib/*` (the domain engine — `maintenance.js`
adaptive TDEE + goal phases, `pace.js`, `nutritionlog.js`, `volume.js`, `score.js`, …). Auth: `lib/auth.js`
(sessions, the device token, the password-derived token; HUB-INTERNALS § Auth). **Full internals map:
[docs/HUB-INTERNALS.md](docs/HUB-INTERNALS.md).**

`npm start` with real `SUPABASE_*` runs every timer against live data: `dueTick` pushes overdue items,
the sweeps delete, and boot rewrites `fallback_config` from whatever `HUB_PASSWORD` it was given. Prove
a change with `npm test` instead.

### Tests

`server/test/` (`node:test`, no dependencies). `harness.js` starts the real `server.js` as a child
process against an in-memory fake of Supabase's REST API, so a test goes through the same middleware
and routes as Fly; Groq, APNs and the ops responder are left unconfigured. They cover only what is
costly to break: every way a request authenticates and every way it is refused, the login lockout,
session issue, upgrade, revocation and survival across a restart, the Menu app's owner check, and
`/api/notify`'s device-token rule. `.github/workflows/server-test.yml` runs them on every push to main
that touches `server/`.

## Apps (`apps/`)

```sh
cd apps
xcodegen generate              # regenerate StatusHub.xcodeproj from project.yml

# iOS (+ the embedded watch app) — build on this Mac and upload to TestFlight
tools/testflight.sh

# macOS — build + run
xcodebuild -project StatusHub.xcodeproj -scheme StatusHubMac -configuration Debug \
  -derivedDataPath build -destination 'platform=macOS' DEVELOPMENT_TEAM=XMH4AVFC78 build
open "build/Build/Products/Debug/Status Hub.app"
```

Bundle id `com.jaredgantt.statushub`, team `XMH4AVFC78`. `StatusHub` (iOS) + `StatusHubMac` share
`apps/Sources/`; the iOS-18 widget extension (`StatusHubControls`) + the shared intents live in
`apps/Controls/` + `apps/Shared/`. That one extension carries the Lock-Screen / Control-Center
**Record** button and three Home Screen widgets: **Macro Rings** (`/api/rings`), **Due**
(`/api/due-widget`) and **Projects** (`/api/repos-widget`), the last two interactive.
The watch app (`StatusHubWatch`) and its complication extension (`StatusHubWatchWidgets`) live in
`apps/Watch/` + `apps/WatchWidgets/`, embedded by the iOS app; see [docs/WATCH.md](docs/WATCH.md).

Iterating on widget layout doesn't need a device — the drawing files are WidgetKit-free and render
standalone to PNGs:

```sh
cd apps
swiftc -O tools/render-rings.swift Controls/RingsView.swift -o /tmp/render && /tmp/render /tmp
swiftc -O tools/render-todo.swift Controls/TodoView.swift Controls/RingsView.swift \
       Shared/Auth.swift Shared/OpenTodoItem.swift -o /tmp/render-todo && /tmp/render-todo /tmp
swiftc -O tools/render-repos.swift Controls/ReposView.swift Controls/RingsView.swift \
       Shared/Auth.swift Shared/OpenTodoItem.swift -o /tmp/render-repos && /tmp/render-repos /tmp
```

**Full internals map: [docs/HUB-INTERNALS.md](docs/HUB-INTERNALS.md) §9 (app) and §9b (widget).**
