#!/bin/sh
# CI helper: runs the iPhone UI test (src-tauri/apple/DevotUITests) against the app that
# `pnpm tauri ios build --debug --target aarch64-sim` made. The app is installed on an iPhone
# simulator and the test launches it by its bundle ID, since Tauri's Xcode project builds Rust only
# under the Tauri CLI. XcodeGen makes the test project from DevotUITests/project.yml; it is
# generated here and never committed.
# The simulator is scripts/ci/iphone-simulator.ts's pick; DEVOT_UI_SIMULATOR, or DEVOT_SIMULATOR,
# picks one by UDID instead. DEVOT_UI_TESTS holds xcodebuild's test selection, such as
# -only-testing:DevotUITests/SettingsTests, for CI to split the classes between jobs.
set -eu
root=$(cd "$(dirname "$0")/../.." && pwd)
# Tauri leaves a simulator build under gen/apple/build; Xcode's derived data is the fallback.
app=$(find "$root/src-tauri/gen/apple/build" "$HOME/Library/Developer/Xcode/DerivedData" \
  -type d -name Devot.app -path '*sim*' -prune 2>/dev/null | head -n 1)
if [ -z "$app" ]; then
  echo "E_IPHONE_UI_NO_APP: no simulator build of Devot.app; run pnpm tauri ios build --debug --target aarch64-sim first" >&2
  exit 1
fi
echo "app: $app"
device=${DEVOT_UI_SIMULATOR:-${DEVOT_SIMULATOR:-$(xcrun simctl list devices available --json |
  node "$root/scripts/ci/iphone-simulator.ts")}}
xcrun simctl bootstatus "$device" -b >/dev/null
xcrun simctl install "$device" "$app"
cd "$root/src-tauri/apple/DevotUITests"
xcodegen generate --quiet
log=$(mktemp)
# CI uploads the result bundle, with the tests' attachments, when a test fails.
results="$root/test-results/iphone-ui.xcresult"
rm -rf "$results"
mkdir -p "$(dirname "$results")"
status=0
xcodebuild test -project DevotUITests.xcodeproj -scheme DevotUITests \
  -destination "id=$device" -resultBundlePath "$results" ${DEVOT_UI_TESTS:-} >"$log" 2>&1 || status=$?
grep -E "^Test Case|error: |\*\* TEST|Executed [0-9]+ test|Issue:|audit|Evidence: " "$log" || tail -n 60 "$log"
rm -f "$log"
exit "$status"
