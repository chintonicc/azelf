# What consumer-a's 2026-09-23 friction log still has open

**Status:** COMPLETE: Phase 1 LANDED 2026-09-24, Phases 2–3 LANDED 2026-09-25 · **Written:** 2026-09-24
**Companion:** consumer-a's friction log (an untracked file in its main checkout, not in
this repo), `docs/wave-friction-plan.md` (the part of the same log that has landed).

Written so it can be picked up cold. Each item says what to change, where, why, and what
proves it. Tick the boxes as they land and add the commit hash after the heading. Line
numbers are as of `6383445`; search for things by name once a phase has moved them.

## What happened

The wave-friction plan fixed the problems that cost a human every wave. Thirteen entries
were left. They were ranked on 2026-09-24 by what they cost when they happen, and eleven
are in this plan.

1. **A crash left the wave unable to recover.** A prep failed with `ENOSPC`. The
   dispatcher retried it every round, and each retry left another partial worktree
   (one was 2.4 GB) until the machine restarted with four sessions open. After that,
   every `.slice-live` still said its session was running, so the dispatcher would never
   relaunch them. Once the markers were cleared by hand, a slice with one commit and
   five uncommitted files counted as finished under `--auto`. The land refused it for a
   dirty tree, with a reason that blamed someone for working after marking it done, and
   it parked where no session is ever relaunched.
2. **The dispatcher can undo a hand fix.** Its pre-gate rebase does not check for a
   rebase already in progress. If the base moved after someone started rebasing a slice
   by hand, the dispatcher's `git rebase` fails, and its cleanup `git rebase --abort`
   aborts the person's rebase and throws their resolution away. This was reproduced in a
   scratch repo on 2026-09-24. It is the only open item that can destroy work.
3. **Two things that have not broken anything yet.** Bumping azelf in the main checkout
   during a wave leaves the running dispatcher on the old version while its slices run
   the new scripts, and nothing says so. And every headless resolver and reviewer run
   starts all of the consumer's MCP servers, although neither uses one.
4. **The run log is hard to read and to act on:**
   - `azelf run --help` plans every ready ticket and asks to proceed.
   - The `[round N]` line repeats every round.
   - The BLOCK line doesn't name the review file.
   - Each conflict attempt overwrites the last one's report.
   - A run that ends with everything parked doesn't print the command to resume.

## Phase 1 — a wave that survives a crash

- [x] **1a. A disk floor before every prep.** (`56f02bf`)
  - **The config value.** `minFreeDiskGb` in `slice.config.ts`, defaulting to 10 in the
    loader.
  - **Checked before each prep.** Before each prep in the start loop
    (`slice-run.ts:2410`), read the free space where the worktrees go: `statfsSync` on the
    parent of `worktreeFor(n)`, which works under Bun (checked 2026-09-24). It is checked
    before every prep, not once per round, because one round can start several slices,
    and each one is about 3 GB on consumer-a.
  - **Below the floor.** Prep nothing more and print once, when free space first goes
    below the floor:
    > disk: 6.2 GB free where the worktrees go, below minFreeDiskGb (10) — starting
    > nothing until there is more. Landing carries on, and each land removes a worktree.

    Print one line when it is back above the floor.
  - **The "nothing can advance" exit** (`:2484`) also fires when:
    - nothing is running;
    - nothing can land;
    - the disk is the only thing stopping a start.

    Its line names the disk and the floor. Nothing inside the run will free space.
  - **The banner** prints the free space next to the concurrency cap.

  *Why a fixed floor and not "N × the last worktree's size":* measuring a worktree means
  running `du` over `node_modules`, which takes seconds for every prep. A before-and-after
  free-space reading around a prep is thrown off by other sessions writing at the same
  time. A number in the config is predictable and testable, and the README says how to
  pick one.

- [x] **1b. A failed prep cleans up after itself.** (`56f02bf`)
  - **A new worktree is removed.** When the worktree did not exist before this prep, and
    the prep failed, remove it with `git worktree remove --force <path>` and print:
    > removed the half-prepped worktree for #33 — it held nothing but a partial install

    The branch stays. It has no commits of its own and costs nothing, and the next prep
    reuses it (`slice-session.sh` says "on existing local branch").
  - **An existing worktree is never removed.** A worktree that existed before the prep
    is a reused one, and someone's work may be in it.
  - **The disk is checked again after a failed prep.** If it is below the floor, 1a's
    hold applies at once, and the rest of this round's starts are skipped too. That is
    the "stop retrying on ENOSPC" half. It needs no parsing of `bun install`'s output,
    which prep prints straight to the terminal (`inherit: true`).

  *Proof for 1a and 1b:* harness tests.
  - **The floor.** With `minFreeDiskGb: 1e9` (through `configExtra`), `--auto -y 40`
    with no worktree:
    - preps nothing;
    - prints the hold line once;
    - exits 1 on "nothing can advance", naming the disk.
  - **A failed prep.** A `package.json` with a `file:` dependency that does not exist
    makes `bun install` fail without touching the network. After the prep fails:
    - the worktree is gone and the branch is still there;
    - the line is printed;
    - a second round (`--interval 1`) fails and cleans up again, so nothing piles up.
  - **An existing worktree.** The same failing prep in a worktree that already existed
    (`worktrees: [40]`) leaves it in place.

- [x] **1c. A stale `.slice-live` is noticed.** (`b23273c`)
  - **How a session is judged alive.** `hasSession` (`slice-run.ts:547`) reads the pid on
    the marker's first line and checks that it is still this slice's session: `ps -o
    command= -p <pid>` has to contain `slice-session` and the ticket id as an argument.
    `slice-land.sh` already makes the `slice-session` check before it warns about a live
    session. It works because the session shell lives as long as the session:
    `slice-session.sh` never `exec`s the agent, since its EXIT trap is what clears the
    marker.
  - **A marker whose pid fails that check.** The dispatcher:
    - reads the marker again and deletes it only if it is unchanged, so a new session's
      fresh marker is never deleted;
    - writes `.slice-interrupted` in the worktree;
    - prints once:
      > #41: its session (pid 52220) ended without clearing .slice-live — a crash, a
      > restart, or a killed tab. Relaunching it.
  - **A marker without a readable pid still counts as live,** as it does now. No version
    has ever written one, and a false "gone" would open a second session on top of a
    live one.
  - **Cost.** One `ps` per marker per round, memoised for the round, because `occupied`
    is asked from several filters. The launch grace (`launchedAt`) still covers the
    moment before a new session has written its marker.

- [x] **1d. A crashed slice is relaunched, not landed.** (`b23273c`)
  - **`autoFinished`** (`:1041`) also requires a clean worktree (`git status
    --porcelain` empty) and no `.slice-interrupted`. A dirty or interrupted worktree
    with no session then falls through to `runnable` (`:663`), which relaunches it in the
    next free slot.

    Both checks are needed:
    - **The marker is the direct evidence,** but it exists only when the dispatcher itself
      saw the stale `.slice-live`.
    - **The dirty check covers the other ways a marker goes missing:** a person deleted
      `.slice-live` by hand (the friction log did exactly that), or a dispatcher from
      before 1c was running.

    A crashed slice with a clean tree and no marker still counts as finished. There,
    the review is what catches half a ticket.
  - **`slice-session.sh`** deletes `.slice-interrupted` at launch, next to where it
    clears `.slice-lock-wait` (`:387`).
  - **The relaunch prompt.** When the worktree already has work in it (commits ahead of
    base, or a dirty tree), `slice-session.sh` appends one sentence to the start prompt:
    > This worktree already has work from an earlier session of this ticket that ended
    > before it finished — see `git log <base>..HEAD` and `git status`. Continue from
    > it; don't start over.
  - **`.slice-interrupted` joins `EXCLUDE_BLOCK`** in `slice-init.ts`, making nine
    markers; update `sliceInit.test.ts`'s count. Consumers need `azelf init` again.
    Until they run it, the marker shows as untracked, but only between being written and
    the relaunch, and a dirty tree is relaunched anyway.

  *Proof for 1c and 1d:* harness tests. Each uses a fake agent that writes its argv to a
  file, run with `--auto --once -y 40` unless stated.
  - **Dirty tree, dead pid.** A commit, a modified file, and a `.slice-live` naming a
    dead pid:
    - the line is printed;
    - nothing is landed;
    - the agent was launched, and its prompt has the "already has work" sentence;
    - `.slice-interrupted` is gone, deleted at launch.
  - **Clean tree, dead pid.** The same with a clean tree: relaunched, not landed. The
    marker decides it.
  - **Marker cleared by hand.** A dirty tree with a commit and no `.slice-live` at all:
    relaunched, not landed.
  - **Pid reused.** A `.slice-live` naming a live process that isn't a slice session
    (the test runner's own pid) counts as gone.
  - **A real session.** One started by the dispatcher (the fake agent sleeps) is left
    alone across rounds (`startDispatcher`).
  - **The existing smoke test** (clean, committed, no session, no marker) still lands.

**As landed, where it differs from the above:**
- 1a: only a prep that creates a NEW worktree is held. A relaunch into an existing
  worktree costs next to nothing on disk and leads to a land, which is what frees
  space, so holding it could only stall the wave. `0` turns the check off, and a
  statfs that fails counts as room. The first new worktree of a round is checked
  before the `[round N] starting` line, so a held round does not announce starts it
  won't make. "Nothing can advance" on the disk fires when nothing is running, nothing
  was prepped this round, and every open ticket is parked (with no retry due) or has
  nothing to land. It exits 1 even with nothing parked. Free space is in GB of 10⁹
  bytes (statfs's `bavail`). The README's config table has the `minFreeDiskGb` row;
  3f still owns the troubleshooting text.
- 1a proof: the floor test runs the dispatcher in the background. As a blocking
  `runDispatcher`, a run without the floor retries its prep forever and hangs the
  suite instead of failing it (found by switching the check off).
- 1b: a worktree that `git worktree remove --force` refuses is reported with its path
  and left in place. `git worktree add` already removes its own partial directory
  when it fails.
- 1c: the check is `kill -0` first (no such process means gone), then
  `ps -ww -o command= -p <pid>`. `-ww` because ps can cut the command to the
  terminal's width, and the ticket id is at the end of a long `node_modules` path.
  When `ps` cannot run at all, the session counts as live. Only the `ps` answer is
  memoised per round; whether the marker exists is still read each time.
- 1d: the relaunch prompt counts commits against the local base AND
  `origin/<base>` when it exists, because a new worktree is cut from origin and a
  local base that is behind it would make origin's commits look like the slice's own.
- 1c/1d proof: the fixture gained `launch: true`, a launcher that spawns each
  session's command detached, and `fakeSession(c, n)`, a process whose command line
  passes the check. The two existing tests that wrote a made-up pid (`99999`) into
  `.slice-live` use it now; under 1c that pid reads as a crash. The relaunch tests
  assert that no land was even attempted ("marked done" never printed): with the
  clean-tree check switched off, the land's own dirty check refused the slice, and
  the relaunch still happened, so "not landed" alone did not catch it.
- Found on the way, not fixed: under `--auto`, a slice that `autoFinished` and was
  then parked (red gates, BLOCK) has no ready marker, so `runnable` also relaunches
  it. That predates this plan. It is why the assertion above had to be "no land
  attempted".

## Phase 2 — guards

- [x] **2a. The dispatcher leaves a hand fix alone.** (`6097c8b`)
  - **The check.** A `handWork(wt)` next to `rebaseInProgress` (`slice-run.ts:1294`),
    read through `gitPath` (`:1260`), names the operation in progress:
    - a rebase (`rebase-merge` or `rebase-apply`);
    - a merge (`MERGE_HEAD`);
    - a cherry-pick (`CHERRY_PICK_HEAD`);
    - a revert (`REVERT_HEAD`).
  - **What skips such a worktree:** the land (the `finished` filter, `:2342`),
    `runnable`, and `autoFinished`. It is not parked, and it doesn't take a slot. Print
    one line when it is first seen and one when it clears:
    > #54: a rebase is in progress in its worktree — someone is fixing it by hand. Not
    > landing it until that's finished.

  *Why:* `rebaseOntoBase` (`:1215`) starts its own rebase when the branch is behind
  base. With a hand rebase in progress, that rebase fails ("there is already a
  rebase-merge directory"), and the cleanup `git rebase --abort` then aborts the HAND
  rebase. That happens whenever the base moved after the person started, which is
  routine with two dispatchers landing onto one base. While the base stands still, a
  ready-to-land slice being fixed by hand shows a different symptom: its gates are
  refused with "worktree is dirty (someone kept working after marking it done)".

  *Not closed:* the seconds between a hand commit and the hand `git rebase` that follows
  it. The commit moves the branch, which un-parks the slice, and a land that starts in
  that gap runs its own rebase. The person's `git rebase` then fails with git's "already
  a rebase-merge directory" message: visible, and nothing is lost. The README's recovery
  note says to finish the rebase before committing anything else, or to fix the slice
  and then run `azelf retry`.

  *Proof:* a harness test. The branch is behind main and conflicts. The worktree is
  mid-rebase with the conflict resolved but not continued, and has `.slice-ready-to-land`.
  Main then moves again, and `--auto --once -y 40` runs:
  - the line is printed and nothing is landed;
  - the resolved file is still resolved;
  - `rebase-merge` still exists.

  With the guard switched off, the test must fail.

- [x] **2b. A warning when azelf changes under a running dispatcher.** (`383b608`)
  - **What counts as the version.** At start, the dispatcher records its own package's
    installed version:
    - `.bun-tag` in the package root, where bun writes `chintonicc-azelf-<sha>` on a git
      install (checked in consumer-a's `node_modules` on 2026-09-24);
    - failing that, the newest mtime among its `scripts/`.

    The banner shows the version.
  - **Checked every round.** The dispatcher reads the version again each round. On a
    change it prints once:
    > azelf changed under this run: a3899a5 → 6383445. This dispatcher is still a3899a5;
    > its slices run 6383445's scripts from now on. Restart it (the same command) when
    > nothing is landing.
  - **A warning only.** The log also suggested giving each wave its own snapshot of
    azelf, and that is not in this plan. The shims resolve to the main checkout's install
    on purpose ("one version per wave"). Pinning sessions to a copy is a bigger change
    than the harm seen so far.

  *Proof:*
  - **A unit test** for the version read: with a tag, without one (mtime), and after a
    change.
  - **A harness test** that runs the dispatcher from a copy of the package (`scripts/`,
    `index.ts`, `package.json`; azelf has no runtime dependencies, so a copy runs) with a
    `.bun-tag`. The test rewrites the tag mid-run and expects the line once.

- [x] **2c. Headless runs don't load the consumer's MCP servers.** (`32bdb66`)
  - **The change.** In `claude()` (`slice-agent.ts:144-151`), `review` and `resolve`
    get `--strict-mcp-config` and no `--mcp-config`, which means no MCP servers. The doc
    comment above already says the reviews need none, and the resolver edits files with
    built-in tools.
  - **Check first, and record the result in the "as landed" block:** does that flag also
    skip claude.ai connectors? The log saw a Resend connector message. One
    `claude -p --strict-mcp-config --debug` run in a directory with a `.mcp.json` shows
    it. If connectors still load, look for a documented switch. Don't use `--bare`, which
    also ignores OAuth logins.

  *Proof:* `sliceAgent.test.ts`. The claude preset's `review` and `resolve` argv
  include the flag, and its `sessionCommand` doesn't.

**As landed, where it differs from the above:**
- 2a: the operations are read with one `git rev-parse` of five `--git-path`s per open
  worktree per round, at the top of the round (`noteHandWork`), not through
  `gitPath` five times. The check is before `isParked` in the land filter, so a retry
  that falls due during someone's rebase (the base moved) is not consumed; it fires
  once the rebase ends. A slice with an operation in progress also keeps both
  "nothing can advance" exits from firing, parked or not: finishing it moves the
  branch, so the run still has something coming. It is recorded but not announced
  while a session is running there (the agent's own rebase), so a session that dies
  mid-rebase is covered too; the crash line's "Relaunching it." is then followed by
  this line, and no relaunch. The line reads:
  > #54: a rebase is in progress in its worktree, with no session running there —
  > someone is fixing it by hand, most likely. Not landing or relaunching it until
  > the rebase is finished or aborted.

  and when it ends, "nothing is in progress in its worktree any more — back in the
  run." The README has a "Fixing a slice by hand while the dispatcher runs"
  subsection. Its advice for the gap: start the rebase before you commit, or commit
  the fix and let the land rebase it.
- 2a proof: three tests. Beside the plan's (mid-rebase, main moved, `--once`), one
  finishes the rebase under a running dispatcher and expects the line once, the
  "back in the run" line, and a land carrying the resolution. One covers a merge.
  With the guard switched off, the fixture's resolver rebased over the hand fix and
  landed without it.
- 2b: the reader is `scripts/slice-version.ts` (`installedVersion`), a module of its
  own so the dispatcher doesn't import `slice-init.ts`. The tag's sha is what is
  shown. Without a tag, the label is `scripts of <UTC time>`, and "unknown" (nothing
  readable) never counts as a change. The banner line is `azelf: <version>`. The
  warning says "the sessions and lands it starts run X from now on", since a land
  runs through the shims too. The README's shim paragraph shows the line.
- 2b proof: `startDispatcher` takes an optional path to another `slice-run.ts`. The
  harness test waits for three rounds after the warning and counts it once. Switching
  off the per-round read, or the once-only flag, fails it.
- 2c: checked on claude 2.1.282 on 2026-09-25 with `--debug-file` in a directory with
  a `.mcp.json`: without the flag nine servers connected (the claude.ai connectors,
  a user-configured one, and the project's), and the project's server started; with
  it, none connected and the project's server never started. claude still fetches
  the connector LIST once, but connects to none. No other switch was needed. The
  docs never quoted the headless argv, so there was nothing to update there.

## Phase 3 — the run log

- [x] **3a. `azelf run --help`.** (`13e4444`)
  - **`slice-run.ts` handles `-h`/`--help` before anything else,** before `--retry` and
    before the tracker. It prints the usage from its header (`:5-17`), which moves into a
    `USAGE` constant, and exits 0. It also adds the two flags the header lacks: `-y`/`--yes`
    and `--interval <seconds>`.
  - **An unknown flag exits 64.** That is anything starting with `-` that is neither a
    known flag nor the value of `--max`, `--interval` or `--retry`:
    > unknown flag --hepl — azelf run --help lists them

    Letting unknown flags through is what turned `--help` into a full plan and a
    `proceed?`.
  - **`bin/azelf.ts`.** `azelf -h` and `azelf --help` print its usage to stdout and exit
    0. Today the usage goes to stderr with exit 2, as for a mistake.

  *Proof:*
  - `run --help` exits 0, prints `-y`, and never prints "reading the plan";
  - `run --hepl` exits 64;
  - `azelf -h` exits 0.

- [x] **3b. The round line only when something changed.** (`fe8664b`) `[round N] … — land one to
  advance` (`slice-run.ts:2453`) is printed when its counts differ from the last one
  printed, and ten minutes after that as a heartbeat. Its text doesn't change, so a
  watcher that matches it keeps working.

  *Proof:* a background run with `--interval 1` and nothing changing prints it once over
  five rounds.

- [x] **3c. The BLOCK line names the review.** (`02718e2`) After the ✗ line (`:944`), print
  `     review: <path>`, the way a failed resolution prints `transcript:`.

  The path is already printed as `report saved:`, above the review text. The log's
  writer missed it because the tool watching the log truncated the text in between. The
  ✗ line is the line people actually read.

  *Proof:* the existing BLOCK harness test checks for the line.

- [x] **3d. Every attempt's report is kept.** (`02718e2`)
  - **Appended, not replaced.** `saveReport` (`:808`) gains an append mode.
    `conflict-<n>.md` (`:1446`) and `ticket-<n>.md` add each attempt as a new
    `## Attempt k — HH:MM` section, newest last, instead of replacing the file. A
    resolution's `## Stop` sections move one level down.
  - **Reviews too, not just conflicts.** Since the wave-friction plan's 2c, a slice
    BLOCKed by the review is re-reviewed routinely. The passing review would otherwise
    replace the BLOCK that says why the slice was parked.

  *Proof:*
  - two failed resolutions on one ticket (two `--once` runs, with the resolver printing
    `IRRECONCILABLE:`) leave one file holding two attempts;
  - a BLOCK then a PASS leave both in `ticket-<n>.md`.

- [x] **3e. The end of a run prints the command to resume.** (`33ee214`) The parked summary
  (`:2516`) and the "nothing can advance" line end with the exact command:
  `bunx azelf run <this run's flags> <parked ids>`, for example
  `bunx azelf run --auto -y 43 55`. The flags are this run's argv minus its ticket ids
  and `--once`.

  *Proof:* the existing parked-exit harness tests check for the line.

- [x] **3f. README and the `/azelf` command copies.** (`dc47f0f`)
  - **Troubleshooting:**
    - a slice whose session crashed (1c, 1d);
    - a disk below the floor (1a);
    - fixing a slice by hand while a dispatcher runs (2a);
    - "azelf changed under this run" (2b).
  - **Config reference:** `minFreeDiskGb`.
  - **The command copies** (`agent/commands/`, `.claude/commands/`): one sentence each
    on crash recovery and on the version warning.

**As landed, where it differs from the above:**
- 3a: the usage and the flag list are in `scripts/slice-run-usage.ts`, not a constant in
  `slice-run.ts`, because `slice-run.ts` loads `slice.config.ts` at import time. From
  there `bin/azelf.ts` answers `azelf run -h`/`--help` itself, so it works in a repo
  with no config. `slice-run.ts` answers the same flags for its shim, right after argv
  is read. `--retry` joined `VALUE_FLAGS`, so `--max -1` and `--retry 12` pass the
  unknown-flag check. `azelf -h` prints to stdout and exits 0.
- 3a proof: four tests: `run --auto --help`, `--hepl`, `--max -1 --plan`, and the real
  CLI's `-h` and `run --help` from a directory with no config above it. Each fails with
  its check switched off.
- 3b: the heartbeat is `SLICE_HEARTBEAT_SECONDS` (default 600, `0` prints every round).
  The tests count rounds by the line, so the fixture sets it to 0, and
  `startDispatcher`'s third argument became `{ dispatcher?, env? }`.
- 3b proof: with a 6s heartbeat and `--interval 1`, the second line comes three or more
  rounds after the first, and a session ending is printed within 3.5s. Printing every
  round fails the first half; printing only on the heartbeat fails the second.
- 3d: an attempt's heading is `## Attempt k — YYYY-MM-DD HH:MM`, local time. The date
  is there because attempts pile up across runs and days. The `# heading` is written
  when the file is created; a review's `## Spec`/`## Standards` and a resolution's
  `## Stop` move to `###`. A file from before this change keeps its old text above
  the first `## Attempt`.
- 3c/3d proof: the BLOCK test checks the `review:` line right under the ✗, and after
  the ticket edit one `# Review` heading over a BLOCK attempt then a PASS attempt. The
  give-up test runs a second `--once` and finds two REJECTED attempts.
- 3e: the ids are the tickets the run left open, not only the parked ones. When
  everything left is parked that is the same set, and it also covers the disk exit
  (which may have nothing parked) and a stopped run. The command is printed at the end
  of the parked summary ("To pick the run up again:") and of the disk's "nothing can
  advance" line, not twice when both apply. Checked on the disk-floor test and the
  give-up test (a `--once` run, so `--once` is dropped).
- 3f: `minFreeDiskGb` was already in the config table (1a). The two command copies
  already differed (the `.claude/` one lacks the resolver paragraph); each got the same
  additions, and they were not otherwise synced.
- Found on the way, not ours: a test "does not relaunch a slice --auto read as finished
  once it has parked" appeared in the working tree during this phase, uncommitted and
  failing. It is the autoFinished-then-parked relaunch gap noted under Phase 1. It was
  left uncommitted.

## Order and cost

- **Phase 1** is most of the work, about a day.
  - Land 1a and 1b as one commit, then 1c and 1d as another. The marker and the
    relaunch prove each other.
  - It needs `azelf init` on the consumer, for the new marker.
- **Phase 2** is about half a day. 2a is the item that protects work, so if only one
  item from this phase lands, it should be 2a.
- **Phase 3** is about half a day of small changes. It can go in one commit, or be
  split along the lettered items.

Each phase can ship on its own.

## Not in this plan

- **A session left at its REPL after marking itself done.** `slice-done.sh` already
  frees the slot by clearing `.slice-live`, so the cost is one idle tab and one agent
  process. Ending an agent from outside needs design work for little gain.
- **`session-commit.sh --amend`.** Nobody has needed it since the log entry.
- **Sharing `node_modules` between worktrees.** This is the real fix for the disk, and a
  project of its own.
- **A `.slice-fixing` marker** that closes the gap 2a leaves between a hand commit and a
  hand rebase.
- **A per-wave snapshot of azelf** for sessions. 2b only warns.
- **Codex's headless MCP config.** Its review only runs with `headless: true`, and its
  MCP servers are configured elsewhere.
- **A crashed slice with a clean tree and no marker** (the marker was cleared by hand, or
  by a dispatcher from before 1c). It still counts as finished, and the review catches a
  half-done ticket.

## What the consumer does itself

Not azelf's to fix, but they came up in the same log:
- **Manual-test journeys.** Number them by ticket, not in sequence at the end of one
  file. Every parallel pair of slices collides on the next number otherwise. Each
  collision is now resolved without a human, but costs one resolver run, and comes back
  at the next land.
- **The test gate.** Set `retries: 1` on it (landed in `85de384`, off by default).
- **`CLAUDE.md`.** It still gives `session-commit.sh` without `-y`.
- **`minFreeDiskGb`.** Set it for the consumer's worktree size once 1a lands. At about
  3 GB per worktree, the default of 10 leaves room for about two preps and the gates.
- **`azelf init`.** Run it after Phase 1.
