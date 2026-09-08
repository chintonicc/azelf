# Extracting the slice workflow into a reusable repo

**Status:** Phases 1–4 LANDED 2026-09-07 · Phase 5 open · **Written:** 2026-09-07
**Source of truth for the current design:** `consumer-a/docs/adr/0001-parallel-slice-sessions.md`
**Destination repo:** `github.com/chintonicc/azelf` — created, empty but for a copy of this
plan. Nothing moves there until Phase 5; the seam work happens in consumer-a, where the code,
the gates and a real consumer already are.

## Phase 1 — landed

Four commits in consumer-a, ordered by dependency so the shared commit path changed last:
`1de5a75` (config + loader + shell bridge) · `4785a49` (slice-run.ts) · `a211e2a`
(slice-session/land/done) · `bcf438f` (db-lock-check + session-commit).

Two deviations from the plan below, both deliberate:

- **`slice.config.ts`, not `.json`.** Half of what makes those values correct is an
  incident, and JSON has nowhere to put the comment. The cost is that the shell half reads
  it through a `bun scripts/slice-config.ts --sh` bridge (`scripts/slice-config.sh`), ~30ms
  per invocation, which makes bun a hard dependency of *committing*. Phase 5 owns whether
  the extracted package can afford that.
- **`branchPattern` is validated to hold exactly one `{n}`**, because the round-trip
  extractor is derived from the same string. `slice-done.sh` now calls
  `slice_ticket_from_branch` instead of parsing `^ticket/([0-9]+)$` by hand.

Ticket ids are still assumed numeric in five places. Phase 3 widens them together.

**New finding, and it changes Phase 5.** `.gitignore` is hashed RAW by `@expo/fingerprint`
(source reason `bareGitIgnore`), so appending the marker block to it moves an Expo app's
runtime version and strands OTA updates for every shipped build until the next build.
Measured in consumer-a: adding the block moved exactly one fingerprint source and cost a manual
revert-publish-restore on each subsequent OTA. The markers now live in
`.git/info/exclude` — untracked, not shipped, not a fingerprint source, and read by every
linked worktree since they share the common git dir. `init` must write there, not to
`.gitignore`. This is not Expo-specific in spirit: any tool that hashes repo files to
derive a version has the same exposure.

## Phase 2 — landed

Four commits in consumer-a, ordered so the dispatcher changed after the config it reads:
`e6768e7` (the three shapes + runner + tests) · `08a9313` (config names its gates, loader
validates) · `f3bce1a` (slice-run.ts runs `config.gates`, gains `--gates <n…>`) · `1992fa7`
(ADR consequence, `/gates` command corrected).

`scripts/slice-gates.ts` ships `exitCode(cmd)`, `exitCodeOverFiles(cmd)` and
`baselineDiff({cmd, errorMatch, normalize})`, plus `runGates` and the `multisetDifference`
that moved out of the dispatcher verbatim. The three tsc facts live in `slice.config.ts` with
the #12 story; `errorMatch` and `normalize` are required, not defaulted. Both shapes take an
optional `hint` so the project's own "run ./scripts/format.sh in the slice" survives in config.

Deviations and additions, all deliberate:

- **The read-only contract is enforced, not only documented.** `runGates` checks `git status`
  after every gate and fails the land BY THE GATE'S NAME if anything changed, before the gate's
  own verdict is considered. It also fails closed when `git status` itself cannot run — found
  the hard way, when a proof pointed at a nonexistent worktree and an empty answer read as
  "clean". Contract text: header of `scripts/slice-gates.ts`, ADR 0001's last consequence.
- **`slice-run.ts --gates <n…>`** runs the configured gates on a slice's worktree and lands
  nothing. It is how the shapes were proven and how a human checks a slice by hand.
- **`exitCodeOverFiles` drops deleted paths and passes without running on an empty list** —
  a linter given no paths would check the whole tree, which is a different gate.
- **`baselineDiff` reports a non-zero exit with zero matching lines as a crash, not a pass** —
  `/gates` already warned that tsc can fall over on expo-router's `Href` union.
- **`.claude/commands/gates.md` told agents to run `bun run format` as a gate.** The
  human-facing half of the same trap; it now says `./scripts/format.sh`.
- **Gates are functions, so they are TypeScript-only.** The shell bridge does not carry them
  and no shell script runs one; `--json` prints their names. Phase 5's runtime decision now
  has a second constraint: whatever the config format becomes, the gates cannot be JSON.

Proof, against a throwaway worktree cut from master (`ticket/99999`, since removed): a comment
line inserted above the three baseline errors in `db/remote/queries.ts` — a baseline file the
slice "touched" — passed all three gates; one new error in an untouched `lib/` file blocked
with "1 error(s) … (baseline is 9)"; a red test blocked at the first gate; a whitespace-only
format error blocked at the linter with the format.sh hint; a gate that appended to a file
failed by name with the dirt listed and the next gate never ran. 22 unit tests cover the
shapes and the runner through a scripted exec.

## Phase 3 — landed

Five commits in consumer-a, ordered so nothing consumed the seam before it existed: `53863d8`
(contract + GitHub adapter + 18 tests) · `9a3d852` (config names its tracker, loader
validates, shell bridge) · `8f0cd5a` (slice-run.ts) · `6086294` (slice-session/land/done) ·
`bd9f133` (ADR consequence).

`scripts/slice-tracker.ts` ships the `Tracker` contract — `listReady`, `get`, `blockers`,
`body`, `close` — plus three data fields the widening needed: `name`, `idPattern` and
`refTemplate`. `github()` is the adapter; it takes a scriptable `gh` runner so the tests run
without a network. The header carries the three reasons this is a contract, and the one that
bites is written as a rule: `close(id)` must leave the ticket in whatever state that
adapter's own `blockers()` reports as `closed`, or the loop deadlocks silently.

Deviations and additions, all deliberate:

- **The shell reaches the adapter through `bun scripts/slice-config.ts --tracker <verb> <id>`**
  — `get` (TSV: state, ready, title), `open-blockers` (an integer), `brief` (the
  `.slice-ticket.md` text), `close`. One bun spawn per verb: three in a launch, one in a
  land, **none in a commit** — `session-commit.sh` never touches the tracker, so the Phase 1
  cost is unchanged where it is paid most. The bridge deliberately offers neither `listReady`
  nor the raw blocker list; the graph is the dispatcher's to read. No shell script calls `gh`
  any more, and the jq program the ready label used to be interpolated into is gone.
- **`openBlockers` is the one filter both halves use.** `blockers()` returns every edge with
  its state; `slice-run.ts` partitions those into in-set and foreign, the bridge counts them.
- **`idPattern` is a regex SOURCE valid in both JavaScript and POSIX ERE**, anchored, because
  the same string is compiled by the dispatcher and handed to bash's `=~` (macOS regcomp: no
  `\d`, no `\w`, no `(?:`). The loader refuses those, since a pattern that works in TS and
  silently rejects every ticket in the shell is exactly the half-widened failure this phase
  exists to prevent. `refTemplate` (`#{n}` on GitHub) is how both halves print a ticket;
  `slice_ref` in shell, `ref()` in TS.
- **Six places, not five, and one is outside the repo.** Widened together: both shell argv
  guards (now `slice_is_ticket_id`, moved below the config source), `slice-run.ts`'s
  `explicit` filter, and both halves of the branch round trip (`idFromBranch` in the tracker
  module, `slice_ticket_from_branch` in shell). The sixth is the `~/.zshrc` autostart hook:
  its `'^[0-9]+$'` guard still refuses a non-numeric marker, which degrades visibly (the tab
  sits at a prompt; the dispatcher reports "never came up") but is not fixed here. It needs
  a safe-token guard — `'^[A-Za-z0-9._-]+$'` — since `slice-session.sh` re-validates against
  the tracker's real pattern anyway; Phase 4's `init` should write that hook.
- **`Ticket.number` is `id: string` throughout the dispatcher.** The tree's sort became
  numeric-aware collation (`compareIds`), so `#9` still precedes `#12` and `ENG-9` precedes
  `ENG-12`. GitHub ids stay numeric strings; `--plan` prints the same tree byte for byte.
- **A latent argv bug went with it:** under `^[0-9]+$`, `--max 2` and `--interval 30` were
  read as tickets #2 and #30, which `gh` would then fetch and plan. The filter now skips the
  values of value-taking flags.
- **The blocker-COUNT guard in `slice-session.sh` stays numeric**, because it guards a count.

Proof: `ticket/3` prepped through the real GitHub adapter with a brief byte-identical to the
jq one it replaced, `--gates 3` and `slice-done.sh` refused it correctly as "nothing to land".
A throwaway `ticket/ENG-123` worktree, its config overridden to a Linear-shaped tracker
(`^[A-Z]+-[0-9]+$`, ref `{n}`), round-tripped through `slice_ticket_from_branch`, was marked
done by `slice-done.sh` naming `slice-land.sh ENG-123`, and passed all three gates under
`slice-run.ts --gates ENG-123`; the main tree, on the GitHub pattern, refused the same id.
Both worktrees and branches removed. tsc baseline still 9; 2245 tests green.

## Phase 4 — landed

Five commits in consumer-a, ordered so nothing consumed the seam before it existed: `3a8e1c0`
(contract + `manual`/`warp`/`tmux` + the sh hook + 20 tests) · `d850871` (config names its
launcher, loader defaults and validates, shell bridge) · `77f3999` (slice-run.ts) · `aa3a734`
(slice-session.sh) · `867b47d` (ADR consequence).

`scripts/slice-launcher.ts` ships the `Launcher` contract — `name`, `starts`,
`startingGraceMs`, `problem()`, `open(sessions)` — and three constructors. `manual()` prints
one pasteable command per slice and opens nothing; it is the default when the config names
none and the fallback whenever a launch cannot run or throws. `warp()` and `tmux()` take a
scriptable spawn so the tests open no terminal. The canonical hook is
`scripts/slice-autostart.sh`; `init` (Phase 5) installs it, and `~/.zshrc` on this machine
still carries the older zsh-only block, which works for numeric ids.

Deviations and additions, all deliberate:

- **`starts: "command" | "marker"` is the field that reaches outside the launcher.** The
  marker protocol is Warp-specific, but `slice-session.sh` parks flags in `.slice-flags` for
  it (ADR #26). The bridge exports `SLICE_LAUNCHER_STARTS`; `--prep-only` parks only under
  `marker` and removes a stale file under `command`, since a parked flag can only ever turn
  something on later. The read-back was already correct with no file. Nothing else in the
  shell half reads the launcher — `open` and `problem` stay on the TS side.
- **The grace window is declared by the launcher.** `STARTING_GRACE_MS` is gone from the
  dispatcher: Warp 120s (URI dispatch + shell startup + hook), tmux 60s (the session's own
  prep only), manual 10 min (a human pasting; after that the command is printed again, which
  is the right reminder). The "never came up" report names the launcher and reads the same
  number, because it is a diagnostic threshold as much as a timeout.
- **`TERM_PROGRAM` is a check, not the selector.** `warp().problem()` returns "config names
  the warp launcher, but this is not Warp (TERM_PROGRAM=…)"; the banner prints it and the run
  falls back to `manual`. Decided once at startup, so the grace window means one thing per
  run. `tmux().problem()` reports a missing binary with the spawn's own reason, and "no tmux
  server is running" when outside a session and `has-session` fails.
- **A missing hook is detected by file name, for zsh, bash and fish.** `autostartHook`
  reads the rc file of `$SHELL` — `.zshrc` honouring `ZDOTDIR`; bash's `.bashrc`,
  `.bash_profile` and `.profile` (macOS starts bash as a login shell); fish's `config.fish`
  honouring `XDG_CONFIG_HOME` — and every "not installed" says where it looked. Fish gets a
  plain "no fish version ships yet" (the hook is sh syntax); a shell it does not know, or an
  unset `$SHELL`, is refused by name rather than guessed at. `rcFilesFor` is exported for
  `init`. Warp's own startup-shell setting can differ from `$SHELL`; that is not read.
- **The hook is sh, and the sixth ticket-id site is closed.** `case "$-" in *i*)` replaces
  `[[ -o interactive ]]`, a `case` glob replaces the quoted `=~` that bash matched as a
  literal, `$PWD/scripts/slice-session.sh` replaces the absolute path, and the guard is the
  safe-token check `[A-Za-z0-9._-]`. A marker in a directory with no `scripts/slice-session.sh`
  is reported, not ignored. Proven under bash 3.2 and zsh 5.9 (`bash --rcfile … -i`,
  `ZDOTDIR=… zsh -i`) against a fake session script: `42`, `ENG-123` and `a.b_c-d` ran, `bad
  id`, `../x` and an empty marker were refused, every marker was consumed, and a
  non-interactive shell left it untouched.
- **Warp's window path writes outside the repo and now says so.** One YAML per launch under
  `~/.warp/launch_configurations`, never removed (deleting it straight after `open` would race
  Warp's read); the printed line names the file. Not fixed, only named.
- **Commands are shell-quoted.** `shellLine` quotes only what needs it, so the manual line
  and the YAML `exec` are unchanged for plain paths and survive a worktree path with a space.

Proof, all against ticket `#3` and this Warp terminal. `--plan` printed the same tree byte for
byte as a detached worktree of `bd9f133`. With the `launcher:` line removed from the config:
`--sh` exported `manual`/`command`, the JSON view said `"launcher": "manual"`, and one
`--once -y 3 --no-start` round prepped the worktree, left no `.slice-flags`, and printed
`…/scripts/slice-session.sh 3 --no-start` for pasting. A malformed launcher object was refused
as "launcher is not a launcher". With `warp()` restored, the same round parked `--no-start`,
wrote the marker, opened one tab here, and reported "(started by the autostart hook in
~/.zshrc)"; the tab consumed the marker, wrote `.slice-live`, and killing the
session cleared it through the EXIT trap. No YAML was written. Detection against this
machine's real files: installed for zsh; a named reason for bash (three files), fish, tcsh
and an unset `$SHELL`. `tmux().problem()` here: "tmux cannot be run: Executable not found in
$PATH". Worktree and branch removed.

**Not proven, and it should be said plainly: tmux is not installed on this machine.** The
tmux launcher is written against `tmux new-window -d -c <dir> -n <name> <cmd>` as documented
and tested through a scripted spawn only. Its first real run belongs to the second-repo proof
in Phase 5. tsc baseline still 9; 2265 tests green.

Two notes for Phase 5. `init` can tell an installed hook from a missing one but not an old
one from the new — both contain `.slice-autostart`; if `init` is to upgrade the block, it
needs a version line in `slice-autostart.sh` to look for. And `openSessions` catches a
throwing launcher and prints the commands, but a launch that *succeeds* into a shell that
does nothing (the marker refused by an old hook) is only ever seen as "never came up" after
the grace window; that is the designed behaviour, and the report now names the launcher so
the reader knows which mechanism to look at.

## What this is

The slice tooling in `consumer-a/scripts/` (`slice-run.ts`, `slice-session.sh`, `slice-land.sh`,
`slice-done.sh`, `db-lock-check.sh`, `session-commit.sh`) is ~1,430 lines that solve a
project-independent problem: run several agent sessions in parallel, each in its own git
worktree, serialize the ones touching a shared resource, review and land them one at a time.

Only the last part is consumer-a-specific. This plan extracts the rest.

**Effort: 14–20 hours, plus 4–6 hours proving it on a second, differently-stacked repo.**
Budget that second part. Every assumption below was invisible until it was audited, and the
next set will be invisible until a Go or Python repo hits them.

## The one thing to know before starting

**ADR 0001's own portability claim is stale.** It says "the only consumer-a-specific pieces are
the repo path and the DB-lock's `supabase/migrations/` path." That was true on 2026-09-03.
The next day `gatesPass()` grew a tsc baseline-differencing algorithm, `--auto`/`--self-land`
added the marker protocol, and the Warp/zshrc launcher stacked three host assumptions.

Do not plan from the ADR's summary. Plan from the inventory below.

## Shape: an installable package, not a template repo

Rejected — **template repo you fork per project**: every consuming project forks 1,400 lines
and never gets the next fix. This tooling is still actively learning; four dispatcher fixes
landed mid-run on 2026-09-04 alone. Forking a codebase that is still discovering its own
failure modes is the worst possible timing for a fork.

Rejected — **skill/plugin bundle alone**: the load-bearing parts are a long-running dispatcher
with a 30-second poll loop, an atomic `mkdir` mutex, filesystem markers coordinating across
processes, and terminal-window orchestration. None of that is prompt-shaped.

**Chosen — a package with one `slice.config.{ts,json}` at the consuming repo's root**, plus a
thin companion plugin carrying the genuinely prompt-shaped half (the `/gates` command, a
skill teaching an agent the `.slice-ticket.md` → implement → `slice-done.sh` contract, and
ADR 0001's prose). That companion also removes the hard dependency on
`mattpocock-skills:implement`, which `slice-session.sh` currently hardcodes into its opening
prompt.

## Phase 1 — Config seam (3–4h)

Thread six keys through the six files. Nothing clever; mostly find-and-replace with care.

| Key | Replaces | Sites |
|---|---|---|
| `baseBranch` | literal `master` | 8 (slice-run 458/512/610/619, slice-land 32/55/60, slice-done 52, slice-session 221/231) |
| `exclusiveLockPaths: string[]` | literal `supabase/migrations` | 4 (db-lock-check 69/85, session-commit 135, slice-session 208) |
| `branchPattern` / `worktreeDir` | `ticket/{n}`, `../{repo}-ticket-{n}` | 6 |
| `readyLabel` | `ready-for-agent` | 3 |
| `provisionCopy: string[]` | `.env`, `expo-env.d.ts` | 2 |
| `startPrompt` | the `/mattpocock-skills:implement` prompt | 1 |

Two traps:

- **`branchPattern` must round-trip.** `slice-done.sh:34` *parses* a branch back into a ticket
  number (`^ticket/([0-9]+)$`). A formatter alone is not enough; ship a matching extractor.
- **`db-lock-check.sh:96` already does this right** — `local base="${DB_LOCK_BASE:-master}"`.
  Copy that pattern rather than inventing a second one.

`exclusiveLockPaths: []` must make the whole DB lock a no-op — that's the correct default for
a project with no shared mutable resource, and it's most projects.

## Phase 2 — Gate seam (4–5h) · the biggest single cost

`gatesPass()` (`slice-run.ts:494–578`) cannot become a config value, because the three gates
have different **shapes**, not just different commands:

- `bun run test` — boolean, exit code.
- `biome check` — boolean, **but takes the changed-file list as arguments**.
- `tsc` — neither. It runs the tool **twice, in two different working directories**
  (`repoRoot` vs the worktree) and multiset-diffs the results.

The tsc gate encodes three tool-specific facts: errors are found by the substring `error TS`;
`(line,col)` noise must be stripped because inserting a line shifts every error below it; and
a *duplicate* of an existing error counts as new, which is why it's a splice-consuming
multiset diff and not a `Set` difference. ADR:28 records that this replaced a naive
"does the error name a file you touched?" check *because that check was wrong in both
directions* — so a generic fallback can't be the naive one either.

**Ship three built-in gate shapes:**

```
exitCode(cmd)                                    # test suites
exitCodeOverFiles(cmd)                           # linters taking a file list
baselineDiff({cmd, errorMatch, normalize})       # typecheckers with standing debt
```

`baselineDiff` covers tsc / mypy / clippy, but genuinely needs a per-language `errorMatch` and
`normalize`. Don't pretend otherwise.

**Make "gates must be read-only" a documented contract, not a per-project string.** The
`format` vs `biome check` distinction is a real trap: a gate that edits the tree dirties the
worktree it is judging and lands changes nobody reviewed. Consumer-A hit the human-facing half of
this on 2026-09-07 (see `scripts/format.sh`). A config key alone would let every consuming
project walk into it.

## Phase 3 — Tracker seam (3–4h)

Five methods: `listReady(label)`, `get(n)`, `blockers(n)`, `body(n)`, `close(n, comment)`.
GitHub adapter ships; others are plugins.

Three reasons this isn't a config value:

1. **GitHub's dependency API only reads one direction** — `slice-run.ts:176` documents that
   `blocks` 404s, so the reverse edges in `printTree` are derived by inversion. Linear and
   Jira model blocking differently.
2. **Closing is load-bearing, not cosmetic.** GitHub clears a blocking edge only on close, so
   `gh issue close` is what unblocks the next wave. A tracker whose "done" state isn't
   "closed" breaks the loop silently.
3. **Two consumers read the graph differently** — `slice-run.ts` needs the full blocker list
   with states (to partition in-set vs foreign blockers); `slice-session.sh` needs only the
   count. The adapter must serve both.

**Also in this phase: stop assuming numeric ticket ids.** Four places require integers
(`slice-session.sh:115`, `slice-land.sh:26`, `slice-done.sh:34`, `slice-run.ts:665`), plus the
shell hook's `'^[0-9]+$'` guard. Linear's `ENG-123` breaks branch naming, argv parsing and the
autostart hook simultaneously. Fix them together or not at all.

## Phase 4 — Launcher seam (2–3h)

`launcher: { open(dirs, cmd) }` with **`manual` as the default**, `warp` and `tmux` shipped.

The Warp path is three stacked assumptions — Warp's two URI schemes and launch-config YAML
(verified only against v0.2026.08.12), macOS `open`, and zsh as the only shell probed for the
hook. It can't collapse to a config value because Warp's two mechanisms have *complementary*
deficiencies (`new_tab` carries no command; `launch/` always opens a new window), and the
entire `.slice-autostart` marker protocol exists solely to bridge that gap. tmux would delete
the marker mechanism entirely (`tmux new-window -c dir cmd` carries both).

Good news: degradation is already clean — non-Warp terminals get the command printed for
pasting. `manual` is a real default, not a stub.

The shell hook must become shell-agnostic and installed by `init`: it currently hardcodes an
absolute path to consumer-a's `slice-session.sh`, and uses two zsh-isms (`[[ -o interactive ]]`,
bare-regex `=~`). Resolving `$PWD/scripts/slice-session.sh` instead makes it project-agnostic
in one line, since `$PWD` is always the worktree.

## Phase 5 — `init`, docs, and the runtime decision (2–3h)

`init` handles the two out-of-repo install steps a template would leave as README steps people
skip: writing the marker block to **`.git/info/exclude`** (7 patterns — see the Phase 1
finding above; `.gitignore` is a fingerprint source in Expo projects and must not be touched
for local litter) and installing the shell hook.

**Decide the runtime.** `slice-run.ts` is bun-only beyond the shebang: `prompt()` is a Bun
global with no Node equivalent, and top-level `await` in a `.ts` file with no build step.
Requiring bun to orchestrate a Go repo is exactly the friction that stops adoption at step
one. Budget 2–3h to ship it compiled with a `readline` prompt.

## Cut from v1

- **The sandbox.** macOS Seatbelt paths, this machine's toolchain layout, pinned to
  sandbox-runtime 0.0.75's settings schema — and documented as breaking interactive `claude`
  input, so the recommended state is already off. Shipping a default profile that is
  macOS-only, version-pinned and known-broken is worse than shipping none. Reduce to a
  `wrapCommand: string[]` hook and let users supply a profile.
- **`.env` fan-out as a default.** It copies secrets into up to N sibling directories that
  linger after a failed land. Benign for Expo public keys; not for production credentials.
  Make it opt-in with a warning.

## What ports for free

Roughly 55% needs no changes: the `mkdir` commit mutex and its staleness takeover; the
foreign-staged-entry detector (`comm -23` of all-staged vs your-pathspec-staged); the
pathspec-limited commit and fast-forward-checked push; the worktree enumerator with its
prefix-based porcelain parsing and fail-closed error branch; `assignWaves`/`printTree`; the
three-state marker model and its launch grace window; `rebaseOntoMaster` with its
name-the-conflicts-before-aborting sequence; the three-way worktree reuse ladder.

**No script reads `CLAUDE.md` or `docs/agents/*.md` at runtime** — every reference is prose.
The docs are rationale, not input, which is why this extracts as cleanly as it does.

The comment density is an asset, not overhead: the *why* is already written, and it is most of
the extracted repo's documentation. Carry the comments over verbatim; they encode incidents
(`db-lock-check.sh`'s two zsh variable traps, ADR:27's "first land re-broke the other two",
ADR:28's #12 false-blame) that a rewrite would have to relearn.

## Suggested execution

This plan is itself a candidate for the pipeline it describes: run
`/mattpocock-skills:to-tickets` over it to get blocking edges, then `slice-run.ts --auto`.
Phases 1–4 are independent enough to parallelize once Phase 1 lands; Phase 1 blocks the rest,
because everything else reads config.

Do it in the consumer-a tree first (the scripts still live there), extract to the new repo at the
end of Phase 5, and keep consumer-a as consumer #1 — a first consumer that can't leave is the
only reliable test that the seams are real.
