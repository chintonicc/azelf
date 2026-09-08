# azelf

**Parallel agent slices: one ticket, one worktree, one session, gated landing.**

A dispatcher reads ready tickets and their blocking edges from your tracker, works
out which ones can run at once, preps a git worktree per ticket, opens a terminal
session in each, and lands the finished ones — re-running the gates itself, because
"the agent said its gates were green" is not a check.

```
── reading the plan from github ──────────────────────
  wave 1   #17  #18  #21
  wave 2   #19          (blocked by #17)
  wave 3   #20          (blocked by #19)

  ✓ #17 landed        ✓ #18 landed
  ✗ #21 did not land — the gates are red
     worktree: /…/repo-ticket-21
     [r] retry now   [f] land anyway   [p] park it   [q] stop the run
```

---

## Contents

- [What problem this solves](#what-problem-this-solves)
- [How it works](#how-it-works)
- [Requirements](#requirements)
- [Install](#install)
- [Quick start](#quick-start)
- [CLI reference](#cli-reference)
- [Configuration reference](#configuration-reference)
- [The five seams](#the-five-seams)
  - [Gates](#gates) · [Tracker](#tracker) · [Launcher](#launcher) · [Agent](#agent) · [wrapCommand](#wrapcommand)
- [Where tickets come from](#where-tickets-come-from)
- [The exclusive lock](#the-exclusive-lock)
- [When two slices touch the same file](#when-two-slices-touch-the-same-file)
  - [Quieting the paths that never matter](#quieting-the-paths-that-never-matter)
- [When a slice will not land](#when-a-slice-will-not-land)
  - [Letting an agent resolve a rebase conflict](#letting-an-agent-resolve-a-rebase-conflict)
- [In a coding agent](#in-a-coding-agent)
- [Sandboxing](#sandboxing)
- [Runtime and limitations](#runtime-and-limitations)
- [Troubleshooting](#troubleshooting)
- [Repository layout](#repository-layout)
- [Design notes](#design-notes)
- [License](#license)

---

## What problem this solves

Running one coding agent is easy. Running six without them colliding is not.

They share a checkout, so two agents editing the same tree corrupt each other's
work. They share a branch, so landing becomes a merge problem nobody asked for.
They finish at different times and in the wrong order, so a ticket that was blocked
when the run started is unblocked twenty minutes later and nothing notices. And the
part that actually costs you: **an agent reporting its own success is not evidence.**
The gates have to be re-run by something that has no stake in the answer.

azelf is the piece that handles all four. It is not an agent and does not write code.
It decides what may run, isolates each run, and decides what may land.

## How it works

The life of one slice, end to end:

1. **Plan.** The dispatcher asks the tracker for every open ticket carrying your
   ready label, plus each one's blocking edges. It assigns waves — wave 1 is
   everything with no open blockers, wave 2 is everything blocked only by wave 1,
   and so on — and prints the tree with the reason each held-back ticket is held.
2. **Prep.** For each ticket in the current wave it creates a branch from
   `baseBranch` and a git worktree outside the repo, copies in the gitignored files
   a fresh worktree never gets (`provisionCopy`), and writes the ticket body to
   `.slice-ticket.md` **inside the worktree**.
3. **Launch.** The launcher opens a terminal in that worktree running your agent
   with `startPrompt` as its opening instruction. The agent reads `.slice-ticket.md`,
   builds only that ticket, commits, and runs `./scripts/slice-done.sh` when its
   own gates are green.
4. **Land.** The dispatcher notices the ready marker, rebases the branch onto
   `baseBranch`, **re-runs every gate itself**, optionally asks a headless agent to
   review the diff against the ticket text, and fast-forward-merges. Landing closes
   the ticket, which clears the blocking edge, which releases the next wave.
5. **Escalate.** If any of those four steps fails, it stops and asks you — once,
   with the reason and the worktree path on screen. It never lands anything that
   failed a check.

Two invariants hold the whole thing together:

- **Every gate is read-only.** Enforced: the runner checks `git status` after each
  gate and fails the land by name if one wrote anything. `biome check <files>`
  observes; `bun run format` rewrites the tree. A gate that edits dirties the
  worktree it is judging and lands changes nobody reviewed.
- **The dispatcher trusts nothing it did not run.** The agent's claim of green
  gates is a hint about timing, not a result.

## Requirements

| | |
| --- | --- |
| **bun** ≥ 1.2 | required, including for Python projects — see [Runtime](#runtime-and-limitations) |
| **git** with worktree support | 2.5+, so effectively any git |
| **`gh`**, authenticated | only if you use the `github()` tracker |
| a coding agent on PATH | `claude`, `codex`, or whatever you point `custom()` at |
| macOS or Linux | the shell half is POSIX sh / bash 3.2 compatible |
| **any terminal** | no PARTICULAR terminal is needed; `warp()` and `tmux()` are optional conveniences |

## Install

```sh
bun add -d @chintonicc/azelf
bunx azelf init
```

`init` reads your `package.json` (or `pyproject.toml`) and writes a `slice.config.ts`
that already fits — Expo, Next.js, plain TypeScript and Python, with the right test,
typecheck and lint gates for the package manager you actually use. Detection is
shallow and every generated line says what it assumed, so a wrong guess is cheap to
correct. A tool it cannot find is written in commented out rather than left to fail
every slice.

It also does the two things a README would otherwise ask you to do by hand and you
would skip:

- writes six marker patterns to **`.git/info/exclude`**, never `.gitignore`
  (which `@expo/fingerprint` hashes raw, so an entry there moves an Expo app's
  runtime version and strands OTA updates until the next production build);
- writes shims into `scripts/` so `./scripts/session-commit.sh` and friends work
  by the names your docs and habits already use.

`azelf init --hook` additionally installs the shell autostart block into your rc
file, keeping a backup. It is opt-in because it edits a file outside your repo.

Everything `init` does is idempotent and delimited: run it again and it tells you
what is already current rather than appending a second copy. It upgrades only files
still carrying its generated marker and leaves anything you have edited alone,
saying so.

### What `init` writes

| path | what it is |
| --- | --- |
| `slice.config.ts` | your config, stack-detected, meant to be edited |
| `scripts/slice-session.sh` | shim — prep and open one slice |
| `scripts/slice-done.sh` | shim — a session marks itself ready to land |
| `scripts/slice-land.sh` | shim — rebase, gate and fast-forward one branch |
| `scripts/session-commit.sh` | shim — commit with explicit paths |
| `scripts/db-lock-check.sh` | shim — the exclusive-path lock |
| `scripts/format.sh` | shim — the write half of the formatter, run by hand |
| `scripts/slice-config.sh` | shim — the shell's view of your config |
| `.claude/commands/azelf.md` | the `/azelf` command |
| `.claude/skills/slice/SKILL.md` | the `slice` skill |
| `.git/info/exclude` | six marker patterns, in a delimited block |

Shims resolve the package at run time via `$AZELF_DIR`, else
`node_modules/@chintonicc/azelf`. They are one line of real logic and safe to commit.

## Quick start

```sh
# 1. label some issues
gh issue edit 17 --add-label ready-for-agent
gh issue edit 18 --add-label ready-for-agent

# 2. see what would happen — reads only, opens nothing
bunx azelf run --plan

# 3. open sessions for one wave
bunx azelf run

# 4. …the agents work. When one is done it runs ./scripts/slice-done.sh

# 5. land whatever is ready, then stop
bunx azelf run --once
```

Once you trust it, the whole thing is one command:

```sh
bunx azelf run --auto
```

which dispatches, waits, lands, releases the next wave, and repeats until nothing
is left — asking you only when something genuinely needs a decision.

## CLI reference

### `azelf init [--hook] [--codex]`

Installs into the repo you are standing in.

| flag | effect |
| --- | --- |
| `--hook` | also install the shell autostart block into your rc file (backs it up) |
| `--codex` | also write `/azelf` to `~/.codex/prompts/azelf.md`, frontmatter stripped |

### `azelf run [flags] [ticket ids…]`

| flag | effect |
| --- | --- |
| *(none)* | prep and open the current wave |
| `<ids…>` | prep and open exactly these tickets, ignoring the plan |
| `--plan` | print the wave tree and exit — reads only, opens nothing |
| `--auto` | dispatch, wait, land, release the next wave, repeat until done |
| `--once` | one round only: land what is ready, then stop |
| `--gates <ids…>` | run only the landing gates against existing worktrees, and exit |
| `--sync-edges` | record the blockers ticket bodies claim, then exit — the one write that is not a close |
| `--max <n>` | cap concurrent slices (default: the widest wave in the plan) |
| `--interval <s>` | seconds between polls under `--auto` (default 30) |
| `--no-start` | prep the worktree but do not open a session |
| `--review` | ask the agent to review the diff before landing (implied by `--auto`) |
| `--no-review` | never review, even under `--auto` |
| `--no-auto-resolve` | never let an agent resolve a rebase conflict — park it, as before |
| `-y`, `--yes` | non-interactive: park on any failure instead of asking |

`--gates` is how you check a slice by hand — no tracker call, no rebase, no land.
The worktree is judged exactly as it sits.

### `azelf hook`

Prints the shell autostart block for pasting by hand. Useful if you would rather
not have `--hook` edit your rc file.

### The shims

Generated into `scripts/`, these are what a session inside a worktree uses:

```sh
./scripts/session-commit.sh -y -m "message" path/to/file   # commit, explicit paths
./scripts/slice-done.sh                                    # mark ready to land
./scripts/format.sh                                        # the write half, by hand
./scripts/db-lock-check.sh                                 # may I touch locked paths?
```

## Configuration reference

One file, `slice.config.ts`, generated by `init` and meant to be edited. It is
TypeScript rather than JSON because half of what makes these values correct is an
incident and JSON has nowhere to put that.

```ts
import { type SliceConfig, exitCode, github } from "@chintonicc/azelf";

export default {
  tracker: github(),
  baseBranch: "main",
  branchPattern: "ticket/{n}",
  worktreeDir: "../{repo}-ticket-{n}",
  readyLabel: "ready-for-agent",
  exclusiveLockPaths: [],
  provisionCopy: [],
  gates: [exitCode(["bun", "run", "test"])],
  startPrompt: "Read .slice-ticket.md — it is your ticket, #{n}.",
} satisfies SliceConfig;
```

| field | type | meaning |
| --- | --- | --- |
| `baseBranch` | `string` | branch slices are cut from and land onto |
| `branchPattern` | `string` | branch template; must contain `{n}` and must round-trip |
| `worktreeDir` | `string` | worktree location relative to repo root; `{repo}` and `{n}` |
| `readyLabel` | `string` | issue label marking a ticket runnable |
| `exclusiveLockPaths` | `string[]` | paths only one worktree may hold changes to; `[]` disables |
| `provisionCopy` | `string[]` | gitignored files copied into each new worktree |
| `overlapIgnore` | `string[]?` | paths the overlap report skips; `*`, `**`, trailing `/` |
| `gates` | `Gate[]` | what a slice must pass before landing, in order |
| `tracker` | `Tracker` | where tickets and blocking edges live |
| `launcher` | `Launcher?` | how a prepped worktree becomes an open session (default `manual()`) |
| `agent` | `Agent?` | which agent runs sessions and reviews diffs (default `claude()`) |
| `wrapCommand` | `string[]?` | command the agent runs inside; `[]` by default |
| `startPrompt` | `string` | opening instruction for a session; `{n}` is the ticket |

Two of these have sharp edges worth stating:

- **`branchPattern` must round-trip.** `slice-done.sh` reads a branch name back into
  a ticket id, so the loader derives an extractor from this string and the tracker's
  id pattern. Changing it while branches exist orphans them — they no longer parse.
- **`worktreeDir` should stay outside the repo.** A worktree nested inside the
  checkout gets walked by biome, tsc and Metro, and then every gate judges every
  slice.

## The five seams

Each is a contract rather than a config string, because each one differs between
projects in *shape*, not just in the command it runs.

| seam | ships | contract |
| --- | --- | --- |
| [gates](#gates) | `exitCode`, `exitCodeOverFiles`, `baselineDiff` | every gate is READ-ONLY, enforced |
| [tracker](#tracker) | `github()` | five methods; its "done" must be its "closed" |
| [launcher](#launcher) | `manual()`, `warp()`, `tmux()` | `manual` is the default and a real answer |
| [agent](#agent) | `claude()`, `codex()`, `custom()` | an interactive session, and an optional headless review |
| [wrapCommand](#wrapcommand) | — | words prepended to the agent's command |

### Gates

Three shapes, because gates differ in shape and not only in argv.

```ts
// 1. An exit code. Runs in the slice's worktree.
exitCode(["bun", "run", "test"], { hint: "the unit suite is red" })

// 2. An exit code over the changed-file list.
exitCodeOverFiles(["bunx", "biome", "check", "--no-errors-on-unmatched"],
  { hint: "run ./scripts/format.sh in the slice" })

// 3. A baseline difference, for a checker with pre-existing errors.
baselineDiff({
  cmd: ["bunx", "tsc", "--noEmit"],
  errorMatch: /error TS/,
  normalize: (line) => line.replace(/\(\d+,\d+\)/, ""),
})
```

`baselineDiff` exists because the obvious shortcut is wrong in both directions.
If your typechecker has a standing baseline of errors, a non-zero exit means
nothing, and "does the error name a file this slice touched?" fails twice over:
files in the baseline are also the files slices routinely edit, so a slice gets
blamed for errors already on the base branch; and it cannot see an error a slice
introduces in a file it did not edit, which is most of what a type change breaks.
So the gate runs the command twice — base checkout and slice — and fails only on
the multiset difference. A duplicate of an existing error counts as new.

`normalize` is what makes the comparison stable: inserting one line shifts every
error position below it, so `(line,col)` has to go before the sets are compared.

### Tracker

```ts
tracker: github()                          // reads the repo you are standing in
tracker: github({ cwd: "../planning" })    // read a different checkout's issues
```

`github()` shells out to `gh`. It needs a tracker whose *closing* an issue is what
clears a blocking edge, because that is how landing releases the next wave.
GitHub's native issue dependencies satisfy this. A tracker where "done" and
"closed" are different states needs its own implementation of the five-method
`Tracker` contract.

#### Epics are excluded from the plan

A ticket that other ready tickets name as their **parent** is a heading over work,
not work. azelf drops it from the plan and says so:

```
  ⚠ #17 excluded — named as Parent by #18 #19 #20 #21
     An epic closes when its children close; it is not a slice.
     Run it anyway with: azelf run 17
```

Two sources, in that order of trust. If your tracker models hierarchy natively it
is asked (`children()`, implemented for GitHub sub-issues). Otherwise the ticket
body is read for a `## Parent` section naming an id.

The prose fallback is not a nicety. The case this was built for had four tickets
each declaring `## Parent — #17` while GitHub's sub-issue *and* dependency graphs
were completely empty — so the hierarchy was real, written down, and invisible to
every structured query. Without the fallback azelf would have opened five sessions:
one building the epic and four each building a quarter of it, all landing onto the
same base branch.

Parsing is section-scoped on purpose. A bare `#17` in a paragraph is a mention, not
a hierarchy — ticket bodies cross-reference each other constantly ("reads best
after #19"), and treating those as structure would exclude tickets that were only
giving context. Only ids under the heading count.

Explicit ids override all of it: `azelf run 17` runs #17, and when you name ids on
the command line the hierarchy is neither consulted nor paid for.

#### Claimed blockers are reported, never assumed

The same read applies to `## Blocked by`. Where a body names a blocker the tracker
has no edge for, azelf prints it under the tree and carries on planning:

```
  ℹ #22's body names a blocker GitHub has no edge for: #19
     The plan above ignores them — it schedules on edges, not prose.
     Record them with: azelf run --sync-edges
```

It is a note and not a warning, because most of these are not mistakes. "Blocked
by #19" in a body very often means "read #19 first", and promoting that to an edge
would delay a slice by a whole wave for a reading order. The plan schedules on the
tracker's edges; the body is a claim about intent that nobody updated.

`azelf run --sync-edges` is the opt-in that acts on it. It lists every claimed
edge, asks once, writes the confirmed ones through the tracker's optional
`addBlocker`, and then **stops** — the edges it just wrote are the input to the
plan, so anything printed after them would be the plan from before. Run it again to
see the new graph. A tracker whose adapter implements no `addBlocker` refuses
cleanly rather than crashing.

> **If you implement `addBlocker` for another tracker, read this.** GitHub's
> endpoint takes `issue_id` — the *internal database id*, not the issue number.
> Passing the number does not fail. It returns 201 and links whatever issue in all
> of GitHub happens to carry that id: probing it with `issue_id=19` on a repo whose
> #19 was the intended blocker produced a dependency on `sparklemotion/nokogiri#2`,
> a stranger's issue from 2008. Ids are global and the endpoint does not require
> the blocker to be in your repo, so a small number always resolves to *something*
> and never to the ticket you meant. `github()` resolves the number through the API
> before every write for exactly this reason.

#### A landed ticket carries its leftover checks

Closing a ticket already posts a comment. It used to be one fixed sentence; it now
also carries the **unticked checkboxes the slice added**, read from its diff:

```
Landed on master via slice-land.sh.

Still to check by hand — boxes this slice added and left unticked:

- [ ] A and B in the same group, both on the new path — B's device renders it
- [ ] Settings → language → deutsch, repeat: the chip reads "für <group>"
```

This exists because of what `--auto` costs you. A finished session closes its own
tab, and everything the agent said in that tab goes with it. Most of that is
recoverable from the diff — but not the checks a human still has to run, on a
device, with two accounts, in a language nobody on the team reads. That is real
work handed back to you, and it was arriving as scrollback in a window that closes.

Three things make it cheap rather than clever:

- **The durable half was already committed.** Agents write those checks into the
  repo as markdown checkboxes, so this reads what is in the diff instead of
  inventing a channel. No new convention, no model call, nothing to configure.
- **`- [x]` is left alone.** A box the slice ticked on its way past is not
  outstanding. Both `-` and `*` bullets count.
- **It is read before the fast-forward**, because afterwards there is nothing to
  read: `base...branch` is empty by definition once the branch has landed, and the
  cleanup deletes the branch outright.

Long lists are capped at 20 with a count of the rest, and a slice whose diff has no
checkboxes gets the plain sentence exactly as before.

### Launcher

**azelf is not Warp-only.** It runs in any terminal, on any platform. The launcher
decides one narrow thing — whether azelf *opens the terminal windows for you*, or
prints the commands for you to open yourself. Everything else (planning, prepping
worktrees, gates, landing, escalation) is identical either way.

| your terminal | what to set | what happens |
| --- | --- | --- |
| anything at all | `manual()` — **the default** | prints one ready-to-paste command per slice |
| Warp | `warp()` | opens a tab per slice in the current window |
| any, with tmux | `tmux()` | a tmux session per slice — *never run end to end, see gaps* |

If you leave `launcher` out of your config entirely you get `manual()`, and azelf
works. `warp()` is an optimisation for one terminal, not a requirement.

```ts
launcher: manual()   // print one command per slice for you to paste — the default
launcher: warp()     // Warp: tabs in the current window, or a new window
launcher: tmux()     // a tmux session per slice
```

`manual()` is the default and a real answer, not a fallback: it works in every
terminal and shows you exactly what would run.

`warp()` exists because Warp's `warp://action/new_tab` URI opens a tab in the
current window but cannot carry a command. So the dispatcher leaves a one-shot
marker in the prepped worktree and the shell autostart block picks it up on shell
start. That is what `azelf init --hook` installs, and why the launcher contract
carries a `starts: "command" | "marker"` field — `slice-session.sh` parks its flags
for the hook only when the launcher starts sessions that way.

#### A finished `--auto` slice closes its own tab

Under `--auto` the tab is the one thing nobody is reading. azelf already tells that
agent *"run ./scripts/slice-done.sh and then exit — nobody is watching this tab"*,
and moments later the dispatcher lands the branch and deletes the worktree the tab
is sitting in. So `slice-session.sh` exits **86** when the session ran under
`--self-land` *and* the agent exited cleanly, and the autostart hook (v3 and later)
ends the shell on that status, which is what the terminal closes the tab on. Under
`tmux()` the pane's command has ended anyway; under `manual()` you get 86 at your
own prompt with a line saying why.

**It is deliberately narrow, in both conditions.** Without `--auto` a human is the
one reading that tab — you read the agent's report there and run `slice-done.sh`
there — so the tab stays. And an agent that exited non-zero (no API key, a wrapper
that blocked the network, an interrupted run) leaves the tab open too: that is the
one case where the tab holds the only copy of what went wrong, and a tab that
vanished on failure would turn a legible error into a slice that silently never
started.

**When the agent does not exit, and it often does not.** Exit 86 needs the agent
process to end, and a Claude session that has finished its work commonly sits at
its REPL instead. On one three-slice `--auto` wave, none of the three exited: all
three ran `slice-done.sh`, all three landed, and all three tabs were still open an
hour later, rooted in worktrees that had been deleted underneath them. So the tab
closing is best-effort, and nothing depends on it: `slice-done.sh` clears the
`.slice-live` marker itself, which is what frees the slot, and `slice-land.sh`
names the still-running session by pid when it removes its directory —

```
✓ removed worktree /…/consumer-a-ticket-18
⚠️  the session for #18 is still running (pid 53049),
    and the directory it is sitting in has just been removed.
    It finished and marked itself done; it just never left its REPL.
    Nothing is lost — close that tab.
```

This changed the hook, so it is `v3`. If your rc file carries `v2`, `azelf init`
says so and `azelf init --hook` replaces it.

### Agent

```ts
agent: claude()                                    // the default
agent: codex({ sessionFlags: ["--full-auto"] })
agent: custom({ name: "aider", sessionCommand: ["aider", "--message"] })
```

| constructor | options |
| --- | --- |
| `claude` | `bin`, `sessionFlags`, `which` |
| `codex` | `bin`, `sessionFlags`, `headless`, `which` |
| `custom` | `name`, `sessionCommand`, `review`, `resolve`, `which` |

An agent has three capabilities and they are not the same one. A **session** is
interactive: a terminal, an opening instruction, running until it is done. A
**review** is headless: one prompt in, text out, bounded time, used to check a diff
against its ticket before landing. A **resolve** is headless *with tools*: it edits
files and runs git inside one slice's worktree, and it is the only one of the three
that writes.

Review and resolve are kept apart on purpose. A reviewer that can edit the tree is a
reviewer that can make its own findings go away — so the review argv carries no write
permission, and `claude()` spends `--permission-mode acceptEdits` only on the
resolver.

An agent can have the first without the others. `codex()` declares no headless mode
unless you pass `headless: true`, because its non-interactive invocation has not been
run against these review prompts — and a review that returns prose with no parseable
`VERDICT:` line is read as BLOCK, which stalls every land. Skipping the review loudly
is the honest failure: the dispatcher says so on the run and lands on the gates alone.

`codex()` declares no resolver at all, and `headless: true` does not grant one: which
flag makes `codex exec` write without stopping to ask has not been run here against a
real conflicted worktree, and an unverified resolver fails worse than an unverified
reviewer — with a half-rebased worktree rather than a missing paragraph. `custom({
resolve })` is the escape hatch once you have verified it. No resolver simply means
the `[a]` option below is never offered.

A missing agent binary is fatal **before** anything is prepped. The alternative is N
worktrees each opening a terminal that prints "command not found", which reads as
"the sessions never came up" and sends you looking at the launcher.

### wrapCommand

Words prepended to the agent's command, so the launch becomes
`<wrap…> <agent…> "<opening prompt>"`.

```ts
wrapCommand: ["srt", "--settings", ".sandbox.json"]
wrapCommand: ["firejail", "--profile=slice.profile"]
wrapCommand: ["docker", "run", "--rm", "-it", "-v", "$PWD:/w", "img"]
```

See [Sandboxing](#sandboxing) for why this is a seam and not a policy.

## Where tickets come from

**The repo you are standing in.** Always, and there is nothing to configure.

`github()` runs `gh` with its working directory set to yours, and `gh` resolves
`{owner}/{repo}` from the git remote there. Run `azelf run` in your app and you get
your app's issues; run it in a different repo and you get that repo's. The package
carries no repo name, and azelf's own config names `github()` exactly like yours
does — which is the only reason running it inside azelf reads azelf's issues.

Ticket text is then **pulled into the worktree**, not left behind a network call.
Before a session launches, `slice-session.sh` fetches the issue body and writes it to
`.slice-ticket.md` in the prepped worktree. The session reads a local file. This
matters more than it looks: `gh` is the first thing a restrictive `wrapCommand`
breaks, and a slice that cannot read its own ticket is the whole tool defeated at
step one.

## The exclusive lock

Some paths cannot safely be edited by two slices at once — database migrations
against a single shared instance being the canonical case.

```ts
exclusiveLockPaths: ["db/migrations"]
```

Only one worktree may hold changes to these at a time. `db-lock-check.sh` diffs
against the base branch to work out who holds it; a second slice that touches them
cannot launch or commit until the first lands.

**Set this to `[]` and the lock becomes a no-op, which is right almost everywhere.**
It earns its place only when you have one live shared resource with no
point-in-time recovery, so that two concurrent migrations mean two agents mutating
production. That is the exception, not the pattern.

## When two slices touch the same file

While a run is polling, the dispatcher compares what each open slice has committed
and says so when more than one of them has changed the same file:

```
  ⚠ slices are editing the same files
     #18 #20  app/category/[id].tsx
     #19✓ #21  lib/categoryWindow.ts  tests/lib/categoryWindow.test.ts
     A land rebases, so edits that CLASH are already caught. These are
     the ones that apply cleanly and still disagree — worth a look while
     both are open. Uncommitted work is not visible here.
     ✓ = already landed, so the open one has to rebase over it.
```

**This is warn-only, and it is about the soft case.** Landing rebases the slice
onto the base branch, so two slices whose edits to one file textually conflict
already fail loudly, at land time, with the slice parked and the reason on screen.
What nothing caught before is the pair that both apply cleanly and still disagree —
two agents restyling the same component, or adding the same helper twice under
different names. A rebase is happy with that; a reviewer six commits later is not.

Three properties worth knowing:

- **It cannot run at plan time.** Nothing knows which files a ticket will touch
  before its agent writes the code — the ticket names an outcome, not a file list.
  Once a slice has commits the question is a `git diff --name-only`, and that is
  why the check lives in the poll loop.
- **Uncommitted work is invisible.** Silence means "no overlap in what has been
  committed", never "no overlap". A slice that has been running for twenty minutes
  without a commit contributes nothing to the report.
- **It prints once per change, not once per round.** A warning reprinted every 30
  seconds teaches you to skip it by the third time.
- **A landed slice stays in the report.** Its files are kept for the rest of the
  run and marked `✓`. This was originally the other way round — a landed slice
  dropped out for free, because `base...branch` is empty once it has landed — and
  that was exactly backwards. A land is what MOVES the base branch, which is what
  forces every open slice to rebase over the landed files. In `consumer-a`'s first
  wave the report named `#19 #20 app/CreateCategory.tsx`, `#20` landed, the line
  vanished, and the very next thing that happened was `#19` failing to rebase onto
  that file. The report went quiet at the moment it became useful. A group whose
  members have *all* landed is dropped, though — the base branch reconciled those.

It never blocks a land. Two slices touching one file is often correct — a barrel
file, a lockfile, the same test helper — and the dispatcher cannot tell which of
those it is looking at. Deciding is yours; noticing is its job.

### Quieting the paths that never matter

`overlapIgnore` in `slice.config.ts` takes path patterns the report should skip —
`*` inside one segment, `**` across them, a trailing `/` for everything under a
directory:

```ts
overlapIgnore: ["bun.lock", "lib/i18n/locales/*.json"],
```

Use it for paths where two slices touching one file tells you nothing because
their edits cannot interact: a lockfile, generated output, a locale catalogue each
slice adds its own keys to.

**Do not use it for a file every slice appends to** — a changelog, a manual-test
document, anything where each slice adds a numbered entry at the end. Those look
like the noisiest possible entry (every slice, every wave, the same path) and they
are the one file that collides *by construction*, because two appends at one anchor
conflict every time. `consumer-a`'s first wave reported four shared files: three
were locale catalogues that merged cleanly, and the fourth was `TESTING.md`, which
was the only real conflict of the four. Ignoring by how often a path shows up would
have hidden precisely the one worth reading.

## When a slice will not land

The dispatcher's promise is that you do not have to watch it. The moment that
promise breaks is when something needs a decision only you can make — so it asks,
once, with the reason on screen:

```
  ✗ #14 did not land — the spec review says BLOCK
     worktree: /…/repo-ticket-14
     [r] retry now   [f] land anyway   [p] park it   [q] stop the run
```

All four failure paths go through that question: a failed rebase, red gates, a
blocking review, or `slice-land.sh` refusing a branch that is not fast-forwardable.
Non-interactive runs (`-y`, or no TTY) park automatically, which loses nothing and
lands nothing unreviewed.

### Letting an agent resolve a rebase conflict

One of those four is mechanical, and it is the one a wave produces by construction:
two slices in one feature area both edited one file, the first landed, and the second
now cannot rebase. The overlap report predicts this correctly and there is nothing to
do with the prediction — retry re-fails, land-anyway is dangerous, park defers. So a
rebase conflict gets a fifth option:

```
  ✗ #19 did not land — the rebase onto the base branch failed
     worktree: /…/repo-ticket-19
     conflict: lib/categoryWindow.ts  tests/lib/categoryWindow.test.ts
     [a] let an agent resolve it   [r] retry now   [f] land anyway   [p] park it   [q] stop the run
     what now? [a/r/f/p/q] a

  resolving #19's conflict with master (2 files) …
     ✓ rebased onto master, clean, no markers left — the gates run next
     ⚠ lib/i18n/locales/es.json was in the diff before and is not now
     transcript: /…/.slice-reviews/conflict-19.md
```

The agent is given the conflicted files, **this slice's ticket body**, and the commits
it is rebasing over — both intents, so it can tell what the two sides were each trying
to do — plus rules that are not advice: "keep both sides" is valid only when git's
`=======` falls on a block boundary, never resolve by discarding a side, and stop and
say so if the two genuinely cannot coexist. That first rule is there because a blind
union resolution of exactly this conflict put `=======` inside a `describe(...)` body
and produced `error TS1005: '}' expected` across ten files.

**Nothing takes the resolver's word for it.** When it returns, the dispatcher checks
the worktree itself: no rebase still in progress, `git status` clean, the base branch
actually an ancestor of `HEAD`, and no conflict markers left in any changed file. Then
the ordinary gates and the spec review run, unchanged — a resolution is held to
exactly the standard the code it is fixing was. Any of those failing means the resolution is thrown
away — `git rebase --abort`, and a `reset --hard` back to the commit the branch was
on if the resolver had already finished the rebase, so "the branch is as it was" is
true even when there was no rebase left to abort — plus a saved transcript and the
same `[r/f/p/q]` question with the reason named. One attempt per branch head: a failed resolution parks, and only a new
commit makes the slice eligible again.

Files that were in the slice's diff before and are not after are **reported, never
gated**. A legitimate resolution can drop a file — the base branch may already have
made the same change — but so can a resolver that quietly deleted the slice's work,
and telling those apart is a human reading one line.

Under `--auto` this happens without asking, because `--auto` already lets an unwatched
agent write code that reaches the base branch gated only by the gates and the review,
and a resolution passes through the same gates and the same review of the rebased
diff. It is strictly less exposure than the slice it is fixing. `--no-auto-resolve`
opts out, and the honest counter-argument is worth knowing: a bad resolution is harder
to spot in review than bad new code, because the diff reads as somebody else's work.

**A parked slice is retried when, and only when, its branch moves.** That condition
is the whole mechanism: it is exactly when the answer could be different, and exactly
what happens when you go and fix the thing. Go commit in the worktree; the next round
picks it up without being told.

This replaced a real loop. A blocking spec review used to fail the land, leave the
ready marker on disk, and have the next round re-run the gates and both reviews
against the identical diff — for the life of the run. One run spent about an hour of
review calls that way before anyone noticed. A verdict on an unchanged diff cannot
change, so retrying it was never optimism.

The run ends by naming every parked slice and exits non-zero, because "the run
ended" and "the work is done" are different things.

## In a coding agent

`init` writes two prompt-shaped files into the repo, so every session in the project
gets the same contract:

- **`.claude/commands/azelf.md`** → `/azelf`. The dispatcher side: plan the waves,
  open the sessions, land what is ready, and the two failure modes worth knowing
  before you use `--auto`.
- **`.claude/skills/slice/SKILL.md`** → the `slice` skill. The session side, for an
  agent working inside a slice worktree: read `.slice-ticket.md`, build only that,
  commit with explicit paths, run the gates, and run `slice-done.sh` **only** if they
  are green. `startPrompt` names this skill.

`azelf init --codex` also writes `/azelf` to `~/.codex/prompts/azelf.md`, frontmatter
stripped. That path is from Codex's documented layout and has not been verified here.

Both are yours once written.

## Sandboxing

There isn't one, and that is the honest state. `wrapCommand` is the seam.

What was removed: a ~90-line macOS Seatbelt profile for
`@anthropic-ai/sandbox-runtime`, pinned to its 0.0.75 settings schema, tuned to one
machine's toolchain layout, and documented in its own comments as breaking
interactive input — so the recommended state was already off. A default profile that
is OS-specific, version-pinned and known-broken is worse than none.

One finding from that era survives as a warning, because any restrictive wrapper hits
it: **under Seatbelt `gh` cannot work at all.** It is a Go binary, Go on macOS verifies
TLS through the system verifier, and that needs the `trustd` mach service Seatbelt
blocks — `x509: OSStatus -26276`. The ticket is therefore fetched and written to
`.slice-ticket.md` before any wrapper is entered, which is why a sandboxed slice can
still read its own ticket.

## Runtime and limitations

**bun, not node.** `slice-run.ts` uses `prompt()` (a bun global with no node
equivalent) and top-level `await` with no build step, and the shell half reads the
config through `bun scripts/slice-config.ts --sh`, which makes bun a dependency of
*committing* as well as dispatching. Shipping this compiled, with a `readline`
prompt, is known work and not yet done — it is the single thing standing between
this and a project that does not already have bun.

That has one consequence worth stating up front: **a Python project still needs bun
on PATH**, because the loader reads a TypeScript config and the shell bridge shells
out to it. The gates themselves are just argv, so pytest and ruff are no harder to
express than vitest and biome.

Known gaps, stated plainly:

- **`tmux()` has never been run end to end.** It is written and unit-tested; it has
  not driven a real session.
- **The Codex prompt path is unverified.** `~/.codex/prompts/azelf.md` comes from
  documentation, not from a working install here.
- **`github()` is the only tracker.** The contract is five methods and the seam is
  real, but nothing else has been written against it.
- **macOS is the tested platform.** The shell is bash 3.2 compatible and should work
  on Linux; `warp()` obviously will not.

## Troubleshooting

**Every gate fails in every worktree, but the main checkout is clean.**
Something gitignored is missing from the worktree. `git worktree add` never
populates ignored files. Add it to `provisionCopy`.

**A gate fails the land with "wrote to the worktree".**
That gate is not read-only. `--apply`, `--write`, `--fix` and `format` all rewrite
the tree. Use the checking form and keep the writing form in `format.sh`.

**`gh` fails with `x509: OSStatus -26276`.**
You are inside a sandbox that blocks `trustd`. See [Sandboxing](#sandboxing).

**Sessions never come up.**
Check the agent binary is on PATH — though the dispatcher should have refused
before prepping anything. Then check the launcher: `manual()` prints commands
rather than opening anything, and it is the default.

**A ticket never leaves the plan.**
It has an open blocker. `azelf run --plan` prints the reason for every held ticket.

**Marker files show up as untracked.**
`init` writes them to `.git/info/exclude`, which is per-checkout and not inherited
by a fresh clone. Re-run `azelf init` there.

## Repository layout

```
bin/azelf.ts            the CLI: init, run, hook
index.ts                the public surface a slice.config.ts imports
scripts/
  slice-run.ts          the dispatcher — waves, launching, landing, escalation
  slice-config.ts       the loader: finds and validates slice.config.ts
  slice-gates.ts        the gate contract and its three shapes
  slice-tracker.ts      the tracker contract and github()
  slice-overlap.ts      which live slices are editing the same files
  slice-launcher.ts     the launcher contract, manual/warp/tmux, autostart probe
  slice-agent.ts        the agent contract, claude/codex/custom
  slice-preset.ts       stack detection for init
  slice-init.ts         markers, shims, generated files, the rc hook
  *.sh                  the shell half: session, land, done, commit, lock, format
tests/scripts/          178 unit tests across the seam modules
docs/extraction-plan.md how this became a package, and what each seam cost
```

Gates for this repo itself:

```sh
bun run test        # vitest
bunx tsc --noEmit
bunx biome check .
```

## Design notes

### Why projects are called `consumer-a`

The comments record real incidents, and an incident is only worth writing down if
you can tell which project it happened in. The projects are private, so they get
opaque identifiers here and the mapping is kept out of this repo.

Where a name was doing real work, the comment states the PROPERTY instead — "one
live shared database with no point-in-time recovery" rather than any project name.
That is both less identifying and more useful to a reader who has access to neither
repo.

### Why the comments are so long

They encode incidents. The `.gitignore` fingerprint finding, the two zsh variable
traps in `db-lock-check.sh`, the tsc baseline that blamed a slice for errors
already on the base branch, the tree-wide formatter that rewrote 891 files under a
live session. Carry them with the code; a rewrite would have to relearn every one.

### Why a `.ts` config and not JSON

Three of the five seams need functions — a gate's `normalize`, a tracker's methods,
a launcher's `open`. JSON cannot carry them, and a plugin-name-plus-options scheme
would have to grow an escape hatch for every project that differs in shape. The
config is code because the seams are code.

## License

[MIT](LICENSE). Use it, change it, ship it in something closed — keep the copyright
notice and it is yours to do as you like with. Provided as is: `--auto` rebases and
fast-forward-merges real branches unattended, and that is your call to make.
