# A run log that says what is true, scripts that take the common order, and a review that can see past its own ticket

**Status:** IN PROGRESS (Phases 1–4 landed) · **Written:** 2026-10-02
**Companion:** consumer-a's friction log (an untracked file in its main checkout, not in
this repo), the entries still `open` after `docs/resolve-and-report-plan.md`: dated
2026-09-25, 09-26, 09-30, 10-01 and 10-02.

Written so it can be picked up cold. Each item says what to change, where, why, and what
proves it. Tick the boxes as they land and add the commit hash after the heading. Line
numbers are as of `e8dd066`; search for things by name once a phase has moved them.

## What happened

Three groups of entries. None of them lost work; each one made a reader check by hand
what azelf should have said or seen.

### The run log says things that are not so

1. **The round line counts a slice that is waiting to land as "blocked", and a ticket
   that just landed as "open".** `remaining` is read before the round's land
   (`slice-run.ts:3087`), and `blocked` is `remaining − up − ready` (`:3263`), so
   everything that is neither running nor startable is "blocked". Seen on two waves:
   `0 running · 1 blocked · 4 open` straight after a land, with nothing blocked.
2. **The same-files warning pairs an open slice with a landed one it was cut on top
   of.** `reportOverlaps` (`:2734`) keeps a landed slice's files for the rest of the
   run, which is right for a slice that was open when the land happened. A slice
   prepped after the land already contains those commits, and has nothing to rebase
   over. Seen on two waves; both times the reader checked the merge-base by hand.
3. **Prep prints "prepped, not launched … launch it with" and the dispatcher then
   launches it.** The two lines are `slice-session.sh --prep-only`'s (`:325`), written
   for a person running it by hand. Under the dispatcher the next line is
   `→ opened 1 tab`. Separately, `git fetch origin <base>` (`:231`) ran for two and a
   half minutes with nothing printed.

### The scripts refuse the common order

4. **`session-commit.sh --push` cannot push a commit that already exists.** `-m` is
   required (`session-commit.sh:53`). "Commit now, push after the user has looked" is
   the usual order in a main session, and it ends in a bare `git push`, which the
   consumer's own rules say to avoid.
5. **`session-commit.sh` has no `-F`.** A slice's commit message is often thirty lines
   and written to a file first.
6. **`format.sh` given paths that do not exist says "nothing to format — no changed
   files" and exits 0.** `add_if_present` (`format.sh:80`) drops a missing path
   silently, for named paths as well as for git's list. Seen twice, both from zsh not
   word-splitting `$FILES`.

### The review cannot see past its own ticket

7. **The spec review cannot read the parent spec.** `reviewSlice` (`slice-run.ts:1385`)
   hands the reviewer the ticket body and the diff. The reviewer tried `gh issue view`
   on the parent, which a headless review is not allowed to run, and then returned
   BLOCK for behaviour the parent had decided. Advisory that time; under `--auto` it
   would have parked a correct slice.
8. **A contract between two sibling slices is only seen after both landed.** One slice
   landed a guard whose comment said its sibling joins it. The sibling was in flight on
   the older base and never did. The overlap warning printed, the resolver noticed, the
   plan review noticed, and the bug was on the base branch by then.
9. **"A failing test first" is checked by reading.** The reviewer tried to run the new
   test against the base and was refused; it has no tools. Every "prove it" criterion a
   ticket writes is accepted on the commit message's word.

## Decisions this plan makes

Each one changes behaviour someone may rely on. Overrule them before the phase starts,
not after.

- **The round line gains buckets, and they only print when they are not zero.**
  `blocked` means "has an open blocker" and nothing else. A slice that is done and
  waiting its turn is `N to land`; one that could start but has no slot, no disk or no
  lock is `N queued`. A line with neither reads word for word as it does now, so a
  watcher that matches it keeps working. The line is built after the round's land.
- **A landed slice leaves an overlap pair once the open slice contains it.** Kept only
  for open slices cut before that land.
- **A dispatched prep prints one line.** `--prep-only` by hand keeps its two.
- **`session-commit.sh --push` alone pushes what is committed.** No `-m`, no paths:
  fetch, refuse unless fast-forward, show the commits, push, under the same lock. It
  follows the commit's rule for confirmation: a prompt on a terminal, `-y` without one.
- **`format.sh` fails on a named path that neither exists nor is known to git.** A
  named path that was deleted (HEAD has it, the tree does not) is still skipped
  quietly: passing a changed-file list that contains a deletion is not a mistake.
  This is the rule `session-commit.sh` already applies to its paths.
- **The parent spec is pasted into the spec review, and the parent wins.** Where the
  diff follows the parent against the ticket's wording, that is a finding ("ticket and
  parent disagree") and never a BLOCK. The parent is context: a requirement only the
  parent states is not this slice's to implement.
- **A slice that lands onto files an overlapping sibling changed is reviewed against
  that sibling.** The spec review gets what landed since the slice branched, limited
  to the files both touched, and one more question. A missed contract is a BLOCK like
  any other spec failure, under the existing rule for when the review blocks. The
  open session is also left a note, which it may or may not read.
- **Running new tests against the base is opt-in, and its result is evidence, not a
  verdict.** The dispatcher cannot tell "the test fails because the fix is missing"
  from "the test fails because the throwaway checkout is broken" by an exit code. So
  the reviewer gets the result and the tail of the output, and judges. It never gates
  a land by itself.

## Phase 1 — the run log says what is true (`be5b582`)

Smallest, no behaviour change beyond text. `scripts/slice-run.ts`,
`scripts/slice-overlap.ts`, `scripts/slice-session.sh`.

### 1a. The round line

- [x] Build the line from the tickets as they are after the land, not from the
      `remaining` read at the top of the round. `tryLand` sets `t.open = false`
      (`:2596`), so filtering `tickets` again is enough; no tracker call.
- [x] `toLand`: open, has a worktree, not occupied, not parked, and
      `isReadyToLand` or (`autoLand` and `autoFinished`). The same predicate as
      `finished` (`:3099`); pull it into one function so the two cannot drift.
- [x] `blocked`: open with at least one entry in `blockedBy` that is still open, or a
      `foreignBlockers` entry.
- [x] `queued`: open, and none of running, to land, blocked, parked.
- [x] Line: `N running · [N to land · ][N queued · ]N blocked · N open[ · N parked] —
      land one to advance`.
- [x] Tests (`sliceRun.test.ts`): after a land in a two-ticket chain the next line
      does not count the landed ticket; a slice with the ready marker behind another
      land reads `1 to land`, not `1 blocked`; a wave with neither bucket prints the
      line exactly as before.

### 1b. The overlap report

- [x] Record the base head a slice landed as: `landedHeads: Map<TicketId, string>`,
      written next to `landedFiles.set` (`:2592`) from `baseHead()` after the land.
- [x] `findOverlaps` (`slice-overlap.ts`) takes `absorbed?: (landed, open) => boolean`.
      For each file, a landed holder is removed when every open holder of that file
      has absorbed it. A file left with fewer than two holders is dropped. Mixed (one
      open slice has it, one does not) keeps the landed slice.
- [x] The caller answers with `git merge-base --is-ancestor <landedHead> <branch>`,
      cached on `(landedHead, branchHead)`.
- [x] Rewrite the "A LANDED SLICE IS STILL AN OVERLAP" block in `slice-overlap.ts` to
      carry the exception and the two waves that showed it.
- [x] Tests: pure ones in `sliceOverlap.test.ts` (absorbed, not absorbed, mixed
      three-way group); one in `sliceRun.test.ts` where a blocked slice is prepped
      after its blocker landed and no warning prints.

### 1c. Prep lines

- [x] The dispatcher passes `--dispatched` with `--prep-only` (`:3211`).
      `slice-session.sh` then prints `✓ prepped — worktree ready at <path>` and
      neither "not launched" nor "launch it with".
- [x] `echo "  fetching origin/$SLICE_BASE_BRANCH …"` before the fetch (`:231`).
- [x] Test: a dispatcher run's output has no `launch it with`; a by-hand
      `--prep-only` still has it.

**As landed.** `N running` is counted after the round's launches as well as its land,
so a slice started this round is running and not queued. A parked slice is no longer
counted as blocked: it has its own `N parked`. The test for a landed slice kept in the
report commits in the open slice after the land, because the report is keyed on
tickets and files and does not reprint when only the ✓ changes.

## Phase 2 — scripts that take the common order (`401238c`)

`scripts/session-commit.sh`, `scripts/format.sh`, `tests/scripts/sessionCommit.test.ts`,
a new `tests/scripts/format.test.ts`. Independent of Phase 1.

### 2a. `session-commit.sh --push` alone

- [x] `--push` with no `-m`, no `-F` and no paths is push-only. `--push` with paths and
      no message stays the error it is.
- [x] Push-only: take the lock, fetch, refuse if `origin/<branch>` is not an ancestor
      of HEAD (the existing message), print `git log --oneline origin/<branch>..HEAD`,
      say "nothing to push" and exit 0 if that is empty, confirm, push.
- [x] Move the existing push block into a function both paths call.
- [x] Usage text, and the header's examples.
- [x] Tests, against the fixture's bare remote: pushes two existing commits; refuses
      when the remote is ahead; nothing to push exits 0; no terminal and no `-y`
      refuses before fetching.

### 2b. `session-commit.sh -F`

- [x] `-F <file>` / `--file <file>`, passed to `git commit -F`. `-F -` reads stdin and
      requires `-y`, since stdin cannot also answer the prompt.
- [x] `-m` and `-F` together: usage error, exit 64. A file that does not exist: error
      before the lock, nothing staged.
- [x] Tests: a multi-line file becomes the commit message verbatim; `-F -`; both flags
      together.

### 2c. `format.sh` and paths that are not there

- [x] With explicit paths: a path that does not exist and that `git ls-tree HEAD` does
      not know → collect, then `error: no such path: <p>` per path, exit 1, nothing
      formatted. If the missing path contains a space or a newline, add
      `(one argument — was a list passed unsplit?)`, which is the mistake both entries
      made.
- [x] If every named path was a deletion: `nothing to format — the N named path(s) are
      deleted.` instead of "no changed files".
- [x] Tests: a missing path fails and formats nothing, also when a real path is named
      beside it; a deleted tracked path is skipped; no arguments behaves as before.

**As landed.** `-F -` is read into the message before the lock, so nothing later in the
script can take stdin from it. A relative `-F` path is resolved before the script moves
to the repo root. `--push` alone with no `origin/<branch>` yet says the push creates
it and asks the same way. `format.test.ts` puts a fake `bunx` on `PATH` that records
its arguments, which is how "nothing formatted" is asserted.

## Phase 3 — the review sees the parent (`195473b`)

`scripts/slice-run.ts`, `scripts/slice-config.ts`, `scripts/slice-config.sh`,
`scripts/slice-session.sh`, the skill (`agent/commands/azelf.md` and its copy).

- [x] One function for "this ticket's parent": `parentFromBody`
      (`slice-tracker.ts:258`) on the ticket's own body. The tracker has no
      child-to-parent call, only `children(id)`, so a parent recorded solely in the
      tracker's own hierarchy is found only when `findEpics` already saw it this run.
      Otherwise there is no parent as far as the review knows, and the ticket-writing
      convention (`## Parent`) is what makes this work. Say so in the README.
- [x] `reviewSlice` fetches the parent's title and body and passes it to `reviewSpec`,
      cut to a budget of its own (20 000 characters, with the same "(truncated)" note
      the diff gets). No parent, or one the tracker cannot read: the prompt is as it
      is today, and an unreadable one is said in the report.
- [x] `reviewSpec`'s prompt gains a `PARENT SPEC` section after `SPEC`, and these
      rules: the ticket is what this slice must do; the parent is why, and decides
      where the two disagree; a diff that follows the parent against the ticket's
      wording is reported as "ticket and parent disagree" and is not (a) or (c); a
      requirement only the parent states is not missing from this slice.
- [x] `slice-config.ts --tracker parent <id>` prints the parent's brief or nothing.
      `slice-session.sh` writes it to `.slice-parent.md` beside `.slice-ticket.md`
      (`:285`), never fatal, and the "your ticket is in" line names both. Whatever
      keeps `.slice-ticket.md` out of commits and cleans it at land must cover the new
      file: find it by grepping for `.slice-ticket.md`, do not assume.
- [x] Skill: one sentence, that the parent spec is in `.slice-parent.md` when there is
      one.
- [x] Tests: the fake review agent in the fixture records its prompt; assert the
      parent's body is in it for a ticket with `## Parent`, and absent without. Prep
      writes `.slice-parent.md` for a child and not for an orphan.

**As landed.** The pattern that keeps `.slice-parent.md` out of commits is in the block
`azelf init` writes to `.git/info/exclude`, and a consumer that upgrades without
re-running init does not have it. There the file would make the worktree dirty, and a
dirty slice does not land. So prep writes the file only where `git check-ignore` says
it is ignored, and otherwise prints one line naming `azelf init`. The review's copy
does not depend on this. A land removes the worktree, ignored files included, so there
is no separate cleanup. The session-side sentence went into the `slice` skill, which is
what a session reads; the `azelf` command file got one line too.

## Phase 4 — a slice is reviewed against the sibling that landed under it

`scripts/slice-run.ts`. Builds on Phase 1b's `landedHeads` and Phase 3's prompt.

- [x] In `reviewSlice`, after the rebase: the landed slices whose `landedFiles`
      intersect this slice's changed files and whose `landedHeads` entry is **not** an
      ancestor of the branch as it was before this land's rebase. That is "landed
      while this one was open". Record the pre-rebase head in `tryLand` for this.
- [x] For those: commit subjects (`git log --oneline` over the landed range) and the
      landed diff limited to the shared files, under a budget (30 000 characters,
      shared files first by size ascending so one large file does not crowd out the
      rest).
- [x] Prompt section `LANDED WHILE THIS SLICE WAS OPEN`, and a fourth finding kind:
      "(d) something the landed work set up for this slice to join, extend or respect,
      that this diff does not — a shared guard, a registry, an invariant stated in a
      comment". BLOCK covers (d). No such slices: no section, no (d).
- [x] When a slice lands and an open slice overlaps it, write the same subjects and
      file list to `<open worktree>/.slice-landed.md`, appended per land, and print
      `noted in #N's worktree: .slice-landed.md`. Skill: before finishing, read
      `.slice-landed.md` if it exists. Same exclusion and cleanup as
      `.slice-ticket.md`.
- [x] Tests: two siblings on one file, the first lands; the second's review prompt
      carries the section and the first's subject line; a slice prepped after the land
      gets no section; the note file appears in the open worktree. With review off the
      note is still written.

**As landed.** "Landed while this one was open" is recorded at the land, for every
ticket that has a branch at that moment (`landedWhileOpen`), and not derived from
ancestry at review time. A slice parked on red gates has already been rebased onto the
landed work when its land is retried, and the ancestry test would then say it contains
it. The file intersection is still taken at review time, after the rebase. The landed
range is the base head before and after the land (`landedRanges`). Paths in
`overlapIgnore` are left out here as they are in the warning. `.slice-landed.md` is
written only where git ignores it, as `.slice-parent.md` is; the exclude block now has
eleven patterns.

## Phase 5 — new tests are run against the base, when the consumer says how

Opt-in. Drop this phase without touching the others if the cost reads wrong.

- [ ] Config (`slice-config.ts`): `testOnBase?: { command: (files: string[]) =>
      string[]; files?: string[] }`. `files` are patterns for what counts as a test,
      default `**/*.test.*` and `**/*.spec.*`, matched with `ignores()` from
      `slice-overlap.ts`. Unset means the feature is off and nothing below runs.
- [ ] At land, after the gates pass and before the review, when review is on: the
      test files this slice added or changed. None: skip, say nothing.
- [ ] A throwaway worktree, detached at the commit the slice rebased onto, beside the
      slice's own. `node_modules` is a symlink to the slice worktree's;
      `provisionCopy` files are copied as prep does. Check out the slice's test files
      into it from the branch. Run the command there, ten-minute timeout. Remove the
      worktree in a `finally`, and at dispatcher start remove any left by a crash.
- [ ] Skipped, with the reason in the report, when the slice changes a manifest or
      lockfile (the base's dependencies are then not the slice's), or when the
      worktree cannot be made.
- [ ] The spec prompt gains `NEW TESTS AGAINST THE BASE`: the command, whether it
      exited non-zero, and the last 40 lines of output. Rule for the reviewer: a
      ticket that asks for a failing test first is met when these tests fail on the
      base *for the reason the ticket describes*; an import error for a file the slice
      adds counts, a broken environment does not, and if it cannot tell it says so.
- [ ] Run log: `new tests on base: fail (expected for a fix)` / `pass` / `skipped —
      <reason>`. Never a park.
- [ ] README: the config key, and that it costs one extra test run per land.
- [ ] Tests: a fixture slice that adds a test and its fix → prompt says the tests
      failed on base; one that adds a test passing on base → says passed; unset config
      → no section and no worktree; the throwaway worktree is gone afterwards in all
      three, also when the command times out.

## Checks only the consumer can make

- A wave with a blocked slice: the round line after the blocker lands, and no
  same-files warning for the slice prepped on top of it.
- `./scripts/session-commit.sh --push` after an approved commit, in the main checkout.
- A review of a child ticket whose parent overrides its wording: the report names the
  disagreement and the verdict is PASS.
- Two siblings that share a file, with `--review`: the second's review names what the
  first set up.
- With `testOnBase` set to the consumer's test runner: that the symlinked
  `node_modules` is enough for its runner to start at all. If it is not, Phase 5
  needs a different way to provision and should be reverted to off.

## Not in this plan

- A mutation check ("the guard is load-bearing"). Phase 5 covers "fails on base" only;
  mutating code needs a writable tree and a judgement about what to mutate.
- A warning at plan time that two siblings will both add to the same shared file.
  Nothing knows a ticket's files before its agent writes them, and guessing from prose
  is what `slice-overlap.ts` declines to do. `--auto-resolve` and Phase 4 cover what
  happens next.
- Offering `merge=union` in `azelf init` for append-only files.
- Filing plan-review findings as tickets.
- `--sync-edges` wrote two of three body-claimed edges on its first run (entry dated
  2026-10-02). Not reproduced yet; since `9681a26` a missing edge to an open blocker
  stops the dispatch, so the cost is a second `--sync-edges`. Needs a reproduction
  before a plan.
- Cutting a review excerpt at a line boundary.
