#!/usr/bin/env bash
# Build "JARVIS HUD.app": the HUD in a window of its own, with the server
# started and stopped for you.
#
#   jarvis-app/build.sh [folder]          the app, self-contained, into folder
#                                         (default: ~/Applications)
#   jarvis-app/build.sh --dmg [file]      the same app in a disk image
#                                         (default: dist/JARVIS HUD.dmg)
#   jarvis-app/build.sh --link [folder]   a small app that runs this project
#                                         folder in place, for development
#
# The self-contained app carries the server, the interface, the connector and a
# freshly generated sample vault. It never carries your .env, your state, your
# vault or your memories: those live in ~/Library/Application Support/JARVIS HUD.
#
# Needs only the Xcode Command Line Tools (swiftc).
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
PROJECT="$(dirname "$HERE")"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

MODE="standalone"
case "${1:-}" in
  --dmg)  MODE="dmg";  shift ;;
  --link) MODE="link"; shift ;;
esac

build_app() {                      # build_app <destination folder> <standalone|link>
  local dest="$1" kind="$2" app="$1/JARVIS HUD.app"
  mkdir -p "$dest"
  rm -rf "$app"
  mkdir -p "$app/Contents/MacOS" "$app/Contents/Resources"

  # One binary for Apple-silicon and Intel Macs, macOS 13 and later. Without
  # -target the app would only open on this Mac's own macOS version or newer.
  # (The Command Line Tools have no Intel copy of Swift's back-deployment
  # library and the linker says so; nothing in this app needs it.)
  local arch
  for arch in arm64 x86_64; do
    swiftc -swift-version 5 -O -target "$arch-apple-macos13.0" -o "$WORK/hud-$arch" \
      "$HERE/JarvisHUD.swift" -framework Cocoa -framework WebKit
  done
  lipo -create "$WORK/hud-arm64" "$WORK/hud-x86_64" -output "$app/Contents/MacOS/JARVIS HUD"

  swiftc -swift-version 5 -O -o "$WORK/make_icon" "$HERE/make_icon.swift" -framework Cocoa
  rm -rf "$WORK/AppIcon.iconset"
  "$WORK/make_icon" "$WORK/AppIcon.iconset"
  iconutil -c icns -o "$app/Contents/Resources/AppIcon.icns" "$WORK/AppIcon.iconset"

  cat > "$app/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>JARVIS HUD</string>
  <key>CFBundleDisplayName</key><string>JARVIS HUD</string>
  <key>CFBundleIdentifier</key><string>local.jarvis.hud</string>
  <key>CFBundleExecutable</key><string>JARVIS HUD</string>
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>1.1</string>
  <key>CFBundleVersion</key><string>2</string>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
  <key>LSApplicationCategoryType</key><string>public.app-category.productivity</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSMicrophoneUsageDescription</key><string>JARVIS listens when you turn on Live voice.</string>
  <key>NSAppTransportSecurity</key>
  <dict><key>NSAllowsLocalNetworking</key><true/></dict>
</dict>
</plist>
PLIST

  if [ "$kind" = "link" ]; then
    # plutil does the escaping, so a path with spaces or an ampersand is safe.
    plutil -insert JarvisProjectPath -string "$PROJECT" "$app/Contents/Info.plist"
  else
    local payload="$app/Contents/Resources/jarvis"
    mkdir -p "$payload/jarvis-app"
    cp "$PROJECT"/server.py "$PROJECT"/runtime.py "$PROJECT"/memory.py "$PROJECT"/commands.py \
       "$PROJECT"/voice.py "$PROJECT"/start.sh "$payload/"
    cp -R "$PROJECT/ui" "$payload/ui"
    cp "$HERE/mcp_server.py" "$HERE/app.env" "$payload/jarvis-app/"
    # The sample vault is generated fresh, never copied from the working one,
    # so no note or memory of yours can end up inside the app.
    cp "$PROJECT/seed_vault.py" "$payload/seed_vault.py"
    (cd "$payload" && python3 seed_vault.py >/dev/null)
    rm -f "$payload/seed_vault.py"
    find "$payload" \( -name ".DS_Store" -o -name "__pycache__" -o -name "*.pyc" \) -prune -exec rm -rf {} +
    # Last line of defence: refuse to ship anything personal.
    if find "$payload" \( -name ".env" -o -name "state.json" -o -name "*token*.json" \
         -o -name "credentials.json" -o -path "*/vault/memory*" -o -path "*/vault/.trash*" \) | grep -q .; then
      echo "build.sh: refusing to package personal files:" >&2
      find "$payload" \( -name ".env" -o -name "state.json" -o -name "*token*.json" \
         -o -name "credentials.json" -o -path "*/vault/memory*" -o -path "*/vault/.trash*" \) >&2
      exit 1
    fi
  fi

  codesign --force --sign - "$app" >/dev/null 2>&1
}

case "$MODE" in
  standalone)
    DEST="${1:-$HOME/Applications}"
    build_app "$DEST" standalone
    echo "Built $DEST/JARVIS HUD.app (self-contained)"
    echo "Its settings, vault and memory live in ~/Library/Application Support/JARVIS HUD"
    ;;
  link)
    DEST="${1:-$HOME/Applications}"
    build_app "$DEST" link
    echo "Built $DEST/JARVIS HUD.app"
    echo "It runs JARVIS from $PROJECT"
    ;;
  dmg)
    OUT="${1:-$PROJECT/dist/JARVIS HUD.dmg}"
    mkdir -p "$(dirname "$OUT")" "$WORK/dmg"
    build_app "$WORK/dmg" standalone
    ln -s /Applications "$WORK/dmg/Applications"     # drag the app onto this to install
    rm -f "$OUT"
    hdiutil create -volname "JARVIS HUD" -srcfolder "$WORK/dmg" -ov -format UDZO "$OUT" >/dev/null
    echo "Built $OUT"
    ;;
esac
