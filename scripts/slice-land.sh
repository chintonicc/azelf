#!/usr/bin/env bash
#
# Fast-forward a finished slice's ticket branch onto master, push, and clean
# up its worktree.
#
#   ./scripts/slice-land.sh 123
#
# WHY THIS EXISTS
# ---------------
# docs/adr/0001-parallel-slice-sessions.md settled on "direct to master via
# session-commit.sh, no PR gate" as the merge path. session-commit.sh commits
# a slice's work and can push its branch, but from inside a ticket worktree
# that only ever pushes to origin/ticket/<n> — nothing was landing it on
# master. This script is that missing landing step: fast-forward only, never
# a merge commit, and it refuses rather than guesses if master has moved in
# a way that isn't a clean fast-forward.
#
# Must be run from the MAIN worktree (the one with master checked out), not
# from inside a ticket worktree — git won't check out master in two
# worktrees at once, so landing has to happen from here.

set -euo pipefail

ticket="${1:-}"
[[ -n "$ticket" ]] || { echo "usage: ${AZELF_INVOKED_AS:-$0} <ticket-id>" >&2; exit 64; }

# The CONSUMER repo's root — not this package's.
#
# This used to be `dirname "$0"/..`, which was right for exactly as long as the
# script lived inside the repo it operated on. Installed as a dependency and
# reached through a generated shim, `$0` is the file in
# `node_modules/@chintonicc/azelf/scripts/`, so that expression resolved to the
# PACKAGE root — and this script would have gone on to commit, land or build a
# worktree in there. It fails silently in the worst way: every path is valid,
# just wrong.
#
# git answers it instead, from the working directory, and `--git-common-dir`
# means a slice worktree resolves to the MAIN checkout rather than to itself.
# That is the same rule the TypeScript loader uses; see its findRepoRoot.
# -P to match git's own canonicalized worktree paths, which
# `git worktree list --porcelain` always prints resolved.
_slice_common="$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null || true)"
if [[ -z "$_slice_common" ]]; then
  echo "error: not inside a git repository — run this from a checkout." >&2
  exit 1
fi
repo_root="$(cd "$(dirname "$_slice_common")" && pwd -P)"
cd "$repo_root"

source "scripts/slice-config.sh"

# After the config, because the tracker decides what an id looks like.
if ! slice_is_ticket_id "$ticket"; then
  echo "error: '$ticket' is not a $SLICE_TRACKER_NAME ticket id (expected $SLICE_TICKET_ID_PATTERN)." >&2
  exit 64
fi
ticket_ref="$(slice_ref "$ticket")"

current_branch=$(git rev-parse --abbrev-ref HEAD)
if [[ "$current_branch" != "$SLICE_BASE_BRANCH" ]]; then
  echo "error: run this from the main worktree, on $SLICE_BASE_BRANCH — currently on '$current_branch'." >&2
  echo "       (git can't check out $SLICE_BASE_BRANCH in two worktrees at once, so landing happens here.)" >&2
  exit 1
fi

branch="$(slice_branch_for "$ticket")"
worktree_path="$(slice_worktree_for "$ticket")"

if ! git show-ref --verify --quiet "refs/heads/$branch"; then
  echo "error: no local branch '$branch' — nothing to land. Was it ever created by slice-session.sh?" >&2
  exit 1
fi

echo "── fast-forwarding $SLICE_BASE_BRANCH onto $branch ──────────────"
if ! git merge --ff-only "$branch"; then
  echo "error: $SLICE_BASE_BRANCH can't fast-forward onto $branch — it has diverged." >&2
  echo "       rebase $branch onto $SLICE_BASE_BRANCH from its worktree first, then retry." >&2
  exit 1
fi
echo "✓ $SLICE_BASE_BRANCH now includes $branch"

echo "── pushing $SLICE_BASE_BRANCH ────────────────────────"
fetch_err=$(git fetch origin "$SLICE_BASE_BRANCH" 2>&1) || {
  echo "error: couldn't fetch origin/$SLICE_BASE_BRANCH:" >&2
  echo "$fetch_err" >&2
  exit 1
}
if git rev-parse --verify -q "origin/$SLICE_BASE_BRANCH" >/dev/null && ! git merge-base --is-ancestor "origin/$SLICE_BASE_BRANCH" HEAD; then
  echo "error: origin/$SLICE_BASE_BRANCH has commits this fast-forward doesn't have — pull/rebase before landing." >&2
  exit 1
fi
git push origin "$SLICE_BASE_BRANCH"
echo "✓ pushed"

# CLEANUP MUST NOT BE ABLE TO FAIL THE LAND, and must say what it skipped.
#
# By this line the base branch has already been fast-forwarded AND pushed — the
# work is public — so what remains is housekeeping, and the ticket close below
# is what unblocks the next wave.
#
# `git worktree remove` refuses a worktree containing modified or untracked
# files, and a session that left something RUNNING — a dev server writing a log,
# a watcher, a test run — is producing exactly those files, seconds after the
# agent exited. That refusal is correct and --force is not the answer: it would
# delete work the refusal exists to protect.
#
# This was written as `git worktree remove "$path" && echo "✓ removed"`, which
# survived the refusal only by accident: bash exempts the left-hand side of an
# `&&` from errexit, so the failure passed unnoticed under `set -e`. What you
# actually got was git's bare `fatal: … contains modified or untracked files` on
# stderr, no "✓ removed" line, and no hint that a worktree had been left behind
# or what to do about it. Written as an `if` instead, the non-fatality is the
# stated intent rather than a property of where the command happens to sit, and
# there is somewhere to put the explanation.
echo "── cleaning up ────────────────────────────────────────"
if [[ -d "$worktree_path" ]]; then
  if git worktree remove "$worktree_path" 2>/dev/null; then
    echo "✓ removed worktree $worktree_path"
  else
    echo "⚠️  left $worktree_path in place — it has modified or untracked files,"
    echo "    most likely from something still running in that session."
    echo "    Check it, then: git worktree remove --force $worktree_path"
  fi
fi
git branch -d "$branch" >/dev/null 2>&1 && echo "✓ deleted local branch $branch" || true
if git show-ref --verify --quiet "refs/remotes/origin/$branch"; then
  git push origin --delete "$branch" >/dev/null 2>&1 && echo "✓ deleted origin/$branch" || true
fi

# Closing the ticket is part of landing, not an afterthought to remember.
# A blocking edge clears only when the blocker is CLOSED — on GitHub that is
# how native issue dependencies work, and it is the contract every tracker
# adapter is held to (scripts/slice-tracker.ts, "closing is load-bearing").
# So a landed-but-open ticket leaves everything downstream of it refusing to
# launch — slice-session.sh counts open blockers and exits. Leaving this to
# the human means discovering it later as "why won't the next slice start?".
#
# Never fatal: the code is on master and pushed by this point, which is the
# part that can't be redone by hand.
echo "── closing $ticket_ref ───────────────────────────────────"
if close_err=$(slice_tracker_close "$ticket" "Landed on $SLICE_BASE_BRANCH via slice-land.sh." 2>&1); then
  echo "✓ closed $ticket_ref"
else
  echo "warning: couldn't close $ticket_ref — close it by hand or its dependents stay blocked:" >&2
  echo "$close_err" >&2
fi
