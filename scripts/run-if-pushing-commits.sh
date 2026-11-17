#!/bin/sh
# pre-push helper: run the command given as $1 only when the push sends commits.
# A push that only deletes remote branches has an all-zero local sha on every
# stdin line (<local ref> <local sha> <remote ref> <remote sha>).
zeros=0000000000000000000000000000000000000000
sends=no
while read -r _local_ref local_sha _remote_ref _remote_sha; do
  case "$local_sha" in
    '' | "$zeros" | 00000000000000000000000000000000000000000000000000000000000000000) ;;
    *) sends=yes ;;
  esac
done
[ "$sends" = no ] && exit 0
exec sh -c "$1"
