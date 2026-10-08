# A resolution a lock can't throw away, a review that sees what it needs, and `format.sh --help`

**Status:** IN PROGRESS — Phase 1 landed 2026-10-08 · **Written:** 2026-10-08
**Companion:** consumer-a's friction log, the three entries dated 2026-10-08 that came in
after `docs/unattended-run-plan.md` was written. That plan and `docs/run-polish-plan.md`
cover every other open entry, and both are complete.

Written so it can be picked up cold. Tick the boxes as they land and add the commit hash
after the heading. Line numbers are as of `c8e12c4`.

## What happened

1. **A brief `index.lock` threw away a correct conflict resolution.** #100's pre-gate
   rebase conflicted in two files. The resolver fixed both: no markers, tsc at baseline,
   the test suite green, all in `.slice-reviews/conflict-100.md`. Then the
   dispatcher's own `git add` failed:

   > Unable to create '…/.git/worktrees/<slice worktree>/index.lock': File exists

   `resolveConflict` treats any failed `git add` as a rejection
   (`slice-run.ts:2925-2929`). `give` (`slice-run.ts:2836`) aborts the rebase and the
   slice is parked. Seconds later the lock file was gone, and no git process was
   running in that worktree. A paid resolver run was lost to a lock that lasted
   seconds. The fix was `azelf retry 100`, which ran the rebase and the resolver again
   from scratch.

   **What held the lock is unconfirmed.** The dispatcher runs git synchronously, and its
   own reads (`withMarkers`, `git diff --name-only`, `ls-files`) have all exited before
   the `add`. The candidates are processes outside it: an editor's background
   `git status` on that worktree, or something the resolver agent left running (it ran
   the test suite). Either way the lock is real, brief, and not ours.

   **The same lock can hit `rebase --continue`** (`slice-run.ts:2933-2937`). Its
   failure isn't checked. The loop then finds the rebase still in progress with nothing
   unmerged, and rejects with "the rebase stopped with nothing left conflicted — git
   said: fatal: Unable to create …index.lock". That's the same loss under a more
   confusing message.

2. **The spec review couldn't see the whole parent, wasn't told the gates had run, and
   its caveats stayed in the review file.** #98's review returned `VERDICT: PASS` with
   two caveats in its own words:

   - "running Vitest needed approval and I didn't get it, so the test results are
     unconfirmed". The spec prompt (`reviewSpec`, `slice-run.ts:1681`) never says the
     gates ran. They always have by then: the review runs after `gatesPass`
     (`slice-run.ts:3289-3296`). The standards prompt does say so, but names
     "biome, tsc, vitest" whatever the consumer's gates are (`slice-run.ts:1647`).
   - "#97's Further Notes was cut off and `gh issue view` needed approval".
     `parentSpec` (`slice-run.ts:1534`) cuts the parent at `PARENT_BUDGET`, which is
     20 000 characters (`slice-run.ts:1505`). #97 was 22 912. The diff gets 120 000
     (`DIFF_BUDGET`, `slice-run.ts:1486`). The worktree had the whole parent in
     `.slice-parent.md`, which the reviewer could have read, but the truncation note
     doesn't mention it.

   The README says the reviewer "has no tools" (`README.md:821`). That's wrong for
   claude: `claude -p` without permissions can read files in its working directory
   (the slice worktree) and is refused anything that needs approval. That matches what
   the review said.

   Neither caveat reached the run log in a form a watcher would see. The full review
   text is printed (`reviewSlice`, `slice-run.ts:2132`), but nothing after it says
   "PASS, with two things unchecked". A PASS prints no summary line at all.

3. **`./scripts/format.sh --help` is read as a path.** It prints `error: no such path:
   --help` and exits 1. There's no usage text, and a slice session couldn't tell whether
   a check-only mode exists (there isn't one). The session wanted one because its skill
   says a gate must not write to the tree. It confirmed its formatting with
   `bunx biome check <paths>` by hand.

## Decisions this plan makes

- **A lock error is retried, never judged.** `git add` and `rebase --continue` in the
  resolver retry on `index.lock': File exists` with backoff. Only a lock that is still
  there after about 15 seconds rejects the resolution, and the message then names the
  lock file and says it may be stale. Every other failure is rejected as today.
- **The review reads the worktree's files, and is told not to run anything.** No change
  to the agent's tool flags (`slice-agent.ts:153`); the prompt says what was already
  run and where the full texts are. A narrower allow-list for the reviewer is in "Not in
  this plan".
- **The parent gets 60 000 characters.** That's still half the diff's budget. When it is
  cut anyway, the note points to `.slice-parent.md` if the worktree has one.
- **Caveats become a line format, like `VERDICT:`.** The reviewer puts each thing it
  could not check on its own `UNVERIFIED:` line before the verdict. The dispatcher
  prints them next to a new one-line verdict summary. They never change the verdict.
- **`format.sh` gets `-h`/`--help` and `--check`.** `--check` runs the same
  `biome check` without `--apply`, which is what the session ran by hand.

## Phase 1 — a lock doesn't throw away a resolution (`6d618f9`)

- [x] **1a. A retrying git write in `resolveConflict`.** A small helper next to it:
  run the git command; if it failed and its output matches
  `/index\.lock': File exists/`, wait and run it again. Use the backoff 250 ms, 500 ms,
  1 s, 2 s, 4 s, 8 s (about 16 s in all). Sleep with `Atomics.wait`, as
  `slice-lock.ts:182` does. Print one line the first time it waits:

  > the worktree's index is locked (another git process?) — waiting for it …

  An env var, `SLICE_LOCK_RETRY_MS`, scales the base delay so tests don't wait 16 s.
  Name it in the helper's comment, like `SLICE_HEARTBEAT_SECONDS`.
- [x] **1b. Use it for both writes.** The `git add -A -- <files>`
  (`slice-run.ts:2925`) and the `rebase --continue` (`slice-run.ts:2933`). For
  `--continue`, a lock failure that outlasts the retries must reject with the lock
  message, not fall through to "stopped with nothing left conflicted".
- [x] **1c. The rejection for a lock that stays.** The `give` reason becomes:

  > the worktree's index stayed locked for 16 s (…/index.lock) — if no git process is running there, it is stale: remove it and run azelf retry 100

  Leave the rest of `give` as it is: it aborts and resets, so the branch is as it was.
  A stale lock would block that abort too. Say so in a comment rather than handling it:
  the park line already points at the worktree.

  *Proof:* **`sliceRun.test.ts`**, in "resolving a rebase conflict"
  (`sliceRun.test.ts:1063`), with `SLICE_LOCK_RETRY_MS` small:
  - the resolver resolves, then creates `$(git rev-parse --git-path index.lock)` and
    starts a background `sleep 1; rm` on it. The resolution is accepted, the lock line
    is printed once, and the slice lands;
  - the same, but the lock is never removed. The resolution is rejected with the lock
    message and the lock path, and the slice is parked. The test removes the lock in
    its cleanup.
  - The first test fails on the old code (`git add failed`).

**As landed.** As planned, with three differences:

- **The abort is reported honestly.** 1c said to leave `give` as it is. But a lock that
  stays also stops `git rebase --abort`, and `give` would then print "the branch is as it
  was" over a worktree still mid-rebase. It now checks: when the rebase is still in
  progress, it says `the rebase could not be aborted either — it is still in progress in
  <worktree>. Finish or abort it there.` The dispatcher already leaves such a worktree
  alone, so it waits for a person.
- **The parser is `heldIndexLock` in `slice-resolve.ts`,** next to the other decisions
  over git output. It returns the lock path, so the message names the real file. Only
  `index.lock` counts: a `HEAD.lock` or any other failure is rejected at once.
- **The backoff is in units of `SLICE_LOCK_RETRY_MS`** (default 250): 1, 2, 4, 8, 16, 32,
  about 16 s in all. The message gives the total in seconds.

The proof is as planned, plus parser tests in `sliceResolve.test.ts`. The lock tests take
the lock with `--absolute-git-dir`, and the background `rm` gets its own stdio, so the
dispatcher doesn't wait on the pipe it holds open. `runDispatcher` takes `env`, like
`startDispatcher`. Both dispatcher tests fail on the old code. The persistent-lock test
also checks that the rebase is still in progress, and that "the branch is as it was" is
not printed. The `--continue` path has no test of its own: a lock arriving between the
`add` and the `--continue` can't be staged from a resolver. It goes through the same
helper. The README's resolver section gained a paragraph. The full suite passed: 429 of
429.

## Phase 2 — the spec review sees what it needs, and says what it couldn't check

- [ ] **2a. The parent's budget, and where the rest is.** `PARENT_BUDGET` becomes
  60 000. When `parentSpec` cuts anyway and `<worktree>/.slice-parent.md` exists, the
  note reads:

  > [parent spec truncated to 60000 of 81234 chars — the whole text is in .slice-parent.md in your working directory; read it there]

  Without the file, the note stays as it is.
- [ ] **2b. Say what already ran.** The spec prompt gains a paragraph before `SPEC:`:

  > The gates (<names from config.gates>) ran on this exact diff, rebased, and passed. Do not run tests, builds, git or gh: you will not be allowed to, and you don't need to. You can read the files in your working directory, which is the slice's worktree.

  The standards prompt's "(biome, tsc, vitest all run separately and passed)"
  (`slice-run.ts:1647`) uses the same names. The README's "The reviewer has no tools"
  (`README.md:821`) is corrected: it can read the worktree, it is refused anything that
  needs approval, and it is told so.
- [ ] **2c. `UNVERIFIED:` lines.** The prompt asks for each thing the reviewer could not
  check on its own line, `UNVERIFIED: <what, and why>`, directly before the verdict.
  It is told that an unverified point is not a reason to BLOCK by itself.
  `reviewSpec` returns them beside `report` and `block`, read the way the verdict is
  (`slice-run.ts:1759`). `parentSpec`'s "could not be read" note is added to the
  list too.
- [ ] **2d. One verdict line in the run log.** After `report saved:`
  (`slice-run.ts:2133`), always print:

  > spec review: PASS — 2 things it could not check:
  >   - the ADR's rejected alternatives (the parent was cut off)
  >   - …

  or `spec review: PASS` / `spec review: BLOCK` alone when there are none. It comes
  before the ✗ or ! line on a BLOCK.

  *Proof:* **`sliceRun.test.ts`**, in "the spec review and the parent spec"
  (`sliceRun.test.ts:337`), whose fake reviewer records every prompt:
  - a 30 000-character parent is pasted whole; one of 70 000 is cut, and the note
    names `.slice-parent.md` when the test wrote one into the worktree, and doesn't
    when it didn't;
  - the prompt names the fixture's gates and says not to run anything;
  - a reviewer answering two `UNVERIFIED:` lines and `VERDICT: PASS` gives the summary
    line with both, and the slice lands;
  - a plain PASS prints `spec review: PASS` and nothing more.

## Phase 3 — `format.sh --help` and `--check`

- [ ] **3a.** `scripts/format.sh` reads its options before the paths:
  - `-h`/`--help` prints usage to stdout and exits 0. The usage covers no arguments,
    named paths, `--check`, and that it formats only what changed;
  - `--check` runs `bunx biome check --no-errors-on-unmatched` without `--apply` on
    the same file list and exits with biome's status. The `▶` line says
    `biome check (no changes written)`;
  - `--` ends the options, so a path that starts with `-` still works;
  - any other `-…` before `--` is an unknown option: usage on stderr, exit 64, as
    `session-commit.sh:59` does.
- [ ] **3b.** The README's command list (`README.md:322`) gains the `--check` form, and
  its paragraph (`README.md:327`) one sentence on `--help`.

  *Proof:* **`format.test.ts`**:
  - `--help` exits 0, prints the usage, and names `--check`;
  - `--check` on an unformatted file exits non-zero and leaves the file unchanged; on a
    formatted file it exits 0;
  - `--bogus` exits 64 with usage on stderr;
  - `-- -odd.ts` formats a file named `-odd.ts`.

## Order and cost

Phase 1 first: it's the one losing paid work, and it's small. Phase 2 is the largest,
mostly prompt text and one new parse. Phase 3 is a short shell change. The three are
independent and touch different code.

## Not in this plan

- **What held the lock.** If the retry line shows up often on consumer-a, the next step
  is to find the process, for example with `lsof` on the lock when the first retry
  starts.
- **Other git writes that could meet the same lock:** the pre-gate rebase itself, and
  the land's own steps. Neither has been seen failing on a lock.
- **A narrower allow-list for the review agent** (`claude -p --allowedTools Read,Grep,Glob`).
  The prompt now says not to run anything; tool flags are per agent preset and would
  need the same thought for every preset.
- **A restarted dispatcher's plan review covers only its own run.** On consumer-a, five
  restarts left the final plan review seeing one ticket of seven. It needs the run's
  landed ranges to survive a restart.
- **A named ticket keeps being read every round after it closes.** Before the
  unattended-run plan that was one more chance to crash. Now it's only extra calls.
- **An agent that is alive but idle after an API error.** The dispatcher sees a live
  session and waits. Noticing it needs a signal from the session, which is a design
  question of its own.

## What the consumer does itself

- **The bump** after each phase.
- **After Phase 3,** a session can run `./scripts/format.sh --check <paths>` instead of
  `bunx biome check` by hand.
