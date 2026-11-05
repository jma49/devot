#!/bin/bash
# Checks a Developer ID provisioning profile before macos-sign.sh embeds it (docs/releasing.md,
# Signing the app): it is a Developer ID profile for the macOS app <team ID>.<bundle ID> of that
# team, holds the signing certificate (its SHA-1, as `security find-identity` prints it), grants
# every entitlement in <entitlements>, and is valid for at least 30 more days. Runs only Apple's
# tools.
#
#   scripts/release/macos-profile.sh <profile> <entitlements> <team ID> <bundle ID> <certificate SHA-1>
#
# `security cms -D` reads the profile without checking that Apple signed it, so this catches a
# wrong or stale profile, not a forged one; macOS checks Apple's signature when the app starts.
# Errors are GitHub annotations with a code; the profile itself is never printed.
set -euo pipefail

fail() {
  echo "::error::$*" >&2
  exit 1
}

usage="E_SIGN_USAGE: macos-profile.sh <profile> <entitlements> <team ID> <bundle ID> <certificate SHA-1>"
[ $# -eq 5 ] || fail "$usage"
profile=$1
entitlements=$2
team=$3
app_id=$3.$4
certificate=$5
[[ $certificate =~ ^[0-9A-F]{40}$ ]] || fail "$usage"
min_days=30

work=$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/devot-profile.XXXXXX")
trap 'rm -rf "$work"' EXIT
decoded=$work/profile.plist

security cms -D -i "$profile" -o "$decoded" > /dev/null 2>&1 && plutil -lint -s "$decoded" > /dev/null 2>&1 ||
  fail "E_SIGN_PROFILE_UNREADABLE: the provisioning profile is not a signed property list"
plutil -convert json -o "$work/wanted.json" "$entitlements" > /dev/null 2>&1 ||
  fail "E_SIGN_PROFILE_UNREADABLE: $(basename "$entitlements") is not a property list"

field() {
  plutil -extract "$1" raw -o - "$decoded" 2> /dev/null || true
}

[ "$(field TeamIdentifier.0)" = "$team" ] ||
  fail "E_SIGN_PROFILE_TEAM: the provisioning profile is for team $(field TeamIdentifier.0), not $team"
plutil -extract Platform json -o - "$decoded" 2> /dev/null | grep -q '"OSX"' ||
  fail "E_SIGN_PROFILE_PLATFORM: the provisioning profile is not for macOS"
[ "$(field ProvisionsAllDevices)" = true ] ||
  fail "E_SIGN_PROFILE_NOT_DEVELOPER_ID: the provisioning profile does not provision all devices, so it is not a Developer ID profile"
held=0
index=0
while der=$(plutil -extract "DeveloperCertificates.$index" raw -o - "$decoded" 2> /dev/null); do
  if [ "$(base64 -D <<< "$der" | shasum -a 1 | cut -d ' ' -f 1 | tr a-f A-F)" = "$certificate" ]; then
    held=1
    break
  fi
  index=$((index + 1))
done
[ $held -eq 1 ] ||
  fail "E_SIGN_PROFILE_CERTIFICATE: the provisioning profile does not hold the signing certificate; make a new one with the current Developer ID certificate (docs/releasing.md, Signing the app)"
plutil -extract Entitlements json -o "$work/granted.json" "$decoded" > /dev/null 2>&1 ||
  fail "E_SIGN_PROFILE_ENTITLEMENTS: the provisioning profile grants no entitlements"
# Entitlement names hold dots, which plutil's key paths would split.
granted=$(jq -r '.["com.apple.application-identifier"] // empty' "$work/granted.json")
[ "$granted" = "$app_id" ] ||
  fail "E_SIGN_PROFILE_APP_ID: the provisioning profile is for ${granted:-no App ID}, not $app_id"
[ "$(jq -r '.["com.apple.application-identifier"] // empty' "$work/wanted.json")" = "$app_id" ] ||
  fail "E_SIGN_PROFILE_APP_ID: $(basename "$entitlements") does not name $app_id"

missing=$(jq -r --slurpfile granted "$work/granted.json" -f "$(dirname "$0")/profile-grants.jq" "$work/wanted.json")
[ -z "$missing" ] ||
  fail "E_SIGN_PROFILE_ENTITLEMENTS: the provisioning profile does not grant $missing; make a new one for the App ID (docs/releasing.md, Signing the app)"

expires=$(field ExpirationDate)
expires_at=$(date -j -u -f '%Y-%m-%dT%H:%M:%SZ' "$expires" +%s 2> /dev/null) ||
  fail "E_SIGN_PROFILE_UNREADABLE: the provisioning profile has no expiry date"
left=$(((expires_at - $(date -u +%s)) / 86400))
[ "$left" -ge "$min_days" ] ||
  fail "E_SIGN_PROFILE_EXPIRING: the provisioning profile ends on $expires, in fewer than $min_days days; make a new one (docs/releasing.md, Signing the app)"
echo "Provisioning profile for $app_id: valid until $expires"
