#!/bin/sh
# DIAGNOSTIC RUN: builds once, then runs the StoreKit tests on one iPhone of every runtime and
# prints storekitd's log for each. Replaced by the real script once the cause is known.
set -u
cd "$(dirname "$0")/../../src-tauri/apple/DevotStore/TestHost"
xcodegen generate --quiet
xcodebuild -version
xcodebuild build-for-testing -project DevotStoreTests.xcodeproj -scheme DevotStoreTests \
  -destination 'generic/platform=iOS Simulator' -derivedDataPath .build/dd -quiet || exit 1
xcrun simctl list devices available --json | node -e '
  const { devices } = JSON.parse(require("fs").readFileSync(0, "utf8"))
  for (const [runtime, list] of Object.entries(devices).sort(([a], [b]) => b.localeCompare(a, "en", { numeric: true }))) {
    const phone = list.find((d) => d.name.startsWith("iPhone"))
    if (runtime.endsWith(".iOS-26-2") && phone) console.log(`${phone.udid} ${runtime}`)
  }
' | while read -r device runtime; do
  echo "::group::StoreKit tests on $runtime"
  xcrun simctl boot "$device" 2>/dev/null
  xcrun simctl bootstatus "$device" -b >/dev/null 2>&1
  start=$(date '+%Y-%m-%d %H:%M:%S')
  xcodebuild test-without-building -project DevotStoreTests.xcodeproj -scheme DevotStoreTests \
    -destination "id=$device" -derivedDataPath .build/dd -test-iterations 6 2>&1 |
    grep -E "failed \(|error: |\*\* TEST|Executed [0-9]+ test" | cut -c1-240
  echo "--- storekitd on $runtime"
  xcrun simctl spawn "$device" log show --start "$start" --style compact \
    --predicate '(process == "storekitd" OR process == "DevotStoreHost") AND subsystem BEGINSWITH "com.apple.storekit"' 2>/dev/null |
    grep -iE "refund|revo|push action|updates|Test Case|unverified|verif" | cut -c1-260 | head -n 400
  xcrun simctl shutdown "$device" 2>/dev/null
  echo "::endgroup::"
done
exit 1
