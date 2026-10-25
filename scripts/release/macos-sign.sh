#!/bin/bash
# The release workflow's notarize job (docs/releasing.md, Signing the app): signs an ad-hoc built
# app with the Developer ID identity and the hardened runtime, notarizes and staples it, makes the
# disk image from it (macos-dmg.sh) and signs, notarizes and staples that, then packs the updater
# bundle from the stapled app. It runs only Apple's tools.
#
#   scripts/release/macos-sign.sh [--skip-notarization] [--search-list] <Name.app> <out dir>
#
# Writes <out dir>/<Name>.dmg and <out dir>/<Name>.app.tar.gz. Reads from the environment:
#   APPLE_CERTIFICATE           base64 of the Developer ID Application .p12
#   APPLE_CERTIFICATE_PASSWORD  its password
#   APPLE_SIGNING_IDENTITY      "Developer ID Application: <name> (<team ID>)"
#   APPLE_API_KEY_P8            the text of the App Store Connect API key (AuthKey_<id>.p8)
#   APPLE_API_KEY_ID            its key ID
#   APPLE_API_ISSUER_ID         its issuer ID (a team key)
#
# The certificate goes into a keychain made for the run and deleted when it ends; no other keychain
# is used. --search-list puts that keychain on the user's search list for the run, so codesign also
# finds an intermediate certificate the .p12 carries (CI only). --skip-notarization needs no API
# key and leaves out notarizing, stapling and Gatekeeper's checks, which a local run with a
# self-signed identity cannot pass.
# Errors are GitHub annotations with a code; no secret is ever printed.
set -euo pipefail

fail() {
  echo "::error::$*" >&2
  exit 1
}

notarize=1
search_list=0
while [ $# -gt 0 ]; do
  case $1 in
    --skip-notarization) notarize=0 ;;
    --search-list) search_list=1 ;;
    --*) fail "E_SIGN_USAGE: unknown option $1" ;;
    *) break ;;
  esac
  shift
done
[ $# -eq 2 ] || fail "E_SIGN_USAGE: macos-sign.sh [--skip-notarization] [--search-list] <Name.app> <out dir>"
input=${1%/}
out=$2
[ -d "$input/Contents" ] || fail "E_SIGN_NO_APP: $input is not an app bundle"

required="APPLE_CERTIFICATE APPLE_CERTIFICATE_PASSWORD APPLE_SIGNING_IDENTITY"
[ $notarize -eq 1 ] && required="$required APPLE_API_KEY_P8 APPLE_API_KEY_ID APPLE_API_ISSUER_ID"
missing=
for name in $required; do
  [ -n "${!name:-}" ] || missing="$missing $name"
done
[ -z "$missing" ] || fail "E_SIGN_CREDENTIALS_MISSING:$missing not set: add them to the release environment (docs/releasing.md, Signing the app)"

identity=$APPLE_SIGNING_IDENTITY
identity_form='^Developer ID Application: .+ \(([A-Z0-9]{10})\)$'
[[ $identity =~ $identity_form ]] ||
  fail "E_SIGN_IDENTITY_FORM: APPLE_SIGNING_IDENTITY must read \"Developer ID Application: <name> (<team ID>)\""
team=${BASH_REMATCH[1]}

script_dir=$(cd "$(dirname "$0")" && pwd)
name=$(basename "$input")
work=$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/devot-sign.XXXXXX")
keychain=$work/signing.keychain-db
made_keychain=0
listed=0
searched=()
cleanup() {
  if [ $made_keychain -eq 1 ]; then
    if [ $listed -eq 1 ]; then
      security list-keychains -d user -s ${searched[@]+"${searched[@]}"} || true
    fi
    security delete-keychain "$keychain" || true
  fi
  rm -rf "$work"
}
trap cleanup EXIT

echo "Importing the certificate into a keychain for this run"
keychain_password=$(uuidgen)
security create-keychain -p "$keychain_password" "$keychain"
made_keychain=1
security set-keychain-settings -lut 7200 "$keychain"
security unlock-keychain -p "$keychain_password" "$keychain"
(umask 077 && printf '%s' "$APPLE_CERTIFICATE" | base64 -D > "$work/certificate.p12") ||
  fail "E_SIGN_CERTIFICATE_UNREADABLE: APPLE_CERTIFICATE is not base64"
security import "$work/certificate.p12" -k "$keychain" -f pkcs12 -P "$APPLE_CERTIFICATE_PASSWORD" \
  -T /usr/bin/codesign > /dev/null 2>&1 ||
  fail "E_SIGN_CERTIFICATE_IMPORT: the .p12 in APPLE_CERTIFICATE does not open with APPLE_CERTIFICATE_PASSWORD"
rm -f "$work/certificate.p12"
security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k "$keychain_password" "$keychain" > /dev/null
security find-identity -p codesigning "$keychain" | grep -qF "\"$identity\"" ||
  fail "E_SIGN_IDENTITY_NOT_FOUND: the certificate holds no identity named by APPLE_SIGNING_IDENTITY"
if [ $search_list -eq 1 ]; then
  while IFS= read -r line; do
    line=${line#*\"}
    searched+=("${line%\"*}")
  done < <(security list-keychains -d user)
  security list-keychains -d user -s "$keychain" ${searched[@]+"${searched[@]}"}
  listed=1
fi

sign() {
  codesign --force --sign "$identity" --keychain "$keychain" --timestamp "$@"
}

is_macho() {
  case $(file -b "$1") in Mach-O*) return 0 ;; *) return 1 ;; esac
}

app=$work/app/$name
mkdir "$work/app"
ditto "$input" "$app"
main=$app/Contents/MacOS/$(plutil -extract CFBundleExecutable raw "$app/Contents/Info.plist")

echo "Signing $name inside out"
# -depth lists what a folder holds before the folder, so nested code is signed before its bundle.
while IFS= read -r -d '' path; do
  if [ -d "$path" ]; then
    sign --options runtime "$path"
  elif [ "$path" != "$main" ] && is_macho "$path"; then
    sign --options runtime "$path"
  fi
done < <(find "$app/Contents" -depth \( -type d \( -name '*.app' -o -name '*.framework' \
  -o -name '*.xpc' -o -name '*.appex' -o -name '*.bundle' -o -name '*.plugin' \) -o -type f \) -print0)
# No entitlements: the app needs none (docs/releasing.md, Signing the app).
sign --options runtime "$app"

# check_signed <path> code|image [stapled]
check_signed() {
  local path=$1 info signed_team
  info=$(codesign -dvv "$path" 2>&1)
  [ "$(sed -n 's/^Authority=//p' <<< "$info" | head -n 1)" = "$identity" ] ||
    fail "E_SIGN_WRONG_IDENTITY: ${path#"$work"/} is not signed by APPLE_SIGNING_IDENTITY"
  grep -q '^Timestamp=' <<< "$info" || fail "E_SIGN_NO_TIMESTAMP: ${path#"$work"/} has no secure timestamp"
  signed_team=$(sed -n 's/^TeamIdentifier=//p' <<< "$info")
  # Only an Apple-issued certificate carries a team; a notarized file must have this one.
  if [ "$signed_team" != "$team" ] && { [ "$signed_team" != "not set" ] || [ "${3:-}" = stapled ]; }; then
    fail "E_SIGN_WRONG_TEAM: ${path#"$work"/} is signed for team $signed_team, not $team"
  fi
  if [ "$2" = code ]; then
    grep -q '^CodeDirectory .*flags=0x[0-9a-f]*([^)]*runtime' <<< "$info" ||
      fail "E_SIGN_NO_RUNTIME: ${path#"$work"/} is not signed with the hardened runtime"
    [ -z "$(codesign -d --entitlements - --xml "$path" 2> /dev/null)" ] ||
      fail "E_SIGN_ENTITLEMENTS: ${path#"$work"/} carries entitlements; the app needs none"
  fi
}

# check_app <app> [stapled]
check_app() {
  local app=$1 path verdict
  codesign --verify --deep --strict "$app"
  check_signed "$app" code "${2:-}"
  while IFS= read -r -d '' path; do
    if is_macho "$path"; then check_signed "$path" code "${2:-}"; fi
  done < <(find "$app/Contents" -type f -print0)
  if [ "${2:-}" = stapled ]; then
    xcrun stapler validate "$app"
    verdict=$(spctl -a -t exec -vv "$app" 2>&1) || true
    echo "$verdict"
    grep -q 'source=Notarized Developer ID' <<< "$verdict" ||
      fail "E_SIGN_GATEKEEPER_REFUSED: Gatekeeper does not accept ${app#"$work"/} as notarized Developer ID code"
  fi
}

key_file=
if [ $notarize -eq 1 ]; then
  key_file=$work/AuthKey_$APPLE_API_KEY_ID.p8
  (umask 077 && printf '%s\n' "$APPLE_API_KEY_P8" > "$key_file")
fi

# The wait budget is shared by the app and the dmg; the dmg gets what is left, but at least 20 minutes.
wait_minutes=${NOTARY_WAIT_MINUTES:-300}
wait_started=$SECONDS

notarize_file() {
  local left=$((wait_minutes - (SECONDS - wait_started) / 60))
  [ "$left" -ge 20 ] || left=20
  NOTARY_KEY_FILE=$key_file NOTARY_WAIT_MINUTES=$left "$script_dir/macos-notarize.sh" "$1" "$2"
}

staple() {
  local attempt
  for attempt in 1 2 3 4 5; do
    xcrun stapler staple "$1" && return 0
    [ "$attempt" -lt 5 ] && sleep 20
  done
  fail "E_SIGN_STAPLE_FAILED: no ticket to staple to $(basename "$1")"
}

check_app "$app"
if [ $notarize -eq 1 ]; then
  ditto -c -k --keepParent "$app" "$work/notarize.zip"
  notarize_file "$work/notarize.zip" "$name"
  staple "$app"
  check_app "$app" stapled
fi

mkdir -p "$out"
dmg=$out/${name%.app}.dmg
echo "Making $(basename "$dmg") from the signed app"
"$script_dir/macos-dmg.sh" "$app" "$dmg"
sign "$dmg"
codesign --verify --strict "$dmg"
check_signed "$dmg" image
if [ $notarize -eq 1 ]; then
  notarize_file "$dmg" "$(basename "$dmg")"
  staple "$dmg"
  check_signed "$dmg" image stapled
  xcrun stapler validate "$dmg"
  verdict=$(spctl -a -t open --context context:primary-signature -vv "$dmg" 2>&1) || true
  echo "$verdict"
  grep -q 'source=Notarized Developer ID' <<< "$verdict" ||
    fail "E_SIGN_GATEKEEPER_REFUSED: Gatekeeper does not accept $(basename "$dmg") as notarized Developer ID"
fi
hdiutil verify -quiet "$dmg"
[ -z "$key_file" ] || rm -f "$key_file"

updater=$out/$name.tar.gz
echo "Packing $(basename "$updater") from the signed app"
# No AppleDouble (._) entries: the updater unpacks every entry into the bundle, which would break its seal.
COPYFILE_DISABLE=1 tar --no-mac-metadata --no-xattrs -czf "$updater" -C "$(dirname "$app")" "$name"
entries=$(tar -tzf "$updater")
if grep -Eq '(^|/)\._' <<< "$entries"; then
  fail "E_SIGN_UPDATER_METADATA: $(basename "$updater") holds AppleDouble entries"
fi
mkdir "$work/unpacked"
tar -xzf "$updater" -C "$work/unpacked"
if [ $notarize -eq 1 ]; then
  check_app "$work/unpacked/$name" stapled
else
  check_app "$work/unpacked/$name"
fi
echo "Signed: $(basename "$dmg"), $(basename "$updater")"
