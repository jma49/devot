#!/bin/sh
# CI helper: runs the StoreKit bridge's tests (src-tauri/apple/DevotStore) on an iPhone simulator.
# StoreKit Test runs only inside an app, so XcodeGen makes a test project with an empty host app
# from TestHost/project.yml; the project is generated here and never committed.
# The simulator is scripts/ci/iphone-simulator.ts's pick, which leaves out the iOS versions whose
# StoreKit Test is broken; DEVOT_STORE_SIMULATOR, or DEVOT_SIMULATOR, picks one by UDID instead.
set -eu
root=$(cd "$(dirname "$0")/../.." && pwd)
cd "$root/src-tauri/apple/DevotStore/TestHost"
xcodegen generate --quiet
device=${DEVOT_STORE_SIMULATOR:-${DEVOT_SIMULATOR:-$(xcrun simctl list devices available --json |
  node "$root/scripts/ci/iphone-simulator.ts" --storekit)}}
# CI boots the simulator early, in the background; this waits for it, or boots it.
sh "$root/scripts/ci/iphone-simulator-ready.sh" "$device"
log=$(mktemp)
start=$(date '+%Y-%m-%d %H:%M:%S')
status=0
# A test that hangs fails after two minutes instead of holding the job to its timeout; a purchase
# took 82 s on a loaded runner, and xcodebuild reruns no test that ran out of time. A test that
# fails once is run again: the simulator's StoreKit Test server answers some purchases with a server
# error (AMSErrorDomain 305) on a loaded runner; a test that fails twice fails the job.
xcodebuild test -project DevotStoreTests.xcodeproj -scheme DevotStoreTests \
  -destination "id=$device" -test-timeouts-enabled YES \
  -default-test-execution-time-allowance 120 -maximum-test-execution-time-allowance 120 \
  -retry-tests-on-failure -test-iterations 2 \
  >"$log" 2>&1 || status=$?
grep -E "^Test Case|error: |\*\* TEST|Executed [0-9]+ test" "$log" || tail -n 60 "$log"
# A green run whose log still has a failed test passed it on the retry: listed so it is fixed.
if [ "$status" -eq 0 ]; then
  sed -n "s/^Test Case '-\[\(.*\)\]' failed.*/\1/p" "$log" | sort -u | while read -r test; do
    echo "::warning title=Flaky StoreKit test::$test"
    [ -n "${GITHUB_STEP_SUMMARY:-}" ] && echo "- Flaky (passed on retry): $test" >>"$GITHUB_STEP_SUMMARY"
  done
fi
rm -f "$log"
if [ "$status" -ne 0 ]; then
  echo "storekitd errors during the run:"
  xcrun simctl spawn "$device" log show --start "$start" --style compact \
    --predicate 'process == "storekitd" AND subsystem BEGINSWITH "com.apple.storekit" AND messageType == error' \
    2>/dev/null | cut -c1-240 | head -n 40
fi
exit "$status"
