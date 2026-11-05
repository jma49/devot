#!/bin/sh
# CI helper: runs the StoreKit bridge's tests (src-tauri/apple/DevotStore) on an iPhone simulator.
# StoreKit Test runs only inside an app, so XcodeGen makes a test project with an empty host app
# from TestHost/project.yml; the project is generated here and never committed.
# DEVOT_STORE_SIMULATOR picks a simulator by UDID; otherwise the newest available iPhone is used.
set -eu
cd "$(dirname "$0")/../../src-tauri/apple/DevotStore/TestHost"
xcodegen generate --quiet
device=${DEVOT_STORE_SIMULATOR:-$(xcrun simctl list devices available --json | node -e '
  const { devices } = JSON.parse(require("fs").readFileSync(0, "utf8"))
  const version = (runtime) => (runtime.match(/iOS-(\d+)-(\d+)/) ?? []).slice(1).map(Number)
  const newer = (a, b) => version(b)[0] - version(a)[0] || version(b)[1] - version(a)[1]
  const runtime = Object.keys(devices).filter((r) => r.includes(".iOS-")).sort(newer)
    .find((r) => devices[r].some((d) => d.name.startsWith("iPhone")))
  if (!runtime) process.exit(1)
  const phone = devices[runtime].find((d) => d.name.startsWith("iPhone"))
  console.error(`StoreKit tests on ${phone.name}, ${runtime}`)
  console.log(phone.udid)
')}
xcodebuild test -project DevotStoreTests.xcodeproj -scheme DevotStoreTests \
  -destination "id=$device" -quiet
