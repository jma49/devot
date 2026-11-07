#!/bin/sh
# CI helper: builds the native screens package (src-tauri/apple/DevotScreens) for the iPhone
# simulator in Debug and in Release, and fails unless the spike harness (Sources/DevotScreens/Debug/,
# docs/specs/iphone-screens.md Spikes) is in the Debug build and absent from the Release one.
# Debug proves the check can see the harness; the app's release build links the Release one.
set -eu
cd "$(dirname "$0")/../../src-tauri/apple/DevotScreens"
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

symbols() {
  config=$1
  if ! xcodebuild build -scheme DevotScreens -configuration "$config" \
    -destination 'generic/platform=iOS Simulator' -derivedDataPath "$work/$config" \
    >"$work/$config.log" 2>&1; then
    tail -n 60 "$work/$config.log" >&2
    echo "E_SCREENS_BUILD_FAILED config=$config" >&2
    exit 1
  fi
  objects=$(find "$work/$config/Build/Products" -name 'DevotScreens*.o' -o -name 'libDevotScreens*.a')
  if [ -z "$objects" ]; then
    echo "E_SCREENS_OBJECT_MISSING config=$config" >&2
    exit 1
  fi
  # shellcheck disable=SC2086
  nm -U $objects 2>/dev/null
}

debug=$(symbols Debug)
release=$(symbols Release)
for config in Debug Release; do
  if [ "$config" = Debug ]; then list=$debug; else list=$release; fi
  if ! printf '%s\n' "$list" | grep devot_screens_install >/dev/null; then
    echo "E_SCREENS_SYMBOLS_UNREADABLE config=$config" >&2
    exit 1
  fi
done
if ! printf '%s\n' "$debug" | grep SpikeHarness >/dev/null; then
  echo "E_SPIKES_MISSING_FROM_DEBUG: the check no longer sees the harness" >&2
  exit 1
fi
found=$(printf '%s\n' "$release" | grep -ci spike || true)
if [ "$found" -ne 0 ]; then
  printf '%s\n' "$release" | grep -i spike | head -n 20 >&2
  echo "E_SPIKES_IN_RELEASE symbols=$found" >&2
  exit 1
fi
echo "spike harness: in the Debug build, absent from the Release build"
