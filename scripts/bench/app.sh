#!/bin/bash
# `pnpm bench:app`: launch time and memory of a built Devot.app (macOS, local only).
# Per launch: ms to the first frame and to the open note (its title field) (scripts/perf/first-paint.swift),
# and resident MB of the app plus the WebKit processes that started with it, 3 s after the note shows
# shows; --cold drops the file cache first (`sudo purge`). One more launch idles 60 s, then is
# sampled. Writes docs/benchmarks/app-results.json. Needs Accessibility permission for the terminal.
# Runs with HOME in a temporary folder, as scripts/perf/launch-cost.sh does. Quit Devot first.
# Not measured: memory after opening a large note or after typing (the probe cannot type).
# usage: app.sh [path to Devot.app, default /Applications/Devot.app] [runs, default 5] [--cold]
set -euo pipefail

COLD=0
POSITIONAL=()
for arg in "$@"; do
  if [ "$arg" = "--cold" ]; then COLD=1; else POSITIONAL+=("$arg"); fi
done
APP="${POSITIONAL[0]:-/Applications/Devot.app}"
RUNS="${POSITIONAL[1]:-5}"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
# shellcheck source=SCRIPTDIR/../app-data.sh
source "$ROOT/scripts/app-data.sh"

[ -x "$APP/Contents/MacOS/devot" ] || { echo "Not a Devot.app: $APP" >&2; exit 1; }
if pgrep -x devot >/dev/null; then
  echo "Quit Devot first" >&2
  exit 1
fi

# The editor is not always in the accessibility tree (a note can open in Preview), the title field is.
export DEVOT_PROBE_LABEL="Title"
PID=""
MS=""
SHELL_MS=""
WORK="$(mktemp -d)"
# shellcheck disable=SC2329 # the EXIT trap below runs it
finish() {
  if [ -n "$PID" ]; then app_stop "$PID" || true; fi
  rm -rf "$WORK"
}
trap finish EXIT
PROBE="$WORK/first-paint"
APP_HOME="$WORK/home"
RESULTS="$WORK/results.tsv"
mkdir "$APP_HOME"
swiftc -O "$ROOT/scripts/perf/first-paint.swift" -o "$PROBE"

webkit_pids() { pgrep -f 'com.apple.WebKit' | sort || true; }

BEFORE=""
launch() {
  BEFORE="$(webkit_pids)"
  read -r SHELL_MS MS PID < <(HOME="$APP_HOME" "$PROBE" "$@" "$APP")
}

quit() {
  local reporter r tries
  reporter="$(pgrep -P "$PID" -f -- '--crash-reporter' || true)"
  app_stop "$PID" || true
  PID=""
  for r in $reporter; do
    tries=50
    while app_running "$r" && ((tries-- > 0)); do sleep 0.2; done
    if app_running "$r"; then app_stop "$r" || true; fi
  done
  sleep 1
}

# Counts WebKit processes that appeared since launch; wrong if another WebKit app starts meanwhile.
rss_mb() {
  local total=0 kb p
  for p in "$PID" $(comm -13 <(echo "$BEFORE") <(webkit_pids)); do
    kb="$(ps -o rss= -p "$p" 2>/dev/null | tr -d ' ' || true)"
    total=$((total + ${kb:-0}))
  done
  echo $((total / 1024))
}

record() { printf '%s\t%s\n' "$1" "$2" >>"$RESULTS"; }

launch --seed
if ! app_wait_for_db "$PID" "$APP_HOME" 10; then
  echo "E_PERF_DATA_FOLDER: the app did not open its database under $APP_HOME" >&2
  exit 1
fi
sleep 3
quit

kinds=(warm)
if [ "$COLD" = 1 ]; then kinds=(cold warm); fi
for kind in "${kinds[@]}"; do
  for i in $(seq "$RUNS"); do
    if [ "$kind" = cold ]; then sudo purge; fi
    launch
    sleep 3
    mem="$(rss_mb)"
    echo "$kind $i: $SHELL_MS ms to the first frame, $MS ms to the open note, $mem MB resident"
    record "$kind.firstFrameMs" "$SHELL_MS"
    record "$kind.openNoteMs" "$MS"
    record "$kind.residentMB" "$mem"
    quit
  done
done

launch
echo "idle: waiting 60 s"
sleep 60
idle="$(rss_mb)"
foot="$(footprint "$PID" | grep 'Footprint:' | head -1 | xargs)"
echo "idle: $idle MB resident (app and its WebKit processes); app $foot"
record "idle.residentMB" "$idle"
quit

node "$ROOT/scripts/bench/app-results.ts" "$RESULTS" "$APP" "$ROOT/docs/benchmarks/app-results.json"
