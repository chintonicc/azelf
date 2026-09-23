# ─── slice autostart v4 ───────────────────────────────────────────────────
# Paste this block into the rc file of the shell your terminal starts —
# ~/.zshrc, or ~/.bashrc / ~/.bash_profile. It is sh syntax on purpose and
# runs unchanged under bash 3.2 and zsh; there is no fish version yet.
#
# Warp's warp://action/new_tab URI opens a tab in the CURRENT window but
# cannot carry a command, so scripts/slice-run.ts leaves a one-shot marker in
# the worktree it just prepped and this picks it up on shell start. Any other
# launcher (tmux, or a pasted command) carries the command itself and never
# writes the marker, so this block sits idle there.
#
# Deliberately narrow: it reads one safe token and nothing else, refuses
# anything outside [A-Za-z0-9._-] (the real ticket-id check is the tracker's,
# in slice-session.sh), runs the slice script OF THE WORKTREE IT IS IN — $PWD
# is always the worktree, which is what makes one block serve every project —
# and deletes the marker BEFORE running so it can never fire twice. A marker
# is a single-use ticket, not a config file.
#
# Delete this block and nothing breaks: slice-run.ts looks for it in your rc
# file before choosing the tab path and falls back to a Warp launch
# configuration, which opens a new window instead.
#
# EXIT 86 CLOSES THIS TAB. slice-session.sh returns it only when the session ran
# under --self-land (so --auto, where nobody is watching the tab) AND the agent
# exited cleanly — or was ended by the land after its worktree was removed,
# which is how a session that sat at its REPL closes. Every other status leaves
# you at a prompt with the output still on screen — a session a human is
# reading, and a session that crashed, are the two cases where the tab is the
# point. `exit` here ends the shell the terminal started, which is what the
# terminal closes the tab on.
#
# UNDER WARP, NOT BEFORE ITS BOOTSTRAP (v4). Warp sets a shell up in two
# steps: the rc file runs, then Warp feeds the shell its bootstrap script as
# the first input, which sets WARP_BOOTSTRAPPED. v3 ran the whole session
# here, inside the rc file — so the exit on 86 came before the bootstrap, and
# Warp read it as a shell that died starting up: "Shell process exited
# prematurely!", tab kept, the bootstrap script dumped as raw text above it.
# So under Warp (zsh) the marker is still read and deleted NOW, but the
# session starts from a one-shot precmd hook at the first prompt after the
# bootstrap; an exit from there is an ordinary one and the tab closes. Seen
# in Warp's own log as "Shell is bootstrapped" then "storing data for closed
# tab", and a session started this way takes typed input. Other terminals,
# and bash, still start it here.
case "$-" in *i*)
  if [ -f "$PWD/.slice-autostart" ]; then
    _slice_n=$(cat "$PWD/.slice-autostart")
    rm -f "$PWD/.slice-autostart"
    _slice_dir=$PWD
    if [ ! -x "$_slice_dir/scripts/slice-session.sh" ]; then
      echo "slice autostart: marker found but no scripts/slice-session.sh in $PWD" >&2
      unset _slice_n _slice_dir
    else
      case "$_slice_n" in
        "" | *[!A-Za-z0-9._-]*)
          echo "slice autostart: ignoring malformed .slice-autostart marker" >&2
          unset _slice_n _slice_dir
          ;;
      esac
    fi
  fi
  if [ -n "${_slice_n:-}" ]; then
    _slice_autostart_run() {
      [ -n "${_slice_n:-}" ] || return 0
      if [ -n "${ZSH_VERSION:-}" ] && [ "${TERM_PROGRAM:-}" = "WarpTerminal" ] &&
        [ -z "${WARP_BOOTSTRAPPED:-}" ]; then
        return 0
      fi
      _slice_run_n=$_slice_n
      unset _slice_n
      "$_slice_dir/scripts/slice-session.sh" "$_slice_run_n"
      _slice_rc=$?
      unset _slice_run_n _slice_dir
      if [ "$_slice_rc" -eq 86 ]; then
        unset _slice_rc
        exit 0
      fi
      unset _slice_rc
    }
    if [ -n "${ZSH_VERSION:-}" ] && [ "${TERM_PROGRAM:-}" = "WarpTerminal" ]; then
      eval 'precmd_functions+=(_slice_autostart_run)'
    else
      _slice_autostart_run
    fi
  fi
  ;;
esac
# ─── end slice autostart ──────────────────────────────────────────────────
#
# THE VERSION IN THE FIRST LINE IS LOAD-BEARING. `azelf init` finds an installed
# block by its delimiters and decides whether to replace it by comparing that
# number. Without it init could see that SOME block was installed but not
# whether it was this one — both old and new contain `.slice-autostart` — and an
# upgrade would either duplicate the block or silently leave a stale one in
# place. That was an open question at the end of Phase 4; this line closes it.
# Bump it whenever the block above changes behaviour.
