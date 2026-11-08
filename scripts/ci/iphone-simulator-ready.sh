#!/bin/sh
# CI helper: waits until the simulator with the given UDID has booted, booting it if nothing else is.
# CI boots its simulators in the background, and `bootstatus -b` can race that boot: it fails with
# "Unable to boot device in current state: Booted" (SimError 405, PR #790). By then the device is
# booted or booting, so the wait is tried once more.
set -eu
xcrun simctl bootstatus "$1" -b >/dev/null 2>&1 || xcrun simctl bootstatus "$1" -b >/dev/null
