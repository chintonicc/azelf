#!/usr/bin/env bash
#
# Say that THIS session's turn is over, from inside its own worktree, with the
# report a person would otherwise have to read in its tab.
#
#   ./scripts/slice-finished.sh -m "<report>"
#   ./scripts/slice-finished.sh -F report.md
#   ./scripts/slice-finished.sh -F - <<'EOF'        # the report from stdin
#   …
#   EOF
#   ./scripts/slice-finished.sh --stuck -m "<what is in the way, and where the work is>"
#
# WHY THIS EXISTS
# ---------------
# Without --auto a session finishes, says so in its tab, and stops at its
# prompt. Its shell is alive and .slice-live names it, so the dispatcher
# counted it as running: on consumer-b three sessions were done inside ten
# minutes, one commit each, and the run said "3 running" for hours. The
# person decided they were finished from commit times and the quiet of the
# worktree. The report each had written was in its tab and nowhere else; a
# supervising session could not read it, and the person copied it out by
# hand.
#
# WHAT IT DELIBERATELY DOES NOT DO
# --------------------------------
# It lands nothing and releases nothing. slice-done.sh is the act that lands:
# a running dispatcher rebases, gates and pushes on it, which on a repo whose
# base branch deploys is the deploy, and it stays a person's. This marker says
# "my turn is over, here is what I did". The dispatcher counts the slice as
# waiting for you rather than running, names the report, and the session
# stays open for a person to tell it to go on. A commit after this makes the
# marker stale on its own: the session went on, and the slice is running
# again.
#
# --stuck is the other ending: the gates will not go green, or the DB lock is
# held, or something only a person can do is in the way and it is not worth a
# hold. Same marker, said as stuck, and the dispatcher's line says so. A stuck
# worktree may be dirty; a finished one may not, for the same reason
# slice-done.sh refuses one: a person reading "finished" over uncommitted work
# would land a branch that does not contain it.

set -euo pipefail

usage() {
  echo "usage: ${AZELF_INVOKED_AS:-$0} [--stuck] (-m <report> | -F <file>)" >&2
  echo "       -F - reads the report from stdin" >&2
  exit 64
}

stuck=false
report=""
report_file=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --stuck) stuck=true; shift ;;
    -m|--message) [[ $# -ge 2 ]] || usage; report="$2"; shift 2 ;;
    -F|--file) [[ $# -ge 2 ]] || usage; report_file="$2"; shift 2 ;;
    -h|--help) usage ;;
    *) echo "unknown argument: $1" >&2; usage ;;
  esac
done
if [[ -n "$report" && -n "$report_file" ]]; then
  echo "error: -m and -F are two reports — pass one." >&2
  usage
fi
if [[ -n "$report_file" ]]; then
  if [[ "$report_file" == "-" ]]; then
    report="$(cat)"
  elif [[ -f "$report_file" ]]; then
    report="$(cat "$report_file")"
  else
    echo "error: no such file: $report_file" >&2
    exit 1
  fi
fi
# The report is the whole message to the person, so an empty one holds nothing.
if [[ -z "${report//[[:space:]]/}" ]]; then
  echo "error: the report is empty, and it is all a person is shown." >&2
  echo "       say what you did, what is left and what to look at: -m \"…\", or -F - with a heredoc." >&2
  exit 64
fi

worktree_root="$(git rev-parse --show-toplevel)"
branch="$(git rev-parse --abbrev-ref HEAD)"

# A slice worktree is a full checkout, so its own copy of the config is right
# here. cd first: slice-config.sh reads scripts/ relative to the cwd.
cd "$worktree_root"
source "scripts/slice-config.sh"

if ! ticket="$(slice_ticket_from_branch "$branch")"; then
  echo "error: '$branch' is not a slice branch (expected $SLICE_BRANCH_PATTERN)." >&2
  echo "       run this from inside a slice worktree." >&2
  exit 1
fi

if ! $stuck && [[ -n "$(git status --porcelain)" ]]; then
  echo "error: the worktree has uncommitted changes — a person reading 'finished' would land a branch that does not contain them." >&2
  echo "       commit them (./scripts/session-commit.sh -y -m \"…\" <paths>), or say --stuck if you cannot." >&2
  git status --short >&2
  exit 1
fi

# Line 1 the head this was said at, line 2 the kind, then the report after a
# blank line. The head is what makes the marker go stale by itself: the
# dispatcher reads it against the branch, and a commit after this means the
# session went on.
head="$(git rev-parse HEAD)"
kind=finished
if $stuck; then kind=stuck; fi
{
  printf '%s\n%s\n\n' "$head" "$kind"
  printf '%s\n' "$report"
} >"$worktree_root/.slice-finished"

echo "✓ $(slice_ref "$ticket") $kind at ${head:0:7} — report in .slice-finished"
if $stuck; then
  echo "  the dispatcher says so and waits for a person. End your turn."
else
  echo "  the dispatcher counts this slice as waiting for a person. End your turn."
  echo "  ./scripts/slice-done.sh here is what lands it — a person's call, not yours."
fi
