#!/bin/sh
# Runs one spike of the native screens' harness (docs/specs/iphone-screens.md, Spikes) on a
# connected iPhone: launches the debug build already installed there with `-DevotSpike <spike>`,
# waits for its report in the app's Documents/spikes/ and prints it. It builds, signs and installs
# nothing, and needs no secret; build and install the debug app first.
#
# Usage: scripts/ios/run-spike.sh S1|S2|S3|S4|barTint [device]
# The device is a devicectl identifier or name; without one, the first connected iPhone is used.
# DEVOT_SPIKE_OUT names the folder the report is copied to (default: a new temporary folder).
# DEVOT_SPIKE_TIMEOUT is how long to wait for the report, in seconds (default 180).
set -eu

# The iPhone app's debug and release builds share one identifier; only the debug one has the harness.
bundle=$(sed -n 's/^ *PRODUCT_BUNDLE_IDENTIFIER: *//p' "$(dirname "$0")/../../src-tauri/gen/apple/project.yml" | head -n 1)
spike=${1:-}
case "$spike" in
S1 | S2 | S3 | S4 | barTint) ;;
*)
  echo "usage: $0 S1|S2|S3|S4|barTint [device]" >&2
  exit 2
  ;;
esac
if [ -z "$bundle" ]; then
  echo "E_SPIKE_NO_BUNDLE: src-tauri/gen/apple/project.yml names no bundle identifier" >&2
  exit 1
fi

out=${DEVOT_SPIKE_OUT:-$(mktemp -d)}
mkdir -p "$out"
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

device=${2:-}
if [ -z "$device" ]; then
  xcrun devicectl list devices --quiet --json-output "$work/devices.json" >/dev/null
  device=$(node -e '
    const { result } = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))
    const phone = (result.devices ?? []).find(
      (d) =>
        d.hardwareProperties?.platform === "iOS" &&
        d.connectionProperties?.tunnelState === "connected",
    )
    if (!phone) {
      console.error("E_SPIKE_NO_DEVICE: no connected iPhone; pass its identifier or name")
      process.exit(1)
    }
    console.log(phone.identifier)
  ' "$work/devices.json")
fi

# A minute early, so a phone whose clock runs a little behind still counts its report as new.
started=$(date -u -v-60S +%Y-%m-%dT%H:%M:%S)
xcrun devicectl device process launch --quiet --device "$device" --terminate-existing \
  "$bundle" -- -DevotSpike "$spike" >/dev/null
echo "I_SPIKE_LAUNCHED spike=$spike" >&2
case "$spike" in
S4 | barTint) echo "the screen stays up for its screenshot; open the app again to leave it" >&2 ;;
esac

report="$out/$spike.json"
deadline=$(($(date +%s) + ${DEVOT_SPIKE_TIMEOUT:-180}))
while :; do
  sleep "${DEVOT_SPIKE_POLL:-5}"
  rm -f "$report"
  if xcrun devicectl device copy from --quiet --device "$device" \
    --domain-type appDataContainer --domain-identifier "$bundle" \
    --source "Documents/spikes/$spike.json" --destination "$report" >/dev/null 2>&1 &&
    node -e '
      const report = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))
      process.exit(report.startedAt >= process.argv[2] ? 0 : 1)
    ' "$report" "$started" 2>/dev/null; then
    break
  fi
  if [ "$(date +%s)" -ge "$deadline" ]; then
    echo "E_SPIKE_REPORT_TIMEOUT spike=$spike" >&2
    exit 1
  fi
done
cat "$report"
echo "I_SPIKE_REPORT spike=$spike path=$report" >&2
