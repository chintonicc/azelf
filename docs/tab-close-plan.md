# Closing the tab of a landed `--auto` slice

**Status:** LANDED 2026-09-23 · **Written:** 2026-09-23
**Companion:** `README.md` "A finished `--auto` slice closes its own tab",
`scripts/slice-session.sh` "Closing the tab", `scripts/slice-autostart.sh` header.

Written so it can be picked up cold. One phase, four items, each says what to change,
where, why, and what proves it. Tick the boxes as they land and add the commit hash
after the heading.

## What happens today

Under `--auto`, `slice-session.sh` exits **86** when the session ran with `--self-land`
*and* the agent exited cleanly (`slice-session.sh:466`). The autostart hook ends the tab's
shell on that status (`slice-autostart.sh:41`), and Warp closes a tab whose shell has
died. That is the whole mechanism, and it is correct as far as it goes.

It does not go far enough, because **exit 86 needs the agent process to end, and a Claude
session that has finished routinely sits at its REPL.** On one three-slice `--auto` wave
all three slices ran `slice-done.sh`, all three landed, and all three tabs were still open
an hour later, rooted in worktrees the dispatcher had already deleted. `slice-land.sh`
already notices this: it reads the session's pid from line 1 of `.slice-ready-to-land`,
checks with `ps` that the pid is still a slice session (`slice-land.sh:253`), and prints
*"the session for #18 is still running (pid 53049) … Nothing is lost — close that tab."*
The human then closes it by hand, once per slice, which is the step this plan removes.

Warp offers no close-tab URI, and an AppleScript keystroke lands on whichever tab has
focus. The process route is the only reliable one: end the agent, let the shell exit.

## Design

**End the agent after the land, in exactly the case where nothing is lost, and let the
existing exit-86 path do the rest.** Nothing new reaches the terminal; the two guards the
README states stay intact:

- **`--auto` only.** Without it a human is reading the tab and lands by hand, so the
  dispatcher's flag is never passed and no session is ever ended.
- **A crash still keeps its tab.** The new exit-86 condition is not "the agent died"; it is
  "the worktree this session was rooted in is gone". A worktree is removed only by a land
  that has already pushed, so a gone worktree is proof there is nothing left in the tab
  worth reading. An agent that dies for any other reason leaves its directory in place and
  its tab open, exactly as now.

**Order matters, and it is remove-then-end.** `slice-land.sh` removes the worktree first
(as it does today), and only then ends the agent. The other order races: the moment the
agent dies, `slice-session.sh` resumes and tests whether its directory still exists, and a
removal still in flight would read as "present" — the session would exit with the agent's
signal status and keep the tab. If `git worktree remove` refuses (modified or untracked
files, usually something still running in there), the agent is **not** ended: the
directory is staying, the refusal is printed with the by-hand command as now, and a
killed agent would only make that tab harder to read.

Non-goals: no change to the hook (v3's `exit` on 86 is enough); no closing under `tmux()`
or `manual()` beyond what already happens (the pane's command ends; 86 at your prompt);
no attempt to close a tab whose session was never a slice session.

## Phase 1 — end the agent, exit 86 on a gone worktree

- [x] **1a. `slice-land.sh --end-session`.** A flag, off by default. In the cleanup
  block, inside the `if git worktree remove …` success branch (`slice-land.sh:248`), after
  the existing "still running" report: when the flag is set and the pid passed the `ps`
  check, end the agent under that session. The pid is the `bash` running
  `slice-session.sh`; the agent is its child, so `pkill -TERM -P "$session_pid"`. Wait up
  to five seconds for the children to go (`pgrep -P` in a loop), then `pkill -KILL -P` as
  the fallback. Print one line either way: *"ended the agent in that tab — the session
  exits and the tab closes"* or *"could not end pid … — close that tab yourself"*. Never
  fatal, same rule as everything else in the cleanup. Under `wrapCommand` the direct
  child may be a wrapper rather than the agent; TERM to the wrapper is the right signal
  and the KILL fallback covers a wrapper that does not forward it — say so in the comment.
  *Proof:* the test in 1c.

- [x] **1b. `slice-session.sh`: exit 86 when the worktree is gone.** At the block starting
  `slice-session.sh:466`, the condition becomes: `--self-land` *and* (the agent exited 0
  *or* `[[ ! -d "$worktree_path" ]]`). Rewrite the "TWO CONDITIONS" comment above it: the
  second condition is now "the agent exited cleanly, or its worktree was landed and
  removed out from under it", and the reason a crash still keeps the tab is that a crash
  leaves the directory in place. Print which of the two fired, so the tab's last line
  (the one nobody reads, under `--auto`) still says why it closed.
  *Proof:* the test in 1c.

- [x] **1c. The dispatcher passes the flag under `--auto`.** `tryLand`
  (`slice-run.ts:1524`): `["./scripts/slice-land.sh", t.id, ...(autoLand ? ["--end-session"] : [])]`.
  Nowhere else — the manual land path and `--gates` never end a session.
  *Proof:* `tests/scripts/sliceSessionClose.test.ts` on `makeConsumer` from
  `tests/scripts/fixture.ts`, with one addition to the fixture: an `agent?: string[]`
  option that writes `agent: custom({ name: "fake", sessionCommand: [...] })` into the
  generated `slice.config.ts` (`custom` is exported from `index.ts`; check
  `SLICE_AGENT_SESSION_CMD` reaches the shell through `--sh` for it). The test:
  1. `makeConsumer({ worktrees: [40], remote: true, agent: ["sleep", "300"] })`.
  2. Start `./scripts/slice-session.sh 40 --self-land` in the background from the main
     checkout with `spawn` (not `sh`, which waits), capturing its exit code; poll for
     `.slice-live` in the worktree.
  3. In the worktree: commit a file with `git`, run `./scripts/slice-done.sh`.
  4. From main: `./scripts/slice-land.sh 40 --end-session`. Assert the output contains
     "ended the agent", the worktree directory is gone, and `pgrep -f "sleep 300"` finds
     nothing.
  5. Await the background session: exit code **86**, output contains the
     "worktree was landed and removed" line.
  6. A second test: same setup, land **without** the flag; assert the sleep is still
     running, the session has not exited, then kill it yourself. That is the manual-land
     guarantee.
  7. A third: `--self-land`, no land at all, kill the sleep by hand; assert the session
     exits with the signal status, not 86, and the worktree still exists. That is the
     crash guarantee.
  Under `manual()` (the fixture's default launcher) flags travel on the command line,
  so `--self-land` needs no `.slice-flags` file; the test never touches the hook.

- [x] **1d. README.** In "When the agent does not exit, and it often does not": the
  paragraph now ends with what the dispatcher does about it under `--auto` (removes the
  worktree, ends the agent, the session exits 86, the tab closes), and keeps the two
  guards. One sentence in the `slice-autostart.sh` header saying 86 can now also mean
  "landed out from under me". Keep it to the length of what is there now.

## Landed

`c4e452c` (1a+1b+1c, with the test) and the docs commit (1d). Deviations:

- **Only a session that declared done is ended.** 1a said "the pid passed the `ps`
  check"; `slice-land.sh` also requires the `.slice-ready-to-land` marker, because a
  session that never ran `slice-done.sh` is being landed out from under it and its
  tab may hold the only explanation. Under `--auto` that case does not arise (the
  dispatcher never lands an occupied slice); a fourth test pins it anyway.
- **The fixture now writes the `init` exclude block** into every temp consumer's
  `.git/info/exclude`. Without it `.slice-ticket.md` and `.slice-live` are untracked,
  `git worktree remove` refuses, and the land never reaches the end-session step —
  which is also what a real consumer without `init` would see.
- **The fake agent is `bash -c "exec sleep <n>"`,** not `sleep 300`: the session
  appends the start prompt to the agent's argv, which `sleep` rejects and `bash -c`
  puts in `$0`. `<n>` is random per test, so `pgrep -f` finds only its own.
- **`vitest.config.ts` sets `testTimeout: 30_000`.** The script tests run at one to
  three seconds alone and hit the 5s default once they ran next to a file that
  launches real sessions.
- A fifth test: `slice-land.sh` rejects an unknown flag and a second ticket id, now
  that it parses arguments.

Not yet seen: Warp closing the tab. That is the dry run in the last section.

## Order and cost

One afternoon. 1a and 1b are independent and about ten lines each; 1c is one line plus
the test file and the fixture option, which is where most of the time goes. Land 1a+1b+1c
as one commit — the test needs all three — and 1d as a second.

## What this does not fix

A session whose agent exited **non-zero** before any land, and a slice landed **by hand**
without `--auto`, both keep their tabs on purpose. A tab that Warp opened but whose hook
never ran (the "never came up" case in the dispatcher) has no slice session to end and is
untouched. Verifying that Warp actually closes the tab is a dry run on consumer-a: one
`--auto` slice, watch the tab go.
