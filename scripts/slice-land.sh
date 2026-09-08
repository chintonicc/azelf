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

# ─── What this slice left for a human to check ─────────────────────────────
#
# READ IT NOW, not at close time. Two things below destroy the evidence: the
# fast-forward makes `$base...$branch` empty by definition, and the cleanup
# deletes the branch outright.
#
# WHY THIS EXISTS. Under --auto a finished session closes its own tab, and
# everything the agent said in it goes with the tab. Most of that is
# reconstructible from the diff; one part is not — the checks a human still has
# to run, on a device, with two accounts, in a language nobody here reads. That
# is real work handed back to you, and it was arriving as scrollback in a
# window that closes.
#
# The durable half is already committed: the agent writes those checks into the
# repo as unticked markdown boxes. So this needs no new convention and no
# model call — it reads the lines the slice ADDED that are still unticked, and
# puts them where the ticket is. `- [x]` is left alone; a box the slice ticked
# on its way past is not outstanding.
#
# Grep can find nothing without that being an error, hence `|| true`: a slice
# whose diff has no checkboxes is the ordinary case, not a failure.
LAND_NOTES_MAX=20
land_notes="$(
  git diff "$SLICE_BASE_BRANCH...$branch" 2>/dev/null \
    | grep -E '^\+[[:space:]]*[-*] \[ \] ' \
    | sed 's/^+//' \
    || true
)"

close_comment="Landed on $SLICE_BASE_BRANCH via slice-land.sh."
if [[ -n "$land_notes" ]]; then
  land_notes_total="$(printf '%s\n' "$land_notes" | wc -l | tr -d ' ')"
  close_comment="$close_comment

Still to check by hand — boxes this slice added and left unticked:

$(printf '%s\n' "$land_notes" | head -n "$LAND_NOTES_MAX")"
  if [[ "$land_notes_total" -gt "$LAND_NOTES_MAX" ]]; then
    close_comment="$close_comment

… and $((land_notes_total - LAND_NOTES_MAX)) more in the files this slice changed."
  fi
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
#
# ─── The session that may still be sitting in there ────────────────────────
#
# Read BEFORE the removal, because both markers live inside the worktree.
#
# slice-session.sh writes its own PID into .slice-live; slice-done.sh carries
# that PID into .slice-ready-to-land and clears .slice-live, so whichever of
# the two is present names the shell that owns this worktree. Preferring the
# done marker also distinguishes the two cases: a session that declared itself
# finished and simply never left its REPL, versus one that never declared
# anything and is being landed by hand.
#
# WHY THIS IS WORTH A LINE OF OUTPUT. On one three-slice --auto wave all three
# sessions were in the first case, and the only symptom was three tabs that
# would not close, an hour later, rooted in directories that no longer existed.
# Nothing said so. Finding out took `ps`. The removal itself is not wrong —
# the work is landed and pushed by this point, and there is nothing left in
# there to lose — but the shell holding the tab open cannot know that, and
# neither could you.
echo "── cleaning up ────────────────────────────────────────"
session_pid=""
session_declared_done=true
if [[ -f "$worktree_path/.slice-ready-to-land" ]]; then
  session_pid="$(head -n 1 "$worktree_path/.slice-ready-to-land" | tr -d '[:space:]')"
elif [[ -f "$worktree_path/.slice-live" ]]; then
  session_pid="$(head -n 1 "$worktree_path/.slice-live" | tr -d '[:space:]')"
  session_declared_done=false
fi
if [[ -d "$worktree_path" ]]; then
  if git worktree remove "$worktree_path" 2>/dev/null; then
    echo "✓ removed worktree $worktree_path"
    # Digits only, and the command line has to still look like a slice session:
    # PIDs are reused, and "process 53049 exists" a day later says nothing.
    # `|| true` because ps exits non-zero on a dead pid, which is the good case.
    if [[ "$session_pid" =~ ^[0-9]+$ ]] &&
       ps -o command= -p "$session_pid" 2>/dev/null | grep -q "slice-session"; then
      echo
      echo "⚠️  the session for $ticket_ref is still running (pid $session_pid),"
      echo "    and the directory it is sitting in has just been removed."
      if $session_declared_done; then
        echo "    It finished and marked itself done; it just never left its REPL."
        echo "    Nothing is lost — close that tab."
      else
        echo "    It never ran slice-done.sh, so this land did not come from it."
        echo "    Check that tab before closing it: kill $session_pid"
      fi
    fi
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
if close_err=$(slice_tracker_close "$ticket" "$close_comment" 2>&1); then
  echo "✓ closed $ticket_ref"
  if [[ -n "$land_notes" ]]; then
    echo "  ↳ carried $land_notes_total unticked check(s) into the ticket"
  fi
else
  echo "warning: couldn't close $ticket_ref — close it by hand or its dependents stay blocked:" >&2
  echo "$close_err" >&2
fi
