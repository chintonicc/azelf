#!/usr/bin/env bash
#
# Mark THIS slice finished, from inside its own worktree.
#
#   ./scripts/slice-done.sh
#   ./scripts/slice-done.sh --hand-over "<what a person has to do>"
#
# WHY THIS EXISTS
# ---------------
# Landing has to happen in the main worktree, on master — git won't check out
# master in two places at once. So finishing a slice used to mean leaving the
# session, finding the other window, remembering the ticket number, and
# running slice-land.sh there. Four steps, three of them clerical.
#
# This is the one step that actually needs a human: saying "this is done".
# It writes a marker, and scripts/slice-run.ts picks it up, re-runs the gates
# itself, lands it and closes the ticket — which unblocks the next slice.
#
# WHAT IT DELIBERATELY DOES NOT DO
# --------------------------------
# It does not land anything. The judgement ("the ticket is actually
# implemented") stays here with you; the clerical work goes to the dispatcher.
# That split is the whole point: an agent can leave a branch committed, clean
# and gate-green while the ticket is half-built, and no automated check can
# tell the difference. This marker is you saying it isn't.
#
# If you're not running slice-run.ts, this prints the command to land by hand
# and changes nothing else.

set -euo pipefail

# --hand-over is the other way a slice stops: not done, but stuck on something
# only a person can do (see below). Anything else is refused before a marker
# is written. This script used to ignore its arguments, so a mistyped flag
# marked the slice done, and under --auto that lands it.
handing_over=false
why=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --hand-over)
      handing_over=true
      why="${2:-}"
      if [[ $# -ge 2 ]]; then shift; fi
      shift
      ;;
    *)
      echo "unknown argument: $1" >&2
      echo "usage: ${AZELF_INVOKED_AS:-$0} [--hand-over \"<what a person has to do>\"]" >&2
      exit 64
      ;;
  esac
done
# The reason is the whole message to the person, so an empty one holds nothing.
if $handing_over && [[ -z "${why//[[:space:]]/}" ]]; then
  echo "error: --hand-over needs what a person has to do, and where your work is." >&2
  echo "       it is all they are told: ./scripts/slice-done.sh --hand-over \"sign in to …, then …\"" >&2
  exit 64
fi

worktree_root="$(git rev-parse --show-toplevel)"
branch="$(git rev-parse --abbrev-ref HEAD)"

# A slice worktree is a full checkout, so its own copy of the config is right
# here. cd first: slice-config.sh reads scripts/ relative to the cwd.
cd "$worktree_root"
source "scripts/slice-config.sh"

# The round-trip half of slice_branch_for. This is why branchPattern is
# validated to hold exactly one {n} — a pattern that can be built but not read
# back leaves this script unable to name the ticket it is finishing. What sits
# in the {n} is judged by the tracker's own id pattern, so this works for
# ENG-123 as well as 123 the day the tracker says so.
if ! ticket="$(slice_ticket_from_branch "$branch")"; then
  echo "error: '$branch' is not a slice branch (expected $SLICE_BRANCH_PATTERN)." >&2
  echo "       run this from inside a slice worktree." >&2
  exit 1
fi

# ─── Handing the slice to a person ─────────────────────────────────────────
#
# For what no session can do for itself: a sign-in that needs a browser, a
# confirmation prompt nobody will answer in its tab, a device, a secret. On
# consumer-a one slice hung on a prompt from its database's MCP server, and
# one came up signed out of that server. Both ended their turns, as the skill
# says, and sat idle in their REPLs. The dispatcher waited on a live session
# and said nothing, and a person found each one by reading its tab.
#
# The hold is `azelf hold`'s, taken by the slice on itself, so the run says
# once who and why, and lands, relaunches and removes nothing until `azelf
# release`. "its session" is SESSION_HOLDER in slice-hold.ts: the run's line
# for such a hold also says what follows the release.
#
# .slice-interrupted goes with it, and no ready marker, because the work is
# not done. The dispatcher reads that marker as "stopped before it was done"
# (`autoFinished`), so after the release a session that has ended is started
# again, and its commits are not landed as the ticket. One still open in its
# tab is waited for, because .slice-live stays. A person who finishes the work
# by hand runs this script without the flag, and that ready marker lands it.
# A ready marker from an earlier run of this script goes, or the release
# would land the slice.
#
# Neither refusal below applies. A dirty tree or no commits is what the person
# picks up.
if $handing_over; then
  session_pid="$(head -n 1 "$worktree_root/.slice-live" 2>/dev/null | tr -d '[:space:]' || true)"
  bun "$SLICE_AZELF_DIR/scripts/slice-run.ts" --hold "$ticket" --by "its session" --why "$why"
  printf '%s\n' "$session_pid" >"$worktree_root/.slice-interrupted"
  rm -f "$worktree_root/.slice-ready-to-land"
  echo "  end your turn — a person takes it from here"
  exit 0
fi

# Refuse on a dirty tree. A marker written over uncommitted work would land a
# branch that doesn't contain it, and the work would sit in a worktree that
# slice-land.sh then removes.
if [[ -n "$(git status --porcelain)" ]]; then
  echo "error: uncommitted changes in this worktree — nothing would land them." >&2
  echo "       commit first: ./scripts/session-commit.sh -y -m \"...\" <paths>" >&2
  echo >&2
  git status --short >&2
  exit 1
fi

if [[ -z "$(git log --oneline "$SLICE_BASE_BRANCH..HEAD")" ]]; then
  echo "error: $branch has no commits $SLICE_BASE_BRANCH doesn't already have — nothing to land." >&2
  exit 1
fi

# ─── Handing the worktree back ─────────────────────────────────────────────
#
# Two markers, written in this order on purpose.
#
# .slice-ready-to-land is the one slice-run.ts lands on. .slice-live is the one
# that says "a session is still open in here", and clearing it HERE rather than
# leaving it to slice-session.sh's EXIT trap is the point of this block.
#
# The trap only runs when the agent leaves its REPL, and a finished agent
# routinely does not. On one three-slice --auto wave, none of the three did:
# every slice ran this script, every slice was landed, every worktree was
# removed, and an hour later all three shells were still sitting in a directory
# that no longer existed. The marker whose whole job is "do not delete this
# worktree out from under someone" was present the entire time and stopped
# nothing, because it is in .git/info/exclude and `git worktree remove` reads
# an ignored file as no reason to refuse.
#
# Declaring the slice done ends the session's claim on the worktree, whether or
# not the REPL lingers. So the two markers are now mutually exclusive by
# construction, and the dispatcher can free the slot the moment you say done
# instead of waiting on a shell that will never exit.
#
# The PID is carried across rather than dropped: slice-land.sh reads it back to
# warn you by number when it is about to delete the working directory of a
# session that is still running. Empty when this is run outside a slice-session
# tab, which is fine — the warning simply has nothing to report.
live_marker="$worktree_root/.slice-live"
session_pid=""
# An `if`, not `[[ … ]] && session_pid=…`: under `set -e` an and-list whose
# left side is false exits 1 and takes the script with it, and "no marker" is
# the ordinary case when this is run outside a session tab.
if [[ -f "$live_marker" ]]; then
  session_pid="$(head -n 1 "$live_marker" | tr -d '[:space:]')"
fi

# Line 2 is the commit this slice was declared done AT. Landing routinely
# rewrites it: the dispatcher rebases a branch that is behind base before it
# lands, which in any multi-slice wave is every slice after the first, so the
# SHA the agent knows stops being an ancestor of base the moment its work
# lands. Two sessions reasoned "my commit is not on base, so I have not landed"
# from exactly that on 2026-09-23. This is the one moment the pre-rebase head
# is still known, and slice-land.sh carries it into the ticket next to the SHA
# it actually landed as, so there is something true to compare against.
printf '%s\n%s\n' "$session_pid" "$(git rev-parse HEAD)" >"$worktree_root/.slice-ready-to-land"
rm -f "$live_marker"

echo "✓ $(slice_ref "$ticket") marked done ($(git log --oneline "$SLICE_BASE_BRANCH..HEAD" | wc -l | tr -d ' ') commit(s) to land)"
echo
echo "  slice-run.ts will re-run the gates, land it, and close the ticket."
echo "  not running slice-run.ts? land it by hand from the main worktree:"
echo "      ./scripts/slice-land.sh $ticket"
