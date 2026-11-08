#!/bin/sh
# CI helper: runs the iPhone UI test (src-tauri/apple/DevotUITests) against the app that
# `pnpm tauri ios build --debug --target aarch64-sim` made, in two steps that CI runs in different jobs:
# - `build` builds the test runner (xcodebuild build-for-testing) and puts it, with the .xctestrun
#   and a copy of the app, in test-results/iphone-ui-build/ (DEVOT_UI_BUILD names another folder);
# - `test` installs that app on an iPhone simulator and runs the tests from that folder
#   (test-without-building). The test launches the app by its bundle ID, since Tauri's Xcode project
#   builds Rust only under the Tauri CLI.
# With no argument it runs both. XcodeGen makes the test project from DevotUITests/project.yml; it is
# generated here and never committed. DEVOT_UI_SHARD runs one shard of the tests
# (scripts/ci/iphone-ui-shards.ts); DEVOT_UI_TESTS holds any other xcodebuild selection, such as
# -only-testing:DevotUITests/TabsTests.
# The simulator is scripts/ci/iphone-simulator.ts's pick; DEVOT_UI_SIMULATOR, or DEVOT_SIMULATOR,
# picks one by UDID instead.
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

run_tests() {
  xctestrun=$(find "$bundle" -maxdepth 1 -name '*.xctestrun' 2>/dev/null | head -n 1)
  if [ -z "$xctestrun" ] || [ ! -d "$bundle/Devot.app" ]; then
    echo "E_IPHONE_UI_NO_BUILD: $bundle holds no test runner and app; run $0 build first" >&2
    exit 1
  fi
  selection=${DEVOT_UI_TESTS:-}
  if [ -n "${DEVOT_UI_SHARD:-}" ]; then
    selection=$(node "$root/scripts/ci/iphone-ui-shards.ts" "$DEVOT_UI_SHARD")
  fi
  echo "tests: ${selection:-all}"
  device=${DEVOT_UI_SIMULATOR:-${DEVOT_SIMULATOR:-$(xcrun simctl list devices available --json |
    node "$root/scripts/ci/iphone-simulator.ts")}}
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
  test) run_tests ;;
  all)
    build_runner
    run_tests
    ;;
  *)
    echo "E_IPHONE_UI_STEP: $step is not build, test or empty" >&2
    exit 2
    ;;
esac
