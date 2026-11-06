# A ticket's comments are part of it, a red gate keeps its output, one land at a time across runs, and an adopted session can see the run's mode

**Status:** built 2026-11-06 on branch `comments-gate-log-next-land`, not on `main` yet · Phase 1 dca95f3, Phase 2 61702bc, Phase 3 ef4be5a, Phase 4 cb9a300 · see "Unobserved"
**Written:** 2026-11-06
**Companion:** the consumer-b friction entries of 2026-11-06 that came after
`relaunch-and-blips-plan.md` was written: Backend #196, twice (binding assumptions only in an
issue comment; a change of mode a session cannot check), Frontend #148 (a red gate does not
name the red part), Frontend #146/#147/#148/#150 (three dispatchers on one repo). Frontend #150
needs nothing here; see "Not in this plan".

Written so it can be picked up cold. Tick the boxes as they land and add the commit hash
after the heading. Line numbers are as of `0b5c108`.

## What happened

1. **Phase 4 of the last plan gets this wrong.** `.slice-refs.md` carries the ticket's own
   comments, and the prompt says "read what the ticket points you to" and "a requirement only
   they state is not yours". On #196 the working assumptions and a lock on one file stood in the
   ticket's own comment, and its body does not point at it: only a question to the dispatcher
   session found them. Under that wording a session would have read past them, and the spec
   review never saw them.
2. **A red gate keeps its last ten lines.** `tail(out)` (`slice-gates.ts:134`). The consumer's
   runner prints each red part first and then a table of everything, about 130 lines, so the name
   is never in the window. On #148 a second full run, eight minutes at load 35, was only for the
   name.
3. **Three dispatchers on one repo lost races for an hour.** The land lock covers the land and not
   the rebase, gates and review before it, which `README.md` chose so that "every other run's lands"
   would not "wait behind a ten-minute review". On 2026-11-06 #146 was reviewed three times and
   parked on "main moved under it 3 times" (`LAND_RACES`, `slice-run.ts:5198`), each round a rebase,
   a resolver, `npm ci`, gates and a review. Lands are serial either way. What the waiting avoided was
   cheaper than what it cost.
4. **A session cannot check a change of mode.** On #196 a run was restarted under `--auto`, and
   another session told this one that `slice-done.sh` now applied. Its prompt forbids that and
   nothing in the worktree said otherwise, so it asked and stayed. That was right, and it cost a
   question to a person who was away.

## Decisions

- **A ticket's own comments are the ticket.** They go at the end of `.slice-ticket.md`, and the
  spec review reads the same text. `.slice-refs.md` is for other tickets only, where "not yours"
  is true. Ticket and comments are one thing for "the ticket was edited" as well: a correction is
  usually a comment. A later comment can correct what is above it.
- **The whole output of a red gate goes to one file**, `.slice-reviews/last-gate.log` in the
  worktree, named on red when the lines shown are not all of it. No parsing of a runner's format.
- **One slice at a time goes from rebase to land, across runs.** A reservation beside the land lock,
  keyed by the remote like it, taken before the rebase and released after the land or the park. A run
  that finds it held skips landing for that round and does everything else, so it blocks nothing. It
  is an optimisation and not a safety lock: `LAND_RACES` stays for a hand merge, and a slice that
  goes on without the reservation only risks the race it has today. This reverses the sentence in
  the README, with the numbers above.
- **It is released before a question to a person**, who may be gone. Without `-y` the land then goes
  on unreserved. Under `-y` there is no question, and a resolver keeps it.
- **No attaching to a running plan, no refusal of a second dispatcher.** The first is
  `--watch-labels` again, which `resolver-and-refresh-plan.md` rejected: claims, waves, overlap report
  and blockers all take the ticket set as fixed. The second would stop what the reservation makes
  harmless.
- **The mode gets its own marker, not `.slice-flags`.** Flags are read back by the next session "only
  ever to turn something ON" (`slice-session.sh:574`), so a `--self-land` written for an adopted
  session would land a later session started by hand. `.slice-run-mode` says what this run is, is
  written only for a session started before it, and goes when the next session starts.
- **It is evidence, and nothing acts on it by itself.** A session told nothing stays with its prompt.
  A run does not land an adopted session that said it finished: that session was told a person
  releases it, and #196's last comment waits for exactly that.

## Phase 1 — a ticket's comments are part of it

- [x] 1a. `ticketText(tracker, id)` in `slice-tracker.ts`: the body, then the comments under a heading
  that says they are part of the ticket. Comments that cannot be read get a line, and the body stands.
- [x] 1b. The `brief` verb and `ticketBody` in `slice-run.ts` use it.
- [x] 1c. `bodyHash` covers body and comments; null when they cannot be read, as today.
- [x] 1d. `refsBrief`: no own comments. Names are read from the body and the comments.
- [x] 1e. The skill and the README say so.
- [x] 1f. Tests: the brief has the comments; the review's spec has them; a new comment after a BLOCK
  counts as an edit; thread failing keeps the body and never reads as changed; `.slice-refs.md` has
  no own comments, and no file when only own comments exist.

### What building it found

- **A name in a comment counts as a name.** Comments are the ticket now, so `.slice-refs.md` follows
  what they name as well as what the body names. The cap holds if a long report in a comment names
  many.
- **A comment by a session or a report also counts as an edit.** After a BLOCK under `--auto` that opens
  a session, which finds nothing to do and finishes, at the cost of a few minutes. Telling a person's
  comment from a report is not something the tracker answers.

## Phase 2 — a red gate keeps its output

- [x] 2a. `GateResult.output?`, set by the gates that run a command.
- [x] 2b. `gatesPass`: on red, when `output` has more lines than `detail`, writes
  `.slice-reviews/last-gate.log` and names it. Only where git ignores it; `last-block.md` gets the same
  guard. The repair round's failure text names it too.
- [x] 2c. Tests: a long red output is saved whole and named; a short one writes no file; the tree stays
  clean; a not-ignored path writes nothing and the gate still reports.

## Phase 3 — one land at a time across runs

- [x] 3a. `nextLandDir(checkout)` in `slice-lock.ts`, beside `landLockDir`.
- [x] 3b. The round's land: `reserveLand(next)`, or a line said once per holder and on to the rest of the
  round. A dead holder is taken over, and said.
- [x] 3c. `park` releases before a question to a person.
- [x] 3d. README, the paragraph that said the opposite.
- [x] 3e. Tests: held by a live process, nothing is gated and the run goes on; the holder ends and it
  lands; two real dispatchers on two slices run the gates twice, not three times; released after a
  land and after a park.

## Phase 4 — an adopted session can see the run's mode

- [x] 4a. Round 1: for each live session this run did not start and that does not self-land,
  `--auto` writes `.slice-run-mode` where git ignores it and says so; without `--auto` it removes one.
- [x] 4b. `slice-session.sh` removes it at start. In `EXCLUDE_BLOCK`.
- [x] 4c. The skill says what to do with a message about a change of mode.
- [x] 4d. Tests: written for an adopted session under `--auto`, not for one with `--self-land`, not without
  `--auto`; gone at the next start; the session is not landed for it.

## Unobserved

Tested with fake agents and a fake tracker. On consumer-b's next real runs: does a session act on
comments at the end of `.slice-ticket.md` without being told more? Do two dispatchers on one repo now
stay out of each other's way? A person at a prompt is the one path without a test, since it needs a
terminal. Nothing yet says whether a session ever checks `.slice-run-mode`.

## Order and cost

Phase 1 first and before anything is pulled: it corrects what is on `main`. 2 and 4 are small, 3 is small
to medium. One commit each.

## Not in this plan

- **Frontend #150, one build directory for every slice.** `scripts/mock/mock_build.mjs` in the consumer
  defaults to one path under tmp. Deriving it from `$SLICE_PORT_BASE`, which azelf already exports, is
  one line there.
- **The red part's name in the runner's last line.** The consumer's `run-alle-kerne.mjs`. Worth doing, and
  theirs.
- **The stacked land.** Still decided against in `relaunch-and-blips-plan.md`. The reservation removes
  the lost races that the entry on three dispatchers counts in its favour.

## What the consumer does itself

- consumer-b: once its runs have ended, pull azelf-run and run `azelf init` in both clones, for
  `.slice-refs.md`, `.slice-run-mode` and the skill.
- consumer-a: bump the pin and run `azelf init`.
