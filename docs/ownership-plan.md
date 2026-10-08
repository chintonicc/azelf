# A land that finishes, one dispatcher per ticket, and a hold on hand work

**Status:** NOT STARTED · **Written:** 2026-10-08
**Companion:** consumer-a's friction log: the five entries dated 2026-10-08 that
`docs/lock-and-review-plan.md` left open, and two more from later the same day (a
rebase that doesn't reinstall, and a worktree re-added by hand). Every other entry is
covered by a complete plan.

Written so it can be picked up cold. Tick the boxes as they land and add the commit hash
after the heading. Line numbers are as of `826db6f`.

## What happened

1. **A bump stranded every slice prepped before it.** consumer-a bumped azelf and added
   `humanLabel` to its `slice.config.ts` in one commit. #102 and #137, in two separate
   runs, had been prepped earlier, each with its own `node_modules` holding the old
   azelf. The land rebased each onto the new base, and the tsc gate reported:

   > slice.config.ts: error TS2353: … 'humanLabel' does not exist in type 'SliceConfig'

   The gate counted that as one new error and parked the slice. Neither slice touched
   the file. `bun install` in the worktree brought tsc back to its baseline, and
   `azelf retry` landed it. The rebase changed `package.json` and the lockfile, and
   nothing reinstalled: `bun install` runs only at prep (`slice-session.sh:323`). Two
   more live slices had the same old copy when this was written. Any bump, or any land
   that adds a dependency, does this to every slice still open.

2. **A dispatcher killed mid-cleanup left a landed ticket open and its worktree
   half-deleted.** #101 fast-forwarded the base and pushed. Then the terminal crashed
   during `git worktree remove` (`slice-land.sh:322`) and took the dispatcher with it.
   The ticket stayed open, `ticket/101` stayed, and `git status` in the worktree showed
   hundreds of tracked files deleted. The ticket close comes after the cleanup
   (`slice-land.sh:382`), so the slow, killable step stood between the push and the
   step that unblocks dependents.

   Nothing records that the push happened. To a restarted dispatcher, #101 is an open
   ticket whose branch is an ancestor of the base. **So is every freshly prepped slice
   that hasn't committed yet**, so ancestry alone can't tell "landed" from "not
   started". Depending on how far the removal had got, a restart either gates a
   half-deleted tree (`isClean` fails, and it parks) or finds no done marker and opens
   a session in it (`runnable`, `slice-run.ts:1241`). The fix was by hand: close with a
   comment, `git worktree remove --force` once the branch was confirmed equal to the base
   with nothing untracked, then `git branch -d`.

3. **A second dispatcher on the same tickets started without a word.** Fifteen seconds
   after one session restarted `azelf run -y --auto 102 103 104 107 108`, another
   started `--max 3` on the same five. The second one found #102's rebase in progress
   with no session running. It said "someone is fixing it by hand, most likely"
   (`noteHandWork`, `slice-run.ts:2729`), but the rebase was the first dispatcher's
   resolver at work. It then started and opened #103. It was caught by hand from `ps`.
   The README says to give each run its own tickets ("Two dispatchers on one repo",
   `README.md:1191`), but nothing enforces it. Sessions have since been guarding
   restarts with `ps | grep slice-run.ts | grep 137` themselves.

4. **A second session aborted a live re-port and removed the worktree.** #102 had been
   parked as IRRECONCILABLE, and an agent was re-porting it by hand: a rebase in
   progress, resolutions unstaged. After a crash, another session was asked to "take
   over the dispatcher". It read the rebase as a stale leftover, ran
   `git rebase --abort`, and removed the worktree. The unstaged resolutions were lost;
   the commits survived. azelf has no way to mark a worktree as in use by someone who
   isn't an azelf session: `.slice-live` belongs to the session `slice-session.sh`
   opened.

   The worktree was re-added by hand. It then had none of the `provisionCopy` files,
   and without `expo-env.d.ts` tsc reports an error the gate would blame on the slice.
   `slice-session.sh <id> --prep-only` would have redone all of it, since it reuses an
   existing worktree (`slice-session.sh:253`). But nobody knew that, and it also
   re-checks the ready label and the blockers, and writes `.slice-flags`.

5. **Two slices in one wave rebuilt the same component.** #101 and #102 were both
   blocked only by #100, so they ran side by side. Both rewrote the editor's filmstrip
   in `VideoEditor.tsx`. #101 landed. #102 conflicted in 8 files, and the resolver
   rightly refused it as IRRECONCILABLE. The park line gives the reason and the
   worktree, but not what to do next.

   The entry asks for a plan-time warning when two same-wave tickets name the same
   files. **Checked against the real tickets, it would not have fired on this pair.**
   Neither #101's body nor #102's names `VideoEditor.tsx`. All five tickets of that
   spec name the same four other files (`captureShared.tsx`, `captureFrame.tsx`,
   `TESTING.md`, the design doc) through a shared conventions block. A text match would
   have paired every ticket with every other and missed the file that collided. That
   is the reason `slice-overlap.ts` gives for not being a plan-time check ("the ticket
   names an outcome, not a file list").

6. **The base moved during the spec review, and the land was refused instead of
   retried.** #103 was rebased, gated, and reviewed PASS. In those minutes another run
   pushed to the base. `slice-land.sh` refused (`can't fast-forward … it has
   diverged`, `slice-land.sh:155`). `tryLand` parks every `slice-land.sh` failure as
   `land` (`slice-run.ts:3463`), to be retried when the base moves again. That might
   be hours. The fix was `azelf retry 103`.

## Decisions this plan makes

- **A rebase that changes what `bun install` reads reinstalls before the gates.** That
  means `package.json`, `bun.lock` or `bun.lockb` changed between the slice's old
  merge-base and the new base. The install is `bun install --frozen-lockfile`, so it
  can't dirty the tree it's about to gate. A failure parks with its own reason.
- **The land writes down that it pushed.** `slice-land.sh` writes a record in the
  common git dir right after the push and deletes it as its last step. A restarted
  dispatcher, or `slice-land.sh` run again by hand, finishes what the record names. It
  doesn't relaunch or re-land it. That covers the gap ancestry can't.
- **The close comes before the cleanup.** The ticket close unblocks dependents, and
  the worktree removal is the slow step that gets killed.
- **A second dispatcher on any of the same tickets refuses to start.** It names the
  first and prints the command for the tickets nobody holds. Quietly dropping the held
  tickets would change the plan the person just approved. A dead holder is taken over
  with a line, as the land and gate locks are.
- **A hold is git's own worktree lock.** `git worktree lock --reason …` makes
  `git worktree remove` refuse, even with one `--force`, whoever runs it. azelf reads
  holds from `git worktree list --porcelain`. A `.slice-hold` note in the worktree is
  for whoever looks with `ls`. Git has no lock against `git rebase --abort`, so that
  half is a rule in `/azelf`.
- **No plan-time overlap check from ticket text.** See item 5 above. The cheap fix
  that works is in the park message.
- **A land refused as diverged rebases again, twice at most, and then parks.** The
  land lock is not stretched over the gates and review: that would hold every other
  dispatcher's lands behind a ten-minute review. The review is skipped on the retry
  when the new base commits touched none of the slice's files, because then the
  slice's diff is byte-identical. The gates always run again.

## Phase 1 — a rebase that brings new dependencies installs them

- [ ] **1a. Reinstall after the pre-gate rebase.** In `tryLand` (`slice-run.ts:3390`),
  read the slice's merge-base before the rebase loop and again after it. If they
  differ and `git diff --name-only <before> <after>` names a `package.json`,
  `bun.lock` or `bun.lockb` (by basename, as `MANIFESTS` matches at
  `slice-run.ts:1940`), run `bun install --frozen-lockfile` in the worktree before
  `gatesPass`:

  > #137: the rebase brought a new package.json, bun.lockb — reinstalling in its worktree …

  The slice's own dependency changes don't count: its session installed them. The
  resolver path ends at the same place, so it is covered.
- [ ] **1b. A failed install parks** as `gates`, with reason `bun install failed after
  the rebase (the lockfile may not match package.json) — run bun install in the
  worktree, commit the lockfile if it changed, and azelf retry <id>`. Its last few lines
  of output are printed under it.

  *Proof:* **`sliceRun.test.ts`**. The fixture's base gains a `package.json` commit
  while a slice is open. The landing slice's install runs once, before its gate. Use a
  root `postinstall` that writes a marker, or a stub install the test can see. A base
  move that touches no manifest installs nothing. A failing install parks with the
  reason above. The first test fails on the old code.

## Phase 2 — an interrupted land is finished, not restarted

- [ ] **2a. The record.** Right after `git push` succeeds (`slice-land.sh:172`), write
  `<common>/azelf-landed-<ticket>.txt`. It holds the landed head, the declared head
  from the done marker, the commit count, and the full close comment (land notes and
  the `landed on … as …` line). To get this, move the marker reads
  (`slice-land.sh:309-320`) and the `landed_line` computation (`slice-land.sh:371-380`)
  up, before the push. The record is deleted as the script's last step, once the close
  succeeded. On a failed close it stays, beside the existing `azelf-close-<ticket>.txt`.
- [ ] **2b. Close, then clean up.** Move "closing" (`slice-land.sh:382-397`) up, before
  "cleaning up" (`slice-land.sh:308`). The `--end-session` handling stays after the
  removal, for the reasons given at `slice-land.sh:274-283`.
- [ ] **2c. Finishing.** `slice-land.sh <ticket>` looks for a record **before** the
  branch check at `slice-land.sh:80`, because the branch may already be gone. With one,
  it takes the land lock and says:

  > ── finishing the land of #101 — it pushed as 46802d7 at 14:31, and the process running it stopped before it was done ──

  Then it checks that `origin/<base>` contains the recorded head (after a fetch), and
  refuses loudly if not. It releases the DB lock if this branch holds it, closes the
  ticket with the saved comment if it is still open, cleans up as in 2d, and deletes
  the record.
- [ ] **2d. A half-removed worktree.** In finish mode only: if `git -C <wt> status
  --porcelain` shows nothing but deletions and HEAD is the recorded head, use
  `git worktree remove --force`. Anything else is left in place with today's message.
  If git can't read the worktree at all (its `.git` file is gone), leave it and say:

  > left ../repo-ticket-101 — git can no longer read it (its removal was interrupted). Everything in it landed as 46802d7; delete the directory and run git worktree prune.

  azelf never `rm -rf`s a directory it can't inspect.
- [ ] **2e. The dispatcher finishes its own.** After "proceed?" (`slice-run.ts:4060`),
  next to the retry-marker sweep (`slice-run.ts:4075`): for each ticket in the run that
  has a record, run `slice-land.sh <id>`. If it is closed afterwards, it counts as
  landed (`t.open = false`). If it is still open, it goes into `closePending`, and
  `retryCloses` keeps trying. A ticket with a record is never `runnable` and never
  `awaitingLand`. A record for a ticket outside the run gets one line and is left
  alone:

  > #101: its land was interrupted after the push — ./scripts/slice-land.sh 101 finishes it

  *Proof:* **`sliceLand.test.ts`**:
  - a land whose record is left behind, with the worktree half-deleted (some tracked
    files removed) and the ticket open. `slice-land.sh` finishes it: closed with the
    saved comment, worktree and branch gone, record gone;
  - the same with the branch already deleted;
  - a worktree with a modified file is left in place.

  **`sliceRun.test.ts`**: a run whose ticket has a record finishes it and never preps
  or launches it. A record for a ticket outside the run prints the line and touches
  nothing. On the old code, the first dispatcher test opens a session.

## Phase 3 — one dispatcher per ticket

- [ ] **3a. Claims.** Before "proceed?" (`slice-run.ts:4060`), the dispatcher takes
  `<common>/azelf-run-<ticket>.lock` for every ticket in its plan. It uses
  `tryTake` from `slice-lock.ts`, with no wait. The owner is its own pid, start time,
  and its argv as the label. If any ticket's lock is held by a running process, it
  releases what it took and exits 1:

  > ✗ #102, #103 are already being dispatched by another run (pid 45696, since 14:55): azelf run -y --auto 102 103 104 107 108
  >   Two dispatchers on one ticket race each other's rebases, sessions and lands. Stop that one first, or run the rest on their own:
  >
  >     bunx azelf run -y --auto 107 108

  The command is `resumeCommand`'s shape, minus the held ids. If no ids are left,
  there's no command. A dead holder is taken over with
  `took over #102 from a dispatcher that is no longer running (pid 30498)`. The claims
  are released on exit. `--plan` only reports the holder, and takes nothing.
  `--gates` and `--retry` don't claim.
- [ ] **3b. `azelf retry` names its dispatcher.** `--retry` (`slice-run.ts:3850`) reads
  the claim. With a live holder it says
  `the running dispatcher (pid 45696) retries #103 next round`. With none it says
  `no running dispatcher has #103 — azelf run --auto 103 starts one`, and still writes
  the marker.
- [ ] **3c. A rebase the resolver left behind.** `resolveConflict`
  (`slice-run.ts:2874`) writes `azelf-resolver` into the slice's **git dir**
  (`git rev-parse --git-path`, so it is never a tree change) with the dispatcher's pid
  and start time, and removes it when it returns. `noteHandWork`
  (`slice-run.ts:2710`) checks it before saying "someone is fixing it by hand". If the
  file names a process that is no longer running:

  > #102: a rebase is in progress in its worktree, left by the conflict resolver of a dispatcher that is no longer running (pid 30498). Nothing will finish it: finish it by hand, or git -C ../repo-ticket-102 rebase --abort and azelf retry 102.

  *Proof:* **`sliceRun.test.ts`**:
  - a second dispatcher on an overlapping set exits 1 with both lines and the command,
    and preps nothing;
  - on a disjoint set it runs;
  - a claim left by a dead pid is taken over;
  - `azelf retry` names the live holder.

  A worktree mid-rebase, with an `azelf-resolver` naming a dead pid, gets the new
  line. On the old code, the first test preps.

## Phase 4 — hand work in a worktree is held

- [ ] **4a. `azelf hold <ticket> [--by <who>] [--why <text>]` and
  `azelf release <ticket>`.** In `bin/azelf.ts` (`bin/azelf.ts:69`), as
  `retry` is: spawned into `slice-run.ts` with a flag handled before the plan.
  - `hold` runs `git worktree lock --reason "azelf hold: <who> — <why>" <wt>`, adds
    the time, and writes `.slice-hold` into the worktree, saying the same thing and how
    to release it. It writes the note only where git ignores it, as `noteLanded` does.
    `--by` defaults to `$USER`.
  - If there is no worktree, `hold` refuses. If the ticket is already held, it prints
    the holder and exits 1.
  - `release` unlocks and removes the note. If the ticket isn't held, it says so.
- [ ] **4b. Who respects a hold.**
  - **The dispatcher** reads holds once a round from `git worktree list --porcelain`
    (`locked azelf hold: …`). A held slice is not landed, relaunched, rebased, or
    auto-finished. The dispatcher says so once when it sees the hold, and once when
    it ends:

    > #102 is held by the re-port session since 14:55 (re-porting onto #101) — not landing or relaunching it until azelf release 102

    It keeps the run waiting, the way a hand rebase does (`noteHandWork`). The round
    line counts `N held`, and the run's ending lists holds with the release command.
    When a held worktree has a rebase in progress, `noteHandWork` names the holder.
  - **`slice-land.sh`** refuses a held ticket before the land lock:
    `#102 is held by … — azelf release 102 first`. Without this, its
    `git worktree remove` would fail on the git lock with a misleading message.
  - **`slice-session.sh`** won't launch a session into a held worktree. Provisioning
    (4c) is allowed.
- [ ] **4c. `azelf provision <ticket>`.** For a worktree re-added by hand, or one
  missing its files: `slice-session.sh <ticket> --provision`. It re-adds the worktree
  from the branch if git no longer lists it. It copies the `provisionCopy` files that
  are missing, and names the ones already there (it never overwrites). It runs
  `bun install` and rewrites `.slice-ticket.md` and `.slice-parent.md`. It skips the
  label, blocker and open-state checks, writes no `.slice-flags`, and launches
  nothing. It refuses when a live session is in the worktree, and when there is
  neither a worktree nor a branch (`azelf run <id>` starts it).
- [ ] **4d. The next step after IRRECONCILABLE.** When a park's reason is the
  resolver's refusal (`stopProblem`, `slice-resolve.ts:121`), `askAboutBlocked`
  (`slice-run.ts:3339`) prints two more lines. The first names the collision, from
  `landedWhileOpen` and `landedFiles` intersected with the conflicted files, and only
  when there is one. The second gives the recipe:

  > it collides with #101, which landed components/capture/VideoEditor.tsx while #102 was open
  > to re-port it by hand: azelf hold 102, rebase it onto master in its worktree and commit, then azelf release 102 — the moved branch retries the land

- [ ] **4e. `/azelf` says what not to do in someone else's worktree.**
  `agent/commands/azelf.md` gains a short section on taking over or cleaning up after
  a run:
  - never `git rebase --abort`, `reset --hard`, or remove a slice worktree you didn't
    start;
  - a rebase in progress with no session may be someone's unstaged work, so ask;
  - `git worktree list` shows holds as `locked`;
  - hold a worktree before working in it by hand, and release it after.

  `.slice-hold` joins `EXCLUDE_BLOCK` (`slice-init.ts:60`).

  *Proof:*
  - **`sliceRun.test.ts`**: a held slice that is done and green is not landed. The
    hold line is printed once. After `release`, the next round lands it.
  - **`sliceLand.test.ts`**: a held ticket is refused before the lock, and
    `git worktree remove --force` on it fails.
  - **A provision test:** a worktree re-added with `git worktree add` and missing a
    `provisionCopy` file gets it, and gets `.slice-ticket.md`. An existing copy is
    left alone.
  - **An IRRECONCILABLE park** prints the collision and the recipe.
  - The init tests count the new exclude line.

## Phase 5 — a land overtaken during the review rebases again

- [ ] **5a. Say why `slice-land.sh` refused.** The diverged refusal
  (`slice-land.sh:155-159`) exits 75 (`EX_TEMPFAIL`: try again after a rebase).
  Everything else keeps exiting 1.
- [ ] **5b. Rebase again in `tryLand`.** On 75, up to `LAND_RACES = 2` times per
  `tryLand`:

  > #103: master moved while it was being gated and reviewed (now 0e28eaa) — rebasing again

  Then go back to the rebase, which brings Phase 1's reinstall and the resolver with
  it. Run the gates again. Run the spec review again only if the commits between the
  old merge-base and the new one touched a file in `changedFiles`, or the rebase
  needed the resolver. Otherwise say `review skipped — the new commits on master
  touch none of #103's files`. After the second race it parks as `land`, as today.
  The README's "Two dispatchers" (`README.md:1191`) and "What retries a parked slice"
  sections change to match.

  *Proof:* **`sliceRun.test.ts`**:
  - the fake reviewer pushes a commit to the base on an unrelated file while it
    reviews. The land is refused once, rebased, gated again, not reviewed again, and
    lands in the same round;
  - the same commit on one of the slice's files gets a second review;
  - a reviewer that moves the base every time parks after two races.

  The first test parks on the old code.

## Order and cost

Phase 1 first: it is small, and every bump hits every open slice with it. Phase 2 is
next because a crash at the wrong moment can open a session on a half-deleted tree.
It's the largest, mostly shell. Phase 3 is small, built on `slice-lock.ts`, and it
removes the double-dispatcher state that entries 3 and 4 started from. Phase 4 is
three small commands plus messages. Phase 5 only saves time, and goes last. Phases 1
and 5 both touch `tryLand`'s rebase step, so 5 builds on 1. The rest are independent.

## Not in this plan

- **A plan-time overlap check from ticket text.** Item 5 above says why. If the
  ticket writer starts declaring files (a `## Touches` section), azelf could read it
  the way it reads `## Blocked by`: a declared fact, not a guess.
- **Calling a type error in a file the slice didn't touch "probably environment".**
  #102's entry asks for it. consumer-a's `slice.config.ts` explains why the
  touched-file test is wrong in both directions (a type change breaks files it didn't
  edit), and Phase 1 removes the cause seen here.
- **Stopping a hand `git rebase --abort`.** Git has no lock for it. The hold note and
  the rule in `/azelf` are the levers.
- **Holds that expire.** A hold has no process behind it. It stays until it is
  released, and the run's ending lists it.
- **Lands interrupted on an azelf before this plan.** They have no record and still
  need the hand fix.
- **A dispatcher killed mid-gate or mid-review.** Nothing is pushed yet, and the next
  run rebases and gates again. Only time is lost.
- **Still open from the lock-and-review plan:** a restarted dispatcher's plan review
  covers only its own run; a named closed ticket is polled every round; an agent left
  idle after an API error.
- **The `gh … unexpected EOF` recurrence** noted under the overlap entry was on
  `7ffe3a0`. Since `28c5777`, a failed read is logged and the round skipped.

## What the consumer does itself

- **The bump after each phase, and `azelf init` after Phase 4** for the new exclude
  line. The bump in Phase 1 is the first one that reinstalls in open slices on its own.
  Until then, a slice prepped before a bump needs `bun install` in its worktree and
  `azelf retry` after its first park.
- **After Phase 3,** drop the `ps | grep slice-run.ts` guard before restarts.
- **After Phase 4,** re-port a parked slice under `azelf hold`, and repair a re-added
  worktree with `azelf provision`.
- **When two tickets of one spec rebuild the same component,** add a blocking edge
  between them when writing the tickets. That's what was done for #107 and #108 ←
  #102.
