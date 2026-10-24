#!/bin/sh
# Makes every app icon image from the masters in design/app-icon/ (pnpm app-icon; macOS, for
# iconutil, and ImageMagick). `tauri icon` renders each size from the SVG; 16 and 32 px come from
# the small cut, which it cannot take beside the master, so the .icns is put together here.
set -eu
command -v magick > /dev/null || {
  echo "E_APP_ICON_NO_MAGICK: ImageMagick is needed (brew install imagemagick)" >&2
  exit 1
}
cd "$(dirname "$0")/../.."
root=$(pwd)
art=$root/design/app-icon
icons=$root/src-tauri/icons
out=$(mktemp -d)
trap 'rm -rf "$out"' EXIT

render() {
  pnpm -s tauri icon "$@" > "$out/tauri.log" 2>&1 || {
    cat "$out/tauri.log" >&2
    exit 1
  }
}

render "$art/source.svg" --png 64,128,256,512,1024,2048 -o "$out/master"
render "$art/source-small.svg" --png 16,32 -o "$out/small"
render "$art/source-ios.svg" -o "$out/ios"

cp "$out/master/2048x2048.png" "$art/source.png"
cp "$out/small/32x32.png" "$out/master/64x64.png" "$out/master/128x128.png" "$icons/"
cp "$out/master/256x256.png" "$icons/128x128@2x.png"
cp "$out/master/512x512.png" "$icons/icon.png"

iconset=$out/icon.iconset
mkdir "$iconset"
cp "$out/small/16x16.png" "$iconset/icon_16x16.png"
cp "$out/small/32x32.png" "$iconset/icon_16x16@2x.png"
cp "$out/small/32x32.png" "$iconset/icon_32x32.png"
cp "$out/master/64x64.png" "$iconset/icon_32x32@2x.png"
for size in 128 256 512; do
  cp "$out/master/${size}x${size}.png" "$iconset/icon_${size}x${size}.png"
  cp "$out/master/$((size * 2))x$((size * 2)).png" "$iconset/icon_${size}x${size}@2x.png"
done
iconutil -c icns "$iconset" -o "$icons/icon.icns"

# App Store Connect refuses an app icon with an alpha channel, even a fully opaque one.
for f in "$out/ios/ios/"*.png; do
  magick "$f" -strip -alpha off -define png:color-type=2 "$f"
done
for dir in "$icons/ios" "$root/src-tauri/gen/apple/Assets.xcassets/AppIcon.appiconset"; do
  cp "$out/ios/ios/"*.png "$dir/"
done

# The menu bar icon is a template image: macOS reads its alpha alone and tints it. 36 px is 18 pt,
# the height the status item draws it at, on a 2x screen.
mkdir -p "$icons/menu-bar"
magick -background none -density 384 "$art/menu-bar.svg" -resize 36x36 -strip \
  -define png:color-type=6 "$icons/menu-bar/template.png"

rm -rf "$icons/AppIcon.icon"
cp -R "$art/AppIcon.icon" "$icons/AppIcon.icon"
