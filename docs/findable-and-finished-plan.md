# Every worktree has the shims, the launcher is ours, a clash is said before the land, and a finished session is seen

**Status:** in progress · Phase 1 landed 2026-10-30
**Written:** 2026-10-30
**Companion:** consumer-b's friction log, the fifteen entries dated 2026-10-30. Ten slice
entries are one complaint, the four dispatcher entries are four, and one slice entry
carries a second problem. The entries of 2026-10-25 and the still-open ones from
2026-10-22 are under "Not in this plan".

Written so it can be picked up cold. Tick the boxes as they land and add the commit hash
after the heading. Line numbers are as of `2d00f7c`.

## What happened

1. **`./scripts/slice-gates.sh` is not in any slice worktree** (ten slice entries, both
   repos; the entry for #119 of 2026-10-27 was the first). Every session found the
   package's copy through `git rev-parse --git-common-dir` and ran that, green, after
   three or four commands of searching.
   - consumer-b keeps every shim untracked, in `.git/info/exclude`, so a worktree gets
     them only through `provisionCopy`. Both of its configs list the shims by hand, and
     the list is the eight shims of before 2026-10-27. `slice-gates.sh` and
     `slice-push-main.sh` joined `SHIMS` (`slice-init.ts:167`) since; `azelf init` wrote
     them into the main checkouts and the consumer's list did not move. The two
     worktrees open today lack exactly those two.
   - `slice-session.sh:338` copies what `SLICE_PROVISION_COPY` names and nothing else.
     azelf knows its own file list and does not use it there. The README (`:174`) says
     to commit the shims, which this consumer chose not to; a consumer that follows
     the README is fine and one that does not is on its own list, which drifts.
   - The skill (step 5, `SKILL.md:58`) names the shim and no fallback.
2. **`bunx azelf run --plan` downloaded a package named `azelf` from the registry** (one
   dispatcher entry). "Resolved, downloaded and extracted [504]", then "could not
   determine executable to run for package azelf". Nothing ran, and foreign code was
   fetched. The clone has no `node_modules/.bin/azelf`: it is a Python repo, azelf is a
   symlink under `node_modules/@chintonicc/`, and no install ever linked a bin. `bunx`
   finds no local binary and goes to the registry, where the name `azelf` is taken by
   something that is not this. The `/azelf` command (`agent/commands/azelf.md:11, :49`,
   `:165`, `:172`), the README's quick start (`:124`, `:203`, `:206`, `:212`, `:218`) and
   the dispatcher's own resume line (`slice-run.ts:6142`) all say `bunx azelf`. The
   non-bun section (`README.md:176`) says `bun $AZELF_DIR/bin/azelf.ts`, and nothing
   generated into the consumer's repo says that.
3. **The same-files warning said the clash "is already caught", and it was a textual
   conflict** (one dispatcher entry). #89 and #109 both raised one inventory total by
   one, on the same line with the same comment. `reportOverlaps` (`slice-run.ts:5044`)
   prints "A land rebases, so edits that CLASH are already caught. These are the ones
   that apply cleanly and still disagree." `slice-overlap.ts` is set algebra over file
   names; nothing in azelf runs `git merge-tree`. Under `-y` the second to land would
   have been parked at its rebase, an hour later. By hand, `git merge-tree
   --write-tree origin/main feat/ticket-109` showed it at once.
4. **Without `--auto`, a finished session is "running" for hours** (one dispatcher
   entry; the 2026-10-25 entry is the crash-shaped case of the same gap). Three sessions
   each finished in about ten minutes, one commit, clean tree, and stopped at their
   prompt as the skill tells them to (`SKILL.md:93`: "Stop with the tree committed and
   the gates green. Say the slice is ready"). The dispatcher said "3 running" for hours.
   `occupied` (`slice-run.ts:1345`) is the live marker and a pid; a session at its prompt
   has both. The report each session wrote exists only in its tab, so a supervising
   session, or a person at the dispatcher, has nothing to read.
5. **`slice-done.sh` says "It does not land anything"** (one dispatcher entry;
   `slice-done.sh:21`). With a dispatcher running it is the one act that lands and
   pushes the base branch, which on consumer-b is a production deploy. A supervising
   Claude Code session in auto mode is stopped by its classifier on exactly that, with
   the person's OK given, and the person types the last command. The entry asks for a
   config that splits "finished" from "may land". The split exists already: without
   `--auto` the session does not run `slice-done.sh`, a person does. What is missing is
   a way for a session, or a supervising one, to say "finished" that is not the land
   trigger, which is group 4's marker.
6. **Two sessions chose the same mock ports** (inside the Frontend #66 slice entry). The
   consumer's prompt warns about two ports; the session picked others, a parallel
   session had the same idea, and one visual check ran against the other's build. azelf
   allots nothing per slice. Not in this plan; see below.

## Decisions this plan makes

- **The prep carries azelf's own files into every worktree, by azelf's own list.** After
  `provisionCopy`, `slice-session.sh` copies each shim and each agent file that the main
  checkout has and the worktree lacks. A tracked file is already there, so this touches
  only the untracked case, which is consumer-b's. `provisionCopy` stays for the
  consumer's files (`.env`, a venv) and may still name the shims; naming them is now
  redundant and harmless. `azelf provision` goes through the same loop.
- **`azelf init` writes a launcher, `scripts/azelf`, and nothing generated says `bunx`
  any more.** The launcher resolves the package by the rule every shim uses and runs
  `bun <package>/bin/azelf.ts`. The `/azelf` command, the README and the dispatcher's
  resume line say `./scripts/azelf run …`. The first call, before the launcher exists,
  is `bun node_modules/@chintonicc/azelf/bin/azelf.ts init`, or `bun
  $AZELF_DIR/bin/azelf.ts init` from a checkout, spelled out: it is one line, once, and
  it cannot reach the registry. The README says in one sentence why `bunx` is gone.
  Reserving the npm name is outside this repo.
- **The overlap report asks git whether the pair will conflict, and says which.** For
  each pair of slices the file report pairs, `git merge-tree --write-tree --name-only
  --no-messages A B`: both open, the two branches; one landed, the base branch against
  the open one. Exit 1 names the conflicted files. The report becomes two blocks:
  "will conflict at the land", with the files git names, and "editing the same files",
  with today's wording, for the pairs that merge clean. One merge-tree per pair, cached
  by the pair's heads, reprinted when a verdict changes. A landed slice is already a
  pair member (`✓`), so "after each land, check the open ones against the new base" is
  the same check on the next round and needs no second code path. On a git without
  `--write-tree` (older than 2.38) the report stays as it is and says so once.
- **A session says it finished with a marker that lands nothing.** `.slice-finished`
  (the thirteenth marker): first line the head it finished at, then its report. Written
  by `./scripts/slice-finished.sh`, which takes the report the way `session-commit.sh`
  takes a message (`-m`, or `-F -` from a heredoc) and `--stuck` for "the gates will not
  go green" or "waiting on the lock". The dispatcher counts a slice whose session is
  alive and whose marker names the branch's head as "waiting for you", not "running",
  and prints the report's path once. A marker that names an older head is stale: the
  session went on, and it is running. `slice-done.sh` and a new session's start remove
  it. Under `--auto` nothing changes: the session runs `slice-done.sh`.
- **`slice-done.sh` says what it triggers.** Its header and the README line stop saying
  "it does not land anything" and say that a running dispatcher lands on it, and that
  on a repo whose base branch deploys, this is the deploy. No `landRequiresApproval`:
  the finished marker is the "done" that deploys nothing, and `slice-done.sh` stays the
  person's act, which is what the classifier is right to guard.

## Phase 1 — the shims are in every worktree, and the launcher is ours

- [x] 1a. `scripts/slice-files.ts`: `SHIMS` and the agent file list move here from
  `slice-init.ts`, which imports them back, so `slice-config.ts` can import them without
  a cycle. The bridge (`slice-config.ts:800`) exports `SLICE_AZELF_FILES[]`: every shim
  as `scripts/<name>` and both agent files.
- [x] 1b. `slice-session.sh:338`: after the `provisionCopy` loop, the same loop over
  `SLICE_AZELF_FILES`, with its own line ("✓ copied scripts/slice-gates.sh — azelf's
  own; it is untracked here"). Never over a file that is there. `--provision` goes
  through it unchanged.
- [x] 1c. `scripts/azelf`, the launcher: a `SHIMS` entry whose target is `bin/azelf.ts`
  through `bun`. `shimText` takes a target and a runner; the existence check and the
  error text name the target. `AZELF_INVOKED_AS` is exported as for the others.
- [x] 1d. Nothing generated says `bunx`: `agent/commands/azelf.md` (`:11`, `:28`,
  `:49–52`, `:165–166`, `:172`), `resumeCommand` (`slice-run.ts:6142`), which prints
  `./scripts/azelf run` when the main checkout has the launcher and `bun
  <package>/bin/azelf.ts run` otherwise. The README: install (`:124`), the quick start,
  the examples (`:314`, `:329`, `:331`, `:724`, `:1605`, `:1626`), the init table
  (`:153`, with the three rows it lacks: `slice-gates.sh`, `slice-push-main.sh`,
  `azelf`), `provisionCopy` (`:454`: azelf's own files need not be listed), and one
  sentence on why `bunx` is gone.
- [x] 1e. The skill, step 5: one sentence naming the package's copy for a worktree
  prepped before this, under the main checkout's `node_modules/@chintonicc/azelf`.
- [x] 1f. Tests
  - `sliceInit.test.ts`: `scripts/azelf` is written, execs `bin/azelf.ts` through bun,
    and fails with the "not installed" text when the package is missing.
  - a prep test (`sliceRun.test.ts`, or a new `sliceProvision.test.ts`): a shim that is
    untracked in the main checkout and absent from `provisionCopy` is in the worktree
    after the prep; a tracked one is not copied over; `azelf provision` fills one that
    was re-added by hand.
  - `sliceRun.test.ts`: the resume line says `./scripts/azelf run` (the fixture has
    the launcher) and not `bunx`.

### What building it found

- **The agent files moved with the shims.** consumer-b's list named the `/azelf`
  command and the skill too, and a worktree without the skill is a session without
  its contract. `slice-files.ts` holds both lists; `slice-init.ts` re-exports them.
- **The first call is spelled out, not `bunx --no-install`.** bunx has that flag, and
  a README line that still starts with `bunx azelf` is the line a reader copies into
  the next repo without the flag. `bun node_modules/@chintonicc/azelf/bin/azelf.ts
  init` is one line, once, and cannot reach the registry.
- **The launcher checks for bun itself**, before the exec, with the same words as
  `slice-gates.sh`; a `.sh` shim's target does that in its own header, a `.ts`
  target has no header to do it in.
- **The prep test needed a remote.** The `provision` tests' consumer has none, and a
  prep fetches `origin/<base>` first (the stale-base plan). `provision` itself goes
  through the same copy loop and is tested on the consumer without one.
- **The fixture writes the launcher too**, so the resume line the tests read
  (`./scripts/azelf run …`) is the one a consumer sees; without it the dispatcher
  would print `bun <package>/bin/azelf.ts run …`, which is right for a checkout that
  never ran init and is not what the tests are about.
- **init's shim lines are `wrote  scripts/…`, two spaces**, where its other lines
  have four. Older than this plan, left alone; the test matches on whitespace.

## Phase 2 — a clash is said before the land

- [ ] 2a. `slice-run.ts`: `conflictOf(a, b)` runs merge-tree for a pair and returns the
  conflicted files, cached by both heads; for a landed member the base branch stands
  in. A usage error from git (no `--write-tree`) disables it for the run and is said
  once.
- [ ] 2b. `reportOverlaps` (`:5044`): each overlap group is split by `conflictOf` into
  the two blocks above. The "will conflict" block lists the files git named, the other
  the shared files as today. The "once per change" key carries the verdicts. The
  `✓ = already landed` line stays with whichever block has one.
- [ ] 2c. README: the paragraph on the overlap report says what each block means and
  that a conflict is said while both slices are open, not at the land.
- [ ] 2d. Tests in `sliceRun.test.ts`: two open slices change one line → "will conflict
  at the land" naming the file; two open slices change different lines of one file →
  "editing the same files" and not the other block; one landed, the open one on the
  same line → "will conflict" with the `✓`; the verdict changing after a commit reprints.

### What building it found

## Phase 3 — a finished session is seen

- [ ] 3a. `scripts/slice-finished.sh` and its shim: from a slice worktree, `-m <text>`
  or `-F <file>` (`-` for stdin), `--stuck` optional. Writes `.slice-finished`: the head,
  `stuck` or `finished`, a blank line, the report. Refuses an empty report and a
  worktree that is not a slice's. Clears nothing. `slice-done.sh` removes it (`:191`);
  `slice-session.sh` removes it when a session starts (`:519`).
- [ ] 3b. `slice-run.ts`: `finishedAt(n)` reads the marker; `waitingForYou(n)` is a
  live session whose marker names `branchHead(n)`. The round line (`:5947`) counts those
  under "waiting for you" and not "running"; `[round N] #89 finished its turn — report
  in <worktree>/.slice-finished; ./scripts/slice-done.sh there lands it` once per marker,
  and "#89 is stuck: <first line>" for `--stuck`. The end-of-run summary lists them.
- [ ] 3c. The marker in `EXCLUDE_BLOCK` (`slice-init.ts:75`); README "twelve" → the
  counted number (`:137`, `:166`).
- [ ] 3d. The skill's finish: without a start instruction, write the report with
  `./scripts/slice-finished.sh -F - <<'EOF' … EOF` and end the turn; the "gates will
  not go green" and "blocked on the lock" endings do the same with `--stuck`. `azelf
  init` rewrites a skill it wrote.
- [ ] 3e. `slice-done.sh:19–28` and README `:408`: what it triggers.
- [ ] 3f. Tests
  - `slice-finished.sh`: writes head and report; `-F -` reads stdin; refuses empty;
    `slice-done.sh` removes it.
  - `sliceRun.test.ts` with `fakeSession`: marker at head → "1 waiting for you" and the
    report line once; a commit after it → "1 running" again; `--stuck` → the stuck line.
  - `sliceInit.test.ts`: thirteen patterns; the skill names `slice-finished.sh`.

### What building it found

## Order and cost

Phase 1 first: it is ten of the fifteen entries and the one with a supply-chain shape.
One shell loop, one shim, one module, docs; about six tests.

Phase 2 second: one git call per pair, one printer split, four tests.

Phase 3 third: one script, one marker, one filter in the dispatcher, a skill edit;
about eight tests.

## Not in this plan

- **`caffeinate -is -w $$` on macOS while slices run, and a stall detector by mtime**
  (2026-10-25). Still not in azelf. The finished marker covers the ordinary case of a
  session at its prompt; the crashed case stays unseen. Cheap, worth its own short plan.
- **A port block per slice** (Frontend #66, and 2026-10-22). An env per session with a
  slot number is small; what the consumer's mock scripts do with it is the larger half.
- **`landRequiresApproval`**: see the decisions.
- **Reserving the npm name `azelf`**: outside this repo.
- **Still open from 2026-10-22:** a command allowlist for the resolver; `reviewReadDirs`;
  `azelf adopt <ticket> <ref>`; `--watch-labels`; `regenerate` and `refresh` steps after a
  rebase; a venv-against-requirements check in the install step.

## What the consumer does itself

consumer-b (the mapping is in `CONSUMERS.local.md`):
- Today, before Phase 1 is pulled: `scripts/slice-gates.sh` and
  `scripts/slice-push-main.sh` into both configs' shim list, so the two running waves
  stop tripping. Done by hand on 2026-10-30.
- After Phase 1: pull `azelf-run`, `azelf init` in both clones (the launcher, the
  command, the skill), and `azelf provision <n>` for a worktree that is still open from
  before, once its session is out of it. The shim entries in `provisionCopy` may go.
- After Phase 3: nothing in the config. The skill carries the finish.
