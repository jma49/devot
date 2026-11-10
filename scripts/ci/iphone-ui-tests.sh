#!/bin/sh
# CI helper: runs the iPhone UI test (src-tauri/apple/DevotUITests) against the app that
# `pnpm tauri ios build --debug --target aarch64-sim` made, in two steps that CI runs in different jobs:
# - `build` builds the test runner (xcodebuild build-for-testing) and puts it, with the .xctestrun
#   and a copy of the app, in test-results/iphone-ui-build/ (DEVOT_UI_BUILD names another folder);
# - `test` installs that app on an iPhone simulator and runs the tests from that folder
#   (test-without-building). The test launches the app by its bundle ID, since Tauri's Xcode project
#   builds Rust only under the Tauri CLI.
# - `settle` (CI) installs the app on the booted simulator and starts it once, until its web view
#   has started, so the tests do not meet WebKit's slow first start.
# With no argument it runs build and test. XcodeGen makes the test project from DevotUITests/project.yml; it is
# generated here and never committed. DEVOT_UI_SHARD runs one shard of the tests
# (scripts/ci/iphone-ui-shards.ts); DEVOT_UI_TESTS holds any other xcodebuild selection, such as
# -only-testing:DevotUITests/TabsTests.
# The simulator is scripts/ci/iphone-simulator.ts's pick; DEVOT_UI_SIMULATOR, or DEVOT_SIMULATOR,
# picks one by UDID instead. DEVOT_UI_WAIT_SCALE multiplies the tests' waits (CI sets 3).
set -eu
root=$(cd "$(dirname "$0")/../.." && pwd)
bundle=${DEVOT_UI_BUILD:-$root/test-results/iphone-ui-build}
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

# WebKit's first start in a freshly booted simulator is the slowest part: tests started before it
# found an empty web view and missed their waits. The app is started once and the tests go on as
# soon as its web view has made its WebKit folders, for at most DEVOT_UI_SETTLE seconds (120). The
# xcode-27 runner's load stays in the hundreds on 3 cores (PR #790), so waiting for a calm machine
# was a fixed 4 minute sleep.
settle() {
  need_build
  device=$(simulator)
  began=$(date +%s)
  sh "$root/scripts/ci/iphone-simulator-ready.sh" "$device"
  echo "settle: simulator booted, $(($(date +%s) - began))s into the step"
  xcrun simctl install "$device" "$bundle/Devot.app"
  app_id=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$bundle/Devot.app/Info.plist")
  xcrun simctl launch "$device" "$app_id" >/dev/null
  echo "settle: app launched, $(($(date +%s) - began))s into the step"
  data=$(xcrun simctl get_app_container "$device" "$app_id" data)
  limit=${DEVOT_UI_SETTLE:-120}
  waited=0
  until [ -n "$(find "$data/Library" -maxdepth 3 -type d -name WebKit 2>/dev/null | head -n 1)" ]; do
    if [ "$waited" -ge "$limit" ]; then
      echo "settle: no web view after ${waited}s; testing anyway"
      break
    fi
    sleep 5
    waited=$((waited + 5))
  done
  # The first page load runs on after the folders appear.
  sleep 10
  xcrun simctl terminate "$device" "$app_id" >/dev/null 2>&1 || true
  echo "settle: web view started after ${waited}s"
}

run_tests() {
  need_build
  selection=${DEVOT_UI_TESTS:-}
  if [ -n "${DEVOT_UI_SHARD:-}" ]; then
    selection=$(node "$root/scripts/ci/iphone-ui-shards.ts" "$DEVOT_UI_SHARD")
  fi
  echo "tests: ${selection:-all}"
  device=$(simulator)
  sh "$root/scripts/ci/iphone-simulator-ready.sh" "$device"
  xcrun simctl install "$device" "$bundle/Devot.app"
  log=$(mktemp)
  # CI uploads the result bundle, with the tests' attachments, when a test fails.
  results="$root/test-results/iphone-ui.xcresult"
  rm -rf "$results"
  mkdir -p "$(dirname "$results")"
  status=0
  # xcodebuild hands TEST_RUNNER_-prefixed variables to the tests without the prefix (Tests/Waits.swift).
  export TEST_RUNNER_DEVOT_UI_WAIT_SCALE="${DEVOT_UI_WAIT_SCALE:-1}"
  # A test that fails once is run again, so a one-off simulator stall does not fail the job; a test
  # that fails twice fails it, and the log lists the first failure either way.
  shown="^Test Case|error: |\*\* TEST|Executed [0-9]+ test|Issue:|audit|Evidence: |Restarting after|uncaught exception"
  # shellcheck disable=SC2086
  xcodebuild test-without-building -xctestrun "$xctestrun" -destination "id=$device" \
    -retry-tests-on-failure -test-iterations 2 \
    -resultBundlePath "$results" $selection >"$log" 2>&1 || status=$?
  grep -E "$shown" "$log" || tail -n 60 "$log"
  # A failed UI test ends the test process, and xcodebuild goes on with the tests that are left
  # without running it again (scripts/ci/xctest-retry.ts): those tests get their second run here.
  again=
  [ "$status" -eq 0 ] || again=$(node "$root/scripts/ci/xctest-retry.ts" "$log")
  if [ -n "$again" ]; then
    echo "retry: $again"
    retry_results="$root/test-results/iphone-ui-retry.xcresult"
    rm -rf "$retry_results"
    status=0
    # shellcheck disable=SC2086
    xcodebuild test-without-building -xctestrun "$xctestrun" -destination "id=$device" \
      -resultBundlePath "$retry_results" $again >"$log.retry" 2>&1 || status=$?
    grep -E "$shown" "$log.retry" || tail -n 60 "$log.retry"
    rm -f "$log.retry"
  fi
  # A green run whose log still has a failed test passed it on the retry: listed so it is fixed.
  if [ "$status" -eq 0 ]; then
    sed -n "s/^Test Case '-\[\(.*\)\]' failed.*/\1/p" "$log" | sort -u | while read -r test; do
      echo "::warning title=Flaky iPhone UI test::$test"
      [ -n "${GITHUB_STEP_SUMMARY:-}" ] && echo "- Flaky (passed on retry): $test" >>"$GITHUB_STEP_SUMMARY"
    done
  fi
  rm -f "$log"
  # The app's own log holds codes and IDs only (src-tauri/src/logs.rs); its warnings say why a screen stayed empty.
  if [ "$status" -ne 0 ]; then
    app_id=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$bundle/Devot.app/Info.plist")
    data=$(xcrun simctl get_app_container "$device" "$app_id" data 2>/dev/null || true)
    find "${data:-/nonexistent}" -name devot.log -path '*logs*' 2>/dev/null | while read -r file; do
      echo "app log: warnings and errors"
      grep -E '"level":"(warn|error)"' "$file" | tail -n 40
    done
  fi
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
