# A formatter that could not write says so, and a slice that needs a person hands itself over

**Status:** OPEN — 1 of 2 phases landed · **Written:** 2026-10-19
**Companion:** consumer-a's friction log: the three entries still open after `fd72b89`,
one dated 2026-10-12 and two dated 2026-10-13. Every other entry is covered by a
complete plan or a fix.

Written so it can be picked up cold. Tick the boxes as they land and add the commit hash
after the heading. Line numbers are as of `fd72b89`.

## What happened

1. **`format.sh` reported success on files it could not write.** A session on
   consumer-a's main checkout ran `./scripts/format.sh` on nine paths while its sandbox
   denied writes to the checkout. Biome printed `Operation not permitted (os error 1)`
   eight times and `Skipped 8 file(s)`, but also `Fixed 8 file(s)`, and the script
   exited 0.

   Reproduced on `fd72b89` with biome 1.5.3, the version consumer-a runs. An immutable
   file (`chflags uchg`, EPERM) and a read-only one (`chmod a-w`, EACCES) each give an
   `internalError/io` diagnostic, `Fixed 1 file(s)`, and exit 0. `format.sh` passes
   biome's status straight through (`format.sh:199-205`), so it reports success too.
   `Skipped N` is no signal on its own, because an unmatched `.md` is counted there as
   well.

2. **Two slices stopped on something only a person could do, and nothing in the run
   said so.**
   - #176 held the DB lock to apply its migration. The first apply hung for 39
     minutes and came back as `Invalid or expired requestState`, and so did every
     later call that carried the migration. The database's MCP server asks the client
     to confirm a statement it judges destructive, and nobody was there to answer in
     the slice's tab. The session moved
     its migration out of the lock paths, committed, released the lock, wrote the
     friction entry and ended its turn.
   - #182 was relaunched to finish its migration. Its MCP server came up signed out,
     offering only an OAuth sign-in that needs a browser. The auto-mode classifier
     refused the CLI fallback. The session parked its migration as a draft, released
     the lock and ended its turn.

   In both cases the session followed the contract (`SKILL.md:99-107`: say what is
   failing, and exit) and then sat idle in its REPL. `.slice-live` named a live session,
   so the dispatcher waited, as it should for a session at work, and said nothing. A
   person found each one by reading its tab, and the main session applied both
   migrations by hand. Had either tab been closed instead, the slice would have read as
   finished under `--auto` and gone to its gates and review with half a ticket.
   `autoFinished` (`slice-run.ts:2660`) asks only for no session, some commits and a
   clean tree.

   **Both causes are gone on consumer-a, and neither was azelf's.**
   - On 2026-10-12 its MCP URL gained `skip_elicitations=apply_migration`, so a
     migration applies without a prompt.
   - #182's sign-out was caused by that URL change. A changed URL is a new server to
     the client's OAuth store, and #182 started before anyone had signed in again.
   - Since then #186, #187 and #188 have applied their migrations from slice tabs
     without a prompt, and the server is signed in (checked 2026-10-19).

   What is left is azelf's part: a slice that is stuck on a person has no way to say
   so. The next one will be stuck on something else: a sign-in, a confirmation, a
   device or a secret.

## Decisions this plan makes

- **A write `format.sh` could not make fails the script.** It reads biome's diagnostics
  for `internalError/`, names each file, and exits 1 even when biome exits 0. `--check`
  does the same, because there the error means the file was not read. Biome's own
  output still reaches the terminal as it does today.
- **A slice that needs a person hands itself over with a hold.** `azelf hold` already
  means "someone has to do something in here first". A held slice is not landed,
  relaunched, rebased or read as finished, and the run carries on around it and does
  not end while it is held. The run says so once, with who and why (`noteHolds`,
  `slice-run.ts:3048`), and lists it again at its end. The slice takes that hold on
  itself, with its reason. The dispatcher gets no new state.
- **The hand-over goes through `slice-done.sh`, not a new script.** It is the one
  finishing command every slice already knows, it reads the ticket from the branch, and
  its shim exists. `--hand-over "<what a person has to do>"` takes the hold and leaves
  the rest as it is: no ready marker, no clean-tree or commit check, and `.slice-live`
  stays.
- **After the release, the slice is not read as finished.** The hand-over also writes
  `.slice-interrupted`. The dispatcher already reads that marker as "stopped before it
  was done" (`autoFinished`), and `slice-session.sh` clears it at every launch
  (`slice-session.sh:522`). So after `azelf release`, a session still open in its tab
  is waited for, as now. One that has ended is started again. A person who finished
  the work by hand runs `slice-done.sh`, and its ready marker lands the slice. Closing
  the tab on a clean tree with commits cannot land half a ticket.
- **The lock stays the slice's call, as now.** The contract says to release it if
  nothing under the lock paths was applied, so other DB tickets can go on. If anything
  was applied, the slice keeps it and says what.

## Phase 1 — `format.sh` fails on a file biome could not write (e0b75c1)

- [x] **1a. Read the diagnostics.**
  - Run biome through `tee` into a temp file, and keep its status from `PIPESTATUS`.
    `set -e` must not exit on it first.
  - Find the `<path> internalError/…` header lines. Keep colours when stdout is a
    terminal (`--colors=force` when `[ -t 1 ]`) and strip escapes before matching, so
    a person still sees what they see today.
  - When any are found, print `✗ biome could not write N file(s), so they are NOT
    formatted:` with one path per line, and exit 1 whatever biome returned. Under
    `--check` the line says `could not read`.
- [x] **1b. The usage says it.** Add one line to `usage()`: a file biome cannot write
  or read fails the run, even when biome's own summary counts it as fixed.

  *Proof:* **`format.test.ts`**. The fake `bunx` gains a mode that prints an
  `internalError/io` diagnostic for `a.ts` and exits 0.
  - `format.sh a.ts` exits 1 and names `a.ts`, and so does `format.sh --check a.ts`.
  - A fake that prints `files/missingHandler` for an `.md` and exits 0 still passes.
  - The first two fail on `fd72b89`.

**As landed.** All in `format.sh`, after the paths are settled. The flags are built
into arrays, so there is one biome call for both modes. Changes from the plan:
- Both of biome's streams go through `tee` (`2>&1`), because 1.5.3 prints its
  diagnostics on stderr and only the summary on stdout. The `✗` line and the paths go
  to stderr. A person at a terminal sees the same text, in the order biome wrote it.
- The match is `^<path> internalError/` on a line that does not start with a space,
  read with `LC_ALL=C` after the escapes are stripped. A path with a space comes
  through whole. Each path is named once, in biome's order.
- The fake `bunx` prints the file `bunx-says` to stderr while it exists. A third test
  feeds it a header in biome's escapes, because the test's stdout is never a terminal.
  The new tests failed on `fd72b89` and the `.md` one passed.
- The README's `format.sh` paragraph gets one sentence too.
- Checked by hand with real biome 1.5.3 under `/bin/bash` 3.2: an immutable file, a
  read-only one and a read-only `sp ace/c.ts` gave `Fixed 4 file(s)`. The script named
  the three and exited 1. Under `script` (a pty) the colours stayed and the match still
  held. `--check` on an unreadable file exited 1. A clean run exited 0, and no temp log
  was left behind.
- The log is made with `mktemp` in `$TMPDIR`. A sandbox that denies that too stops
  the script there, with an error and before biome runs. That failure is loud, not
  silent.

## Phase 2 — a slice that needs a person hands itself over

- [ ] **2a. `slice-done.sh --hand-over "<why>"`.**
  - Parse the flag before the refusals (`slice-done.sh:50-64`), which don't apply to
    it.
  - Take the hold the way `azelf hold` does: `bun "$SLICE_AZELF_DIR/scripts/slice-run.ts"
    --hold <n> --by "its session" --why "<why>"`, run from the worktree.
    `findRepoRoot` resolves the main checkout from there (`slice-config.ts:321`).
  - Write `.slice-interrupted` with the session's pid from `.slice-live`. Write no
    ready marker, and leave `.slice-live` in place.
  - Print the hold line, then `end your turn — a person takes it from here`.
  - Refuse an empty reason with exit 64 and lock nothing: the reason is the whole
    message to the person. Refuse a worktree that is already held, and name the hold.
- [ ] **2b. The contract.** Add a section to the slice `SKILL.md`, before "If the gates
  will not go green", titled **If only a person can get you further**:
  - The cases: a sign-in, a confirmation prompt nobody will answer in this tab, a
    device, a secret.
  - Don't retry in a loop, and don't wait in the session.
  - Commit what you have, and put anything you could not apply where a person will
    find it.
  - Release the DB lock if nothing under the lock paths was applied. If something
    was, keep it and say so.
  - Then run `./scripts/slice-done.sh --hand-over "<what the person has to do, and
    where your work is>"` and end your turn.

  The self-land half of the start instruction in `slice-session.sh` gets one line
  that points at this section.
- [ ] **2c. The run's line says what comes after.** `noteHolds` already prints `#176
  is held by its session since 20:24 (<why>) — not landing or relaunching it until
  azelf release 176`. For a hold the slice took on itself, add what happens after the
  release: `then tell its session to go on, or finish it by hand and run
  ./scripts/slice-done.sh in its worktree — a session that has ended is started
  again`. The end-of-run list stays as it is.
- [ ] **2d. README.** Add one paragraph under holds: a slice can hold itself, and why.

  *Proof:*
  - **`sliceLand.test.ts`**:
    - `slice-done.sh --hand-over "sign in"` in a dirty worktree with no commits locks
      the worktree with `azelf hold: its session since … — sign in`. It writes
      `.slice-interrupted` and no `.slice-ready-to-land`, and leaves `.slice-live`.
    - With an empty reason it exits 64 and locks nothing.
  - **`sliceRun.test.ts`**, under `--auto`, a slice that handed over with a clean tree
    and commits, and whose session then ended:
    - while held, it is neither landed nor relaunched, and the run's line carries the
      reason;
    - after `--release`, it is relaunched, not landed.

    On `fd72b89` the same slice without the hand-over is landed.

## Order and cost

Phase 1 first. It is one script and one test file, and every agent that formats under a
sandbox can believe a formatter that did nothing. Phase 2 is mostly text: one flag in
`slice-done.sh`, which reuses `--hold` and the existing interrupted marker, one
`SKILL.md` section and one line in `noteHolds`. The two phases touch different files.

## Not in this plan

- **Checking before launch that the database's MCP server is signed in.** This was
  #182's suggestion. azelf doesn't know which tool a slice reaches the database
  through, and a health check's output is not a contract. A check would not see a
  confirmation prompt either, which is what #176 hit. The sign-out that was seen came
  from a config change. After Phase 2 such a case costs one hold line instead of an
  idle tab nobody reads.
- **Reading `requestState` errors in the dispatcher.** This was #176's second
  suggestion. The dispatcher never sees a session's tool calls. The agent does, and
  Phase 2 gives it the way out.
- **A warning before dispatching a ticket that will apply DDL.** This was #176's first
  suggestion. `exclusiveLockLabel` already declares those tickets. With the prompt gone
  from `apply_migration`, a DDL ticket runs unattended.
- **Still open from earlier plans:**
  - an agent left idle after an API error, with no marker (Phase 2 covers only an agent
    that knows it is stuck);
  - a restarted dispatcher's plan review covers only its own run;
  - a named closed ticket is polled every round.

## What the consumer does itself

- **The bump after each phase.** After Phase 2, run `azelf init` too, for the new
  `SKILL.md` section.
- **Keep `skip_elicitations=apply_migration`** on the MCP URL in `.mcp.json`. It
  reaches new worktrees through `provisionCopy`. `execute_sql` still asks before
  statements the server judges destructive, so DDL goes through `apply_migration` only.
  A dry run inside a rolled-back transaction can still ask: #176's did.
- **Sign in again after changing the MCP server's URL,** before the next DB ticket
  starts (`/mcp` → the server → Authenticate, from the main checkout).
