#!/usr/bin/env bash
#
# Shell half of the slice config. Sourced (not executed), after cd-ing to a
# checkout root — the same contract db-lock-check.sh documents.
#
#   cd "$repo_root"
#   source "scripts/slice-config.sh"
#   slice_is_ticket_id "$1" || usage         # by the tracker's own idPattern
#   branch="$(slice_branch_for 42)"          # → ticket/42
#   wt="$(slice_worktree_for 42)"            # → /…/consumer-a-ticket-42
#   n="$(slice_ticket_from_branch "$branch")" # → 42, or non-zero if it doesn't parse
#   slice_ref 42                             # → #42 (or ENG-42 — the tracker's refTemplate)
#
#   slice_tracker_get 42            # → state<TAB>ready<TAB>title, one line
#   slice_tracker_open_blockers 42  # → 0
#   slice_tracker_brief 42          # → the .slice-ticket.md text
#   slice_tracker_close 42 "why"    # closes it; non-zero with the reason on stderr
#
# Exports, from slice.config.ts via scripts/slice-config.ts:
#   SLICE_REPO_ROOT SLICE_REPO_NAME SLICE_BASE_BRANCH SLICE_BRANCH_PATTERN
#   SLICE_WORKTREE_DIR SLICE_READY_LABEL SLICE_START_PROMPT
#   SLICE_TRACKER_NAME SLICE_TICKET_ID_PATTERN SLICE_TICKET_REF_TEMPLATE
#   SLICE_LAUNCHER_NAME SLICE_LAUNCHER_STARTS
#   SLICE_EXCLUSIVE_LOCK_PATHS[] SLICE_PROVISION_COPY[]
#
# The tracker's METHODS are not exported — they are functions, like the gates.
# The four slice_tracker_* helpers each spawn bun once and ask the loader to
# call the tracker (`--tracker <verb>`); see scripts/slice-config.ts for what
# that costs and why bash does not talk to gh itself any more.
#
# The launcher is likewise functions, and the shell never launches anything.
# What it carries is SLICE_LAUNCHER_STARTS — `marker` when sessions start via
# the autostart hook (Warp), `command` when the launch carries the command
# (tmux, or a pasted line) — because slice-session.sh parks its flags in
# .slice-flags only for the hook, which passes the ticket id and nothing else.
#
# WHY THIS EXISTS
# ---------------
# There is one source of truth (slice.config.ts) and it is TypeScript, so the
# shell scripts cannot read it directly. Rather than keep a second copy of six
# values in shell — which drifts, silently, into "no local branch 'slices/9' —
# was it ever created?" — this asks the loader for them and evals the answer.
#
# Sourcing is idempotent: db-lock-check.sh is itself sourced by two scripts that
# have usually loaded this already, and re-running bun for every one of them
# would triple the cost of a commit.
#
# NAMING: every variable here is SLICE_-prefixed, and none is called `path` or
# `status`. Both are special in zsh — `path` is tied to $PATH and `status` is
# read-only — and db-lock-check.sh, which this file is sourced alongside, has
# been bitten by each of them once already. See its header.

# Where the azelf package is, resolved from THIS file rather than from the
# caller. A consumer repo reaches this script through a one-line shim in its own
# `scripts/`, so `$0` is the shim and `$PWD` is the consumer's checkout root —
# only `BASH_SOURCE` names the package itself.
#
# Every caller is bash (`#!/usr/bin/env bash`, all six of them), which is what
# makes `BASH_SOURCE` safe to rely on here; `$0` is the fallback for the case
# where this is executed rather than sourced. Do NOT reach for zsh's `${(%):-%x}`
# as a third branch: bash cannot even parse that substitution, so adding it to
# support an interactive zsh would break the six real callers instead.
if [ -z "${SLICE_AZELF_DIR:-}" ]; then
  SLICE_AZELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")/.." && pwd -P)"
fi

if [ -z "${SLICE_CONFIG_LOADED:-}" ]; then
  if ! command -v bun >/dev/null 2>&1; then
    echo "error: 'bun' is not on PATH, and the slice config is read through it." >&2
    echo "       see scripts/slice-config.ts for why that dependency exists." >&2
    return 1
  fi

  # Captured first, then eval'd: `eval "$(cmd)"` swallows a failing cmd whole —
  # eval of an empty string succeeds — and the result would be a script running
  # on with every SLICE_ variable unset. Under `set -u` that surfaces somewhere
  # far from the cause; without it, worse, as an empty branch name.
  _slice_cfg_out=$(bun "$SLICE_AZELF_DIR/scripts/slice-config.ts" --sh) || {
    echo "error: could not read slice.config.ts:" >&2
    echo "$_slice_cfg_out" >&2
    return 1
  }
  eval "$_slice_cfg_out"
  unset _slice_cfg_out
  SLICE_CONFIG_LOADED=1
fi

# Is this a ticket id? Decided by the tracker (`^[0-9]+$` on GitHub, `ENG-123`
# shapes elsewhere), never by a literal here: the same pattern guards argv in
# the dispatcher and the branch round trip below, so an id is either accepted
# everywhere or refused everywhere.
#
# The right-hand side is deliberately UNQUOTED: quoted, bash 3.2 matches it as
# a literal string. And it is a variable rather than a literal because the
# loader has already checked the pattern is POSIX ERE — no `\d`, no `(?:` —
# which is what makes handing it to `=~` safe on macOS.
slice_is_ticket_id() {
  [[ "$1" =~ $SLICE_TICKET_ID_PATTERN ]]
}

# `#{n}` + 42 → `#42`. How a ticket is written for humans, per the tracker.
slice_ref() {
  local _tpl="$SLICE_TICKET_REF_TEMPLATE"
  printf '%s\n' "${_tpl//\{n\}/$1}"
}

# `ticket/{n}` + 42 → `ticket/42`.
slice_branch_for() {
  local _tpl="$SLICE_BRANCH_PATTERN"
  printf '%s\n' "${_tpl//\{n\}/$1}"
}

# The inverse, and the reason branchPattern is constrained to one `{n}`.
# Returns non-zero (printing nothing) when the branch isn't a slice branch —
# callers use that to say "you are not in a slice worktree".
slice_ticket_from_branch() {
  local _branch="$1" _pre _suf _mid
  _pre="${SLICE_BRANCH_PATTERN%%\{n\}*}"
  _suf="${SLICE_BRANCH_PATTERN##*\{n\}}"

  case "$_branch" in
    "$_pre"*"$_suf") ;;
    *) return 1 ;;
  esac

  _mid="${_branch#"$_pre"}"
  _mid="${_mid%"$_suf"}"
  # Whatever sits between prefix and suffix must be a whole id by the tracker's
  # definition — `ticket/` alone, or `ticket/42/extra`, is not a slice branch.
  slice_is_ticket_id "$_mid" || return 1
  printf '%s\n' "$_mid"
}

# ─── the tracker, one bun spawn per call ──────────────────────────────────
# The LOADER is the package's copy; the CONFIG it reads is found by walking up
# from the working directory, so a worktree's own slice.config.ts is still the
# one consulted — the contract is "sourced after cd-ing to a checkout root".
# That split is the whole point of the extraction: one implementation, one
# config per consumer. On failure the loader prints why on stderr and nothing on
# stdout, so a `$(…)` capture is empty rather than half an answer.

slice_tracker_get() {
  bun "$SLICE_AZELF_DIR/scripts/slice-config.ts" --tracker get "$1"
}

slice_tracker_open_blockers() {
  bun "$SLICE_AZELF_DIR/scripts/slice-config.ts" --tracker open-blockers "$1"
}

slice_tracker_brief() {
  bun "$SLICE_AZELF_DIR/scripts/slice-config.ts" --tracker brief "$1"
}

slice_tracker_close() {
  bun "$SLICE_AZELF_DIR/scripts/slice-config.ts" --tracker close "$1" "$2"
}

# Absolute worktree location for a ticket, resolved against the MAIN checkout.
# `pwd -P` to match git's own canonicalized worktree paths, which
# `git worktree list --porcelain` always prints resolved.
slice_worktree_for() {
  local _rel="$SLICE_WORKTREE_DIR" _parent _leaf
  _rel="${_rel//\{repo\}/$SLICE_REPO_NAME}"
  _rel="${_rel//\{n\}/$1}"
  case "$_rel" in
    /*) printf '%s\n' "$_rel" ;;
    *)
      _parent="$(dirname "$_rel")"
      _leaf="$(basename "$_rel")"
      printf '%s\n' "$(cd "$SLICE_REPO_ROOT/$_parent" && pwd -P)/$_leaf"
      ;;
  esac
}
