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
  for (const [runtime, list] of Object.entries(devices)) {
    const phone = list.find((d) => d.name.startsWith("iPhone"))
    if (runtime.includes(".iOS-") && phone) console.log(`${phone.udid} ${runtime}`)
  }
' | while read -r device runtime; do
  echo "::group::StoreKit tests on $runtime"
  xcrun simctl boot "$device" 2>/dev/null
  xcrun simctl bootstatus "$device" -b >/dev/null 2>&1
  start=$(date '+%Y-%m-%d %H:%M:%S')
  xcodebuild test-without-building -project DevotStoreTests.xcodeproj -scheme DevotStoreTests \
    -destination "id=$device" -derivedDataPath .build/dd 2>&1 |
    grep -E "^Test Case|error: |\*\* TEST|Executed [0-9]+ test" | cut -c1-240
  echo "--- storekitd on $runtime"
  xcrun simctl spawn "$device" log show --start "$start" --style compact \
    --predicate 'process == "storekitd" AND (subsystem BEGINSWITH "com.apple.storekit" OR messageType == error)' 2>/dev/null |
    grep -E "XcodeTest|Octane|onfiguration|SKInternal|rror|products|IAP|Sandbox|Media API" |
    grep -vE "Applying configuration overrides|ams_cookies|containermanager" | cut -c1-300 | head -n 120
  xcrun simctl shutdown "$device" 2>/dev/null
  echo "::endgroup::"
done
exit 1
