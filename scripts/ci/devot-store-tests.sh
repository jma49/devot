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
# A test that hangs fails after two minutes instead of holding the job to its timeout.
xcodebuild test -project DevotStoreTests.xcodeproj -scheme DevotStoreTests \
  -destination "id=$device" -test-timeouts-enabled YES \
  -default-test-execution-time-allowance 60 -maximum-test-execution-time-allowance 120 \
  >"$log" 2>&1 || status=$?
grep -E "^Test Case|error: |\*\* TEST|Executed [0-9]+ test" "$log" || tail -n 60 "$log"
rm -f "$log"
if [ "$status" -ne 0 ]; then
  echo "storekitd errors during the run:"
  xcrun simctl spawn "$device" log show --start "$start" --style compact \
    --predicate 'process == "storekitd" AND subsystem BEGINSWITH "com.apple.storekit" AND messageType == error' \
    2>/dev/null | cut -c1-240 | head -n 40
fi
exit "$status"
