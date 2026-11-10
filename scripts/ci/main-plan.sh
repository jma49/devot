#!/bin/sh
# CI helper: reads the names of the files changed on main since its last CI run that passed, one per
# line, on stdin and prints what this run needs, in changed-code.sh's terms.
# A pull request runs what its own files need and leaves the rest to main, so main runs in full
# whenever code changed. Two things it leaves out: everything but the always-on gates when nothing
# but documentation changed, and the tests of a Swift package nothing touched, which link neither
# the UI nor Rust. Either way the macOS runners stay free for the pull requests waiting on them.
set -eu
flags=$(sh "$(dirname "$0")/changed-code.sh")
if printf '%s\n' "$flags" | grep -qx 'docs_only=true'; then
  printf '%s\n' "$flags"
else
  printf 'web=true\nrust=true\ndocs_only=false\niphone_ui=true\n'
  printf '%s\n' "$flags" | grep -E '^(screens|storekit)='
fi
