# A run that finishes its rebases, and says what its last review found

**Status:** COMPLETE — all three phases landed 2026-10-02 (`2ce6f58`, `4b5c168`, `ccb70b5`). The checks under "Checks only the consumer can make" are still open · **Written:** 2026-10-02
**Companion:** consumer-a's friction log (an untracked file in its main checkout, not in
this repo), entries dated 2026-09-25 and 2026-10-01. `docs/dispatch-safety-plan.md`
covers the entries ranked above these.

Written so it can be picked up cold. Each item says what to change, where, why, and what
proves it. Tick the boxes as they land and add the commit hash after the heading. Line
numbers are as of `03a8b86`; search for things by name once a phase has moved them.

## What happened

Three open entries, all about a run nobody is watching.

1. **A correct two-stop resolution was thrown away as "abandoned".** The log entry
   blames the last stop: it reads as if the second stop was never staged and continued.
   That is not the cause. `resolveConflict` (`slice-run.ts:1981`) stages and continues
   after every stop, and `sliceRun.test.ts` ("calls the resolver again for every commit
   that stops") covers two stops and passes.

   The cause is that the base branch moved while the resolver was working. On
   consumer-a a second dispatcher landed a slice onto the base at 17:48:41, and the
   rejection was written at 17:49. The rebase had finished, onto the base as it was
   when the resolution started. The final check asks
   `git merge-base --is-ancestor <baseBranch> HEAD` (`slice-run.ts:2166`) with the
   branch name, so it compared against the commit that landed a minute earlier, and
   `resolutionProblem` (`slice-resolve.ts:89`) reported the rebase as abandoned. `give`
   then reset the branch and discarded up to forty minutes of resolver work.

   A resolver gets twenty minutes per stop. Any run with two dispatchers on one base,
   or one dispatcher that lands while it resolves, can hit this.
2. **A parked conflict in a run without `--auto` has no agent path unless someone is at
   the prompt.** `tryLand` (`slice-run.ts:2459`) hands a conflict to the agent only when
   `--auto` is set. Otherwise `askAboutBlocked` offers `[a]`, and under `-y` or without
   a TTY it parks before the offer (`slice-run.ts:2421`). `azelf run -y 81 82 83` parked
   a slice on a conflict the resolver could have had.
3. **The plan-level review's findings go to a file nobody is pointed at, and the run
   exits 0.** `reviewPlan` (`slice-run.ts:1445`) returns nothing. The run prints
   `✓ every ticket closed — plan complete.`, then the review, then `report saved:`.
   Seen on three waves: two, two, and four findings, exit 0 each time.

## Decisions this plan makes

Each one changes behaviour someone may rely on. Overrule them before Phase 1 starts, not
after.

- **A resolution is judged against the commit it rebased onto, not the base branch's
  name.** If the base moved meanwhile, the land rebases again. That rebase usually
  applies cleanly, because it only covers the commits that arrived during the
  resolution.
- **A second conflict after a base move gets one more resolver pass, then parks.** Two
  passes per land attempt. The alternative is to park straight away, which keeps the
  resolver bill at one pass but leaves an unwatched run stuck on a conflict it has
  already half paid for.
- **`--auto-resolve` is a flag of its own, off by default without `--auto`.** `--auto`
  keeps implying it, and `--no-auto-resolve` keeps turning it off. Without `--auto` a
  human released the slice's code, not the resolution, so:
  - with review on, the spec review **blocks** for a slice whose rebase an agent
    resolved, instead of being advisory;
  - with review off, the gates are the only check, and the run header says that.
- **A plan review with findings exits 2.** Exit 1 keeps meaning "work is left". Exit 2
  means "everything landed and the last review has something to read". A review that
  did not return, or has no parseable count, also exits 2, with its own last line.
  This matches the spec review, which treats no verdict as BLOCK
  (`slice-run.ts:1361-1373`).
- **No tickets are filed from findings.** The tracker contract has no `create`, and a
  finding needs a human to decide whether it is one ticket, three, or none.

## Phase 1 — a resolution survives the base moving under it (`2ce6f58`)

- [x] **1a. `resolveConflict` pins the base.** At the top, next to `head`
  (`slice-run.ts:1993`), read `onto = git rev-parse <baseBranch>`. Use `onto` for the
  rebase (`slice-run.ts:2028`), for `landedCommits`, for `after`
  (`changedIn(wt, onto...HEAD)`), and for the `rebased` check
  (`slice-run.ts:2166`). `before` and `replayed` are read against the same commit.
  - `ResolutionState.base` stays the text used in the message. Pass
    `<baseBranch> at <sha7>`, so a rejection names the commit it compared against.
  - If `onto` cannot be read, return `give("could not read <baseBranch>")` before the
    rebase starts.

- [x] **1b. `tryLand` rebases again after a resolution.** Today a successful
  `resolveConflict` falls through to the gates (`slice-run.ts:2460-2473`). Change the
  top of `tryLand` into a loop of at most `RESOLVE_PASSES = 2`:
  1. `rebaseOntoBase(t)`. If it is fine, leave the loop.
  2. If no resolver is to be used, park as today.
  3. `resolveConflict`. If it fails, park as today.
  4. Go to 1. When the base did not move this is one `is-ancestor` call.

  After the second pass, a rebase that still conflicts parks with kind `rebase` and the
  reason `<base> moved twice while the agent was resolving, and the newest commits
  conflict too`. No `[a]` is offered for that park.
  - The interactive path in `park` (`case "resolve"`, `slice-run.ts:2544`) already
    re-enters `tryLand`, so it gets the same loop.
  - Print one line when the loop goes round:
    `<base> moved during the resolution (<old7> → <new7>) — rebasing onto the new commits …`

- [x] **1c. The "abandoned" message says what was checked.** In `resolutionProblem`
  (`slice-resolve.ts:89`): `the branch is not on <base> — the rebase did not complete`.
  "Abandoned" claimed a cause the check cannot know.

- [x] **1d. Tests.**
  - `sliceResolve.test.ts`: the reworded message.
  - `sliceRun.test.ts`, in "resolving a rebase conflict", with a fake resolver that
    also commits on main while it resolves:
    - a commit to an unrelated file: the slice lands, one resolver call, the output
      has the "moved during the resolution" line, the transcript says ACCEPTED;
    - a commit that conflicts with the branch again: two resolver calls, the slice
      lands;
    - a resolver that moves main on every call: two calls, exit 1, parked with the
      "moved twice" reason, and the branch is rebased onto the first two bases (the
      accepted resolutions are kept, not reset).

  **Proof:** the three tests fail on `03a8b86` (the first with "abandoned") and pass
  after 1a and 1b.

**As landed.** The three tests failed on `03a8b86` with the rejection from the log and
pass now. Three things differ from the text above:

- An unreadable base prints one line and returns before the rebase, without a
  transcript: `give` writes the transcript and is defined after the rebase starts.
- The "moved during the resolution" line is printed by `resolveConflict` when it
  accepts, not by the loop in `tryLand`, because only it knows the commit it rebased
  onto.
- `README.md` gained a paragraph on the base moving (not listed in the phase).

## Phase 2 — `--auto-resolve` without `--auto` (`4b5c168`)

- [x] **2a. The flag.** In `slice-run.ts:2719`:
  - `--auto-resolve` and `--no-auto-resolve` together: usage error, exit 64.
  - `resolveUnasked = agent.resolve && (flag("--auto-resolve") || (autoLand && !flag("--no-auto-resolve")))`.
    This replaces `decide` in `tryLand`.
  - `--auto-resolve` with an agent that declares no resolver: refuse before dispatch,
    exit 1, `<agent> declares no resolver — --auto-resolve has nothing to run`.
  - `[a]` at the prompt keeps its current rule (`canResolve`, `slice-run.ts:2425`).
  - Add the flag to `FLAGS` and the usage text in `slice-run-usage.ts`.
    `resumeCommand` copies flags already, so a resumed run keeps it.

- [x] **2b. A resolved slice's review blocks.** Keep a `Set<TicketId>` of slices whose
  rebase an agent resolved in this run, filled where `resolveConflict` returns true. In
  `reviewSlice` (`slice-run.ts:1413`), block when `reviewBlocks` is set or the ticket
  is in the set. The advisory line (`slice-run.ts:1428`) is unchanged for slices that
  were not resolved.

- [x] **2c. The run says so.**
  - Header (`slice-run.ts:2917-2926`), for `--auto-resolve` without `--auto`:
    - review on: `conflicts: a failed rebase is handed to the agent, re-verified and gated; the spec review blocks a slice that was resolved.`
    - review off: `conflicts: a failed rebase is handed to the agent, re-verified and gated. Review is OFF: the gates are the only check on a resolution.`
  - The non-interactive park line (`slice-run.ts:2422`), when the park carries
    conflicted files, the agent has a resolver, and `--no-auto-resolve` is not set,
    gains: `--auto-resolve lets the agent resolve it`.

- [x] **2d. Docs.** `README.md` (flag table at 237, the paragraph at 920),
  `agent/commands/azelf.md:82` and `.claude/commands/azelf.md`: the flag, what it
  implies for the review, and that `--auto` still implies it.

- [x] **2e. Tests** (`sliceRun.test.ts`):
  - `-y --auto-resolve 40` without `--auto`, slice marked done by hand, conflict with
    main: one resolver call, the slice lands;
  - the same without the flag: parked, and the park line names `--auto-resolve`;
  - with `--review` and a fake reviewer that says BLOCK: a resolved slice is not
    landed; an unresolved slice in the same mode still lands with the advisory line;
  - both flags together: exit 64;
  - the flag with an agent that has no resolver: exit 1 before any session starts.

**As landed.** As written, with these details:

- The set of resolved slices is filled inside `resolveConflict` when it accepts, so a
  resolution taken with `[a]` at the prompt makes the review block too.
- The park line's hint is its own line under `parked (non-interactive)`, and is left
  out once the agent has tried and failed.
- An extra test covers that last case.

## Phase 3 — the plan review's outcome is the run's outcome (`ccb70b5`)

- [x] **3a. The review counts its findings.** In `reviewPlan`'s prompt
  (`slice-run.ts:1463`), replace the "say exactly" sentence with a final line, as the
  spec review does: `FINDINGS: <number>`, and `FINDINGS: 0` with the sentence
  "No cross-cutting findings." above it when there are none. `reviewPlan` returns
  `{ findings: number | null, path: string } | null`:
  - `null` when the review did not run (review off, empty diff);
  - `findings: null` when the agent did not return or printed no parseable line. The
    report gets a note, as the spec review's does.

- [x] **3b. Exit code and last line.** Store the result at the call site
  (`slice-run.ts:2983`). After every other summary at the end of the file (the parked
  block, `slice-run.ts:3276`), print one of:
  - `plan review: no cross-cutting findings.` (exit code unchanged)
  - `plan review: <n> finding(s), all of it already landed → <path>` and exit 2
  - `plan review: no result — it did not return, or gave no count → <path>` and exit 2

  Exit 2 is set only when the code would otherwise be 0.

- [x] **3c. Docs.** The header's review line (`slice-run.ts:2900-2906`) gains
  `findings exit 2`. `README.md` and both `azelf.md` copies get the three exit codes in
  one place: 0 done, 1 work left, 2 landed with plan-review findings, 64 usage.

- [x] **3d. Tests** (`sliceRun.test.ts`), with a fake review agent that answers the
  plan prompt (it contains "cross-cutting") differently from the spec prompt:
  - `FINDINGS: 2`: exit 2, the last line of the output is the findings line with the
    report's path;
  - `FINDINGS: 0`: exit 0, last line says no findings;
  - no `FINDINGS` line, and an agent that exits non-zero: exit 2, the "no result" line;
  - `--no-review`: exit 0, no plan-review line.

**As landed.** As written, with these details:

- The prompt keeps the "No cross-cutting findings." sentence and adds the
  `FINDINGS: <number>` line after it. The parser takes the last such line and
  tolerates markdown emphasis around it.
- `runDispatcher` in the test fixture now also returns `stdout` on its own: its `out`
  is stdout followed by stderr, so `git push`'s progress came after the run's real
  last line.

## After each phase

- `bunx vitest run`, `bunx tsc --noEmit`, `bunx biome check scripts tests`.
- Scan the diff for a consumer's real name before the commit.
- Set the friction-log entry's `Status:` line in the commit that lands the phase.

## Checks only the consumer can make

After the bump and `bunx azelf init`, with no dispatcher running:

- Two dispatchers on one base, one of them resolving: the resolution lands after the
  other one's land, with the "moved during the resolution" line in the log.
- `bunx azelf run -y --auto-resolve <ids>` on two siblings that edit the same file.
- A wave whose plan review has findings: `echo $?` prints 2.

## Not in this plan

Still open in the friction log, ranked below these:

- Run-log noise: the round line's counts after a land, the same-files warning for a
  branch cut on top of the landed slice, "prepped, not launched" before "opened 1 tab".
- Script ergonomics: `session-commit.sh --push` for an existing commit, `-F <file>`,
  `format.sh` on paths that do not exist.
- Review design: the spec reviewer cannot read the parent spec or run a test against
  the base; a contract between sibling slices is only seen by the plan review.
- A warning up front when two siblings in one wave both add to the same shared file.
- Filing plan-review findings as tickets.
