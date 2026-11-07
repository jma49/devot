#!/bin/sh
# CI helper: runs the native screens' tests (src-tauri/apple/DevotScreens) on an iPhone simulator.
# UIKit needs an app with a window scene, so XcodeGen makes a test project with an empty host app
# from TestHost/project.yml; the project is generated here and never committed.
# The newest iPhone runtime is used; DEVOT_SCREENS_SIMULATOR picks a simulator by UDID instead.
set -eu
cd "$(dirname "$0")/../../src-tauri/apple/DevotScreens/TestHost"
xcodegen generate --quiet
device=${DEVOT_SCREENS_SIMULATOR:-$(xcrun simctl list devices available --json | node -e '
  const { devices } = JSON.parse(require("fs").readFileSync(0, "utf8"))
  const version = (runtime) => (runtime.match(/iOS-(\d+)-(\d+)/) ?? []).slice(1).map(Number)
  const newer = (a, b) => version(b)[0] - version(a)[0] || version(b)[1] - version(a)[1]
  const phones = (runtime) => devices[runtime].filter((d) => d.name.startsWith("iPhone"))
  const runtimes = Object.keys(devices).filter((r) => r.includes(".iOS-") && phones(r).length).sort(newer)
  if (!runtimes.length) {
    console.error("no iPhone simulator runtime is installed")
    process.exit(1)
  }
  const phone = phones(runtimes[0])[0]
  console.error(`screens tests on ${phone.name}, iOS ${version(runtimes[0]).join(".")}`)
  console.log(phone.udid)
')}
log=$(mktemp)
status=0
xcodebuild test -project DevotScreensTests.xcodeproj -scheme DevotScreensTests \
  -destination "id=$device" >"$log" 2>&1 || status=$?
grep -E "^Test Case|error: |\*\* TEST|Executed [0-9]+ test" "$log" || tail -n 60 "$log"
rm -f "$log"
exit "$status"
