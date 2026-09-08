#!/usr/bin/env bash
#
# Mark THIS slice finished, from inside its own worktree.
#
#   ./scripts/slice-done.sh
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

# Refuse on a dirty tree. A marker written over uncommitted work would land a
# branch that doesn't contain it, and the work would sit in a worktree that
# slice-land.sh then removes.
if [[ -n "$(git status --porcelain)" ]]; then
  echo "error: uncommitted changes in this worktree — nothing would land them." >&2
  echo "       commit first: ./scripts/session-commit.sh -m \"...\" <paths>" >&2
  echo >&2
  git status --short >&2
  exit 1
fi

if [[ -z "$(git log --oneline "$SLICE_BASE_BRANCH..HEAD")" ]]; then
  echo "error: $branch has no commits $SLICE_BASE_BRANCH doesn't already have — nothing to land." >&2
  exit 1
fi

touch "$worktree_root/.slice-ready-to-land"

echo "✓ $(slice_ref "$ticket") marked done ($(git log --oneline "$SLICE_BASE_BRANCH..HEAD" | wc -l | tr -d ' ') commit(s) to land)"
echo
echo "  slice-run.ts will re-run the gates, land it, and close the ticket."
echo "  not running slice-run.ts? land it by hand from the main worktree:"
echo "      ./scripts/slice-land.sh $ticket"
