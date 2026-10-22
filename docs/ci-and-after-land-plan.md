# A command runs after every land, and CI on the slice's SHA can gate it

**Status:** complete. Phase 1 landed (`fd0c135`) · Phase 2 landed (`b5da41f`), 2026-10-22,
after all, on the user's go · **Written:** 2026-10-22
**Companion:** the analysis consumer-b's session wrote on 2026-10-22, the same one
behind `docs/non-bun-consumer-plan.md`. Its third tool change was "a CI gate plus a
post-land check". That plan put both under "Not in this plan".

Written so it can be picked up cold. Tick the boxes as they land and add the commit hash
after the heading. Line numbers are as of `6f94898`.

## What happened

1. **consumer-b built the CI gate itself.**
   - Its backend requires green CI on the pushed SHA before `main` moves. azelf gates
     locally and pushes `main` right after.
   - So the backend's config ends its `gates` with
     `exitCode(["bash", ".azelf/ci-gate.sh"])`. That is a 120-line script, untracked
     (`.git/info/exclude`). It pushes the rebased slice and waits until the workflows
     `Tests` and `Docker-Gate` succeed on exactly that SHA. Lands are fast-forward
     only, so the SHA that lands is the one CI passed.
   - Its design points, all worth keeping:
     - **A throwaway branch per SHA** (`azelf-ci/<branch>-<sha12>`), never the ticket
       branch. Under `--auto` the base moves often, the land rebases, and a second push
       of the same branch would be a force push, which the project forbids. A name per
       SHA never needs one. The branch is deleted at the end, green or red. The runs
       stay readable through `gh run list --commit <sha>`.
     - **Already green, no push.** A retry with no new head costs nothing.
     - **Only runs created after the push count.** An old red run on the same SHA does
       not fail it.
     - **A deadline (45 minutes).** Past it, the gate is red, not guessed.
     - **It writes nothing into the worktree.** Pushing and deleting move refs only.
   - Both of consumer-b's repos run CI on a push to any branch, which this needs.
2. **Nothing runs after a land.**
   - consumer-b deploys from `main`. The backend's workflow notes that a run on `main`
     accompanies a real deploy. Whoever started the land checks the deploy by hand.
   - Under `--auto` nobody does, and the next slice lands on top of whatever the last
     one deployed.
3. **What a CI gate costs today.**
   - Gates run synchronously in the dispatcher, through `run(cmd, { cwd, allowFail:
     true })` (`slice-run.ts:2797`), with no timeout.
   - While the CI gate waits, up to 45 minutes, the dispatcher does nothing else. It
     preps nothing, lands nothing and relaunches no crashed session.
   - The gate lock is held the whole time (`slice-run.ts:2773`), so a second
     dispatcher on the repo waits for its own gates.
   - consumer-b puts the CI gate last, so a red local suite never pushes. That is
     right, but it does not shorten the wait.

## Decisions this plan makes

- **`afterLand` is an argv in the config, run by `slice-land.sh` as its last step.**
  - Every land goes through `slice-land.sh`: the dispatcher's, `slice-done.sh`'s, and
    one by hand. So the check cannot be skipped by landing another way.
  - It runs in the main checkout, after the push, the close and the cleanup. The close
    is what the next wave waits on, and the cleanup is quick.
  - The ticket is closed even when the check later fails: the code is on the base
    branch either way, and the failure is about the base, not the ticket.
  - It gets `SLICE_TICKET` and `SLICE_LANDED_HEAD` (the full SHA) in its environment.
- **It runs under the land lock.** The next land waits until the check has passed, so
  nothing lands on top of a deploy nobody has looked at.
  - The cost: lands are serialised over the check's duration. A dispatcher lands one
    slice per round anyway.
  - A check that hangs holds the lock. Other lands give up after `LAND_LOCK_WAIT`
    (300 s, `slice-land.sh:190`) and park with "land". azelf adds no timeout. The
    command bounds itself, as consumer-b's CI gate does with its deadline. The README
    says so.
- **A failed `afterLand` stops the landing, not the work.**
  - `slice-land.sh` exits with a code of its own (not 1, not 75), documented in its
    header. The land is not undone: it is pushed and closed.
  - The dispatcher records the slice as landed, because it is. It prints
    `✗ afterLand failed after #n landed — <cmd> exited <code>` and the command's last
    lines. Then it exits with the code it uses for "nothing can advance", after the
    end-of-run summary.
  - Sessions in their tabs keep working, and ready slices wait. The message says what
    to do: fix the base, then `azelf run` again.
  - The alternative was a dispatcher that keeps running and only stops landing. That
    is a new state across the round loop, for a case that needs a person anyway.
  - By hand, `slice-land.sh` prints the failure and exits with that code. There is
    nothing to stop.
- **A finished land runs it too.** Finishing an interrupted land (`$finishing`,
  `slice-land.sh:109`) ends at the same last step, so a land killed before its
  `afterLand` gets one on the finish. A land killed during its `afterLand` does not
  re-run it, because the record is already gone by then. The README says so.
- **The CI gate becomes a gate shape, `ciRuns()`, ported from consumer-b's script.**
  - It is GitHub Actions only, through `gh`, which `github()` already needs. The repo
    comes from the worktree's `origin`, so there is no repo option.
  - Options: `workflows` (required names; all of them must succeed), `deadlineMinutes`
    (default 45) and `pollSeconds` (default 20). It takes `hint`, `retries` and `when`
    like every shape.
  - Every command goes through `ctx.exec`, the sleep included (`["sleep", "20"]`). So
    the tests drive it with a fake exec and no clock, and the dispatcher's log shows
    what it ran.
  - Without it, the next repo that wants a CI gate (consumer-b's frontend, or
    consumer-a) copies 120 lines of bash.

## Phase 1 — `afterLand` — `fd0c135`

- [x] 1a. Config and bridge
  - `afterLand?: string[]` in `SliceConfig`. It is validated like `install`: an array
    of non-empty strings, and `[]` means off.
  - `shArray("SLICE_AFTER_LAND", config.afterLand ?? [])` in `shellAssignments`, and
    the name in `slice-config.sh`'s header list.
- [x] 1b. `slice-land.sh`
  - The step after the cleanup, under the lock that is still held. The `EXIT` trap
    releases it afterwards.
  - It prints `── after the land: <cmd> ──`, then the command's output, then
    `✓ afterLand passed` or `✗ afterLand failed (exit N) — #n is landed and closed;
    the base needs a look before anything else lands`.
  - The new exit code goes in the header next to 75.
- [x] 1c. The dispatcher
  - Handle the new status in the land loop (`slice-run.ts:4258`).
  - Record the slice as landed (the block after `if (!ok)`), print the summary and
    exit as described above.
  - `--gates`/the run header gains a line `afterLand: <cmd>` when one is set.
- [x] 1d. README
  - A config table row.
  - A section "After a land" under "When a slice will not land" or next to "Gates":
    when it runs, the lock, the exit, what a failure does, no timeout, and an example
    health check.
- [x] 1e. Tests
  - slice-land: it runs after the push with both variables set. It does not run when
    the land is refused. A failure exits with the new code and leaves the land pushed
    and the ticket closed. A second land waits on the lock while it runs.
  - Dispatcher (`sliceRun.test.ts`): a failed `afterLand` lands that slice, lands
    nothing after it, says how to resume and exits with the stop code. A passing one
    changes nothing in the run.
  - Config: rejects `afterLand: "x"` and `[""]`.

### What building it found

- **The exit code is 3.** 1 is every refusal and 75 is "diverged". 3 is a code of its
  own and is documented in the script's header.
- **The finish at startup needed it too.** A dispatcher finishes an interrupted land
  before its first round (`slice-run.ts`, "Lands an earlier process pushed"), and that
  land ends at the same last step. Exit 3 there counts as finished. The round loop asks
  `stopForAfterLand()` before its land as well as after it, so round 1 lands nothing on
  top. A test covers it. With the check before the land removed, that test fails,
  because round 1 lands #41.
- **The header line, not `--gates`.** The run header says
  `afterLand: <cmd> — after every land, under the land lock; a failure stops the
  landing.`
- Eight tests:
  - four for `slice-land.sh`: environment and order, exit 3 with the land kept, not
    run on a refusal, the lock held while it runs;
  - two for the dispatcher;
  - one for the finish at startup;
  - one for the config refusing a bad `afterLand`.

  Three of the slice-land tests and both dispatcher tests failed before the change.
  The refusal test was already true.
- Full suite: 564/564. vitest also reported one unhandled
  `Timeout calling "onTaskUpdate"`. That is its own worker RPC under load, and it
  appeared once before this phase too.

## Phase 2 — `ciRuns()`, the CI gate as a shape — `b5da41f`

First deferred on 2026-10-22, because consumer-b's backend had a working script and no
other repo wanted a CI gate. Built the same day after all, on the user's go.

- [x] 2a. `ciRuns(opts)` in `slice-gates.ts`, exported from `index.ts`, with the
  behaviour of consumer-b's script:
  - It reads the SHA and branch in the worktree. A detached HEAD fails.
  - Already green on every named workflow: pass, no push.
  - Otherwise it notes the newest run id, pushes `HEAD:refs/heads/azelf-ci/<branch>-<sha12>`,
    and polls `gh run list --commit <sha> --json name,status,conclusion,databaseId`.
    Only runs newer than the noted id count, and the newest run per workflow decides.
  - A completed run that is not `success` fails, naming the workflow and the
    `gh run list` command. The deadline fails with "not finished after N minutes".
  - The throwaway branch is deleted in every outcome (`try`/`finally`).
- [x] 2b. Tests with a fake `exec`
  - already green, no push;
  - pushed then green;
  - one workflow red;
  - an old red run before the push does not count;
  - the deadline passes;
  - the push is refused;
  - the branch is deleted on green and on red;
  - detached HEAD.
- [x] 2c. README
  - "CI as a gate", under Gates: what it pushes and why per SHA, the trigger it needs
    (CI on a push to any branch, or at least `azelf-ci/**`), `gh` signed in, and to put
    it last.
  - The cost: the dispatcher waits inside it and holds the gate lock.

### What building it found

- **The branch is deleted before the push too.**
  - A dispatcher stopped while the gate waits leaves `azelf-ci/…` on origin at this SHA.
    Ctrl-C is enough: the dispatcher has no SIGINT handler, so the process ends without
    running the `finally` that deletes the branch.
  - Pushing that branch again changes nothing on GitHub and starts no workflow. The
    retry would wait out its deadline and go red.
- **The repo is origin's, read from its URL** (`ghRepoOf`).
  - The push goes to origin. With an `upstream` remote, `gh`'s own guess prefers
    `upstream`, and the gate would watch a repo nothing was pushed to.
  - An origin that is not a URL with a host (a local path, `file://`) fails at once.
    GitHub Enterprise hosts are passed as `host/owner/repo`.
- **gh failing is handled in two ways.**
  - Before the push, a failure fails the gate at once: not installed, signed out, or
    no such repo. consumer-b's script read a failure as "no runs", pushed, and waited
    the full 45 minutes.
  - During the wait, a failure counts as one look that found nothing. If the deadline
    passes, its message names the last failure.
- **The deadline counts waits.** It allows `ceil(deadlineMinutes × 60 / pollSeconds)`
  looks. The real wait runs past it by however long the looks themselves take, a second
  or two each.
- **The deadline message says what was missing.** It names the workflows still running
  and those that never started. For one that never started, it adds the likely cause:
  the workflow's name, or a missing trigger on `azelf-ci/**`.
- **gh's JSON is read from its own line.** `exec` joins stderr into `out`, so a warning
  from `gh` would otherwise break the parse.
- **The constructor refuses bad options at config load.**
  - `workflows: []` would pass every SHA.
  - An empty workflow name is refused.
  - So is a deadline or interval that is not positive.
- **26 tests.**
  - 16 against a scripted world: the eight from 2b, the deleted leftover branch, the
    name, origin not on GitHub, gh failing before the push and during the wait, the
    stderr warning, the constructor, and `retries`/`when`.
  - 9 URL forms for `ghRepoOf`.
  - One against a real bare remote under `runGates`, with only `gh` faked on PATH. It
    checks that the branch exists while CI is asked, is gone afterwards (remote-tracking
    ref included), and that the worktree stays clean.
  - Mutation check: counting the runs from before the push fails the test for the old
    red run.
- **Added after the plan:** a line in the dispatcher's log while the gate waits. Before,
  the dispatcher printed `running N gate(s) …` and then nothing until CI answered.
  consumer-b's script behaves the same way, because its echo goes into the captured
  output. `GateContext` has an optional `log` now, which the dispatcher prints indented
  under the gate count. `ciRuns` says the push, then each change in the workflows (not
  every look), with the time waited counted in waits like the deadline. A failed look is
  said once per streak. Four tests: three on the gate, one on the dispatcher's printing.

## Order and cost

Phase 1 goes first. No consumer has it yet, and it is what an unattended run lacks.
Expect three files of code (`slice-config.ts`, `slice-land.sh`, `slice-run.ts`), the
README section, and about eight tests.

Phase 2 is a port of a script that already works on one consumer. It pays off when a
second repo wants a CI gate. Until then it can wait, and nothing in Phase 1 depends on
it.

## Not in this plan

- **Gates that do not block the dispatcher.** A CI gate waits synchronously, like a
  long test suite. Making gates async touches the round loop and the gate lock.
- **A timeout for gates or `afterLand` in azelf.** The command bounds itself.
- **Undoing a land whose `afterLand` failed.** A revert is a person's decision.
- **CI providers other than GitHub Actions.**
- The rest of `docs/non-bun-consumer-plan.md`'s list: landing without the base branch
  checked out, blockers across two repos, and Python manifests in `INSTALL_MANIFESTS`.

## What the consumer does itself

consumer-b (the mapping is in `CONSUMERS.local.md`):
- **Backend:** it can swap `.azelf/ci-gate.sh` for
  `ciRuns({ workflows: ["Tests", "Docker-Gate"] })` once it pulls `b5da41f` or later,
  or keep its script. Both work. The port fails at once when `gh` cannot list the runs,
  and a retry after a dispatcher stopped mid-wait still starts CI.
- **`afterLand`:** a health check against the deployed backend, which bounds itself
  (`curl --max-time`, or a loop with a deadline). It also decides whether a failed
  check needs a revert.
