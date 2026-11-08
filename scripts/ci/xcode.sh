#!/bin/sh
# CI helper: selects the Xcode an iPhone job builds with, DEVOT_XCODE (an app path, which the
# workflow pins), and fails before any build when the runner image has no such Xcode, so a job
# never falls back to the image's default one. Later steps get it as DEVELOPER_DIR too.
set -eu
xcode=${DEVOT_XCODE:?E_CI_XCODE_UNSET: the workflow names no Xcode}
version=$(basename "$xcode" .app | sed 's/^Xcode_//')
if [ ! -d "$xcode/Contents/Developer" ]; then
  echo "::error::E_CI_XCODE_MISSING: $xcode is not on this runner image (${ImageOS:-?} ${ImageVersion:-?}); installed: $(ls -d /Applications/Xcode*.app 2>/dev/null | tr '\n' ' ')"
  exit 1
fi
sudo xcode-select -s "$xcode/Contents/Developer"
if [ -n "${GITHUB_ENV:-}" ]; then
  echo "DEVELOPER_DIR=$xcode/Contents/Developer" >> "$GITHUB_ENV"
fi
reported=$(xcodebuild -version)
echo "$reported"
case "$(printf '%s\n' "$reported" | head -n 1)" in
  "Xcode $version" | "Xcode $version."*) ;;
  *)
    echo "::error::E_CI_XCODE_VERSION: $xcode reports $(printf '%s\n' "$reported" | head -n 1), not Xcode $version"
    exit 1
    ;;
esac
swift --version 2>&1 | head -n 1
