# CI that never started is not red, a run without CI, and CI read after the land

**Status:** Phase 1 (f748a86) and Phase 2 (5bfa8bc) landed 2026-11-22
**Written:** 2026-11-22
**Companion:** consumer-b's friction entries of 2026-11-22: "Backend #246, #247 · dispatcher" (Actions
out of minutes, two green slices parked as red) and the maintainer's own entry beneath it (two CI runs per land).
The other entries of that day are not in this plan: #246's slice entry is the consumer's ticket
cutting, the `bunx azelf` one is covered by `findable-and-finished-plan.md`, and `--parent` is a
separate idea.

Written so it can be picked up cold. Tick the boxes as they land and add the commit hash after the
heading. Line numbers are as of `05f1af2`.

## What happened

1. **A CI that never started was read as a red CI.** The account's Actions minutes ran out. Every job
   ended after two seconds, without a single step, with the annotation "The job was not started
   because recent account payments have failed or your spending limit needs to be increased. Please
   check the 'Billing & plans' section in your settings". `ciRuns` saw `conclusion: failure` on the
   newest run (`verdict`, `slice-gates.ts:527-538`) and returned "CI: `Tests` is failure on b8f0fea".
   The slice parked as `gates` with "the gates are red". Two finished slices, green locally, were
   parked, and two more waited behind them. The cause was found with `gh run view <id>` and the
   job's annotation, about 15 minutes. The dispatcher log never said that no job had started.

   What GitHub returns, read on the real runs:
   - `gh run view <id> --json jobs`: one job, `conclusion: failure`, `steps: []`, two seconds long.
   - The message is in neither `gh run view` nor the check run's `output`. It is only in
     `gh api repos/<repo>/check-runs/<job id>/annotations`: one annotation, level `failure`, path
     `.github`.
   - A real red run of the same repo has steps (8 per job).

2. **Turning CI off meant editing the config and restarting.** The way out was to comment `ciRuns`
   out of `slice.config.ts`, stop the dispatcher with SIGINT, and start it again. The edit alone did
   nothing: the config is imported once at start (`slice-config.ts:892`), and nothing says so. No land
   records that it went without CI.

3. **Every land costs two CI runs.** One on the throwaway `azelf-ci/<branch>-<sha>` before the land,
   one on main after the push. Since every workflow ran on every branch, that was three workflows twice,
   and one of them (a security scan) was not even in `ciRuns`' list. One wave used up a private repo's
   free minutes. Without minutes the CI is also gone for everything else: the co-maintainer's pushes,
   the Docker gate on main.

   **The consumer has already changed this.** Later that night consumer-b's workflows were set to
   run only on a push to main and on `workflow_dispatch`. Branch pushes trigger nothing any more.
   That saves the minutes, but it also means `ciRuns` as built can no longer work there. Its push to
   `azelf-ci/…` starts no workflow, and the gate would wait its 45 minutes and report "never started"
   for every slice. The commented-out `ciRuns` in consumer-b's config cannot simply be switched back on.

## Decisions

- **"Never started" is its own verdict, not red.** A completed run that is not a success is first
  asked whether it ran at all:
  - `conclusion: startup_failure` means no.
  - So does a run whose jobs are all without a step, or that has no job.
  - So does a run that was cancelled before a step ran.

  Only then does azelf read the annotation of the first job. Its `message` goes into the log word for
  word. A run that started and failed is red as before. If one workflow is red and another never
  started, red wins, because the slice may be the cause. If the extra calls fail (network, gh), the
  run counts as red, as it does today. That is the conservative answer, and it costs only the base
  retry.
- **A gate can say "I could not judge".** `GateResult` gets `unavailable?: true`: the gate did not run
  its check, and the slice is not the cause. `ciRuns` is the only shape that sets it. `runGates` does
  not retry such a gate, because its `retries` are for flakiness under load, and a billing block does
  not clear in seconds. A red run counts as unavailable only when every failure in it is.
- **A slice that could not be judged parks as `ci`, with no automatic base retry.** A new `ParkKind`.
  CI does not come back because main moved, and retrying would push and wait once per base move for
  nothing. It retries when its branch moves or on `azelf retry`. A resolved rebase whose CI never
  started does not go back to its resolver: there is nothing to repair. When every open slice is
  parked, the run stops as it already does ("nothing can advance", `slice-run.ts:7789`). Its summary
  says once what GitHub said, and gives the two ways on: the same command once CI runs again, or the
  same command with `--no-ci`.
- **`--no-ci` is a flag for one run, not a config edit.** It skips every `landOnly` gate. `ciRuns` is
  the only shape that makes one; `landOnly` already means "judges the pushed commit", and
  `azelf gates` skips exactly those. With Phase 3 it also switches off the watch after the land: the
  flag means "this run has no CI". The flag goes into `resumeCommand()` by itself, since `runCommand`
  keeps every flag (`slice-run.ts:7956`).
- **The preamble says what goes missing, in the consumer's words.** azelf cannot know what a CI
  checks that the local gates do not. consumer-b's answer: a clean install on Linux without `.env`,
  and the Docker image build with its native library load probe. `ciRuns({ covers })` takes it as one
  string, and `--no-ci` prints it in the preamble.
- **Every land without a CI verdict gets one line in `.slice-reviews/landed-without-ci.md`.** That
  is the main checkout's `.slice-reviews/`, which `azelf init` already excludes and which outlives
  the worktrees. The file is append-only and starts with one paragraph: one green CI run on the base's
  head covers every line above it, and `gh workflow run <name> --ref <base>` starts one. Phase 2 writes
  a line for each land under `--no-ci` where a `landOnly` gate would have run, judged by its `when`.
  Phase 3 writes one for each land whose CI on main never started, was cancelled without a successor,
  or did not appear before the deadline. A land that skips `ciRuns` because of `when` gets no line:
  that is the configured rule, not an exception.
- **The config is not reloaded during a run.** It holds functions: gates with closures, the tracker,
  the launcher, the agent. A half-reloaded config (new gates, old tracker) is a state nobody tests.
  A reload would also change what a slice that was already gated was judged by. Instead, the
  preamble says that the config is read once. Each round compares the config file's mtime with the
  one at start, and the first change is reported once, with the command to pick the run up again.
  This works the same way as `noteAzelfChange` (`slice-run.ts:7303`). With `--no-ci` and the `ci`
  park, the case that prompted the edit no longer needs one.
- **CI after the land reads the run that happens anyway.** The push to main starts the workflows.
  `afterLandCi: { workflows }` reads their verdict on the landed SHA, once per round. It does not
  hold the next land. That would be `ciRuns` again, a five-minute wait per land. The cost of not
  waiting is that a land that falls during a red run's five minutes lands on top of it. That risk is
  accepted.
- **A red run on main stops the landing, like a failed `afterLand`.** The same stop
  (`stopForAfterLand`, `slice-run.ts:7335`) with its own reason line: which ticket, which SHA, which
  workflow, and the run URL. The land stays landed and closed. Sessions keep working, and the same
  command picks the run up again. A workflow that is red on main for reasons of its own does not go in
  the list. consumer-b's security scan is one.
- **A cancelled run on main is judged by the push after it.** consumer-b's `tests.yml` cancels an
  in-progress run on main when a newer push comes (`cancel-in-progress`). If this run landed a later
  SHA, that one's verdict covers both, and the line says so. If main moved past the SHA through
  someone else, the line says that the next run on main decides, and the watch ends. Otherwise the
  run was cancelled by hand, and the land gets a line in `landed-without-ci.md`.
- **The last land is waited for.** Before the summary, the run waits for open watches, at most
  `deadlineMinutes` (default 30), printing each change. On SIGINT it stops waiting.
- **Before the land, `ciRuns` can start the workflows by hand-start.** `trigger: "dispatch"`: push
  the branch as now, then `gh workflow run <name> --ref azelf-ci/…` per workflow. This works with
  workflows that run only on main and `workflow_dispatch`, which is consumer-b's setup now. It starts
  only the listed workflows, not every workflow on the branch. The default stays `"push"`. Together
  with `when` this means "CI before the land only for the Docker paths".

What a land costs in CI, per configuration:

| Configuration | CI runs per land |
| --- | --- |
| Today (`ciRuns` on push, all workflows on every branch) | every workflow twice |
| `afterLandCi` only | once, the run on main that happens anyway |
| `afterLandCi` + `ciRuns({ trigger: "dispatch", when })` | once, plus the listed workflows on a land that touches a `when` path |
| `--no-ci` | the run on main, unread |

## Phase 1 — a CI that never started parks as `ci`, with GitHub's words (f748a86)

- [x] 1a. A module `scripts/slice-ci.ts` for reading GitHub Actions:
  - Move `ghRepoOf` and `CiRun` there from `slice-gates.ts:351-390`. `slice-gates.ts` re-exports
    `ghRepoOf` so that `index.ts` does not change. `CiVerdict` stays with `ciRuns`: it is that
    gate's own view, with a `done` case for the failed runs it then classifies.
  - Pull the run listing out of `ciRuns`' closures (`look`, `slice-gates.ts:505`) as
    `listRuns(exec, cwd, repo, sha)`, and the command a failure names as `listRunsArgv`.
  - Pull the decision out the same way (`verdict`, `:527`) as `newestPerWorkflow(runs, workflows, after)`.
  - New: `whyNotStarted(exec, cwd, repo, run): string | null`. It returns `null` for a run that
    started. Otherwise it returns GitHub's message: the first `failure` annotation of the first job,
    or else `startup_failure`, "no job ran a single step", or "it was cancelled before a job
    started". If the jobs cannot be read, it returns `null` (counted as red, see Decisions). If only
    the annotation cannot be read, the run still did not start, and the words are azelf's own.
    A GitHub Enterprise repo is asked through `gh api --hostname`.
- [x] 1b. `GateResult` (`slice-gates.ts:91`) gets `unavailable?: true`, with a doc comment.
  `ciRuns`: among the completed, unsuccessful newest runs, a started one is red as today. When none
  of them started, the gate returns
  `{ ok: false, unavailable: true, why: "CI: \`Tests\` did not start on b8f0fea — GitHub: «…»", detail: [url, "gh run view <id> -R <repo>"] }`.
  The `hint` is not appended, because it speaks to a red CI ("the CI on the push SHA is not green").
- [x] 1c. `runGates` (`slice-gates.ts:737`): no retry after an `unavailable` result. `GateFailure`
  carries the field. `GatesResult` gets `unavailable: true` when every failure has it.
- [x] 1d. `gatesPass` (`slice-run.ts:3518`) keeps the answer, with the gate's line, in a map
  `gatesUnavailable`, next to `gateFailures`. `tryLand` (`:5640`): when the set has the slice, `park(t, "ci", <why>)`, before
  `repairResolution`.
- [x] 1e. `ParkKind` (`:4847`) gets `"ci"`. `retryDue` (`:4935`) has no base trigger for it, because
  the existing conditions name `gates` and `land` explicitly. `waysOut` (`:5225`): "retried when its
  branch moves, or now with: azelf retry <id>, once CI runs again".
- [x] 1f. The summary after the parked list (`:7983`): when any park is `ci`, one line. It names the
  slices that wait for CI and not for a fix, and points to the resume command below it. GitHub's
  message is already in each parked line, because the park reason is the gate's line.
- [x] 1g. Tests:
  - `sliceGates.test.ts`, next to the ciRuns tests (`:691`), with the fake `exec`. The billing case:
    a failed run, a job without steps, the annotation. It is unavailable and its `why` has the message.
    Also `startup_failure` is unavailable, and so is a job without steps and without an annotation.
    A run with steps is red. One workflow red and one not started is red. When `gh run view` fails
    during the classification, the run is red. `runGates` does not retry an unavailable gate that
    has `retries: 2`.
  - `sliceRun.test.ts`: a gate that returns `unavailable` parks the slice as `ci`. A base move does not
    retry it, and `azelf retry` does. The summary of a run that ends on it has the line.

## Phase 2 — `azelf run --no-ci`, a record of lands without CI, a config that says it is frozen (5bfa8bc)

- [x] 2a. `--no-ci` in `slice-run-usage.ts`: in `FLAGS` (`:63`) and in `USAGE`, one line: "skip the
  gates that wait for CI (ciRuns) in this run; each land is noted in .slice-reviews/landed-without-ci.md".
- [x] 2b. `gatesPass` (`:3549`): with `--no-ci`, filter `landOnly` as `byHand` does. The line becomes
  "skipped `CI: …` — --no-ci". Keep the list of skipped gates that *would* have run (per `when`) for
  2e.
- [x] 2c. `ciRuns({ covers })` (`CiRunsOptions`, `slice-gates.ts:338`): an optional string, what this
  CI checks that the local gates do not. It is carried on the `Gate` as `covers`. The config refuses
  an empty one.
- [x] 2d. Preamble (`slice-run.ts:7189`, after the gates line):
  - With `--no-ci` and a `landOnly` gate: "CI: OFF (--no-ci) — `CI: Tests, Docker-Gate` does not run
    before a land. It also checks: <covers>. Each land is noted in .slice-reviews/landed-without-ci.md."
  - With `--no-ci` and no such gate: "--no-ci: no gate here waits for CI — the flag changes nothing."
  - Always: "config: <configPath>, read once at start — an edit takes effect when the run is started
    again."
- [x] 2e. After a land under `--no-ci` in which a `landOnly` gate would have run, append one line to
  `.slice-reviews/landed-without-ci.md`. The header paragraph is written when the file is created.
  Line format: `- 2026-11-22 21:40 · #246 · main at 3e812a7 · not run: CI: Tests, Docker-Gate (--no-ci)`.
  A function `noteWithoutCi(id, sha, what, why)` that Phase 3 reuses.
- [x] 2f. The run's last word, after the parked list: "landed without CI: #246, #247 — see
  .slice-reviews/landed-without-ci.md", when there were any.
- [x] 2g. The `ci` park's `waysOut` and the summary block from 1f add: "or land without CI:
  <runCommand with --no-ci>".
- [x] 2h. `noteConfigChange()` next to `noteAzelfChange` (`:7303`), called in the round loop beside it
  (`:7464`). It compares the mtime of `configPath` with the one at start, and reports the first change
  once: "slice.config.ts changed at HH:MM, after this run started. This run keeps the config it started
  with, gates included. To apply the change: stop it with Ctrl-C when nothing is landing, then
  <resumeCommand>." It is reported again only after a further change.
- [x] 2i. Tests (`sliceRun.test.ts`):
  - With `--no-ci`, a `landOnly` gate is not called, the land goes through, and the file has one
    line under its header.
  - `--no-ci` with a `when` that the slice does not match writes no line.
  - The flag is in the resume command.
  - A touched config prints the line once, and a second touch prints it again.
  - `--no-ci` without a `landOnly` gate says that it changes nothing.

As built, where it differs from the above:

- 2d: under `--no-ci` the gates line names only the gates that run. The OFF line ends "Each land it
  would have judged is noted …", because a gate's `when` can leave a land out. Without `covers` it
  says that nothing names what goes unchecked. The config line reads "an edit reaches this run's gates
  when the run is started again".
- 2g: a running dispatcher's park line says "to land it without CI, stop this run and start it again
  with --no-ci". A second run cannot take a slice this one owns, so a command there would be refused.
  The end summary prints the whole command, as planned.
- 2h: the line also says that `slice-land.sh` and the sessions' own `azelf gates` read the new file.
  They source the config afresh, so the run and its scripts disagree until the restart.
- Beyond the plan: the README (flag table, "CI as a gate", "What retries a parked slice", the
  configuration reference) and `agent/commands/azelf.md`, which tells the agent that a `ci` park is
  not a fix and that turning CI off is the user's call. Phase 1's behaviour was not in the README
  either, and is now.

## Phase 3 — `afterLandCi`: read the CI on the landed SHA and stop on red

- [ ] 3a. `slice-config.ts`: `afterLandCi?: { workflows: string[]; deadlineMinutes?: number }`
  next to `afterLand` (`:129`). The doc comment carries the Decisions in short. Validation like
  `ciRuns`': at least one workflow, no empty name, a positive deadline. The default deadline is 30.
- [ ] 3b. `slice-run.ts`: after a successful land (`tryLand`, where `landedHeads` is set, `:5740`),
  add a watch `{ id, sha: landedAt, since }` unless `--no-ci` is set. Once per round,
  `watchLandedCi()` runs after `stopForAfterLand()` and before the land (`:7499`). For each open
  watch it calls `listRuns` and `newestPerWorkflow` from `slice-ci.ts`, then decides:
  - All green: `CI on main at 3e812a7 (#246's land): Tests, Docker-Gate passed`. The watch is done.
  - A started red run: the stop, see 3c.
  - Cancelled: see Decisions. With a later watch of this run, the line names the later SHA. With
    main moved past the SHA by someone else, the line says so. Otherwise: `noteWithoutCi`.
  - Never started (`whyNotStarted`): the line with GitHub's message, then `noteWithoutCi`. The watch
    is done and nothing stops.
  - Missing after the deadline: "no `Tests` run on 3e812a7 after 30 minutes — not checked (does it
    run on a push to main?)", then `noteWithoutCi`.
  - A failing `gh` call is one look that found nothing, as in `ciRuns`. At the deadline the line names
    the last error.

  Only changes are printed, not every look, as in `ciRuns`' `tell`.
- [ ] 3c. Generalise `afterLandFailed` (`:5336`) to `baseFailed: { id, why } | null`, and make
  `stopForAfterLand` into `stopForBase`. The reasons:
  - "afterLand failed after it", as today.
  - "CI `Tests` is red on main at 3e812a7, after #246 landed: <url>". If later lands are on top of
    it, the reason names them: "#247 landed on top of it before the result came in".
- [ ] 3d. Before the summary (after the loop, before `:7983`), open watches are waited for. A look
  every 20 s, at most until each watch's deadline, with the line "waiting for CI on main for #246,
  #247 (at most N min) …". A red result here sets the exit code and prints the stop's lines without
  the resume block. SIGINT ends the wait (`watchSignals`).
- [ ] 3e. Preamble: "CI after each land: `Tests`, `Docker-Gate` on the landed SHA, read each round —
  a red one stops the landing." With `--no-ci`: "CI after each land: off (--no-ci)."
- [ ] 3f. Tests (`sliceRun.test.ts`, with a stub `gh` on `PATH`, as the overlap report's test stubs
  `git`):
  - Green prints the line and the run goes on.
  - Red stops before the next land, with the URL and the resume command.
  - Two lands, the first cancelled and the second green, print "judged with" and do not stop.
  - Never started writes `landed-without-ci.md` and does not stop.
  - Missing after the deadline writes the line.
  - `--no-ci` makes no `gh run list` call.
  - The end of the run waits for a watch that is still open and prints its verdict.

## Phase 4 — `ciRuns({ trigger: "dispatch" })` for workflows that run only on main

Only needed if consumer-b's decision (see "What the consumer does itself") keeps a CI check before
the land. Without this phase that check cannot run there.

- [ ] 4a. `CiRunsOptions` gets `trigger?: "push" | "dispatch"`, default `"push"`. With `"dispatch"`,
  after the push of `azelf-ci/…` (`slice-gates.ts:582`), run
  `gh workflow run <name> -R <repo> --ref <ciBranch>` once per workflow. A refusal is red at once,
  and its message names the cause: the workflow has no `workflow_dispatch` trigger, or the name is
  wrong. The network gets the same retry as the push (`patiently`). The rest is unchanged:
  dispatched runs show up in `gh run list --commit <sha>`, and the `after` filter applies to them.
- [ ] 4b. The deadline hint for a workflow that never started (`:645`) names the trigger: for
  `"push"` as today, for `"dispatch"` "it was dispatched — check the workflow's name".
- [ ] 4c. Tests (`sliceGates.test.ts`): `dispatch` calls `gh workflow run` once per workflow with
  the CI branch as the ref, after the push and before the first look. A refused dispatch is red with
  gh's message. `push` makes no such call.

## Unobserved, once built

- Phase 1: the annotation for other kinds of "not started", such as a workflow file error or a
  disabled workflow.
- Phase 3: how often consumer-b's `cancel-in-progress` cancels a watched run on main, and whether a
  red main is ever found after a second land on top of it.
- Phase 4: whether a dispatched Docker gate on a branch builds the way it does on main. consumer-b's
  workflow says a dispatch always builds.

## Order and cost

Phase 1 (medium: the new module and the park kind), then Phase 2 (small), then Phase 3 (medium),
then Phase 4 (small). One commit each, and each is useful on its own. Phase 3 reuses Phase 1's module
and Phase 2's record. Phase 4 needs only Phase 1. Leave it out if the consumer decides on "after the
land only".

## Not in this plan

- **Reloading the config during a run.** See Decisions.
- **Retrying a `ci` park on a timer.** CI comes back when a person fixes the account. After that,
  one command retries everything.
- **An answer "[c] land without CI" in the interactive question.** `--no-ci` is the same decision,
  made for the whole run, and in the run's command line, where it is seen.
- **A comment on the ticket when main is red after its land.** The tracker contract has only
  `close(id, comment)`. A comment call would be a change to every tracker.
- **Holding the next land until the last one's CI is green.** That is `ciRuns` before the land.
- **Health checks after the land** (`/healthz`, `/readyz`, the version endpoint). That is what
  `afterLand` is for already, as a script of the consumer's.
- **A watch that survives a restart.** The resumed run does not look at lands from before it. The
  run on main is in `gh run list` for anyone who looks.
- **Batching lands** (one CI for several tickets): decided out in `relaunch-and-blips-plan.md`.

## What the consumer does itself

- **consumer-b decides the rule first, with its co-maintainer.** The rule is "green CI on the push SHA
  before main moves". It is shared and stands in the repo's CLAUDE.md. The two shapes:
  - *After the land only:* `afterLandCi: { workflows: ["Tests", "Docker-Gate"] }`, and delete the
    commented-out `ciRuns`. The rule becomes "green CI on the landed SHA, read after the push; a red
    one stops the next land". One run per land, and it is the one that happens anyway.
  - *Before the land for the Docker paths, after it for everything:* the above, plus
    `ciRuns({ workflows: ["Docker-Gate"], trigger: "dispatch", when: ["Dockerfile", "requirements*.txt", "render.yaml", ".github/workflows/**"], covers: "…" })`.
    This needs Phase 4.
- **Do not switch the commented-out `ciRuns` back on as it is.** Since the workflows run only on main
  and on hand-start, its push starts nothing. Every slice would wait 45 minutes and park.
- **Leave the security scan out of both lists.** It is red on main for reasons of its own, and in
  `afterLandCi` it would stop every run.
- **When the minutes are gone:** `azelf run --no-ci …`, and after the account is fixed, start one run
  on main by hand (`gh workflow run Tests --ref main`). It covers every line in
  `landed-without-ci.md`.
- **Both consumers, after each phase:** pull or bump, and restart running dispatchers. No phase adds a
  shim, so no `azelf init` is needed.
