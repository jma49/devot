#!/bin/bash
# Launch time and idle cost of a built Devot.app, against the budgets in
# docs/architecture.md (launch to first editor paint < 700 ms, idle memory
# footprint < 200 MB). Run it on a build without a DSN and on one with a DSN
# to see what native crash reports cost; the steps are in
# docs/architecture.md ("What native crash reports cost").
#
# Prints, per run, the milliseconds from starting the binary to the window
# showing the first editor paint (first-paint.swift; the empty shell's time is
# printed too): first <runs> cold runs (the file cache
# dropped with `sudo purge`, which asks for the password), then <runs> warm
# runs. Then it starts the app once more, waits 60 s and prints the footprint,
# CPU and idle wakeups of the app and of the crash reporter (DSN builds only).
#
# Needs macOS and Accessibility permission for the terminal. The app runs
# with HOME in a temporary folder, so its data folder is a new one there,
# made by a first launch that is not timed: a release build would otherwise
# open, and could migrate, the notes of an installed Devot, and a DSN build
# would send that app's saved crash reports. The script stops if the app
# opens a database anywhere else, and ends only the processes it started.
# Quit Devot before running it.
# usage: launch-cost.sh <path to Devot.app> [runs, default 5]
set -euo pipefail

APP="${1:?usage: launch-cost.sh <path to Devot.app> [runs]}"
RUNS="${2:-5}"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
# shellcheck source=SCRIPTDIR/../app-data.sh
source "$ROOT/scripts/app-data.sh"

[ -x "$APP/Contents/MacOS/devot" ] || { echo "Not a Devot.app: $APP" >&2; exit 1; }
if pgrep -x devot >/dev/null; then
  echo "Quit Devot first" >&2
  exit 1
fi

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
# The app's HOME, and so its data folder: never the user's.
APP_HOME="$WORK/home"
mkdir "$APP_HOME"
swiftc -O "$ROOT/scripts/perf/first-paint.swift" -o "$PROBE"

# Starts the app with its own HOME and waits until its window shows the first
# editor paint (the open note's editor, restored from the last state); sets
# PID, SHELL_MS to the milliseconds until the empty shell showed and MS to
# those until the editor did. `launch --seed` first opens a note by pressing
# New Note, which the next launch of this data folder restores.
launch() {
  read -r SHELL_MS MS PID < <(HOME="$APP_HOME" "$PROBE" "$@" "$APP")
}

# Ends the app this script started and waits until it and its crash reporter
# (a child of it, which leaves when the app has gone) are gone too.
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

# A first launch, not timed, makes the data folder and a note to restore. The
# database must be under APP_HOME, or this build keeps its data elsewhere.
launch --seed
if ! app_wait_for_db "$PID" "$APP_HOME" 10; then
  echo "E_PERF_DATA_FOLDER: the app did not open its database under $APP_HOME" >&2
  exit 1
fi
sleep 3
quit

for kind in cold warm; do
  for i in $(seq "$RUNS"); do
    if [ "$kind" = cold ]; then sudo purge; fi
    launch
    echo "$kind $i: $MS ms to the editor ($SHELL_MS ms to the empty shell)"
    # Let the launch's background work finish before quitting.
    sleep 3
    quit
  done
done

launch
echo "idle: waiting 60 s"
sleep 60
reporter="$(pgrep -P "$PID" -f -- '--crash-reporter' || true)"
for p in $PID $reporter; do
  if [ "$p" = "$PID" ]; then name=app; else name=reporter; fi
  echo "$name ($p): $(footprint "$p" | grep 'Footprint:' | head -1 | xargs)"
  # The second sample covers 5 s of idling.
  echo "$name ($p) pid, cpu %, idle wakeups, power: $(top -l 2 -s 5 -pid "$p" -stats pid,cpu,idlew,power | tail -1 | xargs)"
done
[ -n "$reporter" ] || echo "reporter: none (a build without a DSN)"
quit
