#!/bin/sh
# git gives pre-push one line per ref (<local ref> <local sha> <remote ref> <remote sha>);
# a deleted branch has an all-zero local sha. No lines at all is a hook run by hand.
[ -t 0 ] && exec sh -c "$1"
refs=0
sends=no
while read -r _local_ref local_sha _rest; do
  refs=$((refs + 1))
  case "$local_sha" in
    *[!0]*) sends=yes ;;
  esac
done
[ "$refs" -gt 0 ] && [ "$sends" = no ] && exit 0
exec sh -c "$1"
