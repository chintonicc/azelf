# A tab removes only its own marker, a blocked slice can be sent back, a blip is not a failure, a session reads what its ticket names, and the two review axes run together

**Status:** not started
**Written:** 2026-11-06
**Companion:** the consumer-b friction entries since the last plan: 2026-10-31 Backend #179
(`gh` timeout, stack trace, no retry) and #180 (ticket points at a comment on another
issue); 2026-11-02 Frontend #136, twice (an old tab deletes the new session's marker; no
way to send a slice back after a BLOCK); 2026-11-06 Backend #190 (second `slice-done.sh`
loses the PID, the tab stays) and #190/#195 (landing takes long, proposes a merge train).
One entry of that day needs nothing, and the merge train is left out for now; see "Not in
this plan" and "The stacked land".

Written so it can be picked up cold. Tick the boxes as they land and add the commit hash
after the heading. Line numbers are as of `bb84762`.

## What happened

1. **An old tab deletes a newer session's marker.** `slice-session.sh:604` is
   `trap 'rm -f "$live_marker"' EXIT`, whoever wrote the file. On #136 the first session
   had said done and kept its tab; a second one started and wrote its PID; closing the old
   tab removed that marker. The next round `hasSession` saw no marker, and with an
   uncommitted tree the dispatcher opened a third session: two agents on the same
   uncommitted files, caught only because a person asked about the extra tab.
2. **Nothing stops a session starting over a live one.** The live-marker check at
   `slice-session.sh:204` is inside `if $provision`. `:603` overwrites the marker either way.
3. **A second `slice-done.sh` loses the PID.** It reads the PID from `.slice-live` only
   (`slice-done.sh:~188`), and the first run deleted that file. On #190 the land failed on
   the network, the same session made a follow-up commit and ran `slice-done.sh` again,
   which wrote an empty line 1 into `.slice-ready-to-land`. `slice-land.sh:210` read an
   empty `session_pid`, skipped `end_agent_under` and the warning, and the agent sat an
   hour in a deleted directory.
4. **A BLOCK has no way back to a session.** `autoFinished` (`slice-run.ts:3092`) is "commits
   ahead and clean", so a finished slice stays finished whatever the ticket now says. On
   #136 the review was right, the ticket was corrected, and the run gated and reviewed the
   same code against the new ticket and blocked again (`retryDue`'s `edited`, `:4523`).
   What did relaunch it was a hand-made `.slice-interrupted`, read out of the source, and
   that session got the ticket but not the finding. #190's follow-up went the same way,
   into a session that no longer had a marker, so the dispatcher did not know it was there.
5. **One failed `gh` call ends a start.** Mid-run, reads are forgiven (`refreshOpenState`,
   `noteUnreadable`, `:1701`, 30 minutes). `loadTickets` (`:6101`) has no such thing: on
   #179 an `i/o timeout` and a `connection reset by peer` each gave a stack trace from
   `slice-tracker.ts:586` and an exit, and a minute later 5 of 5 calls passed. The same
   class, elsewhere: `ciRuns` reports a network failure as "the push … was refused"
   (`slice-gates.ts:522`; #190, `Can't assign requested address`), and `slice-land.sh:326`
   says "origin refused the push", undoes the fast-forward and parks.
6. **A session cannot read what its ticket points at.** #180's ticket put deciding facts in
   a comment on another issue. The skill says not to fetch the issue
   (`agent/skills/slice/SKILL.md:13`), and `.slice-ticket.md` holds the body only.
7. **The two review axes wait for each other.** `reviewSlice` (`:2842`) runs spec, then
   standards, each a blocking `run`. Measured on consumer-b (99 spec and 98 standards
   transcripts): medians 1.3 and 1.2 minutes.

Found on the way, not from the log: **a read dir is only as fresh as its last run.** Backend
#190's review (11:20 and 12:05 on 2026-11-06) wrote `UNVERIFIED` for the frontend half of
its ticket: "the local checkout has no" screen it names. The frontend clone stood at
2026-11-02 until 12:16; that screen had been on origin since 11-04. The reader works
(Frontend #136's review compared lists in the backend clone); the checkout it reads is
stale, and only that repo's own dispatcher moves it.

## Decisions

- **A marker belongs to the PID on its first line.** The trap removes it only if that is
  `$$`, which is the log's proposal and closes the whole chain in (1).
- **Starting over a live session refuses**, in both paths, with the test `isSessionOf` uses
  (`slice-session` and this ticket on the command line, so a reused PID does not refuse).
- **`slice-done.sh` keeps the PID it already wrote.** `.slice-live`, else line 1 of the old
  `.slice-ready-to-land`. That is all #190 needs.
- **No `pgrep -f "slice-session.sh <n>"`, in the land or the dispatcher,** though the log
  proposes it twice. Ticket numbers are per repo: consumer-b has a Backend #90 and a Frontend
  #90, and that match reaches the other repo's session, where the next step is
  `end_agent_under`. The markers carry the PID; keep them correct instead.
- **`azelf relaunch <n>` is the way back, and it uses the path that exists.** It marks the
  worktree as `.slice-interrupted` does, so `runnable` opens the session and the ordinary
  prep rewrites `.slice-ticket.md`. Beyond that it removes what says "finished" and ends the
  old session, whose tab would otherwise stay, so (1) cannot begin this way.
- **The finding goes in `<worktree>/.slice-reviews/last-block.md`.** `.slice-reviews/` is
  already in the exclude block, so it is not a dirty tree and needs no new `azelf init`. The
  start prompt names it, because the skill may be an older copy.
- **Under `--auto`, editing the ticket after a BLOCK relaunches instead of re-reviewing.**
  Unchanged code against a changed ticket is what cost the round on #136. When the code was
  already right the session finds nothing to do and finishes, for a few minutes more than a
  review; when it was not, this saves the round and the hand step. It runs once per edit, so
  it cannot loop. A review that could not run (`spec.failed`) still retries as a review.
- **A BLOCK with no edit does not relaunch by itself.** See "Not in this plan".
- **Retries live in the GitHub adapter's transport**, so every call has them, and only for
  network failures read from the error text. A 404, a sign-in problem and a rate limit are
  not retried. A short breaker stops an outage multiplying by the ticket count.
- **At the start, an outage is waited out under `-y` only.** Same 30 minutes as mid-run, then
  one line and exit 75 (`EX_TEMPFAIL`, as `slice-land.sh` uses it). A person at the prompt
  gets the line at once. Everything else that throws keeps its stack: that is a bug.
- **`.slice-refs.md`, not a lint.** A lint on "Kommentar vom …" is language-bound, and a
  warning leaves the session where it was. The file is read only when the ticket points at it,
  so over-fetching costs a few `gh` calls and no context.
- **A stale read dir is exported, not moved.** A read setting does not move someone's
  checkout. `git archive <origin's head> | tar -x` into a temp dir needs no worktree
  registration and nothing to undo.
- **The two axes run through a small helper process.** `tryLand` and everything under it are
  synchronous; making them async to save 1.2 minutes per land is the wrong trade. One
  blocking call to a helper that runs N commands concurrently changes nothing around it.

## Phase 1 — a marker belongs to its session

- [ ] 1a. `slice-session.sh:604`: the trap removes the marker only when its first line is `$$`.
- [ ] 1b. `slice-session.sh:196-211`: the live-session check leaves `if $provision` and
  matches on this ticket too. Before anything in the worktree is touched.
- [ ] 1c. `slice-done.sh`: PID from `.slice-live`, else line 1 of `.slice-ready-to-land`.
- [ ] 1d. Tests: an old session's exit leaves a newer marker, and still removes its own; a
  second start refuses, and a marker whose PID is another ticket's does not; done, then done
  again, keeps the PID, and `slice-land.sh --end-session` ends that agent.

## Phase 2 — a blocked slice can be sent back

- [ ] 2a. `markForRelaunch(id)` in `slice-run.ts`: reads the PID from `.slice-ready-to-land`,
  removes it and `.slice-finished`, writes `.slice-interrupted` with first line `relaunch`
  and `.slice-retry` (so a running dispatcher un-parks it through `isParked`, then neither
  `awaitingLand` nor `autoFinished` takes it, and `runnable` does), writes or removes
  `last-block.md`, and ends the old agent if `isSessionOf` still says so (`pkill -TERM -P`,
  as `end_agent_under`).
- [ ] 2b. `last-block.md`: the last `## Attempt` of `.slice-reviews/ticket-<n>.md`, when its
  spec says `VERDICT: BLOCK`.
- [ ] 2c. `azelf relaunch <n>` / `--relaunch <n>`, before the plan loads, like `--retry`.
  Refuses, with the reason: no worktree, a hold, a git operation in progress, a live session,
  a land record. Says whether a running dispatcher has it (`liveClaim`), as `--retry` does.
  `bin/azelf.ts`, `slice-run-usage.ts`, README, `agent/commands/azelf.md`.
- [ ] 2d. `isParked`: when `due.why === "edited"`, under `autoLand`, on a BLOCK that was a
  verdict: `markForRelaunch` and a line that says so. `retryDue` stays read-only (its comment
  says why). `Parked` needs to know verdict from `spec.failed`.
- [ ] 2e. `isParked`'s line says "relaunch requested" when `.slice-interrupted` is there, not
  "retrying the land". `waysOut` and the ✗ line in `reviewSlice` name `azelf relaunch <n>`.
- [ ] 2f. `slice-session.sh`: when `last-block.md` exists, the start prompt adds: the last
  land was refused by the spec review, the finding is in that file, `.slice-ticket.md` is the
  ticket as it reads now; fix what the finding names that the ticket still asks for, and if
  nothing is left, say so and finish.
- [ ] 2g. `slice-session.sh`, the tab: a fourth way a self-landing session is over: replaced.
  `.slice-interrupted` says `relaunch`, or `.slice-live` names another PID. Exit 86, else
  every relaunch leaves a dead tab behind (the ending agent exits on a signal).
- [ ] 2h. Tests: BLOCK, edit, under `--auto`: a new session in the same worktree with the new
  ticket and the finding, no gate or review run first, then it lands. `azelf relaunch` on a
  parked slice in a running dispatcher, and with none running. Each refusal. The old session
  is ended and its tab exits 86. `last-block.md` leaves the tree clean. No BLOCK, no file.
  A `spec.failed` park, edited, reviews again.

## Phase 3 — a network blip is not a failure

- [ ] 3a. A small module with `isNetworkError(text)`: `i/o timeout`, `connection reset`,
  `TLS handshake`, `EOF`, `no such host`, `Could not resolve host`, `network is unreachable`,
  `connection refused`, `can't assign requested address` (any case), `HTTP 50[234]`,
  `The remote end hung up`, `RPC failed`. Not `rate limit`.
- [ ] 3b. `github()`: `patient(gh)` around the runner: delays 2, 8, 20 s, through a `sleep`
  option for the tests; after a run of failures, one attempt per call for 60 s. `call`
  throws `TrackerUnavailable` (exported, same message shape, so `errorLine` still works).
  Reposting is safe: `addBlocker` treats "already been taken" as success, `close` is
  idempotent, and a doubled close comment after a lost response is accepted.
- [ ] 3c. `slice-run.ts:6101`: around `loadTickets`: `TrackerUnavailable` under `assumeYes`
  says `tracker unreachable: <command> — trying again for up to 30 minutes` once, tries each
  60 s up to `trackerOutageMs`, then that line and exit 75. Without `-y`, the line and exit
  75 at once. No stack. README.
- [ ] 3d. `ciRuns`: the first `look()` and the push retry on `isNetworkError` (`ctx.exec`
  sleep). The final wording says "could not reach origin", not "refused".
- [ ] 3e. `slice-land.sh`: `git push` at `:326` and the fetch in `sync_base_with_origin` go
  through a `net_retry` helper, before the undo: two more tries, 5 and 15 s, on the same list.
  A network failure after that says so instead of "refused". Exit codes as they are.
- [ ] 3f. Tests: one table of samples run against both the TS and the bash list, so they
  cannot drift; a scripted `gh` failing twice then passing; a 404 not retried; the breaker;
  `--once -y` with the fixture's tracker down at the start, then up; ditto never up, exit 75;
  `ciRuns` with a failing first push; `slice-land.sh` with a PATH `git` that fails one push.

## Phase 4 — a session reads what its ticket names, and a review reads what is current

- [ ] 4a. Optional `Tracker.thread?(id)`: `{ title, url, body, comments: { author, at, body }[] }`;
  in `github()` `gh issue view <id> --json title,url,body,comments`, `-R` for another repo.
- [ ] 4b. `slice-config.ts --tracker refs <id>`: this ticket's own comments, then every id
  `idsIn` finds in the body except itself and its parent. One that cannot be read gets a line
  saying so. Nothing when the tracker has no `thread`. Capped: 30 refs, 256 KB, and it says so.
- [ ] 4c. `slice-session.sh`, beside the parent block (`:424`): writes `.slice-refs.md`, only
  where git ignores it, removed when empty, never fatal. `.slice-refs.md` in `EXCLUDE_BLOCK`.
- [ ] 4d. A prompt sentence only when the file exists (what `.slice-parent.md` taught us): the
  tickets and comments this ticket names are in `.slice-refs.md`; read what it points you to;
  a requirement only they state is not yours. Same in the skill, and in the spec review.
- [ ] 4e. Read dirs: `freshReadDirs()` before the spec review. For a git checkout with an
  origin: fetch; if `HEAD` has origin's head, pass it as it is; otherwise export
  `origin/HEAD` to `<tmp>/azelf-read/<repo>-<sha12>`, once per SHA in the run, removed at
  exit. The prompt says which commit it is reading. Fetch or export failing: the directory
  as it is, and the prompt says it may be behind. A non-git directory is unchanged.
- [ ] 4f. `askAgent` passes `readDirs` to every review (`:2278`), and the last plan's decision
  says spec only. Pass it for the spec review only.
- [ ] 4g. Tests: body with `#7` and `other/repo#8` writes both; an unreadable ref does not
  stop the prep; no `thread`, no file; not ignored, no file and the hint; the prompt sentence
  follows the file. A read dir behind origin reaches the agent as the export and level as
  itself; the argv of the standards review has no `--add-dir`.

## Phase 5 — the two axes run together

- [ ] 5a. `scripts/slice-par.ts`: takes `{ cwd, timeoutMs, commands }` as JSON, runs them
  concurrently, prints `[{ ok, out, status }]`. No knowledge of reviews.
- [ ] 5b. `reviewSpec` and `reviewStandards` split into prompt and reading of the answer;
  `reviewSlice` asks both through one `askAgents`. Reports, order in the file and verdict as
  they are. `reviewPlan` keeps `askAgent`.
- [ ] 5c. Tests: the fake agent sleeps and both end in under the sum; one axis failing leaves
  the other's report; a timeout. Fixture tests that assert the order of agent calls will need
  reading by prompt rather than by position.

Expected: the median review from about 2.5 to about 1.3 minutes, on every land in both repos.

## Order and cost

Phase 1 first and alone: three small edits, and it closes the one failure in this list that
put two agents on the same files. Phase 2 is the largest and depends on it. Phases 3, 4 and 5
are independent of everything; 3 is medium, 4 small to medium, 5 small. One commit each.

## The stacked land: decided, not now

The #190/#195 entry proposes a merge train: stack the finished slices, run the suite and CI
once on the top, push once. Two things in it are not as the entry assumes, and the numbers
are smaller than its example.

- **Reviews do not run in parallel today**; they are serial inside `tryLand`. So the
  estimate of (N−1) × 7 min excludes them, and to get them concurrent across slices is more work.
- **#190 is the expensive end.** Its spec review, 4.3 minutes, is the longest of 99.

Measured on consumer-b, 2026-10-22 to 11-06, from the last commit's author time to the
ticket's `closedAt`, without outliers over two hours. It undercounts a slice that went back
for a follow-up, #190/#195 among them.

| | tickets | median to closed | landed in overlap | extra tickets (N−1) |
| --- | --- | --- | --- | --- |
| Backend (suite + CI) | 27 | 12.7 min | 14, in 4 groups | 10 |
| Frontend (one gate, no CI) | 46 | 5.8 min | 14, in 5 groups | 9 |

So on the backend at most 10 × 6:45 ≈ 70 minutes in 15 days; closer to 40, because one group of
5 parked on a shared-budget guard and would have fallen back to serial. On the frontend, at
most one suite run per extra ticket. Add fewer deploys, which is real and not measured. The
cost is in `slice-land.sh` and `tryLand`, the part of azelf with the longest bug history
(`stale-base-plan.md`, `resolve-and-report-plan.md`).

**Decided 2026-11-06: not now.** Phase 5 gives both repos a saving on every land, away from the
land path, and bundling small related tickets into one slice, as the entry itself says, helps
today. Build it when waves of three or more ready at once on a CI-gated repo become routine,
or when the deploy count starts to cost something.

If it is built, what the thinking so far has settled:

- **Pairwise disjoint files only.** Disjoint slices cannot conflict, so there is no resolver in
  the stack, and each review stays true of the rebased diff. A slice that overlaps waits for
  the next round and lands the ordinary way.
- **Stack the real branches, in their own worktrees** (B onto A, C onto B), and gate in the
  top's worktree. No helper branch. Record every head first: on red, reset each branch to its
  recorded head. A plain rebase onto base would carry a dropped slice's commits along.
- **`GateOptions.perSlice`** for the zone gate, so a break is attributed to the slice; every
  other gate runs on the top.
- **`slice-land.sh` on the top pushes; the others finish through the land record**
  (`azelf-landed-<n>.txt`, `finishing`, `:110`), each with its own SHA. `afterLand` once.
- **No bisect at first.** Red goes back to serial.
- **A side benefit:** a suite on the stack catches what is green alone and red together, the
  shared-budget case, which `stale-base-plan.md` declined as a separate probe merge.

## Not in this plan

- **Backend #195, the suite red through a linked `.env`.** Fixed on the consumer's side on
  2026-11-06: its `install` no longer links the file, so the gate computes as CI does.
- **Relaunching on a BLOCK without an edit.** One automatic round with the finding is the
  natural next step and could fix a BLOCK unattended. See how the hand path goes first.
  `resolver-and-refresh-plan.md` declined a round like it for the resolver, as a person's call.
- **A session told to continue after `slice-done.sh`.** It has no marker, and a retried land can
  start under it. `azelf relaunch` is the supported way; nothing here reclaims a marker.
- **`SLICE_SESSION_PID` in the environment.** Keeping the marker is enough for what was seen.
- **Older log entries.** All decided: `landRequiresApproval` (`findable-and-finished-plan.md`),
  `serializePaths`, the probe merge and the `merge-tree` dry run in `slice-done.sh`
  (`stale-base-plan.md`).

## What the consumer does itself

- consumer-b: pull azelf-run and run `azelf init` in both clones, for the exclude entry and the
  skill. Exit 75 is new for a wrapper that restarts a run.
- consumer-a: bump the pin and run `azelf init`.
