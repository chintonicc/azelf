# A landed slice closes its tab in every mode, a moved box is not a new one, the parent in the consumer's words, and a run over one parent

**Status:** proposed, nothing landed
**Written:** 2026-11-25
**Companion:** the open entries of both friction logs:
- consumer-a, 2026-11-24: "a slice landed through slice-done.sh leaves its tab (and sometimes its
  session) open". Covered by Phase 1.
- consumer-a, 2026-11-25: "a land's 'carried unticked checks' comment picks up another ticket's
  journey". Covered by Phase 2.
- consumer-b, 2026-11-22, "Backend #248 · slice": the start prompt says to read `.slice-parent.md`
  and also that there is none. Covered by Phase 3.
- consumer-b, 2026-11-22, "Backend · dispatcher": a wave selected by one tracking issue, with
  tickets labelled later picked up. Covered by Phase 4.

consumer-b's other entries are either done or not azelf's to fix. The 11-22 `bunx azelf` entry is
covered: `./scripts/azelf` has been in both of its clones since 2026-10-30, and no doc names
`bunx azelf`. The 11-22 #246 entry is about how the consumer cuts its tickets.

Written so it can be picked up cold. Tick the boxes as they land and add the commit hash after the
heading. Line numbers are as of `8d1cb09`.

## What happened

1. **A manual land left all five tabs open.** consumer-a ran `azelf run --review -y` without
   `--auto`. Each slice was declared done with `./scripts/slice-done.sh` and landed by the
   dispatcher. Each ticket was closed and each worktree removed, but every Warp tab stayed open.
   Four held a bare shell in a deleted directory. In the fifth (#230), `claude` was still running
   at its prompt. The person expected "done" to close the tab, as an `--auto` land does.

   Why: the tab-close plan made closing `--auto`-only on purpose. `slice-run.ts:5886` and `:7529`
   pass `--end-session` only under `autoLand`. `slice-session.sh:905` exits 86 on a gone worktree
   only under `--self-land`. The reason given was that "without --auto a human is reading the tab".
   That holds until the human releases the slice. After `slice-done.sh` and a land, the tab is in
   a directory that no longer exists, and nothing in it is left to come back to.
   `slice-land.sh:626` already ends only a session that declared done, so it would not cut short
   a session that is still working.

   There are two different states:
   - **The agent is still in its REPL (#230).** `--end-session` plus exit 86 handle this case, as
     they do under `--auto`.
   - **The agent had already exited, and the shell is at a prompt (the other four).** This state
     cannot be fixed from outside. `slice-session.sh` returned before the land, and the hook
     (`slice-autostart.sh:73`) exits the shell only on 86. What is left is an interactive shell
     that nobody tells anything.

2. **A docs commit that moved boxes carried another ticket's checks into the comment.** #231's
   branch had a hand-made commit (`1c72ca0a`) that moved Journeys 175 and 178 into their sections
   of the testing doc. J178 belonged to #233, which had landed already. `slice-land.sh:153-160`
   takes every `+- [ ]` line of `base...branch` as a box "this slice added". A moved line is `+` in
   one place and `-` in another, so #231's closing comment listed J178's boxes. The plan review
   noticed it.

3. **The start prompt contradicts itself on a ticket without a parent.** consumer-b's `startPrompt`
   is in German and says that the tracking ticket is in `.slice-parent.md`, to read it, and that
   it takes precedence over this prompt. It does not use `{parent}`. `slice-session.sh:749-750`
   therefore appends "This ticket hangs under no spec: there is no .slice-parent.md" whenever the
   file is missing. The session received both statements. azelf already has `{parent}` for this
   (`slice-config.ts:364-372`), but the sentence it puts there is fixed English. A consumer that
   wants its own wording ("read it, then the sources it names, then CLAUDE.md"), or its own
   language, has no place to put it.

   The ticket had no parent file because consumer-b's tickets say "Teil von #206" in their first
   line. They have no `## Parent` section and are not sub-issues. azelf does not read that line as
   structure, and it should not: it is a mention like any other.

4. **A wave could only be started by listing its tickets.** Without ids, `azelf run --auto` would
   have taken every `ready-for-agent` ticket, including two older ones (#198, #244) that did not
   belong to the wave. The wave's tickets were linked only by one tracking issue (#206). The ids
   were passed by hand, so tickets of the wave labelled later needed a new run. The set is read
   once in either case (`loadTickets`, `slice-run.ts:470`). The round loop re-reads the state of
   the tickets it has (`refreshOpenState`, `:1888`) and never reads new ones.

## Decisions

- **Once a land has gone through, a session is ended in every mode.** The dispatcher passes
  `--end-session` to every land it makes. The guard that protects a session stays where it is:
  `slice-land.sh` ends only a session whose `.slice-ready-to-land` it read, after the removal
  succeeded. Without `--auto` that marker is the person's release, so the report has been read by
  then. Losing the tab does not lose the conversation, because the agent keeps its own history.
  A hand `slice-land.sh` still ends nothing without the flag. A person landing by hand is reading
  that tab.
- **A gone worktree closes the tab without `--self-land` too.** In `slice-session.sh`, the "worktree
  was landed and removed" condition (`:905`) loses its `$self_land`. The others keep it:
  - A clean exit is still `--self-land` only. A person who quits the agent in a manual run wants
    the shell.
  - So are the lock wait and the relaunch: both start a new session, and that only happens under
    `--auto`.

  A worktree is removed only by a land that has already pushed, or by a person. In either case
  nothing in the tab can still act on it.
- **A shell left at a prompt closes itself once its worktree is gone. This needs zsh, and Warp must
  be shown to support it first.** When `slice-session.sh` returns anything other than 86, hook v5
  sets a watch for that tab only: `TMOUT=15` and a `TRAPALRM` that runs `exit` once `$PWD` is
  still inside the slice's directory and that directory no longer exists. zsh runs the trap only
  while the shell is idle at its prompt, never during a command. A person who `cd`s out of the
  worktree keeps the tab. The watch is not set if the shell already has a `TMOUT` or a
  `TRAPALRM`; some prompt themes use one for a clock. bash gets nothing new: its `TMOUT` means
  logout, and it has no idle trap.

  **The open question is Warp.** Warp runs its own input editor over zsh, and it is not known
  whether zsh's alarm fires while Warp waits for input. 1c checks that first on a real tab. If the
  alarm does not fire, the fallback is a `precmd` check: the tab closes on the next Enter, and the
  line the session prints says so.
- **Moved boxes are subtracted from added ones, and nothing more.** An unticked box that is `+` in
  the slice's diff and `-` somewhere in the same diff, with the same text after trimming
  whitespace, was there before the slice. It is not counted. Each `-` cancels one `+`, so when a
  slice adds a second copy of an existing box, one copy is still counted. A box whose text the
  slice rewrote still counts as added, because its text is new. Attributing boxes to the journey
  heading's own ticket ("#233" in "built …, #233, …"), as the entry suggested, is not planned. That
  heading format is one consumer's convention, and diff arithmetic fixes this case without it.
- **`{parent}` takes the consumer's words.** A new optional key, `startPromptParent`, sets what
  `{parent}` becomes when the worktree has `.slice-parent.md`. The default is today's English
  sentence. Like `startPrompt`, it goes through the bridge as one string, `SLICE_START_PROMPT_PARENT`.
  The no-spec case needs no consumer text: a prompt that uses `{parent}` says nothing when there is
  no parent.
- **A prompt that names `.slice-parent.md` outside `{parent}` gets a warning, not a refusal.**
  The run's preamble prints it next to the config line (`slice-run.ts:7424`), once:
  "⚠ startPrompt names .slice-parent.md but has no {parent}: a ticket without a parent spec is told
  both to read it and that it is not there. Move that sentence into startPromptParent and put
  {parent} where it was." A refusal would stop a running consumer at its next restart over a
  wording issue.
- **`--parent <id>` selects a wave, and it is re-read every round.** The run's set becomes the
  tickets with the ready label whose parent is `<id>`. "Parent" means what it already means in
  azelf: the tracker's native children (`children()`, sub-issues on GitHub), or a `## Parent`
  section naming `<id>` (`parentFromBody`, `slice-tracker.ts:442`). The parent itself is never a
  slice. At the top of each round, after `refreshOpenState`, the set is read again. A new child
  joins with one line, gets its wave, and is claimed. If another dispatcher holds it, that is said
  once and the child is skipped. The run does not stop over it.
  - **Not with ids.** `--parent 206 247 248` is two answers to "which tickets", so it is refused
    with exit 64.
  - **Not a bare run.** A bare run keeps its confirmed set. Picking up every newly labelled ticket
    there would pull in tickets nobody planned for this run, which was the problem in this entry.
  - **A ticket that does not belong is remembered.** A ready ticket whose body names no such
    parent is not read again during the run. One API call per round stays one call. A body that
    gains `## Parent` mid-run is missed until the next run, which is accepted and said in a
    comment.
  - **The cap follows the tree.** Without `--max`, the session cap is the starting tree's width
    (`slice-run.ts:7292`). Under `--parent` it is recomputed when a child joins, so a wave that
    started with one ticket does not run the rest one at a time.
  - **The resume command keeps `--parent` and drops the ids.** The set is re-read, so ids would
    only be refused.
  - **A child that loses the ready label before it starts leaves the run.** One that has started
    stays.
- **`--label` is not built.** `--parent` covers the case, and the tracker already models parents.
  A wave label would be a second way to say the same thing.

## Phase 1 — a landed slice closes its tab in every mode

- [x] 1a. `slice-run.ts`: pass `--end-session` at both land calls (`:5886` in `tryLand`, `:7529`
  when finishing an interrupted land), whatever the mode. Rewrite the comment above `:5882`:
  `slice-land.sh` ends only a session that declared done, and without `--auto` that declaration
  is the person's release. Update the `slice-land.sh` header (`:543`) to match: the flag is passed
  by every dispatcher land, and a hand land without it still ends nothing.
- [x] 1b. `slice-session.sh:905`: the gone-worktree exit-86 drops `$self_land`. The comment block
  (`:867-898`) gets the reason: once the release and the land are done, the person has read the
  tab. Under `manual()` the 86 shows up at the person's prompt with the line above it, as under
  `--auto`.
- [x] 1c. Before writing any code, check whether `TRAPALRM` fires in Warp. Open a test tab with
  `open "warp://action/new_tab?path=<dir>"`, set `TMOUT=5` and a `TRAPALRM` that writes a file,
  leave the tab idle, and check whether the file appears. Write down what Warp does in this plan.
  **Seen 2026-11-25:** it fires. The check used a launch configuration rather than a new tab,
  because its `exec:` can set the trap in the interactive shell. The alarm fired every 5 seconds
  at the idle prompt. Once a `stop` file was there, the trap's `exit 0` ended the zsh, and Warp
  closed the window ("WindowId(1) will close" in `~/Library/Logs/warp.log`). No precmd fallback
  is needed.
- [x] 1d. `slice-autostart.sh` becomes v5. In `_slice_autostart_run`, after a non-86 return and
  only under zsh, set the watch: `_slice_gone_watch_dir=$_slice_dir`, a `TRAPALRM` that runs
  `exit 0` when `$PWD` is under that directory and the directory is gone, and `TMOUT=15`. Both
  are set only when neither exists already. If 1c showed that the alarm does not fire under Warp,
  use a `precmd_functions` entry with the same test instead. Either way, `slice-session.sh` prints
  one line when it returns non-86 in a manual run: "this tab closes by itself once the slice lands"
  (with the alarm), or "… on the next Enter after the slice lands" (with precmd).
  **As built:** the hook prints the line, not `slice-session.sh`, because only the hook knows
  that it set the watch (zsh, no `TMOUT` or `TRAPALRM` before). The watch also leaves alone a
  shell with a job running. zsh would refuse the first `exit` there and allow the second, which
  would kill someone's job. Once the directory is gone and the shell is somewhere else, the watch
  sets `TMOUT=0` and has nothing left to watch.
- [x] 1e. Tests (`sliceSessionClose.test.ts`):
  - Without `--self-land`, the session exits 86 when `slice-land.sh --end-session` removes its
    worktree.
  - Without `--self-land`, a clean agent exit with the worktree still present returns 0, as today.
  - The dispatcher's manual-mode land passes `--end-session` (`sliceRun.test.ts`: a fake
    `slice-land.sh` records its argv).
  - The test "without --end-session the agent is left alone" stays, and its name says that it
    covers a hand land.
  - For the hook: `hookBlock()` carries v5, and `azelf init` reports a v4 block as older. Test the
    alarm watch by running `zsh -i` under `script -q /dev/null` with the hook in a temporary
    `ZDOTDIR`. The shell should exit once the directory is removed and stay up while it exists.
    If `script` turns out too flaky on CI, drop that test and let 1c's Warp check be the proof.
    **As built** (`sliceInit.test.ts`, "a landed slice's idle tab"): `sh -c 'cat | script …'`,
    because macOS `script` refuses a socket for stdin. `TMOUT=15` is cut to 1 in the test's copy
    of the block. The tests cover an exit outside Warp and an exit from precmd under Warp. They
    also check that the shell is kept after a `cd` out, with a job running, and when `TMOUT` was
    already set. The dispatcher test uses a session whose agent is a single `sleep`, and checks
    that "ended the agent in that tab" is printed without `--auto`.
- [x] 1f. README: "A finished `--auto` slice closes its own tab" becomes "A landed slice closes its
  own tab", covering both modes and the hook version. The `/azelf` command
  (`agent/commands/azelf.md`) loses any line that says tabs stay open without `--auto`.
  **As built:** the command doc had no such line. The `azelf run --help` text for manual mode
  now says that the land closes the slice's tab.

## Phase 2 — a moved box is not one this slice added

- [x] 2a. `slice-land.sh:153-160`: read the `-` unticked boxes of the same `base...branch` diff as
  well. Each `+` box is checked against the `-` boxes, with whitespace trimmed on both sides, and
  each `-` cancels at most one `+`. Do it in awk, in one pass over the diff, keeping the order of
  the `+` lines. The `LAND_NOTES_MAX` cut and the count line apply to what is left.
- [x] 2b. The comment above it (`:129-150`) says that a moved box is not new, and that a box the
  slice rewrote still counts.
- [x] 2c. Tests (`sliceLand.test.ts`), each with a temp consumer whose base has a doc with boxes:
  - A slice that adds two boxes gets both in the close comment.
  - A slice that moves an existing block of boxes to another section gets none, and the comment
    has no "Still to check" part.
  - Moving and adding in one branch gets only the added boxes.
  - A box that is duplicated gets one.
  - A box the slice ticks is not listed (it never was).

  **As built:** the two tests with a move fail on the old script and pass on the new one. The
  README section "A landed ticket carries its leftover checks" now explains moved boxes.

## Phase 3 — `{parent}` in the consumer's words, and a warning when it is missing

- [x] 3a. `slice-config.ts`: `startPromptParent?: string` next to `startPrompt` (`:373`). Its doc
  comment says when it is used and that the default is the English sentence. An empty string is
  refused, because `{parent}` would then disappear for tickets that do have a parent. The bridge
  (`:1032`) writes `SLICE_START_PROMPT_PARENT`, using the default when the key is not set.
  **As built:** when the key is left out, the bridge writes an empty value and `slice-session.sh`
  supplies the default (`${SLICE_START_PROMPT_PARENT:-…}`). The sentence lives in one place, and a
  bridge that predates the key gets the same result. `{n}` is substituted in the consumer's
  sentence too.
- [x] 3b. `slice-session.sh:736-740`: `parent_sentence` comes from `SLICE_START_PROMPT_PARENT`, and
  falls back to the current sentence if an older bridge lacks it (as `SLICE_AGENT_SESSION_CMD` is
  guarded at `:817`).
- [x] 3c. Preamble warning (`slice-run.ts`, beside `:7424`): `startPrompt` contains
  `.slice-parent.md` but not `{parent}`. **Also built:** a second warning when
  `startPromptParent` is set but `startPrompt` has no `{parent}`, because the key would then never
  be used.
- [x] 3d. Tests:
  - `sliceSessionClose.test.ts`, next to the `{parent}` tests (`:599`): a config with
    `startPromptParent` puts its text at `{parent}` when the file exists. Without the file, nothing
    is added and no English sentence is appended.
  - `sliceConfigLoad.test.ts`: an empty `startPromptParent` is refused.
  - `sliceRun.test.ts`: the preamble warns about a prompt that names the file without `{parent}`,
    and says nothing when the prompt uses the placeholder.
- [x] 3e. README configuration table and the `startPrompt` section: the new key, with a
  non-English example.

## Phase 4 — `azelf run --parent <id>`: one wave, re-read every round

- [x] 4a. `slice-run-usage.ts`: `--parent` in `VALUE_FLAGS` and `USAGE`: "run the ready tickets
  under one parent (its sub-issues, or a ## Parent section naming it); children labelled later
  join the run". With ticket ids too, exit 64 with "--parent and ticket ids are two answers to
  which tickets — pass one".
- [x] 4b. `loadTickets` (`slice-run.ts:460`) takes the parent. Ids = `listReady(readyLabel)`,
  filtered to native children of the parent plus the tickets whose `## Parent` names it. The bodies
  come from the existing `body` cache, which is already filled for `findEpics`, so this adds no
  read. The parent is excluded. The epic exclusion applies as in a bare run. When nothing
  qualifies: "no ready tickets under #206 — label one ready-for-agent, or give it a ## Parent
  section naming #206", exit 0.
- [x] 4c. A `joinChildren()` in the round loop, after `refreshOpenState` (`:7976`):
  - Read the set again, and drop ids already in `tickets` and those remembered as not belonging.
  - Run the rest through the same path as at plan time (the body, blockers, `foreignBlockers`, and
    `humanLabel`), claim them, add them to `tickets`, and call `assignWaves(tickets)`.
  - Print one line per joiner: `[round N] #250 joined — ready under #206 since the run started
    (wave 2)`.
  - A joiner held by another dispatcher, or one with a body-only blocker that has no edge, is named
    once and left out. Under `--ignore-body-blockers` the second kind joins anyway.
  - A failed read counts as a look that found nothing, as it does in `refreshOpenState`.
- [x] 4d. A ticket in the set that has not started and has lost the ready label leaves the run,
  with one line. It is unclaimed.
- [x] 4e. `maxParallel` (`:7292`) becomes a `let`. Under `--parent` without `--max` it is
  recomputed after a join from the new tree's widest wave.
- [x] 4f. `resumeCommand` / `runCommand` (`:8463`): under `--parent`, no ids. The end line under
  `--parent` reads "every ticket under #206 closed — plan complete (a child labelled after this
  needs a new run)".
- [x] 4g. Tests (`sliceRun.test.ts`, with the fake tracker):
  - `--parent` selects the `## Parent` children and the native children, and leaves out a ready
    ticket under another parent and the parent itself.
  - Ids together with `--parent` exit 64.
  - A child labelled ready while the run is going joins in the next round and lands.
  - A child held by another run is named and skipped, and the run goes on.
  - A child that loses its label before it starts leaves the run.
  - The resume command has `--parent 206` and no ids.
  - Without `--max`, a join that widens the tree raises the cap.

  **As built:** the plan builds each ticket with `planTicket`, which was split out of
  `loadTickets`, and so does a child that joins. A joiner that is a parent itself (it has
  native children, or another joiner names it in `## Parent`) is said once and left out, as a
  bare run leaves out an epic. A blocker that was outside the set moves into it when that
  blocker joins. A cycle through a joiner sends the joiner back out and the run goes on. The
  steady-state cost is one `listReady` per round. Only when a new ready ticket appears does the
  run read the parent's `children`, plus a body for any ticket the tracker does not list as a
  child. A ticket missing from `listReady` is read itself before it leaves the run, because the
  list can lag a label. The cap only grows: `maxParallel = max(cap, widest wave)`. Any other
  command line that names ids, such as "run the rest on their own", drops `--parent`.
- [x] 4h. README ("Choosing what runs" or wherever the bare-run vs ids text is) and
  `agent/commands/azelf.md`: for a wave under one tracking issue, `azelf run --parent <id>`, and
  the children need a `## Parent` section or to be sub-issues.

## Unobserved, once built

- Phase 1: whether ending a manual session at the land ever cuts off a session that someone was
  still talking to after `slice-done.sh`. 1c showed that Warp closes a window whose zsh exits from
  inside a `TRAPALRM`. It has not yet been seen for a tab opened by `warp://action/new_tab` in a
  window that has other tabs.
- Phase 4: how often a wave on consumer-b has a child labelled mid-run, and whether one round's
  delay before it joins is ever too slow.

## Order and cost

Phase 1 (medium: 1a and 1b are a few lines each; the hook, 1c's Warp check and the hook test take
most of the time), then Phase 2 (small), then Phase 3 (small), then Phase 4 (medium-large: a new
path into the round loop). One commit each, and each is useful on its own. 1a and 1b could land
before 1c/1d if the Warp check takes long, since they close #230's case alone. Phases 2 and 3 do
not depend on anything. Phase 4 uses none of the others.

After each phase, update the Status line of consumer-a's entry (Phases 1 and 2). consumer-b's log
has no status field.

## Not in this plan

- **Ending a session when its land parks.** This is still "wontfix for now" from the tab-close plan.
  A parked slice is one the person or the resolver will come back to, so its tab is still in use.
- **Closing a tab under bash.** bash has no idle trap, and its `TMOUT` logs the shell out
  regardless.
- **Reading "Teil von #N" / "Part of #N" as a parent.** It is prose in one language, and azelf
  reads structure (`## Parent`, sub-issues).
- **Re-reading the set in a bare run.** See Decisions.
- **`--label <name>`.** See Decisions.
- **ci-minutes Phase 4** (`ciRuns({ trigger: "dispatch" })`). It still waits for consumer-b's
  decision on whether a check before the land stays.
- **Checking a ticket's new paths against repo guard tests when it is cut** (consumer-b #246).
  That happens where the ticket is written, before azelf sees it.

## What the consumer does itself

- **Both consumers, after Phase 1:** bump or pull, run `azelf init --hook` (v4 → v5), and open new
  tabs so they load it. Restart running dispatchers. A tab opened under v4 keeps the old
  behaviour.
- **consumer-b, after Phase 3:** move "Das Rahmen-Ticket … steht in .slice-parent.md, lies es
  danach … geht diesem Prompt vor." out of `startPrompt` into `startPromptParent`, and put
  `{parent}` where it was. The warning goes away when that is done.
- **consumer-b, for Phase 4:** cut a wave's tickets with a `## Parent` section naming the tracking
  issue (`## Parent\n\n#206`), or file them as its sub-issues. Their first line "Teil von #206"
  can stay as text. This also gives every wave ticket a `.slice-parent.md`, so the parent
  sentence in its prompt becomes true.
- **Both consumers, after Phases 2–4:** bump or pull, and restart running dispatchers. No shim
  changes, so no `azelf init`.
