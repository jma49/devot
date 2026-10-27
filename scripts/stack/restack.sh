#!/usr/bin/env bash
# Usage: restack.sh [--dry-run] [--old-tip <sha>] <merged-branch> <next-branch> [<further-branch> ...]
#        restack.sh [--dry-run] [--old-tip <sha>] --onto <rebased-branch> <next-branch> [<further-branch> ...]
#
# After the bottom layer of a stack was squash-merged into main, moves the
# layers above it onto main without the commits the squash replaced.
# --onto resumes after a conflict: <rebased-branch> was left rebased but not
# pushed, and the layers above it are rebased onto it and pushed, then it is
# pushed too.
# DEVOT_RESTACK_NO_GH=1 skips the gh calls (no network).
set -euo pipefail

usage() {
  echo "usage: $0 [--dry-run] [--old-tip <sha>] <merged-branch> <next-branch> [<further-branch> ...]" >&2
  echo "       $0 [--dry-run] [--old-tip <sha>] --onto <rebased-branch> <next-branch> [<further-branch> ...]" >&2
  exit 2
}

dry_run=0
old_tip=''
onto_override=''
args=()
while (($#)); do
  case "$1" in
    --dry-run) dry_run=1 ;;
    --old-tip)
      (($# >= 2)) || usage
      old_tip=$2
      shift
      ;;
    --onto)
      (($# >= 2)) || usage
      onto_override=$2
      shift
      ;;
    -*) usage ;;
    *) args+=("$1") ;;
  esac
  shift
done
if [[ -n "$onto_override" ]]; then
  ((${#args[@]} >= 1)) || usage
  merged=''
  layers=("${args[@]}")
else
  ((${#args[@]} >= 2)) || usage
  merged=${args[0]}
  layers=("${args[@]:1}")
fi
use_gh=1
[[ -n "${DEVOT_RESTACK_NO_GH:-}" ]] && use_gh=0

run() {
  if ((dry_run)); then
    printf '+'
    printf ' %q' "$@"
    printf '\n'
  else
    "$@"
  fi
}

if [[ -n "$(git status --porcelain)" ]]; then
  echo "restack: the worktree is not clean; commit or stash first" >&2
  exit 1
fi

run git fetch origin

if [[ -n "$onto_override" ]]; then
  onto=$onto_override
  if [[ -z "$old_tip" ]]; then
    if git rev-parse --verify --quiet "origin/$onto" >/dev/null; then
      old_tip=$(git rev-parse "origin/$onto")
      if [[ "$old_tip" == "$(git rev-parse "refs/heads/$onto")" ]]; then
        echo "restack: origin/$onto already holds the rebased $onto; pass --old-tip <its old tip>" >&2
        exit 1
      fi
    elif ((use_gh)); then
      old_tip=$(gh pr view "$onto" --json headRefOid --jq .headRefOid)
    else
      echo "restack: origin/$onto is gone; pass --old-tip <sha>" >&2
      exit 1
    fi
  fi
  # The layers above are cut from the base's old tip, which is still on origin.
  run git push --force-with-lease origin "$onto"
else
  onto=origin/main
  if [[ -z "$old_tip" ]]; then
    if git rev-parse --verify --quiet "origin/$merged" >/dev/null; then
      old_tip=$(git rev-parse "origin/$merged")
    elif ((use_gh)); then
      old_tip=$(gh pr view "$merged" --json headRefOid --jq .headRefOid)
    else
      echo "restack: origin/$merged is gone; pass --old-tip <sha>" >&2
      exit 1
    fi
  fi
fi

# Each layer's tip is recorded before any rebase rewrites it: it is the
# upstream the layer above is cut from.
parents=("$old_tip")
for branch in "${layers[@]}"; do
  git rev-parse --verify --quiet "refs/heads/$branch" >/dev/null || {
    echo "restack: no local branch $branch" >&2
    exit 1
  }
  parents+=("$(git rev-parse "refs/heads/$branch")")
done

start=$(git rev-parse --abbrev-ref HEAD)
for i in "${!layers[@]}"; do
  branch=${layers[$i]}
  if ! run git rebase --onto "$onto" "${parents[$i]}" "$branch"; then
    echo "restack: conflict while rebasing $branch onto $onto." >&2
    echo "The rebase is left in progress: resolve it, run 'git rebase --continue'," >&2
    remaining=("${layers[@]:$((i + 1))}")
    if ((${#remaining[@]})); then
      echo "then rerun this script for the layers above it:" >&2
      echo "  $0 --onto $branch ${remaining[*]}" >&2
    else
      echo "then push it: git push --force-with-lease origin $branch" >&2
    fi
    exit 1
  fi
  run git push --force-with-lease origin "$branch"
  # Only the merged branch's PR moves to main, and only once it is merged there.
  if ((i == 0 && use_gh)) && [[ -n "$merged" ]]; then
    if ((dry_run)); then
      run gh pr edit "$branch" --base main
    elif [[ "$(gh pr view "$merged" --json state --jq .state 2>/dev/null)" == "MERGED" ]] &&
      [[ "$(gh pr view "$branch" --json baseRefName --jq .baseRefName 2>/dev/null)" == "$merged" ]]; then
      run gh pr edit "$branch" --base main
    fi
  fi
  onto=$branch
done

run git checkout "$start"
