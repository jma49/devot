#!/bin/bash
# Has Apple notarize one file and waits for the answer (docs/releasing.md, Signing the app). Used
# by macos-sign.sh.
#
#   scripts/release/macos-notarize.sh <file> <label>
#
# Reads from the environment:
#   NOTARY_KEY_FILE         the App Store Connect API key file
#   APPLE_API_KEY_ID        its key ID
#   APPLE_API_ISSUER_ID     its issuer ID
#   NOTARY_WAIT_MINUTES     how long to wait for the answer in all (default 300): a new team's
#                           first notarizations can take hours
#   NOTARY_WAIT_SECONDS     the same in seconds, taking precedence (for tests)
#   NOTARY_RETRY_SECONDS    pause before a retry (default 20)
# Submits without waiting, prints the submission ID at once, then waits in chunks of at most 30
# minutes. Errors are GitHub annotations with a code; no secret is ever printed.
set -euo pipefail

fail() {
  echo "::error::$*" >&2
  exit 1
}

[ $# -eq 2 ] || fail "E_SIGN_USAGE: macos-notarize.sh <file> <label>"
file=$1
label=$2
retry=${NOTARY_RETRY_SECONDS:-20}
budget=${NOTARY_WAIT_SECONDS:-$((${NOTARY_WAIT_MINUTES:-300} * 60))}
work=$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/devot-notary.XXXXXX")
trap 'rm -rf "$work"' EXIT

notary() {
  xcrun notarytool "$@" --key "$NOTARY_KEY_FILE" --key-id "$APPLE_API_KEY_ID" --issuer "$APPLE_API_ISSUER_ID"
}

json_field() {
  sed -n "s/.*\"$1\" *: *\"\([^\"]*\)\".*/\1/p" <<< "$2" | head -n 1
}

echo "Notarizing $label"
id=
for attempt in 1 2 3; do
  result=$(notary submit "$file" --output-format json 2> "$work/submit.err") || true
  id=$(json_field id "$result")
  [ -z "$id" ] || break
  cat "$work/submit.err" >&2
  [ "$attempt" -lt 3 ] && sleep "$retry"
done
[ -n "$id" ] || fail "E_SIGN_NOTARIZATION_REFUSED: $label was not submitted (no submission ID after 3 tries)"
echo "Submitted $label as notarization $id"

deadline=$((SECONDS + budget))
status=
while :; do
  left=$((deadline - SECONDS))
  [ "$left" -gt 0 ] || break
  chunk=$((left < 1800 ? left : 1800))
  notary wait "$id" --timeout "${chunk}s" > /dev/null 2> "$work/wait.err" || sleep "$retry"
  info=$(notary info "$id" --output-format json 2> "$work/info.err") || true
  status=$(json_field status "$info")
  echo "Notarization $id of $label: ${status:-no answer}"
  case $status in "" | "In Progress") ;; *) break ;; esac
done

if [ "$status" != Accepted ]; then
  cat "$work/wait.err" "$work/info.err" >&2 2> /dev/null || true
  case $status in
    "" | "In Progress")
      fail "E_SIGN_NOTARIZATION_TIMEOUT: $label was still ${status:-without an answer} after the wait budget (submission $id); Apple may still answer: re-run the failed jobs, which submits again" ;;
  esac
  if notary log "$id" "$work/notary-log.json" > /dev/null 2>&1; then
    echo "The notary log of submission $id:" >&2
    cat "$work/notary-log.json" >&2
  fi
  fail "E_SIGN_NOTARIZATION_REFUSED: $label ended as $status (submission $id)"
fi
