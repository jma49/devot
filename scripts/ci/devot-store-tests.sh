#!/bin/sh
# CI helper: runs the StoreKit bridge's tests (src-tauri/apple/DevotStore) on an iPhone simulator.
# StoreKit Test runs only inside an app, so XcodeGen makes a test project with an empty host app
# from TestHost/project.yml; the project is generated here and never committed.
# The iOS 26.5 simulator cannot load a StoreKit configuration outside the Xcode app (FB22237318),
# so the newest iPhone runtime before it is used when there is one. DEVOT_STORE_SIMULATOR picks a
# simulator by UDID instead.
set -eu
cd "$(dirname "$0")/../../src-tauri/apple/DevotStore/TestHost"
xcodegen generate --quiet
device=${DEVOT_STORE_SIMULATOR:-$(xcrun simctl list devices available --json | node -e '
  const { devices } = JSON.parse(require("fs").readFileSync(0, "utf8"))
  const version = (runtime) => (runtime.match(/iOS-(\d+)-(\d+)/) ?? []).slice(1).map(Number)
  const newer = (a, b) => version(b)[0] - version(a)[0] || version(b)[1] - version(a)[1]
  const phones = (runtime) => devices[runtime].filter((d) => d.name.startsWith("iPhone"))
  const runtimes = Object.keys(devices).filter((r) => r.includes(".iOS-") && phones(r).length).sort(newer)
  console.error(`iPhone runtimes: ${runtimes.map((r) => version(r).join(".")).join(", ")}`)
  const broken = (r) => version(r)[0] === 26 && version(r)[1] === 5
  const runtime = runtimes.find((r) => !broken(r)) ?? runtimes[0]
  if (!runtime) process.exit(1)
  const phone = phones(runtime)[0]
  console.error(`StoreKit tests on ${phone.name}, iOS ${version(runtime).join(".")}`)
  console.log(phone.udid)
')}
log=$(mktemp)
status=0
xcodebuild test -project DevotStoreTests.xcodeproj -scheme DevotStoreTests \
  -destination "id=$device" >"$log" 2>&1 || status=$?
grep -E "^Test Case|error: |\*\* TEST|Executed [0-9]+ test" "$log" || tail -n 60 "$log"
rm -f "$log"
exit "$status"
