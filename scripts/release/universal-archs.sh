#!/bin/sh
# Exits 0 when lipo -archs printed exactly arm64 and x86_64, in either order.
set -eu
sorted=$(printf '%s\n' $1 | sort | tr '\n' ' ')
[ "$sorted" = "arm64 x86_64 " ]
