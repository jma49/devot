#!/bin/zsh
# Usage: ./run-probe.sh /path/to/profile.provisionprofile
set -euo pipefail
PROFILE=${1:?Give the path of the downloaded .provisionprofile}
TEAM=WMG3HG38DV
BUNDLE=io.github.jma49.devot.probe
CONTAINER=iCloud.$BUNDLE
HERE=${0:A:h}
BUILD=$(mktemp -d)
trap 'rm -rf "$BUILD"' EXIT
IDENTITY=$(security find-identity -v -p codesigning | sed -n 's/.*"\(Developer ID Application: .*\)"/\1/p' | head -1)
[[ -n $IDENTITY ]] || { echo "No Developer ID Application identity found"; exit 1; }
APP=$BUILD/Probe.app
mkdir -p "$APP/Contents/MacOS"
swiftc -swift-version 5 -o "$APP/Contents/MacOS/probe" "$HERE/Sources/main.swift"
cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>$BUNDLE</string>
<key>CFBundleExecutable</key><string>probe</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleVersion</key><string>1</string>
</dict></plist>
PLIST
cp "$PROFILE" "$APP/Contents/embedded.provisionprofile"
sed -e "s/TEAMID/$TEAM/g" -e "s/CONTAINER/$BUNDLE/" -e '/aps-environment/d' "$HERE/probe.entitlements" > "$BUILD/e.plist"
codesign --force --options runtime --timestamp --entitlements "$BUILD/e.plist" -s "$IDENTITY" "$APP"
codesign --verify --strict "$APP"
DEVOT_PROBE_CONTAINER=$CONTAINER "$APP/Contents/MacOS/probe"
