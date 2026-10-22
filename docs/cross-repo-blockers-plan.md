# A blocker in another repo is read as one, and waited on

**Status:** plan, nothing built · **Written:** 2026-10-22
**Companion:** `docs/non-bun-consumer-plan.md`, whose "Not in this plan" listed
"blockers across two repos". consumer-b has two repos, a backend and a frontend, with
one dispatcher each. A frontend ticket that needs a backend endpoint is blocked by a
backend ticket.

Written so it can be picked up cold. Tick the boxes as they land and add the commit hash
after the heading. Line numbers are as of `ffca576`.

## What happened

1. **GitHub records the edge, and azelf misreads it.**
   - GitHub's issue dependencies cross repos. "Blocked by" on a frontend issue can name a
     backend issue, through the UI or the API.
   - `github().blockers(id)` (`slice-tracker.ts:632`) asks
     `repos/{owner}/{repo}/issues/<id>/dependencies/blocked_by` and keeps
     `{number, state}`. Each item also carries `repository_url`, checked on consumer-b's
     backend on 2026-10-22:
     `{"number":139,"repository_url":"https://api.github.com/repos/<owner>/<backend>","state":"closed"}`.
     azelf drops that field.
   - So a frontend ticket blocked by backend #140 reads as blocked by **frontend #140**.
     The state is the backend issue's, read correctly, but the id is wrong.
2. **What the wrong id does in the dispatcher.**
   - If frontend #140 is in the run, the edge lands inside the run's own graph. The wave
     order follows a dependency that does not exist, and the real one is gone.
   - If it is not in the run, it is a foreign blocker (`slice-run.ts:448`). Every round
     re-reads it with `tracker.get("140")` (`slice-run.ts:1308`), and that reads
     **frontend** #140. When that one is closed, or does not exist, the hold lifts while
     the backend ticket is still open, and the frontend slice starts too early.
   - `slice-session.sh` only counts open blockers (`--tracker open-blockers`). It counts
     right, because the states are right. The dispatcher decides first, though.
3. **Body claims misread it too.**
   - `idsIn` (`slice-tracker.ts:240`) matches `#(\d+)\b`. Inside
     `<owner>/<backend>#140` it finds `#140` and reads it as this repo's #140.
   - A `## Blocked by` section that names the backend issue is therefore a claim on
     frontend #140, and that claim has no edge. A closed frontend #140 is dropped
     silently. An open one, or one that cannot be read, makes `refuseOverBodyBlockers`
     refuse the dispatch, and `--sync-edges` would write the wrong edge.
4. **The waiting itself already works.**
   - A foreign blocker holds its ticket, and every round re-reads its state. Nothing
     ends the run while one is open: the run's three stops are all parked, waiting on a
     human, and a full disk (`slice-run.ts:5691`, `:5727`, `:5768`).
   - So once the id is right, a backend land closes the backend issue. The frontend
     dispatcher reads it as closed in its next round and starts the slice. No channel
     between the two dispatchers is needed: the issue's state is the channel.

## Decisions this plan makes

- **A ticket in another repo has the id `owner/repo#n`.**
  - That is GitHub's own cross-repo reference, and it is what a person types.
  - It never matches `idPattern` (`^[0-9]+$`). So it is never in the run's set, never a
    branch, never launched, and never closed by this dispatcher. It is always a foreign
    blocker. Nothing in the round loop needs a new case.
  - A blocker in the same repo stays a bare number, as today.
- **The tracker decides what "another repo" is.**
  - `github()` compares each blocker's `repository_url` with its own repo. It reads its
    own repo once per process with `gh repo view --json nameWithOwner`, through the same
    `cwd` as every call, and compares case-insensitively.
  - `get(id)` takes both forms. For `owner/repo#n` it runs
    `gh issue view n -R owner/repo`.
  - The `Tracker` contract says so: `blockers()` may return ids outside `idPattern`, and
    `get()` must read every id `blockers()` returns. A custom tracker that has no other
    projects returns none and changes nothing.
- **`ref()` prints such an id as it is.**
  - `refTemplate` (`#{n}`) applies only to ids that match `idPattern`, so the display
    is `<owner>/<backend>#140`, not `#<owner>/<backend>#140`.
  - The shell's `slice_ref` only ever refs this repo's tickets and does not change.
- **The dispatcher waits, and says so.**
  - The plan marks the edge `(in another repo)` instead of `(outside this set)`.
  - When open tickets are held only by blockers in other repos, the round line says
    what it waits for, instead of "land one to advance", which no land here can do.
  - It does not exit. The other repo's dispatcher closes the blocker when it lands it,
    and this one starts the slice in the round after. Ctrl-C ends the wait, as today.
- **Body claims read the qualified form.**
  - `idsIn` reads `owner/repo#n` as that qualified id, and no longer as `#n`. The
    missing-edge check then compares like with like.
  - A body claim without an edge is reported as today. `--sync-edges` can write it,
    because the endpoint takes a blocker from another repo. `addBlocker` resolves the
    internal id under that repo's path (`repos/owner/repo/issues/n`), never under this
    one's. The comment at `slice-tracker.ts:699` explains what goes wrong otherwise.

## Phase 1 — the edge is read as it is, and waited on

- [ ] 1a. `github()`
  - `blockers()` keeps `repository_url` and returns `owner/repo#n` for another repo.
  - `get()` reads both forms.
  - The own repo is read once, lazily, and only when a blocker comes back.
- [ ] 1b. The `Tracker` contract in `slice-tracker.ts`'s header and on `Blocker`, plus a
  helper `isOwnId(id, idPattern)` that `ref()` and the round loop share.
- [ ] 1c. The dispatcher
  - `ref()` leaves a foreign id alone.
  - The plan line says `(in another repo)`.
  - The round line names the other repo's blockers when nothing else can move.
- [ ] 1d. README: a subsection under "Tracker" on blockers in another repo.
  - What the edge looks like and how to set it in GitHub.
  - That the dispatcher waits and starts the slice after the other land.
  - That a cycle across the two repos waits forever: neither dispatcher can see it.
- [ ] 1e. Tests
  - The tracker, with a scripted `gh`:
    - a blocker in the same repo stays `"139"`;
    - one in another repo becomes `owner/repo#n`;
    - the own repo is read once per process, not once per call;
    - `get("owner/repo#7")` passes `-R owner/repo`.
  - The dispatcher, with the fixture tracker. The fixture's `blockedBy` takes any id,
    so `"acme/web#7"` works.
    - A ticket blocked by `acme/web#7` while it is open does not start, and the plan
      says `(in another repo)`.
    - The round after the fake closes it, the ticket starts.
    - The test that would have caught the bug: a ticket in the set with the **same
      number** as the foreign blocker stays unrelated. No wave order and no early start
      come from it.

## Phase 2 — body claims and `--sync-edges` across repos

- [ ] 2a. `idsIn` reads `owner/repo#n` as one qualified id, and never as `#n`.
  `blockersFromBody`, `blockerLine` and `bodyOnlyBlockers` follow.
- [ ] 2b. The tracker's `addBlocker(id, "owner/repo#n")` resolves the internal id under
  `repos/owner/repo/issues/n`.
- [ ] 2c. Tests
  - `## Blocked by\n- <owner>/<backend>#140` claims `"<owner>/<backend>#140"`, not
    `"140"`.
  - A claim that matches a qualified edge is not missing.
  - `--sync-edges` writes the edge with the other repo's internal id.
  - A bare `#140` next to it still reads as this repo's #140.

## Order and cost

Phase 1 first. It fixes the misread, and the dispatcher then waits correctly; nothing
else is needed for consumer-b to use the edge. Expect two files of code
(`slice-tracker.ts`, `slice-run.ts`), the README subsection and about eight tests.

Phase 2 matters once ticket bodies name blockers in the other repo. A ticket-writing
skill does that. Until then, Phase 1 alone is consistent: a body that names another
repo's issue is misread exactly as it is today, and Phase 1 adds no new case of it.

## Not in this plan

- **One dispatcher for two repos.** Each repo keeps its own, with its own worktrees and
  gates. The issue state carries the dependency.
- **Detecting a cycle across repos.** Each dispatcher sees only its own graph.
- **Waking the other dispatcher.** It finds out on its next round, which is at most
  `--interval` later.
- **Trackers other than GitHub.** The contract allows a foreign id; only `github()`
  produces one.

## What the consumer does itself

consumer-b (the mapping is in `CONSUMERS.local.md`):
- Sets the cross-repo edge in GitHub: "Blocked by" on the frontend issue, naming the
  backend issue.
- Runs both dispatchers, or at least the one whose land unblocks the other.
- Pulls `azelf-run` after Phase 1. Neither config changes.
