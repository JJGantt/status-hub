# Status Hub

One product, three faces, one brain. A personal status dashboard (litter robot, nutrition +
adaptive maintenance goal, workouts) served by a Node hub and rendered by a web UI and native
iOS/macOS apps — all over the same `/api/status` contract.

**Architecture principle: server computes, clients render.** All logic and derived display
values (maintenance math, dynamic macros, colors, labels, pace state) live in the hub payload;
the clients only paint. [CLAUDE.md](CLAUDE.md) is what to know before editing;
[IDEAS.md](IDEAS.md) is the roadmap.

## Layout

```
server/   Node/Express hub — the brain. Computes everything, serves the web UI + JSON API
          + SSE stream. Deployed to Fly (app: jared-status-hub).
apps/     Native SwiftUI app, iOS + macOS targets sharing one source tree (XcodeGen).
IDEAS.md  Backlog / roadmap for the whole product.
```

## Server (`server/`)

```sh
cd server
npm install
node server.js                 # local run on :8080
./deploy.sh                    # deploy to Fly, then verify /healthz reports this commit
```

Key files: `server.js` (Express, SSE, auth, page HTML), `lib/*` (the domain engine — `maintenance.js`
adaptive TDEE + goal phases, `pace.js`, `nutritionlog.js`, `volume.js`, `score.js`, …). Auth:
password → sha256 cookie (web) or `X-Hub-Token` header (apps). **Full internals map:
[docs/HUB-INTERNALS.md](docs/HUB-INTERNALS.md).**

## Apps (`apps/`)

```sh
cd apps
xcodegen generate              # regenerate StatusHub.xcodeproj from project.yml

# iOS — build + install to device over the network
xcodebuild -project StatusHub.xcodeproj -scheme StatusHub -configuration Debug \
  -destination 'generic/platform=iOS' -derivedDataPath build \
  -allowProvisioningUpdates DEVELOPMENT_TEAM=XMH4AVFC78 build
xcrun devicectl device install app --device <DEVICE_ID> \
  build/Build/Products/Debug-iphoneos/StatusHub.app

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
