#!/usr/bin/env bash
#
# Prep an isolated git worktree for one slice of a plan, then hand control to
# an interactive agent session inside it.
#
#   ./scripts/slice-session.sh 123
#
# When the session is done, mark it with scripts/slice-done.sh (or land it by
# hand with scripts/slice-land.sh) — this script only preps and launches, it
# never merges (see docs/adr/0001).
#
# See docs/adr/0001-parallel-slice-sessions.md for the design and the
# alternatives it rejects (mattpocock/sandcastle, sandvault, headless
# orchestration, PR gating).
#
# WHY THIS EXISTS
# ---------------
# Running several vertical slices concurrently, each as its own Claude Code
# session, means several git worktrees can exist side by side. Two things
# this repo has already been burned by make that risky without help: git-tree
# races between concurrent sessions (session-commit.sh handles the commit
# side of that) and concurrent Supabase schema changes against a live
# project with no PITR (db-lock-check.sh, shared with session-commit.sh so
# the identical check runs at launch AND at merge).
#
# This script only does the prep: validate the ticket, refuse to proceed if
# the DB lock is held, create the worktree, provision it, and launch an
# interactive agent session inside it. You drive that
# session and commit with session-commit.sh yourself; once you're done,
# scripts/slice-land.sh fast-forwards the branch onto master and cleans up —
# there is no auto-merge here, by design (see the ADR's "orchestration
# style" decision).
#
# WHAT HAPPENED TO THE SANDBOX
# ---------------------------
# This script used to choose a sandbox tier and write a ~90-line Seatbelt
# profile for @anthropic-ai/sandbox-runtime. It is gone: macOS-only, pinned to
# that tool's 0.0.75 settings schema, tuned to one machine's toolchain layout,
# and documented in its own comments as breaking interactive input — so the
# recommended state was already "off". `wrapCommand` in slice.config.ts is the
# seam that replaced it; supply your own profile.
#
# One finding from that era is worth keeping, because it explains the line
# below that would otherwise look arbitrary. Under Seatbelt, `gh` could not
# work at all: it is a Go binary, Go on macOS verifies TLS through the system
# verifier, and that needs the `trustd` mach service Seatbelt blocks
# (`x509: OSStatus -26276`). Any wrapper that restricts the network is liable
# to break the tracker the same way.
#
# So the FIRST thing a slice needs — its own ticket — is fetched out here,
# before any wrapper is entered, and written to `.slice-ticket.md` in the
# worktree. Without that a slice under a restrictive wrapper opens with a
# hand-paste of the ticket body, which is the whole point of the tooling
# defeated at step one.

set -euo pipefail

prep_only=false
autostart=true
self_land=false
ticket=""

usage() {
  echo "usage: ${AZELF_INVOKED_AS:-$0} <ticket-id> [--no-start] [--prep-only] [--self-land]" >&2
  exit 64
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    # Land at a bare prompt instead of starting work immediately.
    --no-start) autostart=false; shift ;;
    # Build the worktree and stop, without launching a session. Used by
    # slice-run.ts to prep several slices SERIALLY before opening any tabs:
    # concurrent `git worktree add` against one repo contends on ref locks,
    # and three simultaneous `bun install`s are a needless spike. The tab it
    # then opens re-runs this script in full, which is idempotent — the
    # worktree is reused, .env is already there, bun install no-ops warm — so
    # there is still exactly one launch path rather than two that can drift.
    --prep-only) prep_only=true; shift ;;
    # Ask the slice to mark ITSELF done and exit when it finishes. Passed by
    # slice-run.ts only under --auto, because it is the same judgement call
    # --auto already makes: without it, --auto cannot progress unattended at
    # all. A finished agent leaves the REPL open, the .slice-live marker never
    # clears, and the dispatcher waits forever on a session that has nothing
    # left to do. See the ADR for why this is off by default.
    --self-land) self_land=true; shift ;;
    -h|--help) usage ;;
    -*) echo "unknown option: $1" >&2; usage ;;
    *)
      [[ -z "$ticket" ]] || usage
      ticket="$1"
      shift
      ;;
  esac
done

[[ -n "$ticket" ]] || usage

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
repo_root="$(cd "$(dirname "$_slice_common")" && pwd -P)"

# A slice worktree is a full checkout, so THIS SCRIPT exists inside every one
# of them — and running that copy used to derive the repo root from its own
# location, i.e. the worktree. From consumer-a-ticket-9 it computed a worktree
# path of `consumer-a-ticket-9-ticket-9`, missed the reuse check, and tried to add
# a second worktree on a branch already in use:
#
#   fatal: 'ticket/9' is already used by worktree at '…/consumer-a-ticket-9'
#
# Which is precisely what you hit if you re-run a session from inside its own
# tab. Resolve to the MAIN worktree instead of refusing: relaunching from
# inside a slice is a reasonable thing to want, and from there the ordinary
# reuse path does exactly the right thing.
common_dir="$(git -C "$repo_root" rev-parse --path-format=absolute --git-common-dir 2>/dev/null || true)"
if [[ -n "$common_dir" ]]; then
  main_root="$(cd "$(dirname "$common_dir")" && pwd -P)"
  if [[ "$main_root" != "$repo_root" ]]; then
    echo "note: run from inside a slice worktree — using the main worktree at $main_root"
    repo_root="$main_root"
  fi
fi

cd "$repo_root"

# Config first: db-lock-check.sh reads SLICE_EXCLUSIVE_LOCK_PATHS from it.
source "$repo_root/scripts/slice-config.sh"
source "$repo_root/scripts/db-lock-check.sh"

# What a ticket id looks like is the tracker's call (`^[0-9]+$` on GitHub),
# which is why this check waits for the config rather than sitting with the
# other argv checks above. Nothing stateful happened in between.
if ! slice_is_ticket_id "$ticket"; then
  echo "error: '$ticket' is not a $SLICE_TRACKER_NAME ticket id (expected $SLICE_TICKET_ID_PATTERN)." >&2
  exit 64
fi
ticket_ref="$(slice_ref "$ticket")"

# ─── Validate the ticket ────────────────────────────────────────────────
echo "── checking ticket $ticket_ref ─────────────────────"

# Through the tracker bridge, not gh: the loader answers `state<TAB>ready<TAB>
# title`, with `ready` already decided against readyLabel. (That also retires
# the jq program the label used to be interpolated into.) On failure the
# bridge prints why on stderr and nothing on stdout.
issue_tsv=$(slice_tracker_get "$ticket" 2>&1) || {
  echo "error: couldn't fetch $ticket_ref from $SLICE_TRACKER_NAME:" >&2
  echo "$issue_tsv" >&2
  exit 1
}
IFS=$'\t' read -r state has_label title <<<"$issue_tsv"

if [[ "$state" != "open" ]]; then
  echo "error: $ticket_ref is $state, not open." >&2
  exit 1
fi
if [[ "$has_label" != "true" ]]; then
  echo "error: $ticket_ref is missing the '$SLICE_READY_LABEL' label." >&2
  echo "       run /mattpocock-skills:triage or /mattpocock-skills:to-tickets on it first." >&2
  exit 1
fi

# A COUNT, so the numeric guard here is right and stays: the bridge filters
# the blocker list to the still-open ones with the same rule slice-run.ts
# uses (openBlockers in slice-tracker.ts), and this script only ever needs
# how many. Anything but digits means the bridge failed and printed why.
blocked_by=$(slice_tracker_open_blockers "$ticket" 2>&1)
if [[ ! "$blocked_by" =~ ^[0-9]+$ ]]; then
  echo "error: couldn't read the blocker count for $ticket_ref from $SLICE_TRACKER_NAME:" >&2
  echo "$blocked_by" >&2
  exit 1
fi
if [[ "$blocked_by" -gt 0 ]]; then
  echo "error: $ticket_ref still has $blocked_by open blocker(s) — not ready yet." >&2
  exit 1
fi

echo "✓ $ticket_ref \"$title\" is $SLICE_READY_LABEL with no open blockers"

# ─── DB-lock check ──────────────────────────────────────────────────────
branch="$(slice_branch_for "$ticket")"
holder=$(db_lock_holder "$branch") || true
if [[ -n "$holder" ]]; then
  echo "error: DB lock held by $holder." >&2
  echo "       only one worktree may touch ${SLICE_EXCLUSIVE_LOCK_PATHS[*]} at a time — finish and merge that one first." >&2
  exit 1
fi

# ─── Create the worktree ────────────────────────────────────────────────
worktree_path="$(slice_worktree_for "$ticket")"

if git worktree list --porcelain | grep -qx "worktree $worktree_path"; then
  echo "✓ worktree already exists at $worktree_path — reusing it"
elif git show-ref --verify --quiet "refs/heads/$branch"; then
  git worktree add "$worktree_path" "$branch"
  echo "✓ created worktree at $worktree_path on existing local branch $branch"
else
  fetch_err=$(git fetch origin "$SLICE_BASE_BRANCH" 2>&1) || {
    echo "error: couldn't fetch origin/$SLICE_BASE_BRANCH:" >&2
    echo "$fetch_err" >&2
    exit 1
  }
  git fetch origin "$branch" 2>/dev/null || true
  if git show-ref --verify --quiet "refs/remotes/origin/$branch"; then
    git worktree add "$worktree_path" -b "$branch" "origin/$branch"
    echo "✓ created worktree at $worktree_path, resuming previously-pushed branch origin/$branch"
  else
    git worktree add "$worktree_path" -b "$branch" "origin/$SLICE_BASE_BRANCH"
    echo "✓ created worktree at $worktree_path on new branch $branch"
  fi
fi

# ─── Provision ───────────────────────────────────────────────────────────
# git worktree add never populates gitignored files (.env, node_modules) —
# without this the handed-off session can't run bun/expo or reach Supabase.
# WHICH files, and why each one is load-bearing, is in slice.config.ts under
# provisionCopy; this loop only carries them across.
#
# Never overwrites: a worktree that already has one has usually had it edited
# on purpose. Missing sources are skipped silently — a file that isn't in the
# main checkout was not needed.
#
# The count guard is not decoration: macOS ships bash 3.2, where expanding an
# EMPTY array as "${arr[@]}" under `set -u` is an unbound-variable error rather
# than nothing. provisionCopy: [] is a legitimate config.
echo "── provisioning worktree ─────────────────────────"
if [[ ${#SLICE_PROVISION_COPY[@]} -gt 0 ]]; then
  for provision_file in "${SLICE_PROVISION_COPY[@]}"; do
    if [[ -f "$repo_root/$provision_file" && ! -e "$worktree_path/$provision_file" ]]; then
      mkdir -p "$(dirname "$worktree_path/$provision_file")"
      cp "$repo_root/$provision_file" "$worktree_path/$provision_file"
      echo "✓ copied $provision_file"
    fi
  done
fi
if ! (cd "$worktree_path" && bun install); then
  echo "error: 'bun install' failed in the new worktree." >&2
  exit 1
fi
echo "✓ dependencies installed"

# ─── Ticket brief ────────────────────────────────────────────────────────
# Fetched out here, before any wrapCommand is entered, and the reason is in the
# header: a wrapper that restricts the network breaks `gh`, so the session could
# not read the issue it was launched for. Written unconditionally (also when
# there is no wrapper at all, where gh
# would work) so a slice always finds its ticket in the same place and the
# instruction to the agent doesn't have to vary by tier.
#
# Never fatal: a slice whose brief failed to write can still be driven by
# pasting the ticket, which is exactly where we were before this existed.
ticket_file="$worktree_path/.slice-ticket.md"
if brief=$(slice_tracker_brief "$ticket" 2>&1); then
  printf '%s\n' "$brief" >"$ticket_file"
  echo "✓ wrote .slice-ticket.md — the ticket, readable without gh"
else
  echo "warning: couldn't write .slice-ticket.md; paste the ticket by hand:" >&2
  echo "$brief" >&2
fi

# ─── Launch ──────────────────────────────────────────────────────────────
cd "$worktree_path"

# Flags have to survive the trip from the prep run to the launching run, and
# under the Warp launcher they cannot travel as arguments: the tab is opened
# by the autostart hook (scripts/slice-autostart.sh, pasted into the user's
# rc file), which passes the ticket ID and nothing else. So --prep-only parks
# them in the worktree and the launching run picks them back up. Without this
# every flag slice-run.ts passes is silently dropped at the tab boundary —
# which is exactly what happened to the old --sandbox flag, unnoticed only
# because it had been default-off since the finding that killed it.
#
# Only under that launcher, though. The config's launcher declares what its
# launch carries (SLICE_LAUNCHER_STARTS, from the bridge): `marker` means the
# hook starts the session and the flags must be parked; `command` means the
# launch — a tmux window, a pasted line — carries the flags itself, and a
# parked file would be litter that can only ever turn something ON later.
# So a `command` launcher removes any stale file instead of writing one, and
# the read-back below is correct with no file at all.
flags_file="$worktree_path/.slice-flags"

if $prep_only; then
  if [[ "${SLICE_LAUNCHER_STARTS:-command}" == "marker" ]]; then
    # Written as `if` blocks, not `$flag && echo`: under `set -e` a false flag
    # makes the and-list exit 1 and takes the whole script with it.
    : >"$flags_file"
    if $self_land; then echo "--self-land" >>"$flags_file"; fi
    if ! $autostart; then echo "--no-start" >>"$flags_file"; fi
  else
    rm -f "$flags_file"
  fi
  echo "✓ prepped, not launched — worktree ready at $worktree_path"
  echo "  launch it with: ${AZELF_INVOKED_AS:-$0} $ticket"
  exit 0
fi

# Read them back, but only ever to turn something ON: an explicit flag on this
# invocation must not be undone by a stale parked file.
if [[ -f "$flags_file" ]]; then
  while IFS= read -r parked; do
    case "$parked" in
      --self-land) self_land=true ;;
      --no-start) autostart=false ;;
    esac
  done <"$flags_file"
fi

[[ -f "$ticket_file" ]] && echo "   your ticket is in .slice-ticket.md — read it first."

# A liveness marker, so `slice-run.ts --auto` can tell "this session is still
# open" from "this session finished". Without it, --auto would eventually land
# a branch and delete the worktree out from under someone still working in it.
#
# This is why the launch below is no longer `exec`: exec REPLACES this shell,
# and a replaced shell runs no trap, so the marker would never be cleared. The
# cost is one lingering bash frame per session; the gain is that the dangerous
# failure mode of --auto cannot happen.
#
# A hard-killed tab (SIGKILL, force-quitting Warp) skips the trap and strands
# the marker — slice-run.ts reports a slice that looks live but has no session,
# and deleting .slice-live in that worktree clears it.
live_marker="$worktree_path/.slice-live"
: >"$live_marker"
trap 'rm -f "$live_marker"' EXIT

# The opening instruction, so a slice starts working when its tab opens
# instead of waiting to be told the same thing eight times. --no-start gives
# you the bare prompt back.
#
# The text lives in slice.config.ts as startPrompt (with the reasoning about
# how it is phrased), because it names a skill — /mattpocock-skills:implement —
# that another project need not have installed. The self-land clause below is
# tool mechanics rather than project preference, so it stays here.
start_prompt="${SLICE_START_PROMPT//\{n\}/$ticket}"

# Under --self-land the slice closes itself out. Both halves matter: the marker
# is what the dispatcher lands on, and the exit is what clears .slice-live so
# the slot frees. Told to stop rather than mark done if the gates are red,
# because a stranded worktree is cheap and a bad land is not.
if $self_land; then
  start_prompt="$start_prompt When it is finished and the gates are green, run ./scripts/slice-done.sh and then exit — nobody is watching this tab. If the gates will not go green, leave the worktree as it is, do NOT run slice-done.sh, and exit."
fi

# The configured agent's argv prefix, from slice.config.ts through the bridge.
# Defaulted here as well as in the loader so that a shell sourced against an
# older config — or a bridge that has not been regenerated — starts a session
# instead of failing with an unbound variable under `set -u`.
if [[ ${#SLICE_AGENT_SESSION_CMD[@]} -eq 0 ]]; then
  echo "error: slice.config.ts's agent has an empty sessionCommand." >&2
  exit 1
fi

launch() {
  if $autostart; then "$@" "$start_prompt"; else "$@"; fi
}

# `<wrap…> <agent…> "<prompt>"`. wrapCommand is empty by default, in which case
# this is exactly the agent's own command — the array expansion below collapses
# to nothing, which is why it is written as one launch path and not two.
#
# `"${arr[@]}"` on an EMPTY array is an unbound-variable error under `set -u` on
# bash 3.2, which macOS still ships. Both arrays are therefore expanded through
# the `${arr[@]+"${arr[@]}"}` form rather than guarded with an `if`.
if [[ ${#SLICE_WRAP_COMMAND[@]} -gt 0 ]]; then
  echo "── launching via wrapCommand: ${SLICE_WRAP_COMMAND[*]} ─────────────"
  echo "   note: a wrapper that restricts the network is liable to break 'gh'."
  echo "   Your ticket is already in .slice-ticket.md, so the session does not need it."
else
  echo "── launching $SLICE_AGENT_NAME ─────────────────────────────────────"
fi
launch ${SLICE_WRAP_COMMAND[@]+"${SLICE_WRAP_COMMAND[@]}"} \
  "${SLICE_AGENT_SESSION_CMD[@]}"
