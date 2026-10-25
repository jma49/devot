#!/bin/bash
# Makes the release disk image from a signed app, laid out as the bundler's CI dmg was: the app, a
# link to /Applications and the app's icon as the volume icon, with no Finder window settings;
# HFS+, zlib-compressed (UDZO). Signing it is the caller's step (macos-sign.sh).
#
#   scripts/release/macos-dmg.sh <Name.app> <out.dmg>
set -euo pipefail

fail() {
  echo "::error::$*" >&2
  exit 1
}

[ $# -eq 2 ] || fail "E_DMG_USAGE: macos-dmg.sh <Name.app> <out.dmg>"
app=${1%/}
dmg=$2
[ -d "$app/Contents" ] || fail "E_DMG_NO_APP: $app is not an app bundle"
case $dmg in *.dmg) ;; *) fail "E_DMG_USAGE: the output must end in .dmg" ;; esac

name=$(basename "$app" .app)
icon=$(plutil -extract CFBundleIconFile raw "$app/Contents/Info.plist")
icon=$app/Contents/Resources/${icon%.icns}.icns
[ -f "$icon" ] || fail "E_DMG_NO_ICON: the app has no $(basename "$icon")"

work=$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/devot-dmg.XXXXXX")
mounted=
cleanup() {
  if [ -n "$mounted" ]; then hdiutil detach -quiet "$mounted" || hdiutil detach -quiet -force "$mounted" || true; fi
  rm -rf "$work"
}
trap cleanup EXIT

stage=$work/stage
mkdir "$stage"
ditto "$app" "$stage/$name.app"
ln -s /Applications "$stage/Applications"
cp "$icon" "$stage/.VolumeIcon.icns"
# Finder info: creator `icnC` marks the volume icon file; flag kHasCustomIcon (0x0400) on the root shows it.
xattr -wx com.apple.FinderInfo "0000000069636E430000000000000000 00000000000000000000000000000000" "$stage/.VolumeIcon.icns"

hdiutil create -quiet -volname "$name" -fs HFS+ -fsargs "-c c=64,a=16,e=16" -format UDRW \
  -srcfolder "$stage" "$work/rw.dmg"
mkdir "$work/mnt"
hdiutil attach -quiet -readwrite -noverify -noautoopen -nobrowse -mountpoint "$work/mnt" "$work/rw.dmg"
mounted=$work/mnt
# hdiutil create does not carry the source folder's Finder info to the volume root.
xattr -wx com.apple.FinderInfo "00000000000000000400000000000000 00000000000000000000000000000000" "$work/mnt"
rm -rf "$work/mnt/.fseventsd"
hdiutil detach -quiet "$work/mnt"
mounted=

rm -f "$dmg"
hdiutil convert -quiet "$work/rw.dmg" -format UDZO -imagekey zlib-level=9 -o "$dmg"
