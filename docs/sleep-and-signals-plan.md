# A run says when the Mac sleeps, and stops when it is told to

**Status:** planned · nothing built
**Written:** 2026-11-12
**Companion:** `one-session-plan.md` (Backend #227) and what was found while restarting consumer-b's
two dispatchers after it.

Written so it can be picked up cold. Tick the boxes as they land and add the commit hash after the
heading. Line numbers are as of `8656917`.

## What happened

**The sleep.** The `pmset -g log` for the #227 evening (2026-11-09, times EST) shows:

- At 13:55:33: `Entering Sleep state due to 'Clamshell Sleep' … Using Batt`. The lid was closed on
  battery.
- From then until the night, the Mac only DarkWaked: 2–12 s about every 15 minutes, while the charge
  stayed at 82–83%.
- The dispatcher's `caffeinate -is` was alive the whole time. Its assertions show `ClientDied` only
  at 14:10, 14:27 and 15:03, each after 15–20 minutes.

Why it held nothing:

- `-i` prevents idle sleep only.
- `-s` "is valid only when system is running on AC power" (`man caffeinate`).
- A lid closed on battery sleeps whatever is held. All 11 clamshell sleeps in the log are on
  battery, and there is no sleep on AC power in it.

`slice-config.ts:192-197` already says so in the `keepAwake` doc ("`-s` holds only on mains power,
and a closed lid sleeps regardless"). The run itself says nothing. It prints "keeping this Mac
awake while the run lasts" (`slice-run.ts:7145`) on battery too, and stays silent while the Mac
sleeps.

Since `one-session-plan.md`, a sleep no longer leads to a second session; it only pauses the work.
What is missing is that anyone is told: before, that a closed lid will stop the run, and afterwards,
in the log, that it did.

**The signal.** consumer-b's backend session restarted its dispatcher (`azelf run --auto -y --max 4
…`). It sent SIGINT to the outer `bun …/bin/azelf.ts run`. That ended the wrapper only:

- `slice-run.ts` (pid 52191) ran on, adopted by init.
- It still held the dispatch claim, so the restart was refused with "already being dispatched by
  another run" (`slice-run.ts:5985`).
- Only a second SIGINT, sent straight to `slice-run.ts`, ended it.

The cause is `bin/azelf.ts:136-141`. The wrapper runs the dispatcher with `spawnSync(…, { stdio:
"inherit" })` and exits with its status:

- While `spawnSync` blocks, no JS handler in the wrapper can run, and with none installed a signal
  ends the wrapper by its default.
- Ctrl-C in a terminal works anyway, because it reaches the whole foreground group. A signal sent
  to the wrapper's pid reaches the wrapper alone.
- `provision` (`:144-156`) and `push-main` (`:160-168`) have the same shape.

## Decisions

- **The wrapper passes signals on.** `bin/azelf.ts` starts its child with an async `spawn`, stdio
  inherited as now. It forwards SIGINT, SIGTERM and SIGHUP to the child, and does not die of them
  itself. It exits with the child's code, or 128 + the signal number when the child died of one.
  This is one helper for all three spawns.
- **A forwarded copy is not a second signal, and needs no rule.** Ctrl-C reaches both the wrapper
  and the dispatcher, so a forwarded SIGINT arrives right behind the terminal's own, and a second
  signal "quits at once" (`stopSignalArrived`, `slice-run.ts:340`). The plan was a 1 s window. Built
  and tested, it changed nothing. The dispatcher handles signals only in its sleep between rounds
  (its one `await`). Once the first has woken it, everything to the exit is synchronous, so the copy
  is never handled. Two copies pending during a gate are one pending signal. The window was taken
  out again. The test that Ctrl-C through the wrapper stops after the round stays, and it catches
  this if a round ever awaits.
- **The run says it is on battery.** At the start, and once each time the power source changes to
  battery, the run prints one line. It says that on battery a closed lid puts the Mac to sleep
  whatever `caffeinate` holds, that the run pauses until the Mac wakes, and to keep the lid open or
  plug in.
  - The line is read from `pmset -g batt` ("Now drawing from 'Battery Power'"), through `PATH` so a
    test can stand in for it.
  - Only on macOS and not for `--once`, like `keepMacAwake`. With `keepAwake: false` it still prints:
    the lid sleeps either way.
  - When `pmset` cannot answer, nothing is printed.
- **The run says when it slept.** If the wait between two rounds (`slice-run.ts:7588-7596`) took 60
  s or more longer than `--interval` by the wall clock, the next round prints one line: the Mac was
  asleep, or this process was stopped, for about N minutes (HH:MM–HH:MM), and the run was paused.
  - The test threshold comes from an environment variable, like `SLICE_HEARTBEAT_SECONDS`.
  - A night of DarkWakes prints one line per wake. That is the evidence #227 lacked, and is
    accepted.
- **No `pmset disablesleep`.** It needs `sudo`, and changes the machine for everything on it.
  Whether the Mac may sleep is the owner's setting; azelf says what it costs.

## Phase 1 — the wrapper passes signals on

- [x] 1a. `bin/azelf.ts`: one `runChild(cmd, args, env?)`, an async `spawn` with `stdio: "inherit"`.
  It forwards SIGINT, SIGTERM and SIGHUP to the child, and exits with the child's code or 128 +
  signal. `run`/`retry`/`relaunch`/`hold`/`release`/`gates`, `provision` and `push-main` use it.
  The comment says why: the backend restart that found an orphaned dispatcher holding its claim.
- [x] 1b. ~~`stopSignalArrived`: a same-kind signal within 1 s is the same one.~~ Not needed, see
  Decisions. The reason is in `runChild`'s comment instead.
- [x] 1c. Tests:
  - SIGINT to the wrapper's pid alone makes the dispatcher print "SIGINT — stopping after this
    round", leave through the normal ending, and release its claim, and the wrapper exits with its
    code.
  - SIGTERM, the same way.
  - Ctrl-C (SIGINT to the wrapper's process group) during a gate that ignores it stops after the
    round, with the ending and the claim released.
  - `provision`/`push-main` under a signal leave no child behind.

## Phase 2 — the run says when the Mac sleeps

- [ ] 2a. `slice-run.ts`, next to `keepMacAwake` (`:7136`): `onBattery()` reads `pmset -g batt`.
  It is null when the answer is unknown.
- [ ] 2b. The battery line at the start, and once per change to battery, checked each round.
- [ ] 2c. The sleep line, from the wall-clock length of the wait between rounds.
  `SLICE_SLEEP_GAP_SECONDS` sets the threshold for tests (default 60).
- [ ] 2d. `keepAwake`'s doc (`slice-config.ts:188-198`) points at the battery line. The README's
  keepAwake paragraph says the same, if there is one.
- [ ] 2e. Tests:
  - A fake `pmset` on `PATH` reporting battery gives the line at the start; reporting AC, it does
    not.
  - A switch to battery mid-run gives it once.
  - A dispatcher held with SIGSTOP for a few seconds past a small `SLICE_SLEEP_GAP_SECONDS`, then
    SIGCONT, prints the sleep line once.
  - The macOS-only tests are skipped elsewhere.

## Unobserved, once built

- Does the battery line get read before someone closes the lid?
- Does a night of DarkWakes make the log noisy enough to want one summary line instead of one per
  wake?
- Does a Claude session that drives a dispatcher now stop it by its wrapper's pid?

## Order and cost

Phase 1 first: it is a bug, and it gets in the way of every restart after an update. Both phases are
small. One commit each.

## Not in this plan

- **Keeping the Mac awake with the lid closed** (`pmset disablesleep`, clamshell mode with an
  external display). See Decisions.
- **Counting the launch window in awake time.** Phase 2 of `one-session-plan.md` asks the process
  table instead.
- **A summary of sleep across a whole night.** Only if the per-wake lines turn out to be noise.

## What the consumer does itself

- consumer-b, consumer-a: pull or bump, and run `azelf init` (nothing in init changes). Restart
  running dispatchers. Until Phase 1 has landed, stop one by sending the signal to `slice-run.ts`
  itself, not to the wrapper.
