#!/usr/bin/env bun
/**
 * Drive a whole plan's worth of slices from one command.
 *
 *   ./scripts/slice-run.ts                 # plan, confirm, then run to completion
 *   ./scripts/slice-run.ts --plan          # print the dependency tree and stop
 *   ./scripts/slice-run.ts 9 10 11 12      # an explicit ticket set
 *   ./scripts/slice-run.ts --max 2         # cap concurrent sessions
 *   ./scripts/slice-run.ts --once          # one round, then exit
 *   ./scripts/slice-run.ts --auto          # land without waiting for slice-done.sh
 *   ./scripts/slice-run.ts --no-start      # land at a bare prompt instead of starting work
 *   ./scripts/slice-run.ts --review        # review each slice before landing (implied by --auto)
 *   ./scripts/slice-run.ts --auto --no-review   # opt out of the review --auto implies
 *   ./scripts/slice-run.ts --gates 12      # run the landing gates on slice 12, land nothing
 *
 * Inside a finished slice, run ./scripts/slice-done.sh — this then re-runs the
 * gates, lands it, closes the ticket, and starts whatever that unblocked.
 *
 * WHY THIS EXISTS
 * ---------------
 * `to-tickets` produces a set of tickets with real blocking edges on GitHub,
 * and `slice-session.sh` runs exactly one of them. Between those two sits a
 * job nobody wants to do by hand: work out which tickets are runnable right
 * now, open that many terminals, and then keep noticing — for as long as the
 * plan takes — that landing one has unblocked two more.
 *
 * This is that middle. It reads the edges from GitHub, prints the tree, tells
 * you how wide the plan actually is, and then keeps a set of slice sessions
 * running until every ticket is closed.
 *
 * WHAT IT DELIBERATELY DOES NOT DO
 * --------------------------------
 * It never decides that a slice is FINISHED. docs/adr/0001 chose semi-manual
 * orchestration over sandcastle's headless run-and-auto-merge, because this
 * repo has a git-race history and a Supabase project with no PITR, and that
 * decision stands where it matters: an agent can leave a branch committed,
 * clean and gate-green while the ticket is half-built, and no automated check
 * can tell the difference. A human says so, by running slice-done.sh.
 *
 * What it does do, once you have said so, is the clerical half: re-run the
 * gates independently, fast-forward master, push, remove the worktree, close
 * the ticket, and start whatever that unblocked. "The agent said its gates
 * were green" is not a check, so this runs them again itself before landing —
 * the cost of a bad land is paid by every slice built on top of it.
 *
 * The practical consequence, worth knowing before you leave it running: the
 * loop cannot advance on its own. Walk away with three sessions open and mark
 * none of them done, and it waits forever, correctly.
 *
 * TERMINAL
 * --------
 * How a prepped worktree becomes an open session is the launcher's business
 * (scripts/slice-launcher.ts), named in slice.config.ts. `manual` — print the
 * command per slice, open nothing — is what a project has until it names
 * one, and it is the fallback here whenever the configured launcher cannot
 * run: it is the one path that cannot fail. `warp` opens tabs in this window
 * through the `.slice-autostart` marker and the shell hook that consumes it
 * (scripts/slice-autostart.sh), or a new window when the hook is not
 * installed — detected in the rc file of $SHELL, never assumed, because a
 * missing hook would otherwise be three tabs silently sitting at a prompt.
 * `tmux` opens windows that carry the command themselves.
 *
 * Two things the launcher decides reach into this file: its grace window
 * (how long "launched but no .slice-live yet" is normal, which is also what
 * the "never came up" report keys off), and whether it starts sessions by
 * command or by marker — which slice-session.sh reads through the shell
 * bridge to decide whether to park flags for the hook.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
// Every project-specific value — the base branch, the branch and worktree
// naming, the ready label — comes from slice.config.ts through here. See that
// file; nothing below should grow a literal back.
import {
  agent,
  branchFor,
  config,
  isTicketId,
  launcher as configuredLauncher,
  ref,
  repoRoot,
  tracker,
  worktreeFor,
} from "./slice-config";
// The gates themselves are in slice.config.ts too, as three shapes from
// slice-gates.ts; this file only runs them. See that file for the read-only
// contract every gate is held to.
import { runGates } from "./slice-gates";
// The launcher is picked below, in the launching section; `manual` is
// imported here because it is the fallback as well as the default.
import { type Launcher, type Session, manual } from "./slice-launcher";
// And the tracker: every ticket and every blocking edge below is read through
// `tracker`, never through gh directly. Ids are strings the tracker defines
// (`ref` writes one the way that tracker does — `#3`, or `ENG-3`); see
// slice-tracker.ts for the contract, and for why closing is what unblocks.
import { type TicketId, compareIds, openBlockers } from "./slice-tracker";

// NOT named `base`: reviewPlan already takes a `base` parameter — the commit
// the run started from — and a module const of the same name would be shadowed
// there in the one function that uses both.
const baseBranch = config.baseBranch;

// ─── arguments ────────────────────────────────────────────────────────────
// Parsed up here, not down in main: the launch helpers below close over
// `sessionFlags`, and a const declared after its user only works by accident
// of call order.
const argv = process.argv.slice(2);
const flag = (name: string) => argv.includes(name);
const value = (name: string) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};

// Passed straight through to slice-session.sh, whose defaults these mirror —
// autostart in particular (a tab that opens and then waits to be told the same
// thing eight times is not one command).
const sessionFlags = [
  ...(flag("--no-start") ? ["--no-start"] : []),
  // --auto is a promise that the loop progresses without a human, and it
  // cannot keep that promise on its own: a finished agent leaves its REPL
  // open, so .slice-live never clears and the slot never frees. --self-land
  // asks the slice to mark itself done and exit. Only under --auto, which is
  // where that judgement was already made.
  ...(flag("--auto") ? ["--self-land"] : []),
];

// Declared up here for the same reason as sessionFlags: reviewSlice closes
// over these, and a const declared after its user only works by accident of
// call order. Review is MANDATORY under --auto (nothing else is reading the
// diff) and opt-in otherwise, where a human ran slice-done.sh having looked.
// It only ever blocks a land under --auto, for that same reason.
const reviewEnabled =
  !flag("--no-review") && (flag("--auto") || flag("--review"));
const reviewBlocks = flag("--auto");

// ─── shelling out ─────────────────────────────────────────────────────────

function run(
  cmd: string[],
  opts: {
    inherit?: boolean;
    allowFail?: boolean;
    cwd?: string;
    timeoutMs?: number;
  } = {},
): { ok: boolean; out: string } {
  const [bin, ...args] = cmd;
  const proc = spawnSync(bin as string, args, {
    cwd: opts.cwd ?? repoRoot,
    stdio: opts.inherit ? "inherit" : "pipe",
    encoding: "utf8",
    timeout: opts.timeoutMs,
    // Default is 1MB, which a full-branch `git diff` or a long tsc run can
    // exceed — and spawnSync signals that by TRUNCATING and setting an error,
    // so the failure would look like a gate result rather than a buffer limit.
    maxBuffer: 64 * 1024 * 1024,
  });
  // tsc's output goes to stdout, biome's to stderr, git splits across both —
  // so callers that grep the result need them joined, not just stdout.
  const out = opts.inherit
    ? ""
    : `${proc.stdout ?? ""}${proc.stderr ?? ""}`.trim();
  const ok = proc.status === 0;
  if (!ok && !opts.allowFail) {
    throw new Error(`${cmd.join(" ")} failed:\n${out}`);
  }
  return { ok, out };
}

// ─── the graph ────────────────────────────────────────────────────────────

type Ticket = {
  id: TicketId;
  title: string;
  open: boolean;
  /** Blockers, restricted to tickets in this run's set. */
  blockedBy: TicketId[];
  /** Blockers outside the set — reported, never scheduled around silently. */
  foreignBlockers: TicketId[];
  wave: number;
};

/**
 * Blockers whose ticket is already closed are dropped: the tracker clears a
 * blocking edge on close, and so must the plan, or a finished wave keeps
 * blocking the next one forever.
 *
 * Only the forward edges are read (`tracker.blockers`), and the reverse ones
 * are derived from them by assignWaves and printTree — that is the one
 * direction every tracker can answer; see slice-tracker.ts.
 */
function loadTickets(explicit: TicketId[]): Ticket[] {
  const ids = explicit.length ? explicit : tracker.listReady(config.readyLabel);

  if (ids.length === 0) return [];
  const inSet = new Set(ids);

  const tickets: Ticket[] = [];
  for (const id of ids) {
    const meta = tracker.get(id);
    const stillBlocking = openBlockers(tracker.blockers(id));
    tickets.push({
      id,
      title: meta.title,
      open: meta.state === "open",
      blockedBy: stillBlocking.filter((b) => inSet.has(b.id)).map((b) => b.id),
      foreignBlockers: stillBlocking
        .filter((b) => !inSet.has(b.id))
        .map((b) => b.id),
      wave: 0,
    });
  }
  return tickets;
}

/**
 * Longest-path layering: a ticket sits one wave below its deepest blocker.
 * Throws on a cycle rather than looping — a cycle means the edges are wrong,
 * and quietly picking an order would hide that.
 */
function assignWaves(tickets: Ticket[]): void {
  const byId = new Map(tickets.map((t) => [t.id, t]));
  const settled = new Map<TicketId, number>();

  const depth = (n: TicketId, seen: Set<TicketId>): number => {
    if (settled.has(n)) return settled.get(n) as number;
    if (seen.has(n)) {
      throw new Error(
        `dependency cycle through ${ref(n)} — fix the blocking edges on ${
          tracker.name
        }`,
      );
    }
    const t = byId.get(n);
    if (!t) return 0;
    seen.add(n);
    const d = t.blockedBy.length
      ? 1 + Math.max(...t.blockedBy.map((b) => depth(b, seen)))
      : 0;
    seen.delete(n);
    settled.set(n, d);
    return d;
  };

  for (const t of tickets) t.wave = depth(t.id, new Set());
}

function printTree(tickets: Ticket[]): number {
  const waves = new Map<number, Ticket[]>();
  for (const t of tickets) {
    const list = waves.get(t.wave) ?? [];
    list.push(t);
    waves.set(t.wave, list);
  }
  const ordered = [...waves.keys()].sort((a, b) => a - b);

  console.log("");
  for (const w of ordered) {
    const inWave = (waves.get(w) as Ticket[]).sort((a, b) =>
      compareIds(a.id, b.id),
    );
    console.log(
      `  wave ${w + 1}  ${inWave.length} ticket${
        inWave.length === 1 ? "" : "s"
      }${w === 0 ? "  (runnable now)" : ""}`,
    );
    for (const t of inWave) {
      const blockers = t.blockedBy.length
        ? `  ← blocked by ${t.blockedBy.map(ref).join(", ")}`
        : "";
      const foreign = t.foreignBlockers.length
        ? `  ← blocked by ${t.foreignBlockers
            .map(ref)
            .join(", ")} (outside this set)`
        : "";
      const done = t.open ? "" : "  ✓ closed";
      console.log(`      ${ref(t.id)}  ${t.title}${blockers}${foreign}${done}`);
    }
  }

  // The widest wave is the most sessions that can ever be useful at once.
  // Running more than this cannot go faster; it only burns tokens on tickets
  // whose blockers haven't landed.
  const width = Math.max(
    ...ordered.map((w) => (waves.get(w) as Ticket[]).length),
  );
  console.log("");
  console.log(`  ${tickets.length} tickets, ${ordered.length} waves deep`);
  console.log(
    `  widest wave: ${width} — more than ${width} sessions can never help`,
  );
  return width;
}

// ─── scheduling state ─────────────────────────────────────────────────────

const LIVE_MARKER = ".slice-live";
const READY_MARKER = ".slice-ready-to-land";

/**
 * Three different questions, which an earlier version answered with one check
 * and got wrong.
 *
 * "Does a worktree exist" is NOT "is a session running". A worktree that has
 * been prepped, or whose session you exited, still exists — so counting those
 * as running filled every slot with nothing and the dispatcher reported
 * "3 running" while launching nothing and opening no sessions.
 *
 *  - hasWorktree — prepped. Decides whether a slice can be LANDED.
 *  - hasSession  — a session is actually open, via the `.slice-live` marker
 *                  slice-session.sh writes at launch and clears on exit.
 *                  Decides whether a SLOT is taken.
 *  - occupied    — hasSession, plus a grace window after we launched it but
 *                  before its shell has got as far as writing the marker.
 *                  Without it the next round would open a second session for
 *                  the same ticket.
 */
const hasWorktree = (n: TicketId) => existsSync(worktreeFor(n));
const hasSession = (n: TicketId) =>
  existsSync(join(worktreeFor(n), LIVE_MARKER));

/** When we launched a ticket, so a slow start isn't launched twice. */
const launchedAt = new Map<TicketId, number>();

// The grace window is the LAUNCHER'S, not a constant here: under Warp it has
// to cover a URI dispatch, a full shell startup and the hook; under tmux the
// command starts at once; under manual a human has to paste. The "never came
// up" report below reads the same number, so it is a diagnostic threshold as
// much as a timeout — which is why the launcher declares it rather than
// every launcher sharing whichever value Warp needed.
function occupied(n: TicketId): boolean {
  if (hasSession(n)) return true;
  const t = launchedAt.get(n);
  return t !== undefined && Date.now() - t < launcher.startingGraceMs;
}

/** Prepped, open, but with nobody working in it — worth saying out loud. */
const idleWorktrees = (tickets: Ticket[]) =>
  tickets.filter((t) => t.open && hasWorktree(t.id) && !occupied(t.id));

/** Empty when free; otherwise the holder, as db-lock-check.sh describes it. */
function dbLockHolder(): string {
  const { out } = run(
    [
      "bash",
      "-c",
      'source scripts/db-lock-check.sh; db_lock_holder "" || true',
    ],
    { allowFail: true },
  );
  return out.trim();
}

function refreshOpenState(tickets: Ticket[]): void {
  for (const t of tickets) t.open = tracker.get(t.id).state === "open";
}

/** Open, every blocker closed, nothing outside the set holding it, not already up. */
function runnable(tickets: Ticket[]): Ticket[] {
  const closed = new Set(tickets.filter((t) => !t.open).map((t) => t.id));
  return tickets.filter(
    (t) =>
      t.open &&
      !occupied(t.id) &&
      t.foreignBlockers.length === 0 &&
      t.blockedBy.every((b) => closed.has(b)),
  );
}

// ─── launching ────────────────────────────────────────────────────────────

/**
 * The configured launcher, unless it cannot run here — then `manual`, and
 * the reason is printed in the banner. TERM_PROGRAM used to SELECT the
 * launcher; now the config selects and the sniff is the launcher's own
 * `problem()` check ("config says warp, this is not Warp"). The information
 * is kept; the decision moved.
 *
 * Decided once, at startup: the grace window is read every round, and a
 * launcher that came and went between rounds would make "never came up"
 * mean two different things.
 */
const launcherProblem = configuredLauncher.problem();
const launcher: Launcher = launcherProblem ? manual() : configuredLauncher;

/**
 * Every launcher runs the ordinary `slice-session.sh <n> <flags>`: prep
 * already happened, so it reuses the worktree and goes almost straight to
 * the session — one launch path, not two that can drift. The flags are on
 * the command line here; a launcher that cannot carry a command (Warp's
 * tab path) gets them from the `.slice-flags` file prep parked instead.
 */
const sessionFor = (n: TicketId): Session => ({
  id: n,
  ref: ref(n),
  dir: worktreeFor(n),
  cmd: [`${repoRoot}/scripts/slice-session.sh`, n, ...sessionFlags],
});

/**
 * A launch that throws — `open` not found, tmux's server gone — falls back to
 * printing the commands: the worktrees are prepped, and a session a human
 * starts by hand is the same session. What was attempted and why it failed
 * is printed first, so the fallback is never mistaken for the plan.
 */
function openSessions(ids: TicketId[]): void {
  const sessions = ids.map(sessionFor);
  let lines: string[];
  try {
    lines = launcher.open(sessions);
  } catch (e) {
    console.log(
      `  ! ${launcher.name} could not open the sessions: ${
        e instanceof Error ? e.message : String(e)
      }`,
    );
    lines = manual().open(sessions);
  }
  for (const line of lines) console.log(`  ${line}`);
}

// ─── review ───────────────────────────────────────────────────────────────
/**
 * Two-axis review — Standards and Spec — of a diff, run through `claude -p`.
 *
 * WHY THIS EXISTS
 * ---------------
 * `gatesPass` answers "does it build, lint and test". Nothing in this pipeline
 * ever answered "is it the thing the ticket asked for". Under `--auto` that
 * gap is the whole exposure: the ADR's safety argument rests on a human
 * running slice-done.sh having looked at the work, and --auto is the
 * documented opt-out of exactly that. So review is MANDATORY under --auto and
 * opt-in (--review) otherwise, where a human already said done.
 *
 * The diff is computed here and pasted into the prompt rather than letting the
 * reviewer run git itself. That means `claude -p` needs no tools, no
 * permission grants and no MCP — text in, text out. It is deterministic, it
 * cannot wander the repo, and it is the reason this module ports to another
 * project unchanged.
 *
 * Two calls, not one: the axes are kept in separate contexts on purpose (a
 * spec failure and a style nit must not be reranked against each other), which
 * is the same reason the code-review skill spawns two sub-agents.
 *
 * FAILS CLOSED, like db-lock-check.sh: an unparseable or errored Spec review
 * blocks the land rather than waving it through. A false block costs one human
 * glance; a false pass under --auto puts unreviewed code on master.
 */

const REVIEW_TIMEOUT_MS = 10 * 60 * 1000;
const DIFF_BUDGET = 120_000;
const REVIEW_DIR = join(repoRoot, ".slice-reviews");

const SMELLS = `Mysterious Name · Duplicated Code · Feature Envy · Data Clumps · Primitive Obsession · Repeated Switches · Shotgun Surgery · Divergent Change · Speculative Generality · Message Chains · Middle Man · Refused Bequest`;

/**
 * The ticket body is the spec. Fetched on demand rather than carried on
 * Ticket: only the review needs it, and loadTickets already makes two tracker
 * calls per ticket without it.
 */
function ticketBody(n: TicketId): string {
  try {
    return tracker.body(n) || "(no body)";
  } catch {
    return "(ticket body unavailable)";
  }
}

/** `git diff` for a range, capped so an enormous branch can't blow the prompt. */
function diffFor(range: string, cwd: string): string {
  const stat = run(["git", "diff", "--stat", range], {
    cwd,
    allowFail: true,
  }).out;
  const full = run(["git", "diff", range], { cwd, allowFail: true }).out;
  if (full.length <= DIFF_BUDGET) return full || "(empty diff)";
  return `${stat}\n\n[diff truncated to ${DIFF_BUDGET} of ${
    full.length
  } chars — the stat above is complete]\n\n${full.slice(0, DIFF_BUDGET)}`;
}

/**
 * One headless prompt to the configured agent.
 *
 * Returns null when the agent HAS no headless mode as well as when the call
 * fails, and the caller treats both the same way: skip the review, say so, land
 * on the gates alone. That is deliberate — the reviews are an enhancement to
 * landing, not a precondition for it, and an agent without `-p` is a reason to
 * review less, never a reason to refuse to land.
 */
function askAgent(prompt: string, cwd: string): string | null {
  const argv = agent.review(prompt);
  if (!argv) return null;
  const { ok, out } = run(argv, {
    cwd,
    allowFail: true,
    timeoutMs: REVIEW_TIMEOUT_MS,
  });
  return ok && out.trim() ? out.trim() : null;
}

function saveReport(name: string, body: string): string {
  mkdirSync(REVIEW_DIR, { recursive: true });
  const path = join(REVIEW_DIR, name);
  writeFileSync(path, body);
  return path;
}

/** Standards axis. Always report-only — a smell is a judgement call. */
function reviewStandards(
  scope: string,
  commits: string,
  diff: string,
  cwd: string,
): string {
  return (
    askAgent(
      `You are reviewing a diff on ONE axis only: does it follow this repo's coding standards?

Read CLAUDE.md and any standards docs in the repo for the documented rules — a documented repo rule ALWAYS overrides the generic baseline below, and where the repo endorses something the baseline would flag, stay quiet.

Generic smell baseline (Fowler ch.3), each a labelled judgement call, never a hard violation:
${SMELLS}

Skip anything tooling already enforces (biome, tsc, vitest all run separately and passed).

Report per file/hunk: documented-standard breaches (cite the rule) and baseline smells (name it, quote the hunk). Distinguish the two. Be concrete; no praise, no summary of what the code does. Under 400 words. If nothing is worth raising, say exactly: "No standards findings."

SCOPE: ${scope}

COMMITS:
${commits}

DIFF:
${diff}`,
      cwd,
    ) ?? "(standards review did not return — skipped)"
  );
}

/**
 * Spec axis. Returns a verdict, because this is the one that can block:
 * "does the diff do what the ticket asked, and only that".
 */
function reviewSpec(
  spec: string,
  scope: string,
  commits: string,
  diff: string,
  cwd: string,
): { report: string; block: boolean } {
  const out = askAgent(
    `You are reviewing a diff on ONE axis only: does it faithfully implement the spec below?

Report only:
 (a) requirements the spec asked for that are MISSING or partial;
 (b) behaviour in the diff that was NOT asked for (scope creep);
 (c) requirements that look implemented but where the implementation looks WRONG.
Quote the spec line for each finding. Do not comment on style, naming or structure — a separate axis covers that. Under 400 words.

Then, as the FINAL line and nothing after it, print exactly one of:
VERDICT: PASS
VERDICT: BLOCK

BLOCK only for (a) or (c) — something asked for is missing or looks wrong. Scope creep alone is a finding, not a block. If the spec is too vague to judge against, PASS and say so.

SPEC:
${spec}

SCOPE: ${scope}

COMMITS:
${commits}

DIFF:
${diff}`,
    cwd,
  );

  if (!out) {
    return {
      report:
        "(spec review did not return — treating as BLOCK; see the fail-closed note above)",
      block: true,
    };
  }
  const verdict = out.match(/^VERDICT:\s*(PASS|BLOCK)\s*$/m)?.[1];
  if (!verdict) {
    return {
      report: `${out}\n\n(no parseable VERDICT line — treating as BLOCK)`,
      block: true,
    };
  }
  return { report: out, block: verdict === "BLOCK" };
}

/**
 * Review one finished slice, just before it lands. Returns false only when the
 * land should be refused.
 */
function reviewSlice(t: Ticket): boolean {
  if (!reviewEnabled) return true;

  const wt = worktreeFor(t.id);
  const range = `${baseBranch}...${branchFor(t.id)}`;
  const commits = run(
    ["git", "log", "--oneline", `${baseBranch}..${branchFor(t.id)}`],
    {
      cwd: wt,
      allowFail: true,
    },
  ).out;
  const diff = diffFor(range, wt);
  const scope = `ticket ${ref(t.id)} — ${t.title}`;

  console.log(`  reviewing ${ref(t.id)} (spec + standards) …`);
  const spec = reviewSpec(
    `${ref(t.id)} — ${t.title}\n\n${ticketBody(t.id)}`,
    scope,
    commits,
    diff,
    wt,
  );
  const standards = reviewStandards(scope, commits, diff, wt);

  const body = `# Review — ${ref(t.id)} ${t.title}\n\n## Spec\n\n${
    spec.report
  }\n\n## Standards\n\n${standards}\n`;
  const path = saveReport(`ticket-${t.id}.md`, body);

  console.log(`\n${body}`);
  console.log(`  report saved: ${path}`);

  if (spec.block && reviewBlocks) {
    console.log(
      `  ✗ ${ref(
        t.id,
      )} not landed — spec review says BLOCK. Fix it in the worktree, or land it yourself with ./scripts/slice-land.sh ${
        t.id
      }.`,
    );
    return false;
  }
  if (spec.block) {
    console.log(
      `  ! ${ref(
        t.id,
      )} spec review says BLOCK, but review is advisory here (a human ran slice-done.sh) — landing anyway.`,
    );
  }
  return true;
}

/**
 * Plan-level review, once the graph is empty.
 *
 * Every per-slice review sees only its own diff in its own worktree, so the
 * one thing none of them can see is the seam BETWEEN slices — the duplication,
 * the half-migrated call site, the abstraction two slices each invented
 * differently. This is the only pass that reads the plan as one change.
 * Advisory by definition: everything already landed.
 */
function reviewPlan(tickets: Ticket[], base: string): void {
  if (!reviewEnabled) return;
  const range = `${base}...${baseBranch}`;
  const diff = diffFor(range, repoRoot);
  if (diff === "(empty diff)") return;

  const commits = run(["git", "log", "--oneline", `${base}..${baseBranch}`], {
    allowFail: true,
  }).out;
  const scope = `the whole plan: ${tickets
    .map((t) => `${ref(t.id)}`)
    .join(", ")} (${base.slice(0, 7)}..${baseBranch})`;
  const spec = tickets
    .map((t) => `${ref(t.id)} — ${t.title}\n${ticketBody(t.id)}`)
    .join("\n\n---\n\n");

  console.log("\n── plan-level review (the seam between slices) ────────");
  const crossCutting =
    askAgent(
      `Several tickets were implemented independently, each in its own worktree, each reviewed and gate-checked ALONE. They have all landed on ${baseBranch}. Your job is the one thing none of those per-slice reviews could see: how the slices fit together.

Report ONLY cross-cutting findings — things invisible when reading any single slice's diff on its own:
 - the same concept implemented two different ways by two slices;
 - duplication introduced across slices (each reasonable alone);
 - a call site half-migrated: slice A changed a shape, slice B still uses the old one;
 - a rival abstraction — two slices each inventing their own helper for one job;
 - dead or orphaned code left behind by a later slice superseding an earlier one;
 - inconsistent naming or error handling across the set.

Do NOT re-report anything confined to a single slice; that was already reviewed. If there are no cross-cutting findings, say exactly: "No cross-cutting findings." Under 500 words.

TICKETS IN THIS PLAN:
${spec}

COMMITS:
${commits}

COMBINED DIFF:
${diff}`,
      repoRoot,
    ) ?? "(plan review did not return)";

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const body = `# Plan review — ${scope}\n\n${crossCutting}\n`;
  const path = saveReport(`plan-${stamp}.md`, body);
  console.log(`\n${crossCutting}\n`);
  console.log(`  report saved: ${path}`);
}

// ─── landing ──────────────────────────────────────────────────────────────

const isReadyToLand = (n: TicketId) =>
  existsSync(join(worktreeFor(n), READY_MARKER));

const commitsAhead = (n: TicketId) =>
  run(["git", "log", "--oneline", `${baseBranch}..HEAD`], {
    cwd: worktreeFor(n),
    allowFail: true,
  })
    .out.split("\n")
    .filter((l) => l.trim()).length;

/**
 * Under `--auto`, a slice counts as finished when its session is gone and it
 * left commits behind — no `slice-done.sh`. `occupied` rather than
 * `hasSession` on purpose: it also covers the launch grace window, so a
 * worktree prepped seconds ago whose tab has not opened yet is not read as a
 * session that closed. The commits check comes before the gates only to keep
 * an idle prepped worktree from printing "nothing to land" every round.
 */
const autoFinished = (n: TicketId) => !occupied(n) && commitsAhead(n) > 0;

/**
 * Re-run the quality gates against a finished slice, in its own worktree,
 * before landing it.
 *
 * This is the whole safety argument for automating the land at all. The slice
 * has already claimed its gates were green — `/implement` runs them and the
 * acceptance criteria demand them — but "the agent said so" is not a check.
 * Landing pushes to master and unblocks downstream tickets that will build on
 * this, so the cost of a bad land is paid by every slice after it.
 *
 * WHICH gates, and what each one has to be careful about, is the project's
 * business and lives in slice.config.ts under `gates` — the tsc baseline
 * diff, the linter that must be `check` and never `--apply`. This function
 * owns only what is the dispatcher's: that the worktree is clean and has
 * something to land, and that a gate which writes to the tree is a failed
 * gate whatever it reported (enforced in runGates).
 */
function gatesPass(n: TicketId): boolean {
  const wt = worktreeFor(n);
  const fail = (why: string) => {
    console.log(`  ✗ ${ref(n)} not landed — ${why}`);
    return false;
  };

  if (
    run(["git", "status", "--porcelain"], {
      cwd: wt,
      allowFail: true,
    }).out.trim()
  ) {
    return fail(
      "worktree is dirty (someone kept working after marking it done)",
    );
  }

  const changed = run(["git", "diff", "--name-only", `${baseBranch}...HEAD`], {
    cwd: wt,
    allowFail: true,
  })
    .out.split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  if (changed.length === 0) return fail("nothing to land");

  console.log(
    `  running ${config.gates.length} gate(s) for ${ref(n)} (${
      changed.length
    } files) …`,
  );

  const result = runGates(config.gates, {
    worktree: wt,
    // The main checkout is the baseline: it sits on the base branch the slice
    // was just rebased onto, so its errors are exactly the standing debt.
    baselineDir: repoRoot,
    changedFiles: changed,
    exec: (cmd, cwd) => run(cmd, { cwd, allowFail: true }),
  });
  if (result.ok) return true;

  const DETAIL_LINES = 10;
  const detail = result.detail ?? [];
  if (detail.length) {
    console.log(
      detail
        .slice(0, DETAIL_LINES)
        .map((l) => `      ${l}`)
        .join("\n"),
    );
    if (detail.length > DETAIL_LINES) {
      console.log(`      … ${detail.length - DETAIL_LINES} more`);
    }
  }
  return fail(result.why);
}

/**
 * Land one finished slice. Serial by construction — the caller lands at most
 * one per round, because every land is a fast-forward of the SAME master in
 * the SAME main worktree, and two at once would race each other.
 *
 * Never fatal: a slice that can't land (master moved, main worktree dirty,
 * gates red) is reported and left exactly as it was, to be retried next round
 * or landed by hand.
 */
/**
 * Bring a finished slice up to date with master before it is judged.
 *
 * `slice-land.sh` is fast-forward-only, so a branch is landable only while
 * master is still its ancestor — and **every land breaks that for every other
 * pending branch**. Land one slice out of a wave of three and the other two
 * become unlandable in the same instant, which is not an edge case but the
 * normal course of a wave finishing. Without this the dispatcher lands exactly
 * one slice per wave and then retries the rest forever.
 *
 * Rebasing here rather than in `slice-land.sh` is deliberate: it puts the
 * branch on its true final base BEFORE the gates run, so what gets tested is
 * what actually lands. Gating on stale-but-green is how a wave of individually
 * passing slices lands a broken master.
 *
 * A conflict is left entirely alone — aborted, reported, and the slice stays
 * exactly as its agent left it for a human to resolve.
 */
function rebaseOntoBase(t: Ticket): boolean {
  const wt = worktreeFor(t.id);
  if (
    run(["git", "merge-base", "--is-ancestor", baseBranch, "HEAD"], {
      cwd: wt,
      allowFail: true,
    }).ok
  ) {
    return true;
  }

  console.log(
    `  ${ref(t.id)} is behind ${baseBranch} — rebasing before the gates …`,
  );
  if (run(["git", "rebase", baseBranch], { cwd: wt, allowFail: true }).ok) {
    return true;
  }

  // Name the files BEFORE aborting — after the abort there is nothing left to
  // inspect, and "it conflicts" alone means whoever picks this up has to
  // reproduce the rebase just to learn where. In practice the answer is
  // usually the same: two slices in one wave both appended to the shared
  // locale files and the shared test file.
  const conflicted = run(["git", "diff", "--name-only", "--diff-filter=U"], {
    cwd: wt,
    allowFail: true,
  }).out.trim();
  run(["git", "rebase", "--abort"], { cwd: wt, allowFail: true });
  console.log(
    `  ✗ ${ref(
      t.id,
    )} not landed — it conflicts with ${baseBranch}, and a conflict is not something to resolve unsupervised. Rebase it by hand.`,
  );
  if (conflicted) {
    console.log(
      conflicted
        .split("\n")
        .map((f) => `      conflict: ${f}`)
        .join("\n"),
    );
  }
  return false;
}

/**
 * Why a ticket is not being retried, and the branch head that was true when it
 * failed.
 *
 * THE BUG THIS EXISTS TO KILL. A land runs the gates and two `claude -p`
 * reviews. A spec review returning BLOCK failed the land, the ready marker
 * stayed on disk, and the next round tried the identical branch again — gates,
 * both reviews, same verdict, forever. A review verdict on an unchanged diff
 * cannot change, so the retry was not optimism, it was a paid loop. One run
 * burned about an hour of review calls on ticket #3 before anyone noticed.
 *
 * The head is the whole mechanism. A blocked slice is retried when, and only
 * when, its branch has MOVED — which is exactly the condition under which the
 * answer could be different, and exactly what happens when you go fix it in
 * the worktree.
 */
type Parked = { reason: string; head: string };
const parked = new Map<TicketId, Parked>();

/** The slice branch's current commit, or null if it cannot be read. */
function branchHead(id: TicketId): string | null {
  const { ok, out } = run(["git", "rev-parse", branchFor(id)], {
    allowFail: true,
  });
  return ok && out.trim() ? out.trim() : null;
}

/** Has this ticket been parked, with nothing new committed since? */
function isParked(id: TicketId): boolean {
  const b = parked.get(id);
  if (!b) return false;
  const head = branchHead(id);
  if (head && head !== b.head) {
    console.log(
      `  ${ref(id)} has moved since it was parked — retrying the land.`,
    );
    parked.delete(id);
    return false;
  }
  return true;
}

export type Escalation = "retry" | "force" | "park" | "quit";

/**
 * What to do about a slice that will not land.
 *
 * The dispatcher's whole promise is that you do not have to watch it, and the
 * moment that promise breaks is here: something needs a decision only you can
 * make. So it asks — once, with the reason on screen — rather than either
 * grinding on or silently giving up.
 *
 * Non-interactive runs park. That is the conservative branch: the worktree and
 * the branch are left exactly as they are, the run carries on with the other
 * slices, and the summary at the end names every parked ticket. Nothing is
 * lost and nothing is landed unreviewed.
 */
function askAboutBlocked(t: Ticket, reason: string): Escalation {
  console.log(`
  ✗ ${ref(t.id)} did not land — ${reason}`);
  console.log(`     worktree: ${worktreeFor(t.id)}`);
  if (assumeYes || !process.stdin.isTTY) {
    console.log(
      "     parked (non-interactive). It will be retried automatically if you commit to that branch.",
    );
    return "park";
  }
  console.log(
    "     [r] retry now   [f] land anyway   [p] park it   [q] stop the run",
  );
  const answer = (prompt("     what now? [r/f/p/q]") ?? "")
    .trim()
    .toLowerCase();
  if (answer.startsWith("r")) return "retry";
  if (answer.startsWith("f")) return "force";
  if (answer.startsWith("q")) return "quit";
  return "park";
}

/** Set by the escalation prompt; the round loop checks it and stops cleanly. */
let stopRequested = false;

function tryLand(t: Ticket, opts: { force?: boolean } = {}): boolean {
  if (!rebaseOntoBase(t)) {
    return park(
      t,
      "the rebase onto the base branch failed — resolve it in the worktree",
    );
  }
  if (!gatesPass(t.id)) {
    return park(t, "the gates are red");
  }
  // After the gates, not before: no point paying for a review of something
  // that doesn't compile, and the reviewer should see the rebased diff that
  // is actually about to land.
  if (!opts.force && !reviewSlice(t)) {
    return park(t, "the spec review says BLOCK");
  }
  console.log(`  landing ${ref(t.id)} …`);
  const { ok } = run(["./scripts/slice-land.sh", t.id], {
    inherit: true,
    allowFail: true,
  });
  if (!ok) {
    return park(
      t,
      "slice-land.sh refused — the branch is not fast-forwardable, or a hook rejected it",
    );
  }
  parked.delete(t.id);
  t.open = false;
  return true;
}

/**
 * Record the failure, ask what to do, and act on the answer.
 *
 * Split out of `tryLand` so that every failure path goes through the same
 * question. Before this, three of the four returned false with a different
 * message and identical behaviour — retry next round, indefinitely.
 */
function park(t: Ticket, reason: string): boolean {
  const head = branchHead(t.id);
  switch (askAboutBlocked(t, reason)) {
    case "retry":
      return tryLand(t);
    case "force":
      console.log(
        `  landing ${ref(t.id)} without the review, at your request …`,
      );
      return tryLand(t, { force: true });
    case "quit":
      stopRequested = true;
      parked.set(t.id, { reason, head: head ?? "" });
      return false;
    default:
      parked.set(t.id, { reason, head: head ?? "" });
      return false;
  }
}

// ─── main ─────────────────────────────────────────────────────────────────

// A ticket id is whatever the tracker says one is — `^[0-9]+$` on GitHub, so
// `--max 2` and `--interval 30` would read as tickets #2 and #30 if their
// values were not skipped here.
const VALUE_FLAGS = new Set(["--max", "--interval"]);
const explicit: TicketId[] = argv.filter(
  (a, i) => isTicketId(a) && !VALUE_FLAGS.has(argv[i - 1] ?? ""),
);
const planOnly = flag("--plan");
const once = flag("--once");
const assumeYes = flag("-y") || flag("--yes");
const autoLand = flag("--auto");
const intervalMs = Number(value("--interval") ?? 30) * 1000;

// `--gates <n…>`: the landing gates, and nothing else — no GitHub, no rebase,
// no land. The worktree is judged exactly as it sits. This is how to check a
// slice by hand, and how the gate shapes were proven against real worktrees.
if (flag("--gates")) {
  if (explicit.length === 0) {
    console.error("--gates needs at least one ticket id");
    process.exit(64);
  }
  let allOk = true;
  for (const n of explicit) {
    if (!hasWorktree(n)) {
      console.log(`  ✗ ${ref(n)}: no worktree at ${worktreeFor(n)}`);
      allOk = false;
      continue;
    }
    if (gatesPass(n)) console.log(`  ✓ ${ref(n)} passes every gate`);
    else allOk = false;
  }
  process.exit(allOk ? 0 : 1);
}

console.log(`── reading the plan from ${tracker.name} ──────────────────────`);
const tickets = loadTickets(explicit);
if (tickets.length === 0) {
  console.log(`no open ${config.readyLabel} tickets — nothing to run.`);
  process.exit(0);
}
assignWaves(tickets);
const width = printTree(tickets);
const maxParallel = Number(value("--max") ?? width);

if (planOnly) process.exit(0);

console.log("");
console.log(`  concurrency cap: ${maxParallel}`);
console.log(
  `  note: ${maxParallel} slices means ${maxParallel} ${agent.name} sessions running at once.`,
);
/**
 * A missing agent binary is fatal, and it is fatal HERE — before a single
 * worktree is created. The alternative is N prepped worktrees each opening a
 * terminal that prints "command not found" and exits, which reads as "the
 * sessions never came up" and sends you looking at the launcher.
 */
const agentProblem = agent.problem();
if (agentProblem) {
  console.error(`error: ${agentProblem}.`);
  console.error(
    "       nothing has been prepped. Fix the agent, or name another one in slice.config.ts.",
  );
  process.exit(1);
}
if (!agent.review("probe")) {
  console.log(
    `  agent: ${agent.name} — no headless mode, so the spec and standards reviews are SKIPPED; landing rests on the gates alone.`,
  );
} else {
  console.log(`  agent: ${agent.name}`);
}
if (config.wrapCommand?.length) {
  console.log(`  wrapCommand: ${config.wrapCommand.join(" ")}`);
}
if (launcherProblem) {
  console.log(`  launcher: ${launcherProblem}.`);
  console.log(
    "            Falling back to manual: the command for each slice is printed for you to paste.",
  );
} else {
  console.log(
    `  launcher: ${launcher.name}${
      launcher.name === "manual"
        ? " — the command for each slice is printed for you to paste"
        : ""
    }`,
  );
}
if (autoLand) {
  console.log(
    "  --auto: a slice lands as soon as its session closes and the gates pass —",
  );
  console.log(
    "          no slice-done.sh needed. A session closed mid-ticket on a green",
  );
  console.log(
    "          intermediate commit will land half a ticket. The gates still run.",
  );
  console.log(
    "          Slices are also told to mark themselves done and exit (--self-land).",
  );
} else {
  console.log(
    "  run ./scripts/slice-done.sh inside a finished slice; this then verifies and lands it.",
  );
}
console.log(
  config.gates.length
    ? `  gates before each land: ${config.gates
        .map((g) => `\`${g.name}\``)
        .join(", ")}`
    : "  gates: NONE configured — whatever is committed lands. See slice.config.ts.",
);
console.log(
  reviewEnabled
    ? `  review: spec + standards before each land${
        reviewBlocks
          ? ", and a failing SPEC review blocks it (--no-review to disable)"
          : " — advisory only, a human already said done"
      }; plan-level review when the graph empties.`
    : "  review: OFF — nothing reads the diff before it lands. --review to enable.",
);

if (!assumeYes) {
  const answer = prompt("\nproceed? [y/N]") ?? "";
  if (!/^y(es)?$/i.test(answer.trim())) {
    console.log("stopped.");
    process.exit(0);
  }
}

// Captured before the first land, so the plan-level review at the end can diff
// everything THIS run produced, however many slices that turned out to be.
const planBase = run(["git", "rev-parse", baseBranch]).out.trim();

let round = 0;
for (;;) {
  round += 1;
  if (round > 1) refreshOpenState(tickets);

  const remaining = tickets.filter((t) => t.open);
  if (remaining.length === 0) {
    console.log("\n✓ every ticket closed — plan complete.");
    reviewPlan(tickets, planBase);
    break;
  }

  // Land before launching, so a slot freed this round is refilled this round.
  // One per round: every land fast-forwards the same master in the same main
  // worktree, so they cannot be done concurrently.
  const finished = tickets.filter(
    (t) =>
      t.open &&
      hasWorktree(t.id) &&
      // Parked slices are skipped until their branch moves. Without this the
      // same failing land is re-attempted every round for the life of the run.
      !isParked(t.id) &&
      (isReadyToLand(t.id) || (autoLand && autoFinished(t.id))),
  );
  if (finished.length) {
    console.log(
      `\n[round ${round}] ${finished.length} marked done — landing one`,
    );
    tryLand(finished[0] as Ticket);
  }

  if (stopRequested) {
    console.log(
      "\n  stopping at your request. Nothing has been left half-landed.",
    );
    break;
  }

  const up = tickets.filter((t) => t.open && occupied(t.id));
  const free = maxParallel - up.length;
  const ready = runnable(tickets);

  if (free > 0 && ready.length > 0) {
    // Checked BEFORE prepping, not after: slice-session.sh refuses to launch
    // while any other worktree has a migration diff, so prepping into a held
    // lock would build worktrees whose tabs then immediately fail.
    const holder = dbLockHolder();
    if (holder) {
      console.log(
        `\n[round ${round}] DB lock held by ${holder} — not starting anything.`,
      );
    } else {
      const starting = ready.slice(0, free);
      console.log(
        `\n[round ${round}] starting ${starting
          .map((t) => `${ref(t.id)}`)
          .join(", ")}`,
      );
      const prepped: TicketId[] = [];
      for (const t of starting) {
        // Serially, on purpose: concurrent `git worktree add` against one repo
        // contends on ref locks, and parallel `bun install`s are a pointless
        // spike. A failure here is reported and skipped, never fatal — the
        // other slices in this wave should still start.
        console.log(`  prepping ${ref(t.id)} …`);
        const { ok } = run(
          ["./scripts/slice-session.sh", t.id, ...sessionFlags, "--prep-only"],
          { inherit: true, allowFail: true },
        );
        if (ok) prepped.push(t.id);
        else
          console.log(`  ! ${ref(t.id)} failed to prep — skipping this round`);
      }
      if (prepped.length) {
        for (const n of prepped) launchedAt.set(n, Date.now());
        openSessions(prepped);
      }
    }
  }

  if (once) {
    console.log("\n--once: stopping here.");
    break;
  }

  // Keyed off the launcher's own grace window, so under Warp this means "the
  // tab opened and nothing ran in it — the hook, most likely" and under
  // manual it means "nobody has pasted the command yet"; either way the
  // launch is retried next round.
  const idle = idleWorktrees(tickets).filter((t) => launchedAt.has(t.id));
  if (idle.length) {
    console.log(
      `[round ${round}] never came up: ${idle
        .map((t) => `${ref(t.id)}`)
        .join(", ")} — launched via ${launcher.name} over ${Math.round(
        launcher.startingGraceMs / 1000,
      )}s ago and no session has started. Check where it should have opened; it will be relaunched.`,
    );
    for (const t of idle) launchedAt.delete(t.id);
  }

  const blocked = remaining.length - up.length - ready.length;
  console.log(
    `[round ${round}] ${up.length} running · ${Math.max(
      0,
      blocked,
    )} blocked · ${remaining.length} open${
      parked.size ? ` · ${parked.size} parked` : ""
    } — land one to advance`,
  );

  /**
   * Nothing running, nothing startable, and everything left is parked: the run
   * cannot advance on its own, and every further round is a sleep that prints
   * the same line. Stop and say what is holding it, rather than looking busy.
   *
   * This is only reachable because parking exists. The old code could not
   * stall here — it retried the failing land forever instead, which looked
   * like progress and cost a review call every round.
   */
  if (
    up.length === 0 &&
    ready.length === 0 &&
    remaining.length > 0 &&
    remaining.every((t) => parked.has(t.id))
  ) {
    console.log("\n  nothing can advance — every open slice is parked.");
    break;
  }

  await new Promise((r) => setTimeout(r, intervalMs));
}

/**
 * The last word of a run: what did not land, and what to do about each.
 *
 * Printed after the loop for every exit path, because "the run ended" and "the
 * work is done" are different things and the difference must not be something
 * you infer from scrollback.
 */
if (parked.size > 0) {
  console.log(`\n── parked (${parked.size}) ─────────────────────────────`);
  for (const [id, p] of parked) {
    console.log(`  ${ref(id)}  ${p.reason}`);
    console.log(`     ${worktreeFor(id)}`);
  }
  console.log(
    "\n  Each will be retried automatically once you commit to its branch.",
  );
  console.log(
    `  Or land one yourself: ./scripts/slice-land.sh <ticket>${
      parked.size > 1 ? "  (one at a time)" : ""
    }`,
  );
  process.exitCode = 1;
}
