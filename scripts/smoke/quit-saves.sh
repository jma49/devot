#!/bin/bash
# Smoke test on the real app: type into a new note and quit (Cmd+Q) or close
# the window (Cmd+W) immediately, before autosave fires, then check that the
# text reached the database.
#
# Needs macOS, a debug build (`pnpm build:debug --bundles app`) and
# Accessibility permission for the terminal (System Settings > Privacy &
# Security > Accessibility). It runs only that debug build, which keeps its
# data in the debug builds' own folder (scripts/app-data.sh), never in an
# installed Devot's: it starts the app itself, with a HOME of its own in
# which only that folder is real, so a bundle that keeps its data elsewhere
# (one built before debug builds had a folder of their own) opens a new
# database there instead of a real one; it stops if the app opened any
# database but the dev one, types only while that app is in front, and ends
# only that process. Each check starts from an empty database. A dev
# database that is there first is copied aside with SQLite's online backup
# (into <dev data>/smoke-backups, where the copy stays) and put back at the
# end; the script refuses to start while any process has the dev database
# open.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
APP="$ROOT/src-tauri/target/debug/bundle/macos/Devot.app"
# shellcheck source=SCRIPTDIR/../app-data.sh
source "$ROOT/scripts/app-data.sh"

[ -d "$APP" ] || { echo "Build first: pnpm build:debug --bundles app" >&2; exit 1; }
BACKUP="$(dev_data_begin)"
[ -z "$BACKUP" ] || echo "I_SMOKE_DEV_DATA_COPY: the dev notes are copied to $BACKUP"

PID=""
WORK=""
TOOL=""
ORIGINAL=""
# shellcheck disable=SC2329 # the EXIT trap below runs it
finish() {
  if [ -n "$PID" ]; then app_stop "$PID" || true; fi
  if [ -n "$ORIGINAL" ]; then "$TOOL" set "$ORIGINAL" >/dev/null || true; fi
  dev_data_end "$BACKUP" || true
  # rm does not follow the link to the dev folder in APP_HOME.
  if [ -n "$WORK" ]; then rm -rf "$WORK"; fi
}
trap finish EXIT

WORK="$(mktemp -d)"
# The app's HOME: only the dev folder in it is real (dev_app_home).
APP_HOME="$WORK/home"
dev_app_home "$APP_HOME"
TOOL="$WORK/inputsource"
swiftc -O "$ROOT/scripts/smoke/inputsource.swift" -o "$TOOL"
ORIGINAL="$("$TOOL" get)"
"$TOOL" set com.apple.keylayout.ABC >/dev/null

# Waits up to 30 s until process $1 shows a window.
wait_for_window() {
  local end=$((SECONDS + 30)) windows
  while ((SECONDS < end)); do
    windows="$(osascript -e "tell application \"System Events\" to count windows of (first process whose unix id is $1)" 2>/dev/null || true)"
    if [ "${windows:-0}" -gt 0 ] 2>/dev/null; then return 0; fi
    sleep 0.2
  done
  return 1
}

# Waits up to 10 s for process $1 to end.
wait_for_end() {
  local tries=50
  while app_running "$1"; do
    ((tries-- > 0)) || return 1
    sleep 0.2
  done
}

failures=0
check() {
  local text=$1 key=$2 label=$3 exited=yes saved=""
  dev_data_clear
  HOME="$APP_HOME" "$APP/Contents/MacOS/devot" </dev/null >/dev/null 2>&1 &
  PID=$!
  # Its database must be the dev one. A bundle that keeps its data elsewhere
  # opened a new one in APP_HOME, and the run ends with nothing real touched.
  if ! app_wait_for_db "$PID" "$DEVOT_DEV_DATA"; then
    echo "FAIL $label: the app did not open $DEVOT_DEV_DB; rebuild it" >&2
    exit 1
  fi
  if ! wait_for_window "$PID"; then
    echo "FAIL $label: no window within 30 s; does the terminal have Accessibility?" >&2
    exit 1
  fi
  # Lets the page load before typing into it.
  sleep 3
  # Keys go only to the app this script started, and only while it is in front.
  if ! osascript \
    -e 'tell application "System Events"' \
    -e "set frontmost of (first process whose unix id is $PID) to true" \
    -e 'delay 0.5' \
    -e "if unix id of (first process whose frontmost is true) is not $PID then error \"E_SMOKE_NOT_IN_FRONT\"" \
    -e 'key code 48' -e 'delay 0.2' -e 'key code 49' -e 'delay 1.0' \
    -e "if unix id of (first process whose frontmost is true) is not $PID then error \"E_SMOKE_NOT_IN_FRONT\"" \
    -e "keystroke \"$text\"" \
    -e "keystroke \"$key\" using command down" \
    -e 'end tell' >/dev/null; then
    echo "FAIL $label: E_SMOKE_NOT_IN_FRONT, typing stopped"
    failures=$((failures + 1))
    app_stop "$PID" || true
    PID=""
    return
  fi
  wait_for_end "$PID" || exited=no
  if [ -e "$DEVOT_DEV_DB" ]; then
    saved="$(sqlite3 "$DEVOT_DEV_DB" 'SELECT body_md FROM notes;' 2>/dev/null || true)"
  fi
  if [ "$exited" = yes ] && [ "$saved" = "$text" ]; then
    echo "ok   $label: exited and saved \"$saved\""
  else
    echo "FAIL $label: exited=$exited saved=\"$saved\""
    failures=$((failures + 1))
    app_stop "$PID" || true
  fi
  PID=""
}

check "Quit right after typing" q "Cmd+Q"
check "Close right after typing" w "Cmd+W"
exit "$failures"
