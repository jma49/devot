#!/bin/sh
# Temporary CI probe (removed with the simulator-probe job): boots the simulator $DEVICE, prints each
# boot stage with the seconds since the start, then shuts it down and prints its data folder's size.
set -eu
start=$(date +%s)
xcrun simctl bootstatus "$DEVICE" -b 2>&1 | while IFS= read -r line; do
  echo "probe $1 +$(($(date +%s) - start))s: $line"
done
echo "probe $1: booted after $(($(date +%s) - start))s"
xcrun simctl shutdown "$DEVICE"
echo "probe $1: shut down after $(($(date +%s) - start))s"
du -sh "$HOME/Library/Developer/CoreSimulator/Devices/$DEVICE/data"
