#!/bin/sh
# CI helper: runs the native screens' tests (src-tauri/apple/DevotScreens) on an iPhone simulator.
# UIKit needs an app with a window scene, so XcodeGen makes a test project with an empty host app
# from TestHost/project.yml; the project is generated here and never committed.
# The simulator is scripts/ci/iphone-simulator.ts's pick; DEVOT_SCREENS_SIMULATOR, or DEVOT_SIMULATOR,
# picks one by UDID instead.
set -eu
root=$(cd "$(dirname "$0")/../.." && pwd)
cd "$root/src-tauri/apple/DevotScreens/TestHost"
xcodegen generate --quiet
device=${DEVOT_SCREENS_SIMULATOR:-${DEVOT_SIMULATOR:-$(xcrun simctl list devices available --json |
  node "$root/scripts/ci/iphone-simulator.ts")}}
# CI boots the simulator early, in the background; this waits for it, or boots it.
sh "$root/scripts/ci/iphone-simulator-ready.sh" "$device"
log=$(mktemp)
status=0
# A test that fails once is run again, so a one-off stall on a loaded runner does not fail the job;
# a test that fails twice does.
xcodebuild test -project DevotScreensTests.xcodeproj -scheme DevotScreensTests \
  -destination "id=$device" -retry-tests-on-failure -test-iterations 2 >"$log" 2>&1 || status=$?
grep -E "^Test Case|error: |\*\* TEST|Executed [0-9]+ test" "$log" || tail -n 60 "$log"
rm -f "$log"
exit "$status"
