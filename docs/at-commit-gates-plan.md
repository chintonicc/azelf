# A stuck session can see every red, and a cheap gate can warn at the commit

**Status:** Phase 1 landed 2026-11-10 (its hash goes after its heading with Phase 2) · Phase 2 open
**Written:** 2026-11-09
**Companion:** the consumer-b friction entry of 2026-11-08, Backend #197, the only one since
`comments-gate-log-next-land-plan.md` was written. consumer-a's log has no open entry.

Written so it can be picked up cold. Tick the boxes as they land and add the commit hash
after the heading. Line numbers are as of `d937fdd`.

## What happened

1. **A zone break is found after the build.** The consumer's zone gate is its first and cheapest
   gate, and it reads only the slice's own diff. But gates run at `slice-gates.sh`, at the end. On
   #197 the file in question was in the slice's very first commit, the gate went red on a finished
   build, and the slice ended `--stuck`.
2. **The first red gate hides the others.** `runGates` stops at the first failure
   (`slice-gates.ts:667`). The zone gate comes first, so that run said nothing about the suite. That
   the suite was green the session had to find out by hand, and the person who decides a `--stuck`
   gets one fact where two were cheap to have.
3. **Two lists for one zone, and no per-ticket exemption for it.** Both are the consumer's own
   scripts. azelf does not know what a zone is. See "What the consumer does itself".

## Decisions

- **`--keep-going` is opt-in and by hand only.** Not the default for a session: one that fixes a lint
  finding would pay for the suite on every re-run, and Frontend #148 measured that at eight minutes
  under load. Not at the land: a red slice does not land, so the remaining gates buy nothing. It pays
  just before `--stuck`, so the skill says it there.
- **A gate opts in to the commit with `atCommit: true`,** beside `when` and `retries`. Off by default;
  a config that does not say it changes in nothing, and pays nothing.
- **It is advice.** A commit is never refused for it and the exit code stays what it was. The land's
  run is the verdict. The DB lock is the one thing a commit is refused for, and that guards a live
  database.
- **It runs after the commit, with the commit lock already released.** It judges what was committed
  (`main...HEAD`). Under the lock it would hold up every other session's commit in the repo, whose wait
  ends at 30 seconds (`session-commit.sh:34`).
- **Only in a slice worktree,** told by `.slice-ticket.md`. A main checkout has no diff against its base.
- **It runs on a dirty tree,** because the session's next files are in progress. `runGates` refuses a
  dirty tree, so it gets a mode that compares with the state before instead. An `atCommit` gate must
  therefore judge commits and not the working tree, and the option's comment says so.
- **No marker and no memory.** Every commit asks again, so a red stays visible until it is fixed.

## Phase 1 — every red at once

- [x] 1a. `GateContext.keepGoing`. `runGates` collects failures in `failures: {gate, why, detail,
  output}[]`, on a red result only, and goes on; the first failure stays the result's `why`,
  `detail` and `output`, so every reader stays as it is. The write check still stops at once: a
  gate that wrote has spoiled what follows.
- [x] 1b. `gatesPass` with `opts.keepGoing` prints every failure. `.slice-reviews/last-gate.log` holds the
  output of each red gate under its name.
- [x] 1c. `--keep-going` on `--gates`, in `slice-run-usage.ts`, and through the `gates` verb
  (`bin/azelf.ts:130`). `slice-gates.sh` passes it already.
- [x] 1d. The skill, "If the gates will not go green": once with `--keep-going` before `--stuck`, and
  every red named in `-m`. README, the `slice-gates.sh` line.
- [x] 1e. Tests: goes on after a red and names both; the first failure is still the result's `why`; a
  gate that writes stops it anyway; without the flag it stops at the first, as today.

### What building it found

- **`failures` exists only on a red result.** A green run keeps exactly the shape it had.
- **The file is decided per gate.** A red gate whose output was shown whole adds nothing to the
  decision, so two short red gates write no file, as one short one does not.

## Phase 2 — a cheap gate can warn at the commit

- [ ] 2a. `atCommit?: true` on `Gate` and `GateOptions`, carried by `exitCode`, `exitCodeOverFiles` and
  `baselineDiff`. `slice-config.ts` refuses it together with `landOnly`.
- [ ] 2b. `GateContext.dirtyOk`: `runGates` takes the state before as its reference and names a gate only
  if the state changed.
- [ ] 2c. `azelf run --gates --at-commit`: the `atCommit` gates of the slice here, `dirtyOk` and
  `keepGoing`, no gate lock, no `last-gate.log`, not through `gatesPass` (which refuses a dirty tree).
  Prints the gate, its reason and that the commit stands and the land runs this gate too. Always exits 0.
- [ ] 2d. `SLICE_HAS_AT_COMMIT_GATES` from `--sh` (`slice-config.ts:972`), so a commit in a config without
  such a gate starts no second `bun`.
- [ ] 2e. `session-commit.sh`, last step: with `.slice-ticket.md` and the variable, release the lock, then
  run it, `|| true`. After the optional push.
- [ ] 2f. README: the gate options and the `session-commit.sh` row. The skill, one line: a warning after a
  commit means the land will refuse this; fix it now, or say so with `--stuck`.
- [ ] 2g. Tests: a red gate warns, the commit stands, exit 0; the lock is free while the gate runs; a main
  checkout does not run it; a config without `atCommit` does not start it; it runs on a dirty tree; a gate
  that writes is named; `atCommit` with `landOnly` is refused.

## Unobserved, once built

Tested with fake gates. On consumer-b's next real runs: does a session act on the warning at once, or
carry on and meet it at the end? Does anyone use `--keep-going` before `--stuck`?

## Order and cost

Phase 1 first, because Phase 2 reports through it. Phase 1 is small, Phase 2 small to medium. One commit
each. Either can stop there and be useful.

## Not in this plan

- **A per-ticket exemption in azelf.** azelf does not know zones, and the script that judges them is the
  consumer's.
- **Refusing the commit on a red `atCommit` gate.** A person decides a zone break. A refused commit
  takes away the session's only way of keeping its work, and tells nobody more than the warning does.
- **Judging the staged files before the commit.** The gates read `main...HEAD`. A staged view is a second
  contract for what one line after the commit already gives.
- **The merge train.** Still decided against in `relaunch-and-blips-plan.md`.

## What the consumer does itself

- consumer-b, backend, once Phase 2 is pulled and `azelf init` has run: `atCommit: true` on the zone gate.
- consumer-b, backend: feed the zone gate from the list its diff check already reads, which replaces the
  exception added by hand on 2026-11-08. A per-ticket exemption for the forbidden zone is a question for
  the people who own those files, and the pattern exists beside it for the hot zone.
- consumer-a: bump the pin and run `azelf init`. It needs no `atCommit` gate unless it wants one.
