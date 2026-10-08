# Fresh tickets in the plan, and less noise in the run

**Status:** NOT STARTED · **Written:** 2026-10-08
**Companion:** consumer-a's friction log, entries dated 2026-10-02. The four larger open
entries from the same log are in `docs/unattended-run-plan.md`. That plan goes first.

Written so it can be picked up cold. Tick the boxes as they land and add the commit hash
after the heading. Line numbers are as of `7ffe3a0`.

## What happened

Three small entries. None of them started or lost work. Each one made a run cost more,
or made it harder to read.

1. **`--sync-edges` wrote 2 of the 3 edges that ticket bodies claimed.** Four tickets
   were filed one after another (#87–#90; the bodies said #88→#87, #89→#87, #90→#89),
   and `--sync-edges` ran straight after. It wrote the first two. The following plan
   reported `#90's body names a blocker GitHub has no edge for: #89`, and a second
   `--sync-edges` wrote that one.

   **The cause.** `listReady` calls `gh issue list --label <readyLabel>`
   (`slice-tracker.ts:525`), and `gh` answers that through GitHub's search API. That
   was checked with `GH_DEBUG=api` on gh 2.94.0: the request is an `IssueSearch` query
   with type `ISSUE_ADVANCED` and `label:… state:open` in its query string. Search is
   indexed with a lag, so #90, filed seconds earlier, wasn't in the ready list yet, and
   its body was never read. Running the sync in a loop wouldn't fix that. The same lag
   hides a freshly filed ticket from any bare plan, and `--limit 100` cuts the list off
   without saying so.
2. **The `DB lock held by:` block is printed every round.** Rounds 42–69, back to back,
   all identical: the same holder and the same "since" time. The round line got
   print-on-change in `fe8664b`. The lock block (`slice-run.ts:3664-3680`) didn't.
3. **The plan-level review runs an agent for a run that landed one slice.** It answered,
   correctly, "Cross-slice problems need at least two slices … FINDINGS: 0", after a
   full agent call and the wait that comes with it. `reviewPlan` (`slice-run.ts:1902`)
   only checks that review is on and that the diff isn't empty.

## Decisions this plan makes

- **The ready list comes from the REST issues endpoint, not search.** That endpoint is
  not search-indexed, and it pages, so the cap of 100 goes too. `parentClaims` stays on
  search, because it needs body text across closed issues. The children that matter
  most, the ones in the ready set, are read directly by `findEpics`.
- **The lock block is printed when it changes, on the heartbeat, and once when the
  lock frees.**
- **The plan review needs two slices landed by this run.** With fewer, it prints one
  line and calls no agent.

## Phase 1 — the plan sees a ticket filed a moment ago

- [ ] **1a. `listReady` through REST.**
  - **The call** in `github()` (`slice-tracker.ts:525-538`) becomes:

    ```
    gh api --paginate "repos/{owner}/{repo}/issues?state=open&labels=<label>&per_page=100"
    ```

    `<label>` is URI-encoded. The endpoint also returns pull requests, so drop the
    entries that have a `pull_request` key.
  - **How to read the pages** is the implementer's choice, recorded in "as landed":
    either `--jq '.[] | select(.pull_request == null) | .number'` with one number per
    line, or `--slurp` and flatten (`--slurp` can't be combined with `--jq`).
  - **Errors** keep the adapter's shape: `gh api … failed:` with `gh`'s output
    attached.
  - **Order** stays newest first, which is both endpoints' default, so which ticket
    starts first under `--max` doesn't change.
  - **Labels.** REST reads a comma in `labels` as "and". Config validation refuses a
    `readyLabel` containing a comma (`slice-config.ts:339`), and so does `humanLabel`'s
    validation from the other plan.
- [ ] **1b. Check first, and record the result.** On a scratch repository, file a
  labelled issue and list it immediately both ways. Repeat a few times. The expected
  result: REST shows it at once, and search sometimes doesn't. If REST lags too, stop
  and write down what was seen. The fix would then need a different shape, and `--sync-edges`
  would have to say "ran N seconds after the newest issue was filed" instead.
- [ ] **1c. The comment on `parentClaims`** gains one sentence: search lags, so a
  just-filed child is found through the ready set's own bodies, not through this.

  *Proof:* **`sliceTracker.test.ts`**, with the injected `gh` (`sliceTracker.test.ts:58`):
  - the call is `api --paginate` with the encoded label;
  - a pull request in the reply is dropped;
  - two pages give one list;
  - a failure throws with `gh`'s stderr attached, as the existing "Not logged in" test
    does (`sliceTracker.test.ts:220`).
  - `slice-config` refuses a `readyLabel` containing a comma.

## Phase 2 — the lock block is printed when it changes

- [ ] **2a.** In the round loop (`slice-run.ts:3655-3680`), keep the last printed block
  without its round number, as `lastRoundLine` does (`slice-run.ts:3606`). The key is
  the holder text plus the "waiting for it" list. Print when the key changes, or when
  `heartbeatMs` has passed since it was last printed.
- [ ] **2b.** When the lock goes from held to free and a held block was printed, print
  once:

  > [round 70] DB lock free

  Today nothing is printed when it frees. With the block printed only on change, "it
  freed" would otherwise have to be inferred from silence.

  *Proof:* **`sliceRun.test.ts`**, next to the heartbeat test (`sliceRun.test.ts:86`),
  with `SLICE_HEARTBEAT_SECONDS: "6"` and `--interval 1`:
  - a worktree claims the lock (`db-lock.sh claim`, as the lock tests do) and holds it
    for four rounds: `DB lock held by:` appears once;
  - releasing it prints `DB lock free` once.
  - A second test claims, releases and claims again, and sees the block twice.

## Phase 3 — the plan review needs two slices

- [ ] **3a.** At the top of `reviewPlan`, after the `reviewEnabled` check: if
  `landedRanges.size < 2` (set in `tryLand`, `slice-run.ts:3039`), call no agent and
  return null. Print one line:

  > plan review: skipped — one slice landed in this run (#87), and its own review covered it.

  With nothing landed, there is no line.
- [ ] **3b.** The README's review paragraph and the run header's review line
  (`slice-run.ts:3527-3536`, "plan-level review when the graph empties") gain "when two
  or more slices landed".

  *Proof:* **`sliceRun.test.ts`**:
  - Every test in "the plan-level review's outcome" (`sliceRun.test.ts:1221`) lands one
    slice today. Its `landed` helper gains a second done worktree (#41), so those tests
    keep testing the review.
  - A new test lands only #40 and sees the skip line, and the fake reviewer is never
    asked (it writes a file when called; the file must not exist). Exit 0.

## Order and cost

All three phases fit in one sitting, an hour or two each. Phase 1 has the only real
unknown, the check in 1b. Phases 2 and 3 are independent of each other and of
`docs/unattended-run-plan.md`, except that both plans edit the round loop. Land
whichever comes second on top of the first.

## Not in this plan

- **The plan review's diff covers everything on the base branch since the run
  started**, including a second dispatcher's lands and hand commits. Reviewing only
  this run's landed ranges would be more precise. That is a bigger change than this
  entry asked for.
- **`--sync-edges` following a claimed blocker's own body.** With a fresh listing it
  isn't needed: every claimant in the ready set is read.

## What the consumer does itself

- **The bump.** After Phase 1, run `--sync-edges` once after filing tickets, not twice.
