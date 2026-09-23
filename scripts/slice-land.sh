#!/usr/bin/env bash
#
# Fast-forward a finished slice's ticket branch onto master, push, and clean
# up its worktree.
#
#   ./scripts/slice-land.sh 123
#   ./scripts/slice-land.sh 123 --end-session   # also end the agent still
#                                                # sitting in the removed worktree
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

usage() { echo "usage: ${AZELF_INVOKED_AS:-$0} <ticket-id> [--end-session]" >&2; exit 64; }
ticket=""
end_session=false
while [[ $# -gt 0 ]]; do
  case "$1" in
    --end-session) end_session=true; shift ;;
    -*) usage ;;
    *) [[ -z "$ticket" ]] || usage; ticket="$1"; shift ;;
  esac
done
[[ -n "$ticket" ]] || usage

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

# Taken before the fast-forward, for the "landed as" line below: afterwards
# `base..HEAD` is empty by definition.
base_before="$(git rev-parse HEAD)"

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

# ─── The DB lock ────────────────────────────────────────────────────────────
#
# A slice that changed an exclusive path claimed the DB lock before it did
# (db-lock.sh, via session-commit.sh) and has held it since; the change is now
# on the base branch and pushed, which is the moment the hold was for. Released
# from here with --landed because the slice's own session is gone by now, and
# because the main checkout is the one place that can vouch for "landed".
#
# Never fatal — same rule as the cleanup below: the work is public, and a lock
# left held is printed with the exact command to run by hand. Three cases:
#
#   - the branch holds the claim → release it, noting when it never actually
#     landed a change under those paths (held, but harmlessly);
#   - the branch landed such a change and holds NO claim → the protocol was
#     skipped; nothing to release, but say so, because the database may hold
#     what two sessions applied;
#   - neither → nothing to do, silently. This is every ordinary slice.
if [[ ${#SLICE_EXCLUSIVE_LOCK_PATHS[@]} -gt 0 ]]; then
  source "scripts/db-lock-check.sh"
  lock_owner=""
  lock_rc=0
  db_lock_read_owner || lock_rc=$?
  if [[ $lock_rc -eq 0 ]]; then lock_owner="$DB_LOCK_OWNER_BRANCH"; fi
  touched_lock=false
  if git diff --name-only "$base_before" HEAD | grep -qE "$(db_lock_re)"; then touched_lock=true; fi

  if [[ "$lock_owner" == "$branch" ]]; then
    echo "── releasing the DB lock ──────────────────────────"
    if release_out=$("$SLICE_AZELF_DIR/scripts/db-lock.sh" release --landed "$branch" 2>&1); then
      printf '%s\n' "$release_out"
      if ! $touched_lock; then
        echo "  (it held the claim without landing a change under ${SLICE_EXCLUSIVE_LOCK_PATHS[*]})"
      fi
    else
      echo "⚠️  couldn't release the DB lock held by $branch:"
      printf '%s\n' "$release_out" | sed 's/^/    /'
      echo "    run it by hand, from here: ./scripts/db-lock.sh release --landed $branch"
    fi
  elif $touched_lock; then
    if [[ -n "$lock_owner" ]]; then
      echo "⚠️  $branch landed a change under ${SLICE_EXCLUSIVE_LOCK_PATHS[*]} while the DB lock is held by $lock_owner —"
      echo "    it skipped the claim. Check what BOTH have applied to the database before $lock_owner continues."
    elif [[ $lock_rc -eq 2 ]]; then
      echo "⚠️  $branch landed a change under ${SLICE_EXCLUSIVE_LOCK_PATHS[*]}, and the DB lock is UNVERIFIABLE:"
      _db_lock_unverifiable_lines | sed 's/^/    /'
    else
      echo "⚠️  $branch landed a change under ${SLICE_EXCLUSIVE_LOCK_PATHS[*]} without ever holding the DB lock —"
      echo "    it skipped the claim. Nothing to release; worth knowing if another session was mid-migration."
    fi
  fi
fi

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
#
# ─── Ending it, under --end-session ────────────────────────────────────────
#
# The dispatcher passes --end-session under --auto only, where nobody is
# reading that tab. Ending the agent lets slice-session.sh resume, see its
# worktree gone, and exit 86 — which is what closes the tab (see "Closing the
# tab" there). Without the flag, or by hand, the line above stays advice.
#
# THREE CONDITIONS, CHECKED WHERE THIS IS CALLED, AND EACH ONE MATTERS:
#  - After the removal SUCCEEDED, never before. The moment the agent dies the
#    session tests whether its directory still exists; a removal still in
#    flight would read as present, and the session would keep its tab. And a
#    refused removal means the directory stays, so the tab is still the place
#    to look — killing the agent would only make it harder to read.
#  - The pid passed the `ps` check: it is a slice session, not a reused pid.
#  - The session DECLARED done. One that never ran slice-done.sh is being
#    landed out from under it, and its tab may hold the only explanation.
#
# The pid is the bash running slice-session.sh; the agent is its direct child,
# so the signal goes to the children and never to that shell, which has to
# survive to exit 86. Under wrapCommand the direct child is the wrapper
# rather than the agent: TERM to the wrapper is still the right signal, and
# the KILL fallback covers one that does not forward it. Never fatal — the
# land is pushed by now, and the worst case is the tab you close by hand.
end_agent_under() {
  local session=$1 waited=0
  pkill -TERM -P "$session" 2>/dev/null || true
  while pgrep -P "$session" >/dev/null 2>&1 && [[ $waited -lt 10 ]]; do
    sleep 0.5
    waited=$((waited + 1))
  done
  if pgrep -P "$session" >/dev/null 2>&1; then
    pkill -KILL -P "$session" 2>/dev/null || true
    sleep 0.5
  fi
  if pgrep -P "$session" >/dev/null 2>&1; then
    echo "    could not end the agent under pid $session — close that tab yourself."
  else
    echo "    ended the agent in that tab — the session exits and the tab closes."
  fi
}

echo "── cleaning up ────────────────────────────────────────"
session_pid=""
session_declared_done=true
declared_head=""
if [[ -f "$worktree_path/.slice-ready-to-land" ]]; then
  session_pid="$(head -n 1 "$worktree_path/.slice-ready-to-land" | tr -d '[:space:]')"
  # Line 2, when slice-done.sh wrote one: the head the agent declared done at,
  # BEFORE any rebase moved it. See the note there for why that matters.
  declared_head="$(sed -n 2p "$worktree_path/.slice-ready-to-land" | tr -d '[:space:]')"
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
      if $session_declared_done && $end_session; then
        echo "    It finished and marked itself done; it just never left its REPL."
        end_agent_under "$session_pid"
      elif $session_declared_done; then
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
#
# The close comment also records WHAT landed, as SHAs. The landed head is the
# only one a later `merge-base --is-ancestor` will ever say yes to; the
# declared head is the one the agent has in its scrollback, and the two differ
# whenever the dispatcher rebased before landing. Putting both on the ticket
# is what lets "did #42 land?" be answered by looking, instead of by a SHA
# check that is a false negative most of the time.
landed_head="$(git rev-parse HEAD)"
landed_count="$(git rev-list --count "$base_before..$landed_head")"
landed_line="landed on $SLICE_BASE_BRANCH as $(git rev-parse --short "$landed_head") ($landed_count commit(s))"
if [[ -n "$declared_head" ]]; then
  landed_line="declared done at $(git rev-parse --short "$declared_head" 2>/dev/null || echo "$declared_head"), $landed_line"
fi
close_comment="$close_comment

$landed_line"
echo "✓ $landed_line"

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
