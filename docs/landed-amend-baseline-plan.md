# A session sees the conflict coming, can fix its last commit, and can measure the base

**Status:** in progress · Phase 1 (c48e39f) and Phase 2 (3a31af0) landed 2026-11-13
**Written:** 2026-11-13
**Companion:** consumer-b's friction entries of 2026-11-10 (Backend #233, #240) and 2026-11-12
(Backend #237). Those are the open ones since `at-commit-gates-plan.md`. #197 went into that plan and
#227 into `one-session-plan.md`. #231 and Frontend #164 are the consumer's (see "What the consumer
does itself"), and so is consumer-a's one open entry of 2026-11-12.

Written so it can be picked up cold. Tick the boxes as they land and add the commit hash after the
heading. Line numbers are as of `8656917`.

## What happened

1. **The landed note did not say the rebase would conflict (#237).** Two slices landed on files
   that #237 had changed too. `.slice-landed.md` named them and said "Your branch does not have them
   until it is rebased at land". It did not say that the rebase already conflicted, in a docs file
   both had edited. The session found that out with its own `git merge-tree` and rebased before
   doing anything else. Without that probe the land would have stopped at the rebase, or gone to
   the resolver, and this ticket had already been blocked once. The note is written by `noteLanded`
   (`slice-run.ts:3068`), which knows only the shared file names. `conflictBetween`
   (`slice-run.ts:6190`) asks git the real question for the overlap report and is not used here.

2. **A slice cannot amend its last commit (#233).** consumer-b's rule is: behaviour and docs in
   the same commit. The slice may only commit through `session-commit.sh`, and that has no
   `--amend` (`session-commit.sh:51-62`). The docs written after the code commit went in as a
   second commit, and a wrong file count in a commit message could no longer be corrected.

3. **A slice has no way to run something on its base (#240).** consumer-b wants a suite baseline
   as a pair, SHA and result, on the base and without the slice's changes. The slice's worktree
   already has them. The session made a detached worktree by hand in its scratchpad and removed it
   afterwards. Two lands on the same lines of an inventory test meant two rebases and two more
   suite runs. In the end the baseline matched an intermediate base, not the last one. About ten
   minutes of suite runs and manual work. azelf already builds exactly this kind of throwaway
   checkout for `testOnBase` (`testsOnBase`, `slice-run.ts:2935`), but only for the reviewer.

## Decisions

- **The conflict check runs where the note is written, and only there.** A note exists only when
  a land shared files with an open slice, and only those can conflict at its rebase in a way the
  session has to see. That is one `git merge-tree` per noted slice per land, through
  `conflictBetween` and its cache. It checks what is committed. Uncommitted work is not in it, and
  the note says so.
- **A conflict tells the session to rebase now, itself.** The session knows its own change better
  than the resolver does at the land, and a rebase done early is one the land does not have to do.
  A clean answer is said too, in one line: "checked, goes through". A git too old for `merge-tree
  --write-tree`, or one that cannot answer, adds nothing, and the note stays as it is today.
- **`--amend` only in a slice worktree.** In the shared main checkout another session may have
  committed between yours and the amend, and then `--amend` rewrites their commit. In a slice
  worktree, branch and session are one.
- **Only a commit nobody else has.** Refused when HEAD is on the base branch, on any remote-tracking
  ref, is a merge, or the slice has already handed itself in (`.slice-ready-to-land` or
  `.slice-finished`): then the dispatcher may be gating that very SHA.
- **Amend keeps the script's rules.** Named paths only, no bulk stage, the same DB-lock check, the
  same `atCommit` gates afterwards. With paths and no message the old message is kept. With a
  message and no paths only the message changes (`--only`, so a stray staged entry does not ride
  along). With neither, it refuses.
- **On-base runs a command, not the gates.** Run on the base, the gates read an empty diff. A zone
  gate passes for nothing, and `ciRuns` would push a CI branch for a commit that is already on
  main. What a session wants on the base is one command, usually its suite. azelf runs it and
  reports. Counting tests is the consumer's.
- **The base is the commit the branch sits on (its merge base), not the tip of main.** That is the
  tree "mine without my changes", the comparison the rule asks for. When main has moved past it, the
  run says by how many commits, and that a rebase comes first if the baseline should be the one the
  land will see.
- **The throwaway checkout is installed like a prep, not linked.** `testsOnBase` symlinks the
  slice's `node_modules`, and skips when the slice changed a manifest. Here the run is the point, so
  the base gets its own install (`installFor(config.install, dir, "prep")`). That is what makes
  consumer-b's `.venv` link, which its install command creates, appear there too. The
  `provisionCopy` files are copied as in prep.
- **The result goes into `.slice-baseline`, overwritten per run.** Base SHA, command, exit code,
  time, last lines of output. Excluded by `azelf init` like the other markers. The last run is what
  counts. Whoever wants a history writes it to their own log.

## Phase 1 — the landed note says whether the rebase conflicts (c48e39f)

- [x] 1a. `noteLanded` (`slice-run.ts:3068`): after `shared`, ask
  `conflictBetween({ ref: baseBranch, head: landedAt }, { ref: branchFor(t.id), head: branchHead(t.id) })`.
  Files: a section `### Rebasing now conflicts` under this land's heading. It names the files and
  says: rebase onto `<base>` in this worktree now, resolve, commit, run the gates again. Empty: one
  line, `A rebase onto <base> goes through cleanly (checked at <sha12>, committed work only).`
  `null`: nothing.
- [x] 1b. The run log line becomes `noted in #N's worktree: .slice-landed.md (rebase conflicts in
  a, b)` when there are conflicts, and stays as today otherwise.
- [x] 1c. The slice skill, §6 "Finish": a section "Rebasing now conflicts" in `.slice-landed.md`
  means rebase before anything else, since your later work builds on the conflict. In both copies
  (`agent/skills/slice/SKILL.md`, `.claude/skills/slice/SKILL.md`).
- [x] 1d. Tests (`sliceRun.test.ts`, next to "writes the note with review off"): two siblings on
  the same line of `shared.txt` get the conflict section with the file. Siblings on different lines
  get the clean line. A git without `--write-tree` (stub `git` on `PATH`, as the overlap report's
  test does) gets the note without either.

## Phase 2 — `session-commit.sh --amend` (3a31af0)

- [x] 2a. Parse `--amend` (`session-commit.sh:51`), usage (`:42`): `--amend (-m|-F) [-y] [<path>…]`
  and `--amend [-y] <path>…`. Not together with `--push`. The paths check at `:82` does not
  apply to `--amend` with a message.
- [x] 2b. The guards, before the lock and before anything is staged, each refusal naming why and
  "nothing was staged": no `.slice-ticket.md` in the toplevel; `.slice-ready-to-land` or
  `.slice-finished` there; HEAD a merge; `git merge-base --is-ancestor HEAD <base>`;
  `git branch -r --contains HEAD` not empty. The base comes from `slice-config.sh`.
- [x] 2c. The commit (`:363-367`): `git commit --amend` with `-F`/`-m`, or `--no-edit` without a
  message; `-- paths` when paths are given, `--only` when not. Then
  `✓ amended: <old12> → <new12> <subject>`. The DB-lock block (`:308`) runs on the amended paths as
  on a new commit. The `atCommit` block (`:377`) runs unchanged.
- [x] 2d. The slice skill, §4: one paragraph. Use `--amend` for the last commit, for docs that
  belong with it or a message that is wrong. It is refused once the slice is handed in. Both copies.
- [x] 2e. Tests (`sessionCommit.test.ts`): amend with a path keeps the message and adds the file,
  and keeps the commit's other changes. Amend with `-m` and no path changes only the message, and a
  stray staged file stays staged and out. Refused in a checkout without `.slice-ticket.md`, on a
  commit that is on the base, on one that `origin/x` contains, and with `.slice-ready-to-land`
  present. `--amend --push` is a usage error. The `atCommit` gate runs after an amend.

## Phase 3 — a command on the base: `azelf on-base`

- [ ] 3a. Extract the throwaway checkout from `testsOnBase` (`slice-run.ts:2965-2990`) into
  `throwawayCheckout(dir, sha, { install })`: `git worktree add --detach`, the `provisionCopy`
  files, then either the `node_modules` link (`testsOnBase`, unchanged) or `installFor(…, "prep")`
  (on-base). Removal stays `removeBaseTest`'s, generalised to a directory. Its own directory,
  `<worktree>-on-base`, so it never meets a land's `-base-test`.
- [ ] 3b. `slice-run.ts --on-base [<id>] -- <cmd…>`: the ticket as `--gates` finds it (from the cwd
  when not given). The merge base of the slice branch with `<base>`. Run `cmd` there with output
  streamed, then remove the checkout, whatever happened (`finally`, and on SIGINT/SIGTERM). Print
  `base <sha12> (main is N commit(s) ahead — rebase first for the land's baseline)` when N > 0.
  Exit with the command's code. Write `.slice-baseline` into the slice worktree.
- [ ] 3c. The entry points: verb `azelf on-base [<ticket>] -- <cmd…>` in `bin/azelf.ts` (beside
  `gates`, `:111`), through the forwarding spawn helper from `sleep-and-signals-plan.md` Phase 1.
  Shim `scripts/slice-on-base.sh` (`how: "exec"` in `slice-files.ts:66`). `.slice-baseline` in
  init's exclude block (`slice-init.ts:77`). Usage in `slice-run-usage.ts`.
- [ ] 3d. `noteLanded`: when the worktree has a `.slice-baseline`, the note adds `your
  .slice-baseline is on <sha12>; the base has moved since`.
- [ ] 3e. The slice skill, §5: when you need to know whether a failure is yours, run
  `./scripts/slice-on-base.sh -- <the suite>`, and don't build your own worktree. Both copies.
- [ ] 3f. Tests (`sliceRun.test.ts`, `sliceInit.test.ts`): the command runs in a tree without the
  slice's change (a file the slice added is absent) at the merge base. Its exit code is the run's.
  `.slice-baseline` holds SHA, command and code. The checkout is gone afterwards, also after a
  failing command. A `provisionCopy` file is there. With the base ahead, the line names the count.
  Init lists the marker and the shim.

## Unobserved, once built

Phase 1: does a session that reads the conflict section rebase on its own, or carry on until the
land? Phase 3: how long the install takes in a throwaway checkout on consumer-a (bun, cached) and on
consumer-b (a link to the venv). Whether sessions use the shim instead of building their own
worktree.

## Order and cost

The `sleep-and-signals-plan.md` comes first. Its Phase 1 adds the spawn helper that 3c uses. Then
Phase 1 here (small), Phase 2 (small), Phase 3 (medium). One commit each. Each one is useful on its
own.

## Not in this plan

- **The dispatcher rebasing an open slice itself.** A session may be working in that worktree.
  The note is the lever.
- **`--amend` in the main checkout, or for an older commit.** See Decisions. A fixup of an older
  commit is a rebase, and the land squashes nothing.
- **Running the gates on the base.** See Decisions.
- **Directories or globs in `provisionCopy`.** consumer-a's case needs two files. Again only if a
  directory is ever needed.
- **The `baselineDiff` baseline in a clean checkout instead of the main checkout.** That would mean
  an install per gate run. The cause of consumer-a's case goes away with `provisionCopy`.

## What the consumer does itself

- consumer-a, the entry of 2026-11-12 (`test-runs/driver/` missing in slice worktrees): add
  `test-runs/driver/observed-ref.mjs` and `test-runs/driver/preflight-actions.mjs` to
  `provisionCopy` in `slice.config.ts`. That makes the test and tsc gates green again, and
  `azelf provision <ticket>` adds them to existing worktrees. Mark the entry so.
- consumer-b, #231: a per-ticket exemption for the forbidden zone in its zone gate, next to
  `hot-zone-freigaben`, as `at-commit-gates-plan.md` already says. The `--keep-going` addendum ran
  on an azelf from before `cfdd627`. If it comes back on a current one, it is a new entry.
- consumer-b, Frontend #164: the mock line in its own start prompt becomes "don't rebuild it; add
  where the ticket asks".
- Both, after each phase: pull or bump, run `azelf init` (Phase 3 brings a shim and an exclude
  line), restart running dispatchers for Phase 1.
