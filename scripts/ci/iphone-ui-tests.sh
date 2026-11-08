#!/bin/sh
# CI helper: runs the iPhone UI test (src-tauri/apple/DevotUITests) against the app that
# `pnpm tauri ios build --debug --target aarch64-sim` made, in two steps that CI runs in different jobs:
# - `build` builds the test runner (xcodebuild build-for-testing) and puts it, with the .xctestrun
#   and a copy of the app, in test-results/iphone-ui-build/ (DEVOT_UI_BUILD names another folder);
# - `test` installs that app on an iPhone simulator and runs the tests from that folder
#   (test-without-building). The test launches the app by its bundle ID, since Tauri's Xcode project
#   builds Rust only under the Tauri CLI.
# - `settle` (CI) installs the app on the booted simulator, starts it once and waits for the
#   machine to calm down, so the tests do not start on a simulator still busy with its first boot.
# With no argument it runs build and test. XcodeGen makes the test project from DevotUITests/project.yml; it is
# generated here and never committed. DEVOT_UI_SHARD runs one shard of the tests
# (scripts/ci/iphone-ui-shards.ts); DEVOT_UI_TESTS holds any other xcodebuild selection, such as
# -only-testing:DevotUITests/TabsTests.
# The simulator is scripts/ci/iphone-simulator.ts's pick; DEVOT_UI_SIMULATOR, or DEVOT_SIMULATOR,
# picks one by UDID instead.
set -eu
root=$(cd "$(dirname "$0")/../.." && pwd)
bundle=${DEVOT_UI_BUILD:-$root/test-results/iphone-ui-build}
app_id=io.github.jma49.devot
step=${1:-all}

build_runner() {
  # Tauri leaves a simulator build under gen/apple/build; Xcode's derived data is the fallback.
  app=$(find "$root/src-tauri/gen/apple/build" "$HOME/Library/Developer/Xcode/DerivedData" \
    -type d -name Devot.app -path '*sim*' -prune 2>/dev/null | head -n 1)
  if [ -z "$app" ]; then
    echo "E_IPHONE_UI_NO_APP: no simulator build of Devot.app; run pnpm tauri ios build --debug --target aarch64-sim first" >&2
    exit 1
  fi
  echo "app: $app"
  cd "$root/src-tauri/apple/DevotUITests"
  xcodegen generate --quiet
  work=$(mktemp -d)
  # Only the Apple silicon simulator runs the tests, so the runner is built for arm64 alone.
  if ! xcodebuild build-for-testing -project DevotUITests.xcodeproj -scheme DevotUITests \
    -destination 'generic/platform=iOS Simulator' -derivedDataPath "$work" ARCHS=arm64 \
    >"$work/build.log" 2>&1; then
    grep -E "error: " "$work/build.log" || tail -n 60 "$work/build.log"
    rm -rf "$work"
    echo "E_IPHONE_UI_BUILD_FAILED" >&2
    exit 1
  fi
  rm -rf "$bundle"
  mkdir -p "$bundle/Debug-iphonesimulator"
  cp "$work"/Build/Products/*.xctestrun "$bundle/"
  cp -R "$work"/Build/Products/Debug-iphonesimulator/*.app "$bundle/Debug-iphonesimulator/"
  cp -R "$app" "$bundle/Devot.app"
  rm -rf "$work"
  du -sh "$bundle"
}

simulator() {
  echo "${DEVOT_UI_SIMULATOR:-${DEVOT_SIMULATOR:-$(xcrun simctl list devices available --json |
    node "$root/scripts/ci/iphone-simulator.ts")}}"
}

need_build() {
  xctestrun=$(find "$bundle" -maxdepth 1 -name '*.xctestrun' 2>/dev/null | head -n 1)
  if [ -z "$xctestrun" ] || [ ! -d "$bundle/Devot.app" ]; then
    echo "E_IPHONE_UI_NO_BUILD: $bundle holds no test runner and app; run $0 build first" >&2
    exit 1
  fi
}

# A cold-booted simulator keeps a CI runner busy for minutes, and WebKit's first start in it is the
# slowest part: tests started then found an empty web view and missed their waits. The app is
# started once, and the tests wait until the one-minute load is under the core count, for at most
# DEVOT_UI_SETTLE seconds (240).
settle() {
  need_build
  device=$(simulator)
  xcrun simctl bootstatus "$device" -b >/dev/null
  xcrun simctl install "$device" "$bundle/Devot.app"
  xcrun simctl launch "$device" "$app_id" >/dev/null
  cores=$(sysctl -n hw.ncpu)
  limit=${DEVOT_UI_SETTLE:-240}
  waited=0
  while :; do
    load=$(sysctl -n vm.loadavg | awk '{ print $2 }')
    awk -v load="$load" -v cores="$cores" 'BEGIN { exit !(load < cores) }' && break
    if [ "$waited" -ge "$limit" ]; then
      echo "settle: still busy after ${waited}s; testing anyway"
      break
    fi
    [ $((waited % 60)) -eq 0 ] && echo "settle: load $load on $cores cores after ${waited}s"
    sleep 15
    waited=$((waited + 15))
  done
  xcrun simctl terminate "$device" "$app_id" >/dev/null 2>&1 || true
  echo "settle: load $load on $cores cores after ${waited}s"
}

run_tests() {
  need_build
  selection=${DEVOT_UI_TESTS:-}
  if [ -n "${DEVOT_UI_SHARD:-}" ]; then
    selection=$(node "$root/scripts/ci/iphone-ui-shards.ts" "$DEVOT_UI_SHARD")
  fi
  echo "tests: ${selection:-all}"
  device=$(simulator)
  xcrun simctl bootstatus "$device" -b >/dev/null
  xcrun simctl install "$device" "$bundle/Devot.app"
  log=$(mktemp)
  # CI uploads the result bundle, with the tests' attachments, when a test fails.
  results="$root/test-results/iphone-ui.xcresult"
  rm -rf "$results"
  mkdir -p "$(dirname "$results")"
  status=0
  # shellcheck disable=SC2086
  xcodebuild test-without-building -xctestrun "$xctestrun" -destination "id=$device" \
    -resultBundlePath "$results" $selection >"$log" 2>&1 || status=$?
  grep -E "^Test Case|error: |\*\* TEST|Executed [0-9]+ test|Issue:|audit|Evidence: " "$log" || tail -n 60 "$log"
  rm -f "$log"
  return "$status"
}

case "$step" in
  build) build_runner ;;
  settle) settle ;;
  test) run_tests ;;
  all)
    build_runner
    run_tests
    ;;
  *)
    echo "E_IPHONE_UI_STEP: $step is not build, settle, test or empty" >&2
    exit 2
    ;;
esac
