# shellcheck shell=bash
# Helpers for the scripts that start Devot (sourced, never run on its own;
# they work under `set -euo pipefail`): where debug builds keep their data,
# a HOME to start an app with in which only that folder is real, the copy of
# the notes there that a script keeps before it deletes the database, a check
# that an app a script started opened the database it should, and ending
# only the processes a script started.
#
# Debug builds (`pnpm dev`, `pnpm build:debug`) keep their data in a
# folder of their own, never in the release app's (src-tauri/src/data_folder.rs).
# Scripts use that folder or a temporary one and never name the release
# folder (tests/policy/data-folder.test.ts). The folder comes from HOME alone,
# here and in the app.

# Where debug builds keep their data, under HOME.
DEVOT_DEV_FOLDER="Library/Application Support/io.github.jma49.devot.dev"
DEVOT_DEV_DATA="$HOME/$DEVOT_DEV_FOLDER"
DEVOT_DEV_DB="$DEVOT_DEV_DATA/devot.sqlite"

# Whether process $1 is running (one that ended but is not reaped yet is not).
app_running() {
  local state
  state="$(ps -o stat= -p "$1" 2>/dev/null)" || return 1
  [[ -n "$state" && "$state" != *Z* ]]
}

# Ends process $1, which the calling script started: asks it to, then after
# $2 seconds (default 10) forces it. Nothing else is touched.
app_stop() {
  local pid=$1 tries=$((${2:-10} * 5))
  kill "$pid" 2>/dev/null || true
  while app_running "$pid" && ((tries-- > 0)); do sleep 0.2; done
  if app_running "$pid"; then
    kill -9 "$pid" 2>/dev/null || true
    tries=25
    while app_running "$pid" && ((tries-- > 0)); do sleep 0.2; done
  fi
  ! app_running "$pid"
}

# The `devot.sqlite` files process $1 has open, one per line.
app_databases() {
  { lsof -Fn -p "$1" 2>/dev/null || true; } | sed -n 's/^n//p' | grep '/devot\.sqlite$' || true
}

# Waits until process $1 has a Devot database open under the folder $2, for
# up to $3 seconds (default 30). Status 0 once it has; 2 when it opened one
# elsewhere (a build that keeps its data somewhere else: a release build, or
# a debug build made before debug builds had a folder of their own); 1 when
# it ended or the time ran out.
app_wait_for_db() {
  local pid=$1 folder=$2 end=$((SECONDS + ${3:-30})) open real line
  while true; do
    open="$(app_databases "$pid")"
    # lsof names files by their real path, without symbolic links.
    real="$(cd "$folder" 2>/dev/null && pwd -P || printf '%s' "$folder")"
    while IFS= read -r line; do
      [[ "$line" == "$real"/* ]] && return 0
    done <<<"$open"
    if [ -n "$open" ]; then
      echo "E_APP_OTHER_DATABASE: process $pid opened $open, not one under $folder" >&2
      return 2
    fi
    app_running "$pid" && ((SECONDS < end)) || return 1
    sleep 0.2
  done
}

# Makes the folder $1, which must not exist yet, a HOME to start an app with.
# The app takes its folders from HOME, and in this one only the debug
# builds' data folder is real: a link to $DEVOT_DEV_DATA (made when missing).
# A debug build uses the dev data through it. A build that keeps its data
# elsewhere (a release build, or a debug build made before debug builds had
# a folder of their own) makes a new folder in $1 instead, touching nothing
# real, and app_wait_for_db refuses it. Deleting $1 deletes only the link.
dev_app_home() {
  local link="$1/$DEVOT_DEV_FOLDER"
  mkdir "$1" || return 1
  mkdir -p "$DEVOT_DEV_DATA" "${link%/*}" || return 1
  ln -s "$DEVOT_DEV_DATA" "$link"
}

# Deletes the dev database; the rest of the dev folder stays.
dev_data_clear() {
  rm -f "$DEVOT_DEV_DB" "$DEVOT_DEV_DB-wal" "$DEVOT_DEV_DB-shm" "$DEVOT_DEV_DB-journal"
}

# Refuses (status 1) while a process has the dev database open: a running
# debug build would lose what a script deletes or puts back.
dev_data_unused() {
  local holders
  holders="$({ lsof -t -- "$DEVOT_DEV_DB" "$DEVOT_DEV_DB-wal" 2>/dev/null || true; } | sort -u | tr '\n' ' ')"
  if [ -n "$holders" ]; then
    echo "E_SMOKE_DEV_DATA_IN_USE: process ${holders% } has $DEVOT_DEV_DB open; quit it first" >&2
    return 1
  fi
}

# Before a script deletes the dev database: refuses while it is in use, and
# copies it, when there is one, into <dev data>/smoke-backups with SQLite's
# online backup (every note, also those still in the write-ahead log), as a
# plain file checked like the original. Prints the copy's path, or nothing
# when there is no database. Status 1, with nothing deleted, when the
# database cannot be read or the copy fails its check.
dev_data_begin() {
  dev_data_unused || return 1
  [ -e "$DEVOT_DEV_DB" ] || return 0
  local notes backup checked
  if ! notes="$(sqlite3 "$DEVOT_DEV_DB" 'SELECT count(*) FROM notes;' 2>/dev/null)"; then
    echo "E_SMOKE_DEV_DATA_UNREADABLE: $DEVOT_DEV_DB is not a Devot database; move it away first" >&2
    return 1
  fi
  backup="$DEVOT_DEV_DATA/smoke-backups/devot-$(date -u +%Y%m%dT%H%M%SZ).sqlite"
  # sqlite3 takes the path in single quotes.
  if [[ "$backup" == *"'"* ]]; then
    echo "E_SMOKE_BACKUP_PATH: $backup has a quote in it" >&2
    return 1
  fi
  mkdir -p "$DEVOT_DEV_DATA/smoke-backups"
  if ! sqlite3 "$DEVOT_DEV_DB" ".backup '$backup'" 2>/dev/null; then
    echo "E_SMOKE_BACKUP_FAILED: could not copy $DEVOT_DEV_DB" >&2
    return 1
  fi
  checked="$(sqlite3 "$backup" 'PRAGMA journal_mode = DELETE; PRAGMA quick_check; SELECT count(*) FROM notes;' 2>/dev/null | tr '\n' ' ' || true)"
  if [ "$checked" != "delete ok $notes " ]; then
    echo "E_SMOKE_BACKUP_CHECK_FAILED: $backup does not hold the $notes notes" >&2
    return 1
  fi
  echo "$backup"
}

# After a script's runs, once the app it started has ended: deletes the
# script's database and puts the copy from dev_data_begin ($1; none when
# empty) back as the dev database. The copy stays where it is. Status 1,
# touching nothing, while a process has the database open, or when the copy
# put back fails its check; the message says where the copy is.
dev_data_end() {
  local backup=${1:-}
  if ! dev_data_unused; then
    [ -z "$backup" ] || echo "I_SMOKE_DEV_DATA_COPY: the dev notes are in $backup" >&2
    return 1
  fi
  dev_data_clear
  [ -n "$backup" ] || return 0
  if ! cp "$backup" "$DEVOT_DEV_DB" || [ "$(sqlite3 "$DEVOT_DEV_DB" 'PRAGMA quick_check;' 2>/dev/null || true)" != ok ]; then
    echo "E_SMOKE_RESTORE_FAILED: copy $backup to $DEVOT_DEV_DB by hand" >&2
    return 1
  fi
}
