# An unattended run that outlives a flaky network and starts only agent work

**Status:** IN PROGRESS — Phase 1 landed · **Written:** 2026-10-08
**Companion:** consumer-a's friction log (an untracked file in its main checkout, not in
this repo), entries dated 2026-10-06 to 2026-10-08. `docs/run-polish-plan.md` covers
the three smaller open entries from the same log.

Written so it can be picked up cold. Each item says what to change, where, why, and what
proves it. Tick the boxes as they land and add the commit hash after the heading. Line
numbers are as of `7ffe3a0`; search for things by name once a phase has moved them.

## What happened

The friction log has seven open entries. These are the three where an unattended run
either died or would have started the wrong work.

1. **One failed `gh` call ends the run** (two entries, seven crashes). Over two days
   and two dispatchers, a single `gh issue view <n> --json number,title,state,url,labels`
   failed mid-run, and the dispatcher exited 1. Three different errors came back: x509
   "certificate signed by unknown authority", "connection reset by peer", and `EOF`.
   Seconds later `gh` answered normally each time. The live sessions kept working with
   nothing to land them. consumer-a now wraps the dispatcher in a shell loop that
   restarts it on this crash.

   The cause is one call site. `refreshOpenState` (`slice-run.ts:943`) calls
   `tracker.get` for every ticket at the top of every round (`slice-run.ts:3614-3617`).
   The adapter throws on any `gh` failure, which is deliberate (`slice-tracker.ts:492`):
   a plan must not be built from a failed read. Every other tracker read in the round
   already catches (`ticketBody`, `parentSpec`, `bodyHash`). This one doesn't, and the
   loop has no catch around it.

2. **A related danger, found while reading the code and not yet seen on a real run.**
   The same network makes the close after a land fail. `slice-land.sh:383-390` treats
   that as a warning, which is right: the code is pushed. Next round, though,
   `refreshOpenState` reads the ticket as open again and sets `t.open = true`.
   `runnable` (`slice-run.ts:996`) then sees an open ticket with no worktree, no
   session, no marker and no park, so it preps a fresh worktree and opens a new agent
   session on a ticket that has already landed. Its dependents fail prep every round,
   because `slice-session.sh` still counts it as an open blocker.

3. **A ticket meant for a person was planned as runnable.** `azelf run --plan 98 99 …`
   put #99 in wave 1. #99 carries consumer-a's `ready-for-human` label (a check on a
   device only a person can do) and not the ready label. azelf knows only one label
   (`readyLabel`) and has no idea what a human ticket is.

   The plan did say so: `⚠ not labelled ready-for-agent: #99 — running it because you
   named it` (`printNamed`, `slice-run.ts:440`). That line is also wrong. A dispatch
   does not run the ticket. `slice-session.sh:184` refuses any ticket without the ready
   label, so the prep fails, and the dispatcher retries the same refused prep every
   round. Nothing parks it, so the run never ends, and #99's dependents never start.
   Checked on the test fixture with `--once -y 2` on an unlabelled #2: the plan says
   "running it", then `error: #2 is missing the 'ready' label`. The refusal is in the
   first commit (`07099bc`) and predates the decision to run named tickets, so nobody
   chose this outcome.

   Leaving #99 out of the set doesn't help either. A blocker outside the set is read
   once, at load (`foreignBlockers`, `slice-run.ts:373`), and never again. #105,
   "blocked by #99 (outside this set)", can't start in that run even after a person
   closes #99.

4. **A slice was cut without commits the base branch already had.** Local `master` was
   two commits ahead of origin, including a file the ticket had to edit. The prep cut
   `ticket/93` from `origin/master` (`slice-session.sh:236-249`). The fetch already
   happens right before `git worktree add`, so fetching again would not have helped.
   The real mismatch: the land rebases onto *local* `master` (`rebaseOntoBase`,
   `slice-run.ts:2192`) and pushes it (`slice-land.sh:155-172`). So local-only commits
   are missing from the slice but go out with the first land anyway, and neither half
   is printed anywhere.

## Decisions this plan makes

Each one changes behaviour someone may rely on. Overrule them before Phase 1 starts, not
after. The three marked *(user)* were chosen by the maintainer on 2026-10-08.

- **A failed tracker read in the loop is "no news", not an error.** A ticket keeps its
  last known state, and the round goes on. The run stops only after 30 minutes in which
  every read failed, and then it exits through its normal ending with a resume command.
  Reading state late is safe: an open ticket that is really closed waits one more round.
- **A ticket this run landed stays closed for the rest of the run**, whatever the
  tracker says. The dispatcher retries the close until it succeeds.
- **A `humanLabel` ticket is a gate, not a slice** *(user)*. This is a new optional key;
  `init`'s preset writes `"ready-for-human"`. Such a ticket is never dispatched, even
  when named. It stays in the plan as "waiting on a human" and blocks its dependents in
  that run. Unset, nothing changes.
- **When only human work is left, the run exits** *(user)*. This is the same rule as
  "every open slice is parked": stop, name what is waiting, and print the resume
  command. It does not wait for the person.
- **A named ticket without the ready label really runs.** That is what `printNamed`
  promises and what `docs/dispatch-safety-plan.md` decided. The prep is told it was
  named, and skips the label check. A ticket carrying `humanLabel` is refused even
  then.
- **Slices are cut from what will land** *(user)*. If local `baseBranch` contains
  `origin/<baseBranch>`, the cut is local, and the plan says how many commits that adds
  and that the first land pushes them. If the two have diverged, the dispatch refuses,
  because no land could push.

## Phase 1 — a flaky tracker does not end the run (`28c5777`)

- [x] **1a. `refreshOpenState` reads each ticket on its own, and failures don't throw.**
  - **The change.** A try/catch per ticket. On failure the ticket keeps `t.open` as it
    was. The function returns the failures (`{ id, error }[]`) and whether every read
    failed. It no longer reads tickets this run landed (1b).
  - **What the loop prints.** At most one line per change, like the round line:
    - the first failed round of a streak:

      > [round 45] couldn't read #114 from GitHub — keeping its last state, trying again next round: Post "https://api.github.com/graphql": EOF

      Only the first line of `gh`'s error: the adapter attaches all of stderr.
    - nothing more while the same tickets keep failing, except on the heartbeat
      (`heartbeatMs`, the round line's ten minutes), which says how many rounds;
    - when every read works again, once:

      > [round 47] GitHub answers again (#114 unreadable for 2 rounds)

  - **The ceiling.** A round in which *every* read failed starts an outage clock, and the
    first round with one good read resets it. After 30 minutes the run stops through 1c,
    with reason "GitHub has not answered for 30 minutes". The duration can be changed
    through `SLICE_TRACKER_OUTAGE_SECONDS`, in the same style as
    `SLICE_HEARTBEAT_SECONDS` (`slice-run.ts:3350`), so the test doesn't wait half an
    hour. One ticket that always fails (say, deleted) never stops the run. It is named
    on every heartbeat instead.
  - **Why not retry inside the adapter.** The adapter's reads also run at plan time,
    where a failure stops before anything has started, which is the right failure. Only
    the loop has something to lose, so only the loop learns to wait.

- [x] **1b. A landed ticket is not reopened, and its close is retried.**
  - `tryLand` already records `landedHeads` (`slice-run.ts:3037`). `refreshOpenState`
    skips those tickets' `t.open`, which stays `false`.
  - **Separately**, once per round, each landed ticket the tracker has not yet confirmed
    closed is read. If it is still open, the dispatcher calls `tracker.close(id,
    comment)` itself. The comment names the landed head and says this is the
    dispatcher's retry, because the close right after the land failed. One line on the
    first failure, one on success. A ticket read as closed once is not read again.
  - **The ending.** A landed ticket still open when the run ends gets its own block
    before the parked list:

    > ── landed, still open on GitHub (1) ─────────
    >   #40  close it by hand: its dependents' sessions refuse to start while it is open

  - In-run dependents need nothing new. Their prep refuses while the blocker is open
    (`slice-session.sh:195-202`), "failed to prep — skipping this round" retries them
    every round, and they start the round after the close goes through.

- [x] **1c. A round that throws ends the run with what it left behind.**
  - Wrap the round body (`slice-run.ts:3610-3891`) in a try/catch. On catch, and on 1a's
    outage, one shared function prints:

    > ✗ the dispatcher stopped in round 45: <first line of the error>
    >   still running, with nothing to land them: #111 #113

    It sets `process.exitCode = 1` and breaks out of the loop into the normal ending.
  - **The ending prints the resume command for this exit too.** Today
    `resumeCommand()` is printed only under "parked" (`slice-run.ts:3933`). A restart
    adopts live sessions cleanly (the friction log saw it do so four times), so the
    command is all that's needed.
  - A plan-time error (in `loadTickets`, before the prompt) is left as it is: nothing
    has started.

  *Proof*, in `sliceRun.test.ts`, with `--interval 1`:
  - **The fake tracker** (`fixture.ts:224`) gains two switches, each a file in the
    fixture root: while `tracker-down` exists, `get` and `body` throw; while
    `close-fails` exists, `close` throws. The `Consumer` gets helpers to set and clear
    them.
  - **A brief outage.** Two tickets, #40 already done. Take the tracker down after
    round 1 and bring it back three rounds later. The run does not exit. "couldn't read"
    appears once, "answers again" once, and #40 lands.
  - **A long outage.** With `SLICE_TRACKER_OUTAGE_SECONDS=2` and the tracker down for
    good, the run exits 1. It prints "has not answered", names the live session, and
    prints `bunx azelf run …` as its resume line.
  - **A failed close.** With `close-fails` set, #40 lands, and the land warns that it
    could not close. The next rounds never print `prepping #40`. Clear the switch, and
    the run prints the retry's success, and the tickets file reads #40 closed.
  - The catch in 1c is three lines, and its output comes from the same function the
    long-outage test covers. It gets no test of its own.

**As landed.** The lines name `tracker.name`, not GitHub, since azelf takes other
trackers. They read "GitHub" on consumer-a and "Fake" in the tests. The try/catch is
around the whole loop, not the round body: a throw leaves the loop and goes to the
same ending, with no body re-indented twice. It also prints the error's stack, because
a network blip never reaches it, so anything that does is a bug. Landed tickets are
skipped by `landedFiles`, which every land sets, rather than by `landedHeads`, which is
set only when the head reads back. When the close fails, `slice-land.sh` saves the
comment it would have left in `.git/azelf-close-<id>.txt`, and the dispatcher's retry
posts that comment, so the unticked checks still reach the ticket. The ending reads
pending closes once more before the block, so a run that ends in the round of its
last land does not list a close that went through. The block is titled "landed, not
seen closed on <tracker>", because an unreadable ticket may already be closed. It sets
exit 1, since a ticket is left to close. The full suite passes (404). vitest's
"Timeout calling onTaskUpdate" errors under load also show up on `cf908c5`.

**What the consumer does:** the bump. Then drop the shell loop that restarts the
dispatcher on this crash. It would now hide a real error behind a restart.

## Phase 2 — a human ticket is a gate, not a slice

- [ ] **2a. `humanLabel` in the config.**
  - `SliceConfig` gains `humanLabel?: string`, documented next to `exclusiveLockLabel`
    (`slice-config.ts:87`). It is validated as a non-empty string, and not equal to
    `readyLabel`.
  - The preset writes `humanLabel: "ready-for-human"` (`slice-preset.ts:366`), so a new
    `init` gets it. README's configuration table gains a row.

- [ ] **2b. Held in the plan, whoever named it.**
  - **`loadTickets`** (`slice-run.ts:266`) sets `human: true` on a set ticket carrying
    the label. A bare run only meets one when it also carries the ready label, so the
    case that matters is a ticket named explicitly.
  - **Outside blockers.** For every open blocker outside the set, the plan reads it once
    through the cached `get` and records whether it carries the label
    (`foreignHuman`).
  - **`runnable`** (`slice-run.ts:996`) excludes `human` tickets.
  - **`printTree`** prints a held ticket in its wave with `[waiting on a human]` and
    leaves it out of the `(runnable now)` count and the widest-wave figure. That figure
    is the default `--max`.
  - **`printNamed`** gets a line of its own:

    > ⚠ #99 is labelled ready-for-human — not starting it; #105 waits until it is closed

- [ ] **2c. A blocker outside the set is read again every round.**
  - `refreshOpenState` also reads each distinct outside blocker, which is a handful of
    extra calls per round, and drops the closed ones from `t.foreignBlockers`. A
    ticket held by an outside blocker then starts the round after a person, or another
    dispatcher, closes that blocker.
  - Failures follow 1a: a blocker that can't be read keeps holding.

- [ ] **2d. The run stops when only human work is left.**
  - **Next to the parked rule** (`slice-run.ts:3842-3855`), a ticket is "waiting on a
    human" when it is `human`, when an outside blocker is `foreignHuman`, or when an
    open blocker in the set is itself waiting on a human. That last case takes a
    closure over `blockedBy`.
  - **The condition.** Nothing is running or startable, every remaining ticket is either
    parked with no retry due or waiting on a human, and at least one is waiting on a
    human. Then:

    > nothing can advance — what is left waits on a human:
    >   #99  ready-for-human — blocks #105
    >   Close it when it is done, then pick the run up again:
    >
    >       bunx azelf run -y 99 105

    Exit 1, through the same ending as 1c.
  - **The round line** gets a `N waiting on a human` bucket. As with `to land` and
    `queued`, it is printed only when it isn't zero, so a watcher matching the old line
    keeps working.
  - **One behaviour change to note.** A ticket held by an outside blocker that isn't a
    human ticket keeps the run waiting, as it always did. The difference after 2c is
    that the wait can now end. Two dispatchers on one repo is the case: one closes what
    the other waits on.

- [ ] **2e. A named ticket without the ready label is prepped.**
  - **The dispatcher** passes `--named` to `slice-session.sh` for each id in
    `unlabelled`. It goes both on the prep call (`slice-run.ts:3726-3737`) and on the
    session command (`sessionFor`, `slice-run.ts:1151`). Under a marker launcher, prep
    parks it in `.slice-flags` next to `--self-land` (`slice-session.sh:342-349`).
  - **`slice-session.sh`** accepts `--named` and skips the ready-label refusal
    (`slice-session.sh:184-188`) with it. The open-state and blocker checks stay.
  - **The tracker bridge** answers `get` with a fourth field,
    `state<TAB>ready<TAB>human<TAB>title` (`slice-config.ts:673-677`; the reader is
    `slice-session.sh:178`). A ticket carrying `humanLabel` is refused with or without
    `--named`:

    > error: #99 is labelled ready-for-human — a person does this one, not a session.

    Both halves ship in one package, so the field's order can change in one commit.
    Update the comment on `slice_tracker_get` (`slice-config.sh:14`).

  *Proof:*
  - **`sliceRun.test.ts`.** The fake tracker already takes `labels`. With `humanLabel:
    "human"` passed through `configExtra`:
    - `--plan 2 3`, with #2 labelled `human` and #3 blocked by #2, shows #2 held and
      prints the 2b line;
    - `-y --interval 1 2 3` prints no `prepping #2` and exits 1 with "waits on a human"
      and a resume line naming #2 and #3;
    - a bare run where #3's only blocker is #2 (outside the set, labelled `human`)
      exits the same way;
    - #3 blocked by #5, outside the set and not human, with #5 closed in the tickets
      file after round 2: #3 is prepped (2c).
  - **The probe as a test.** `--once -y 2` on an unlabelled #2 prints `prepping #2` and
    `✓ prepped`, and no "missing the 'ready' label".
  - **`sliceSessionClose.test.ts`**, which starts `slice-session.sh` directly: a
    `human`-labelled ticket is refused with `--named`; an unlabelled one is refused
    without it and prepped with it.
  - **`sliceInit.test.ts`**: the preset carries `humanLabel`.

**What the consumer does:** add `humanLabel: "ready-for-human"` to `slice.config.ts` by
hand. `init` does not rewrite an existing config.

## Phase 3 — a slice starts from what will land

- [ ] **3a. The prep cuts from local when local is ahead.** In `slice-session.sh:236-249`,
  after the fetch, for a new branch:
  - `origin/<base>` is an ancestor of local `<base>`: cut from local `<base>`, and say
    so when it adds commits:

    > ✓ created worktree at … on new branch ticket/93, from local master (2 commits ahead of origin — the first land pushes them)

  - local is an ancestor of origin: cut from `origin/<base>`, as today;
  - diverged: exit 1, and name both heads and the way out (pull or rebase local
    `<base>`). No worktree is created.

  The resume path (`origin/<branch>` exists) and the existing-branch path are left as
  they are. This runs for a slice started by hand too, which is the point: a hand
  session and a dispatched one start from the same commit.

- [ ] **3b. The plan says it before anything is cut.** After `printNamed`
  (`slice-run.ts:3425`):
  - The dispatcher runs `git fetch origin <base>`, for `--plan` too. If the fetch
    fails, it says so and compares against the last fetch.
  - Then it compares. Ahead:

    > ℹ master is 2 commits ahead of origin/master. Slices are cut from it, and the first land pushes them:
    >     a1b2c3d <subject>
    >     d4e5f6a <subject>

    Up to five subjects, then "… and N more".
  - Diverged: a `✗` line with both counts. A dispatch then exits 1 before `proceed?`,
    like `refuseOverBodyBlockers` (`slice-run.ts:522`), and `--plan` exits 0:

    > not dispatching: master and origin/master have diverged (2 and 1 commits), so no land could push. Pull or rebase master first.

  - Behind or level: nothing is printed.

  *Proof:*
  - **`sliceRun.test.ts`**, with a remote: commit on the main checkout's `main` without
    pushing, then `--once -y 40` with no worktree for #40. The new worktree's `HEAD`
    contains that commit, and the plan printed the `ℹ` line with its subject.
  - Diverged: push a commit from a second clone, and commit locally. `--plan` exits 0
    with the `✗` line, and `-y` exits 1 with "not dispatching" and no worktree.
  - Level: neither line appears. Existing tests already cover that, so check that none
    of them now prints the `ℹ` line.

## Order and cost

Phase 1 ships first and alone: it is the only one that has cost real runs, seven times.
It takes half a day, most of it the fake tracker's switches and the three multi-round
tests.

Phase 2 is the largest, about a day. 2e is small but touches the shell bridge's output
format, so its tests need to pass on both halves before it lands.

Phase 3 is half a day. Phases 1 and 2 both edit `refreshOpenState`; land them in that
order.

## Not in this plan

- **The three smaller open entries:** `--sync-edges` missing a freshly filed ticket,
  the DB lock block every round, and the plan review for one slice. See
  `docs/run-polish-plan.md`.
- **A prep refused for a reason that won't go away is retried every round.** 2e removes
  the case that was seen. A blocker edge added mid-run would still loop the same way.
  Parking a refused prep is a separate change.
- **Left over from entries already marked partly fixed:** an up-front warning for
  sibling slices that add to the same TESTING.md journey; a spec with the ready label
  and no children yet; a crashed `--auto` slice with a clean tree and no marker
  counting as finished.
- **The x509 failures themselves.** "Certificate signed by unknown authority" every
  45–50 minutes is something on the machine (a VPN, proxy or security tool replacing
  certificates), not GitHub. After Phase 1 it costs a log line instead of a run, but
  the cause is worth finding.

## What the consumer does itself

- **The bump** after each phase; **`humanLabel`** in `slice.config.ts` after Phase 2.
- **Retire the restart wrapper** once Phase 1 has run through an outage.
- **Name the human ticket in the run** after Phase 2, e.g. `azelf run 98 99 105`.
  Its dependents then start in the same run if the person finishes in time, and the
  run says what it is waiting for if not.
