# A slice has one session, even across a sleep

**Status:** complete · Phase 1 and Phase 2 landed 2026-11-12
**Written:** 2026-11-10
**Companion:** the consumer-b friction entry of 2026-11-10, Backend #227, the only one since
`at-commit-gates-plan.md`. consumer-a's log has had no new entry since 2026-10-20.

Written so it can be picked up cold. Tick the boxes as they land and add the commit hash
after the heading. Line numbers are as of `59b50a1`.

## What happened

On #227 two `slice-session.sh 227` ran in the same worktree for three and a half hours, each with
its own agent. `.slice-live` named only the second. Near the end the first found the second's
uncommitted changes and stopped without writing anything. Nothing was lost, by luck.

The guard against exactly this exists (`slice-session.sh:204-221`, since `32d0786`) and was in the
version that ran. It did not fire, because the Mac was asleep on battery and ran only in DarkWakes
(`pmset -g log`, times EST):

| When | DarkWake | What ran |
| --- | --- | --- |
| 21:01:28 | 6 s | The tab's `slice-session.sh` (pid 33903) starts at 21:01:29, passes the guard, and the Mac sleeps again before it writes `.slice-live`. |
| 21:17:48 | 11 s | The dispatcher wakes. Its launch was 16 minutes ago by the wall clock, Warp's window is 120 s (`slice-launcher.ts:353`), and there is no marker, so the start "failed": it preps again (`.slice-flags` 21:17) and opens a second tab. pid 35268 starts at 21:18:00, finds no marker, and passes the guard. |
| 21:39:05 | 42 s | Both finish their prep, both write `.slice-live` (the second a second later) and both start an agent: 21:39:28 and 21:39:30. |

Two holes, one on each side:

1. **The session claims its slice too late.** The guard reads `.slice-live` at `:214`, and the
   marker is written at `:636`. Between them are five calls through the tracker (get, open-blockers,
   brief, parent, refs). That window is seconds when awake, and as long as the Mac sleeps when not.
   A second run in that window sees no marker.
2. **The dispatcher counts a start that slept as a start that failed.** `occupied()` measures the
   window with `Date.now()` (`slice-run.ts:1430`), and wall-clock time runs on in sleep. It looks for
   the marker only, not for a `slice-session.sh` that is still on its way to writing one.

## Decisions

- **Claim first, then do the slow part.** A run of `slice-session.sh` writes `.slice-live` with its
  pid right at the guard, created exclusively (`set -C`), before any tracker call. The check and the
  write become one step. A marker whose pid is not a live session of this ticket (the same test as
  today) is replaced; a live one refuses the run, as today.
- **The trap goes with the claim.** The trap that removes the marker only if it is still this
  run's is set where the claim is made. A run that is refused later (the ticket is closed, a blocker
  is open) leaves no marker behind.
- **Every run that passes the guard claims, except `--provision`.** That includes the dispatcher's
  `--prep-only`, which exits and clears it before the tab opens. `--provision` is refused while a
  session runs and is not a session.
- **A worktree that does not exist yet is claimed right after `git worktree add`.** No session can
  be in a worktree that is not there, and git refuses a second worktree on the same branch.
- **The dispatcher asks the process table, not the clock alone.** A ticket whose launch window has
  passed is still occupied while a `slice-session.sh` with that ticket on its command line is
  running. It is one `ps` per round. A process stuck before it claims is still a process.
- **No awake-time clock.** Whether Bun's monotonic clock stops in sleep on macOS would have to be
  proven per version. The process table answers the question that is actually asked.

## Phase 1 — the session claims its slice before anything slow (bb73fa2)

- [x] 1a. `slice-session.sh`: the guard (`:204-221`) becomes the claim (`claim_slice`). Write
  `.slice-live` with `set -C`. If the file is there, its pid is a live `slice-session.sh` with this
  ticket, and that pid is not `$$`, refuse as today. If the pid is not live, remove the file and try
  once more; a second failure means another run claimed it in between, so check again and refuse.
  A dead pid goes to `.slice-interrupted` first, unless one is there: that is what the dispatcher
  writes when it finds such a marker, and a run refused after the claim must not take the evidence
  of a crash with it.
- [x] 1b. The trap (`remove_own_live_marker`) is set at the claim. The write at `:636` is gone: a
  worktree that did not exist at the guard is claimed right after `git worktree add`, the same way.
- [x] 1c. `--provision` neither claims nor writes the marker; it is still refused while a session
  runs.
- [x] 1d. The comment at the claim says why: Backend #227, a second run in the window between guard
  and marker.
- [x] 1e. Tests (`sliceSessionClose.test.ts`, the fixture's tracker can now hold `get` and `body`):
  a run held inside its tracker calls has already written `.slice-live` with its pid; a second run
  for the same ticket meanwhile is refused and the marker keeps the first pid; a marker of a dead pid
  is taken over and kept as `.slice-interrupted`; a run refused after the claim (closed ticket) leaves
  no marker; `--prep-only` leaves none; a new worktree is claimed once it exists; `--provision` writes
  none.

## Phase 2 — the dispatcher does not take a sleeping start for a failed one

- [x] 2a. `startingSession(n)`: is a `slice-session.sh` with `n` on its command line running? One
  `ps -ax -ww -o pid=,command=` per round, read with the same words as `isSessionOf`
  (`slice-run.ts:1194`, now shared as `runsSliceSession`). The process must also work in this
  repo's main checkout or in the ticket's worktree (`lsof`, `/proc` on Linux), only asked of the
  processes that match: both consumers run on one Mac, and their ticket numbers overlap. When `ps`
  or the directory cannot be read, the answer is no and the window decides, as before; since
  Phase 1 a wrong no costs only a tab that is refused.
- [x] 2b. `occupied(n)` (`:1427`) is also true while one is running. The "never came up" line
  (`:7283`) leaves out such a ticket and keeps its `launchedAt`; both follow from `occupied`, since
  `idleWorktrees` asks it.
- [x] 2c. Tests (`sliceRun.test.ts`, "a start the Mac slept on"; the fixture has a stand-in
  `slice-session.sh` that never claims, `asleepSession` and `launch: "asleep"`): a launched ticket
  whose window has passed, with its `slice-session.sh` running and no marker, is not launched
  again; once that process is gone it is, as today. One started by hand in the main checkout
  keeps the ticket from starting; one for the same number in another checkout does not.

  In this test a relaunch happens at the top of the round in which the window ran out, before the
  "never came up" line is reached. That line prints only for a ticket that is not started again
  in the same round (no free slot, held for disk), so it is not what the tests check.

## Unobserved, once built

Tested with a held tracker call and fake processes. On consumer-b's next run on battery: does a
DarkWake start still end in one session? Does a refused second tab say clearly why it exits?
Does `lsof` answer quickly enough on a busy machine? It is asked only of processes that already
match the ticket. A start stuck before its claim stays "running" with no quiet note, because
`noteQuiet` reads the marker. Nothing has been seen to stick there while awake.

## Order and cost

Phase 1 first: it alone makes a second session impossible, because the second run is refused. Phase 2
spares the second tab and the wrong "never came up" line. Both small. One commit each.

## Not in this plan

- **A check in the prompt** that `.slice-live` is the session's own, which the friction entry
  suggests. Once the claim is atomic, a second session cannot start, and a check an agent has to
  remember is weaker than a run that is refused.
- **Keeping the Mac awake on battery.** It slept on battery during a run whose `keepAwake` was on.
  What put it to sleep anyway is the machine's setting, not azelf's. azelf has to be right across a
  sleep either way.
- **An awake-time clock for the launch window.** See Decisions.

## What the consumer does itself

- consumer-b, consumer-a: pull or bump and run `azelf init`. A dispatcher that is running has to be
  restarted for Phase 2.
