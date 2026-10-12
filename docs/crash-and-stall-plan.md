# A review that cannot kill the run, a lock wait that ends, blockers read from the list, and gates scoped by path

**Status:** IN PROGRESS (Phases 1–2 landed) · **Written:** 2026-10-10
**Companion:** consumer-a's friction log: the four entries still open after
`docs/ownership-plan.md`, two dated 2026-10-08 and two dated 2026-10-09. Every other
entry is covered by a complete plan.

Written so it can be picked up cold. Tick the boxes as they land and add the commit hash
after the heading. Line numbers are as of `7eef84b`.

## What happened

1. **A NUL byte in a slice's diff killed the dispatcher in the spec review.** #127's
   gates passed. Then `reviewing #127 (spec + standards) …` died with
   `TypeError: The argument 'args[2]' must be a string without null bytes`
   (`ERR_INVALID_ARG_VALUE`), from `run` ← `askAgent` ← `reviewSpec` ← `reviewSlice`
   ← `tryLand`. The diff touched a source file that uses a literal NUL as a map-key
   separator inside template literals, four times, already on the base. The diff went
   into the prompt, and the prompt goes to the agent as an argument
   (`slice-agent.ts:153`, `[bin, "-p", …, prompt]`). An argument is a C string: it
   cannot hold a NUL. `spawnSync` refuses such an argument by **throwing**, not by
   returning an error, so `run`'s `allowFail` (`slice-run.ts:215`) never saw it. The
   whole run exited, not just the review. The NULs also reached the run's log, so plain
   `grep` read the log as binary.

2. **A slice refused by the DB lock waited twelve hours for a relaunch that could not
   come.** #129's session committed its part that needed no lock. Then
   `db-lock.sh claim` refused it (holder #127) and wrote `.slice-lock-wait`. The lock
   was free from 21:33 that evening. The dispatcher said `waiting for it: #129 —
   relaunched when it frees` (`slice-run.ts:4850`) and then never relaunched it. #129
   sat idle until a person pasted its status into its tab the next morning, at about
   09:45; the run's log had reached round 488.

   The contract tells the agent to "say who holds the lock, and exit" (slice
   `SKILL.md:36`, and the refusal text, `db-lock.sh:136`). An agent in an interactive
   REPL cannot exit its own process; it can only end its turn, and the REPL stays.
   So `.slice-live` names a live session, `occupied()` (`slice-run.ts:1049`) is true,
   and `runnable` (`slice-run.ts:1290`) never picks the ticket up. The only way a REPL
   session ever ends is `slice-land.sh --end-session` after a land
   (`end_agent_under`, `slice-land.sh:448`). A lock wait has nothing like it.

3. **Any ticket number under `## Blocked by` counts as a blocker, prose included.**
   #99 was taken off #105's blockers by deleting its list item, and an italic note
   at the top of the section said why: "*#99 … was taken off the blockers*". The
   pre-flight then refused the plan: `✗ #105's body says it is blocked by #99 (open,
   not in this run). GitHub has no edge.` `blockersFromBody`
   (`slice-tracker.ts:288`) reads every id in the section unless it opens with
   "None". The message did not say which line it had read, so the cause took a while
   to find.

4. **A slice's own expensive test never ran as a gate.** #142 changed the Swift
   encoder of a native iOS module. Its acceptance criteria hinge on a script that
   builds the Swift with `swiftc` and runs real encodes, about four minutes. The gates
   are the three every slice gets (Vitest, tsc, Biome), so the Swift was never compiled
   before the land. The spec review said so, as `UNVERIFIED: whether … passes — the
   Swift code was not compiled or run`, under a PASS, and the slice landed and pushed.
   Run by hand on the base afterwards, the script passed. A compile error would have
   reached the base and broken the next native build, and nothing would have noticed.
   Making the script a gate for every slice would cost four minutes on each, for the
   few slices that touch that module.

## Decisions this plan makes

- **No NUL ever reaches an argument.** Every agent prompt has its NULs written as the
  two characters `\0`, which is what a person reading the source sees. That is done in
  one place per agent call, not per input, because the diff, the ticket, the parent
  spec and the landed diffs all feed the same prompt. `run` also catches what
  `spawnSync` throws, so the next argument it cannot pass fails one call, not the run.
- **A review that could not run says so, and parks.** The spec review already fails
  closed: no answer reads as BLOCK. The park reason says the review did not run, and
  why, instead of `the spec review says BLOCK`.
- **The dispatcher ends a session that waits on a free lock, and starts it again.**
  This applies under `--auto` only. It waits until the worktree has been quiet for two
  rounds, so an agent still committing is not cut off. Its files stay as they are, and
  the relaunch prompt already says to continue from them (`slice-session.sh:548`).
  Without `--auto` a person reads that tab, so the dispatcher says once that the lock
  is free and leaves the session alone.
- **The contract stops asking for the impossible.** "End your turn", not "exit".
- **A `## Blocked by` section with list items is read as a list.** Only the ids in its
  items count. A section with no list items is read as today, and so are the phrases
  ("blocked on #2") anywhere in the body. The refusal quotes the line it read.
- **A gate can be scoped by path.** `when: [globs]` runs it only when the slice's
  diff touches a matching file. The globs use `overlapIgnore`'s syntax
  (`slice-overlap.ts:120`). A skipped gate is said in the run, and the reviews are
  told which gates ran and which were skipped. The review is not made to BLOCK on a
  command nobody ran: it is told not to run anything (`alreadyRan`,
  `slice-run.ts:1631`), and the cure for an unrun check is a gate.

## Phase 1 — a NUL in a prompt no longer kills the run (913c273)

- [x] **1a. Write NULs as `\0` in agent prompts.** One helper, used by `askAgent`
  (`slice-run.ts:1662`) on the prompt it hands `agent.review`, and by `resolveStops`
  (`slice-run.ts:3033`) on the prompt it hands `agent.resolve`. The reviewer reads
  `\0` where the file has the byte, and the resolver edits the file itself with its
  tools, so it never writes a prompt's copy back.
- [x] **1b. `run` never throws on a spawn it cannot make, under `allowFail`.** Catch
  what `spawnSync` throws and return `ok: false`, `status: null`, with the error's
  message as `out`. Also put `proc.error?.message` into `out` when `spawnSync`
  returns an error instead of throwing (`E2BIG` for a prompt over the argument limit,
  `ENOENT` for a missing binary). Today `out` is empty then, and the reason is lost.
  Without `allowFail`, `run` throws as today.
- [x] **1c. A review that did not run parks with that reason.** `askAgent` hands back
  why the call failed, alongside the null it returns today. `reviewSpec`'s "did not
  return" report (`slice-run.ts:1865`) carries the reason. `tryLand` parks as `review`
  with `the spec review could not run — <first line>`. It is retried when the branch
  moves, when the ticket is edited, or with `azelf retry`, as any review park is.

  *Proof:* **`sliceRun.test.ts`**:
  - a slice whose diff carries a raw NUL (a `.gitattributes` line makes git diff the
    file as text) is reviewed and lands; the recorded prompt holds `\0` and no NUL.
    On the old code the dispatcher exits with the `TypeError`;
  - a reviewer whose argv holds a NUL itself parks the slice as
    `the spec review could not run — …`, and the run ends normally;
  - a reviewer whose binary does not exist names `ENOENT` in the park line.

**As landed.** `argSafe` and `spawnFailure` in `slice-run.ts`; `askAgent` returns
`{ text, why }`, and `reviewSlice` returns the park reason or null. Three changes from
the plan:
- `why` is the *last* line of what the agent printed, not the first: stdout comes
  before stderr in `out`, and the error is at the end.
- Bun's missing-binary error says "Executable not found in $PATH" and not ENOENT, and
  its `status` is `undefined`, not `null`. `spawnFailure` puts the code in front of the
  message when the message lacks it, and cuts it at 200 characters, because the
  message for a bad argument quotes the whole prompt.
- The ✗ line for a review that could not run says to retry once the reviewer can run,
  instead of telling the author to fix the slice.

Proof: three tests in `sliceRun.test.ts`, "a review that cannot run". All three fail
on `7eef84b`, and the first stops the dispatcher with the `TypeError` from consumer-a.
README: "A review that could not run says so."

## Phase 2 — a slice waiting on a free lock is ended and started again (0166ccc)

- [x] **2a. End it under `--auto`.** Each round, when `dbLockHolder()` is empty, check
  every open ticket that has a live session (`hasSession`) and `.slice-lock-wait`.
  For each one, compare its worktree's HEAD and `git status --porcelain` with what the
  last round saw. When they have stayed the same for two rounds, end the agent under
  that session the way `end_agent_under` does: TERM to the children of the session's
  pid, KILL after five seconds, and never the session shell itself.

  > #129: the DB lock is free — ending its session, which has waited on it since 15:09, to start it again

  The session shell exits, its trap clears `.slice-live`, and the next round's
  `runnable` relaunches the ticket like any idle worktree. The launch clears
  `.slice-lock-wait` (`slice-session.sh:517`).
- [x] **2b. Close its tab.** In `slice-session.sh`, under `--self-land`, an agent that
  ended while `.slice-lock-wait` is there closes its tab with exit 86, as a land does
  (`slice-session.sh:654-661`):

  > ── waiting on the DB lock — closing this tab; the dispatcher starts it again when the lock is free ─

  Otherwise every lock wait would leave a dead tab behind the relaunched one, because
  an agent that ended on a signal reads as a crash.
- [x] **2c. Say it without `--auto`.** Once per ticket, when the lock frees:

  > #129 waits on the DB lock, which is free now — tell its session to go on, or end it and it is started again

- [x] **2d. The contract.** In slice `SKILL.md` §3 and "If the gates will not go
  green", and in the refusal text in `db-lock.sh` (`refuse_claim`): commit what you
  have outside those paths, say who holds the lock, and end your turn. Under `--auto`
  the dispatcher ends this session and starts a new one when the lock frees. Do not
  wait for it in the session.

  *Proof:*
  - **`sliceRun.test.ts`**, with a fake session that runs a child process standing in
    for the agent and exits when that child does:
    - lock held by #127, #129 waiting. #127 releases, the line is printed, the child
      is ended, and #129 is launched again in a later round. On the old code it is
      never relaunched;
    - a worktree that changes every round is not ended while it does;
    - without `--auto`, the 2c line is printed once and the child keeps running.
  - **`sliceSessionClose.test.ts`**: an agent ended by a signal with
    `.slice-lock-wait` present exits 86 under `--self-land` and keeps its exit status
    without it.

**As landed.** `wakeLockWaiters` and `endAgentUnder` in `slice-run.ts`, called each
round right after the DB lock block. `LOCK_WAIT_QUIET = 2`: the round the lock frees
records the worktree, and the session is ended two unchanged rounds later. The
session's pid comes from `liveSession`, so a marker with no pid is never ended. Two
changes from the plan:
- The first session in the proof commits its lock-free part before it is refused, as
  #129 did. The test then checks that this commit is not landed as half a ticket
  when that session ends, and that the relaunch prompt says to continue from it.
- The README's `claim` paragraph says "ends its turn" too, and gets its own
  paragraph on the relaunch.

Proof: "a session waiting on a lock that frees" (three tests) in `sliceRun.test.ts`,
and two lock-wait tests in `sliceSessionClose.test.ts`. On the old code the relaunch
test and the exit-86 test fail. Full suite 480/480.

## Phase 3 — a `## Blocked by` list is read as a list

- [ ] **3a. List items only, when there are any.** In `blockersFromBody`
  (`slice-tracker.ts:288`), a section with at least one list item (`- `, `* `, `+ `,
  `1. ` or `1) `, after optional indentation) contributes only the ids in its items.
  A section without one is read whole, as today. An italic line (`*#99 …*`) is not a
  list item: the marker must be followed by a space. The "None" rule and the phrase
  rule are unchanged.
- [ ] **3b. Quote the line.** The refusal (`slice-run.ts:567`) prints the line the id
  was read from, under it:

  > ✗ #105's body says it is blocked by #99 (open, not in this run). GitHub has no edge.
  >     read from: "- #99 — the storage policy"

  A helper in `slice-tracker.ts` returns the first line, in the section or in a
  phrase, that `blockersFromBody` takes the id from.

  *Proof:* **`sliceTracker.test.ts`**:
  - a list plus a prose line naming another id → only the list's ids;
  - no list items → every id, as today;
  - an italic note naming an id is not an item;
  - "None" and the phrase rule still hold.

  **`sliceRun.test.ts`**: the refusal quotes the list item. The first case reads #99
  on the old code.

## Phase 4 — gates scoped by path

- [ ] **4a. `when` on every gate shape.** `GateOptions` (`slice-gates.ts:95`) gains
  `when?: string[]`, and `Gate` carries it. `runGates` (`slice-gates.ts:314`) skips a
  gate whose `when` matches none of `ctx.changedFiles`, and `GatesResult` gains
  `skipped: string[]`. The matcher is `ignores()` from `slice-overlap.ts`: `*` within
  a directory, `**` across them, and a trailing `/` for a directory's contents.
  `slice-config.ts` refuses a `when` that is not a non-empty array of strings.
- [ ] **4b. Say it.** `gatesPass` (`slice-run.ts:2483`) prints one line per skipped
  gate:

  > skipped `bun run test:native` — #142 touches none of ios/**, scripts/encode-verify.swift

  The `running N gate(s)` line counts the gates that will run. `azelf run --gates`
  prints the same lines.
- [ ] **4c. Tell the reviews.** `alreadyRan` (`slice-run.ts:1631`) takes the slice's
  gate result. It names the gates that ran and passed, and separately the gates that
  were skipped because the diff touched none of their paths. Today it names
  `config.gates`, all of them, as having run.
- [ ] **4d. README.** The gates section documents `when`, with the native-module case
  as its example, and says that a scoped gate holds the gate lock while it runs, like
  any gate.

  *Proof:*
  - **`sliceGates.test.ts`**: a `when` gate is skipped when nothing matches and run
    when one file does; `**` matches across directories; `skipped` lists it; a gate
    without `when` always runs.
  - **`sliceRun.test.ts`**:
    - a slice touching `ios/x.swift` runs the scoped gate, which fails and parks it;
    - a slice touching only `a.txt` skips it with the line and lands;
    - the review prompt names the skipped gate as skipped, not as passed.
  - The config test refuses `when: []` and `when: "ios/**"`.

## Order and cost

Phase 1 first: it is small, and a single byte in any file a slice touches stops the
whole run. Phase 2 next, because it silently costs hours whenever two lock tickets
overlap. It is mostly the dispatcher, plus one condition in `slice-session.sh` and
text. Phase 3 is small and independent. Phase 4 is the largest: a new config key, the
gate runner and the review prompt. It is a feature rather than a fix, so it goes last.
The phases touch different code, apart from Phases 1 and 4, which both change what
the review is told, in different functions.

## Not in this plan

- **Prompts through stdin instead of an argument.** That would remove the NUL and the
  argument-length limits at once, but it changes every agent preset and the `custom()`
  contract. After 1a, NUL is the only byte an argument cannot carry. A prompt over the
  limit already fails closed, and after 1b it says `E2BIG`.
- **Typing into a waiting session's tab.** Warp has no way to send it text; tmux could,
  but ending the session and starting it again works under every launcher.
- **A plan-time edge between two tickets that both touch the lock paths, from ticket
  text.** The ticket text does not reliably say which files a ticket touches; see
  `docs/ownership-plan.md`, item 5. `exclusiveLockLabel` is the declared form, and it
  already keeps two labelled tickets from running at once.
- **A spec review that BLOCKs on an acceptance command nobody ran.** It is told not to
  run anything, and an `UNVERIFIED` line is already printed under the verdict. The
  cure is a gate, scoped if it is expensive.
- **Still open from earlier plans:** a restarted dispatcher's plan review covers only
  its own run; a named closed ticket is polled every round; an agent left idle after an
  API error.

## What the consumer does itself

- **The bump after each phase.** After Phase 2, `azelf init` too, for the new
  `SKILL.md` text.
- **Until Phase 1:** replace the raw NULs in that source file with `\u0000` escapes.
  It reads the same at runtime and keeps the bytes out of every diff.
- **Until Phase 2:** under `--auto`, a slice that logs a DB-lock refusal needs its tab
  told when the lock frees, or its session ended. Give tickets that need the lock
  `exclusiveLockLabel`, so they don't run side by side.
- **After Phase 4:** add the native build as a gate with `when` on the module's
  paths.
