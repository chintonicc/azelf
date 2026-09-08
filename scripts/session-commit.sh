#!/usr/bin/env bash
#
# Commit safely when several sessions share this working tree.
#
#   ./scripts/session-commit.sh -m "message" path/one.ts path/two.tsx
#   ./scripts/session-commit.sh -m "message" --push -y path/one.ts
#
# WHY THIS EXISTS
# ---------------
# CLAUDE.md already bans `git add -A` / `git add .` because several sessions
# share this tree and bulk-staging sweeps up another session's in-progress
# work — that happened for real (see memory: project_shared_tree_commit_race).
# The rail only works if every session remembers it every time. This script
# makes the unsafe path unavailable instead of relying on memory: it refuses
# to run with zero named paths, shows exactly what's about to be staged, and
# serializes commits across sessions with a lock so two commits never
# interleave. `--push` extends the same fix to pushing: fetch and check the
# push would fast-forward before sending it, per the same memory's "diff
# against parent before pushing."
#
# This does not replace judgement about which files belong to your task —
# it just makes it impossible to stage more than you named.

set -euo pipefail

LOCK_STALE_SECONDS=120
LOCK_WAIT_SECONDS=30

message=""
paths=()
auto_yes=false
do_push=false

usage() {
  echo "usage: ${AZELF_INVOKED_AS:-$0} -m <message> [--push] [-y] <path> [<path> ...]" >&2
  echo "       every path must be named explicitly — no ., no -A" >&2
  exit 64
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    -m|--message) message="${2:-}"; shift 2 ;;
    -y|--yes) auto_yes=true; shift ;;
    --push) do_push=true; shift ;;
    -h|--help) usage ;;
    --) shift; paths+=("$@"); break ;;
    -*) echo "unknown option: $1" >&2; usage ;;
    *) paths+=("$1"); shift ;;
  esac
done

[[ -n "$message" ]] || { echo "error: -m/--message is required" >&2; usage; }

if [[ ${#paths[@]} -eq 0 ]]; then
  echo "error: no paths given — this script never stages everything." >&2
  echo "       pass the exact files/dirs this task touched." >&2
  exit 1
fi

for p in "${paths[@]}"; do
  case "$p" in
    "."|".."|"-A"|"--all"|"*")
      echo "error: '$p' looks like a bulk-stage, not a named path. Refusing." >&2
      exit 1
      ;;
  esac
done

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
# git answers it instead, from the working directory — and `--show-toplevel`,
# NOT `--git-common-dir`. This script operates on the checkout you are STANDING
# IN, and inside a slice worktree those two are different directories.
#
# THAT DISTINCTION IS A BUG THIS LINE ONCE HAD, and it failed silently in the
# worst way: every path was valid, just somebody else's. `--git-common-dir`
# resolves a linked worktree to the MAIN checkout, which is correct for
# slice-land.sh (it fast-forwards the base branch there), for slice-session.sh
# (it manages worktrees from there) and for the TypeScript loader's findRepoRoot
# (it must recognise a worktree of a repo it already has). It is wrong for the
# two scripts a SLICE AGENT runs inside its own worktree — this one and
# session-commit.sh. consumer-a's ticket #21 hit it on 2026-09-08:
# session-commit.sh died with "pathspec did not match", and format.sh quietly
# reformatted the main checkout's copies of the slice's files while the slice's
# own copies stayed unformatted and its format gate never ran. slice-done.sh had
# used --show-toplevel all along and was right.
#
# A side effect worth naming: session-commit.sh's lock lives in `--git-dir`,
# which now resolves to the worktree's own `.git/worktrees/<name>` rather than
# to the shared one. That is the correct scope — the lock guards ONE index
# against interleaved staging, and every worktree has its own.
#
# -P to match git's own canonicalized worktree paths, which
# `git worktree list --porcelain` always prints resolved.
_slice_root="$(git rev-parse --show-toplevel 2>/dev/null || true)"
if [[ -z "$_slice_root" ]]; then
  echo "error: not inside a git repository — run this from a checkout." >&2
  exit 1
fi
cd "$(cd "$_slice_root" && pwd -P)"

# Loaded here rather than at the DB-lock block below, because that block TESTS
# ${#SLICE_EXCLUSIVE_LOCK_PATHS[@]} to decide whether to run at all — and under
# `set -u` reading the length of an array that hasn't been declared yet is an
# unbound-variable error, not zero.
source "scripts/slice-config.sh"

# ─── Lock ────────────────────────────────────────────────────────────────
# mkdir is atomic even across processes/sessions, so it doubles as a mutex.
# The cleanup trap is only registered AFTER we own the lock — registering it
# earlier would let a timed-out session rmdir the lock another session holds.
git_dir=$(git rev-parse --git-dir)
lock_dir="$git_dir/session-commit.lock"

waited=0
while ! mkdir "$lock_dir" 2>/dev/null; do
  lock_age=0
  if [[ -d "$lock_dir" ]]; then
    lock_mtime=$(stat -f %m "$lock_dir" 2>/dev/null || stat -c %Y "$lock_dir" 2>/dev/null || echo 0)
    lock_age=$(( $(date +%s) - lock_mtime ))
    if [[ $lock_age -gt $LOCK_STALE_SECONDS ]]; then
      echo "⚠️  stale lock (${lock_age}s old) — a session likely crashed mid-commit. Taking over." >&2
      rmdir "$lock_dir" 2>/dev/null || true
      continue
    fi
  fi
  if [[ $waited -ge $LOCK_WAIT_SECONDS ]]; then
    echo "error: another session is committing right now (lock held ~${lock_age}s). Try again shortly." >&2
    exit 1
  fi
  sleep 1
  waited=$((waited + 1))
done
trap 'rmdir "$lock_dir" 2>/dev/null || true' EXIT

# ─── Stage + review ─────────────────────────────────────────────────────
echo "── working tree status ──────────────────────────"
git status --short
echo "──────────────────────────────────────────────────"

git add -- "${paths[@]}"

# The index is shared across sessions and can hold a stray staged entry left
# by another one (memory: project-shared-tree-commit-race, the "MM" tell). A
# bare `git commit` would sweep that in — so warn if it's there, and commit
# with an explicit pathspec below so it can't ride along either way. Let git
# resolve both pathspecs itself (not string-match args against filenames) so
# a directory/glob arg like `components/foo/` is handled correctly.
foreign=$(comm -23 \
  <(git diff --cached --name-only | sort) \
  <(git diff --cached --name-only -- "${paths[@]}" | sort))
if [[ -n "$foreign" ]]; then
  echo "⚠️  index also has staged entries you didn't name (likely another session's):" >&2
  echo "$foreign" | sed 's/^/    /' >&2
  echo "   Not committing them — this commit is pathspec-limited to your paths." >&2
fi

echo "── staged for this commit ───────────────────────"
git diff --cached --stat -- "${paths[@]}"
echo "──────────────────────────────────────────────────"

# ─── DB-lock check ──────────────────────────────────────────────────────
# Only relevant when this commit itself touches an exclusive path — see
# slice.config.ts's exclusiveLockPaths, scripts/db-lock-check.sh and
# docs/adr/0001-parallel-slice-sessions.md.
# This is the merge-time half of the same check slice-session.sh runs at
# launch; running it again here — already holding this script's own commit
# lock above — is what actually closes the race, since two commits can never
# reach this point at the same time regardless of what the launch-time check
# saw. NOTE: source by a path relative to repo root, not `dirname "$0"` —
# we already `cd`'d to repo root above, so re-deriving from $0 here would
# resolve relative to the NEW cwd instead of the ORIGINAL invocation dir.
#
# Two pathspecs can't be ANDed by git, so the exclusive paths are matched as a
# regex over the file list this commit is actually staging, rather than by
# asking git a second question. Each is anchored and followed by `/` or
# end-of-string, so an entry may name a directory OR a single file.
if [[ ${#SLICE_EXCLUSIVE_LOCK_PATHS[@]} -gt 0 ]]; then
  lock_re=""
  for lock_path in "${SLICE_EXCLUSIVE_LOCK_PATHS[@]}"; do
    lock_path="${lock_path%/}"
    # A literal `.` in a configured path would otherwise match any character
    # and over-trigger the lock — a false hold, which is the safe direction,
    # but confusing enough to be worth not doing.
    lock_path="$(printf '%s' "$lock_path" | sed 's/[].[^$*\\]/\\&/g')"
    lock_re="${lock_re}${lock_re:+|}^${lock_path}"'(/|$)'
  done

  if git diff --cached --name-only -- "${paths[@]}" | grep -qE "$lock_re"; then
    source "scripts/db-lock-check.sh"
    this_branch=$(git rev-parse --abbrev-ref HEAD)
    holder=$(db_lock_holder "$this_branch") || true
    if [[ -n "$holder" ]]; then
      echo "error: this commit touches ${SLICE_EXCLUSIVE_LOCK_PATHS[*]}, but the lock is held by $holder." >&2
      echo "       only one worktree may touch those paths at a time — let that one merge first." >&2
      git reset -- "${paths[@]}" >/dev/null
      exit 1
    fi
  fi
fi

if ! $auto_yes; then
  if [[ ! -t 0 ]]; then
    echo "error: non-interactive and -y not passed — refusing to guess. Pass -y to confirm." >&2
    exit 1
  fi
  read -r -p "Commit the ${#paths[@]} path(s) above? [y/N] " reply
  [[ "$reply" =~ ^[Yy]$ ]] || { echo "Aborted — nothing committed."; exit 1; }
fi

git commit -m "$message" -- "${paths[@]}"
echo "✓ committed: $(git log -1 --format='%h %s')"

# ─── Optional push ──────────────────────────────────────────────────────
if $do_push; then
  branch=$(git rev-parse --abbrev-ref HEAD)
  git fetch origin "$branch" 2>/dev/null || true
  if git rev-parse --verify -q "origin/$branch" >/dev/null; then
    if git merge-base --is-ancestor "origin/$branch" HEAD; then
      git push origin "HEAD:$branch"
    else
      echo "error: origin/$branch has commits you don't have — pull/rebase before pushing." >&2
      exit 1
    fi
  else
    git push -u origin "HEAD:$branch"
  fi
  echo "✓ pushed to origin/$branch"
fi
