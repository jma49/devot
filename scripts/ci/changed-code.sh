#!/bin/sh
# CI helper: reads the names of the files a pull request changes, one per
# line, on stdin and prints which build jobs it needs, as `web=true|false`,
# `rust=true|false` and `iphone_ui=true|false`. Used by .github/workflows/ci.yml; when the web jobs
# are not needed, the `policy` job runs instead: the format check, lint, the
# type check and all of Vitest, which also reads Rust sources, migrations and
# capabilities and runs the tests of the sync relay and the licence Worker.
#
# - Documentation (a file under docs/, or a Markdown file outside src/) and
#   the design sources of the app icon (design/app-icon/) need neither. A
#   Markdown file under src/ is part of the UI (the welcome notes), so it needs
#   both. A change made only of documentation gets `docs_only=true`, so CI can
#   skip the expensive jobs while its always-on gates still satisfy the
#   required checks.
# - The sync relay (relay/) and the licence Worker (licence/) need neither:
#   the app imports neither, and the policy job checks both.
# - src-tauri/tauri.conf.json needs both: the UI tests serve the built UI
#   under the CSP it declares.
# - src-tauri/plugin-frame/ needs both: the UI tests run those pages, and Rust
#   serves them.
# - licence/test-vectors.json needs the Rust job: the app's licence tests check
#   that it accepts the keys the vectors hold.
# - Anything else under src-tauri/ (Rust code, Cargo files, migrations,
#   capabilities, the app icons the binary embeds) needs the Rust job; the
#   Vitest tests that read those files run in the `policy` job.
# - The TypeScript tests and UI specs under tests/ need the web jobs; the
#   shared fixtures (tests/fixtures/) and case files (tests/support/*.json)
#   are also read by the Rust tests, so they need both.
# - Everything else needs both: the Rust job builds the UI that the binary
#   embeds, and a change to the tooling or CI itself could break either.
# - The iPhone UI test (`iphone-ui`), which builds and launches the whole app,
#   runs for the Swift packages and the app project (src-tauri/apple/,
#   src-tauri/gen/apple/), the phone's native code (src-tauri/src/native/ios/),
#   the screens bridge on every side (any screens/ folder), the phone page
#   (src/renderer/src/phone/), its own script and the scripts that pick its Xcode and simulator.
# A list with no files needs everything, so a doubt runs everything.
web=false
iphone_ui=false
rust=false
docs_only=true
seen=false
while IFS= read -r file; do
  [ -n "$file" ] || continue
  seen=true
  case "$file" in
    licence/test-vectors.json)
      rust=true
      docs_only=false
      ;;
    src/*)
      web=true
      rust=true
      docs_only=false
      ;;
    docs/* | *.md) ;;
    design/app-icon/* | relay/* | licence/*) docs_only=false ;;
    src-tauri/tauri.conf.json)
      web=true
      rust=true
      docs_only=false
      ;;
    src-tauri/plugin-frame/*)
      web=true
      rust=true
      docs_only=false
      ;;
    src-tauri/*)
      rust=true
      docs_only=false
      ;;
    tests/fixtures/* | tests/support/*.json)
      web=true
      rust=true
      docs_only=false
      ;;
    tests/*)
      web=true
      docs_only=false
      ;;
    *)
      web=true
      rust=true
      docs_only=false
      ;;
  esac
  case "$file" in
    src-tauri/apple/* | src-tauri/gen/apple/* | src-tauri/src/native/ios/* | */screens/* | \
      src/renderer/src/phone/* | scripts/ci/iphone-ui-tests.sh | scripts/ci/iphone-simulator.ts | \
      scripts/ci/xcode.sh)
      iphone_ui=true
      ;;
  esac
done
if [ "$seen" = false ]; then
  web=true
  rust=true
  docs_only=false
  iphone_ui=true
fi
echo "web=$web"
echo "rust=$rust"
echo "docs_only=$docs_only"
echo "iphone_ui=$iphone_ui"
