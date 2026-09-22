#!/usr/bin/env bash
# Build StatusHub on THIS Mac and upload it to TestFlight. This is the path — the Mac has the iOS and
# watchOS device platforms and a team distribution identity, and the whole thing takes a few minutes.
# `.github/workflows/ios-testflight.yml` is the same build on a rented Mac, for when this one is away;
# macOS runners bill at 10x, so it is the fallback, not the habit.
#
# Signs from the `gnarcast-build` keychain, which holds the team's Apple Distribution identity and the
# account's development identity, unlocked here with its own password so nothing prompts. Profiles are
# fetched or made with the App Store Connect API key rather than an Xcode account login.
#
# The build number comes from TestFlight itself (`asc.mjs next-build`), so a build made here and one
# made on a runner can never pick the same number.
set -euo pipefail
cd "$(dirname "$0")/.."
K="$HOME/.appstoreconnect/private_keys"
KC="$HOME/Library/Keychains/gnarcast-build.keychain-db"
KEY_ID=P8Y337A8RC
ISSUER=141a8ead-b829-4e58-b9ff-b8c95f8c4ed9
TEAM=XMH4AVFC78
OUT="$(mktemp -d)"
trap 'rm -r "$OUT"' EXIT

# Apple does not list a build for some minutes after it is uploaded, so the API's answer can be a
# number that is already taken. The mark file is this Mac's own high-water line; the build is whichever
# is higher.
MARK="$K/statushub-last-build"
ASKED="$(ASC_KEY_P8="$(cat "$K/AuthKey_$KEY_ID.p8")" ASC_KEY_ID="$KEY_ID" ASC_ISSUER_ID="$ISSUER" \
  node tools/asc.mjs next-build)"
[[ "$ASKED" =~ ^[0-9]+$ ]] || { echo "could not read the next build number: $ASKED"; exit 1; }
MINE=$(( $(cat "$MARK" 2>/dev/null || echo 0) + 1 ))
BUILD=$(( ASKED > MINE ? ASKED : MINE ))

security unlock-keychain -p "$(cat "$K/gnarcast-build-keychain.password")" "$KC"
xcodegen generate >/dev/null

AUTH=(-allowProvisioningUpdates -authenticationKeyPath "$K/AuthKey_$KEY_ID.p8"
      -authenticationKeyID "$KEY_ID" -authenticationKeyIssuerID "$ISSUER")

echo "archiving build $BUILD"
xcodebuild -project StatusHub.xcodeproj -scheme StatusHub -configuration Release \
  -destination 'generic/platform=iOS' -archivePath "$OUT/StatusHub.xcarchive" \
  "${AUTH[@]}" DEVELOPMENT_TEAM="$TEAM" CURRENT_PROJECT_VERSION="$BUILD" \
  archive 2>&1 | grep -E "error:|ARCHIVE" || true
[ -d "$OUT/StatusHub.xcarchive" ] || { echo "archive failed"; exit 1; }

cat > "$OUT/ExportOptions.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>method</key><string>app-store-connect</string>
  <key>teamID</key><string>$TEAM</string>
  <key>uploadSymbols</key><true/>
  <key>signingStyle</key><string>automatic</string>
  <key>destination</key><string>export</string>
</dict></plist>
PLIST
xcodebuild -exportArchive -archivePath "$OUT/StatusHub.xcarchive" -exportPath "$OUT/export" \
  -exportOptionsPlist "$OUT/ExportOptions.plist" "${AUTH[@]}" 2>&1 | grep -E "error:|EXPORT" || true
IPA="$(ls "$OUT"/export/*.ipa 2>/dev/null | head -1)"
[ -n "$IPA" ] || { echo "export failed"; exit 1; }

echo "uploading build $BUILD"
xcrun altool --upload-app -f "$IPA" -t ios --apiKey "$KEY_ID" --apiIssuer "$ISSUER" 2>&1 | tail -4
echo "$BUILD" > "$MARK"
