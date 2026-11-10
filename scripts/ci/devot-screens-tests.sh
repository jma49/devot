#!/bin/sh
# CI helper: runs the native screens' tests (src-tauri/apple/DevotScreens) on an iPhone simulator.
# UIKit needs an app with a window scene, so XcodeGen makes a test project with an empty host app
# from TestHost/project.yml; the project is generated here and never committed.
# The simulator is scripts/ci/iphone-simulator.ts's pick; DEVOT_SCREENS_SIMULATOR, or DEVOT_SIMULATOR,
# picks one by UDID instead. DEVOT_SCREENS_PART, as `1/2`, runs that part of the test classes
# (scripts/ci/screens-shards.ts).
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
selection=
if [ -n "${DEVOT_SCREENS_PART:-}" ]; then
  selection=$(node "$root/scripts/ci/screens-shards.ts" "$DEVOT_SCREENS_PART")
fi
# shellcheck disable=SC2086
xcodebuild test -project DevotScreensTests.xcodeproj -scheme DevotScreensTests \
  -destination "id=$device" -retry-tests-on-failure -test-iterations 2 $selection >"$log" 2>&1 || status=$?
grep -E "^Test Case|error: |\*\* TEST|Executed [0-9]+ test" "$log" || tail -n 60 "$log"
# A green run whose log still has a failed test passed it on the retry: listed so it is fixed.
if [ "$status" -eq 0 ]; then
  sed -n "s/^Test Case '-\[\(.*\)\]' failed.*/\1/p" "$log" | sort -u | while read -r test; do
    echo "::warning title=Flaky screens test::$test"
    [ -n "${GITHUB_STEP_SUMMARY:-}" ] && echo "- Flaky (passed on retry): $test" >>"$GITHUB_STEP_SUMMARY"
  done
fi
rm -f "$log"
exit "$status"
