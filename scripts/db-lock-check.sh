#!/usr/bin/env bash
#
# Shared DB-lock check, sourced (not executed directly) by slice-session.sh,
# session-commit.sh, slice-land.sh, db-lock.sh and the dispatcher.
#
#   source "scripts/db-lock-check.sh"   # after cd-ing to repo root
#   holder=$(db_lock_holder "$(git rev-parse --abbrev-ref HEAD)") || true
#   [[ -z "$holder" ]] || { echo "DB lock held by: $holder" >&2; exit 1; }
#
# Also the primitives db-lock.sh (the claim) is built on, so the two never
# disagree about where the lock lives or what its owner file says:
#
#   db_lock_dir / db_lock_log     # <common git dir>/azelf-db.lock, azelf-db.log
#   db_lock_read_owner            # 0 held (DB_LOCK_OWNER_* set), 1 free, 2 unverifiable
#   db_lock_re                    # the exclusive paths as one anchored ERE
#   db_lock_status_line           # "DB lock: free" / "held by … since …" / UNVERIFIABLE
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
# THE LOCK IS A CLAIM, AND THE SCAN IS ITS BACKSTOP
# -------------------------------------------------
# A session takes the lock BEFORE it touches the database — `db-lock.sh claim`
# — and holds it until its change is on the base branch, where slice-land.sh
# releases it. The claim is a directory in the common git dir (shared by every
# worktree of the repo, and the only thing all of them can already see), taken
# with mkdir, which is atomic: exactly one claimer wins, so two sessions can
# never each believe the other holds it. The owner file inside names the
# branch, and `db_lock_holder` reads that FIRST. Only when nobody holds the
# claim does it fall back to the scan below.
#
# The scan: a worktree "holds the lock" if any exclusive path has EITHER:
#   - changes committed to its branch that the base branch doesn't have yet, or
#   - uncommitted changes sitting in its working directory right now
# The second case matters as much as the first: a migration is often applied
# live against Supabase (via the MCP tool or the CLI) well before it's ever
# committed, so checking git history alone would miss the actual danger
# window. With the claim in place a worktree found this way is one that
# SKIPPED the protocol, and the scan says so by name; it is what gets the
# violation noticed, not what enforces the rule.
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
# WHY THE SCAN WAS NOT ENOUGH: it can only NOTICE a migration after it has
# been written. The dangerous act, applying that migration to the live
# database, happens between launch and commit, and a scan is in no position to
# refuse it. On 2026-09-23 two slices on consumer-a applied migrations nine
# minutes apart; the first refusal arrived at commit time, about the git
# record, after both applies were done — and then each slice saw the other as
# the holder and waited, forever, for a condition that could not become true.
# The claim (docs/db-lock-plan.md) is what fixes both: a lock taken before the
# DDL, with exactly one owner. The mutual-case diagnosis below is kept for the
# path where nobody claimed, and its advice now ends in a claim. And
# `exclusiveLockLabel` is how the dispatcher avoids scheduling the race the
# claim resolves: labelled tickets are started one at a time (slice-run.ts,
# `runnable`).
#
# The commit-time call runs under session-commit.sh's mkdir mutex, which lives
# in the COMMON git dir and so serializes commits across worktrees. That stops
# two commits interleaving; the claim is what stops two sessions each writing
# a migration in the first place.

# Self-contained: both callers have usually loaded this already, and
# slice-config.sh no-ops on a second source, so this costs nothing when they
# have and works when something sources this file alone. Same contract as the
# usage note above — cwd must be a checkout root.
source "scripts/slice-config.sh"

# ─── the claim: primitives shared with db-lock.sh ─────────────────────────
#
# In the COMMON git dir, not `--git-dir`: inside a linked worktree the latter
# is that worktree's private `.git/worktrees/<name>`, and a lock there would be
# one nobody else could see — the exact mistake session-commit.sh's mutex once
# made. `--path-format=absolute` because the common dir is otherwise printed
# relative to the cwd. Names prefixed `_` / `DB_LOCK_` and never `path` or
# `status`: see the zsh notes further down.
db_lock_dir() {
  local _common
  _common=$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null) || return 1
  printf '%s\n' "$_common/azelf-db.lock"
}

db_lock_log() {
  local _common
  _common=$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null) || return 1
  printf '%s\n' "$_common/azelf-db.log"
}

# Reads the owner file into DB_LOCK_OWNER_BRANCH / _TICKET / _PID / _AT / _WT.
# Returns 0 when the lock is held, 1 when it is free, 2 when the lock dir
# exists but says nothing readable about who owns it — which every caller
# treats as HELD, because a claim that cannot be verified is not one to take
# over. Never a `local x=$(…)`: `local` would mask the exit status.
db_lock_read_owner() {
  DB_LOCK_OWNER_BRANCH=""
  DB_LOCK_OWNER_TICKET=""
  DB_LOCK_OWNER_PID=""
  DB_LOCK_OWNER_AT=""
  DB_LOCK_OWNER_WT=""
  local _dir _owner _line
  _dir=$(db_lock_dir) || return 2
  if [[ ! -d "$_dir" ]]; then
    return 1
  fi
  _owner="$_dir/owner"
  if [[ ! -r "$_owner" ]]; then
    return 2
  fi
  while IFS= read -r _line || [[ -n "$_line" ]]; do
    case "${_line%%=*}" in
      branch) DB_LOCK_OWNER_BRANCH="${_line#*=}" ;;
      ticket) DB_LOCK_OWNER_TICKET="${_line#*=}" ;;
      pid) DB_LOCK_OWNER_PID="${_line#*=}" ;;
      claimed_at) DB_LOCK_OWNER_AT="${_line#*=}" ;;
      worktree) DB_LOCK_OWNER_WT="${_line#*=}" ;;
    esac
  done <"$_owner"
  if [[ -z "$DB_LOCK_OWNER_BRANCH" ]]; then
    return 2
  fi
  return 0
}

# The owner's branch is gone. Reported, never auto-released: a deleted branch
# does not mean its migration was reverted, or was never applied.
db_lock_owner_stale() {
  ! git show-ref --verify --quiet "refs/heads/$DB_LOCK_OWNER_BRANCH"
}

# The exclusive paths as one anchored ERE over a file list, for callers that
# need to ask "does THIS set of files touch them" — a question git cannot
# answer with two pathspecs. Each entry is followed by `/` or end-of-string,
# so it may name a directory OR a single file; a literal `.` is escaped so it
# does not match any character and over-trigger (a false hold is the safe
# direction, but confusing enough to be worth not doing). Non-zero with no
# output when nothing is configured, so `grep -qE "$(db_lock_re)"` cannot
# accidentally match everything.
db_lock_re() {
  if [[ ${#SLICE_EXCLUSIVE_LOCK_PATHS[@]} -eq 0 ]]; then
    return 1
  fi
  local _re="" _p
  for _p in "${SLICE_EXCLUSIVE_LOCK_PATHS[@]}"; do
    _p="${_p%/}"
    _p="$(printf '%s' "$_p" | sed 's/[].[^$*\\]/\\&/g')"
    _re="${_re}${_re:+|}^${_p}"'(/|$)'
  done
  printf '%s\n' "$_re"
}

# One human line, for banners. Exit status is always 0; the text is the answer.
db_lock_status_line() {
  if [[ ${#SLICE_EXCLUSIVE_LOCK_PATHS[@]} -eq 0 ]]; then
    echo "DB lock: not configured (exclusiveLockPaths is empty)"
    return 0
  fi
  local _rc=0
  db_lock_read_owner || _rc=$?
  case $_rc in
    1) echo "DB lock: free" ;;
    2) echo "DB lock: UNVERIFIABLE — $(db_lock_dir) exists but its owner file is missing or unreadable" ;;
    0)
      local _line="DB lock: held by $DB_LOCK_OWNER_BRANCH since $DB_LOCK_OWNER_AT"
      if db_lock_owner_stale; then
        _line="$_line (STALE — that branch no longer exists; not released automatically)"
      fi
      echo "$_line"
      ;;
  esac
}

# The holder lines db_lock_holder prints for a claim. Same shape as the scan's
# lines — `path (branch, …)` — so a caller printing them verbatim reads the same
# either way.
_db_lock_owner_lines() {
  local _lock_paths="${SLICE_EXCLUSIVE_LOCK_PATHS[*]}"
  echo "${DB_LOCK_OWNER_WT:-?} ($DB_LOCK_OWNER_BRANCH, holds the DB lock since $DB_LOCK_OWNER_AT)"
  if db_lock_owner_stale; then
    cat <<EOF
    ⚠️  branch $DB_LOCK_OWNER_BRANCH no longer exists, so this claim is STALE. It is NOT released
        automatically: a gone branch does not mean its change to $_lock_paths was
        reverted, or was never applied. Check $(db_lock_log) and the database, then from
        the main checkout: ./scripts/db-lock.sh release --landed $DB_LOCK_OWNER_BRANCH
EOF
  fi
}

_db_lock_unverifiable_lines() {
  cat <<EOF
$(db_lock_dir) exists but its owner file is missing or unreadable — UNVERIFIABLE, treating as locked.
    A claimer may have died between taking the lock and recording itself. Check
    $(db_lock_log); once you know nobody is mid-migration: rm -r $(db_lock_dir)
EOF
}

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

  # ─── 1. the claim ──────────────────────────────────────────────────────
  # Read first, and final when it names someone else: a held claim is the
  # answer, whatever the worktrees look like. The scan below only runs when
  # nobody holds it, or when the CALLER does — in which case anything it finds
  # is another worktree that skipped the protocol, worth a warning to the
  # owner and a refusal to anyone else.
  local claim_rc=0
  db_lock_read_owner || claim_rc=$?
  case $claim_rc in
    2)
      _db_lock_unverifiable_lines
      return 0
      ;;
    0)
      if [[ "$DB_LOCK_OWNER_BRANCH" != "$exclude_branch" ]]; then
        _db_lock_owner_lines
        return 0
      fi
      ;;
  esac
  local caller_owns=false
  if [[ $claim_rc -eq 0 ]]; then caller_owns=true; fi

  # ─── 2. the scan ───────────────────────────────────────────────────────
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
      # Anything the scan finds holds no claim by construction — a claim would
      # have been the answer above — so the line says what was skipped.
      dirty) holders+=("$wt_path (${wt_branch:-detached}, dirty under ${SLICE_EXCLUSIVE_LOCK_PATHS[*]} with no claim — it skipped db-lock.sh claim)") ;;
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

  # The caller holds the claim: the above are violators, and the caller must
  # not wait for them — that would hand the mutual deadlock back.
  if $caller_owns; then
    echo "(this worktree — $exclude_branch — holds the claim; they must stash or wait, not you)"
    return 0
  fi

  local dirty_total=${#holders[@]}
  if $self_dirty; then
    dirty_total=$((dirty_total + 1))
    echo "(and this worktree — $exclude_branch — is dirty there too, with no claim)"
  fi
  if [[ $dirty_total -ge 2 ]]; then
    _db_lock_mutual_advice "$dirty_total"
  fi
  return 0
}

# Printed under the holder list whenever more than one worktree holds
# uncommitted changes to an exclusive path and none of them holds the claim.
# Every caller prints db_lock_holder's output verbatim, so this travels with
# the holder rather than needing each caller to re-diagnose — a session that
# polls db_lock_holder by hand sees it too.
_db_lock_mutual_advice() {
  local n="$1" lock_paths="${SLICE_EXCLUSIVE_LOCK_PATHS[*]}"
  cat <<EOF

⚠️  $n worktrees hold uncommitted changes under $lock_paths and none holds the claim.
    This does NOT clear by waiting: each is waiting for the other to land, and
    neither can commit. Pick one to go first. In each of the others:
        git stash push -- $lock_paths
    then in the first: ./scripts/db-lock.sh claim — it wins now that it is alone —
    commit and land. \`git stash pop\` in the others afterwards, and renumber
    the migration if it now sorts before the one that landed.
    And check what each session has ALREADY applied to the database: this state
    means more than one may have. (docs/db-lock-plan.md in the azelf package)
EOF
}
