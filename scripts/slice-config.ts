#!/usr/bin/env bun
/**
 * Loader and shell bridge for `slice.config.ts`.
 *
 *   import { config, branchFor, worktreeFor } from "./slice-config";   # from TS
 *   eval "$(bun scripts/slice-config.ts --sh)"                         # from bash
 *   bun scripts/slice-config.ts --tracker get 42                       # the tracker, from bash
 *
 * WHY THIS EXISTS
 * ---------------
 * The slice tooling is half TypeScript (`slice-run.ts`) and half bash
 * (`slice-session.sh`, `slice-land.sh`, `slice-done.sh`, `db-lock-check.sh`,
 * `session-commit.sh`), and both halves need the same six values. Two copies of
 * a setting is two copies that drift — and the way they drift here is silent:
 * the dispatcher builds `ticket/9`, the lander looks for `slices/9`, and the
 * failure surfaces as "no local branch — was it ever created?".
 *
 * So there is one source of truth (`slice.config.ts`), one reader (this file),
 * and the shell half gets its values by asking this file for them rather than
 * by holding its own copy. `--sh` prints shell assignments; `scripts/
 * slice-config.sh` is the two-line wrapper that evals them.
 *
 * The cost is one `bun` spawn per shell script invocation, ~30ms. That is paid
 * on every `session-commit.sh` run, which makes bun a hard dependency of
 * committing — acceptable here, where CLAUDE.md already mandates bun and every
 * other script in this directory calls it. Phase 5 of the extraction plan owns
 * the question of whether the extracted package can afford that.
 *
 * THE TRACKER BRIDGE (`--tracker <verb> <id> …`)
 * ---------------------------------------------
 * The tracker is an object of functions (scripts/slice-tracker.ts), so like the
 * gates it cannot travel through `--sh`. Unlike the gates, the shell half DOES
 * need it: slice-session.sh validates a ticket and writes its brief,
 * slice-land.sh closes it. Rather than have bash re-implement the graph with
 * its own `gh` calls — a second copy of the tracker, drifting — each of those
 * is one call into this file, which loads the config, picks the tracker and
 * answers in a shell-friendly shape (TSV, a bare integer, plain text).
 *
 * The cost is one bun spawn (~30ms plus the tracker's own call) per verb:
 * three in slice-session.sh's launch (get, open-blockers, brief), one in
 * slice-land.sh (close). Both are already paying for a `bun install` or a git
 * push, so this is noise there; it is NOT paid by session-commit.sh, which
 * never touches the tracker. What the bridge deliberately does not offer is
 * `listReady` or the raw blocker list — the shell has no consumer for either,
 * and the graph is the dispatcher's to read.
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { type Agent, claude } from "./slice-agent";
import type { Gate } from "./slice-gates";
import { type Launcher, manual } from "./slice-launcher";
import {
  type TicketId,
  type Tracker,
  idFromBranch,
  idPatternProblem,
  openBlockers,
  refFor,
} from "./slice-tracker";

export type SliceConfig = {
  /** Branch slices are cut from and land onto. */
  baseBranch: string;
  /** Branch name template. Must contain `{n}` and must round-trip. */
  branchPattern: string;
  /** Worktree location, relative to the repo root. `{repo}` and `{n}`. */
  worktreeDir: string;
  /** Issue label marking a ticket as runnable. */
  readyLabel: string;
  /** Paths only one worktree may hold changes to at a time. `[]` disables. */
  exclusiveLockPaths: string[];
  /** Gitignored files copied into each new worktree. */
  provisionCopy: string[];
  /**
   * Paths the overlap report leaves out. Optional; `[]` and omitted are the
   * same. `*` stays inside one path segment, `**` crosses them, a trailing
   * `/` means everything beneath a directory.
   *
   * For paths where two slices touching one file tells you nothing because
   * their edits cannot interact — a lockfile, generated output, a locale
   * catalogue each slice adds its own keys to.
   *
   * NOT for a file every slice APPENDS to. See `ignores()` in
   * scripts/slice-overlap.ts for why that is the exact opposite case, and for
   * the wave that made the distinction concrete.
   */
  overlapIgnore?: string[];
  /**
   * What a slice must pass before it lands, in order. Built from the shapes
   * in `slice-gates.ts`; every one must be read-only (see the contract there).
   * TypeScript-only — functions, so the shell bridge cannot carry them and no
   * shell script runs them. `slice-run.ts` is the only consumer.
   */
  gates: Gate[];
  /**
   * Where the tickets and their blocking edges live. Built from a constructor
   * in `slice-tracker.ts` (`github()` ships); see the contract there, in
   * particular what `close` must do. Its `idPattern` decides what a ticket id
   * looks like everywhere — argv, branch names, the round trip, the shell.
   * Functions, so `--sh` carries only its name, pattern and ref template; the
   * shell reaches the methods through `--tracker`.
   */
  tracker: Tracker;
  /**
   * How a prepped worktree becomes an open session. Built from a constructor
   * in `slice-launcher.ts`; `manual()` — print the command, open nothing — is
   * the default when this is absent, and `warp()` and `tmux()` ship. Its
   * `starts` field is what the shell bridge carries (as SLICE_LAUNCHER_STARTS):
   * `slice-session.sh` parks its flags for the autostart hook only when the
   * launcher starts sessions through that hook.
   */
  launcher?: Launcher;
  /**
   * Which coding agent a session runs, and which one reviews a diff before it
   * lands. Built from a constructor in `slice-agent.ts`; `claude()` is the
   * default and `codex()` ships. Only its `sessionCommand` crosses the shell
   * bridge — the review half is headless and belongs to the dispatcher.
   */
  agent?: Agent;
  /**
   * A command the agent's own command is run INSIDE, or `[]` — the default.
   *
   * This is what is left of the sandbox. The tooling used to carry a macOS
   * Seatbelt profile for @anthropic-ai/sandbox-runtime: pinned to that tool's
   * 0.0.75 settings schema, ~90 lines of allowRead/allowWrite/allowedDomains
   * tuned to one machine's toolchain layout, and documented in its own comments
   * as breaking interactive input so that the recommended state was already
   * "off". Shipping a default profile that is macOS-only, version-pinned and
   * known-broken is worse than shipping none, so it is gone.
   *
   * What replaces it is the seam and not the policy:
   *
   *   wrapCommand: ["srt", "--settings", ".sandbox.json"]
   *   wrapCommand: ["firejail", "--profile=slice.profile"]
   *   wrapCommand: ["docker", "run", "--rm", "-it", "-v", "$PWD:/w", "img"]
   *
   * The words are prepended to the agent's `sessionCommand`, so the launch
   * becomes `<wrap…> <agent…> "<opening prompt>"`. Supply your own profile;
   * this package has no opinion about what a safe one looks like on your
   * machine, which is precisely the thing the deleted profile got wrong.
   */
  wrapCommand?: string[];
  /** Opening instruction for a slice's session. `{n}` is the ticket. */
  startPrompt: string;
};

/**
 * The MAIN checkout of the CONSUMER repo — not the caller's worktree, and not
 * this package.
 *
 * Two separate corrections live in this one function, and dropping either one
 * has been a real bug.
 *
 * `import.meta.url` is wrong now. While this file was vendored in the project
 * it described, its own directory was the repo; installed as a dependency it
 * resolves to `node_modules/azelf`, whose git root is either absent or — worse,
 * if the package is a sibling checkout — a completely different repo whose
 * `master` the tooling would then try to land onto. So the anchor is the
 * WORKING DIRECTORY, which every entry point already guarantees: the shell half
 * documents "sourced after cd-ing to a checkout root", and the dispatcher runs
 * from one.
 *
 * `--git-common-dir` is the older correction and still load-bearing. Every
 * slice worktree is a full checkout, so cwd is frequently a worktree rather
 * than the main tree, and the worktree's own path is the wrong answer: from
 * `consumer-a-ticket-9` the naive version computed `consumer-a-ticket-9-ticket-9`,
 * missed the reuse check, and tried to add a second worktree on a branch
 * already in use. See slice-session.sh's `common_dir` block.
 */
function findRepoRoot(): string {
  const here = resolve(process.env.SLICE_REPO_ROOT ?? process.cwd());
  try {
    const proc = spawnSync(
      "git",
      ["-C", here, "rev-parse", "--path-format=absolute", "--git-common-dir"],
      { encoding: "utf8" },
    );
    if (proc.status === 0 && proc.stdout.trim()) {
      return dirname(proc.stdout.trim());
    }
  } catch {
    // Not a git checkout, or git is unavailable. `here` is the honest answer.
  }
  return here;
}

export const repoRoot = findRepoRoot();
export const repoName = basename(repoRoot);

/**
 * Fails loudly and specifically. A config typo that reaches the tooling turns
 * into an unlandable branch or a lock that never engages, and neither says
 * "your config is wrong" on its own.
 */
function validate(c: SliceConfig): SliceConfig {
  const bad = (why: string): never => {
    throw new Error(`slice.config.ts: ${why}`);
  };
  if (!c.baseBranch) bad("baseBranch must be a non-empty branch name");
  if (!c.branchPattern.includes("{n}")) {
    bad("branchPattern must contain {n} — it is the ticket id");
  }
  if (!c.worktreeDir.includes("{n}")) {
    bad("worktreeDir must contain {n}, or every slice shares one directory");
  }
  if (c.branchPattern.split("{n}").length !== 2) {
    bad("branchPattern must contain {n} exactly once, or it cannot round-trip");
  }
  if (!c.readyLabel) bad("readyLabel must be a non-empty label name");
  if (c.overlapIgnore !== undefined) {
    if (!Array.isArray(c.overlapIgnore)) {
      bad("overlapIgnore must be an array of path patterns, or left out");
    }
    for (const [i, p] of c.overlapIgnore.entries()) {
      if (typeof p !== "string" || !p) {
        bad(`overlapIgnore[${i}] must be a non-empty path pattern`);
      }
      // A leading `./` or `/` never matches: git prints repo-relative paths
      // with neither, so such a pattern would silently ignore nothing.
      if (p.startsWith("/") || p.startsWith("./")) {
        bad(
          `overlapIgnore[${i}] ("${p}") must be repo-relative — no leading / or ./`,
        );
      }
    }
  }
  if (!Array.isArray(c.gates)) bad("gates must be an array of gates");
  for (const [i, g] of c.gates.entries()) {
    if (!g || typeof g.name !== "string" || typeof g.run !== "function") {
      bad(
        `gates[${i}] is not a gate — build it with exitCode, exitCodeOverFiles or baselineDiff from scripts/slice-gates.ts`,
      );
    }
  }
  // Deliberately NOT rejected: `gates: []`. It means "land whatever is
  // committed", which is a legitimate choice for a repo with no toolchain, and
  // the dispatcher prints it in its startup summary so it is never a surprise.
  const t = c.tracker;
  if (!t || typeof t !== "object") {
    bad(
      "tracker is missing — build it with github() from scripts/slice-tracker.ts",
    );
  }
  for (const m of ["listReady", "get", "blockers", "body", "close"] as const) {
    if (typeof t[m] !== "function") {
      bad(
        `tracker.${m} is not a function — a tracker is the five-method contract in scripts/slice-tracker.ts`,
      );
    }
  }
  if (!t.name) bad("tracker.name must be a non-empty string");
  if (typeof t.idPattern !== "string") {
    bad("tracker.idPattern must be a regex source string");
  }
  const problem = idPatternProblem(t.idPattern);
  if (problem) bad(`tracker.idPattern ${problem}`);
  if (typeof t.refTemplate !== "string" || !t.refTemplate.includes("{n}")) {
    bad(
      "tracker.refTemplate must contain {n} — it is how a ticket is written for humans",
    );
  }
  // Absent is fine — that is `manual()`. Present and malformed is not.
  const l = c.launcher;
  if (l !== undefined) {
    if (!l || typeof l !== "object" || typeof l.open !== "function") {
      bad(
        "launcher is not a launcher — build it with manual(), warp() or tmux() from scripts/slice-launcher.ts, or leave it out for manual",
      );
    }
    if (!l.name) bad("launcher.name must be a non-empty string");
    if (l.starts !== "command" && l.starts !== "marker") {
      bad(
        `launcher.starts must be "command" or "marker" (got ${JSON.stringify(
          l.starts,
        )}) — slice-session.sh decides whether to park flags from it`,
      );
    }
    if (!(Number.isFinite(l.startingGraceMs) && l.startingGraceMs > 0)) {
      bad("launcher.startingGraceMs must be a positive number of milliseconds");
    }
    if (typeof l.problem !== "function") {
      bad("launcher.problem must be a function returning a reason or null");
    }
  }
  // Absent is fine — claude() is the default, and a real one. Malformed is not.
  if (c.agent !== undefined) {
    const a = c.agent;
    if (!a || typeof a !== "object") {
      bad(
        "agent is not an agent — build it with claude(), codex() or custom() from scripts/slice-agent.ts, or leave it out for claude",
      );
    }
    if (typeof a.name !== "string" || a.name.length === 0) {
      bad("agent.name must be a non-empty string");
    }
    if (typeof a.problem !== "function") {
      bad("agent.problem must be a function returning a reason or null");
    }
    if (typeof a.review !== "function") {
      bad(
        "agent.review must be a function returning argv, or null when the agent has no headless mode",
      );
    }
    // Optional in a way `review` is not: absent means the dispatcher never
    // offers to resolve a conflict, which is the behaviour every agent had
    // before this capability existed. Present and not a function is still a
    // typo worth naming.
    if (a.resolve !== undefined && typeof a.resolve !== "function") {
      bad(
        "agent.resolve must be a function returning argv for a headless run WITH TOOLS, or null — leave it out entirely if the agent cannot edit files headlessly",
      );
    }
    if (
      !Array.isArray(a.sessionCommand) ||
      a.sessionCommand.length === 0 ||
      a.sessionCommand.some((w) => typeof w !== "string")
    ) {
      bad(
        "agent.sessionCommand must be a non-empty array of strings — the argv prefix the opening prompt is appended to",
      );
    }
  }
  if (c.wrapCommand !== undefined) {
    if (
      !Array.isArray(c.wrapCommand) ||
      c.wrapCommand.some((w) => typeof w !== "string")
    ) {
      bad("wrapCommand must be an array of strings, or left out entirely");
    }
  }
  return c;
}

/**
 * Where the consumer's `slice.config.ts` is.
 *
 * Searched upward from the repo root rather than imported by a fixed relative
 * path, because this package no longer lives inside the project it configures.
 * `SLICE_CONFIG` overrides it — that is how the tests point the loader at a
 * fixture, and how a repo that keeps its config somewhere other than the root
 * says so.
 *
 * The walk stops at the filesystem root and the error names both the directory
 * it started from and the fix. A missing config used to be impossible (it was a
 * static import, so it was a compile error); now it is a run-time condition,
 * and it is the FIRST thing a new consumer will hit.
 */
function findConfigPath(): string {
  const override = process.env.SLICE_CONFIG;
  if (override) {
    const p = resolve(override);
    if (!existsSync(p)) {
      throw new Error(`SLICE_CONFIG points at ${p}, which does not exist`);
    }
    return p;
  }
  let dir = repoRoot;
  for (;;) {
    const p = join(dir, "slice.config.ts");
    if (existsSync(p)) return p;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(
    `no slice.config.ts found in ${repoRoot} or any parent.
       run \`azelf init\` there, or set SLICE_CONFIG to its path.`,
  );
}

export const configPath = findConfigPath();

/**
 * Top-level await, deliberately. The config is a TypeScript module holding
 * FUNCTIONS — gates, a tracker, a launcher — so it cannot be read as data, and
 * its path is not known until run time, so it cannot be a static import. Every
 * importer of this file already awaits it through the module graph.
 */
const userConfig: SliceConfig = (await import(configPath)).default;

export const config: SliceConfig = validate(userConfig);
export const tracker: Tracker = config.tracker;
/** The configured launcher, or `manual()` — the default is a real launcher, not a missing one. */
export const launcher: Launcher = config.launcher ?? manual();
/** The configured agent, or `claude()` — the default is a real agent, not a missing one. */
export const agent: Agent = config.agent ?? claude();

/** `#42` on GitHub, `ENG-42` on Linear — whatever the tracker says. */
export const ref = (id: TicketId): string => refFor(tracker.refTemplate, id);

/** Is this argument a ticket id, by the tracker's own definition? */
export const isTicketId = (s: string): boolean =>
  new RegExp(tracker.idPattern).test(s);

/** `.split().join()` rather than `replaceAll`, which needs a newer lib target. */
const fill = (tpl: string, n: TicketId): string =>
  tpl.split("{n}").join(n).split("{repo}").join(repoName);

export const branchFor = (n: TicketId): string => fill(config.branchPattern, n);

export const worktreeFor = (n: TicketId): string =>
  resolve(repoRoot, fill(config.worktreeDir, n));

/**
 * The other half of `branchFor`, and the reason `branchPattern` is constrained
 * to one `{n}`. `slice-done.sh` runs inside a worktree knowing only its branch
 * name, and has to name the ticket back to you.
 *
 * What counts as an id in the middle is the tracker's `idPattern`, the same
 * one that guards argv in the dispatcher and the shell scripts and that
 * `slice_ticket_from_branch` in slice-config.sh tests with `=~`. One
 * definition, read in five places, so `ENG-123` either works everywhere or
 * is refused everywhere.
 */
export const ticketFromBranch = (branch: string): TicketId | null =>
  idFromBranch(config.branchPattern, tracker.idPattern, branch);

// ─── shell bridge ─────────────────────────────────────────────────────────
// Single-quote everything and escape embedded quotes the POSIX way, so a value
// containing a space, a `$` or a newline survives the eval intact. The start
// prompt is a full English sentence, so this is not hypothetical.

const shq = (s: string): string => `'${s.split("'").join(`'\\''`)}'`;
const shArray = (name: string, items: string[]): string =>
  `${name}=(${items.map(shq).join(" ")})`;

export function shellAssignments(): string {
  return [
    `SLICE_REPO_ROOT=${shq(repoRoot)}`,
    `SLICE_REPO_NAME=${shq(repoName)}`,
    `SLICE_BASE_BRANCH=${shq(config.baseBranch)}`,
    `SLICE_BRANCH_PATTERN=${shq(config.branchPattern)}`,
    `SLICE_WORKTREE_DIR=${shq(config.worktreeDir)}`,
    `SLICE_READY_LABEL=${shq(config.readyLabel)}`,
    `SLICE_START_PROMPT=${shq(config.startPrompt)}`,
    // The tracker's data, not its methods — those are behind --tracker.
    `SLICE_TRACKER_NAME=${shq(tracker.name)}`,
    `SLICE_TICKET_ID_PATTERN=${shq(tracker.idPattern)}`,
    `SLICE_TICKET_REF_TEMPLATE=${shq(tracker.refTemplate)}`,
    // The launcher's name and what its launch carries. `open` and `problem`
    // stay on the TS side — the shell never launches anything; it only needs
    // to know whether the autostart hook will, so it can park flags for it.
    `SLICE_LAUNCHER_NAME=${shq(launcher.name)}`,
    `SLICE_LAUNCHER_STARTS=${shq(launcher.starts)}`,
    // The agent's name, and the argv prefix a session is started with —
    // slice-session.sh appends the opening prompt as the final argument. The
    // review half never crosses: nothing in the shell reviews anything.
    `SLICE_AGENT_NAME=${shq(agent.name)}`,
    shArray("SLICE_AGENT_SESSION_CMD", agent.sessionCommand),
    // Prepended to the agent's command by slice-session.sh. Empty by default,
    // and an empty array is a legitimate value — see wrapCommand's comment for
    // what used to be here instead.
    shArray("SLICE_WRAP_COMMAND", config.wrapCommand ?? []),
    shArray("SLICE_EXCLUSIVE_LOCK_PATHS", config.exclusiveLockPaths),
    shArray("SLICE_PROVISION_COPY", config.provisionCopy),
  ].join("\n");
}

/**
 * The verbs the shell half needs, each answered in a shape bash can read
 * without jq. Exit 64 for a usage error, 1 for a tracker failure (message on
 * stderr, nothing on stdout — so a `$(…)` capture is empty, never half a line).
 *
 *   get <id>            state<TAB>ready<TAB>title   (ready: carries readyLabel)
 *   open-blockers <id>  the number of blockers still open, as an integer
 *   brief <id>          the .slice-ticket.md text — title, url, body
 *   close <id> <text>   close it, with that comment
 */
function trackerCli(args: string[]): never {
  const [verb, id, ...rest] = args;
  const usage = (): never => {
    console.error(
      "usage: slice-config.ts --tracker get|open-blockers|brief <id> | close <id> <comment>",
    );
    process.exit(64);
  };
  if (!verb || !id) usage();
  if (!isTicketId(id)) {
    console.error(
      `error: '${id}' is not a ${tracker.name} ticket id (expected ${tracker.idPattern})`,
    );
    process.exit(64);
  }
  try {
    switch (verb) {
      case "get": {
        const t = tracker.get(id);
        const ready = t.labels.includes(config.readyLabel);
        console.log([t.state, String(ready), t.title].join("\t"));
        break;
      }
      case "open-blockers":
        console.log(String(openBlockers(tracker.blockers(id)).length));
        break;
      case "brief": {
        const t = tracker.get(id);
        const body = tracker.body(id) || "(no body)";
        console.log(`# ${ref(id)} — ${t.title}\n\n${t.url}\n\n---\n\n${body}`);
        break;
      }
      case "close": {
        const comment = rest[0];
        if (comment === undefined) usage();
        tracker.close(id, comment as string);
        break;
      }
      default:
        usage();
    }
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  }
  process.exit(0);
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  if (argv[0] === "--sh") {
    console.log(shellAssignments());
  } else if (argv[0] === "--tracker") {
    trackerCli(argv.slice(1));
  } else {
    // Gates, the tracker and the launcher are functions; show their names
    // rather than dropping them silently.
    console.log(
      JSON.stringify(
        {
          ...config,
          gates: config.gates.map((g) => g.name),
          tracker: tracker.name,
          launcher: launcher.name,
        },
        null,
        2,
      ),
    );
  }
}
