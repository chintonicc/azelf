# What consumer-a's 2026-09-23 waves tripped over

**Status:** COMPLETE: Phases 1–3 LANDED 2026-09-23 · **Written:** 2026-09-23
**Companion:** consumer-a's friction log (an untracked file in its main checkout, not in
this repo), `scripts/slice-resolve.ts` header, `docs/tab-close-plan.md` (same day, same
waves).

Written so it can be picked up cold. Each item says what to change, where, why, and what
proves it. Tick the boxes as they land and add the commit hash after the heading. Line
numbers are as of `a3899a5`; the three phases moved `slice-run.ts` by about 400 lines, so
search for things by name.

## What happened

Two dispatchers ran about a dozen slices on consumer-a in one day. The sessions logged
fifteen problems as they hit them. Four groups are in this plan. The rest are listed at the
end for the next one.

1. **The conflict resolver fixes the conflict and cannot finish the rebase.** On four slices
   the headless resolver produced a correct resolution (markers gone, tests and tsc green),
   then stopped: *"The permission layer blocked `git add` (requires approval)"*. It runs
   under `--permission-mode acceptEdits`, which covers edits and not git. The dispatcher
   sees a rebase still in progress, `give()` aborts it, and the resolution is thrown away.
   One branch's reflog shows two correct resolutions discarded before a human finished the
   third by hand.
2. **`session-commit.sh` fails on ordinary git.** A path removed with `git rm`, or moved
   with `git mv`, is in neither the index nor the worktree, so `git add -- <path>`
   (`session-commit.sh:162`) dies with *"pathspec did not match any files"*. Run without
   `-y` in a session with no terminal, it stages everything first and only then refuses
   (`:227`), so the retry trips over its own leftover staging. And the slice skill shows the
   command without `-y` (`agent/skills/slice/SKILL.md:43`), though a slice session never
   has anyone at the keyboard: every slice paid one failed commit to learn that.
3. **A parked slice retries only when its branch moves.** Four cases, and in none of them
   was the branch the problem:
   - it lost a fast-forward race to another land;
   - the spec review said BLOCK because the ticket text was stale, and the ticket was fixed
     on the tracker;
   - a timing-sensitive test failed under load, and a fix for the test landed on master;
   - it was landed by hand, and the dispatcher kept it in `parked` for the rest of the run
     and tried to start it again.

   The workarounds were rebasing a correct branch just to move it, and
   `slice-land.sh --end-session` to bypass the review.
4. **Two dispatchers on one repo run into each other.** Nothing serialises lands across
   dispatchers: each one lands one slice per round, but five of them landed onto one
   master in one main checkout. And every gate run happens under the load of the whole
   wave: load average 26–29, and a 5-second test timeout parked three green slices that
   did not touch the code under test.

## Phase 1 — the everyday failures

- [x] **1a. A dispatcher test harness.** (`f34aae2`) Every later item changes `slice-run.ts`, and
  nothing tests it end to end (Phase 2 of the DB-lock plan was proven by a scratch dry
  run). In `tests/scripts/fixture.ts`:
  - The fake tracker reads titles, bodies and states from a JSON file under `root` on
    every call, so a test can edit a ticket or close it mid-run.
  - An `agent` option taking `resolve` and `review` argv as well as `sessionCommand`.
    The fake resolver and reviewer are small bash scripts: one rewrites the conflicted
    file, the other prints `VERDICT: BLOCK` unless the ticket body says otherwise.
  - `runDispatcher(fx, args)`, which spawns `bun <AZELF>/scripts/slice-run.ts` from the
    main checkout. It runs `--once` for synchronous tests, or in the background with
    `--interval 1` plus an `until(output contains …)` helper for multi-round ones.

  *Proof:* one smoke test. A worktree with a commit and `.slice-ready-to-land`, then
  `--auto --once -y --no-review 40`, lands and closes the ticket.

- [x] **1b. The resolver edits; azelf runs the git.** (`f34aae2`) In `resolveConflict`
  (`slice-run.ts:1256`), replace the single resolver call with a loop over the rebase's
  stops. While a rebase is in progress:
  1. Read the unmerged paths (`git diff --name-only --diff-filter=U`).
  2. Hand them to the resolver.
  3. If any still has conflict markers (`hasConflictMarkers`), call `give()`.
  4. Otherwise `git add -A -- <those paths>` and run `git rebase --continue` with
     `GIT_EDITOR=true` in its environment.

  Cap the loop at the number of commits being replayed plus one. Each stop gets its own
  `RESOLVE_TIMEOUT_MS`.

  Change `resolvePrompt` (`:1196`) to match. The resolver edits the conflicted files and
  does nothing else. It does not run `git add`, `rebase --continue` or `rebase --abort`,
  because azelf does those and calls it again if the next commit stops. When the two
  sides cannot coexist, it leaves the files alone and prints a line starting
  `IRRECONCILABLE:`, which `give()` uses as its reason.

  `-A` is deliberate. An unmerged path is still in the index, so a resolution that deletes
  the file stages the removal (checked 2026-09-23: `rm f && git add -A -- f` mid-rebase,
  then `--continue`, succeeds). Paths the resolver was not given are never staged.
  Stray edits therefore leave the tree dirty, and the existing dirty check
  (`resolutionProblem`, `slice-resolve.ts:63`) rejects them.

  *Why not grant the resolver `git add`:* that only fixes `claude()`, through its
  permission-rule syntax, and only where the consumer's settings do not deny it. Any
  other resolver would still hit the same wall. Letting it run git would also let it
  `reset --hard` or `commit --amend`, which rule 5 of the prompt forbids only by
  instruction.

  *Proof:* four harness tests on a branch that conflicts with main.
  - One stop, resolved: lands, and the report says ACCEPTED.
  - Two conflicting commits: the resolver is called twice, and the branch lands.
  - The resolver prints `IRRECONCILABLE:` and leaves markers: rejected, head unchanged,
    no rebase in progress.
  - The resolver also edits an unrelated file: rejected as dirty.

- [x] **1c. `session-commit.sh` takes deletions and renames, and refuses before it
  stages.** (`0623602`)
  - **Deletions and renames.** Before `git add` (`:162`), leave out each path that is
    absent from the worktree, absent from the index (`git ls-files --error-unmatch`
    fails), and present in `HEAD` (`git ls-tree -r --name-only HEAD -- <path>` is
    non-empty). That is a removal already staged by `git rm` or `git mv`. It stays in the
    `git commit -- <paths>` pathspec, which accepts it: checked 2026-09-23 for a `git rm`
    deletion and a `git mv` directory rename (recorded as R100). A path that matches
    nothing anywhere is still git's error, so typo protection stays.
  - **Refusing before staging.** Move the non-interactive-without-`-y` refusal (`:225`) to
    before the lock and before staging.
  - **Aborts.** The interactive `N` answer and the DB-lock refusal both run
    `git reset -q -- <paths>`, so an abort leaves the index as it found it, give or take
    a staged removal turning back into an unstaged one.

  *Proof:* in `tests/scripts/sessionCommit.test.ts`:
  - a `git rm`'d file commits;
  - a `git mv`'d directory commits as a rename;
  - a misspelt path is still refused;
  - a run without `-y` and without a terminal exits 1 with `git diff --cached` empty.

- [x] **1d. The skill says `-y`.** (`0623602`) Section 4 of both `agent/skills/slice/SKILL.md` and
  `.claude/skills/slice/SKILL.md` becomes
  `./scripts/session-commit.sh -y -m "..." <paths>`, plus one sentence: a slice session
  never has a terminal, and without `-y` the script refuses. The README's cheat sheet
  already shows `-y`.

**As landed, where it differs from the above:**
- 1a: the resolver and reviewer argv are fixture options of their own (`resolve`,
  `review`), not fields of `agent`; either one alone gives the config a fake agent
  whose session command is `true`. The fake tracker's `close` also marks the ticket
  closed in its file, as a real one would. `runDispatcher` and `startDispatcher` are
  the two runners, and the tests are in `tests/scripts/sliceRun.test.ts`: the smoke
  test, one multi-round test (`slice-done.sh` run while the dispatcher is waiting),
  and the four resolver tests.
- 1b: stray edits are caught by a per-stop check (`stopProblem` in
  `slice-resolve.ts`), not by the final dirty check. Checked 2026-09-23: with an
  unrelated file modified, `git rebase --continue` refuses with "You must edit all
  merge conflicts and then mark them as resolved using git add", so the dirty check
  never ran and the reason would have named the wrong file. Each stop's prompt names
  the commit being replayed (`REBASE_HEAD`), and a resolution that empties a commit
  is fine: `--continue` drops it (checked the same day).
- 1d: `slice-done.sh`'s "commit first" hint shows `-y` too.

## Phase 2 — a parked slice retries when the reason it parked changes

- [x] **2a. A ticket closed elsewhere leaves `parked`.** (`4faf7dc`) After `refreshOpenState`
  (`slice-run.ts:613`), drop every parked ticket that now reads closed, and print
  *"#17 was closed outside this run — no longer parked"*. It then stops counting toward
  `N parked` and the end-of-run summary (`:2059`), which also stops a run that finished
  everything from exiting 1.

  A ticket landed by hand in the middle of a round can still be "started" once, before the
  next refresh. `slice-session.sh` refuses it on the tracker check, which is harmless;
  leave it.

- [x] **2b. `Parked` records why and against what.** (`4faf7dc`) `type Parked` (`:1400`) gains:
  - `kind`: `"rebase" | "gates" | "review" | "land"`, set by each `park()` call in
    `tryLand` (`:1484`);
  - `base`: the base branch's head at park time;
  - for `review` only, `body`: a hash of `tracker.body` at park time;
  - `autoRetries`: a count.

- [x] **2c. The automatic triggers.** (`4faf7dc`) `isParked` (`:1412`) keeps "the branch moved" and
  adds two more:
  - `gates` or `land`, and the base branch has moved since parking: retry, at most twice
    per branch head. Print *"master moved since #42 was parked — retrying"*. This covers
    the lost fast-forward race and a flaky test fixed on master. The cap is there because
    every land moves the base, and a slice whose own code is red should not re-run the
    gates after each one.
  - `review`, and the ticket body's hash has changed: retry, printing *"the ticket was
    edited since the BLOCK — retrying"*. That costs one tracker call per review-parked
    ticket per round.

  `rebase` parks get no automatic retry: each attempt is a resolver run of up to twenty
  minutes, against a conflict the base moving rarely removes.

  The "nothing can advance — every open slice is parked" exit (`:2044`) stays. Every
  trigger is an outside event, and a run with nothing else to do should say so and stop
  rather than poll. Starting the dispatcher again is the retry.

- [x] **2d. `azelf retry <ticket>`.** (`4faf7dc`) A new verb in `bin/azelf.ts`. It spawns
  `slice-run.ts --retry <id>`, which validates the id, writes `.slice-retry` into that
  slice's worktree before loading any plan, and prints:

  > the running dispatcher retries #17 next round; if none is running,
  > `azelf run --auto 17` does

  `isParked` consumes the marker (deletes it and un-parks the ticket). A dispatcher also
  deletes leftover markers when it starts, since its `parked` map starts empty anyway.

  `.slice-retry` joins `EXCLUDE_BLOCK` in `slice-init.ts`, making eight markers. Update
  `sliceInit.test.ts`'s count. Consumers need `azelf init` again.

  The park line in `askAboutBlocked` (`:1441`) and the summary name every way out: *"retried
  when its branch moves, when master moves, or now with: azelf retry 17"*, trimmed to the
  triggers that apply to that `kind`.

- [x] **2e. README.** (`4faf7dc`) The parked-slice section: what retries automatically and when, what
  `azelf retry` is for, and that `slice-land.sh` by hand is for landing without the
  review, not for retrying it.

  *Proof for 2a–2d:* harness tests, run in the background with `--interval 1`.
  - **Gates red:** the gate needs a file main does not have yet. After it parks, commit the
    file to main; the slice lands without anything committed to its branch.
  - **Review BLOCK:** the fake reviewer blocks until the ticket body contains `FIXED`. Edit
    the fake ticket and it lands.
  - **`azelf retry 40`:** a parked slice retries on the marker, and the marker is gone
    afterwards.
  - **Closed elsewhere:** close the fake ticket while it is parked. The line is printed,
    `parked` no longer counts it, and the run exits 0.
  - **The cap:** a `gates` park whose gate never passes retries twice as master moves,
    then stays parked.

**As landed, where it differs from the above:**
- 2b: `base` is the branch's merge-base with the base branch at park time, not the
  base's head. A land that loses a fast-forward race parks after the other land has
  already moved the base, so the head would include the very move that should retry
  it. The harness test for that race (a gate that lands a commit on main while it
  runs) fails with the head and passes with the merge-base.
- 2b: `autoRetries` is carried from a retry to the park that follows it through a
  separate `retriesSpent` map, because a retry deletes its `Parked` record. "Per
  branch head" means per head the author committed: a retry's own rebase moves the
  branch too, and counting that as a new head would reset the cap every time.
  `azelf retry` and an edited ticket carry the count unchanged; a moved branch
  resets it.
- 2c: once the cap is spent, the next base move prints one line saying so (not
  one per round), naming `azelf retry`.
- 2c: the "nothing can advance" exit does not fire while a parked slice is already
  due a retry. One trigger is not an outside event: this round's own land can move
  the base, and a `gates` park waiting on exactly that gets its next round. There is
  a harness test for it (#42 lands the fix that #40's gate needs).
- 2c: a body the tracker fails to return never reads as "changed", so a flaky
  tracker cannot turn into a retry per round.
- 2d: `--retry` also refuses an id with no worktree (exit 1). An interactive `[p]`
  prints the same ways-out line as a non-interactive park.
- 2d: the end-of-run summary does not repeat "retried when …", because that is a
  running dispatcher's promise and the run is exiting. It says the next run starts
  with nothing parked, and that `slice-land.sh` lands without the review.
- 2e: both copies of the `/azelf` command (`agent/commands/`, `.claude/commands/`)
  describe the triggers too, and the spec review's BLOCK line suggests correcting the
  ticket.
- Tests: the fixture takes a `gate` (as `exitCode(gate)`). The eight new tests in
  `tests/scripts/sliceRun.test.ts` are the five above, the race, the self-moved
  base, and `azelf retry` on a ticket with no worktree.

## Phase 3 — two dispatchers on one repo

- [x] **3a. A land lock in `slice-land.sh`.** (`85de384`) Take `<common git dir>/azelf-land.lock` (an
  atomic `mkdir`, with an owner file naming pid, ticket and time) after the branch checks
  and before `base_before` (`slice-land.sh:131`). Hold it until exit.
  - It waits up to five minutes, printing once *"waiting for ticket/41's land (pid …)"*.
  - A lock whose owner pid is dead is taken over, with a line saying so.

  It lives in the script and not in the dispatcher because hand lands race too: one of
  the friction entries is a by-hand `slice-land.sh` during a running wave.

  With 2c, a land that loses the race refuses cleanly ("diverged"), parks as `land`, and
  retries on the base move, instead of two `git merge`s contending for `index.lock`.

  *Proof:* two `slice-land.sh` in the fixture, the first held open by a slow `pre-push`
  hook. The second prints the waiting line naming the first, then either lands or refuses
  as "diverged", never with a git lock error.

- [x] **3b. One gate run per repo at a time.** (`85de384`) `gatesPass` (`slice-run.ts:1031`) runs
  `runGates` under `<common git dir>/azelf-gates.lock`. Use the same owner-file shape as
  3a, in a small `scripts/slice-lock.ts`, so the lock itself is unit-testable. It prints
  *"waiting for #31's gates (other dispatcher, pid …)"* while it waits.

  A single dispatcher already gates one slice at a time. This stops a second dispatcher's
  gates running on top of the first's. It does not stop the sessions' own test runs,
  which is why 3c exists.

  *Proof:* unit tests on `slice-lock.ts`: two processes contend, one waits and then
  proceeds, and a dead owner is taken over.

- [x] **3c. A gate can ask to be retried once.** (`85de384`) `Gate` (`slice-gates.ts:83`) gains
  `retries?: number`, default 0, settable through the opts of `exitCode`,
  `exitCodeOverFiles` and `baselineDiff`.
  - `runGates` (`:288`) re-runs a failed gate up to that many times, still inside the
    write check. The result carries `flaky: string[]`, naming the gates that passed only
    on a retry.
  - `gatesPass` prints *"⚠ `bun run test` failed, then passed on retry 1 — flaky under
    load"*. The end-of-run summary lists every slice landed on a retried gate, so the
    flakiness is seen and not buried.

  Off by default, because retrying a deterministic gate (tsc, lint) only doubles the cost
  of a real failure. A consumer sets `retries: 1` on its test gate.

  *Proof:* a unit test with a gate that fails on its first call and passes on its second
  lands with `flaky: [name]`. With `retries: 0` it fails.

**As landed, where it differs from the above:**
- 3a/3b: one implementation, not two. `slice-land.sh` calls `slice-lock.ts` through
  its command line (`bun slice-lock.ts acquire|release <dir> --pid $$ …`) and releases
  in an EXIT trap. A lock is placed whole: its owner file (pid, start time, label,
  time) is written into a private directory, which is then renamed into place.
  rename(2) fails onto a non-empty directory, so this is as atomic as `mkdir` and a
  lock never exists without its owner. A holder is alive when its pid is running and
  its `ps -o lstart` still matches, because pids get reused. A takeover moves the dead
  lock aside and checks that it moved the lock it judged dead, so two waiters on one
  dead holder do not delete each other's fresh lock.
- 3a: the lock is taken right before `base_before`, so a land refused for having no
  branch never waits. There is a test for that, besides the two in the plan (the slow
  `pre-push` race, and a dead holder taken over).
- 3b: the gate lock waits as long as the holder is running, with no cap. The round
  has nothing else to do until its gates have run, and a holder that dies is taken
  over. `azelf run --gates` takes it too. There is a harness test for the waiting line
  as well as the unit tests.
- 3b, not closed: `baselineDiff` runs its baseline in the main checkout, and another
  dispatcher's land can fast-forward that checkout mid-run, because the gate lock
  does not also take the land lock. The friction log has no case of it. Holding both
  would stop every land for the length of a gate run.
- 3c: `flaky` is `{ gate, retry }[]`, not `string[]`, so the warning can name the
  retry that passed. A failure after its retries reads "…, and again on N retries".
  `GateOptions`, `GatesResult` and `Flaky` are exported from `index.ts`. The end of
  the run prints a "landed on a retried gate" block before the parked list. Proof: six
  unit tests in `sliceGates.test.ts`, and two harness tests (lands and is listed with
  `retries: 1`; parks without it).
- The README gains "Two dispatchers on one repo", `retries` under Gates, and a
  troubleshooting entry. Both `/azelf` command copies say two dispatchers are fine.
  Nothing new goes in the worktree, so consumers need no `azelf init` for this phase.

## Order and cost

All three phases landed on 2026-09-23. The estimate as written: Phase 1 is about a
day, and 1a is most of it; land 1a+1b as one commit (the harness
exists to prove 1b), then 1c+1d as another. Phase 2 is half a day and needs `azelf init` on
the consumer for the new marker. Phase 3 is half a day. Each phase is shippable alone, and
1b and 1c remove the failures that happened most often.

## Not in this plan

The rest of the friction log, for the next plan:

- **Stale `.slice-live` after a crash or restart.** `hasSession` (`slice-run.ts:533`)
  checks that the file exists. The file already holds the session's pid, so check that
  the pid is alive and is a slice session.
- **`autoFinished` lands a crashed slice's committed half.** `:1011` counts "no session +
  commits ahead" as finished; also require a clean worktree, and relaunch a dirty one
  instead.
- **A full disk.** A prep that fails with ENOSPC is retried every round, leaving a
  partial worktree (about 2.7 GB each) each time. Check free space before a prep, stop
  the run on ENOSPC, and look at sharing `node_modules` between worktrees.
- **A hand fix racing the dispatcher.** A `.slice-fixing` marker that the dispatcher
  treats as "occupied, do not land".
- **A session left at its REPL when its land parks.** `--end-session` only runs on a land.
  End the agent when the dispatcher first sees `.slice-ready-to-land` instead, and weigh
  what that costs a parked slice.
- **`azelf run --help`** plans every ready ticket and asks to proceed. `-h`/`--help`
  should print the flags. The usage text is also missing `-y`.
- **`session-commit.sh --amend`**, for a fix-up in a worktree that should not add a
  commit.

## What the consumer does itself

Not azelf's to fix, but it produced the same symptoms:
- consumer-a's `CLAUDE.md` gives `session-commit.sh` without `-y` too;
- its manual-test document numbers each entry sequentially at the end of one file. That
  makes every pair of parallel slices collide, and no resolver can renumber against
  branches it cannot see. Key entries by ticket instead;
- its time-bounded tests need load-tolerant timeouts (done on 2026-09-23).
