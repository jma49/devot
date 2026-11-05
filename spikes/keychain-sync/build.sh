#!/bin/bash
# CI only (.github/workflows/keychain-probe.yml): builds the probe, embeds the Developer ID profile
# and signs it with probe.entitlements and the hardened runtime.
#   spikes/keychain-sync/build.sh <out dir>
# Reads APPLE_CERTIFICATE, APPLE_CERTIFICATE_PASSWORD, APPLE_SIGNING_IDENTITY, PROFILE_MACOS.
set -euo pipefail
out=${1:?out dir}
here=$(cd "$(dirname "$0")" && pwd)
work=$(mktemp -d "${RUNNER_TEMP:?}/probe.XXXXXX")
keychain=$work/signing.keychain-db
searched=()
cleanup() {
  [ ${#searched[@]} -eq 0 ] || security list-keychains -d user -s "${searched[@]}" || true
  security delete-keychain "$keychain" 2> /dev/null || true
  rm -rf "$work"
}
trap cleanup EXIT

password=$(uuidgen)
security create-keychain -p "$password" "$keychain"
security set-keychain-settings -lut 3600 "$keychain"
security unlock-keychain -p "$password" "$keychain"
(umask 077 && printf '%s' "$APPLE_CERTIFICATE" | base64 -D > "$work/c.p12")
security import "$work/c.p12" -k "$keychain" -f pkcs12 -P "$APPLE_CERTIFICATE_PASSWORD" -T /usr/bin/codesign > /dev/null 2>&1
rm -f "$work/c.p12"
security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k "$password" "$keychain" > /dev/null
while IFS= read -r line; do
  line=${line#*\"}
  searched+=("${line%\"*}")
done < <(security list-keychains -d user)
security list-keychains -d user -s "$keychain" "${searched[@]}"

app=$out/KeychainProbe.app
mkdir -p "$app/Contents/MacOS"
swiftc -swift-version 5 -O -o "$app/Contents/MacOS/probe" "$here/Sources/main.swift"
cat > "$app/Contents/Info.plist" << PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>io.github.jma49.devot</string>
<key>CFBundleName</key><string>KeychainProbe</string>
<key>CFBundleExecutable</key><string>probe</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleShortVersionString</key><string>0.0.1</string>
<key>CFBundleVersion</key><string>1</string>
<key>LSMinimumSystemVersion</key><string>26.0</string>
</dict></plist>
PLIST
(umask 077 && printf '%s' "$PROFILE_MACOS" | base64 -D > "$app/Contents/embedded.provisionprofile")
codesign --force --options runtime --timestamp --keychain "$keychain" \
  --entitlements "$here/probe.entitlements" -s "$APPLE_SIGNING_IDENTITY" "$app"
codesign --verify --strict "$app"
codesign -dvv "$app" 2>&1 | grep -E '^(Identifier|Authority=Developer|TeamIdentifier|Timestamp|CodeDirectory)'
codesign -d --entitlements - --xml "$app" 2> /dev/null | plutil -p - || true
