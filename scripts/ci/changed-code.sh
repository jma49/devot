#!/bin/sh
# CI helper: reads the names of the files a pull request changes, one per
# line, on stdin and prints which build jobs it needs, as `web=true|false`
# and `rust=true|false`. Used by .github/workflows/ci.yml; when the web jobs
# are not needed, the `policy` job runs instead: the format check, lint, the
# type check and all of Vitest, which also reads Rust sources, migrations and
# capabilities and runs the tests of the sync relay and the licence Worker.
#
# - Documentation (a file under docs/, or a Markdown file outside src/) and
#   the design sources of the app icon (design/app-icon/) need neither. A
#   Markdown file under src/ is part of the UI (the welcome notes), so it needs
#   both.
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
# - Everything else needs both: the Rust job builds the UI that the binary
#   embeds, and a change to the tooling or CI itself could break either.
# A list with no files needs both, so a doubt runs everything.
web=false
rust=false
seen=false
while IFS= read -r file; do
  [ -n "$file" ] || continue
  seen=true
  case "$file" in
    licence/test-vectors.json) rust=true ;;
    src/*)
      web=true
      rust=true
      ;;
    docs/* | *.md | design/app-icon/* | relay/* | licence/*) ;;
    src-tauri/tauri.conf.json)
      web=true
      rust=true
      ;;
    src-tauri/plugin-frame/*)
      web=true
      rust=true
      ;;
    src-tauri/*) rust=true ;;
    *)
      web=true
      rust=true
      ;;
  esac
done
if [ "$seen" = false ]; then
  web=true
  rust=true
fi
echo "web=$web"
echo "rust=$rust"
