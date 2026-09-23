#!/usr/bin/env bash
#
# The DB lock: claim it before you touch an exclusive path, hold it until the
# change is on the base branch.
#
#   ./scripts/db-lock.sh claim                          # take it, or be told who has it
#   ./scripts/db-lock.sh release                        # give it back (owner only)
#   ./scripts/db-lock.sh release --landed <branch>      # slice-land.sh, from the main checkout
#   ./scripts/db-lock.sh status [--porcelain]           # free / held by … / UNVERIFIABLE
#   ./scripts/db-lock.sh transfer <ticket> --reason "…" # the operator's override, logged
#
# WHY THIS EXISTS
# ---------------
# `exclusiveLockPaths` in slice.config.ts names paths only one worktree may
# change at a time — database migrations against one live instance, on a
# project with no point-in-time recovery, is the case it was written for. The
# check that guarded them (db-lock-check.sh) SCANNED git for a migration, and
# a scan can only see one that has already been written. The dangerous act —
# applying it to the live database — happens before anything is committed,
# and nothing was in a position to refuse it. On 2026-09-23 two slices on
# consumer-a each applied a migration, nine minutes apart, and the first
# refusal arrived at commit time, about the git record. Then each saw the
# other as the holder and waited for it. Forever.
#
# So the lock is now something a session TAKES, before the DDL:
#
#   - A directory in the common git dir, made with mkdir. mkdir is atomic
#     across processes, so exactly one claimer wins; there is no symmetric
#     state for two sessions to be stuck in. The common dir is shared by every
#     worktree of the repo and is the only thing all of them can already see.
#   - An owner file inside it: branch, ticket, pid, claimed_at, worktree. And
#     an append-only log next to it, one line per claim, release and transfer,
#     so "who had it when" is a fact and not a reconstruction.
#   - Released by slice-land.sh once the change is on the base branch. The
#     owner can release it early by hand; nobody else can release it at all.
#   - `transfer` is the ONLY override, and it is the operator's, from the main
#     checkout, with a reason that goes in the log. session-commit.sh gains no
#     --force: a force on this lock is the one door that lets two sessions
#     mutate production on purpose, and a slice agent must never hold it.
#
# NO WAITING, NO POLLING. A refused claim exits 1 and says who holds the lock;
# what to do next is the caller's decision. Inside a slice worktree a refusal
# also writes `.slice-lock-wait`, which is how the dispatcher knows this slice
# is not finished, only blocked, and relaunches it once the lock is free
# instead of landing what it had as a whole ticket. A successful claim, and a
# fresh session launch, clear it.
#
# The scan in db-lock-check.sh survives as the backstop: a worktree that is
# dirty under an exclusive path and holds no claim skipped this script, and a
# claim is refused while one exists, because taking the lock next to an
# unclaimed migration would be taking it on paper only. The owner is never
# refused on that account — refusing the one party that followed the rules is
# how the deadlock comes back.
#
# An EMPTY exclusiveLockPaths makes every subcommand a no-op that says so.

set -euo pipefail

usage() {
  local me="${AZELF_INVOKED_AS:-$0}"
  echo "usage: $me claim" >&2
  echo "       $me release [--landed <branch>]" >&2
  echo "       $me status [--porcelain]" >&2
  echo "       $me transfer <ticket> --reason \"…\"" >&2
  exit 64
}

sub="${1:-}"
[[ -n "$sub" ]] || usage
shift

# The checkout you are STANDING in — `--show-toplevel`, not `--git-common-dir`.
# A claim is made by a worktree, and inside a linked worktree the two are
# different directories; see session-commit.sh for the incident behind that
# distinction. The lock itself lives in the common dir (db_lock_dir), which is
# the one place this script reaches for it.
_slice_root="$(git rev-parse --show-toplevel 2>/dev/null || true)"
if [[ -z "$_slice_root" ]]; then
  echo "error: not inside a git repository — run this from a checkout." >&2
  exit 1
fi
cd "$(cd "$_slice_root" && pwd -P)"

# Brings slice-config.sh with it. The consumer's shim, by the same relative
# path every other script uses once it has cd'd to a checkout root.
source "scripts/db-lock-check.sh"

if [[ ${#SLICE_EXCLUSIVE_LOCK_PATHS[@]} -eq 0 ]]; then
  echo "DB lock: exclusiveLockPaths is empty in slice.config.ts — nothing to $sub. (no-op)"
  exit 0
fi

lock_paths="${SLICE_EXCLUSIVE_LOCK_PATHS[*]}"
lock_dir="$(db_lock_dir)"
lock_log="$(db_lock_log)"
this_wt="$(pwd -P)"
this_branch="$(git rev-parse --abbrev-ref HEAD)"
this_ticket="$(slice_ticket_from_branch "$this_branch" 2>/dev/null || echo "-")"
wait_marker="$this_wt/.slice-lock-wait"
me="${AZELF_INVOKED_AS:-./scripts/db-lock.sh}"

now() { date -u +%Y-%m-%dT%H:%M:%SZ; }
who() { git config user.name 2>/dev/null || echo "${USER:-?}"; }
log() { printf '%s\t%s\n' "$(now)" "$*" >>"$lock_log"; }
indent() { sed 's/^/       /'; }

# Same guard as slice-land.sh: the main checkout, on the base branch.
in_main_checkout() {
  local _main
  _main="$(cd "$(dirname "$(git rev-parse --path-format=absolute --git-common-dir)")" && pwd -P)"
  [[ "$this_wt" == "$_main" && "$this_branch" == "$SLICE_BASE_BRANCH" ]]
}

# Written whole into a temp file and moved into place, so a reader never sees
# half an owner. `pid` is the process that ran this script's parent — the
# agent's shell, or session-commit.sh — since this script itself is gone a
# moment later.
write_owner() {
  local _branch="$1" _ticket="$2" _pid="$3" _wt="$4" _tmp="$lock_dir/owner.tmp.$$"
  printf 'branch=%s\nticket=%s\npid=%s\nclaimed_at=%s\nworktree=%s\n' \
    "$_branch" "$_ticket" "$_pid" "$(now)" "$_wt" >"$_tmp"
  mv -f "$_tmp" "$lock_dir/owner"
}

refuse_claim() {
  local _holder="$1"
  # The marker first, the text second: a caller that stops reading early
  # (`| head`) kills this script on the next write, and the dispatcher's view
  # of this slice must not depend on how much of the refusal got read.
  if [[ "$this_ticket" != "-" ]]; then
    printf '%s\n' "$_holder" >"$wait_marker"
  fi
  echo "error: DB lock refused for $this_branch — held by:" >&2
  printf '%s\n' "$_holder" | indent >&2
  echo "       Do not touch $lock_paths, and do not poll for this to clear. Commit what" >&2
  echo "       you have outside those paths, say who holds the lock, and exit; the" >&2
  echo "       dispatcher starts you again when it is free." >&2
  if [[ "$this_ticket" != "-" ]]; then
    echo "       If you and the holder are both mid-migration, the operator can order" >&2
    echo "       you from the main checkout: $me transfer $this_ticket --reason \"…\"" >&2
  fi
  exit 1
}

cmd_claim() {
  [[ $# -eq 0 ]] || usage
  local _rc=0
  db_lock_read_owner || _rc=$?

  # The owner, re-claiming: always yes. session-commit.sh runs this on every
  # commit that touches an exclusive path, and the owner's second commit must
  # not be refused because someone ELSE has since skipped the protocol — the
  # scan result is a warning to the owner, and a refusal to everyone else.
  if [[ $_rc -eq 0 && "$DB_LOCK_OWNER_BRANCH" == "$this_branch" ]]; then
    rm -f "$wait_marker"
    echo "✓ DB lock already held by this worktree ($this_branch) since $DB_LOCK_OWNER_AT"
    local _warn
    _warn=$(db_lock_holder "$this_branch") || true
    if [[ -n "$_warn" ]]; then
      echo "⚠️  someone is touching $lock_paths without the claim:"
      printf '%s\n' "$_warn" | sed 's/^/    /'
    fi
    return 0
  fi

  # Held by another, unverifiable, or free-but-someone-skipped-the-protocol:
  # db_lock_holder tells all three apart and says what to do.
  local _holder
  _holder=$(db_lock_holder "$this_branch") || true
  if [[ -n "$_holder" ]]; then
    refuse_claim "$_holder"
  fi

  # Free, and the scan is clean. mkdir is the claim.
  if mkdir "$lock_dir" 2>/dev/null; then
    write_owner "$this_branch" "$this_ticket" "$PPID" "$this_wt"
    log "claim	$this_branch	ticket=$this_ticket	worktree=$this_wt	by=$(who)"
    rm -f "$wait_marker"
    echo "✓ DB lock claimed by $this_branch — hold it until this branch lands; slice-land.sh releases it"
    return 0
  fi

  # Lost the race between the check and the mkdir. Whoever won is in the
  # owner file now; say so the same way as any other refusal.
  _rc=0
  db_lock_read_owner || _rc=$?
  if [[ $_rc -eq 0 && "$DB_LOCK_OWNER_BRANCH" == "$this_branch" ]]; then
    echo "✓ DB lock already held by this worktree ($this_branch)"
    return 0
  fi
  _holder=$(db_lock_holder "$this_branch") || _holder="(claimed by someone else a moment ago — run: $me status)"
  refuse_claim "$_holder"
}

cmd_release() {
  local _landed=""
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --landed) _landed="${2:-}"; [[ -n "$_landed" ]] || usage; shift 2 ;;
      *) usage ;;
    esac
  done

  local _rc=0
  db_lock_read_owner || _rc=$?
  case $_rc in
    1)
      echo "DB lock is free — nothing to release"
      return 0
      ;;
    2)
      echo "error: DB lock is UNVERIFIABLE — not releasing what cannot be read:" >&2
      _db_lock_unverifiable_lines | indent >&2
      exit 1
      ;;
  esac

  if [[ -n "$_landed" ]]; then
    if ! in_main_checkout; then
      echo "error: release --landed runs from the main checkout on $SLICE_BASE_BRANCH — that is where a land happens." >&2
      echo "       (currently in $this_wt on $this_branch)" >&2
      exit 1
    fi
    if [[ "$DB_LOCK_OWNER_BRANCH" != "$_landed" ]]; then
      echo "error: DB lock is held by $DB_LOCK_OWNER_BRANCH since $DB_LOCK_OWNER_AT, not by $_landed — not releasing." >&2
      exit 1
    fi
    rm -rf "$lock_dir"
    log "release	$_landed	landed	by=$(who)"
    echo "✓ DB lock released — $_landed landed (held since $DB_LOCK_OWNER_AT)"
    return 0
  fi

  if [[ "$DB_LOCK_OWNER_BRANCH" != "$this_branch" ]]; then
    echo "error: DB lock is held by $DB_LOCK_OWNER_BRANCH since $DB_LOCK_OWNER_AT, not by this worktree ($this_branch)." >&2
    echo "       Only the owner releases it, or slice-land.sh when that branch lands." >&2
    exit 1
  fi
  rm -rf "$lock_dir"
  log "release	$this_branch	by-owner	by=$(who)"
  echo "✓ DB lock released by $this_branch (held since $DB_LOCK_OWNER_AT)"
}

cmd_status() {
  local _porcelain=false
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --porcelain) _porcelain=true; shift ;;
      *) usage ;;
    esac
  done

  local _rc=0
  db_lock_read_owner || _rc=$?
  if $_porcelain; then
    # One tab-separated line for scripts: `free`, `unverifiable`, or
    # `held|stale <TAB> branch <TAB> claimed_at <TAB> worktree`.
    case $_rc in
      1) echo "free" ;;
      2) echo "unverifiable" ;;
      0)
        local _state="held"
        if db_lock_owner_stale; then _state="stale"; fi
        printf '%s\t%s\t%s\t%s\n' "$_state" "$DB_LOCK_OWNER_BRANCH" "$DB_LOCK_OWNER_AT" "$DB_LOCK_OWNER_WT"
        ;;
    esac
    return 0
  fi

  case $_rc in
    1) echo "DB lock: free" ;;
    2)
      echo "DB lock: UNVERIFIABLE"
      _db_lock_unverifiable_lines | sed 's/^/    /'
      ;;
    0)
      local _ref="$DB_LOCK_OWNER_TICKET"
      if [[ "$_ref" != "-" && -n "$_ref" ]]; then _ref=" ($(slice_ref "$_ref"))"; else _ref=""; fi
      echo "DB lock: held by $DB_LOCK_OWNER_BRANCH$_ref since $DB_LOCK_OWNER_AT"
      echo "    worktree $DB_LOCK_OWNER_WT, claimed by pid $DB_LOCK_OWNER_PID"
      if db_lock_owner_stale; then
        _db_lock_owner_lines | tail -n +2
      fi
      ;;
  esac
  if [[ -f "$lock_log" ]]; then
    echo "    log: $lock_log"
  fi
}

cmd_transfer() {
  local _target="${1:-}" _reason=""
  [[ -n "$_target" ]] || usage
  shift
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --reason) _reason="${2:-}"; shift 2 ;;
      *) usage ;;
    esac
  done
  if ! slice_is_ticket_id "$_target"; then
    echo "error: '$_target' is not a $SLICE_TRACKER_NAME ticket id (expected $SLICE_TICKET_ID_PATTERN)." >&2
    exit 64
  fi
  if [[ -z "$_reason" ]]; then
    echo "error: --reason is required — it is the ordering decision, and it goes in the log." >&2
    exit 64
  fi
  if ! in_main_checkout; then
    echo "error: transfer runs from the main checkout on $SLICE_BASE_BRANCH. It is the operator's" >&2
    echo "       decision about which slice goes first, and a slice must never make it for itself." >&2
    echo "       (currently in $this_wt on $this_branch)" >&2
    exit 1
  fi

  local _to_branch _to_wt
  _to_branch="$(slice_branch_for "$_target")"
  _to_wt="$(slice_worktree_for "$_target")"

  local _rc=0
  db_lock_read_owner || _rc=$?
  case $_rc in
    1)
      echo "error: DB lock is free — nothing to transfer. $_to_branch can claim it itself:" >&2
      echo "       $me claim  (in its worktree)" >&2
      exit 1
      ;;
    2)
      echo "error: DB lock is UNVERIFIABLE — not transferring what cannot be read:" >&2
      _db_lock_unverifiable_lines | indent >&2
      exit 1
      ;;
  esac
  if [[ "$DB_LOCK_OWNER_BRANCH" == "$_to_branch" ]]; then
    echo "✓ DB lock is already held by $_to_branch (since $DB_LOCK_OWNER_AT)"
    return 0
  fi

  local _from="$DB_LOCK_OWNER_BRANCH"
  write_owner "$_to_branch" "$_target" "-" "$_to_wt"
  log "transfer	$_from -> $_to_branch	reason=\"$_reason\"	by=$(who)"
  # The new owner may have exited on a refused claim; without this the
  # dispatcher keeps it parked until the lock reads free.
  rm -f "$_to_wt/.slice-lock-wait"
  echo "✓ DB lock transferred from $_from to $_to_branch — $_reason"
  echo "  $_from finds out at its next claim or commit. It must not touch $lock_paths"
  echo "  until the lock is back with it; check what it has ALREADY applied to the database."
}

case "$sub" in
  claim) cmd_claim "$@" ;;
  release) cmd_release "$@" ;;
  status) cmd_status "$@" ;;
  transfer) cmd_transfer "$@" ;;
  -h|--help) usage ;;
  *) echo "unknown subcommand: $sub" >&2; usage ;;
esac
