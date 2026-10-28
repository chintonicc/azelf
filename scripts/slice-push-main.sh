#!/usr/bin/env bash
#
# Push the base branch from the main checkout, under the land lock.
#
#   ./scripts/slice-push-main.sh        # azelf push-main
#
# For what lands by hand: a merge made in the main checkout — of the
# dispatcher's clone, or of any other clone of the same remote. The land lock
# is keyed by the remote (see scripts/slice-lock.ts, landLockDir), so this
# waits for a land that is pushing, and a land waits for this. Without it a
# hand push and a land race for origin, and the loser's push is refused: the
# land undoes its fast-forward and exits 75, and the hand merge is left to be
# rebased by hand. The lock turns the race into a queue.
#
# It pushes only a fast-forward of origin's base: a local base that is behind
# has nothing to push, and one that has diverged cannot be pushed without
# force, which nothing here does. Nothing is rebased, merged or moved: the
# local base is left exactly as it is, pushed or not.
#
# Run from anywhere in the repo: a slice worktree resolves to the main
# checkout, as it does for slice-land.sh, and it is the main checkout's base
# branch that is pushed.
#
# Exits 0 when it pushed or there was nothing to push, 1 for every refusal,
# 64 for an argument.

set -euo pipefail

usage() { echo "usage: ${AZELF_INVOKED_AS:-$0}" >&2; exit 64; }
[[ $# -eq 0 ]] || usage

# The CONSUMER repo's root — from git, not from where this file is; see the
# same block in slice-land.sh.
_slice_common="$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null || true)"
if [[ -z "$_slice_common" ]]; then
  echo "error: not inside a git repository — run this from a checkout." >&2
  exit 1
fi
repo_root="$(cd "$(dirname "$_slice_common")" && pwd -P)"
cd "$repo_root"

source "scripts/slice-config.sh"

current_branch=$(git rev-parse --abbrev-ref HEAD)
if [[ "$current_branch" != "$SLICE_BASE_BRANCH" ]]; then
  echo "error: run this from the main worktree, on $SLICE_BASE_BRANCH — currently on '$current_branch'." >&2
  exit 1
fi

if ! git remote get-url origin >/dev/null 2>&1; then
  echo "error: this checkout has no origin — there is nowhere to push $SLICE_BASE_BRANCH to." >&2
  exit 1
fi

# The same lock a land holds, for as long as the fetch and the push take.
LAND_LOCK_WAIT=300
land_lock="$(bun "$SLICE_AZELF_DIR/scripts/slice-lock.ts" land-dir "$_slice_common")"
bun "$SLICE_AZELF_DIR/scripts/slice-lock.ts" acquire "$land_lock" \
  --pid $$ --label push-main --what land --wait "$LAND_LOCK_WAIT" || exit 1
trap 'bun "$SLICE_AZELF_DIR/scripts/slice-lock.ts" release "$land_lock" --pid $$ || true' EXIT

# Fetched under the lock: what origin has is only settled once no land is
# pushing.
fetch_err=$(git fetch origin "$SLICE_BASE_BRANCH" 2>&1) || {
  echo "error: couldn't fetch origin/$SLICE_BASE_BRANCH:" >&2
  echo "$fetch_err" >&2
  exit 1
}
remote="refs/remotes/origin/$SLICE_BASE_BRANCH"
if git rev-parse --verify -q "$remote" >/dev/null; then
  if git merge-base --is-ancestor HEAD "$remote"; then
    if [[ "$(git rev-parse HEAD)" == "$(git rev-parse "$remote")" ]]; then
      echo "✓ origin/$SLICE_BASE_BRANCH already has $SLICE_BASE_BRANCH ($(git rev-parse --short HEAD)) — nothing to push"
      exit 0
    fi
    echo "error: $SLICE_BASE_BRANCH is $(git rev-list --count "HEAD..$remote") commit(s) behind origin/$SLICE_BASE_BRANCH and has nothing of its own — nothing to push." >&2
    echo "       git merge --ff-only origin/$SLICE_BASE_BRANCH brings it level." >&2
    exit 1
  fi
  if ! git merge-base --is-ancestor "$remote" HEAD; then
    echo "error: $SLICE_BASE_BRANCH and origin/$SLICE_BASE_BRANCH have diverged ($(git rev-list --count "$remote..HEAD") and $(git rev-list --count "HEAD..$remote") commits) — only a fast-forward is pushed." >&2
    echo "       Rebase or merge origin/$SLICE_BASE_BRANCH into $SLICE_BASE_BRANCH first, then push again. Nothing was pushed." >&2
    exit 1
  fi
  ahead="$(git rev-list --count "$remote..HEAD")"
else
  # No such branch on origin yet: the push creates it.
  ahead="$(git rev-list --count HEAD)"
fi

echo "── pushing $SLICE_BASE_BRANCH ────────────────────────"
if ! push_out=$(git push origin "$SLICE_BASE_BRANCH" 2>&1); then
  [[ -n "$push_out" ]] && echo "$push_out" >&2
  echo "error: origin refused the push — see git's message above. $SLICE_BASE_BRANCH is where it was; nothing was pushed." >&2
  exit 1
fi
[[ -n "$push_out" ]] && echo "$push_out"
echo "✓ pushed $SLICE_BASE_BRANCH — origin/$SLICE_BASE_BRANCH is now $(git rev-parse --short HEAD) ($ahead commit(s))"
