#!/bin/bash
# Checks which code in a signed app carries entitlements (docs/releasing.md, Signing the app): with
# <entitlements>, the main executable carries exactly that set; without, it carries none; each app
# extension in Contents/PlugIns carries exactly src-tauri/macos/Extension.entitlements, the sandbox;
# no other Mach-O carries any. Used by macos-sign.sh. Runs only Apple's tools.
#
#   scripts/release/macos-entitlements.sh <Name.app> [<entitlements>]
#
# Errors are GitHub annotations with a code.
set -euo pipefail

fail() {
  echo "::error::$*" >&2
  exit 1
}

[ $# -eq 1 ] || [ $# -eq 2 ] || fail "E_SIGN_USAGE: macos-entitlements.sh <Name.app> [<entitlements>]"
app=${1%/}
wanted=${2:-}
main=$app/Contents/MacOS/$(plutil -extract CFBundleExecutable raw -o - "$app/Contents/Info.plist")
shown=${app%/*}/

canonical() {
  plutil -convert json -o - - 2> /dev/null | jq -S . 2> /dev/null
}

carried() {
  codesign -d --entitlements - --xml "$1" 2> /dev/null || true
}

extension_set=$(cd "$(dirname "$0")" && pwd)/../../src-tauri/macos/Extension.entitlements
extension_expected=$(canonical < "$extension_set")
extensions=()
while IFS= read -r -d '' appex; do
  executable=$appex/Contents/MacOS/$(plutil -extract CFBundleExecutable raw -o - "$appex/Contents/Info.plist")
  [ "$(carried "$executable" | canonical)" = "$extension_expected" ] ||
    fail "E_SIGN_ENTITLEMENTS: ${appex#"$shown"} does not carry exactly the entitlements in Extension.entitlements"
  extensions+=("$executable")
done < <(find "$app/Contents" -type d -name '*.appex' -print0)

is_extension() {
  local executable
  for executable in ${extensions[@]+"${extensions[@]}"}; do
    [ "$1" = "$executable" ] && return 0
  done
  return 1
}

if [ -n "$wanted" ]; then
  expected=$(canonical < "$wanted") || fail "E_SIGN_USAGE: $(basename "$wanted") is not a property list"
  for path in "$app" "$main"; do
    [ "$(carried "$path" | canonical)" = "$expected" ] ||
      fail "E_SIGN_ENTITLEMENTS: ${path#"$shown"} does not carry exactly the entitlements in $(basename "$wanted")"
  done
fi

while IFS= read -r -d '' path; do
  [ -n "$wanted" ] && [ "$path" = "$main" ] && continue
  is_extension "$path" && continue
  case $(file -b "$path") in Mach-O*) ;; *) continue ;; esac
  [ -z "$(carried "$path")" ] && continue
  if [ "$path" = "$main" ]; then
    fail "E_SIGN_ENTITLEMENTS: ${path#"$shown"} carries entitlements; a build without the provisioning profile has none"
  fi
  fail "E_SIGN_ENTITLEMENTS: ${path#"$shown"} carries entitlements; only the main executable and an app extension may"
done < <(find "$app/Contents" -type f -print0)
