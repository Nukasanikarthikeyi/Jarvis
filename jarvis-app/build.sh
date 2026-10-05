#!/usr/bin/env bash
# Build "JARVIS HUD.app": the HUD in a window of its own, with the server
# started and stopped for you.
#
#   jarvis-app/build.sh [destination folder]        default: ~/Applications
#
# Needs only the Xcode Command Line Tools (swiftc). The app remembers where
# this project is, so build it again if you move the project folder.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
PROJECT="$(dirname "$HERE")"
DEST="${1:-$HOME/Applications}"
APP="$DEST/JARVIS HUD.app"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

mkdir -p "$DEST"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"

swiftc -swift-version 5 -O -o "$APP/Contents/MacOS/JARVIS HUD" "$HERE/JarvisHUD.swift" \
  -framework Cocoa -framework WebKit

swiftc -swift-version 5 -O -o "$WORK/make_icon" "$HERE/make_icon.swift" -framework Cocoa
"$WORK/make_icon" "$WORK/AppIcon.iconset"
iconutil -c icns -o "$APP/Contents/Resources/AppIcon.icns" "$WORK/AppIcon.iconset"

cat > "$APP/Contents/Info.plist" <<'PLIST'
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
  <key>CFBundleShortVersionString</key><string>1.0</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
  <key>LSApplicationCategoryType</key><string>public.app-category.productivity</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSMicrophoneUsageDescription</key><string>JARVIS listens when you turn on Live voice.</string>
  <key>NSAppTransportSecurity</key>
  <dict><key>NSAllowsLocalNetworking</key><true/></dict>
</dict>
</plist>
PLIST
# plutil does the escaping, so a path with spaces or an ampersand is safe.
plutil -insert JarvisProjectPath -string "$PROJECT" "$APP/Contents/Info.plist"

codesign --force --sign - "$APP" >/dev/null 2>&1
echo "Built $APP"
echo "It runs JARVIS from $PROJECT"
