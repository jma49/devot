#!/bin/bash
# The App Store workflow's export job (docs/releasing.md, The App Store build): signs the unsigned
# iPhone archive the build job made with the Apple Distribution certificate, its App Store
# provisioning profile and the app's entitlements, exports the App Store .ipa from it and checks
# the result; with --upload, also sends it to App Store Connect. It runs only Apple's tools.
#
#   scripts/release/ios-export.sh [--upload] <entitlements> <Name.xcarchive> <out dir>
#
# Writes <out dir>/<Name>.ipa. Reads from the environment:
#   APPLE_DISTRIBUTION_CERTIFICATE           base64 of the Apple Distribution .p12
#   APPLE_DISTRIBUTION_CERTIFICATE_PASSWORD  its password
#   APPLE_PROVISIONING_PROFILE               base64 of the App Store provisioning profile
#   APPLE_PROVISIONING_PROFILE_SHARE         base64 of the Share Extension's App Store profile, when
#                                            the app holds the extension (docs/specs/share-extension.md)
#   APPLE_API_KEY_P8, APPLE_API_KEY_ID, APPLE_API_ISSUER_ID  the App Store Connect API key (--upload)
#
# The certificate goes into a keychain made for the run, which is on the user's search list only
# while the script runs, so xcodebuild finds it; the profile is installed where Xcode reads
# profiles and removed again. Errors are GitHub annotations with a code; no secret is printed.
set -euo pipefail

fail() {
  echo "::error::$*" >&2
  exit 1
}

upload=0
if [ "${1:-}" = --upload ]; then
  upload=1
  shift
fi
[ $# -eq 3 ] || fail "E_EXPORT_USAGE: ios-export.sh [--upload] <entitlements> <Name.xcarchive> <out dir>"
entitlements=$1
input=${2%/}
out=$3
[ -f "$entitlements" ] || fail "E_EXPORT_USAGE: $entitlements is not a file"
apps=$(find "$input/Products/Applications" -maxdepth 1 -name '*.app' -type d 2> /dev/null || true)
[ -n "$apps" ] && [ "$(wc -l <<< "$apps")" -eq 1 ] || fail "E_EXPORT_NO_APP: $input holds no single app"

required="APPLE_DISTRIBUTION_CERTIFICATE APPLE_DISTRIBUTION_CERTIFICATE_PASSWORD APPLE_PROVISIONING_PROFILE"
[ $upload -eq 1 ] && required="$required APPLE_API_KEY_P8 APPLE_API_KEY_ID APPLE_API_ISSUER_ID"
missing=
for name in $required; do
  [ -n "${!name:-}" ] || missing="$missing $name"
done
[ -z "$missing" ] || fail "E_EXPORT_CREDENTIALS_MISSING:$missing not set: add them to the release environment (docs/releasing.md, The App Store build)"

script_dir=$(cd "$(dirname "$0")" && pwd)
options_template=$script_dir/../../src-tauri/gen/apple/ExportOptions-AppStore.plist
work=$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/devot-export.XXXXXX")
keychain=$work/signing.keychain-db
made_keychain=0
listed=0
searched=()
installed=()
cleanup() {
  if [ $made_keychain -eq 1 ]; then
    if [ $listed -eq 1 ]; then
      security list-keychains -d user -s ${searched[@]+"${searched[@]}"} || true
    fi
    security delete-keychain "$keychain" || true
  fi
  rm -f ${installed[@]+"${installed[@]}"}
  rm -rf "$work"
}
trap cleanup EXIT

profile=$work/embedded.mobileprovision
(umask 077 && printf '%s' "$APPLE_PROVISIONING_PROFILE" | base64 -D > "$profile") 2> /dev/null ||
  fail "E_SIGN_PROFILE_UNREADABLE: APPLE_PROVISIONING_PROFILE is not base64"
security cms -D -i "$profile" -o "$work/profile.plist" > /dev/null 2>&1 ||
  fail "E_SIGN_PROFILE_UNREADABLE: the provisioning profile is not a signed property list"
uuid=$(plutil -extract UUID raw -o - "$work/profile.plist" 2> /dev/null) ||
  fail "E_SIGN_PROFILE_UNREADABLE: the provisioning profile has no UUID"

echo "Importing the certificate into a keychain for this run"
keychain_password=$(uuidgen)
security create-keychain -p "$keychain_password" "$keychain"
made_keychain=1
security set-keychain-settings -lut 7200 "$keychain"
security unlock-keychain -p "$keychain_password" "$keychain"
(umask 077 && printf '%s' "$APPLE_DISTRIBUTION_CERTIFICATE" | base64 -D > "$work/certificate.p12") ||
  fail "E_SIGN_CERTIFICATE_UNREADABLE: APPLE_DISTRIBUTION_CERTIFICATE is not base64"
security import "$work/certificate.p12" -k "$keychain" -f pkcs12 -P "$APPLE_DISTRIBUTION_CERTIFICATE_PASSWORD" \
  -T /usr/bin/codesign > /dev/null 2>&1 ||
  fail "E_SIGN_CERTIFICATE_IMPORT: the .p12 in APPLE_DISTRIBUTION_CERTIFICATE does not open with APPLE_DISTRIBUTION_CERTIFICATE_PASSWORD"
rm -f "$work/certificate.p12"
security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k "$keychain_password" "$keychain" > /dev/null
# find-identity lists a valid identity twice, under all and under valid ones; the hashes tell them apart.
identities=$(security find-identity -p codesigning "$keychain" |
  sed -nE 's/^ *[0-9]+\) ([0-9A-F]{40}) "((Apple|iPhone) Distribution: .+ \(([A-Z0-9]{10})\))"$/\1 \4 \2/p' | sort -u)
[ -n "$identities" ] ||
  fail "E_SIGN_IDENTITY_NOT_FOUND: the certificate in APPLE_DISTRIBUTION_CERTIFICATE holds no trusted Apple Distribution identity"
[ "$(wc -l <<< "$identities")" -eq 1 ] ||
  fail "E_SIGN_IDENTITY_AMBIGUOUS: the certificate holds $(wc -l <<< "$identities" | tr -d ' ') Apple Distribution identities; export only the current one into the .p12"
read -r certificate team identity <<< "$identities"

while IFS= read -r line; do
  line=${line#*\"}
  searched+=("${line%\"*}")
done < <(security list-keychains -d user)
security list-keychains -d user -s "$keychain" ${searched[@]+"${searched[@]}"}
listed=1

name=$(basename "$input")
archive=$work/$name
ditto "$input" "$archive"
app=$(find "$archive/Products/Applications" -maxdepth 1 -name '*.app' -type d)
bundle_id=$(plutil -extract CFBundleIdentifier raw -o - "$app/Info.plist")

# The archive is unsigned; xcodebuild keeps the entitlements of the signature it finds when it
# exports, so the app is signed first with the App ID, team and push environment the profile gives.
plutil -convert json -o "$work/entitlements.json" "$entitlements"
jq --arg app_id "$team.$bundle_id" --arg team "$team" '. + {
  "application-identifier": $app_id,
  "com.apple.developer.team-identifier": $team,
  "aps-environment": "production",
  "com.apple.developer.icloud-container-environment": "Production"
}' "$work/entitlements.json" > "$work/signing.json"
plutil -convert xml1 -o "$work/signing.entitlements" "$work/signing.json"
"$script_dir/ios-profile.sh" "$profile" "$work/signing.entitlements" "$team" "$bundle_id" "$certificate"

for folder in "$HOME/Library/MobileDevice/Provisioning Profiles" "$HOME/Library/Developer/Xcode/UserData/Provisioning Profiles"; do
  mkdir -p "$folder"
  cp "$profile" "$folder/$uuid.mobileprovision"
  installed+=("$folder/$uuid.mobileprovision")
done

echo "Signing $(basename "$app") with $identity"
sign() {
  codesign --force --sign "$certificate" --keychain "$keychain" "$@"
}
while IFS= read -r -d '' nested; do
  sign "$nested"
done < <(find "$app" -mindepth 1 -depth \( -name '*.framework' -o -name '*.dylib' \) -print0)
# The Share Extension has its own App ID (<app>.share) and App Store profile, and the entitlements
# of src-tauri/gen/apple/devot_Share, with the app's version so App Store Connect takes the pair.
extensions=$(find "$app/PlugIns" -mindepth 1 -maxdepth 1 -name '*.appex' -type d 2> /dev/null || true)
extension=
if [ -n "$extensions" ]; then
  [ "$(wc -l <<< "$extensions")" -eq 1 ] || fail "E_EXPORT_EXTENSIONS: the app holds more than the Share Extension"
  extension=$extensions
  extension_id=$(plutil -extract CFBundleIdentifier raw -o - "$extension/Info.plist")
  [ "$extension_id" = "$bundle_id.share" ] ||
    fail "E_EXPORT_EXTENSIONS: the extension's bundle ID is $extension_id, not $bundle_id.share"
  [ -n "${APPLE_PROVISIONING_PROFILE_SHARE:-}" ] ||
    fail "E_EXPORT_CREDENTIALS_MISSING: APPLE_PROVISIONING_PROFILE_SHARE not set: add it to the release environment (docs/releasing.md, The Share Extension)"
  extension_profile=$work/extension.mobileprovision
  (umask 077 && printf '%s' "$APPLE_PROVISIONING_PROFILE_SHARE" | base64 -D > "$extension_profile") 2> /dev/null ||
    fail "E_SIGN_PROFILE_UNREADABLE: APPLE_PROVISIONING_PROFILE_SHARE is not base64"
  security cms -D -i "$extension_profile" -o "$work/extension-profile.plist" > /dev/null 2>&1 ||
    fail "E_SIGN_PROFILE_UNREADABLE: the Share Extension's profile is not a signed property list"
  extension_uuid=$(plutil -extract UUID raw -o - "$work/extension-profile.plist" 2> /dev/null) ||
    fail "E_SIGN_PROFILE_UNREADABLE: the Share Extension's profile has no UUID"
  plutil -convert json -o "$work/extension-entitlements.json" "$script_dir/../../src-tauri/gen/apple/devot_Share/devot_Share.entitlements"
  jq --arg app_id "$team.$extension_id" --arg team "$team" '. + {
    "application-identifier": $app_id,
    "com.apple.developer.team-identifier": $team
  }' "$work/extension-entitlements.json" > "$work/extension-signing.json"
  plutil -convert xml1 -o "$work/extension.entitlements" "$work/extension-signing.json"
  "$script_dir/ios-profile.sh" "$extension_profile" "$work/extension.entitlements" "$team" "$extension_id" "$certificate"
  for key in CFBundleShortVersionString CFBundleVersion; do
    value=$(plutil -extract "$key" raw -o - "$app/Info.plist")
    plutil -replace "$key" -string "$value" "$extension/Info.plist"
  done
  for folder in "$HOME/Library/MobileDevice/Provisioning Profiles" "$HOME/Library/Developer/Xcode/UserData/Provisioning Profiles"; do
    cp "$extension_profile" "$folder/$extension_uuid.mobileprovision"
    installed+=("$folder/$extension_uuid.mobileprovision")
  done
  cp "$extension_profile" "$extension/embedded.mobileprovision"
  sign --entitlements "$work/extension.entitlements" --generate-entitlement-der "$extension"
fi
cp "$profile" "$app/embedded.mobileprovision"
sign --entitlements "$work/signing.entitlements" --generate-entitlement-der "$app"

options=$work/ExportOptions.plist
cp "$options_template" "$options"
/usr/libexec/PlistBuddy -c "Add :teamID string $team" \
  -c "Add :signingCertificate string $certificate" \
  -c "Add :provisioningProfiles dict" \
  -c "Add :provisioningProfiles:$bundle_id string $uuid" "$options"
if [ -n "$extension" ]; then
  /usr/libexec/PlistBuddy -c "Add :provisioningProfiles:$extension_id string $extension_uuid" "$options"
fi

export_archive() {
  local log=$work/xcodebuild-$1.log
  shift
  if ! xcodebuild -exportArchive -archivePath "$archive" -exportOptionsPlist "$@" > "$log" 2>&1; then
    grep -E 'error|warning: |\*\* EXPORT' "$log" | tail -n 40 >&2 || tail -n 40 "$log" >&2
    return 1
  fi
}

echo "Exporting the App Store package"
export_archive export "$options" -exportPath "$work/export" ||
  fail "E_EXPORT_FAILED: xcodebuild could not export the archive for the App Store"
ipa=$(find "$work/export" -maxdepth 1 -name '*.ipa')
[ -n "$ipa" ] && [ "$(wc -l <<< "$ipa")" -eq 1 ] || fail "E_EXPORT_NO_IPA: the export made no single .ipa"

ditto -x -k "$ipa" "$work/check"
shipped=$(find "$work/check/Payload" -maxdepth 1 -name '*.app' -type d)
codesign --verify --deep --strict "$shipped" || fail "E_EXPORT_SIGNATURE: the exported app does not verify"
details=$(codesign -dvv "$shipped" 2>&1)
grep -qxF "Authority=$identity" <<< "$details" && grep -qxF "TeamIdentifier=$team" <<< "$details" ||
  fail "E_EXPORT_SIGNATURE: the exported app is not signed by $identity"
[ -f "$shipped/embedded.mobileprovision" ] || fail "E_EXPORT_PROFILE: the exported app has no embedded profile"
[ -f "$shipped/PrivacyInfo.xcprivacy" ] || fail "E_EXPORT_PRIVACY: the exported app has no PrivacyInfo.xcprivacy"
codesign -d --entitlements - --xml "$shipped" 2> /dev/null > "$work/signed.plist"
plutil -convert json -o "$work/signed.json" "$work/signed.plist" ||
  fail "E_EXPORT_ENTITLEMENTS: the exported app carries no entitlements"
lost=$(jq -r --slurpfile signed "$work/signed.json" \
  '[to_entries[] | select(.value != $signed[0][.key]) | .key] | sort | join(" ")' "$work/signing.json")
[ -z "$lost" ] || fail "E_EXPORT_ENTITLEMENTS: the exported app does not carry $lost as signed"
[ "$(jq -r '.["get-task-allow"] // false' "$work/signed.json")" = false ] ||
  fail "E_EXPORT_ENTITLEMENTS: the exported app lets a debugger attach (get-task-allow)"
if [ -n "$extension" ]; then
  shipped_extension=$shipped/PlugIns/$(basename "$extension")
  codesign -d --entitlements - --xml "$shipped_extension" 2> /dev/null > "$work/extension-signed.plist"
  plutil -convert json -o "$work/extension-signed.json" "$work/extension-signed.plist" ||
    fail "E_EXPORT_ENTITLEMENTS: the exported Share Extension carries no entitlements"
  lost=$(jq -r --slurpfile signed "$work/extension-signed.json" \
    '[to_entries[] | select(.value != $signed[0][.key]) | .key] | sort | join(" ")' "$work/extension-signing.json")
  [ -z "$lost" ] || fail "E_EXPORT_ENTITLEMENTS: the exported Share Extension does not carry $lost as signed"
fi

mkdir -p "$out"
cp "$ipa" "$out/"
short=$(plutil -extract CFBundleShortVersionString raw -o - "$shipped/Info.plist")
build=$(plutil -extract CFBundleVersion raw -o - "$shipped/Info.plist")
echo "Exported $(basename "$ipa"): $bundle_id $short ($build), signed by $identity"

[ $upload -eq 1 ] || exit 0
key=$work/AuthKey_$APPLE_API_KEY_ID.p8
(umask 077 && printf '%s\n' "$APPLE_API_KEY_P8" > "$key")
cp "$options" "$work/UploadOptions.plist"
/usr/libexec/PlistBuddy -c "Set :destination upload" "$work/UploadOptions.plist"
echo "Uploading $short ($build) to App Store Connect"
export_archive upload "$work/UploadOptions.plist" -exportPath "$work/upload" -allowProvisioningUpdates \
  -authenticationKeyPath "$key" -authenticationKeyID "$APPLE_API_KEY_ID" \
  -authenticationKeyIssuerID "$APPLE_API_ISSUER_ID" ||
  fail "E_EXPORT_UPLOAD_FAILED: App Store Connect did not take the build (docs/releasing.md, The App Store build)"
echo "Uploaded $short ($build); it shows in App Store Connect once Apple has processed it"
