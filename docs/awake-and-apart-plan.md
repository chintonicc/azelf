# A stopped run says its last word, the Mac stays awake, a quiet session is seen, and each slice has its own ports

**Status:** complete · Phase 1 landed 2026-10-30 (9793135), Phase 2 (cde06cc), Phase 3 built 2026-10-30
**Written:** 2026-10-30
**Companion:** the "Still open" list of `docs/findable-and-finished-plan.md`, and the
consumer-b friction entries it pointed at: 2026-10-25 Frontend #95 (a session that died
when the Mac slept, shown as "running" for 1.5 hours) and the port entries of 2026-10-22
(#99, #101, #102, #110, #66: parallel sessions picking the same mock ports).

Written so it can be picked up cold. Tick the boxes as they land and add the commit hash
after the heading. Line numbers are as of `dbc5238`.

## What happened

1. **A run stopped with Ctrl-C or `kill` printed no ending.** The parked, held and
   "waiting for you" blocks, the resume command and the plan review are top-level code
   after the loop (`slice-run.ts:6331` on). No signal is handled, so SIGINT and SIGTERM
   end the process where it is. The `exit` handler that releases ticket claims
   (`:4950`) does not run on a default-handled signal either: a killed run left its
   claims on the tracker.
2. **The old-git path of the conflict check is unexercised.** `conflictBetween`
   (`:5121`) falls back to file names when git has no `merge-tree --write-tree`
   (before 2.38). Every machine that ran the suite has a newer git.
3. **The Mac slept under a run** (2026-10-25, twice). The session ended on "API Error:
   Your computer went to sleep mid-response" and sat at its prompt with 30 files of
   uncommitted work; the round line said "1 running" for 1.5 hours. The consumer's own
   workaround was `caffeinate -is -w <dispatcher pid>`.
4. **A dead session and a working one look the same** (same entry). `occupied()`
   (`:1348`) is "its shell is alive", and an agent at its prompt keeps its shell alive.
   The finished marker of the last plan covers a session that says it is done; one that
   stopped without saying anything is still "running".
5. **Parallel sessions took the same ports** (five slice entries). The start prompt
   said "take your own ports"; two sessions picked 8846/8847 at once, one tested against
   the other's server and got a wrong answer with no error, and one `pkill -f` killed
   the other's mock. The suggestion each time: azelf hands each slice a block.
6. **The npm name `azelf`** is held by an unrelated package since 2023-01-07 (an image
   downloader). It cannot be reserved; `@chintonicc/azelf` is not on npm at all. The
   launcher of the last plan is what keeps the name out of every command.

## Decisions

- **A signal stops the loop, not the process.** The first SIGINT or SIGTERM ends the
  round's sleep and leaves through the normal ending; a second one exits at once. A
  round in the middle of a land is not interrupted by the handler (the land is
  synchronous), so the stop is seen when the land returns. Exit 130 / 143, the shell's
  numbers, after the ending has printed.
- **`caffeinate -is -w <pid>` for the life of the run, macOS only, on by default.**
  `keepAwake: false` in `slice.config.ts` turns it off. `-s` holds only on mains power,
  and a closed lid sleeps anyway: said in the README, not worked around.
- **"Quiet", not "stalled".** A session is quiet when nothing it could have done is
  newer than `quietAfterMinutes` (default 30, `0` turns it off): no changed file in its
  worktree, no commit, nothing written to its agent transcript when one can be found.
  Quiet is counted apart from running and said once per stretch of quiet, with "look at
  its tab". azelf does not type into the tab: a session that is thinking for 31 minutes
  is told nothing it did not ask for.
- **Ports are opt-in** (`ports: { from, size }`), because most repos start no servers
  and a block they never use is noise in every prompt. A slice keeps its block for the
  life of its worktree (`.slice-ports`), takes the lowest block no other worktree of
  this repo holds and no process is listening in, and gets it as `SLICE_PORT_BASE` /
  `SLICE_PORT_COUNT` in its environment and as one sentence in its start prompt. Two
  repos on one machine give themselves different `from`s.

## Phase 1 — a stopped run says its last word

- [x] 1a. `slice-run.ts`: SIGINT/SIGTERM handlers. First signal: say "stopping after
  this round", wake the sleep, break before anything is launched; the ending prints as
  for any stop, with the resume command. Second signal: `process.exit`.
- [x] 1b. The exit code is the signal's (130/143), set after the ending, over whatever
  the ending set.
- [x] 1c. Tests: SIGTERM mid-run prints "── waiting for you" and the resume command and
  exits 143; a fake `git` on PATH that refuses `merge-tree --write-tree` gives the "this
  git cannot say" note once and the file-name block.

### What building it found

- **A handler swallows Ctrl-C at a question.** `prompt()` reads stdin synchronously, so
  with a SIGINT listener installed Ctrl-C at `proceed? [y/N]` did nothing until Enter
  (tried under a pty). `ask()` takes the listeners off for the question, which gives the
  signal its default back. Removing them in bun restores the default; checked the same
  way.
- **Watched from the first round only.** Before it nothing has started, and a Ctrl-C
  while the plan is read should end the process as it always did.
- **A child that died of SIGINT is the stop, noted synchronously.** The handler runs
  only when the round yields; the rest of the round must not open a tab first. `run()`
  notes `proc.signal`, and the round breaks after the land, before launching.
- **The claims comment was the old reason for no handler** (`claimTickets`): "one would
  hold Ctrl-C back for as long as a gate takes". Ctrl-C reaches the gate too, so it does
  not; a `kill` of the dispatcher alone does wait for it, and the README says so.
- **The README for all three phases goes in with Phase 3**, as one text.

## Phase 2 — the Mac stays awake, and a quiet session is seen

- [x] 2a. `keepAwake?: boolean` in the config; at the start of a watching run on darwin
  with `/usr/bin/caffeinate` present, `caffeinate -is -w <pid>`, said once. Not for
  `--once`.
- [x] 2b. `quietAfterMinutes?: number`; `lastActivity(n)`: newest of the worktree's
  changed and untracked files, the head commit, `.slice-live`, and the Claude Code
  transcript directory (`$CLAUDE_CONFIG_DIR` or `~/.claude`, `projects/<path with
  non-alphanumerics as ->`, as given or as its real path).
- [x] 2c. The round line counts "N quiet" apart from running; `[round N] #id has been
  quiet for 42 min …` once per stretch (keyed by the last sign of work); the ending lists
  them under `── quiet`.
- [x] 2d. Tests: an old worktree with a live fake session is quiet and said once; a new
  file makes it running again; a fresh transcript keeps it running and an old one is
  named; `quietAfterMinutes: 0` never says it; caffeinate runs with the dispatcher's pid
  and is gone after it (macOS only); the fixture sets `keepAwake: false` by default.

### What building it found

- **`.slice-live` is a sign of work.** A relaunched session in an old worktree has
  written nothing yet; without the marker's mtime it would be quiet the round it came
  up. The tests backdate it with the rest.
- **`git status --porcelain` is not used**: `run()` trims its output, and the first
  entry's leading space (` M a.txt`) would go with it. `git diff --name-only HEAD` and
  `git ls-files --others --exclude-standard` give bare paths.
- **A slice waiting on the DB lock, one that said its turn is over, and one marked done
  are not quiet**: each is counted elsewhere already.

## Phase 3 — each slice has its own ports

- [x] 3a. `ports?: { from: number; size?: number }` (size 10), validated (whole numbers,
  `from` ≥ 1024, the first block ending by 65535), bridged as `SLICE_PORTS_FROM` /
  `SLICE_PORTS_SIZE`.
- [x] 3b. `slice-session.sh`: reuse `.slice-ports` unless another worktree holds it,
  else the lowest block no other worktree holds and no port of which is listening
  (`lsof -iTCP -sTCP:LISTEN`); export the two vars; add the sentence to the start prompt
  (own ports, stop only your own PIDs, never `pkill -f`). The file only where git
  ignores it; otherwise the vars and the sentence without it.
- [x] 3c. `.slice-ports` in `EXCLUDE_BLOCK` (fourteen patterns); a paragraph in the
  skill's "Build it"; README "Ports per slice" and the config table.
- [x] 3d. The non-auto start prompt names `slice-finished.sh`.
- [x] 3e. Tests (`slicePorts.test.ts`): two worktrees get two blocks and the prompt
  says the range; a relaunch keeps its block with its own server listening in it,
  another slice skips held and listening blocks; no `ports` → no var, no sentence, no
  file; a block past 65535 is refused by the config.

### What building it found

- **bash 3.2 reads `$port_base–` as a longer name.** The en dash is UTF-8, and its first
  byte was taken into the identifier: "port_base\xe2: unbound variable" under `set -u`.
  `${port_base}–`.
- **`lsof` exits 1 when nothing listens**, which under `pipefail` ends the prep. `||
  true` inside the pipe.
- **A kept block is exempt from the listening check**: the servers in it are most
  likely the slice's own, from before the relaunch.

## Order and cost

Phase 1 is small and stands alone. Phase 2 is one file plus the config. Phase 3 is the
shell half and init. One commit each.

## Not in this plan

- **Typing "go on" into a quiet session's tab.** Rejected above.
- **Publishing `@chintonicc/azelf` to npm.** Outside this repo, and outward-facing; the
  GitHub dependency works and the launcher does not need the registry.
- **Still open from 2026-10-22:** a command allowlist for the resolver; `reviewReadDirs`;
  `azelf adopt <ticket> <ref>`; `--watch-labels`; `regenerate` and `refresh` steps after a
  rebase; a venv-against-requirements check in the install step.

## What the consumer does itself

- consumer-b: pull azelf-run, `azelf init` in both clones, add `/.slice-ports`-style
  entries if init's block is not used, and give each clone's config a `ports` block with
  its own `from`. The start prompts' "take your own ports" sentence can go.
- consumer-a: bump the pin and run `azelf init`.
