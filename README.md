# Status Hub

One product, three faces, one brain. A personal status dashboard (litter robot, nutrition +
adaptive maintenance goal, workouts) served by a Node hub and rendered by a web UI and native
iOS/macOS apps — all over the same `/api/status` contract.

**Architecture principle: server computes, clients render.** All logic and derived display
values (maintenance math, dynamic macros, colors, labels, pace state) live in the hub payload;
the clients only paint. See [IDEAS.md](IDEAS.md) for the roadmap.

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
fly deploy --now               # deploy (fly.toml lives here; build context = server/)
```

Key files: `server.js` (Express, SSE, auth, dashboard HTML), `maintenance.js` (adaptive TDEE
+ dynamic macro goal). Auth: password → sha256 cookie (web) or `X-Hub-Token` header (apps).

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

Bundle id `com.jaredgantt.statushub`, team `XMH4AVFC78`. Both targets share `apps/Sources/`.
