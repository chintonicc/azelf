#!/usr/bin/env bash
#
# One command at the slice's base, without the slice's changes — what a
# session runs when it needs to know whether a failure is its own. It is
# `azelf on-base` for a worktree that has the shims and not the binary on PATH,
# which is every slice worktree.
#
#   ./scripts/slice-on-base.sh -- bun test          # the slice this worktree is on
#   ./scripts/slice-on-base.sh 42 -- pytest -q      # a slice by ticket, from any checkout
#
# The command runs at the merge base of the slice's branch with the base
# branch, in a throwaway checkout beside the worktree, installed like a prep.
# The checkout is removed afterwards, whatever happened. The exit code is the
# command's, and the base, the command, the exit code and the output's last
# lines go to .slice-baseline in the slice's worktree.
set -euo pipefail

# The package, from THIS file: a consumer reaches it through a shim in its own
# scripts/, so $0 is the shim and only BASH_SOURCE names the package.
azelf_dir="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")/.." && pwd -P)"

if ! command -v bun >/dev/null 2>&1; then
  echo "error: 'bun' is not on PATH, and slice.config.ts is read through it." >&2
  exit 1
fi

exec bun "$azelf_dir/scripts/slice-run.ts" --on-base "$@"
