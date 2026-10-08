#!/usr/bin/env bash
#
# Format and lint-fix only what YOU changed, not the whole tree.
#
#   ./scripts/format.sh                      # files changed vs HEAD
#   ./scripts/format.sh lib/foo.ts app/bar.tsx   # exactly these
#   ./scripts/format.sh --check lib/foo.ts   # say what would change, write nothing
#   ./scripts/format.sh --help
#
# WHY THIS EXISTS
# ---------------
# `bun run format` is `biome check --apply .` — tree-wide and MUTATING. On
# 2026-09-07 it rewrote 891 files while another session was mid-edit in this
# shared working tree, and the seven unexpected modified files that produced
# were nearly reverted as "formatter noise" when they were actually that
# session's in-flight work.
#
# Two distinct harms, both real here:
#   - An editor holding a stale buffer writes it back over the formatter's
#     version. That is exactly how TESTING.md has reverted commits twice
#     (memory: project-testing-md-formatter-mangle).
#   - It muddles attribution: your `git status` fills with changes you did not
#     make, which is the same fog session-commit.sh exists to cut through.
#
# slice-run.ts's gate already knew this — it runs `biome check` on the changed
# file list and never `bun run format`, with a comment saying a gate that edits
# the tree would dirty the worktree it is judging. This is that same reasoning
# applied to the gate a human runs.
#
# NOTE ON package.json: deliberately NOT a package.json script, for the same
# reason as ota-publish.sh — `packageJson:scripts` is an @expo/fingerprint
# source hashed verbatim, so adding or editing an entry bumps the runtime
# version for every profile and strands OTA updates for already-shipped
# builds. Files under scripts/ are not fingerprint sources.
#
# `bun run format` still exists and still formats everything. Reach for it
# deliberately (a real repo-wide sweep), never as the finish-a-task gate.

set -euo pipefail

usage() {
  cat <<EOF
usage: ${AZELF_INVOKED_AS:-$0} [--check] [--] [<path> ...]

Runs biome on what changed, never on the whole tree.

  (no paths)   the files changed vs HEAD, plus untracked ones
  <path> ...   exactly these; a path that neither exists nor is known to git
               is an error, and then nothing is formatted
  --check      write nothing: biome reports what it would change, and the
               exit status is non-zero when anything would
  --           the end of the options, for a path that starts with -
  -h, --help   this text
EOF
}

# Options first, and before anything that needs a repository, so --help works
# anywhere. A slice session asked for --help and got "no such path: --help",
# with no way short of reading this file to learn whether a check-only mode
# existed. Options may sit among the paths; after `--` everything is a path.
# bash 3.2, as below: no bare "${paths[@]}" on an array that may be empty.
check=0
paths=()
ended=0
for arg in "$@"; do
  if [ "$ended" -eq 0 ]; then
    case "$arg" in
      -h|--help) usage; exit 0 ;;
      --check) check=1; continue ;;
      --) ended=1; continue ;;
      -*) echo "unknown option: $arg" >&2; usage >&2; exit 64 ;;
    esac
  fi
  paths[${#paths[@]}]="$arg"
done
set -- ${paths[@]+"${paths[@]}"}
what=format
did=formatted
if [ "$check" -eq 1 ]; then
  what=check
  did=checked
fi

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
# (session-commit.sh's commit lock is the one thing that DOES belong in the
# common dir, and lives there — see the note on it in that script.)
#
# -P to match git's own canonicalized worktree paths, which
# `git worktree list --porcelain` always prints resolved.
_slice_root="$(git rev-parse --show-toplevel 2>/dev/null || true)"
if [[ -z "$_slice_root" ]]; then
  echo "error: not inside a git repository — run this from a checkout." >&2
  exit 1
fi
cd "$(cd "$_slice_root" && pwd -P)"

# macOS ships bash 3.2, so: no `mapfile`, and no bare "${arr[@]}" on a
# possibly-empty array under `set -u` — both are bash-4-isms that would fail
# here only at runtime, and only sometimes.
existing=()

add_if_present() {
  # A path git reports can be gone (deleted, or renamed away); handing biome a
  # missing file is an error, not a no-op. A path that starts with - goes to
  # biome as ./-…, or biome would read it as a flag.
  [ -e "$1" ] || return 0
  case "$1" in
    -*) existing[${#existing[@]}]="./$1" ;;
    *) existing[${#existing[@]}]="$1" ;;
  esac
  return 0
}

# Named paths that are not there. A deletion (HEAD has it, the tree does not)
# is skipped quietly: a changed-file list that contains one is not a mistake.
# A path neither the tree nor HEAD knows is one, and used to end in "nothing
# to format — no changed files" and exit 0. It is the rule session-commit.sh
# applies to its own paths.
deleted=0
missing=()

if [ $# -gt 0 ]; then
  for f in "$@"; do
    if [ -e "$f" ] || [ -L "$f" ]; then
      add_if_present "$f"
    elif [ -n "$(git ls-tree -r --name-only HEAD -- "$f" 2>/dev/null)" ]; then
      deleted=$((deleted + 1))
    else
      missing[${#missing[@]}]="$f"
    fi
  done
  if [ ${#missing[@]} -gt 0 ]; then
    for f in "${missing[@]}"; do
      case "$f" in
        *" "*|*"
"*)
          # What an unsplit "$FILES" looks like: zsh does not word-split it.
          echo "error: no such path: $f (one argument — was a list passed unsplit?)" >&2
          ;;
        *) echo "error: no such path: $f" >&2 ;;
      esac
    done
    echo "       Nothing was $did." >&2
    exit 1
  fi
  if [ ${#existing[@]} -eq 0 ]; then
    echo "nothing to $what — the $deleted named path(s) are deleted."
    exit 0
  fi
else
  # Tracked changes vs HEAD (staged and unstaged) plus untracked files. In a
  # SHARED tree this is still everyone's uncommitted work, not just yours —
  # git cannot attribute authorship. When another session is live, name your
  # paths explicitly, same rule as session-commit.sh.
  while IFS= read -r f; do
    [ -n "$f" ] && add_if_present "$f"
  done < <(
    {
      git diff --name-only HEAD
      git ls-files --others --exclude-standard
    } | sort -u
  )
fi

if [ ${#existing[@]} -eq 0 ]; then
  echo "nothing to $what — no changed files."
  exit 0
fi

# --no-errors-on-unmatched: the list carries .json, .md, .sql and images that
# biome has no handler for, and an unmatched path is not a failure here.
# Under --check, biome's exit status is the answer, and set -e passes it on.
if [ "$check" -eq 1 ]; then
  echo "▶ biome check on ${#existing[@]} file(s) (no changes written)"
  bunx biome check --no-errors-on-unmatched "${existing[@]}"
else
  echo "▶ biome check --apply on ${#existing[@]} file(s)"
  bunx biome check --no-errors-on-unmatched --apply "${existing[@]}"
fi
