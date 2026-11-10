#!/usr/bin/env bash
#
# The landing gates on the worktree you are standing in — what a session runs
# before it declares itself done, so the dispatcher's re-run at the land finds
# nothing new. It is `azelf gates` for a worktree that has the shims and not
# the binary on PATH, which is every slice worktree.
#
#   ./scripts/slice-gates.sh          # the slice this worktree is on
#   ./scripts/slice-gates.sh 42       # a slice by ticket, from any checkout
#   ./scripts/slice-gates.sh --keep-going   # every red gate, not only the first
#
# The verdict is the exit code. No land, no rebase, no tracker call; a gate
# that judges the pushed commit (`ciRuns`) is skipped and said to run at the
# land. It does not wait for the dispatcher's gate lock: a session's own check
# would otherwise sit behind a land's gates, CI included, for nothing it needs.
set -euo pipefail

# The package, from THIS file: a consumer reaches it through a shim in its own
# scripts/, so $0 is the shim and only BASH_SOURCE names the package.
azelf_dir="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")/.." && pwd -P)"

if ! command -v bun >/dev/null 2>&1; then
  echo "error: 'bun' is not on PATH, and the gates are read from slice.config.ts through it." >&2
  exit 1
fi

exec bun "$azelf_dir/scripts/slice-run.ts" --gates --no-lock "$@"
