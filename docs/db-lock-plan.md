# The exclusive-path lock: from a scan to a claim

**Status:** Phase 1 LANDED 2026-09-23 · Phase 2 LANDED 2026-09-23 · Phase 3 LANDED 2026-09-25 · **Written:** 2026-09-23
**Companion:** `scripts/db-lock-check.sh` header (the current design and its known
limitation), `docs/extraction-plan.md` (how the scripts got here).

Written so it can be picked up cold. Each phase says what to change, where, why, and
what proves it. Tick the boxes as they land and add the commit hash after the heading.

## What happened

Two slices in one `--auto` wave on consumer-a (one live Supabase database, no PITR) both
needed a migration. Both sessions reported what follows independently; both accounts agree
and were checked against the scripts on 2026-09-23.

1. **The lock never guards the DDL.** `db_lock_holder` runs at three moments — slice launch
   (`slice-session.sh:204`), commit (`session-commit.sh:200`) and before the dispatcher
   starts a wave (`slice-run.ts:1884`). All three scan git state, so all three can only
   *notice* a migration after it has been written. The apply against the live DB happens
   between launch and commit, and nothing refuses it. Verified: the two slices applied
   migrations nine minutes apart, and the first refusal arrived at commit time, about the
   git record, after both applies were done.
2. **Two migration-bearing slices deadlock each other.** `db-lock-check.sh:162` exempts
   only the caller's branch, so two worktrees each holding an uncommitted migration each
   name the other as holder. Nothing orders them; waiting cannot resolve it. Both sessions
   ran pollers against a condition that could never become true, and the error text ("let
   that one merge first") was advice neither could follow. The dispatcher's own check
   excludes nothing (`db_lock_holder ""`), so it saw the lock held and started nothing:
   the whole run stalled silently.
3. **The commit mutex is per-worktree.** `session-commit.sh:120` locks under
   `--git-dir`, which in a linked worktree is `.git/worktrees/<name>`. The comment at
   `:96` calls that scope deliberate (it guards one index); the header of
   `db-lock-check.sh:57` claims the same mutex serializes the DB check across worktrees.
   The second claim is false. Practical impact is small — the scan reads persistent state,
   so two commits cannot both pass it — but the promise is broken and the fix is one word.
4. **There is no sanctioned override.** When 2 fired, the only way forward was raw
   `git add`/`git commit` — the exact thing `session-commit.sh` exists to prevent. One
   session did it, transparently and with the operator's explicit ordering decision; the
   other refused to take a peer's say-so as approval. Both were right, and the tool
   forced the choice.
5. **Landing rewrites SHAs, and nothing records the result.** `slice-land.sh` is
   `--ff-only` and rewrites nothing, but the dispatcher rebases any branch that is behind
   base before landing it (`rebaseOntoBase`, `slice-run.ts:1083`). In a multi-slice wave
   that is every slice after the first, so `git merge-base --is-ancestor <slice sha> base`
   is a false negative for most landed slices. Both sessions reasoned about landing state
   that way; at least one drew the wrong conclusion.
6. **A blocked slice cannot finish.** `slice-done.sh:52` refuses a dirty tree — correct
   in isolation — so a slice caught in 2 can neither commit nor declare itself done, and
   the documented fallback ("leave the worktree, say what is failing, exit") strands it on
   a condition that clears only by human intervention.

Finding 1 is the reason the lock exists; 2, 4 and 6 are one defect seen from three sides;
3 and 5 are independent and small.

## Design

The lock becomes something a session **takes before applying DDL and holds until its
migration is on the base branch**, not something inferred from git afterwards. Three
consequences fall out of that:

- **Deadlock is structurally impossible.** The claim is an atomic `mkdir`; exactly one
  claimer wins. There is no symmetric state and no human tiebreak.
- **Ordering is a recorded fact, so overriding it is a transfer, not a bypass.** The
  operator can hand the lock to a different slice from the main checkout, and the transfer
  is logged. `session-commit.sh` gains no `--force`: a force on the DB lock is the one door
  that lets two sessions mutate production on purpose, and a slice agent must never hold it.
- **The scan survives as a backstop.** A dirty exclusive path in a worktree that does not
  own the lock means someone skipped the protocol. That is reported, and still fails
  closed when the state cannot be verified.

Non-goals: no dependency on the tracker for the lock itself (git's common dir is shared
by every worktree and is the only thing all of them can already see); no change to what
`exclusiveLockPaths` means; no cross-machine lock (one repo, one machine, same as today).

## Phase 1 — landed

Three commits: `a70b1d1` (1a) · `c42da63` (1b) · `0834212` (1c).

Deviations from the plan below, all deliberate:

- **1b needed no new argument.** The caller's own worktree is already in the
  `git worktree list` output `db_lock_holder` parses, so it checks that entry's state
  on the way past instead of taking a path. Every holder is now collected rather than
  the first returned, which is what lets the dispatcher (which excludes nobody) see two
  stuck worktrees too. An UNVERIFIABLE worktree still wins over the diagnosis. The
  text travels with the holder output, so it reaches every caller alike — a session
  polling `db_lock_holder` by hand sees it, not only one that runs `session-commit.sh`.
- **1c's proof is a test, not a dry run.** `tests/scripts/fixture.ts` builds a real
  consumer checkout — shims pointed at this repo, a `slice.config.ts` with a file-backed
  fake tracker, optional bare origin, linked worktrees — and `sliceLand.test.ts` runs
  `slice-done.sh` then `slice-land.sh` through it with a rebase in between. Phase 2's
  tests should build on that fixture rather than on a second one.
- **The two SKILL.md copies** (`agent/` and `.claude/`) were edited identically; `azelf
  init` regenerates the consumer's from `agent/`.

Each item is independent. Land them as separate commits.

- [x] **1a. `session-commit.sh`: lock under `--git-common-dir`.**
  `git_dir=$(git rev-parse --git-dir)` → `--path-format=absolute --git-common-dir`
  (`slice-land.sh:45` already uses that form). Rewrite the comment block at
  `session-commit.sh:96–99` and its copy in `format.sh:66` (the "side effect worth naming"
  paragraph): the lock now serializes commits across every worktree of the repo, which is
  cheap because commits take seconds, and it is what the header of `db-lock-check.sh:57`
  always claimed. Rewrite that header paragraph too so the two files stop contradicting
  each other, and have it say plainly that the scan is a backstop and Phase 2's claim is
  the enforcement point.
  *Proof:* two worktrees, one holds `session-commit.lock` in the common dir, the other's
  `session-commit.sh` waits and reports "another session is committing".

- [x] **1b. `db_lock_holder`: name the mutual case instead of pointing at an impossible fix.**
  Add a second optional argument, the caller's own worktree path, and when the caller is
  itself dirty on an exclusive path AND another worktree is, say so:

  > both `ticket/40` and `ticket/44` hold uncommitted migrations. This does not clear by
  > waiting. Pick one to go first: in the other, `git stash push -- supabase/migrations`,
  > let the first land, then `git stash pop` and renumber the migration if it now sorts
  > before the one that landed. Check what each already applied to the database.

  The same text from `session-commit.sh` and from the dispatcher's "DB lock held — not
  starting anything" line (`slice-run.ts:1886`), which today gives no hint that the run
  will never resume on its own. Phase 2 makes this branch unreachable in normal use; keep
  it for the backstop path.
  *Proof:* a test under `tests/scripts/` that builds a repo with two worktrees, dirties an
  exclusive path in each, sources `db-lock-check.sh` and asserts the mutual message.
  (`sliceInit.test.ts` shows how the suite drives bash against a temp repo.)

- [x] **1c. Record the landed SHA in the ticket.**
  The original head is lost by the time `slice-land.sh` runs, because the rebase happens
  in `slice-run.ts` before it. The cheapest durable place to capture it is the moment the
  agent declares done: `slice-done.sh` already writes `.slice-ready-to-land` with the
  session PID on line 1 — write `git rev-parse HEAD` on line 2. `slice-land.sh:158` reads
  line 1 of that marker today; read line 2 as well, and after the fast-forward append to
  `close_comment`:

  > declared done at `dace4ec`, landed on master as `ee62e2d` (2 commits).

  Print the same line. Then one paragraph in `agent/skills/slice/SKILL.md` (and its copy
  under `.claude/skills/`) after "Finish": *a closed ticket means it landed. Landing may
  rebase your commits, so never test for a land by SHA; match by subject or check the
  ticket.*
  *Proof:* land a slice whose branch was behind base; the close comment carries both SHAs
  and the second is an ancestor of base.

## Phase 2 — landed

The fix for 1, 2, 4 and 6. Three commits: `c7e59a6` (2a–2d, the shim, the tests) ·
`48c997d` (2f) · the docs commit after it (2e, 2g, this file).

Deviations from the plan below, all deliberate:

- **Launch no longer refuses on a held lock (2f, not only pre-wave).** The dispatcher
  starts every ticket through `slice-session.sh --prep-only`, so a launch-time refusal
  would have stalled the wave exactly as the pre-wave check did. Starting is safe now
  — the claim guards the DDL, not the launch — so it prints the holder and goes on.
- **A parked slice leaves a marker.** Checking the pickup path (2f's second bullet)
  found two things: a slice that exited on a refused claim was relaunched *every*
  round while the lock was held, opening a session whose first act was to be refused
  again, and under `--auto` its commits outside the exclusive paths made it read as
  *finished* — `autoFinished` would have landed half a ticket. So a refused claim in
  a slice worktree writes `.slice-lock-wait` (excluded by `init`, cleared by a
  successful claim, by `transfer`, and at every session launch). `runnable()` skips a
  marked ticket while the lock is held; `autoFinished()` skips it always. That is the
  whole mechanism; the relaunch path itself was already right.
- **The scan runs inside `claim`, not after it.** A free lock next to a worktree that
  is dirty under an exclusive path with no claim is not taken — that would be a lock
  on paper — so `claim` refuses with the scan's text. The owner is never refused on
  that account: refusing the one party that followed the rules is how the deadlock
  comes back. `session-commit.sh` therefore just runs `claim` and relays its output;
  the "warning, not refusal" for the owner falls out of that.
- **2b's caller-path argument** was not needed, for the reason 1b's was not.
- **Shared primitives live in `db-lock-check.sh`**: `db_lock_dir`, `db_lock_log`,
  `db_lock_read_owner`, `db_lock_owner_stale`, `db_lock_re` (the regex 2d asked to
  share) and `db_lock_status_line` (the banner). `db-lock.sh` sources it.
- **`status --porcelain`** exists for scripts: `free`, `unverifiable`, or
  `held|stale <TAB> branch <TAB> claimed_at <TAB> worktree`.
- **The dispatcher's proof was a scratch dry run**, not a test: a fixture consumer with
  two ready tickets, the lock claimed by #44 and #40 parked on it, `--once`. Round 1
  printed the holder, `waiting for it: #40 — relaunched when it frees`, and started #44
  only; after `release --landed ticket/44` the next `--once` started both. There is no
  `slice-run` test harness, and building one was out of scope.
- **Both SKILL.md copies** edited identically, as in Phase 1.

- [x] **2a. `scripts/db-lock.sh` — `claim | release | status | transfer`.**
  Executed, not sourced (`SHIMS` in `slice-init.ts:148` gets `{ name: "db-lock.sh",
  how: "exec" }`; `sliceInit.test.ts:237` checks the shim list). Contract:

  - Lock dir: `$(git rev-parse --path-format=absolute --git-common-dir)/azelf-db.lock`.
    Owner file inside it: `branch`, `ticket`, `pid`, `claimed_at` (ISO), `worktree`.
    Append-only `azelf-db.log` next to it, one line per claim/release/transfer.
  - `claim`: `mkdir` the dir (atomic). On success write the owner file and log. If the
    dir exists and the owner is this branch → no-op, exit 0. If owned by another branch →
    print the owner and `claimed_at`, exit 1. If the dir exists but the owner file is
    missing or unreadable → exit 1, report UNVERIFIABLE, never take over. No waiting, no
    polling: the caller decides what to do with a refusal.
  - `release`: only by the owner branch, or with `--landed <branch>` from the main
    checkout (this is what `slice-land.sh` calls). Anything else is refused with the
    owner's name. Log it.
  - `status`: free / held by … since … / UNVERIFIABLE. Also flags a **stale** claim: the
    owner branch no longer exists (`git show-ref`) — reported, never auto-released, because
    the branch being gone does not mean the migration was applied and reverted.
  - `transfer <ticket> --reason "…"`: the sanctioned override. Refused unless run from the
    main checkout on the base branch (same guard as `slice-land.sh:60`). Rewrites the owner
    file to the target slice's branch and logs `transfer from → to, reason, user, time`.
    This is the operator's ordering decision kept inside the tool. Does not touch the
    losing worktree; that slice's next `claim` or commit tells it what happened.
  - Empty `exclusiveLockPaths` → every subcommand is a no-op that says so, exit 0
    (same disabling rule as the scan).
  *Proof:* `tests/scripts/dbLock.test.ts`, on `makeConsumer` from `tests/scripts/fixture.ts`
  — two worktrees race `claim` (one wins), re-claim
  is idempotent, `release` by a non-owner is refused, `transfer` outside the main checkout
  is refused, missing owner file reads as UNVERIFIABLE, empty lock paths no-op.

- [x] **2b. `db_lock_holder` reads the claim first, scans second.**
  Order: (1) owner file present and owner ≠ caller → holder is the owner; (2) owner file
  unreadable → UNVERIFIABLE, as now; (3) no claim → the existing scan, but a dirty
  worktree found this way is reported as *"… has uncommitted changes under
  supabase/migrations/ and holds no claim — it skipped `db-lock.sh claim`"*. The
  mutual-case text from 1b stays for that path. Keep `exclude_branch`; add the caller
  path argument from 1b.
  *Proof:* extend the 1b test — with a claim present the scan is not consulted; with no
  claim and a dirty non-owner the message names the protocol.

- [x] **2c. `session-commit.sh`: a commit touching an exclusive path requires the claim.**
  At the block starting `session-commit.sh:190`: if the staged set matches `lock_re`, run
  `db-lock.sh claim` (idempotent for the owner; wins the lock if nobody had it — a slice
  that wrote a migration without claiming is not punished, it is just late). If the claim
  is refused → the existing "lock held by …" refusal, unstage, exit 1, plus one line:
  *if you and the holder are both mid-migration, the operator can order you with
  `db-lock.sh transfer`.* No `--force`. The scan (2b) runs after the claim as the
  backstop: a dirty non-owner elsewhere is printed as a warning, not a refusal, because the
  claim is the authority now and a warning is what gets the protocol violation noticed.
  *Proof:* a test that stages a migration in a worktree that does not own the lock and
  asserts the refusal names the owner.

- [x] **2d. `slice-land.sh` releases the lock once the migration is on base.**
  After `git push origin "$SLICE_BASE_BRANCH"` succeeds (`slice-land.sh:135`), if the
  landed range touched an exclusive path — reuse the `lock_re` construction from
  `session-commit.sh`, or move it into `db-lock-check.sh` as `db_lock_re` so both share it
  — call `db-lock.sh release --landed "$branch"`. Never fatal (same rule as the cleanup
  below it): a failed release is printed with the exact command to run by hand. A branch
  that did not touch exclusive paths but somehow holds the claim is released too, with a
  note.
  *Proof:* land a slice that owns the lock; `db-lock.sh status` reports free and the log
  has the release.

- [x] **2e. The skill: claim before you touch the database.**
  In `agent/skills/slice/SKILL.md` (and `.claude/skills/slice/SKILL.md`), a new section
  between "Build it" and "Commit":

  > **Before creating or applying anything under `exclusiveLockPaths`** (see
  > `slice.config.ts`), run `./scripts/db-lock.sh claim`. If it is refused, do not touch
  > the database and do not poll. Commit what you have outside those paths, say in your
  > final message who holds the lock, and exit. The dispatcher starts you again when it
  > is free. Applying a migration you have not claimed the lock for is the one thing in
  > this worktree that cannot be undone.

  And under "If the gates will not go green", the same instruction for a slice that is
  blocked on the lock: leave the worktree clean of exclusive-path changes if you can,
  otherwise leave it and say so. This is the fix for finding 6: a blocked slice now has a
  defined exit that is not "wait forever".
  *Proof:* read-through; `azelf init` regenerates the consumer's copy.

- [x] **2f. The dispatcher.**
  - Launch (`slice-session.sh:202`) and pre-wave (`slice-run.ts:1884`) keep calling
    `db_lock_holder`, now claim-aware via 2b. The pre-wave check must **not** block
    tickets that do not need the lock — today it stops the whole wave. Replace "lock held →
    start nothing" with "lock held → start everything anyway": a slice that needs the lock
    will be refused at `claim` and exit cleanly per 2e. (With Phase 3, the dispatcher
    knows which tickets need it and can leave those out.)
  - `idleWorktrees` (`slice-run.ts:561`) already names a prepped-but-unoccupied worktree
    and the loop relaunches it. Check that a slice which exited on a refused claim is
    picked up by that path once `status` reports free; if it is not, that is the bug to
    fix here, not a new mechanism.
  - Add `db-lock.sh status` to the round banner when `exclusiveLockPaths` is non-empty:
    one line, `DB lock: held by ticket/44 since 10:02` or `DB lock: free`.
  *Proof:* a dry run with a held lock starts the non-lock tickets and prints the holder.

- [x] **2g. README.** The `db-lock-check.sh` row in the scripts table gains a `db-lock.sh`
  row; the "Only one worktree may hold changes…" paragraph (README:591) describes the
  claim, when it is taken, when it is released, and `transfer`. Keep it to the length of
  what is there now.

## Phase 3 — landed

One commit (3a–3d and the tests).

Deviations from the plan below, all deliberate:

- **"In flight" is "has a worktree", not "occupied or ready-to-land".** Every state
  between the first launch and the land holds a migration that is not on base yet:
  running, done, parked, crashed, refused at the claim. A worktree covers all of
  them, and a land removes it. The first labelled ticket in the run's order starts;
  the rest wait.
- **The plan's widest wave counts a wave's labelled tickets as one slot**, so the
  default `--max` does not open sessions that could only wait.
- **The waiting line is printed when it changes**, like the round line since
  `fe8664b`: `[db] one at a time: #40 in flight; waiting on it: #44`.
- **The proof is three dispatcher tests** in `sliceRun.test.ts` (plan marks and width,
  one-at-a-time then the next after the land, the validation error), on the fixture's
  fake tracker, which now takes labels per ticket. With the grouping disabled the
  second test fails: #44 is prepped next to #40.
- **Both `azelf.md` copies** got the same paragraph.

## Phase 3 — stop scheduling the collision

Phases 1–2 make the collision safe and self-resolving; this makes it not happen, so a
migration-bearing slice is not started only to exit again.

- [x] **3a. `exclusiveLockLabel?: string` in `SliceConfig`** (`slice-config.ts:63`), carried
  through `--sh` as `SLICE_EXCLUSIVE_LOCK_LABEL`; default unset. Validation: setting it
  with empty `exclusiveLockPaths` is an error (a label with nothing to protect is a typo).
- [x] **3b. `runnable()` (`slice-run.ts:583`)** treats labelled tickets as a group of size
  one: if any labelled ticket is in flight (occupied, or ready-to-land and not yet landed),
  no other labelled ticket is runnable. `Ticket` already carries `labels` from the tracker
  (`slice-tracker.ts:75`).
- [x] **3c. The plan output** (`agent/commands/azelf.md`, the wave listing in `slice-run.ts`)
  marks labelled tickets and says why two of them sit in different waves.
- [x] **3d. The `db-lock-check.sh` header** gets one sentence pointing here: the label is
  how the dispatcher avoids the race the claim resolves.
  *Proof:* `sliceRun`-level test or a dry run with two labelled ready tickets and
  `maxParallel 3`: the second is listed as waiting on the first, not started.

## Order and cost

Phase 1 is three small commits, an afternoon, and removes the immediate hazards (the
silent stall, the impossible advice, the SHA trap). Phase 2 is the one that matters: one
new script with a test file, edits to four scripts, the skill and the dispatcher, roughly a
day. Phase 3 is a morning once 2 exists. Do them in order; 2 depends on nothing in 1 except
the shared `lock_re` (2d) and the mutual-case text (1b/2b), so 1 can also be folded into 2
if the context allows.

## Recovery

With the claim in place the states that need a human are these, and each one's message
names the command:

- **Two slices both want the lock.** No deadlock: one holds it, the other was refused,
  exited, and is parked. To reorder, from the main checkout:
  `./scripts/db-lock.sh transfer <ticket> --reason "…"`. The loser finds out at its next
  claim or commit; check what it has already applied.
- **Two worktrees dirty under the exclusive paths and no claim** (the protocol was
  skipped twice): in all but one, `git stash push -- <exclusive paths>`; in the one,
  `./scripts/db-lock.sh claim`, commit, land; `git stash pop` in the others, renumber if
  needed; and **check what each already applied to the live database**.
- **STALE** (owner branch gone): check `.git/azelf-db.log` and the database, then from the
  main checkout `./scripts/db-lock.sh release --landed <branch>`.
- **UNVERIFIABLE** (lock dir with no readable owner): check the log; once nobody is
  mid-migration, `rm -r .git/azelf-db.lock`.
