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

# ─── A hold ────────────────────────────────────────────────────────────────
#
# Someone is working in the worktree by hand (`azelf hold`, or any git lock on
# it). First, before the record and the land lock: git refuses to remove a
# locked worktree, so a land that went ahead would push, close the ticket and
# then fail its cleanup with a message about a dirty tree. See
# scripts/slice-hold.ts.
if hold="$(bun "$SLICE_AZELF_DIR/scripts/slice-hold.ts" describe "$worktree_path" "$ticket")"; then
  echo "error: $ticket_ref is $hold first." >&2
  exit 1
fi

# ─── A land that already pushed ────────────────────────────────────────────
#
# Written right after the push, deleted as the last step once the ticket is
# closed. Found here, a land was interrupted between the two — a dispatcher
# killed with its terminal, a crash mid-cleanup — and the work is public but
# the ticket is open and the worktree half there. Running the land again from
# the start can't work: the branch may be gone, and a fast-forward of what
# already landed is no answer. So it is FINISHED instead, from what the record
# says. Checked before the branch, because the branch may be the first thing
# the interrupted cleanup deleted.
#
# Line 1 the landed head, 2 the declared head (or -), 3 the commit count, 4
# when it pushed; the close comment from line 6.
landed_record="$_slice_common/azelf-landed-$ticket.txt"
finishing=false
if [[ -f "$landed_record" ]]; then
  finishing=true
  landed_head="$(sed -n 's/^landed //p' "$landed_record" | head -n 1)"
  declared_head="$(sed -n 's/^declared //p' "$landed_record" | head -n 1)"
  [[ "$declared_head" == "-" ]] && declared_head=""
  landed_count="$(sed -n 's/^count //p' "$landed_record" | head -n 1)"
  pushed_at="$(sed -n 's/^pushed //p' "$landed_record" | head -n 1)"
  close_comment="$(tail -n +6 "$landed_record")"
  if ! [[ "$landed_head" =~ ^[0-9a-f]{7,}$ && "$landed_count" =~ ^[0-9]+$ ]]; then
    echo "error: $landed_record is not a land record azelf can read — check it, then delete it and land again." >&2
    exit 1
  fi
elif ! git show-ref --verify --quiet "refs/heads/$branch"; then
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
#
# A land being finished has its comment in the record already.
LAND_NOTES_MAX=20
land_notes=""
if ! $finishing; then
  land_notes="$(
    git diff "$SLICE_BASE_BRANCH...$branch" 2>/dev/null \
      | grep -E '^\+[[:space:]]*[-*] \[ \] ' \
      | sed 's/^+//' \
      || true
  )"
  close_comment="Landed on $SLICE_BASE_BRANCH via slice-land.sh."
fi
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

# ─── The land lock ─────────────────────────────────────────────────────────
#
# One land at a time per repo, whoever runs it. A dispatcher lands one slice
# per round, which serialises its own lands and nobody else's: with two
# dispatchers on consumer-a, five slices landed onto one master in one main
# checkout, and a hand land during a running wave raced them too. Two `git
# merge`s at once fail on git's index.lock, which reads as a broken land; one
# after the other, the second refuses as "diverged" below, which a dispatcher
# parks and retries when the base moves.
#
# Here and not in the dispatcher, because hand lands race too. Taken after the
# checks above, so a land that was never going to happen waits for nobody, and
# held until this script exits, cleanup and ticket close included. The holder
# is this shell: a land that died holding it is taken over by the next one,
# which says so. See scripts/slice-lock.ts.
LAND_LOCK_WAIT=300
land_lock="$_slice_common/azelf-land.lock"
bun "$SLICE_AZELF_DIR/scripts/slice-lock.ts" acquire "$land_lock" \
  --pid $$ --label "$branch" --what land --wait "$LAND_LOCK_WAIT" || exit 1
trap 'bun "$SLICE_AZELF_DIR/scripts/slice-lock.ts" release "$land_lock" --pid $$ || true' EXIT

# The markers live inside the worktree, which the cleanup removes, so they are
# read first. What they say is used at the cleanup; see "The session that may
# still be sitting in there" there.
session_pid=""
session_declared_done=true
marker_declared=""
if [[ -f "$worktree_path/.slice-ready-to-land" ]]; then
  session_pid="$(head -n 1 "$worktree_path/.slice-ready-to-land" | tr -d '[:space:]')"
  # Line 2, when slice-done.sh wrote one: the head the agent declared done at,
  # BEFORE any rebase moved it. See the note there for why that matters.
  marker_declared="$(sed -n 2p "$worktree_path/.slice-ready-to-land" | tr -d '[:space:]')"
elif [[ -f "$worktree_path/.slice-live" ]]; then
  session_pid="$(head -n 1 "$worktree_path/.slice-live" | tr -d '[:space:]')"
  session_declared_done=false
fi

if $finishing; then
  landed_short="$(git rev-parse --short "$landed_head" 2>/dev/null || echo "$landed_head")"
  echo "── finishing the land of $ticket_ref — it pushed as $landed_short at $pushed_at, and the process running it stopped before it was done ──"
  fetch_err=$(git fetch origin "$SLICE_BASE_BRANCH" 2>&1) || {
    echo "error: couldn't fetch origin/$SLICE_BASE_BRANCH to check the land:" >&2
    echo "$fetch_err" >&2
    exit 1
  }
  # The record is this script's own word that the push happened. Checked
  # anyway, because closing a ticket whose work is not on the base is the one
  # mistake here that someone downstream pays for.
  if ! git merge-base --is-ancestor "$landed_head" "origin/$SLICE_BASE_BRANCH" 2>/dev/null; then
    echo "error: $landed_record says $ticket_ref pushed as $landed_short, but origin/$SLICE_BASE_BRANCH does not contain it." >&2
    echo "       Nothing was changed. Check what reached origin, then delete that file and land $ticket_ref again." >&2
    exit 1
  fi
  echo "✓ origin/$SLICE_BASE_BRANCH contains $landed_short"
  # A fast-forward is linear, so the commits it brought are the last N.
  base_before="$(git rev-parse "$landed_head~$landed_count" 2>/dev/null || true)"
else
  declared_head="$marker_declared"
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

  # The close comment also records WHAT landed, as SHAs. The landed head is the
  # only one a later `merge-base --is-ancestor` will ever say yes to; the
  # declared head is the one the agent has in its scrollback, and the two differ
  # whenever the dispatcher rebased before landing. Putting both on the ticket
  # is what lets "did #42 land?" be answered by looking, instead of by a SHA
  # check that is a false negative most of the time.
  landed_head="$(git rev-parse HEAD)"
  landed_short="$(git rev-parse --short "$landed_head")"
  landed_count="$(git rev-list --count "$base_before..$landed_head")"
  landed_line="landed on $SLICE_BASE_BRANCH as $landed_short ($landed_count commit(s))"
  if [[ -n "$declared_head" ]]; then
    landed_line="declared done at $(git rev-parse --short "$declared_head" 2>/dev/null || echo "$declared_head"), $landed_line"
  fi
  close_comment="$close_comment

$landed_line"
  echo "✓ $landed_line"

  # The record, now that the work is public. See "A land that already pushed"
  # above. A record that can't be written costs only the finishing, so it
  # warns and goes on.
  if ! printf 'landed %s\ndeclared %s\ncount %s\npushed %s\n\n%s\n' \
      "$landed_head" "${declared_head:--}" "$landed_count" "$(date '+%Y-%m-%d %H:%M')" \
      "$close_comment" >"$landed_record" 2>/dev/null; then
    echo "warning: couldn't write $landed_record — if this land is interrupted now, finish it by hand." >&2
  fi
fi

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
  if [[ -n "$base_before" ]] && git diff --name-only "$base_before" "$landed_head" | grep -qE "$(db_lock_re)"; then touched_lock=true; fi

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

# Closing the ticket is part of landing, not an afterthought to remember.
# A blocking edge clears only when the blocker is CLOSED — on GitHub that is
# how native issue dependencies work, and it is the contract every tracker
# adapter is held to (scripts/slice-tracker.ts, "closing is load-bearing").
# So a landed-but-open ticket leaves everything downstream of it refusing to
# launch — slice-session.sh counts open blockers and exits. Leaving this to
# the human means discovering it later as "why won't the next slice start?".
#
# Before the cleanup, not after it. Removing a worktree full of node_modules
# takes long enough to be interrupted, and on consumer-a it was: a terminal
# crash killed a dispatcher mid-removal (2026-10-08), and the ticket it had
# just pushed stayed open, its dependents blocked, with nothing saying why.
# The close is what the next wave waits on; the cleanup can wait for anyone.
#
# Never fatal: the code is on master and pushed by this point, which is the
# part that can't be redone by hand.
echo "── closing $ticket_ref ───────────────────────────────────"
closed=false
if $finishing && [[ "$(slice_tracker_get "$ticket" 2>/dev/null | cut -f1)" == "closed" ]]; then
  echo "✓ $ticket_ref is already closed"
  closed=true
elif close_err=$(slice_tracker_close "$ticket" "$close_comment" 2>&1); then
  echo "✓ closed $ticket_ref"
  closed=true
  if [[ -n "$land_notes" ]]; then
    echo "  ↳ carried $land_notes_total unticked check(s) into the ticket"
  fi
else
  echo "warning: couldn't close $ticket_ref — close it by hand or its dependents stay blocked:" >&2
  echo "$close_err" >&2
  # Kept for whoever closes it later: a dispatcher retries the close with this
  # comment, so the unticked checks above still reach the ticket.
  close_saved="$_slice_common/azelf-close-$ticket.txt"
  if printf '%s\n' "$close_comment" >"$close_saved" 2>/dev/null; then
    echo "  the comment it would have left is in $close_saved" >&2
  fi
fi

# CLEANUP MUST NOT BE ABLE TO FAIL THE LAND, and must say what it skipped.
#
# By this line the base branch has already been fast-forwarded AND pushed — the
# work is public — and the ticket is closed, so what remains is housekeeping.
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
# Read before the land, because both markers live inside the worktree.
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

# ─── A worktree whose removal was interrupted ──────────────────────────────
#
# Only when finishing. `git worktree remove` deletes the files and then the
# directory, so one cut short leaves a worktree that is missing tracked files
# — which plain `remove` refuses as "modified". When every change is such a
# deletion and its HEAD is the head that landed, there is nothing in it that
# is not on the base, and --force removes what is left. Anything else — a
# modified file, an untracked one, another HEAD — is someone's, and stays.
# A worktree git can no longer read at all (its `.git` file went first) is
# not inspected, so it is not removed either: the person is told to.
worktree_unreadable=false
half_removed() {
  local top status
  if [[ ! -e "$worktree_path/.git" ]] ||
     ! top="$(git -C "$worktree_path" rev-parse --show-toplevel 2>/dev/null)" ||
     [[ "$(cd "$top" && pwd -P)" != "$worktree_path" ]]; then
    worktree_unreadable=true
    return 1
  fi
  [[ "$(git -C "$worktree_path" rev-parse HEAD 2>/dev/null)" == "$(git rev-parse "$landed_head" 2>/dev/null)" ]] || return 1
  status="$(git -C "$worktree_path" status --porcelain 2>/dev/null)" || return 1
  [[ -n "$status" ]] && ! printf '%s\n' "$status" | grep -qv '^ D '
}

echo "── cleaning up ────────────────────────────────────────"
if [[ -d "$worktree_path" ]]; then
  removed=false
  if git worktree remove "$worktree_path" 2>/dev/null; then
    removed=true
  elif $finishing && half_removed &&
       git worktree remove --force "$worktree_path" 2>/dev/null; then
    removed=true
    echo "  (its interrupted removal had already deleted part of it; nothing in it was unlanded)"
  fi
  if $removed; then
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
  elif $worktree_unreadable; then
    echo "⚠️  left $worktree_path — git can no longer read it (its removal was interrupted)."
    echo "    Everything in it landed as $landed_short; delete the directory and run git worktree prune."
  else
    echo "⚠️  left $worktree_path in place — it has modified or untracked files,"
    echo "    most likely from something still running in that session."
    echo "    Check it, then: git worktree remove --force $worktree_path"
  fi
fi
# A worktree whose directory is already gone is still registered until this.
if $finishing; then git worktree prune 2>/dev/null || true; fi
git branch -d "$branch" >/dev/null 2>&1 && echo "✓ deleted local branch $branch" || true
if git show-ref --verify --quiet "refs/remotes/origin/$branch"; then
  git push origin --delete "$branch" >/dev/null 2>&1 && echo "✓ deleted origin/$branch" || true
fi

# Last, and only once the ticket is closed: until then a run of this script
# has something left to finish. The cleanup is not waited for — what it left
# was said above, and is a person's to look at.
if $closed; then
  rm -f "$landed_record"
  if $finishing; then echo "✓ finished the land of $ticket_ref"; fi
fi
