# A dispatch that only starts what was meant, and only lands what was released

**Status:** PLANNED, nothing landed · **Written:** 2026-10-02
**Companion:** consumer-a's friction log (an untracked file in its main checkout, not in
this repo), entries dated 2026-09-25 to 2026-10-02. `docs/wave-recovery-plan.md` covers
the entries before those.

Written so it can be picked up cold. Each item says what to change, where, why, and what
proves it. Tick the boxes as they land and add the commit hash after the heading. Line
numbers are as of `e3abd70`; search for things by name once a phase has moved them.

## What happened

The friction log has 23 open entries. They were ranked on 2026-10-02 by what happens
without a human in the loop, and the seven in this plan are the ones where azelf started
or landed work nobody asked for.

1. **Slices landed and were pushed with nobody releasing them.** A run without `--auto`
   is documented as "the session stops, a human runs `slice-done.sh`". Two sessions ran
   `slice-done.sh` themselves, and the dispatcher landed and pushed both. Review is off
   by default without `--auto`, so nothing read either diff.

   The cause is the slice skill. Section 6 of `agent/skills/slice/SKILL.md` tells every
   session to run `slice-done.sh` and exit, whatever the mode. `--self-land` only adds
   the same instruction to the start prompt (`slice-session.sh:423-429`).
2. **A spec is planned as a slice** (three entries). `findEpics`
   (`slice-tracker.ts:317`) only counts a parent whose children are in the same ready
   set. Once the children land and close they leave the set, and the parent, still
   carrying the ready label, becomes an ordinary wave-1 ticket. A bare `azelf run` would
   open a session on the whole spec. With explicit ids the hierarchy is not read at all
   (`slice-run.ts:277`).
3. **A blocker that exists only in the ticket body is not scheduled on** (two entries).
   Three tickets were filed with `## Blocked by #81` and no tracker edge. The plan put
   all three in wave 1 and said so in a note below the waves. Bodies that say
   "**Blocked on #2.** Do not start early" outside a `## Blocked by` section are not
   read at all (`section()`, `slice-tracker.ts:213`).
4. **Explicit ids skip the ready label without a word.** `azelf run 2 4 5 6 7` listed
   five tickets as runnable, none of which carried the label.

## Decisions this plan makes

Each one changes behaviour someone may rely on. Overrule them before Phase 1 starts, not
after.

- **A session marks itself done only under `--self-land`.** The doc, the run header
  (`slice-run.ts:2703`) and `slice-done.sh`'s own header already say this. The skill is
  the part that disagrees, so the skill changes.
- **A ticket with children is never a slice in a bare run, wherever the children are.**
  Open or closed, in the set or not.
- **Explicit ids still win, but the plan says what it overrode.** A named parent or a
  named ticket without the ready label runs, with a `⚠` line each. No new flag.
- **An open body-only blocker stops the dispatch.** The plan still prints. The run then
  refuses and gives two commands: record the edge, or run anyway. The existing rule that
  prose is never turned into an edge on its own (`printMissingEdges`,
  `slice-run.ts:340-350`) stays: azelf still does not guess, it now asks.

## Phase 1 — a session only declares done when told to

- [ ] **1a. The skill's finish section depends on the start instruction.**
  - **The change.** Section 6 of `agent/skills/slice/SKILL.md` becomes two cases:
    - the start instruction says to run `slice-done.sh`: run it and exit, as today;
    - it does not: stop with the tree committed and the gates green, say the slice is
      ready and that `./scripts/slice-done.sh` releases it, and do not run it.

    The frontmatter description ("…commit, mark it done") loses "mark it done".
  - **Why the default is "don't".** A session started with `--no-start` or by hand has
    no start instruction at all. Reading the skill alone must not land anything.
  - **This repo's own copy.** `.claude/skills/slice/SKILL.md` gets the same text.
    `.claude/commands/azelf.md` is already behind `agent/commands/azelf.md` (it lacks
    the auto-resolve paragraph); bring it level in the same commit.

- [ ] **1b. The start prompt says it too.** In `slice-session.sh:423-429`, the
  `$self_land` branch gets an `else`:

  > When it is finished and the gates are green, stop and say it is ready. Do NOT run
  > ./scripts/slice-done.sh: a human releases this slice.

  The skill is a file the consumer may have edited (`init` leaves an edited copy
  alone, `slice-init.ts:403`), so the prompt cannot rely on it.

- [ ] **1c. The run header and the doc say what a land does.**
  - `slice-run.ts:2703`, the non-`--auto` header, becomes two lines: sessions stop when
    finished and do not mark themselves done; `slice-done.sh` releases one, and a land
    pushes `<baseBranch>` to origin.
  - `agent/commands/azelf.md:36-38` says the same in one sentence each for the two
    modes, and that review is off without `--auto` unless `--review` is passed.
  - README, wherever it describes `slice-done.sh`.

  *Proof:*
  - **`sliceSessionClose.test.ts`** already starts `slice-session.sh` with a fake agent.
    Add: without `--self-land` the prompt the agent receives contains "Do NOT run" and
    does not contain "and then exit"; with it, the reverse.
  - **`sliceInit.test.ts`**: the packaged skill contains both cases. One assertion, so a
    later edit cannot drop the "do not" half unnoticed.
  - There is no test that an agent obeys. That is checked once by hand on consumer-a:
    `azelf run <one ticket>` without `--auto`, and the session stops without a
    `.slice-ready-to-land`.

**What the consumer does:** `bunx azelf init` after the bump. It rewrites the skill if
the copy still carries the `generated by` line.

## Phase 2 — a parent is not a slice

- [ ] **2a. `findEpics` counts children outside the set.**
  - **Native children.** In the `from.children` loop (`slice-tracker.ts:331-337`), drop
    `inSet.has(kid)`. GitHub's `sub_issues` returns closed children too, and
    `children()` is already called for every id, so this costs nothing.
  - **Prose children.** A new optional tracker method:

    ```ts
    /** Every ticket, open or closed, whose body has a `## Parent` section. */
    parentClaims?(): { id: TicketId; state: TicketState; body: string }[];
    ```

    `findEpics` runs `parentFromBody` over the result and adds each child whose parent
    is in `ids`. One call per plan, not one per ticket. GitHub's adapter answers it with
    `gh issue list --state all --search '"## Parent" in:body' --json number,state,body`.
  - **Check first, and record the result in the "as landed" block:** does that search
    match the heading reliably, and what does it return on a repo with several hundred
    issues? If search proves unreliable, fall back to listing the most recently closed
    issues (`--state closed --limit 100`) and filtering locally.
  - **`Epic` gains `openChildren: TicketId[]`.** `children()` returns ids only, so the
    state comes from `parentClaims` for prose children and from one `tracker.get` per
    native child not already loaded. Cache it; a plan has a handful of epics.

- [ ] **2b. The exclusion says what to do about a finished epic.** `printEpics`
  (`slice-run.ts:325`) prints one of two lines:

  > ⚠ #45 excluded — named as Parent by #47 #48 #49 (1 open)
  > ⚠ #80 excluded — its 3 children are all closed. Close it, or remove ready-for-agent.

  The "run it anyway" line stays on both.

- [ ] **2c. Explicit ids: run it, and say so.** `loadTickets` (`slice-run.ts:277`)
  computes the epics for explicit ids too, and no longer excludes on them. For each:

  > ⚠ #45 is a parent (#47 #48 #49, all closed) — running it as a slice because you named it

  And for every named ticket whose labels lack `config.readyLabel` (`tracker.get`
  already returns them), one line for the lot:

  > ⚠ not labelled ready-for-agent: #2 #4 #5 — running them because you named them

  Both are printed after the waves, where the `proceed?` prompt is, not above them.

  *Proof:*
  - **`sliceTracker.test.ts`**, on `findEpics` with an injected tracker:
    - a parent whose native children are all outside `ids` is an epic;
    - a parent named only by a closed ticket's `## Parent` (through `parentClaims`) is
      an epic, with `openChildren` empty;
    - a tracker with neither method behaves as today.
  - **`sliceRun.test.ts`**. The fake tracker (`fixture.ts:224`) gains `listReady` from
    the tickets file, a `ready: false` field and `parentClaims`. Then:
    - a bare `--plan` over a parent with closed children prints "all closed" and plans
      nothing;
    - `--plan 45` prints the "because you named it" line and plans #45;
    - `--plan 2` on an unlabelled ticket prints the label line.

## Phase 3 — a blocker the body names is not ignored

- [ ] **3a. "Blocked on #N" is read wherever it stands.** `blockersFromBody`
  (`slice-tracker.ts:259`) returns the union of:
  - the ids under `## Blocked by`, as today, **unless the section's first non-empty
    line starts with "None"**. Then the section is empty, whatever it goes on to
    mention ("None. #62 and #63 have landed.");
  - the ids in any sentence that contains `blocked on` or `blocked by`, from that
    phrase to the next `.`, `;` or line end. "Blocked on #2 (the egress trigger) and #3
    (the authorizer)." gives #2 and #3. A phrase preceded by `not ` or `n't ` is
    skipped.

  `section()`'s comment explains why a bare `#17` in a paragraph is a mention, not
  structure. That still holds: this reads one phrase, not every id in the body.

- [ ] **3b. A closed blocker is not reported.** `bodyOnlyBlockers`
  (`slice-tracker.ts:281`) takes a `stateOf(id)` and drops claimed blockers that are
  closed. `loadTickets` supplies it from the set's own `tracker.get` results, and one
  cached `tracker.get` for an id outside the set. An id the tracker cannot read stays
  in the list: a typo in a body should be seen, not swallowed.

  After this, everything in `missingEdges` is an open ticket.

- [ ] **3c. The run refuses to dispatch over one.** After `printTree`
  (`slice-run.ts:2622`), when `missingEdges` is not empty:
  - **The note moves up and changes tone.** It names where each blocker is:

    > ✗ #82's body says it is blocked by #81 (in this run, wave 1). GitHub has no edge.
    > ✗ #4's body says it is blocked by #3 (open, not in this run). GitHub has no edge.

  - **`--plan` exits 0** as today, with the lines above and the two commands below.
  - **A dispatch exits 1 before the `proceed?` prompt**, in every mode, `-y` included:

    > not dispatching: the plan above would start a ticket beside its claimed blocker.
    >   record the edges:  azelf run --sync-edges -y
    >   or run as planned: azelf run --ignore-body-blockers <this run's flags and ids>

  - **`--ignore-body-blockers`** is added to `slice-run-usage.ts` and its known-flag
    list. With it the lines are printed as `ℹ`, as today, and the run proceeds.
  - **Why refuse instead of scheduling on the claim.** The existing comment gives the
    case: a body that says "blocked by #19" and means "read #19 first". Scheduling on it
    silently would delay a slice by a wave for a reading order. Refusing costs one
    command, once, and after `--sync-edges` the tracker is right for every later run.

- [ ] **3d. `--sync-edges` says how to confirm without a terminal.** `-y` already works
  (`syncEdges(missingEdges, assumeYes)`, `slice-run.ts:2618`); nothing says so. The
  usage line becomes `azelf run --sync-edges [-y]`, and when the prompt gets no answer
  on a non-TTY the last line is:

  > stopped. Nothing was written. Confirm without a prompt with: azelf run --sync-edges -y

- [ ] **3e. README and both `/azelf` command copies.** "Always start with the plan"
  gains: a parent is never a slice, a body-only blocker stops the dispatch, and the two
  ways out.

  *Proof:*
  - **`sliceTracker.test.ts`**:
    - `blockersFromBody`: the "None. #62 and #63 have landed." section gives `[]`;
      "**Blocked on #2 (…) and #3 (…).** Do not start early" gives `["2","3"]`; "not
      blocked by #19" gives `[]`; "reads best after #19" gives `[]`;
    - `bodyOnlyBlockers`: a closed claimed blocker is dropped, an unreadable one is
      kept.
  - **`sliceRun.test.ts`**, two tickets where one body names the other:
    - `--plan` exits 0 and prints the `✗` line;
    - `-y` exits 1, prints "not dispatching", and creates no worktree;
    - `--ignore-body-blockers -y --once` preps both;
    - with the blocker closed in the tickets file, the run proceeds and prints no note.

## Order and cost

Phase 1 is an hour of text and two assertions. It ships alone and first, because it is
the only item where something reached origin unreviewed. Phase 2 is half a day, most of
it the `parentClaims` check against a real repo. Phase 3 is half a day. Phases 2 and 3
both extend the fake tracker in `fixture.ts`; do that once, at the start of Phase 2.

## Not in this plan

The rest of the friction log's open entries, in the order they were ranked:

- **The resolver's last stop.** A rebase that stops twice is resolved twice and then
  rejected as abandoned; the second resolution is never staged and continued.
- **A plan review with findings exits 0.**
- **`--auto-resolve` without `--auto`**, for a parked conflict in a non-interactive run.
- **Run-log noise:** the round line after a land, the overlap warning for a branch that
  already contains the landed slice, "prepped, not launched" before a launch.
- **Scripts:** `session-commit.sh --push` without `-m`, `-F <file>`; `format.sh` on a
  path that does not exist.
- **Review design:** the parent spec handed to the reviewer and the session, new tests
  run against the base, and a landed slice's notes handed to its open siblings.
- **A spec with the ready label and no children yet.** Nothing marks it as a parent
  until its tickets exist. Excluding on a `Spec:` title would be a guess; the consumer
  keeps the label off specs (see below).
- **A mechanical guard on `slice-done.sh`.** The script cannot tell an agent from the
  human releasing the slice in the same tab. Phase 1 is instructions only.

## What the consumer does itself

- **`bunx azelf init`** after Phase 1, so the skill copy is the new one.
- **Remove the ready label from specs.** The spec-writing skill applies it by design.
  After Phase 2 a spec with children is excluded either way, but one without children
  yet still runs.
- **`azelf run --sync-edges -y` after filing tickets** whose bodies name blockers. After
  Phase 3 the run asks for it; doing it at filing time saves the refusal.
