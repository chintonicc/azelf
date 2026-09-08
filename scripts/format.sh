#!/usr/bin/env bash
#
# Format and lint-fix only what YOU changed, not the whole tree.
#
#   ./scripts/format.sh                      # files changed vs HEAD
#   ./scripts/format.sh lib/foo.ts app/bar.tsx   # exactly these
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
cd "$(cd "$(dirname "$_slice_common")" && pwd -P)"

# macOS ships bash 3.2, so: no `mapfile`, and no bare "${arr[@]}" on a
# possibly-empty array under `set -u` — both are bash-4-isms that would fail
# here only at runtime, and only sometimes.
existing=()

add_if_present() {
  # A path git reports can be gone (deleted, or renamed away); handing biome a
  # missing file is an error, not a no-op.
  [ -e "$1" ] && existing[${#existing[@]}]="$1"
  return 0
}

if [ $# -gt 0 ]; then
  for f in "$@"; do add_if_present "$f"; done
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
  echo "nothing to format — no changed files."
  exit 0
fi

echo "▶ biome check --apply on ${#existing[@]} file(s)"
# --no-errors-on-unmatched: the list carries .json, .md, .sql and images that
# biome has no handler for, and an unmatched path is not a failure here.
bunx biome check --no-errors-on-unmatched --apply "${existing[@]}"
