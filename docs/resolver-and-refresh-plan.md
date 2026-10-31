# The resolver can run the checks, a red gate goes back to it once, a rebase refreshes what it moved, and the reviewer reads beyond the worktree

**Status:** complete · Phase 1 landed 2026-10-31 (0cfa1cc), Phases 2 and 3 built 2026-10-31, in one commit
**Written:** 2026-10-31
**Companion:** the still-open consumer-b entries of 2026-10-22: Backend #140/#139
(resolver refused every command), Frontend #105 (resolver merged a generated file by
hand, counter wrong, gates red, parked), Backend venv drift (suite red for every slice
after main raised the pins), Frontend #92/#94/#93 (spec reviewer sees only the
worktree). Two entries of that day are left out on purpose, see "Not in this plan".

Written so it can be picked up cold. Tick the boxes as they land and add the commit hash
after the heading. Line numbers are as of `547714a`.

## What happened

1. **The resolver resolves blind.** `claude -p --permission-mode acceptEdits`
   (`slice-agent.ts:154`) may edit but not run anything: in a headless run every Bash
   call is refused, and the prompt's rule 4 ("the project's checks pass",
   `slice-run.ts:3641`) asks for what it cannot do. On #139/#140 it wrote "every Python
   call in this session was refused" and handed back untested resolutions. They held;
   on #105 one did not.
2. **A red gate right after a resolution parks the slice** (`slice-run.ts:4741`), with
   the gate output in the log and nobody to act on it but a person. On #105 the fix was
   one regenerate command away.
3. **Generated output is merged by hand.** `scripts/meldungenInventar.json` carries a
   count; both sides lowered it by one, the resolver kept both entries and one side's
   count. Nothing re-runs the generator after a rebase. The same shape: a venv shared
   through the install step, pinned by `requirements.txt`, which main raised; every
   slice's suite was red for a reason none of them caused. `reinstallAfterRebase`
   (`slice-run.ts:4567`) already does exactly this for package manifests, by a fixed
   list of file names.
4. **The spec reviewer sees the worktree and nothing else.** A ticket that places half
   its facts in the other repo, or in a spec file outside the checkout, gets
   `UNVERIFIED:` for all of it, and the person at the dispatcher checks field names by
   hand.

## Decisions

- **Commands are configured, not derived.** Gates are functions
  (`Gate.run(ctx)`, `slice-gates.ts:92`); their commands are closed over. So
  `resolverCommands: string[]` names what the resolver may run, as command prefixes
  (`".venv/bin/python -m pytest"`, `"npm run test:alle"`). For `claude()` each
  becomes `Bash(<prefix>:*)` under `--allowedTools`. Verified on claude 2.1.314 with
  two prefixes, one containing spaces, each as its own argument, placed BEFORE `-p`:
  the flag is variadic and would otherwise swallow the prompt.
- **One repair round, on the files it was given.** When the gates are red right after
  a resolution (or a renumbering), the resolver is called once more with the gate's
  output, may edit the files the slice changes, and its edit is committed as its own
  commit (`fix: the resolution — the gates said …`) by the dispatcher, like a
  renumbering. The gates run again; red again parks, as before. Once: the commit moves
  the head, and the retry path (`azelf retry`) rebases clean and is not a resolution.
- **`refresh` is a list of `{ when, run }`**, run after a rebase that moved the base
  under the slice, when a file the base changed matches `when` (the overlap report's
  patterns: `*`, `**`, trailing `/`). Tracked changes it leaves are committed as one
  commit (`chore: refresh after the rebase — <what>`); a venv install leaves none. A
  failing `run` parks as a gate, and is owed on the retry, like a reinstall. It does
  not replace `install`: lockfiles keep their fixed list.
- **`reviewReadDirs` is `--add-dir`**, for `claude()`; the spec review's prompt names
  the directories, so the reviewer knows to look. The standards and plan reviews are
  about this repo and do not get them. Relative paths are from the repo root; a
  missing directory is a config error, because the point is a path the person knows.

## Phase 1 — the resolver can run the checks, and a red gate goes back to it once

- [x] 1a. `slice-agent.ts`: `ResolveOptions { commands: string[] }`,
  `ReviewOptions { readDirs: string[] }`; `resolve?(prompt, opts?)`,
  `review(prompt, opts?)`. `claude()` emits `--allowedTools Bash(<c>:*)…` before `-p`.
  `custom()` passes both through.
- [x] 1b. `resolverCommands?: string[]` in the config, validated like `afterLand`.
- [x] 1c. `resolvePrompt` rule 4 says what may be run, or that nothing can be and the
  gates run after. `resolveStops` and `renumber` pass the commands.
- [x] 1d. `gatesPass` keeps the failing gate's output per slice; `tryLand`: red gates
  after `resolved` → `repairResolution(t, failure)` → gates again.
- [x] 1e. Tests: `sliceAgent` argv shapes; the resolver's argv and prompt carry the
  commands; a gate red after a resolution is repaired, committed and green; a repair
  that strays or changes nothing is rejected and the slice parks; the config refuses a
  bad list.

### What building it found

- **The fake agent passes the options after the prompt** (`fixture.ts`): `$1` stays
  the prompt for every older test, and a fake that wants to know what it was allowed
  reads `$2…`.
- **`custom()`'s option types had to widen too**, not only `Agent`'s: a consumer's
  `resolve: (p, o) => …` is typed against `CustomOptions`.
- **A rejected repair also `git clean`s**: a stray new file is untracked, and
  `reset --hard` leaves it.
- **The repair's "changed nothing" comes after the stray check and the refusal**: a
  resolver that said `IRRECONCILABLE:` changed nothing by design, and that reason is
  the better one.

## Phase 2 — a rebase refreshes what it moved

- [x] 2a. `refresh?: { when: string[]; run: string[]; name?: string }[]`, validated.
- [x] 2b. `refreshAfterRebase(id, before)` after `reinstallAfterRebase` in `tryLand`;
  owed on failure; commits tracked changes; says what ran and why.
- [x] 2c. Tests: a base change matching `when` runs `run` and commits its output; no
  match runs nothing; a failing `run` parks and is retried; README.

### What building it found

- **The owed list is this process's.** A refresh that failed is owed on the retry within
  the run, as a reinstall is; a run restarted after the park finds the branch rebased,
  sees no base move, and runs nothing. The park line says to run the step by hand and
  commit, which is the path that does not depend on it.
- **"Nothing to commit" is said**, so a venv install that changes no tracked file is
  seen to have run.

## Phase 3 — the reviewer reads beyond the worktree

- [x] 3a. `reviewReadDirs?: string[]`, resolved against the repo root, must exist.
- [x] 3b. `askAgent` passes them; `reviewSpec`'s prompt lists them.
- [x] 3c. Tests: `claude().review` argv; the spec prompt names the directory; a missing
  directory is refused; README.

### What building it found

- **The directories are checked when the config loads**, so `azelf gates` in a worktree
  refuses too when one is gone. Accepted: the setting names a path the person keeps.
- **Phases 2 and 3 touch the same four files** and went in as one commit.

## Order and cost

Phase 1 is the largest: the agent seam, the prompt, and the repair round. Phases 2 and
3 are small. One commit each.

## Not in this plan

- **`--watch-labels`.** Re-planning mid-run touches the claims, the waves, the overlap
  report and the blockers, all of which take the ticket set as fixed. Running again is
  the answer, and it adopts the sessions that are running.
- **`azelf adopt <ticket> <ref>`.** Rare, and four commands by hand; worth a README
  recipe when it comes up again, not a command.
- **Giving the resolver a second round for a `BLOCK` from the review.** The review
  blocks on a resolved slice for a reason (the resolution was released by nobody); that
  is a person's call.

## What the consumer does itself

- consumer-b: pull azelf-run, set `resolverCommands` (the test command of each repo),
  `refresh` (backend: `requirements*.txt` → pip install; frontend: the inventory
  generator), and `reviewReadDirs` (the other repo's clone, the spec folder).
- consumer-a: bump the pin and run `azelf init`.
