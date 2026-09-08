#!/usr/bin/env bash
#
# Shared DB-lock check, sourced (not executed directly) by slice-session.sh
# and session-commit.sh.
#
#   source "scripts/db-lock-check.sh"   # after cd-ing to repo root
#   holder=$(db_lock_holder "$(git rev-parse --abbrev-ref HEAD)") || true
#   [[ -z "$holder" ]] || { echo "DB lock held by: $holder" >&2; exit 1; }
#
# WHY THIS EXISTS
# ---------------
# This Supabase project has no PITR, and a past scope-by-primary-key mistake
# already clobbered protected rows once on the shared prod DB. CLAUDE.md's
# rule is "only one session touches the DB at a time" — running several
# slice sessions in parallel (docs/adr/0001-parallel-slice-sessions.md) means
# several git worktrees can exist at once, so this is the check that enforces
# that rule across worktrees instead of relying on memory.
#
# WHICH paths are exclusive is slice.config.ts's `exclusiveLockPaths`, not a
# literal in here. An EMPTY list makes this whole check a no-op, which is the
# right answer for a project with no shared mutable resource — most projects.
# consumer-a is the exception: one live shared database, no point-in-time
# recovery, so two concurrent migrations mean two agents mutating production.
#
# A worktree "holds the lock" if any exclusive path has EITHER:
#   - changes committed to its branch that the base branch doesn't have yet, or
#   - uncommitted changes sitting in its working directory right now
# The second case matters as much as the first: a migration is often applied
# live against Supabase (via the MCP tool or the CLI) well before it's ever
# committed, so checking git history alone would miss the actual danger
# window.
#
# FAILS CLOSED: if the check itself can't be completed for a worktree (git
# command failure, a stale worktree entry whose directory is already gone,
# `git worktree list` itself failing) that worktree is reported as HOLDING
# the lock, not skipped. A safety gate on an unrecoverable database should
# refuse when uncertain, never silently wave a session through.
#
# EVERY worktree is scanned, the base checkout on `master` included. An
# earlier version skipped the base, which made the guard asymmetric in the
# wrong direction: a slice's migrations blocked a commit on master, but
# uncommitted migrations on master never blocked a slice from launching or
# committing. Since master is where the main session works and slices are the
# new concurrent thing, "main session mid-migration, new slice starting" is
# the likelier of the two collisions, and it was the one going uncaught. The
# only worktree exempt now is the CALLER's own (`exclude_branch`), since your
# own in-flight work must not block your own commit.
#
# The cost is real and intended: while any uncommitted migration sits on
# master, no slice touching supabase/migrations/ can launch or commit until
# it lands. That is what "only one session touches the DB at a time" means
# when taken literally, which is the point.
#
# KNOWN LIMITATION: this is a point-in-time scan, not an atomic lock, at the
# point slice-session.sh calls it (launch time) — two sessions can both pass
# a clean check before either has touched a migration, then both proceed.
# That's why there are two checkpoints: the real enforcement point is
# session-commit.sh's call, which runs this same check while already holding
# session-commit.sh's own mkdir-based commit mutex, so two commits can never
# race each other there. The launch-time check is a best-effort early
# warning, not a guarantee — the merge-time check is what closes the race.

# Self-contained: both callers have usually loaded this already, and
# slice-config.sh no-ops on a second source, so this costs nothing when they
# have and works when something sources this file alone. Same contract as the
# usage note above — cwd must be a checkout root.
source "scripts/slice-config.sh"

_db_lock_worktree_status() {
  # Echoes "dirty", "error", or nothing (clean) for one worktree.
  #
  # `dir`, not `path`: in zsh `path` is the array tied to $PATH, so `local
  # path=...` inside a sourced function empties PATH for the rest of it and
  # every `git` call below fails to resolve. See the note on `wt_status` in
  # db_lock_holder — same class of bug, and this one hid behind the
  # fail-closed branch by reporting every worktree UNVERIFIABLE.
  local dir="$1" branch="$2" base="$3"

  if [[ -n "$branch" && "$branch" != "HEAD" ]]; then
    local diff_out
    if ! diff_out=$(git diff --name-only "$base...$branch" -- "${SLICE_EXCLUSIVE_LOCK_PATHS[@]}" 2>&1); then
      echo "error"
      return
    fi
    if [[ -n "$diff_out" ]]; then
      echo "dirty"
      return
    fi
  fi

  if [[ ! -d "$dir" ]]; then
    echo "error"
    return
  fi

  local status_out
  if ! status_out=$(git -C "$dir" status --porcelain -- "${SLICE_EXCLUSIVE_LOCK_PATHS[@]}" 2>&1); then
    echo "error"
    return
  fi
  if [[ -n "$status_out" ]]; then
    echo "dirty"
  fi
}

db_lock_holder() {
  local exclude_branch="${1:-}"
  # DB_LOCK_BASE still wins, so a caller can scan against a different base
  # without editing config. The default is now the configured base branch.
  local base="${DB_LOCK_BASE:-$SLICE_BASE_BRANCH}"

  # No exclusive paths configured means there is nothing to serialize on, and
  # the lock is never held. This is also what keeps the two expansions below
  # safe: macOS ships bash 3.2, where "${arr[@]}" on an EMPTY array under
  # `set -u` is an unbound-variable error, not an empty list.
  #
  # Written as an `if`, never `[[ … ]] && return 1`: under `set -e` an and-list
  # whose test fails returns non-zero and takes the calling script down with it.
  if [[ ${#SLICE_EXCLUSIVE_LOCK_PATHS[@]} -eq 0 ]]; then
    return 1
  fi

  local raw
  if ! raw=$(git worktree list --porcelain 2>&1); then
    echo "(unable to enumerate worktrees — git worktree list failed: $raw)"
    return 0
  fi

  # Parse porcelain output by line PREFIX, not by field-splitting, so a
  # worktree path containing a space is never truncated.
  local wt branch=""
  local -a entries=()
  while IFS= read -r line; do
    if [[ "$line" == worktree\ * ]]; then
      wt="${line#worktree }"
      branch=""
    elif [[ "$line" == branch\ * ]]; then
      branch="${line#branch refs/heads/}"
    elif [[ "$line" == "detached" ]]; then
      branch="HEAD"
    elif [[ -z "$line" ]]; then
      [[ -n "$wt" ]] && entries+=("$wt"$'\t'"$branch")
      wt=""
      branch=""
    fi
  done <<<"$raw"
  [[ -n "$wt" ]] && entries+=("$wt"$'\t'"$branch")

  # NOT named `status`: that is a read-only special variable in zsh, and this
  # file is documented above as something you can `source`. Sourced into an
  # interactive zsh, `local ... status` aborts the function mid-scan and it
  # returns EMPTY — reporting the lock free without having checked anything.
  # Both callers run under a bash shebang so they were never affected, but a
  # gate that fails OPEN in any shell is the one direction this must not fail.
  local entry wt_path wt_branch wt_status
  for entry in "${entries[@]}"; do
    wt_path="${entry%%$'\t'*}"
    wt_branch="${entry#*$'\t'}"

    # Only the caller's own worktree is exempt — see the header on why the
    # base worktree is deliberately NOT skipped any more.
    [[ -n "$exclude_branch" && "$wt_branch" == "$exclude_branch" ]] && continue

    wt_status=$(_db_lock_worktree_status "$wt_path" "$wt_branch" "$base")
    case "$wt_status" in
      dirty) echo "$wt_path (${wt_branch:-detached}, dirty)"; return 0 ;;
      error) echo "$wt_path (${wt_branch:-detached}, UNVERIFIABLE — treating as locked)"; return 0 ;;
    esac
  done

  return 1
}
