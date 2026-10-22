# A repo that is not a bun project can run azelf

**Status:** DONE — both phases landed 2026-10-22 · **Written:** 2026-10-22
**Companion:** consumer-b's adoption analysis, written in a consumer-b session on
2026-10-22 and not committed anywhere. Its other findings are under "Not in this plan"
and "What the consumer does itself".

Written so it can be picked up cold. Tick the boxes as they land and add the commit hash
after the heading. Line numbers are as of `b77b291`, without the uncommitted Phase 1 work.

## What happened

consumer-b wants azelf for two repos: a Python backend with no `package.json`, and a
web frontend on npm with only `package-lock.json`. Neither can take azelf as a
dependency. The backend has no package manager for it. In the frontend, adding it to
`package.json` without updating `package-lock.json` breaks `npm ci` in CI. So azelf runs
from a checkout, found through `AZELF_DIR`. Two things stop that before the first ticket
runs.

1. **The install step was always `bun install`.** That was in `slice-session.sh:363`
   after the prep, and `slice-run.ts:4096` after a rebase.
   - In the Python repo, bun exits 1 because there is no `package.json`. The prep fails
     and no session starts.
   - In the npm repo, bun migrates the lockfile and writes a `bun.lock` that git does
     not track. The worktree is dirty before the agent starts, and `slice-done.sh`
     refuses a dirty tree. The dependencies bun resolves are also not the ones `npm ci`
     would install, so the gates judge a tree that CI never sees.

2. **The config does not load without the package in `node_modules`.** `slice.config.ts`
   imports `@chintonicc/azelf`, and the loader loads the file with
   `await import(configPath)` (`slice-config.ts:606`). Bun resolves that name from the
   config's own directory.
   - Reproduced on `b77b291` with bun 1.3.5: a scratch git repo holding only azelf's
     own `slice.config.ts` and a `pyproject.toml`, then
     `bun <azelf>/scripts/slice-config.ts --sh`. Result: `error: Cannot find module
     '@chintonicc/azelf' from '<repo>/slice.config.ts'`.
   - The shims find the package through `AZELF_DIR`, but the loader they call fails
     right after.
   - The tests never hit this: `fixture.ts:231-236` writes the config with the absolute
     path to `index.ts`. consumer-a resolves the name through `node_modules`, and azelf
     through its own package name.

## Decisions this plan makes

- **The lockfile decides the install step, and `install` in the config overrides it.**
  - `bun.lock` → `bun install` after a prep, `bun install --frozen-lockfile` after a
    rebase. These are today's commands, so consumer-a sees no change.
  - `pnpm-lock.yaml`, `yarn.lock` → the frozen install. `package-lock.json` → `npm ci`.
  - No `package.json` → nothing. A `package.json` without a lockfile → bun's two
    forms, as today. The frozen one with no lockfile installs and writes no lockfile
    (bun 1.3.5).
  - `install: []` means install nothing, chosen on purpose. A configured command is
    used as given in both phases.
- **The prep reads the main checkout's lockfile, and the reinstall reads the
  worktree's.** The shell bridge runs in the main checkout and does not know the
  worktree. A fresh worktree is cut from the base, so the two lockfiles are the same.
- **The loader points `@chintonicc/azelf` at the package that is running.** It does not
  use whatever `node_modules` holds.
  - Mechanism: a Bun runtime plugin whose `onLoad` rewrites the name in the config's
    source text before Bun resolves it.
  - `onResolve` does not work for this. It was tried on bun 1.3.5, and the bare name
    still failed. The `onLoad` rewrite was tested: it loaded azelf's own config from a
    repo without `node_modules`.
  - For consumer-a this is the same copy in the normal case. In the sibling-checkout
    case (`AZELF_DIR` set) the config used to load `node_modules`' copy while the
    scripts ran the checkout's. Now both are one version.
- **Only the config file is rewritten,** not the modules it imports. A config that is
  split across helper files imports the package in `slice.config.ts` only. The README
  says so.
- **Not a symlink that init writes into `node_modules`.** `npm ci` deletes
  `node_modules` in the main checkout, so the link would be gone after the next install.
  In the Python repo it would be an untracked directory. **Not tsconfig `paths` either:**
  that needs a `tsconfig.json` in a Python repo.

## Phase 1 — the install step follows the lockfile — `137df67`

State when this was written: uncommitted in the main checkout on `b77b291`, written by
another session that was then stopped.
- New: `scripts/slice-install.ts`, `tests/scripts/sliceInstall.test.ts`.
- Changed: `slice-config.ts`, `slice-config.sh`, `slice-session.sh`, `slice-run.ts`,
  `slice-preset.ts`, `README.md`, `slicePreset.test.ts`, `sliceRun.test.ts`.

If it was committed in the meantime, review that commit instead. Run `git status` and
`git log` first.

- [x] **1a. Review it against the decisions above.** Check these points in particular:
  - **consumer-a is unchanged.** A `bun.lock` checkout gets `bun install` at prep and
    `bun install --frozen-lockfile` at reinstall, and a test pins both.
  - **`install: []` and a repo with no `package.json`.** The prep prints the reason
    (`SLICE_INSTALL_WHY`), and a reinstall leaves nothing owed.
  - **A rebase that moves `package-lock.json`** runs the npm command in the worktree.
    A failing install parks the slice and names the command that failed, not
    `bun install`. If `sliceRun.test.ts` has no test for this, add one with a fake
    command.
  - **The empty `SLICE_INSTALL` array** survives `set -u` under `/bin/bash` 3.2. The
    count guard is there; the session tests prove it under that shell.
  - **`shellAssignments` calls `installFor` twice.** One call is enough.
  - **No consumer is named** in the new text. Scan it before committing.
- [x] **1b. Gates and commit.** Run the suite under `/bin/bash` 3.2, then `bunx tsc
  --noEmit` and biome on the changed files. Commit Phase 1 with this plan.

  *Proof:*
  - `sliceInstall.test.ts`, the prep tests in `sliceRun.test.ts` and the preset tests.
  - The prep test for a repo with no `package.json` and the one for a configured
    command should fail on `b77b291`. Check that they do.

  *What the review found:*
  - `installFor` was called twice in `shellAssignments`; now once.
  - The two rebase tests still pinned the old message, without the command.
  - The reinstall for a `package.json` with no lockfile had become plain
    `bun install`, which writes a `bun.lock` right before the gates. It is frozen
    again, as before.
  - Three rebase tests added: `npm ci` with a fake `npm` on `PATH`, a failing
    `npm ci` that parks and names it, and `install: []`.
  - The round-line test passed on `b77b291` only by accident. After its fake session
    stops, the relaunch's prep failed on `bun install` because the fixture has no
    `package.json`, and the slice dropped to queued. Now the prep succeeds, so the
    test sets `install: ["false"]` to make that failure deliberate.
  - The ten new or changed install tests in `sliceRun.test.ts` fail on `b77b291`. The full
    suite passes under `/bin/bash` 3.2.57, the only bash on `PATH`.

## Phase 2 — the config loads without the package in `node_modules` — `dc29b0e`

- [x] **2a. The loader rewrites the package name.** In `slice-config.ts`, before
  `await import(configPath)`, register a plugin with `Bun.plugin`.
  - Its `onLoad` filter matches `configPath` exactly, as an escaped regex.
  - It reads the file and replaces the package name in both quote styles:
    - `@chintonicc/azelf` → the JSON string of `join(ownRoot, "index.ts")`;
    - `@chintonicc/azelf/package.json` → `join(ownRoot, "package.json")`.

    `ownRoot` is in `slice-version.ts:17`; check that importing it creates no cycle.
    These are the only two exports in `package.json`. Any other subpath is left alone
    and fails with Bun's own message, as it does now.
  - It returns the rewritten text with `loader: "ts"`.
  - The comment says why: a repo with no azelf in `node_modules`, why `onLoad` and not
    `onResolve`, and why the running package.
- [x] **2b. README.** Two additions:
  - **Next to the paragraph on how shims resolve the package:** a repo that cannot
    take azelf as a dependency runs it from a checkout with `AZELF_DIR`. The config's
    import then points at that checkout. Only `slice.config.ts` is rewritten.
  - **In the Python section:** such a repo needs bun on `PATH` and `AZELF_DIR`, and
    runs the CLI as `bun $AZELF_DIR/bin/azelf.ts`.

  *Proof:* a new `tests/scripts/sliceConfigLoad.test.ts`.
  - A temp git repo outside the package, with no `node_modules`. Its `slice.config.ts`
    imports `@chintonicc/azelf` by name: one value import in double quotes, one
    `import type` in single quotes.
  - `bun <AZELF>/scripts/slice-config.ts --sh` run there exits 0 and prints
    `SLICE_BASE_BRANCH=`. This fails on `b77b291` with `Cannot find module`.
  - A config that imports an unexported subpath still fails, and the error names it.
  - The rest of the suite (absolute path in `fixture.ts`) passes unchanged.

  *Hand check:* make a scratch repo with only a `pyproject.toml` and a git remote,
  then:
  - `AZELF_DIR=<azelf> bun <azelf>/bin/azelf.ts init`. Read what it writes, in
    particular any machine-specific fallback path in the shims.
  - `./scripts/slice-config.sh` gives the values.
  - A prep with `install: []` prints `no install step`.

  *What building it found:*
  - Bun hands `onLoad` the path with symlinks resolved, but with the case as it was
    typed. On macOS `/tmp` → `/private/tmp`, and `~/documents` stays lower case
    while `realpathSync` gives `Documents`. An exact filter on either form alone
    misses the other. The filter takes both forms and ignores case, and a test
    loads the config through a symlinked `SLICE_CONFIG`.
  - vitest runs under node, where there is no `Bun`. The plugin is only
    registered under bun. `sliceTabTitle.test.ts` imports the loader in vitest.
  - `ownRoot` comes from `slice-version.ts`, which imports only node modules, so
    there is no cycle.
  - All four tests in `sliceConfigLoad.test.ts` fail on `137df67` with
    `Cannot find module`.
  - Hand check, 2026-10-22, passed:
    - `init` wrote the shims with a fallback to the absolute path of the checkout
      `AZELF_DIR` named, and printed a note that it is machine-specific. So run
      `init` with `AZELF_DIR` set to the checkout that slices should run.
    - With `AZELF_DIR` unset, `slice-config.sh` gave `SLICE_INSTALL=()` and `no
      package.json — nothing to install` through that fallback.
    - With a stub tracker, `slice-session.sh 40 --prep-only` printed `no install
      step (install: [] in slice.config.ts)` and left a clean worktree.
    - The shims' error for a missing package said "run 'bun install' here", which
      is the wrong advice in such a repo. Fixed after the plan: it says that only
      where package.json lists azelf. Otherwise it says to set `AZELF_DIR`, or,
      when `AZELF_DIR` is set, that it points at no package. Existing shims
      change on the next `azelf init`.

## Order and cost

Phase 1 goes first. It is already written; what remains is the review, possibly one
reinstall test, and the commit. Both phases change `slice-config.ts`, so Phase 2 starts
on Phase 1's commit. Phase 2 is one block in the loader, one test file and two README
paragraphs.

## Not in this plan

- **Landing without the base branch checked out in the main checkout,** for example
  `push <branch>:<base>` after an ancestor check against `origin/<base>`. This is bigger
  than it looks:
  - the dispatcher rebases onto the local base branch (`slice-run.ts:2882`);
  - the baseline gate compares against the main checkout (`baselineDir: repoRoot`,
    `:2794`);
  - slices are cut from the local base branch.

  All three would have to move to `origin/<base>`. consumer-b's backend gives azelf its
  own clone instead (see below).
- **CI as a gate.** This needs no code: a gate that pushes `HEAD` to the ticket branch
  and waits for the CI run on that SHA. Lands are fast-forward only, so the SHA that
  lands is the one CI passed. The gate lives in the consumer.
- **A command after the land** (`afterLand`), such as a health check after a deploy.
  Until a consumer runs unattended, the person who starts the land does the check.
- **Blockers across two repos.** There is one dispatcher per repo, so a ticket in one
  repo cannot wait on a ticket in the other.
- **Python manifests in `INSTALL_MANIFESTS`** (`pyproject.toml`, `uv.lock`). A configured
  Python install does not run again after a rebase. consumer-b's backend installs
  nothing.
- **A `package.json` without a lockfile** still got `bun install` at prep, which
  wrote an untracked `bun.lock`. Fixed after the plan: it gets
  `bun install --frozen-lockfile` in both phases, which writes none.

## What the consumer does itself

consumer-b (two repos; the mapping is in `CONSUMERS.local.md`):
- **azelf comes from a checkout of its own,** not from the azelf checkout you develop
  in. Otherwise every slice runs your uncommitted edits. For example,
  `git worktree add ../azelf-run main` with `AZELF_DIR` pointing at it, updated with
  `git -C ../azelf-run pull --ff-only` after a phase lands. Make `azelf` an alias for
  `bun $AZELF_DIR/bin/azelf.ts`. Don't use `bun add`.
- **`azelf init` in both repos,** then commit the shims and the `.claude/` files after
  reading them. In the frontend, check that its CRLF check over `scripts/` passes on
  the shims.
- **Frontend:** leave `install` out, and the lockfile decides `npm ci`. If its
  `tsconfig` or linter covers the repo root, exclude `slice.config.ts` from them: with
  no azelf in `node_modules`, tsc cannot resolve the import.
- **Backend:**
  - `install: []`. The gates call the main checkout's `.venv` Python by absolute path.
  - azelf gets its own clone on `main` with `.env` and `.venv`. It must be a separate
    `git clone`, not a `git worktree` of the checkout a person works in, because git
    will not check out `main` twice.
  - The CI gate script lives in that repo.
  - No `--auto`.
- **As consumer-b actually set it up (2026-10-22, on `137df67`):**
  - One dedicated clone per repo, used only by azelf and on `main`. Nobody runs an
    install in their main checkouts.
  - In each clone, `node_modules/@chintonicc/azelf` is a symlink to a plain clone of
    azelf at the landed commit. The bare import and the shims both resolve through
    it, also from a new tab with no `AZELF_DIR`. The symlink this plan rejected is
    therefore fine in a clone where nothing runs `npm ci`. Phase 2 is what a
    checkout without one needs.
  - Nothing azelf writes is committed there. The shims, `.claude/` and
    `slice.config.ts` are untracked, listed in `.git/info/exclude`, and copied into
    each worktree through `provisionCopy`. The copies keep their exec bit.
  - Verified: `npm ci` at prep. Both suites green and read-only as gates (29 s and
    81 s). Both sessions launched by the hook.
- **consumer-a:** nothing changes for it. Bump it after Phase 2 anyway (`bun install
  --force`, because bun reuses a cached SHA), so that config and scripts are one
  version there too. Neither phase changes shims or skills, so no `azelf init`.
