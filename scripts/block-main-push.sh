#!/bin/sh
# pre-push hook: refuse pushes to main. Changes reach main through pull
# requests only. Git passes one line per ref on stdin:
#   <local ref> <local sha> <remote ref> <remote sha>
while read -r _local_ref _local_sha remote_ref _remote_sha; do
  if [ "$remote_ref" = "refs/heads/main" ]; then
    echo "Pushing to main is blocked. Push a branch and open a pull request." >&2
    exit 1
  fi
done
exit 0
