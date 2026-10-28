# The base the dispatcher works from is origin's, the gates are findable, and a prompt does not promise a file that is not there

**Status:** complete · all three phases landed 2026-10-27 in one commit
**Written:** 2026-10-27
**Companion:** consumer-b's friction log, the thirteen entries dated 2026-10-27. They fall
into six groups; one is a defect in `slice-land.sh`, the rest are gaps. The two entries
dated 2026-10-25 and the still-open ones from 2026-10-22 are under "Not in this plan".

Written so it can be picked up cold. Tick the boxes as they land and add the commit hash
after the heading. Line numbers are as of `1712ec9`.

## What happened

1. **A stale local base broke a whole run, three ways at once** (two dispatcher entries,
   one slice entry; about forty minutes of standstill, repaired by hand).
   - consumer-b's dispatcher runs in its own clone. The local `main` there moves only
     when azelf lands; other people push to origin from a different checkout. So the
     clone's `main` is routinely behind `origin/main`. Slices are cut from origin, so
     the slice branches are ahead of the local base they are compared with.
   - `noteBaseAgainstOrigin` (`slice-run.ts:680`) fetches once, at the start of the run,
     and acts only when the local base is **ahead**: diverged refuses to dispatch,
     ahead-only is noted. Behind-only returns silently at `:702`. That fetch is the only
     one in the dispatcher; nothing fetches again in later rounds.
   - Everything else reads the local base: `rebaseOntoBase` rebases onto `baseBranch`
     (`:2896`), `changedFiles`/`gatesPass` diff `${baseBranch}...HEAD` (`:2751`),
     `reportOverlaps` counts from the same diff, and the consumer's own zone gate runs
     `git diff main...HEAD`. With the base behind origin, every one of those credits
     other people's commits to the slice. The zone gate parked #103 for files the slice
     never touched.
   - `slice-land.sh` fast-forwards the local base onto the slice FIRST (`:250`), fetches
     origin after it (`:257`), checks that origin is contained (`:262`) and pushes
     (`:266`). A push rejected as non-fast-forward exits 1 under `set -e`; the local base
     is left ON THE SLICE, unpushed, and the dispatcher parks the slice as "a hold, a
     hook, or a push that failed". `base_before` is already in a variable (`:236`) and is
     not used to undo the fast-forward.
   - The next slice (#157) was rebased onto that unpushed base, so it carried #158's
     commits, and its push was rejected the same way. The retry of #158 "rebased" it
     onto a base that now contained #157: its branch fast-forwarded to include #157,
     and `git diff main...HEAD` was empty.
   - That emptiness is reported wrong. `gatesPass` returns false for "nothing to land"
     (`:2758`), and `tryLand` turns every false from it into
     `park(t, "gates", "the gates are red")` (`:4236`). The run said the gates were red
     for a slice whose gates never ran, and the diagnosis took the wrong turn first.
2. **`slice-done.sh` counts against the local base too** (one slice entry). `:124` and
   `:175` use `$SLICE_BASE_BRANCH..HEAD`. The slice saw "6 commit(s) to land" for a
   branch with one commit of its own; the other five were origin's, missing from the
   clone's `main`. `slice-session.sh:552` already counts against `origin/<base>` as well
   when that ref exists; `slice-done.sh` does not.
3. **The land lock is visible only inside the dispatcher's clone** (one process entry).
   `slice-land.sh:192` puts it in the clone's common git dir. A merge by hand from the
   consumer's main checkout, a different clone of the same remote, cannot see it and
   pushed six commits in the middle of a land. That push is what started group 1.
4. **The start prompt promises `.slice-parent.md`, and five worktrees had none** (five
   slice entries, two repos). Both of consumer-b's `startPrompt`s say the spec "is in
   .slice-parent.md, read it next, it takes precedence over this prompt". azelf writes
   that file only when the ticket has a `## Parent` (`slice-session.sh:407`), and the
   skill says "when the ticket hangs under a spec". Both are right. The prompt has no
   way to know: `{n}` is the only placeholder (`slice-config.ts:245`), and the line
   azelf prints about the two files (`slice-session.sh:476`) goes to the terminal, not
   into the prompt. Each session's first command failed, and each had to decide whether
   a rule it was told takes precedence was missing.
5. **A slice cannot find its gates** (three slice entries). The skill says "Run the
   gates yourself before declaring done" and names none. It points at
   `slice.config.ts` for `exclusiveLockPaths`, and that file is untracked in the
   consumer's clone and not in its `provisionCopy`, so the worktree has no copy. Each
   session found the gate list by `git rev-parse --git-common-dir` and reading the
   clone. azelf has no verb that runs the gates from a worktree: the verbs are `init`,
   `run`, `retry`, `hold`, `release`, `provision`, `hook` (`bin/azelf.ts:44`).
6. **A guard over a shared budget was green per slice and red together** (one
   dispatcher entry). Three slices each added to `CLAUDE.md`; a test holds it under
   25000 bytes. Each passed alone and the third to land failed. `reportOverlaps`
   (`slice-run.ts:4808`) named the file and, by design, only warned. After the fix was
   committed on one branch, the restarted run tried the others first, in ticket order,
   and each went red again until the fixed one landed. `retryDue` (`:3881`) already
   distinguishes "its branch moved" (`spent: 0`) from "the base moved", and nothing uses
   that for the order.

## Decisions this plan makes

- **The local base equals `origin/<base>` at the start of every round.** The dispatcher
  fetches and fast-forwards the local base when it is behind, every round, before the
  lands. Diverged still refuses, as today. With that invariant the rebase target, the
  diff base, the overlap report and the consumer's zone gate are all right without a
  new config key, and the consumer's `AZELF_ZONEN_BASIS` stays unset.
- **`slice-land.sh` fetches before it moves anything, and undoes what it moved if the
  push is refused.** Order: fetch → fast-forward the local base onto `origin/<base>` if
  behind → require `origin/<base>` to be an ancestor of the slice branch (else 75) →
  fast-forward onto the slice → push → on a rejected push `git reset --keep
  "$base_before"` and exit 75. `--keep`, not `--hard`: it aborts rather than overwrite
  local changes in the main checkout, and the fast-forward only ever moved files that
  the two commits differ in.
- **"Nothing to land" is its own parking reason, outside the gates.** A slice whose
  branch adds nothing to the base did not fail a gate. It is parked under `land` with a
  message that says the branch is already contained in the base and asks whether it
  landed or the base was moved past it.
- **The prompt is told when there is no parent, by azelf, not by the consumer.** When
  no `.slice-parent.md` was written, `slice-session.sh` appends one sentence to the start
  prompt. That works for every existing `startPrompt` unchanged. A `{parent}`
  placeholder is added for prompts that want to phrase it themselves: it expands to a
  sentence when the file exists and to nothing otherwise.
- **The gates are a command, `azelf gates`, runnable from a worktree.** The skill names
  that command instead of "run the gates yourself". Gates that push or wait on CI
  (`ciRuns`) are skipped and said to be: a slice must not push. The skill stops pointing
  at `slice.config.ts`; `db-lock.sh claim` already knows the exclusive paths.
- **Phase 3 is optional and separate.** The lock location and the land order are real
  but second-order; each is cheap, and neither blocks the invariant above.

## Phase 1 — the base is origin's, in the dispatcher, in the land, in `slice-done.sh`

- [x] 1a. `slice-land.sh`: the order above. The ancestry check against `origin/<base>`
  replaces the one at `:262`, which ran after the fast-forward. A rejected push resets
  with `--keep` to `base_before`, prints what it undid, and exits 75 so the dispatcher
  rebases and retries instead of parking. The land lock stays held through the reset.
- [x] 1b. `slice-run.ts`: `syncBaseWithOrigin()` — fetch `origin/<base>` and fast-forward
  the local base when it is strictly behind, from the main checkout; diverged keeps
  today's refusal at start and parks nothing mid-run but says so once. Called where
  `noteBaseAgainstOrigin` is called (`:5136`) and once per round before the lands
  (`:5441`, before `reportOverlaps`). A fetch that fails keeps the last fetch and says so
  once per run, as the start check does today.
- [x] 1c. `slice-run.ts`: "nothing to land" leaves `gatesPass`. `tryLand` computes the
  changed files first; an empty list parks under `land` with its own reason. The gate
  skip lines keep their place after it.
- [x] 1d. `slice-done.sh`: count and refuse against the local base AND `origin/<base>`
  when the ref exists, the way `slice-session.sh:552` does. The "commit(s) to land" line
  says which base it counted against when the two differ.
- [x] 1e. README: under the land, a paragraph on the invariant and on exit 75 after a
  rejected push; under "Not in this plan" nothing. The consumer-facing line: the
  dispatcher's clone may be used only through azelf and `azelf push-main` (Phase 3)
  until that exists, by hand with `git merge --ff-only origin/<base>`.
- [x] 1f. Tests
  - `sliceLand.test.ts`, with the bare origin the fixture has:
    - the base behind origin, slice cut from origin: lands, and the local base ends on
      origin's head plus the slice;
    - origin moved after the fetch (a second clone pushes between fetch and push):
      exit 75, local base back on `base_before`, the branch untouched, the lock released;
    - the slice not containing origin's head: exit 75 before any fast-forward.
  - `sliceRun.test.ts`, with the fixture tracker:
    - the local base behind origin at round start is fast-forwarded before the rebase,
      and the changed-file list of a slice cut from origin is only its own files;
    - a branch already contained in the base parks as "nothing to land", not as red
      gates, and the gates are not run.
  - `slice-done.sh`: six commits on origin the local base lacks, one on the branch:
    "1 commit(s) to land".

### What building it found

- **A refused push is not one case but two.** The plan said "exit 75 on a rejected
  push". A push origin refuses because it moved is the one a rebase fixes; a push a
  hook or a credential refuses is not, and 75 there would have had the dispatcher
  rebase twice and park as "moved under it 3 times". So after the undo the script
  fetches once more: origin moved past `base_before` is 75, anything else is 1. Both
  undo the fast-forward first.
- **After the undo the land script syncs the base itself, and exits 75 from origin's
  new head.** Reset to `base_before` alone would have left the local base behind
  origin, and the dispatcher's next rebase (onto the local base) would have met the
  same 75 at the next land, twice, then parked. With the sync in the script, the
  hand path works the same way: the message asks for a rebase onto the local base,
  and the local base is origin's.
- **The ancestry check stays against local HEAD, not `origin/<base>`.** After the sync
  HEAD contains origin's head, and checking HEAD also covers a local base that is
  legitimately ahead (slices are cut from it). The message is the one the existing
  lock tests assert on.
- **`gatesPass` keeps a guard for an empty change list.** It is reached from
  `azelf run --gates` too, which judges the worktree as it sits; there an empty list
  says "nothing to check" rather than running zero gates green. `tryLand` parks the
  case first, as a land, and only when the worktree is clean: dirty and empty stays
  the gates' "worktree is dirty", which names the thing to look at.
- **The round sync skips round 1,** which the start already synced; `--plan` never
  syncs, because a plan reads and moving the checkout is not reading.
- **`slice-done.sh` puts the "counted against" note after the parenthesis,** so
  "marked done (1 commit(s) to land)" still reads as one phrase and the existing
  assertion on it holds.

## Phase 2 — the prompt and the gates

- [x] 2a. `slice-session.sh`: when no `.slice-parent.md` was written, append to the start
  prompt: "This ticket hangs under no spec: there is no .slice-parent.md in this
  worktree, and nothing takes precedence over .slice-ticket.md." A `{parent}`
  placeholder in `startPrompt` expands to the sentence naming the file when it exists,
  to nothing otherwise; a prompt that uses it gets no appended sentence. Also the
  relaunch sentence stays last.
- [x] 2b. `azelf gates [<ticket>]`: from inside a slice worktree, or from the main checkout
  with a ticket. Resolves the repo root through `--git-common-dir` like the shell scripts
  do, loads the config, computes the changed files against the base (Phase 1's base),
  and runs the gates through `runGates`. Gates of the `ciRuns` shape are skipped with a
  line saying they run at land. Exit code is the verdict. No lock: this is a session
  checking itself, and the dispatcher's gate lock is for lands.
- [x] 2c. The skill (`agent/skills/slice/SKILL.md`, written by `slice-init.ts`): step 5
  says `azelf gates`, or `./scripts/slice-gates.sh` if the shim is what the worktree has;
  decide one and provision it. Step 3 drops the pointer to `slice.config.ts`. `azelf
  init` rewrites a skill it wrote.
- [x] 2d. README: `azelf gates` in the verb list and under the gates; `{parent}` under
  `startPrompt`; `provisionCopy` gets one sentence that an untracked `slice.config.ts`
  belongs in it if sessions are to read it.
- [x] 2e. Tests
  - `sliceSessionClose.test.ts` or a new `sliceSessionPrompt.test.ts`: no parent → the
    sentence is appended; parent → it is not; `{parent}` → expanded, nothing appended.
  - `sliceGates.test.ts`: the verb skips `ciRuns`, runs the rest on the worktree's
    changed files, returns the verdict as exit code.
  - `sliceInit.test.ts`: the regenerated skill names the command.

### What building it found

- **The command the skill names is the shim, `./scripts/slice-gates.sh`.** A worktree
  has the shims and not necessarily `azelf` on PATH (consumer-b's Python repo has no
  `node_modules/.bin`). The shim execs a real `scripts/slice-gates.sh` in the package,
  which runs `slice-run.ts --gates --no-lock`, so the shim mechanism, the main-checkout
  rule included, covers it unchanged. `azelf gates` is the same command for a person.
- **`azelf gates` is `--gates` with two differences, not a second gate runner.**
  Without an id, `--gates` reads the ticket from the current directory's branch
  through `branchPattern`, and exits 64 from the main checkout saying which branch is
  not a slice branch. `--no-lock` is what the verb and the shim pass: a session's own
  check does not wait behind a land's gate run, CI included. `azelf run --gates <ids…>`
  keeps the lock; the existing lock test asserts it, and by hand from the main
  checkout it is the right default.
- **The `ciRuns` skip is a field on `Gate`, `landOnly: true`,** set by `ciRuns` and open
  to a hand-written gate. `gatesPass` filters on it under `byHand`, which both `--gates`
  forms pass, so `azelf run --gates` skips it as well: a worktree with nothing pushed
  would otherwise wait the whole CI deadline. The skip line goes before the `when`
  skips and the gate count, and the count is of the gates that will run.
- **`{parent}` takes the space before it when it expands to nothing,** so a prompt
  written `#{n}. {parent} Go.` reads `#40. Go.` with no double space. The no-spec
  sentence is appended only to a prompt without the placeholder and only when there is
  no parent; a prompt with a parent and no placeholder is left as written.
- **Step 3 of the skill says the lock "names the paths when it answers".** That is true:
  `db-lock.sh`'s refusal prints `exclusiveLockPaths`. It replaces the pointer to
  `slice.config.ts`, which an untracked config makes a dead link in a worktree.
- **The fixture grew a `startPrompt` option.** A second `startPrompt:` through
  `configExtra` would have been a duplicate key the transpiler accepts and `tsc` would
  not.

## Phase 3 — the lock every checkout sees, and the order after a park (optional)

- [x] 3a. The land lock keyed by the remote: `~/.azelf/locks/<sha256 of origin's URL,
  short>/land`, with the directory shape `slice-lock.ts` already has. Falls back to the
  common git dir when there is no origin. The gate lock stays where it is: it
  serialises load on one machine's checkout, not pushes.
- [x] 3b. `azelf push-main`: take the land lock, fetch, require the local base to be a
  fast-forward of origin, push, release. For merges by hand from any checkout of the
  same remote. The consumer's merge ritual then calls it.
- [x] 3c. The land order: among slices due a retry in one round, those whose branch moved
  since the park go before those retried because the base moved. `retryDue` already
  says which. Across a restart there is no park state and the order stays ticket order;
  the README says so.
- [x] 3d. Tests: a hand `push-main` and a `slice-land.sh` from two clones of one bare
  origin do not interleave; the moved branch lands first.

### What building it found

- **The lock directory is answered by `slice-lock.ts land-dir <checkout>`**, so the two
  shell scripts and the tests compute it in one place. The key is sha256 of origin's URL
  less a trailing `/` and `.git`, first twelve hex digits; the ssh and https spellings
  of one remote are two keys, and the README says to use one spelling rather than
  guess at an equivalence. `AZELF_LOCKS_DIR` moves the root; the fixture sets it under
  its temp root so tests leave nothing in the real home.
- **`push-main` lives in `scripts/slice-push-main.sh`, with a shim**, not in the
  dispatcher: it is the land's push without the land, and the consumer's merge ritual
  runs in a checkout where the shims are what exists. From a slice worktree it acts on
  the main checkout, as `slice-land.sh` does. A base that is behind origin with nothing
  of its own is a refusal (exit 1), not "nothing to push": the person expected a push.
- **3c is "the base-moved retry goes last", not "the moved branch goes first".** With
  one land per round the two are the same for the pair the plan named, and the first
  also orders a base-moved retry behind a slice that was never parked, which carries
  something new too. `retryDue` grew a `why`; `isParked` records it with the branch head
  at the un-park; the deferral holds until the slice is tried, parks again or its
  branch moves. The test was run with the order disabled: #40 parks twice and spends a
  second automatic retry, which is the shared-budget entry's afternoon.
- **The two-clone test's natural outcome for the land that waited is 75, not a land**:
  it fetched under the lock, found the hand push, and the slice lacks it. That is the
  Phase 1 answer; the test rebases and lands it after. Without the lock the land would
  have exited 75 as well, after a refused push and an undo — the assertions are the
  wait line, the sync line and the absence of `origin refused the push`.

## Order and cost

Phase 1 first and alone: it is the defect, and it returns on every run where someone
else pushes to origin. Three scripts, one README paragraph, about eight tests.

Phase 2 right after: it removes two recurring entries (eight of today's thirteen) and
costs one shell sentence, one verb, one skill edit.

Phase 3 when a second hand merge races a land, or when the next wave of a shared-budget
guard parks slices in the wrong order.

## Not in this plan

- **A probe merge of all open slices with the gates run on it** (the shared-budget
  entry's first proposal). Every round would pay a full gate run for a warning the
  overlap report already gives by file. Reconsider if the pattern recurs.
- **`serializePaths`** (its third proposal). The land already rebases and re-gates; what
  was missing was the order, which 3c fixes.
- **The two entries of 2026-10-25:** a `git merge-tree` dry run in `slice-done.sh`
  against the base, warn-only; and a stall detector plus `caffeinate -is -w $$` on
  macOS while slices run. Neither exists in azelf yet (no code names caffeinate or
  reads a worktree's mtimes). Both are worth their own short plan.
- **Still open from 2026-10-22:** a command allowlist for the resolver; `reviewReadDirs`;
  `azelf adopt <ticket> <ref>`; `--watch-labels`; a port block per slice; `regenerate`
  and `refresh` steps after a rebase; a venv-against-requirements check in the install
  step. The marker-refresh entry ("branch moved since done") is partly covered: a parked
  slice whose branch moves is retried, a ready slice lands its current head.

## What the consumer does itself

consumer-b (the mapping is in `CONSUMERS.local.md`):
- Until Phase 1 lands: `git merge --ff-only origin/main` in the dispatcher's clone before
  each run, and no pushes to `main` from another checkout while a run is landing. After
  Phase 3: the merge ritual ends in `azelf push-main` (or `./scripts/slice-push-main.sh`)
  instead of `git push`, from whichever clone the merge was made in.
- Both `startPrompt`s: "falls vorhanden" on the sentence about the parent spec, or
  `{parent}` after Phase 2.
- `slice.config.ts` into `provisionCopy` if sessions are to read it; after Phase 2 they
  need not.
- Pull `azelf-run` after each phase. The zone gate keeps `git diff main...HEAD`.
