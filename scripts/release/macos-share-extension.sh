#!/bin/bash
# Builds the Mac Share menu extension (src-tauri/macos/DevotShare) as a universal DevotShare.appex,
# signed ad hoc with the sandbox (src-tauri/macos/Extension.entitlements), which macOS loads no
# extension without. Tauri copies it into Devot.app/Contents/PlugIns (tauri.macos.conf.json) and
# macos-sign.sh signs it again with the Developer ID identity. Runs only Apple's tools.
#
#   scripts/release/macos-share-extension.sh <out dir>
#
# Errors are GitHub annotations with a code.
set -euo pipefail

fail() {
  echo "::error::$*" >&2
  exit 1
}

[ $# -eq 1 ] || fail "E_SHARE_USAGE: macos-share-extension.sh <out dir>"
root=$(cd "$(dirname "$0")/../.." && pwd)
source=$root/src-tauri/macos/DevotShare
version=$(plutil -extract version raw -o - "$root/package.json") ||
  fail "E_SHARE_VERSION: package.json holds no version"
minimum=$(plutil -extract bundle.macOS.minimumSystemVersion raw -o - "$root/src-tauri/tauri.conf.json") ||
  fail "E_SHARE_VERSION: tauri.conf.json holds no minimum macOS version"

out=${1%/}
appex=$out/DevotShare.appex
work=$(mktemp -d "${TMPDIR:-/tmp}/devot-share.XXXXXX")
trap 'rm -rf "$work"' EXIT

slices=()
for arch in arm64 x86_64; do
  xcrun --sdk macosx swiftc -swift-version 6 -warnings-as-errors -O -whole-module-optimization \
    -target "$arch-apple-macos$minimum" -application-extension -module-name DevotShare \
    -Xlinker -e -Xlinker _NSExtensionMain \
    -o "$work/DevotShare-$arch" "$source/CaptureLink.swift" "$source/ShareViewController.swift"
  slices+=("$work/DevotShare-$arch")
done

rm -rf "$appex"
mkdir -p "$appex/Contents/MacOS"
lipo -create -output "$appex/Contents/MacOS/DevotShare" "${slices[@]}"
cp "$source/Info.plist" "$appex/Contents/Info.plist"
for key in CFBundleShortVersionString CFBundleVersion; do
  plutil -replace "$key" -string "$version" "$appex/Contents/Info.plist"
done
plutil -replace LSMinimumSystemVersion -string "$minimum" "$appex/Contents/Info.plist"
codesign --force --sign - --options runtime \
  --entitlements "$root/src-tauri/macos/Extension.entitlements" "$appex"
echo "Built $appex"
