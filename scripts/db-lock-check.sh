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
# KNOWN LIMITATION, AND IT IS THE BIG ONE: this is a scan of git state, not a
# lock anyone takes. Every caller — slice-session.sh at launch, session-commit.sh
# at commit, slice-run.ts before a wave — can only NOTICE a migration after it
# has been written. The dangerous act, applying that migration to the live
# database, happens between launch and commit, and nothing here is in a
# position to refuse it. On 2026-09-23 two slices on consumer-a applied
# migrations nine minutes apart; the first refusal arrived at commit time,
# about the git record, after both applies were done. The claim protocol in
# docs/db-lock-plan.md (Phase 2) is the fix: a lock a session takes BEFORE it
# touches the DB. Until it lands, this scan is a backstop, not an enforcement
# point.
#
# The commit-time call does run under session-commit.sh's mkdir mutex, which
# lives in the COMMON git dir and so serializes commits across worktrees. That
# stops two commits interleaving; it does not, and cannot, stop two sessions
# each writing a migration and then each seeing the other's — which is the
# mutual case db_lock_holder names explicitly below.

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
  # Every holder is collected, not just the first, and the caller's own
  # worktree is checked too (without counting as a holder). Both are for one
  # diagnosis: the MUTUAL case. Two worktrees that each hold an uncommitted
  # migration each see the other as the holder, and this function used to
  # return the first one it found with nothing more — so each side got "the
  # lock is held by <the other one>, let it merge first", waited for that, and
  # waited forever, because the other side was doing the same. Two slices on
  # consumer-a sat in exactly that state on 2026-09-23 with pollers running
  # against a condition that could never become true. Waiting is the wrong
  # move there and the message has to say so, because "let that one merge
  # first" is impossible advice when it is also waiting on you.
  local entry wt_path wt_branch wt_status
  local -a holders=()
  local self_dirty=false
  for entry in "${entries[@]}"; do
    wt_path="${entry%%$'\t'*}"
    wt_branch="${entry#*$'\t'}"

    wt_status=$(_db_lock_worktree_status "$wt_path" "$wt_branch" "$base")

    # Only the caller's own worktree is exempt from HOLDING — see the header
    # on why the base worktree is deliberately NOT skipped any more. Its state
    # still matters: dirty-and-blocked is the mutual case.
    if [[ -n "$exclude_branch" && "$wt_branch" == "$exclude_branch" ]]; then
      if [[ "$wt_status" == "dirty" ]]; then self_dirty=true; fi
      continue
    fi

    case "$wt_status" in
      dirty) holders+=("$wt_path (${wt_branch:-detached}, dirty)") ;;
      # Fails closed, and immediately: an unverifiable worktree is reported
      # on its own, ahead of any diagnosis, because the diagnosis assumes the
      # scan can be trusted.
      error) echo "$wt_path (${wt_branch:-detached}, UNVERIFIABLE — treating as locked)"; return 0 ;;
    esac
  done

  if [[ ${#holders[@]} -eq 0 ]]; then
    return 1
  fi

  printf '%s\n' "${holders[@]}"

  local dirty_total=${#holders[@]}
  if $self_dirty; then
    dirty_total=$((dirty_total + 1))
    echo "(and this worktree — $exclude_branch — is dirty there too)"
  fi
  if [[ $dirty_total -ge 2 ]]; then
    _db_lock_mutual_advice "$dirty_total"
  fi
  return 0
}

# Printed under the holder list whenever more than one worktree holds
# uncommitted changes to an exclusive path. Every caller prints db_lock_holder's
# output verbatim, so this travels with the holder rather than needing each
# caller to re-diagnose.
_db_lock_mutual_advice() {
  local n="$1" lock_paths="${SLICE_EXCLUSIVE_LOCK_PATHS[*]}"
  cat <<EOF

⚠️  $n worktrees hold uncommitted changes under $lock_paths at once.
    This does NOT clear by waiting: each is waiting for the other to land, and
    neither can commit. Pick one to go first. In each of the others:
        git stash push -- $lock_paths
    then let the first one commit and land, \`git stash pop\` there, and renumber
    the migration if it now sorts before the one that landed.
    And check what each session has ALREADY applied to the database: this state
    means more than one may have. (docs/db-lock-plan.md in the azelf package)
EOF
}
