#!/bin/sh
# CI helper: runs the iPhone UI test (src-tauri/apple/DevotUITests) against the app that
# `pnpm tauri ios build --debug --target aarch64-sim` made. The app is installed on an iPhone
# simulator and the test launches it by its bundle ID, since Tauri's Xcode project builds Rust only
# under the Tauri CLI. XcodeGen makes the test project from DevotUITests/project.yml; it is
# generated here and never committed.
# The newest iPhone runtime is used; DEVOT_UI_SIMULATOR picks a simulator by UDID instead.
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
device=${DEVOT_UI_SIMULATOR:-$(xcrun simctl list devices available --json | node -e '
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
  console.error(`iPhone UI test on ${phone.name}, iOS ${version(runtimes[0]).join(".")}`)
  console.log(phone.udid)
')}
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
  -destination "id=$device" -resultBundlePath "$results" >"$log" 2>&1 || status=$?
grep -E "^Test Case|error: |\*\* TEST|Executed [0-9]+ test|Issue:|audit|Evidence: " "$log" || tail -n 60 "$log"
rm -f "$log"
exit "$status"
