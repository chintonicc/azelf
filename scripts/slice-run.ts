#!/usr/bin/env bun
/**
 * Drive a whole plan's worth of slices from one command.
 *
 *   azelf run --help      # every flag; the text is USAGE in slice-run-usage.ts
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
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statfsSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
// Every project-specific value — the base branch, the branch and worktree
// naming, the ready label — comes from slice.config.ts through here. See that
// file; nothing below should grow a literal back.
import {
  agent,
  branchFor,
  config,
  isTicketId,
  launcher as configuredLauncher,
  minFreeDiskGb,
  ref,
  repoRoot,
  tracker,
  worktreeFor,
} from "./slice-config";
// The gates themselves are in slice.config.ts too, as three shapes from
// slice-gates.ts; this file only runs them. See that file for the read-only
// contract every gate is held to.
import { type Flaky, runGates } from "./slice-gates";
// The launcher is picked below, in the launching section; `manual` is
// imported here because it is the fallback as well as the default.
import { type Launcher, type Session, manual } from "./slice-launcher";
// One gate run per repo at a time, across dispatchers; see gatesPass.
import { acquire, release } from "./slice-lock";
// The pure half of the overlap report; the git that feeds it is below, in the
// overlap section, because only this file knows where a slice's branch is.
import { findOverlaps, ignores } from "./slice-overlap";
// Same split again: whether a conflict resolution may proceed is a decision
// over facts and lives there; reading those facts out of a worktree is here.
import {
  type ResolutionState,
  droppedFiles,
  hasConflictMarkers,
  resolutionProblem,
  stopProblem,
} from "./slice-resolve";
// The flags, and the text `--help` prints: a module of its own so bin/azelf.ts
// can print it where there is no slice.config.ts for this file to load.
import { USAGE, VALUE_FLAGS, unknownFlag, wantsHelp } from "./slice-run-usage";
// And the tracker: every ticket and every blocking edge below is read through
// `tracker`, never through gh directly. Ids are strings the tracker defines
// (`ref` writes one the way that tracker does — `#3`, or `ENG-3`); see
// slice-tracker.ts for the contract, and for why closing is what unblocks.
import {
  type Epic,
  type TicketId,
  type TicketInfo,
  bodyOnlyBlockers,
  compareIds,
  findEpics,
  openBlockers,
  parentFromBody,
} from "./slice-tracker";
// Which azelf this is, read again every round: see the version check below.
import { installedVersion } from "./slice-version";

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

// Before anything reads a flag: --retry, the tracker and the plan all come
// after this, so a mistyped flag costs nothing but the message.
if (wantsHelp(argv)) {
  console.log(USAGE);
  process.exit(0);
}
const unknown = unknownFlag(argv);
if (unknown !== null) {
  console.error(`unknown flag ${unknown} — azelf run --help lists them`);
  process.exit(64);
}

// Passed straight through to slice-session.sh, whose defaults these mirror —
// autostart in particular (a tab that opens and then waits to be told the same
// thing eight times is not one command).
const sessionFlags = [
  ...(flag("--no-start") ? ["--no-start"] : []),
  // --auto is a promise that the loop progresses without a human, and it
  // cannot keep that promise on its own: nothing else tells the agent to run
  // slice-done.sh, and without that marker there is nothing to land against.
  // --self-land asks the slice to mark itself done and exit. Only under
  // --auto, which is where that judgement was already made.
  //
  // The "and exit" half is a request an agent is free to ignore, and usually
  // does. That is slice-done.sh's problem, not this flag's: it clears the
  // liveness marker itself, so the slot frees whether or not the REPL closes.
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
// Slices whose rebase an agent resolved in this run. Their spec review blocks
// even without --auto: the human who ran slice-done.sh released the slice's
// code, and the resolution was written after that.
const resolvedByAgent = new Set<TicketId>();

// ─── shelling out ─────────────────────────────────────────────────────────

function run(
  cmd: string[],
  opts: {
    inherit?: boolean;
    allowFail?: boolean;
    cwd?: string;
    timeoutMs?: number;
    /** Added to this process's environment, not in place of it. */
    env?: Record<string, string>;
  } = {},
): { ok: boolean; out: string } {
  const [bin, ...args] = cmd;
  const proc = spawnSync(bin as string, args, {
    cwd: opts.cwd ?? repoRoot,
    stdio: opts.inherit ? "inherit" : "pipe",
    encoding: "utf8",
    timeout: opts.timeoutMs,
    env: opts.env ? { ...process.env, ...opts.env } : undefined,
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
  /** Carries `exclusiveLockLabel`: scheduled one at a time, see `runnable`. */
  exclusive: boolean;
  /** Carries `humanLabel`: a person's ticket, never dispatched. */
  human: boolean;
  /** The subset of `foreignBlockers` that carry `humanLabel`. */
  foreignHuman: TicketId[];
};

/**
 * A ticket whose body names blockers the tracker has no edge for.
 *
 * Kept apart from `Ticket.blockedBy` on purpose: these are NOT scheduled on.
 * The plan runs on the tracker's edges, and a body is prose that was true when
 * someone wrote it. Promoting a claim to an edge is a decision with a flag
 * attached (`--sync-edges`), never a side effect of reading the plan. What
 * the claim does do is stop the dispatch until someone has decided
 * (`refuseOverBodyBlockers`). Closed blockers never get here.
 */
type MissingEdge = {
  id: TicketId;
  blockers: TicketId[];
  /** The subset of `blockers` the tracker could not read: a typo, usually. */
  unreadable: TicketId[];
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
function loadTickets(explicit: TicketId[]): {
  tickets: Ticket[];
  /** Parents left out of a bare run. Empty when ids were named. */
  epics: Epic[];
  /** Parents that run anyway, because they were named. */
  namedEpics: Epic[];
  /** Named tickets without the ready label, and without `humanLabel`. */
  unlabelled: TicketId[];
  missingEdges: MissingEdge[];
} {
  const ids = explicit.length ? explicit : tracker.listReady(config.readyLabel);

  if (ids.length === 0) {
    return {
      tickets: [],
      epics: [],
      namedEpics: [],
      unlabelled: [],
      missingEdges: [],
    };
  }

  // One fetch per ticket, however many readers want the text: findEpics reads
  // every body for `## Parent` and the edge check below reads the same bodies
  // for `## Blocked by`. Uncached that is two round trips per ticket to ask two
  // questions about one string, and plan time is already two calls a ticket.
  const bodies = new Map<TicketId, string>();
  const body = (id: TicketId): string => {
    const hit = bodies.get(id);
    if (hit !== undefined) return hit;
    const text = tracker.body(id);
    bodies.set(id, text);
    return text;
  };

  // Cached for the same reason: a child's state is asked for by findEpics and
  // the ticket itself is read again in the loop below.
  const metas = new Map<TicketId, TicketInfo>();
  const get = (id: TicketId): TicketInfo => {
    const hit = metas.get(id);
    if (hit) return hit;
    const meta = tracker.get(id);
    metas.set(id, meta);
    return meta;
  };

  // The hierarchy is read for explicit ids too, but only a bare run excludes
  // on it. Explicit ids are the user's own answer and override the plan, here
  // as everywhere else, which is what makes the exclusion recoverable rather
  // than a dead end: `azelf run 17` runs #17. It used to run it without a
  // word, and a spec named among its own tickets then opened a session on the
  // whole spec; now the plan says what was overridden (`printNamed`).
  const found = findEpics(ids, {
    idPattern: tracker.idPattern,
    body,
    children: tracker.children?.bind(tracker),
    parentClaims: tracker.parentClaims?.bind(tracker),
    state: (id) => get(id).state,
  });
  const epics = explicit.length ? [] : found;
  const excluded = new Set(epics.map((e) => e.id));
  const runnable = ids.filter((id) => !excluded.has(id));
  const inSet = new Set(runnable);

  const tickets: Ticket[] = [];
  const missingEdges: MissingEdge[] = [];
  const unlabelled: TicketId[] = [];
  const lockLabel = config.exclusiveLockLabel;
  const humanLabel = config.humanLabel;
  const isHuman = (meta: TicketInfo) =>
    humanLabel !== undefined && meta.labels.includes(humanLabel);
  for (const id of runnable) {
    const meta = get(id);
    const human = isHuman(meta);
    if (explicit.length && !human && !meta.labels.includes(config.readyLabel)) {
      unlabelled.push(id);
    }
    const declared = tracker.blockers(id);
    const stillBlocking = openBlockers(declared);
    // Against the FULL blocker list, closed ones included — an edge the plan
    // has already worked through is recorded, not missing. Unlike the epic
    // check this runs for explicit ids too: naming ids says which tickets to
    // run, not which edges exist, and the waves below are built from edges
    // either way.
    //
    // A claimed blocker that is closed blocks nothing and is dropped. One the
    // tracker cannot read is kept, and marked: a typo in a body should be
    // seen, not swallowed.
    const unreadable: TicketId[] = [];
    const claimed = bodyOnlyBlockers(
      body(id),
      declared,
      tracker.idPattern,
      id,
      (blocker) => {
        try {
          return get(blocker).state;
        } catch {
          unreadable.push(blocker);
          return undefined;
        }
      },
    );
    if (claimed.length > 0) {
      missingEdges.push({ id, blockers: claimed, unreadable });
    }
    const foreignBlockers = stillBlocking
      .filter((b) => !inSet.has(b.id))
      .map((b) => b.id);
    tickets.push({
      id,
      title: meta.title,
      open: meta.state === "open",
      blockedBy: stillBlocking.filter((b) => inSet.has(b.id)).map((b) => b.id),
      foreignBlockers,
      wave: 0,
      exclusive: lockLabel !== undefined && meta.labels.includes(lockLabel),
      human,
      // Read only to say what the wait is for. One that cannot be read holds
      // all the same: it is still an open blocker.
      foreignHuman: foreignBlockers.filter((b) => {
        try {
          return isHuman(get(b));
        } catch {
          return false;
        }
      }),
    });
  }
  return {
    tickets,
    epics,
    namedEpics: explicit.length ? found : [],
    unlabelled,
    missingEdges,
  };
}

/** "#47 #48 #49, 1 open" or "#47 #48 #49, all closed". */
function childrenOf(e: Epic): string {
  return `${e.children.map(ref).join(" ")}, ${
    e.openChildren.length ? `${e.openChildren.length} open` : "all closed"
  }`;
}

/**
 * Why a ticket was left out, and how to overrule it.
 *
 * The override line is load-bearing. An exclusion the tool will not explain and
 * cannot be argued with is worse than the collision it prevents: the ticket
 * simply vanishes from the plan and the next question is "why is nothing
 * running for #17".
 */
function printEpics(epics: Epic[]): void {
  for (const e of epics) {
    console.log("");
    if (e.openChildren.length > 0) {
      console.log(
        `  ⚠ ${ref(e.id)} excluded — named as Parent by ${e.children
          .map(ref)
          .join(" ")} (${e.openChildren.length} open)`,
      );
      console.log(
        "     An epic closes when its children close; it is not a slice.",
      );
    } else {
      // The children left the ready set as they landed, and the parent kept
      // its label. Nothing is wrong with the plan; the tracker needs tidying.
      const n = e.children.length;
      console.log(
        `  ⚠ ${ref(e.id)} excluded — ${
          n === 1
            ? "its one child is closed"
            : `its ${n} children are all closed`
        }. Close it, or remove ${config.readyLabel}.`,
      );
    }
    console.log(`     Run it anyway with: azelf run ${e.id}`);
  }
}

/**
 * What naming ids overrode. Explicit ids win over the hierarchy and the ready
 * label, and they should, but not silently: `azelf run 2 4 5` on five
 * unlabelled tickets used to read exactly like a plan the tracker agreed with.
 *
 * Printed after the waves, next to the `proceed?` prompt, because that is
 * where the decision to go ahead is made.
 */
function printNamed(
  namedEpics: Epic[],
  unlabelled: TicketId[],
  tickets: Ticket[],
): void {
  const held = tickets.filter((t) => t.human && t.open);
  if (namedEpics.length === 0 && unlabelled.length === 0 && !held.length) {
    return;
  }
  console.log("");
  for (const e of namedEpics) {
    console.log(
      `  ⚠ ${ref(e.id)} is a parent (${childrenOf(
        e,
      )}) — running it as a slice because you named it`,
    );
  }
  if (unlabelled.length > 0) {
    console.log(
      `  ⚠ not labelled ${config.readyLabel}: ${unlabelled
        .map(ref)
        .join(" ")} — running ${
        unlabelled.length === 1 ? "it" : "them"
      } because you named ${unlabelled.length === 1 ? "it" : "them"}`,
    );
  }
  // Named or not: a person's ticket is not an agent's, whoever asked.
  for (const h of held) {
    const waiting = tickets
      .filter((t) => t.open && t.blockedBy.includes(h.id))
      .map((t) => ref(t.id));
    console.log(
      `  ⚠ ${ref(h.id)} is labelled ${config.humanLabel} — not starting it${
        waiting.length
          ? `; ${waiting.join(", ")} ${
              waiting.length === 1 ? "waits" : "wait"
            } until it is closed`
          : ""
      }`,
    );
  }
}

/**
 * What the bodies claim and the tracker does not know, and what that does to
 * the run.
 *
 * The plan is never changed by it. Most of these are not mistakes: a body
 * saying "blocked by #19" often means "read #19 first", and the ticket that
 * prompted the first version of this said in so many words that it "reads best
 * after #19 … but does not depend on it". Scheduling on that sentence would
 * delay a slice by a whole wave for a reading order.
 *
 * It used to be a note below the waves and nothing more, and that was too
 * little: three tickets filed with `## Blocked by #81` and no edge were planned
 * into wave 1 beside #81, and a note is not read by a run started with `-y`.
 * So azelf still does not guess, but it now asks: a dispatch stops (see
 * `refuseOverBodyBlockers`) until the edges are recorded or the claim is
 * waved through with `--ignore-body-blockers`. Refusing costs one command,
 * once, and after `--sync-edges` the tracker is right for every later run.
 *
 * `ignored` is that flag: the lines are then a note, as they always were.
 */
function printMissingEdges(
  missing: MissingEdge[],
  tickets: Ticket[],
  ignored: boolean,
): void {
  if (missing.length === 0) return;
  const waveOf = new Map(tickets.map((t) => [t.id, t.wave]));
  const where = (m: MissingEdge, b: TicketId): string => {
    const wave = waveOf.get(b);
    if (wave !== undefined) return `in this run, wave ${wave + 1}`;
    return m.unreadable.includes(b)
      ? `not readable on ${tracker.name}`
      : "open, not in this run";
  };
  console.log("");
  for (const m of missing) {
    for (const b of m.blockers) {
      console.log(
        `  ${ignored ? "ℹ" : "✗"} ${ref(
          m.id,
        )}'s body says it is blocked by ${ref(b)} (${where(m, b)}). ${
          tracker.name
        } has no edge.`,
      );
    }
  }
  if (ignored) {
    console.log(
      "     Running as planned (--ignore-body-blockers): edges are scheduled on, prose is not.",
    );
  }
}

/**
 * The two ways past a body-only blocker, and for a dispatch the exit.
 *
 * `--plan` prints the same lines and exits 0: reading a plan is how this is
 * found, and a plan that failed would be a plan nobody could read in a script.
 * A dispatch exits 1 before `proceed?`, with `-y` as much as without, because
 * `-y` is exactly the run in which nobody reads the note.
 */
function refuseOverBodyBlockers(dispatching: boolean): void {
  // The run's own arguments, so the second command can be pasted as it is.
  const rest = argv.filter((a) => a !== "--plan").join(" ");
  const ids = explicit.join(" ");
  console.log("");
  console.log(
    dispatching
      ? "not dispatching: the plan above would start a ticket beside its claimed blocker."
      : "a dispatch of this plan stops here: it would start a ticket beside its claimed blocker.",
  );
  console.log(
    `  record the edges:  azelf run --sync-edges -y${ids ? ` ${ids}` : ""}`,
  );
  console.log(
    `  or run as planned: azelf run --ignore-body-blockers${
      rest ? ` ${rest}` : ""
    }`,
  );
  if (dispatching) process.exit(1);
}

/**
 * The base branch against origin's, said before anything is cut. A slice is
 * cut from local `baseBranch` when it is ahead (see slice-session.sh), and the
 * first land pushes those commits; neither was printed anywhere, and a run
 * once cut a ticket without two local commits it needed. Ahead: which
 * commits. Diverged: no land could push, so a dispatch stops here. Behind or
 * level: nothing. No `origin` at all: nothing either, there is nothing to
 * push to.
 */
function noteBaseAgainstOrigin(dispatching: boolean): void {
  if (!run(["git", "remote", "get-url", "origin"], { allowFail: true }).ok) {
    return;
  }
  const fetched = run(["git", "fetch", "-q", "origin", baseBranch], {
    allowFail: true,
  });
  if (!fetched.ok) {
    console.log(
      `\n  couldn't fetch origin/${baseBranch} — comparing against the last fetch: ${errorLine(
        fetched.out,
      )}`,
    );
  }
  const local = `refs/heads/${baseBranch}`;
  const remote = `refs/remotes/origin/${baseBranch}`;
  const count = (range: string) => {
    const r = run(["git", "rev-list", "--count", range], { allowFail: true });
    return r.ok ? Number(r.out) : 0;
  };
  const ahead = count(`${remote}..${local}`);
  const behind = count(`${local}..${remote}`);
  if (ahead === 0) return;
  if (behind > 0) {
    console.log(
      `\n  ✗ ${baseBranch} and origin/${baseBranch} have diverged (${ahead} and ${behind} commits), so no land could push. Pull or rebase ${baseBranch} first.`,
    );
    if (dispatching) {
      console.log(
        `\nnot dispatching: ${baseBranch} and origin/${baseBranch} have diverged.`,
      );
      process.exit(1);
    }
    return;
  }
  const subjects = run(
    ["git", "log", "--format=%h %s", "-n", "5", `${remote}..${local}`],
    { allowFail: true },
  ).out;
  console.log(
    `\n  ℹ ${baseBranch} is ${ahead} commit${
      ahead === 1 ? "" : "s"
    } ahead of origin/${baseBranch}. Slices are cut from it, and the first land pushes ${
      ahead === 1 ? "it" : "them"
    }:`,
  );
  for (const line of subjects.split("\n").filter(Boolean)) {
    console.log(`      ${line}`);
  }
  if (ahead > 5) console.log(`      … and ${ahead - 5} more`);
}

/**
 * Write the claimed edges the tracker is missing, one confirmation for the lot.
 *
 * This is the only write azelf makes to a tracker that is not a close-on-land,
 * and it is the only one that changes what future runs schedule — so it is
 * opt-in, it prints every edge before writing any, and it stops afterwards
 * rather than running the plan it just invalidated.
 */
function syncEdges(missing: MissingEdge[], assumeYes: boolean): void {
  if (missing.length === 0) {
    console.log(
      `\nevery blocker named in a body is already an edge on ${tracker.name} — nothing to sync.`,
    );
    return;
  }
  // Bound once: the contract makes this optional, and a tracker without it can
  // still do everything else, so this is a refusal and not a crash.
  const addBlocker = tracker.addBlocker?.bind(tracker);
  if (!addBlocker) {
    console.error(
      `\n${tracker.name}'s adapter implements no addBlocker — azelf cannot write edges to it.`,
    );
    console.error(
      "       The discrepancies above are still real; record them in the tracker by hand.",
    );
    process.exit(1);
  }

  const total = missing.reduce((n, m) => n + m.blockers.length, 0);
  console.log("");
  console.log(
    `  ${total} edge${
      total === 1 ? "" : "s"
    } claimed by a body and missing from ${tracker.name}:`,
  );
  for (const m of missing) {
    for (const b of m.blockers)
      console.log(`    ${ref(m.id)} blocked by ${ref(b)}`);
  }
  console.log("");
  console.log(
    "  Writing these changes what every future run schedules: a blocked ticket",
  );
  console.log(
    "  drops a wave, and it stops being runnable until its blocker closes.",
  );
  if (!assumeYes) {
    // `null` is a prompt nobody could answer: no terminal on stdin.
    const answer = prompt("\nwrite them? [y/N]");
    if (!/^y(es)?$/i.test((answer ?? "").trim())) {
      console.log(
        answer === null
          ? "stopped. Nothing was written. Confirm without a prompt with: azelf run --sync-edges -y"
          : "stopped. Nothing was written.",
      );
      return;
    }
  }

  console.log("");
  let wrote = 0;
  for (const m of missing) {
    for (const b of m.blockers) {
      try {
        addBlocker(m.id, b);
        wrote += 1;
        console.log(`  ✓ ${ref(m.id)} blocked by ${ref(b)}`);
      } catch (e) {
        // One bad edge must not cost the others. A body naming a ticket that
        // was renumbered or deleted is the ordinary case here, and failing the
        // whole sync on it would mean fixing the prose before any real edge
        // could be drawn.
        console.log(
          `  ✗ ${ref(m.id)} blocked by ${ref(b)}: ${
            e instanceof Error ? e.message : String(e)
          }`,
        );
      }
    }
  }
  console.log("");
  console.log(
    `${wrote} of ${total} written. Run again to plan against the new graph.`,
  );
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
    const held = inWave.filter((t) => t.human && t.open).length;
    console.log(
      `  wave ${w + 1}  ${inWave.length} ticket${
        inWave.length === 1 ? "" : "s"
      }${held ? `, ${held} waiting on a human` : ""}${
        w === 0 ? "  (runnable now)" : ""
      }`,
    );
    for (const t of inWave) {
      const blockers = t.blockedBy.length
        ? `  ← blocked by ${t.blockedBy.map(ref).join(", ")}`
        : "";
      const foreign = t.foreignBlockers.length
        ? `  ← blocked by ${t.foreignBlockers
            .map(ref)
            .join(", ")} (outside this set${
            t.foreignHuman.length ? ", waiting on a human" : ""
          })`
        : "";
      const done = t.open ? "" : "  ✓ closed";
      const label = t.exclusive ? `  [${config.exclusiveLockLabel}]` : "";
      const human = t.human && t.open ? "  [waiting on a human]" : "";
      console.log(
        `      ${ref(t.id)}  ${
          t.title
        }${label}${human}${blockers}${foreign}${done}`,
      );
    }
  }

  // Labelled tickets share one slot whatever their wave: two of them in one
  // wave would both reach `db-lock.sh claim`, and one would only be refused.
  const exclusive = tickets.filter((t) => t.exclusive && t.open);
  if (exclusive.length > 1) {
    console.log("");
    console.log(
      `  ${exclusive.map((t) => ref(t.id)).join(", ")} carry [${
        config.exclusiveLockLabel
      }] (exclusiveLockLabel): they run one at a time, in this order, whatever their wave says — each one touches ${config.exclusiveLockPaths.join(
        ", ",
      )}, and only one slice may hold the DB lock.`,
    );
  }

  // The widest wave is the most sessions that can ever be useful at once.
  // Running more than this cannot go faster; it only burns tokens on tickets
  // whose blockers haven't landed. A wave's labelled tickets count as one,
  // and a person's tickets as none: no session is ever opened for them.
  const width = Math.max(
    ...ordered.map((w) => {
      const inWave = (waves.get(w) as Ticket[]).filter((t) => !t.human);
      const labelled = inWave.filter((t) => t.exclusive).length;
      return inWave.length - labelled + Math.min(labelled, 1);
    }),
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
 *  - hasWorktree   — prepped. Decides whether a slice can be LANDED.
 *  - hasSession    — a session is actually open, via the `.slice-live` marker
 *                    slice-session.sh writes at launch, and the process it
 *                    names. Decides whether a SLOT is taken.
 *  - isReadyToLand — the slice said it is finished, via `.slice-ready-to-land`.
 *  - occupied      — hasSession, plus a grace window after we launched it but
 *                    before its shell has got as far as writing the marker.
 *                    Without it the next round would open a second session for
 *                    the same ticket.
 *
 * The first two markers are mutually exclusive by construction: slice-done.sh
 * writes the done marker and clears the live one in the same breath, because
 * an agent that has finished routinely leaves its REPL open and the session
 * shell's EXIT trap therefore never runs. Declaring done is what ends a
 * session's claim on its worktree; leaving the REPL is not.
 */
const hasWorktree = (n: TicketId) => existsSync(worktreeFor(n));
const isReadyToLand = (n: TicketId) =>
  existsSync(join(worktreeFor(n), READY_MARKER));

/**
 * Written here when a `.slice-live` turns out to name a session that is gone,
 * and deleted by slice-session.sh when the next session starts. It is what
 * tells `autoFinished` that the commits in the worktree are part of a ticket,
 * not the whole of one.
 */
const INTERRUPTED_MARKER = ".slice-interrupted";
const wasInterrupted = (n: TicketId) =>
  existsSync(join(worktreeFor(n), INTERRUPTED_MARKER));

/**
 * `ps` answers per round, by ticket and pid: `occupied` is asked from several
 * filters in one round, and a process does not become a different one between
 * them. Cleared at the top of every round.
 */
const sessionAnswers = new Map<string, boolean>();

/**
 * Is `pid` still this ticket's session? It must be running, and its command
 * line must be slice-session.sh with the ticket as an argument. PIDs are
 * reused, and after a restart the number on a marker can belong to anything.
 *
 * `-ww`, because ps may otherwise cut the command to the terminal's width,
 * and the ticket id is at the end of a long path. When `ps` cannot run at all,
 * the answer is yes: a false "gone" opens a second session on top of a live
 * one, and a false "alive" only waits.
 */
function isSessionOf(n: TicketId, pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ESRCH") return false;
  }
  const r = spawnSync("ps", ["-ww", "-o", "command=", "-p", String(pid)], {
    encoding: "utf8",
  });
  if (r.error) return true;
  const cmd = (r.stdout ?? "").trim();
  return cmd.includes("slice-session") && cmd.split(/\s+/).includes(n);
}

/**
 * Is a session open in this slice's worktree? The marker is not enough on its
 * own. slice-session.sh clears it from an EXIT trap, and a crash, a restart or
 * a force-quit terminal never runs the trap. On consumer-a a restart left four
 * markers behind, the dispatcher counted four sessions that did not exist, and
 * none of those slices was relaunched until the markers were deleted by hand.
 *
 * So the pid on the marker's first line has to still be this slice's session.
 * That works because the session shell lives exactly as long as the session:
 * slice-session.sh never `exec`s the agent, since the trap is what clears the
 * marker. A marker with no readable pid counts as live, as every marker did
 * before; nothing has ever written one, and "gone" is the unsafe mistake.
 */
function hasSession(n: TicketId): boolean {
  const path = join(worktreeFor(n), LIVE_MARKER);
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return false;
  }
  const first = text.split("\n")[0]?.trim() ?? "";
  if (!/^[0-9]+$/.test(first)) return true;
  const key = `${n}:${first}`;
  let alive = sessionAnswers.get(key);
  if (alive === undefined) {
    alive = isSessionOf(n, Number(first));
    sessionAnswers.set(key, alive);
  }
  if (alive) return true;
  clearStaleSession(n, path, text, first);
  // Whatever is in the file now: a session that started a moment ago has
  // written its own marker, and that one is live.
  return existsSync(path);
}

/**
 * The marker is read again and deleted only if it has not changed, so a
 * session that started since it was first read keeps the one it wrote.
 * `.slice-interrupted` goes in its place, and the line is printed once,
 * because the marker it is about is gone after this.
 */
function clearStaleSession(
  n: TicketId,
  path: string,
  seen: string,
  pid: string,
): void {
  let now: string;
  try {
    now = readFileSync(path, "utf8");
  } catch {
    return;
  }
  if (now !== seen) return;
  rmSync(path, { force: true });
  writeFileSync(join(worktreeFor(n), INTERRUPTED_MARKER), `${pid}\n`);
  console.log(
    `  ${ref(
      n,
    )}: its session (pid ${pid}) ended without clearing .slice-live — a crash, a restart, or a killed tab. Relaunching it.`,
  );
}

/**
 * A fourth question, asked only when `exclusiveLockPaths` is set: did this
 * slice's session exit because `db-lock.sh claim` refused it?
 *
 * db-lock.sh writes `.slice-lock-wait` on a refusal inside a slice worktree
 * and clears it on a successful claim; slice-session.sh clears it at every
 * launch. While it is present AND the lock is still held, the slice is
 * neither finished nor runnable: under --auto its commits are the part of
 * the ticket that did not need the lock, not the ticket, and relaunching it
 * would open a session whose first act is to be refused again. Once the lock
 * frees it is runnable like any other prepped-but-idle worktree, and the
 * ordinary relaunch path picks it up.
 */
const LOCK_WAIT_MARKER = ".slice-lock-wait";
const isWaitingOnLock = (n: TicketId) =>
  existsSync(join(worktreeFor(n), LOCK_WAIT_MARKER));
const lockEnabled = config.exclusiveLockPaths.length > 0;

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

/**
 * Prepped, open, but with nobody working in it — worth saying out loud.
 *
 * A slice that has declared itself done is excluded: it is unoccupied for the
 * best possible reason, and the caller's phrasing for this set is "never came
 * up … it will be relaunched", which would be two false statements about a
 * slice that came up, did the work, and is waiting on a land.
 */
const idleWorktrees = (tickets: Ticket[]) =>
  tickets.filter(
    (t) =>
      t.open && hasWorktree(t.id) && !occupied(t.id) && !isReadyToLand(t.id),
  );

/**
 * Empty when free; otherwise the holder, as db-lock-check.sh describes it —
 * the claim's owner first, and only when nobody holds the claim whatever the
 * scan turns up. Empty at once when the lock is not configured, so a project
 * without one pays no bash spawn per round for it.
 */
function dbLockHolder(): string {
  if (!lockEnabled) return "";
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

/** `DB lock: free` / `held by ticket/44 since …` — one line, for the banner. */
function dbLockStatusLine(): string {
  const { out } = run(
    ["bash", "-c", "source scripts/db-lock-check.sh; db_lock_status_line"],
    { allowFail: true },
  );
  return out.trim();
}

/**
 * Every ticket's state, read again at the top of a round. Each read on its
 * own: one that fails leaves that ticket as it was, and is returned rather
 * than thrown. The adapter throws on any failed `gh` call, and is right to at
 * plan time, where nothing has started yet. Here it ended runs: one `EOF` from
 * GitHub, seconds before it answered normally again, and the live sessions
 * were left with nothing to land them. A state read a round late is safe: a
 * ticket that is really closed waits one more round.
 *
 * Not the tickets this run landed. Their state is ours: a close that failed
 * after the land would read them open again, and `runnable` would prep a
 * fresh worktree for work that is already on the base branch. Their close is
 * retried instead, in `retryCloses`.
 *
 * And each blocker outside the set, once however many tickets it holds, so a
 * ticket starts the round after a person, or another dispatcher, closes what
 * held it. Read once at plan time, as it used to be, it held them for the
 * whole run. One that cannot be read keeps holding.
 */
function refreshOpenState(tickets: Ticket[]): {
  failed: { id: TicketId; error: string }[];
  allFailed: boolean;
} {
  const failed: { id: TicketId; error: string }[] = [];
  let read = 0;
  for (const t of tickets) {
    // Set at every land, where landedHeads is only when the head read back.
    if (landedFiles.has(t.id)) continue;
    read += 1;
    try {
      t.open = tracker.get(t.id).state === "open";
    } catch (e) {
      failed.push({ id: t.id, error: errorLine(e) });
    }
  }
  const closed = new Set<TicketId>();
  const outside = new Set(
    tickets.flatMap((t) => (t.open ? t.foreignBlockers : [])),
  );
  for (const id of outside) {
    read += 1;
    try {
      if (tracker.get(id).state !== "open") closed.add(id);
    } catch (e) {
      failed.push({ id, error: errorLine(e) });
    }
  }
  for (const t of tickets) {
    t.foreignBlockers = t.foreignBlockers.filter((b) => !closed.has(b));
    t.foreignHuman = t.foreignHuman.filter((b) => !closed.has(b));
  }
  return { failed, allFailed: read > 0 && failed.length === read };
}

/**
 * The line of an error worth printing. The GitHub adapter's message is
 * `gh … failed:` with all of `gh`'s stderr below it, and the line after that
 * header is the one that says what happened.
 */
function errorLine(e: unknown): string {
  const lines = (e instanceof Error ? e.message : String(e))
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  const at = lines.length > 1 && lines[0]?.endsWith("failed:") ? 1 : 0;
  return lines[at] ?? "no message";
}

// How long every read may fail before the run gives up: long enough to ride
// out a VPN reconnecting, short enough that a run whose network is gone for
// good says so the same morning. Seconds, like SLICE_HEARTBEAT_SECONDS, so a
// test can wait two of them instead of thirty minutes.
const trackerOutageMs =
  Number(process.env.SLICE_TRACKER_OUTAGE_SECONDS ?? 1800) * 1000;

/** `30 minutes`, `2 seconds`. */
function duration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 120) return `${s} second${s === 1 ? "" : "s"}`;
  return `${Math.round(s / 60)} minutes`;
}

// The streak of rounds with a failed read: which tickets, how many rounds,
// when it was last said, and since when every read has failed.
const unreadable = new Set<TicketId>();
let unreadableRounds = 0;
let unreadableSaidAt = 0;
let outageSince: number | null = null;

/**
 * What a round's failed reads print: the first round of a streak, the
 * heartbeat while it lasts, and the round it ends. Returns why the run must
 * stop, once every read has failed for `trackerOutageMs`.
 */
function noteUnreadable(
  failed: { id: TicketId; error: string }[],
  allFailed: boolean,
): string | null {
  outageSince = allFailed ? outageSince ?? Date.now() : null;
  if (failed.length === 0) {
    if (unreadableRounds > 0) {
      console.log(
        `\n[round ${round}] ${tracker.name} answers again (${[...unreadable]
          .map(ref)
          .join(", ")} unreadable for ${unreadableRounds} round${
          unreadableRounds === 1 ? "" : "s"
        })`,
      );
    }
    unreadable.clear();
    unreadableRounds = 0;
    return null;
  }
  for (const f of failed) unreadable.add(f.id);
  unreadableRounds += 1;
  const ids = failed.map((f) => ref(f.id)).join(", ");
  const its = failed.length === 1 ? "its" : "their";
  const error = (failed[0] as { error: string }).error;
  if (unreadableRounds === 1) {
    console.log(
      `\n[round ${round}] couldn't read ${ids} from ${tracker.name} — keeping ${its} last state, trying again next round: ${error}`,
    );
    unreadableSaidAt = Date.now();
  } else if (Date.now() - unreadableSaidAt >= heartbeatMs) {
    console.log(
      `\n[round ${round}] still can't read ${ids} from ${tracker.name}, ${unreadableRounds} rounds now — keeping ${its} last state: ${error}`,
    );
    unreadableSaidAt = Date.now();
  }
  if (outageSince !== null && Date.now() - outageSince >= trackerOutageMs) {
    return `${tracker.name} has not answered for ${duration(trackerOutageMs)}`;
  }
  return null;
}

/**
 * A parked ticket the tracker now reads closed was landed by hand, or closed
 * for some other reason: either way there is nothing left to retry. Left in
 * `parked`, it counted in every round's line and in the summary, and made a
 * run that had finished everything exit 1.
 */
function unparkClosed(tickets: Ticket[]): void {
  for (const t of tickets) {
    if (!t.open && parked.delete(t.id)) {
      console.log(
        `  ${ref(t.id)} was closed outside this run — no longer parked`,
      );
    }
  }
}

/**
 * Open, every blocker closed, nothing outside the set holding it, not already
 * up, and not already finished.
 *
 * That last clause is not redundant with `occupied`. A slice that has run
 * slice-done.sh has no live marker — that is the point of clearing it — so it
 * reads as unoccupied from here, and until it lands it is still open. Without
 * the check, a slice whose land is PARKED (red gates, a BLOCK verdict) would
 * be relaunched next round: a second session opened into a worktree the first
 * one may still be sitting in, to redo work that is already committed. The
 * ticket is finished; what it is waiting for is a land, not an agent.
 *
 * And not parked. Under --auto a slice can be finished with no marker at all
 * (`autoFinished`), so when its land parked, nothing above held it back: it
 * was relaunched the same round, into the worktree whose land had just
 * failed. A parked ticket comes back through `isParked`, which the landing
 * filter asks earlier in the round, so one that is due a retry has already
 * been taken off `parked` by the time this reads it.
 *
 * And not parked on the DB lock while it is held (`lockHeld` is this round's
 * reading of it): see `isWaitingOnLock`. A slice that exited on a refused
 * claim is relaunched the round the lock frees, not every round until then.
 *
 * And not while a rebase or merge is in progress in its worktree
 * (`inProgress`): a session opened there would work on top of someone's
 * half-finished fix.
 *
 * And not a person's ticket (`humanLabel`), named or not.
 *
 * Last, `exclusiveLockLabel` tickets are a group of size one: while one is in
 * flight (see `exclusiveInFlight`) only that one may be relaunched, and with
 * none in flight only the first of them may start. Without this, two
 * labelled tickets in one round both open a session, both reach `db-lock.sh
 * claim`, and the loser exits having done nothing but be refused.
 */
function runnable(tickets: Ticket[], lockHeld: boolean): Ticket[] {
  const closed = new Set(tickets.filter((t) => !t.open).map((t) => t.id));
  const flying = exclusiveInFlight(tickets);
  let exclusiveTaken = false;
  const ready = tickets.filter(
    (t) =>
      t.open &&
      !occupied(t.id) &&
      !isReadyToLand(t.id) &&
      !parked.has(t.id) &&
      !inProgress.has(t.id) &&
      !(lockHeld && isWaitingOnLock(t.id)) &&
      !t.human &&
      t.foreignBlockers.length === 0 &&
      t.blockedBy.every((b) => closed.has(b)),
  );
  return ready.filter((t) => {
    if (!t.exclusive) return true;
    if (flying) return t.id === flying.id;
    if (exclusiveTaken) return false;
    exclusiveTaken = true;
    return true;
  });
}

/**
 * Open tickets that wait on a person: one carrying `humanLabel`, one held by
 * an outside blocker that does, and one whose open blocker in the set waits
 * on a person, however far down the chain.
 */
function waitingOnHuman(tickets: Ticket[]): Set<TicketId> {
  const byId = new Map(tickets.map((t) => [t.id, t]));
  const memo = new Map<TicketId, boolean>();
  const waits = (t: Ticket): boolean => {
    const hit = memo.get(t.id);
    if (hit !== undefined) return hit;
    const w =
      t.human ||
      t.foreignHuman.length > 0 ||
      t.blockedBy.some((b) => {
        const o = byId.get(b);
        return o?.open === true && waits(o);
      });
    memo.set(t.id, w);
    return w;
  };
  return new Set(tickets.filter((t) => t.open && waits(t)).map((t) => t.id));
}

/**
 * The labelled ticket holding the group's one slot: open, and occupied or
 * with a worktree. A worktree is the test, not a session, because every state
 * between the first launch and the land counts — running, done and waiting
 * on a land, parked, crashed, refused at the claim — and in all of them its
 * migration is not on the base branch yet. A land removes the worktree and
 * closes the ticket, which is what frees the slot.
 */
const exclusiveInFlight = (tickets: Ticket[]): Ticket | undefined =>
  tickets.find(
    (t) => t.exclusive && t.open && (occupied(t.id) || hasWorktree(t.id)),
  );

// ─── disk ─────────────────────────────────────────────────────────────────

/**
 * Free space where this ticket's worktree goes, in GB, or null when it cannot
 * be read. Measured on the nearest directory that exists, since the worktree
 * itself does not yet, and a `worktreeDir` with `{n}` in a directory name
 * does not have its parent yet either.
 */
function freeGbFor(n: TicketId): number | null {
  let dir = dirname(worktreeFor(n));
  while (!existsSync(dir)) {
    const up = dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
  try {
    const s = statfsSync(dir);
    return (s.bavail * s.bsize) / 1e9;
  } catch {
    return null;
  }
}

const gb = (n: number) => `${n.toFixed(1)} GB`;

/**
 * Below `minFreeDiskGb` at the last check. Printed on the way down and on the
 * way up, not every time it is checked, which is before every prep.
 */
let diskHeld = false;

/**
 * Is there room to prep a new worktree for this ticket? Asked before each
 * prep that creates one, not once per round: one round can start several
 * slices, and each is a checkout and a `node_modules`.
 *
 * WHY THIS EXISTS. On consumer-a a prep failed with ENOSPC partway through
 * `bun install`, and the next round tried it again, and the next. Each retry
 * left another half-built worktree until the machine restarted with four
 * sessions open. Landing is what frees space here, since each land removes a
 * worktree, so a held start waits for that and lands are never held.
 *
 * A reading that fails is room: the check protects the disk, and a
 * filesystem statfs cannot read is no reason to stop a wave.
 */
function roomToPrep(n: TicketId): boolean {
  if (minFreeDiskGb <= 0) return true;
  const free = freeGbFor(n);
  if (free === null) return true;
  const low = free < minFreeDiskGb;
  if (low && !diskHeld) {
    console.log(
      `  disk: ${gb(
        free,
      )} free where the worktrees go, below minFreeDiskGb (${minFreeDiskGb}) — starting nothing until there is more. Landing carries on, and each land removes a worktree.`,
    );
  } else if (!low && diskHeld) {
    console.log(
      `  disk: ${gb(
        free,
      )} free again, above minFreeDiskGb (${minFreeDiskGb}) — starting slices again.`,
    );
  }
  diskHeld = low;
  return !low;
}

/**
 * A prep that failed after creating its worktree leaves one behind: a
 * checkout, the files provisioning copied, and part of a `node_modules`. On
 * consumer-a one was 2.4 GB, and each retry added another. Removed with
 * `--force`, because what makes it dirty is the prep's own copying and
 * installing. The branch stays, with whatever it had, and the next prep
 * checks it out again.
 *
 * Only for a worktree this prep created: the caller checks it was not there
 * before. One that was is a reused worktree, and someone's work may be in it.
 */
function removeHalfPrepped(n: TicketId): void {
  if (!hasWorktree(n)) return;
  const { ok, out } = run(
    ["git", "worktree", "remove", "--force", worktreeFor(n)],
    { allowFail: true },
  );
  console.log(
    ok
      ? `  removed the half-prepped worktree for ${ref(
          n,
        )} — it held nothing but a partial install`
      : `  ! could not remove the half-prepped worktree at ${worktreeFor(
          n,
        )}: ${out.trim()}`,
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
 *
 * `--named` for a ticket named on the command line without the ready label:
 * the plan said it runs because you named it, and the session's own label
 * check would otherwise refuse it at every prep.
 */
const flagsFor = (n: TicketId): string[] => [
  ...sessionFlags,
  ...(unlabelled.includes(n) ? ["--named"] : []),
];
const sessionFor = (n: TicketId): Session => ({
  id: n,
  ref: ref(n),
  dir: worktreeFor(n),
  cmd: [`${repoRoot}/scripts/slice-session.sh`, n, ...flagsFor(n)],
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

/** What a parent spec may take of the spec review's prompt. */
const PARENT_BUDGET = 20_000;

/**
 * The ticket this one hangs under, or null.
 *
 * The ticket's own `## Parent` section first. A tracker has no child-to-parent
 * call, only `children(id)`, so a parent recorded solely in the tracker's own
 * hierarchy is known only when this run's plan already found it as an epic.
 * Otherwise there is no parent as far as the review can tell.
 */
function parentOf(id: TicketId): TicketId | null {
  let named: TicketId | null = null;
  try {
    named = parentFromBody(tracker.body(id), tracker.idPattern);
  } catch {
    // An unreadable body names nothing; the spec itself says so already.
  }
  if (named && named !== id) return named;
  return (
    [...epics, ...namedEpics].find((e) => e.children.includes(id))?.id ?? null
  );
}

/**
 * The parent spec for the review's prompt: its title and body, cut to a
 * budget of its own. `text` is null with no parent, and with one the tracker
 * cannot read; the second case carries a `note` for the report, because a
 * review that could not see the parent is a weaker review.
 */
function parentSpec(id: TicketId): { text: string | null; note?: string } {
  const parent = parentOf(id);
  if (!parent) return { text: null };
  try {
    const title = tracker.get(parent).title;
    const body = tracker.body(parent) || "(no body)";
    const full = `${ref(parent)} — ${title}\n\n${body}`;
    return {
      text:
        full.length <= PARENT_BUDGET
          ? full
          : `${full.slice(
              0,
              PARENT_BUDGET,
            )}\n\n[parent spec truncated to ${PARENT_BUDGET} of ${
              full.length
            } chars]`,
    };
  } catch {
    return {
      text: null,
      note: `(the parent spec ${ref(
        parent,
      )} could not be read — reviewed against the ticket alone)`,
    };
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

/**
 * `body` into `.slice-reviews/<name>`, replacing it; or, given a `heading`,
 * added to it as the next `## Attempt k — <date> HH:MM`, newest last, under
 * that heading, written once. The appending is for the files one slice is
 * written to again and again, its review and its conflict resolution: the
 * attempt that explains why it was parked must survive the attempt after it,
 * and since a BLOCK is re-reviewed routinely, the passing review would
 * otherwise replace the one that says why.
 */
function saveReport(name: string, body: string, heading?: string): string {
  mkdirSync(REVIEW_DIR, { recursive: true });
  const path = join(REVIEW_DIR, name);
  if (heading === undefined) {
    writeFileSync(path, body);
    return path;
  }
  let before = "";
  try {
    before = readFileSync(path, "utf8");
  } catch {
    // The first attempt.
  }
  if (!before) before = `${heading}\n`;
  const k = (before.match(/^## Attempt \d+/gm) ?? []).length + 1;
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const at = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(
    now.getDate(),
  )} ${pad(now.getHours())}:${pad(now.getMinutes())}`;
  writeFileSync(
    path,
    `${before.trimEnd()}\n\n## Attempt ${k} — ${at}\n\n${body.trim()}\n`,
  );
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
 * What the spec review is shown besides the ticket and the diff. Each part is
 * absent when there is nothing to show, and the prompt then reads as it did
 * before the part existed.
 */
type SpecContext = {
  /** The spec the ticket hangs under: see `parentSpec`. */
  parent?: string | null;
  /** What landed onto this slice's files while it was open: see `landedUnder`. */
  landed?: string | null;
  /** The slice's new tests, run against the base: see `testsOnBase`. */
  testsOnBase?: string | null;
};

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
  context: SpecContext = {},
): { report: string; block: boolean } {
  const out = askAgent(
    `You are reviewing a diff on ONE axis only: does it faithfully implement the spec below?

Report only:
 (a) requirements the spec asked for that are MISSING or partial;
 (b) behaviour in the diff that was NOT asked for (scope creep);
 (c) requirements that look implemented but where the implementation looks WRONG.${
   context.landed
     ? `
 (d) something the landed work below set up for this slice to join, extend or respect, that this diff does not — a shared guard, a registry, an invariant stated in a comment.`
     : ""
 }
Quote the spec line for each finding${
      context.landed ? ", or for (d) the landed line" : ""
    }. Do not comment on style, naming or structure — a separate axis covers that. Under 400 words.

Then, as the FINAL line and nothing after it, print exactly one of:
VERDICT: PASS
VERDICT: BLOCK

BLOCK only for (a)${
      context.landed ? ", (c) or (d)" : " or (c)"
    } — something asked for is missing or looks wrong${
      context.landed ? ", or a contract the landed work set up is not kept" : ""
    }. Scope creep alone is a finding, not a block. If the spec is too vague to judge against, PASS and say so.${
      context.parent
        ? `

The SPEC is what this slice must do. The PARENT SPEC is the larger spec it is one slice of: it says why, and it decides wherever the two disagree. Where the diff follows the parent against the ticket's wording, report that as "ticket and parent disagree" — it is not (a) and not (c), and never a reason to BLOCK. A requirement only the parent states belongs to another slice: it is not missing from this one.`
        : ""
    }

SPEC:
${spec}
${context.parent ? `\nPARENT SPEC:\n${context.parent}\n` : ""}
SCOPE: ${scope}

COMMITS:
${commits}

DIFF:
${diff}${
  context.testsOnBase
    ? `

NEW TESTS AGAINST THE BASE:
${context.testsOnBase}

How to read that: a spec that asks for a failing test first is met when these tests FAIL on the base for the reason the spec describes. An import error for a file this slice adds counts — the code under test is not there yet. A broken environment (a missing dependency, a runner that did not start) does not count either way. Tests that PASS on the base do not show what a failing-test-first spec asked them to show: report that under (a). If you cannot tell which of these it is, say so, and do not BLOCK on this alone.`
    : ""
}${
  context.landed
    ? `

LANDED WHILE THIS SLICE WAS OPEN:
Other slices of the same plan landed on files this diff also changes, after this slice was started. Its author did not see them. The DIFF above is already rebased onto them, so they applied cleanly; (d) is about what a clean rebase does not check.

${context.landed}`
    : ""
}`,
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

/** What the landed diffs may take of the spec review's prompt. */
const LANDED_BUDGET = 30_000;

/** The files both lists name, minus what the overlap report ignores. */
const sharedFiles = (a: string[], b: string[]): string[] => {
  const other = new Set(b);
  return [...new Set(a)]
    .filter((f) => other.has(f) && !overlapIgnored(f))
    .sort();
};

/** `git log --oneline` over what one slice put on the base branch. */
const landedSubjects = (r: { from: string; to: string }): string =>
  run(["git", "log", "--oneline", `${r.from}..${r.to}`], {
    allowFail: true,
  }).out.trim();

/**
 * The spec review's `LANDED WHILE THIS SLICE WAS OPEN` section, or null.
 *
 * A contract between two siblings is the thing no per-slice review could see:
 * on consumer-a one slice landed a guard whose comment said its sibling joins
 * it, the sibling was in flight on the older base and never did, and the
 * overlap warning, the resolver and the plan review all noticed after it was
 * on the base branch. So a slice that lands onto files a sibling changed
 * under it is shown that sibling: its commit subjects, and its diff limited
 * to the files both touched.
 *
 * Called after the rebase, so `changedFiles` is what this slice itself
 * changes. Per-file diffs are added smallest first, so one large file does
 * not crowd out the rest; what does not fit is named.
 */
function landedUnder(id: TicketId): string | null {
  const mine = changedFiles(id);
  const parts: string[] = [];
  const diffs: { file: string; text: string }[] = [];
  for (const other of landedWhileOpen.get(id) ?? []) {
    const range = landedRanges.get(other);
    const files = sharedFiles(landedFiles.get(other) ?? [], mine);
    if (!range || files.length === 0) continue;
    const title = tickets.find((t) => t.id === other)?.title ?? "";
    parts.push(
      `${ref(other)} — ${title}\nfiles this diff also changes: ${files.join(
        "  ",
      )}\ncommits:\n${landedSubjects(range)}`,
    );
    for (const file of files) {
      const text = run(["git", "diff", range.from, range.to, "--", file], {
        allowFail: true,
      }).out;
      if (text.trim()) diffs.push({ file: `${ref(other)} ${file}`, text });
    }
  }
  if (parts.length === 0) return null;

  diffs.sort((a, b) => a.text.length - b.text.length);
  let left = LANDED_BUDGET;
  const shown: string[] = [];
  const cut: string[] = [];
  for (const d of diffs) {
    if (d.text.length <= left) {
      left -= d.text.length;
      shown.push(d.text.trimEnd());
    } else {
      cut.push(`${d.file} (${d.text.length} chars)`);
    }
  }
  return `${parts.join(
    "\n\n",
  )}\n\nWHAT THEY CHANGED IN THOSE FILES:\n${shown.join("\n")}${
    cut.length
      ? `\n\n[not shown, over the ${LANDED_BUDGET}-char budget: ${cut.join(
          ", ",
        )}]`
      : ""
  }`;
}

/** How long the slice's tests may run against the base. */
const TEST_ON_BASE_TIMEOUT_MS =
  Number(process.env.SLICE_TEST_ON_BASE_TIMEOUT_SECONDS ?? 600) * 1000;

/** Output lines of that run the reviewer is shown. */
const TEST_ON_BASE_TAIL = 40;

/** What counts as a test file when `testOnBase.files` is left out. */
const isTestFile = ignores(
  config.testOnBase?.files ?? [
    "**/*.test.*",
    "*.test.*",
    "**/*.spec.*",
    "*.spec.*",
  ],
);

/**
 * A slice that changes one of these has dependencies the base does not, and
 * its tests against the base's install say nothing about the tests.
 */
const MANIFESTS = new Set([
  "package.json",
  "package-lock.json",
  "bun.lock",
  "bun.lockb",
  "yarn.lock",
  "pnpm-lock.yaml",
  "Cargo.toml",
  "Cargo.lock",
  "go.mod",
  "go.sum",
  "pyproject.toml",
  "requirements.txt",
  "uv.lock",
  "poetry.lock",
  "Gemfile",
  "Gemfile.lock",
]);

/** The throwaway worktree for one slice's run, beside the slice's own. */
const baseTestDir = (id: TicketId) => `${worktreeFor(id)}-base-test`;

/** Remove it, whatever state it was left in. */
function removeBaseTest(id: TicketId): void {
  const dir = baseTestDir(id);
  if (!existsSync(dir)) return;
  run(["git", "worktree", "remove", "--force", dir], { allowFail: true });
  // A directory git no longer knows as a worktree, or could not remove.
  rmSync(dir, { recursive: true, force: true });
  run(["git", "worktree", "prune"], { allowFail: true });
}

/**
 * Run the test files this slice adds or changes against the base branch as it
 * was before the slice, for the spec review to read. See `testOnBase` in
 * slice-config.ts for why, and for why the answer is evidence and not a gate.
 *
 * Null when the feature is off or the slice touches no test file: nothing is
 * said. Otherwise `line` is the run log's, and `section` the prompt's, absent
 * when the run was skipped.
 *
 * Called after the rebase and the gates, so the merge base is the commit the
 * slice now sits on, and the test files are the ones that will land.
 */
function testsOnBase(id: TicketId): { line: string; section?: string } | null {
  const conf = config.testOnBase;
  if (!conf) return null;
  const onto = mergeBase(id);
  if (!onto) return null;
  // Added, modified or renamed-to: a deleted test file has nothing to run.
  const tests = run(
    [
      "git",
      "diff",
      "--name-only",
      "--diff-filter=AMR",
      `${onto}..${branchFor(id)}`,
    ],
    { allowFail: true },
  )
    .out.split("\n")
    .map((l) => l.trim())
    .filter((f) => f && isTestFile(f));
  if (tests.length === 0) return null;

  const manifest = changedFiles(id).find((f) =>
    MANIFESTS.has(f.split("/").pop() ?? ""),
  );
  if (manifest) {
    return {
      line: `skipped — the slice changes ${manifest}, so the base's dependencies are not the slice's`,
    };
  }

  const dir = baseTestDir(id);
  removeBaseTest(id);
  try {
    const made = run(["git", "worktree", "add", "--detach", dir, onto], {
      allowFail: true,
    });
    if (!made.ok) {
      return {
        line: `skipped — the throwaway worktree could not be made: ${
          made.out.split("\n").pop() ?? ""
        }`,
      };
    }
    // What prep gives a worktree, without the install: the slice's own
    // node_modules by reference, and the gitignored files the config names.
    const wt = worktreeFor(id);
    if (existsSync(join(wt, "node_modules"))) {
      symlinkSync(join(wt, "node_modules"), join(dir, "node_modules"));
    }
    for (const f of config.provisionCopy) {
      const from = join(repoRoot, f);
      const to = join(dir, f);
      if (existsSync(from) && !existsSync(to)) {
        mkdirSync(dirname(to), { recursive: true });
        copyFileSync(from, to);
      }
    }
    const got = run(["git", "checkout", branchFor(id), "--", ...tests], {
      cwd: dir,
      allowFail: true,
    });
    if (!got.ok) {
      return {
        line: "skipped — the slice's test files could not be checked out onto the base",
      };
    }

    const argv = conf.command(tests);
    const proc = spawnSync(argv[0] as string, argv.slice(1), {
      cwd: dir,
      stdio: "pipe",
      encoding: "utf8",
      timeout: TEST_ON_BASE_TIMEOUT_MS,
      maxBuffer: 64 * 1024 * 1024,
    });
    if (proc.error) {
      const timedOut =
        (proc.error as NodeJS.ErrnoException).code === "ETIMEDOUT";
      return {
        line: timedOut
          ? `skipped — the command did not finish in ${Math.round(
              TEST_ON_BASE_TIMEOUT_MS / 1000,
            )}s`
          : `skipped — the command could not be run: ${proc.error.message}`,
      };
    }
    const failed = proc.status !== 0;
    const tail = `${proc.stdout ?? ""}${proc.stderr ?? ""}`
      .trimEnd()
      .split("\n")
      .slice(-TEST_ON_BASE_TAIL)
      .join("\n");
    return {
      line: failed ? "fail (expected for a fix)" : "pass",
      section: `The test files this slice adds or changes were run against the base branch as it was before this slice (${onto.slice(
        0,
        12,
      )}), in a throwaway checkout holding the base's code and only these files from the slice:
${tests.join("  ")}
command: ${argv.join(" ")}
result: ${
        failed
          ? `exited ${
              proc.status ?? "on a signal"
            } — the tests FAIL on the base`
          : "exited 0 — the tests PASS on the base"
      }
last ${TEST_ON_BASE_TAIL} lines of output:
${tail || "(no output)"}`,
    };
  } catch (e) {
    return {
      line: `skipped — ${e instanceof Error ? e.message : String(e)}`,
    };
  } finally {
    removeBaseTest(id);
  }
}

/** Left in an open slice's worktree when a sibling lands on its files. */
const LANDED_NOTE = ".slice-landed.md";

/**
 * Tell the open slices that `landed` just changed files they have changed
 * too: a note in each one's worktree, appended per land, which its session
 * may or may not read. The review at its own land is what checks; this is the
 * cheap chance to get it right before then. Written whether or not review is
 * on.
 *
 * Only where git ignores the file (the pattern is in init's exclude block):
 * elsewhere it would be an untracked change, and a slice with one is not
 * clean and does not land.
 */
function noteLanded(landed: Ticket, files: string[]): void {
  const range = landedRanges.get(landed.id);
  if (!range) return;
  for (const t of tickets) {
    if (!t.open || t.id === landed.id || !hasWorktree(t.id)) continue;
    const shared = sharedFiles(files, changedFiles(t.id));
    if (shared.length === 0) continue;
    const wt = worktreeFor(t.id);
    const { ok: ignored } = run(["git", "check-ignore", "-q", LANDED_NOTE], {
      cwd: wt,
      allowFail: true,
    });
    if (!ignored) continue;
    const path = join(wt, LANDED_NOTE);
    let before = "";
    try {
      before = readFileSync(path, "utf8");
    } catch {
      // The first land under this slice.
    }
    writeFileSync(
      path,
      `${
        before ||
        `# Landed under this slice\n\nOther slices of this plan landed on files this one has changed. Your branch does not have them until it is rebased at land. Before you finish, read what they changed: if one set up something this slice should join, extend or respect (a shared guard, a registry, an invariant stated in a comment), do that. The review at land checks for it.\n`
      }\n## ${ref(landed.id)} — ${
        landed.title
      }\n\nFiles you both changed:\n${shared
        .map((f) => `- ${f}`)
        .join("\n")}\n\nCommits:\n\n${landedSubjects(range)
        .split("\n")
        .map((l) => `    ${l}`)
        .join("\n")}\n\nWhat it changed there: \`git diff ${range.from.slice(
        0,
        12,
      )} ${range.to.slice(0, 12)} -- ${shared.join(" ")}\`\n`,
    );
    console.log(`  noted in ${ref(t.id)}'s worktree: ${LANDED_NOTE}`);
  }
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

  const onBase = testsOnBase(t.id);
  if (onBase) console.log(`  new tests on base: ${onBase.line}`);

  console.log(`  reviewing ${ref(t.id)} (spec + standards) …`);
  const parent = parentSpec(t.id);
  const spec = reviewSpec(
    `${ref(t.id)} — ${t.title}\n\n${ticketBody(t.id)}`,
    scope,
    commits,
    diff,
    wt,
    {
      parent: parent.text,
      landed: landedUnder(t.id),
      testsOnBase: onBase?.section,
    },
  );
  if (parent.note) spec.report = `${parent.note}\n\n${spec.report}`;
  if (onBase && !onBase.section) {
    spec.report = `(new tests on base: ${onBase.line})\n\n${spec.report}`;
  }
  const standards = reviewStandards(scope, commits, diff, wt);

  const heading = `# Review — ${ref(t.id)} ${t.title}`;
  const body = `### Spec\n\n${spec.report}\n\n### Standards\n\n${standards}\n`;
  const path = saveReport(`ticket-${t.id}.md`, body, heading);

  console.log(`\n${heading}\n\n${body}`);
  console.log(`  report saved: ${path}`);

  if (spec.block && (reviewBlocks || resolvedByAgent.has(t.id))) {
    console.log(
      `  ✗ ${ref(
        t.id,
      )} not landed — spec review says BLOCK. Fix it in the worktree, correct the ticket if the spec is wrong, or land it without the review: ./scripts/slice-land.sh ${
        t.id
      }.`,
    );
    // The path is printed above too, as `report saved:`, but the review's text
    // comes between, and a log cut short at the ✗ line lost it.
    console.log(`     review: ${path}`);
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
 *
 * So it cannot block, and what it can do is not be missed. It returns its
 * count, and the run ends on a line that names it and exits 2 when there is
 * anything to read: on consumer-a three unwatched waves ended "plan complete",
 * exit 0, with eight findings between them in a file nobody was pointed at.
 * Null when no review ran.
 */
type PlanReview = {
  /** How many findings it reported, or null when it gave no count at all. */
  findings: number | null;
  path: string;
};

function reviewPlan(tickets: Ticket[], base: string): PlanReview | null {
  if (!reviewEnabled) return null;
  const range = `${base}...${baseBranch}`;
  const diff = diffFor(range, repoRoot);
  if (diff === "(empty diff)") return null;

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
  const answer = askAgent(
    `Several tickets were implemented independently, each in its own worktree, each reviewed and gate-checked ALONE. They have all landed on ${baseBranch}. Your job is the one thing none of those per-slice reviews could see: how the slices fit together.

Report ONLY cross-cutting findings — things invisible when reading any single slice's diff on its own:
 - the same concept implemented two different ways by two slices;
 - duplication introduced across slices (each reasonable alone);
 - a call site half-migrated: slice A changed a shape, slice B still uses the old one;
 - a rival abstraction — two slices each inventing their own helper for one job;
 - dead or orphaned code left behind by a later slice superseding an earlier one;
 - inconsistent naming or error handling across the set.

Do NOT re-report anything confined to a single slice; that was already reviewed. If there are no cross-cutting findings, say exactly: "No cross-cutting findings." Under 500 words.

Then, as the FINAL line and nothing after it, print the number of findings you reported, exactly in this form (0 when there are none):
FINDINGS: <number>

TICKETS IN THIS PLAN:
${spec}

COMMITS:
${commits}

COMBINED DIFF:
${diff}`,
    repoRoot,
  );

  // The last such line, with the emphasis a model asked for a plain line often
  // adds. No line is no count, and is reported as that: the same fail-closed
  // reading the spec review gives a missing VERDICT.
  const counts = [
    ...(answer ?? "").matchAll(/^[\s>*`_]*FINDINGS:[*`_]*[ \t]*(\d+)/gm),
  ];
  const last = counts[counts.length - 1]?.[1];
  const findings = last === undefined ? null : Number(last);
  const crossCutting = !answer
    ? "(plan review did not return)"
    : findings === null
      ? `${answer}\n\n(no parseable FINDINGS line — reported as no result)`
      : answer;

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const body = `# Plan review — ${scope}\n\n${crossCutting}\n`;
  const path = saveReport(`plan-${stamp}.md`, body);
  console.log(`\n${crossCutting}\n`);
  console.log(`  report saved: ${path}`);
  return { findings, path };
}

// ─── landing ──────────────────────────────────────────────────────────────

const commitsAhead = (n: TicketId) =>
  run(["git", "log", "--oneline", `${baseBranch}..HEAD`], {
    cwd: worktreeFor(n),
    allowFail: true,
  })
    .out.split("\n")
    .filter((l) => l.trim()).length;

/** Nothing modified, staged or untracked; the markers are excluded by `init`. */
const isClean = (n: TicketId) =>
  !run(["git", "status", "--porcelain"], {
    cwd: worktreeFor(n),
    allowFail: true,
  }).out.trim();

/**
 * Under `--auto`, a slice counts as finished when its session is gone and it
 * left commits behind — no `slice-done.sh`. `occupied` rather than
 * `hasSession` on purpose: it also covers the launch grace window, so a
 * worktree prepped seconds ago whose tab has not opened yet is not read as a
 * session that closed. The commits check comes before the gates only to keep
 * an idle prepped worktree from printing "nothing to land" every round.
 *
 * Not while it waits on the DB lock: the skill tells a slice refused at
 * `claim` to commit what it has OUTSIDE the exclusive paths and exit, and
 * without this clause that exit, with those commits behind it, would read as
 * a finished ticket and land half of one.
 *
 * And not when its session crashed. On consumer-a a slice with one commit
 * and five uncommitted files counted as finished once its stale marker was
 * cleared, and the land refused it for a dirty tree and parked it where no
 * session is ever relaunched. Both of these send such a slice to `runnable`
 * instead, which relaunches it:
 *  - `.slice-interrupted`, the direct evidence, written when `hasSession`
 *    finds the marker's session gone;
 *  - a dirty tree, for the other ways a marker goes missing: a person deleted
 *    it by hand, or a dispatcher from before the check was running. A session
 *    that finished commits its work.
 * A crashed slice with a clean tree and no marker still reads as finished.
 * There, the review is what catches half a ticket.
 *
 * Nor with a git operation in progress in its worktree: see `inProgress`.
 */
const autoFinished = (n: TicketId) =>
  !inProgress.has(n) &&
  !occupied(n) &&
  !isWaitingOnLock(n) &&
  !wasInterrupted(n) &&
  commitsAhead(n) > 0 &&
  isClean(n);

/**
 * The gate lock's directory, in the common git dir every worktree shares.
 * Read once: the main checkout's git dir does not move during a run.
 */
let gatesLockDir: string | undefined;
const gatesLock = () => {
  gatesLockDir ??= join(
    run(["git", "rev-parse", "--path-format=absolute", "--git-common-dir"]).out,
    "azelf-gates.lock",
  );
  return gatesLockDir;
};

/**
 * Gates that passed only on a retry: per slice from its last gate run, and
 * per LANDED slice for the end of the run. A pass on a retry lands, and the
 * summary names it, so a flaky suite is seen and not buried.
 */
const flakyGates = new Map<TicketId, Flaky[]>();
const landedOnRetry = new Map<TicketId, Flaky[]>();

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
  flakyGates.delete(n);
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

  // One gate run per repo at a time. This process already gates one slice at
  // a time; the lock stops a second dispatcher's gates running on top of
  // them, which on consumer-a meant a load average near 30 and green slices
  // parked on test timeouts. Waits for as long as the holder is running: this
  // round has nothing to do until its gates have run, and a holder that dies
  // is taken over. The sessions' own test runs are not covered; that is what
  // a gate's `retries` is for.
  acquire(gatesLock(), {
    pid: process.pid,
    label: ref(n),
    onWait: (h) =>
      console.log(
        h
          ? `  waiting for ${h.label}'s gates (another dispatcher, pid ${h.pid}) …`
          : "  waiting for the gate lock …",
      ),
    onTakeover: (h) =>
      console.log(
        `  took over the gate lock${
          h ? ` from ${h.label} (pid ${h.pid})` : ""
        } — that process is no longer running`,
      ),
  });
  let result: ReturnType<typeof runGates>;
  try {
    result = runGates(config.gates, {
      worktree: wt,
      // The main checkout is the baseline: it sits on the base branch the slice
      // was just rebased onto, so its errors are exactly the standing debt.
      baselineDir: repoRoot,
      changedFiles: changed,
      exec: (cmd, cwd) => run(cmd, { cwd, allowFail: true }),
    });
  } finally {
    release(gatesLock(), process.pid);
  }
  for (const f of result.flaky) {
    console.log(
      `  ⚠ \`${f.gate}\` failed, then passed on retry ${f.retry} — flaky under load`,
    );
  }
  if (result.ok) {
    if (result.flaky.length) flakyGates.set(n, result.flaky);
    return true;
  }

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
 * exactly as its agent left it. This function ABORTS EVEN WHEN A RESOLVER IS
 * AVAILABLE, and that is deliberate: `resolveConflict` re-runs `git rebase`
 * itself and hits the same conflicts deterministically, which costs one extra
 * rebase and keeps "leaves nothing behind" an unconditional property of this
 * function. The alternative — handing the resolver a mid-rebase worktree —
 * makes that contract depend on what the caller does next, and leaves a parked
 * worktree sitting in a half-finished rebase for whoever opens it.
 *
 * The conflicted paths come back rather than being printed here, because who
 * prints them depends on what happens next: the escalation prompt shows them
 * next to the `[a]` option, and the resolver puts them in its prompt.
 */
function rebaseOntoBase(t: Ticket): { ok: boolean; conflicted: string[] } {
  const wt = worktreeFor(t.id);
  if (
    run(["git", "merge-base", "--is-ancestor", baseBranch, "HEAD"], {
      cwd: wt,
      allowFail: true,
    }).ok
  ) {
    return { ok: true, conflicted: [] };
  }

  console.log(
    `  ${ref(t.id)} is behind ${baseBranch} — rebasing before the gates …`,
  );
  if (run(["git", "rebase", baseBranch], { cwd: wt, allowFail: true }).ok) {
    return { ok: true, conflicted: [] };
  }

  // Name the files BEFORE aborting — after the abort there is nothing left to
  // inspect, and "it conflicts" alone means whoever picks this up has to
  // reproduce the rebase just to learn where. In practice the answer is
  // usually the same: two slices in one wave both appended to the shared
  // locale files and the shared test file.
  const conflicted = run(["git", "diff", "--name-only", "--diff-filter=U"], {
    cwd: wt,
    allowFail: true,
  })
    .out.split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  run(["git", "rebase", "--abort"], { cwd: wt, allowFail: true });
  return { ok: false, conflicted };
}

/**
 * Per stop of the rebase, not per resolution: the resolver is called once for
 * each commit that conflicts. Longer than the review's ten minutes, because
 * this one has tools: it reads files, edits them, and may run the project's
 * checks. A review that times out costs a review; this one times out into
 * files still holding markers, which the stop check below catches — so the
 * budget is generous and the check is strict.
 */
const RESOLVE_TIMEOUT_MS = 20 * 60 * 1000;

/** A path inside a worktree's git dir — `rebase-merge` and friends. */
function gitPath(wt: string, name: string): string {
  const { ok, out } = run(["git", "rev-parse", "--git-path", name], {
    cwd: wt,
    allowFail: true,
  });
  const p = out.trim();
  // Asked rather than assumed: a slice lives in a linked worktree, so its git
  // dir is `.git/worktrees/<name>` in the main checkout and `<wt>/.git` is a
  // file pointing there. `join(wt, ".git", "rebase-merge")` would be a path
  // that never exists, which reads as "no rebase in progress" — the exact
  // wrong answer, and one that fails open.
  if (!ok || !p) return join(wt, name);
  return isAbsolute(p) ? p : join(wt, p);
}

const changedIn = (wt: string, range: string): string[] =>
  run(["git", "diff", "--name-only", range], { cwd: wt, allowFail: true })
    .out.split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

/**
 * A git path list, NUL-separated so a path is never quoted: the stop check
 * compares these lists with each other, and `git status` quotes a path with a
 * space in it where `git diff --name-only` does not.
 */
const pathsFrom = (wt: string, args: string[]): string[] =>
  run(["git", ...args, "-z"], { cwd: wt, allowFail: true })
    .out.split("\0")
    .filter(Boolean);

const unmergedIn = (wt: string): string[] =>
  pathsFrom(wt, ["diff", "--name-only", "--diff-filter=U"]);

const rebaseInProgress = (wt: string): boolean =>
  existsSync(gitPath(wt, "rebase-merge")) ||
  existsSync(gitPath(wt, "rebase-apply"));

/** What each git-dir entry means is in progress, in the order `handWork` asks. */
const IN_PROGRESS: [string, string][] = [
  ["rebase-merge", "rebase"],
  ["rebase-apply", "rebase"],
  ["MERGE_HEAD", "merge"],
  ["CHERRY_PICK_HEAD", "cherry-pick"],
  ["REVERT_HEAD", "revert"],
];

/**
 * The git operation left in progress in a worktree ("rebase", "merge", …),
 * or null when there is none. One `rev-parse` for all five paths, because
 * this is asked for every open worktree every round.
 */
function handWork(wt: string): string | null {
  const { ok, out } = run(
    ["git", "rev-parse", ...IN_PROGRESS.flatMap(([p]) => ["--git-path", p])],
    { cwd: wt, allowFail: true },
  );
  const paths = out.split("\n").map((l) => l.trim());
  // A worktree git cannot read has nothing in progress that git would know
  // about either; the land's own checks say what is wrong with it.
  if (!ok || paths.length < IN_PROGRESS.length) return null;
  for (const [i, [, what]] of IN_PROGRESS.entries()) {
    const p = paths[i] as string;
    if (existsSync(isAbsolute(p) ? p : join(wt, p))) return what;
  }
  return null;
}

/**
 * Worktrees with a git operation in progress, by ticket, read at the top of
 * every round by `noteHandWork`. Such a slice is not landed, not relaunched,
 * and not finished under --auto. It is not parked either, and it keeps the
 * run from stopping: it waits on a person, and is back in the run the round
 * the operation ends.
 *
 * The land is why. `rebaseOntoBase` starts its own rebase when the branch is
 * behind the base. With someone's rebase already in progress that one fails,
 * and its cleanup `git rebase --abort` aborts THEIRS and throws their
 * resolution away. That happens whenever the base moved after they started,
 * which two dispatchers landing onto one base make routine; it was reproduced
 * in a scratch repo on 2026-09-24. While the base stands still the symptom is
 * milder: the gates refuse a dirty tree and blame the slice for it.
 *
 * Not closed: the seconds between a hand commit and the hand rebase after it.
 * The commit moves the branch, which un-parks the slice, and a land in that
 * gap starts its own rebase first. The person's `git rebase` then fails with
 * git's "already a rebase-merge directory": seen, and nothing lost.
 */
const inProgress = new Map<TicketId, string>();
/** The ones announced, so each is printed once when seen and once when it ends. */
const announced = new Set<TicketId>();

function noteHandWork(tickets: Ticket[]): void {
  for (const t of tickets) {
    if (!t.open) {
      inProgress.delete(t.id);
      announced.delete(t.id);
      continue;
    }
    const what = hasWorktree(t.id) ? handWork(worktreeFor(t.id)) : null;
    if (what) inProgress.set(t.id, what);
    else inProgress.delete(t.id);
    // Recorded but not announced while a session runs there: that is the
    // agent's own rebase, and a running session is neither landed nor
    // relaunched anyway. Recording it still covers the session ending
    // mid-operation, which leaves the same state a person would.
    if (what && !announced.has(t.id) && !occupied(t.id)) {
      announced.add(t.id);
      console.log(
        `  ${ref(
          t.id,
        )}: a ${what} is in progress in its worktree, with no session running there — someone is fixing it by hand, most likely. Not landing or relaunching it until the ${what} is finished or aborted.`,
      );
    } else if (!what && announced.delete(t.id)) {
      console.log(
        `  ${ref(
          t.id,
        )}: nothing is in progress in its worktree any more — back in the run.`,
      );
    }
  }
}

/** Which of these files, relative to the worktree, hold conflict markers. */
const withMarkers = (wt: string, files: string[]): string[] =>
  files.filter((f) => {
    try {
      return hasConflictMarkers(readFileSync(join(wt, f), "utf8"));
    } catch {
      // Deleted by the resolution, or not text. Neither can hold a marker.
      return false;
    }
  });

/**
 * The instruction the resolver is given, once per stop of the rebase. Every
 * rule in it is here because something went wrong without it in consumer-a's
 * first three-slice wave, and the last paragraph because of its fourth: told
 * to finish the rebase itself, the resolver needed `git add`, which its
 * permission mode does not grant, and correct resolutions were thrown away
 * with the rebase still in progress.
 */
function resolvePrompt(
  t: Ticket,
  conflicted: string[],
  landedCommits: string,
  replaying: string,
): string {
  return `You are resolving a git conflict in this worktree. That is the whole job.

Branch \`${branchFor(
    t.id,
  )}\` is being rebased onto \`${baseBranch}\`. The rebase is IN PROGRESS in this directory and has stopped${
    replaying ? ` replaying ${replaying}` : ""
  } on conflicts in:

${conflicted.map((f) => `  ${f}`).join("\n")}

WHAT THIS BRANCH IS FOR — ticket ${ref(t.id)}, ${t.title}:

${ticketBody(t.id)}

WHAT IT IS REBASING OVER — commits already on ${baseBranch} that it does not have:

${landedCommits || "(none listed)"}

RULES. These are not advice; a resolution that breaks one of them is thrown away.

1. "Keep both sides" is only valid when git's \`=======\` falls on a BLOCK
   BOUNDARY. It is wrong for import lists, JSON objects, union types, and any
   conflict whose split runs through a brace, a bracket or a call. Concatenating
   the two sides of a conflict that split a \`describe(...)\` body is how this
   rule got written: it produced \`error TS1005: '}' expected\` in ten files.
   Read what the braces actually do before you keep both halves.
2. Never resolve by discarding one side. Both sides are work somebody meant. If
   the two genuinely cannot coexist, STOP: leave the files exactly as they are
   and print one line starting \`IRRECONCILABLE:\` that says what the
   disagreement is. Stopping is a correct outcome and it is much better than a
   plausible-looking wrong merge.
3. Both intents matter. The ticket above says what this branch is trying to do;
   the commit list says what it is landing on top of. The resolved file has to
   still do both.
4. Verify before you say you are done: no \`<<<<<<<\`, \`=======\` or \`>>>>>>>\`
   left in the files above, the files you touched still parse, and the
   project's checks pass.
5. Resolve the conflict and NOTHING ELSE. Edit only the files listed above. Do
   not rename anything, do not take the opportunity to improve the code you are
   looking at. The diff you produce should be explicable as "this is what the
   two sides together mean". A change anywhere else fails the resolution.

HOW TO FINISH: edit the conflicted files until they are resolved, and stop. Do
not run \`git add\`, \`git rebase --continue\`, \`git rebase --abort\`,
\`git commit\`, \`git reset\` or \`git stash\`: azelf stages the files above and
continues the rebase itself once you have finished, and calls you again if the
next commit stops too. Reading git — \`git diff\`, \`git log\`, \`git show\` — is
fine. To resolve a conflict by deleting a file, delete it.`;
}

/**
 * Let the agent resolve a rebase conflict, then check its work.
 *
 * The resolver edits and azelf runs the git. For every commit the rebase stops
 * on, the resolver is handed that stop's conflicted files; when it returns,
 * the stop is checked (`stopProblem`: no refusal, no markers left in those
 * files, nothing changed outside them), and only then does this function
 * `git add -A` exactly those files and `rebase --continue`. `-A` so that a
 * resolution which deletes a file stages the deletion: an unmerged path is
 * still in the index, and plain `add` would refuse it.
 *
 * Returns true ONLY if the branch is now rebased, clean and free of conflict
 * markers — the gates are check 5 and `tryLand` runs them immediately after
 * this returns, which is why they are not repeated here.
 *
 * Nothing here trusts the resolver's own report. It gets read into the
 * transcript, and the one line it can say that counts is a refusal
 * (`IRRECONCILABLE:`); everything else is decided from the state of the
 * worktree.
 */
function resolveConflict(t: Ticket, conflicted: string[]): boolean {
  const argvFor = agent.resolve;
  if (!argvFor) return false;
  const wt = worktreeFor(t.id);
  const branch = branchFor(t.id);

  // The base as a COMMIT, read once. A resolver gets twenty minutes a stop, and
  // a land elsewhere — this run's, or a second dispatcher's — moves the branch
  // name meanwhile. Everything below asks about the commit this resolution
  // rebased onto; a check against the name would compare a finished rebase
  // with a commit that arrived after it, and on consumer-a threw a correct
  // two-stop resolution away for exactly that. `tryLand` rebases again
  // afterwards if the base moved.
  const onto = run(["git", "rev-parse", baseBranch], {
    cwd: wt,
    allowFail: true,
  }).out.trim();
  if (!onto) {
    console.log(
      `     ✗ could not read ${baseBranch} — not attempting a resolution.`,
    );
    return false;
  }

  // Read BEFORE the rebase starts, because all of these are about the branch
  // as its author left it: the file set is what check 6 compares against, the
  // commit count is the most stops the rebase can make, and the commit list is
  // the other slices' work, which the merge-base stops being able to name once
  // the rebase has moved the branch.
  const before = changedIn(wt, `${onto}...${branch}`);
  const head = run(["git", "rev-parse", "HEAD"], {
    cwd: wt,
    allowFail: true,
  }).out.trim();
  const replayed =
    Number(
      run(["git", "rev-list", "--count", `${onto}..${branch}`], {
        cwd: wt,
        allowFail: true,
      }).out.trim(),
    ) || 0;
  const mergeBase = run(["git", "merge-base", onto, branch], {
    cwd: wt,
    allowFail: true,
  }).out.trim();
  const landedCommits = run(
    ["git", "log", "--oneline", onto, "--not", mergeBase || onto],
    { cwd: wt, allowFail: true },
  ).out;

  console.log(
    `\n  resolving ${ref(t.id)}'s conflict with ${baseBranch} (${
      conflicted.length
    } file${conflicted.length === 1 ? "" : "s"}) …`,
  );

  // `rebaseOntoBase` aborted, on purpose — see its comment. Re-run it here to
  // stop on the same conflicts, in this function, where the abort on failure is
  // ours to make.
  if (run(["git", "rebase", onto], { cwd: wt, allowFail: true }).ok) {
    // Not impossible: a land in the same round can move the base branch between
    // the two attempts, and the second one is the one that counts.
    console.log(
      `     ✓ the rebase applied cleanly this time — nothing for the resolver to do.`,
    );
    return true;
  }

  // One entry per stop: the files the resolver was given and what it printed.
  const stops: { files: string[]; out: string }[] = [];
  const report = (verdict: string): string =>
    saveReport(
      `conflict-${t.id}.md`,
      `${verdict}\n\n${
        stops.length
          ? stops
              .map(
                (s, i) =>
                  `### Stop ${i + 1}: ${s.files.join(", ")}\n\n${
                    s.out.trim() || "(the agent printed nothing)"
                  }`,
              )
              .join("\n\n")
          : `### Conflicted files\n\n${conflicted
              .map((f) => `- ${f}`)
              .join("\n")}\n\n(the agent was not run)`
      }\n`,
      `# Conflict resolution — ${ref(t.id)} ${t.title}`,
    );

  const give = (why: string): boolean => {
    run(["git", "rebase", "--abort"], { cwd: wt, allowFail: true });
    // An abort is not enough on its own: a rebase that got through every stop
    // can still fail the final check — markers in a file that never conflicted,
    // a tree dirty afterwards. There is no rebase left to abort by then, so
    // without this the branch keeps the bad resolution and "the branch is as it
    // was" would be a lie. `head` is this branch's own commit from a moment ago, so the
    // reset discards exactly the resolution and nothing else.
    const now = run(["git", "rev-parse", "HEAD"], {
      cwd: wt,
      allowFail: true,
    }).out.trim();
    if (head && now && now !== head) {
      run(["git", "reset", "--hard", head], { cwd: wt, allowFail: true });
    }
    const path = report(`REJECTED: ${why}`);
    console.log(`     ✗ resolution rejected — ${why}`);
    console.log(`     the rebase was aborted; the branch is as it was.`);
    console.log(`     transcript: ${path}`);
    return false;
  };

  // What the last `--continue` said, for a rebase that then stops on nothing.
  let continued = "";
  while (rebaseInProgress(wt)) {
    const files = unmergedIn(wt);
    if (files.length === 0) {
      const said = continued
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean)
        .join(" ")
        .slice(0, 200);
      return give(
        `the rebase stopped with nothing left conflicted${
          said ? ` — git said: ${said}` : ""
        }`,
      );
    }
    // A commit stops at most once, so a rebase still stopping after one stop
    // per commit is going round in a loop, not making progress.
    if (stops.length > replayed) {
      return give(
        `the rebase stopped ${
          stops.length + 1
        } times replaying ${replayed} commit(s)`,
      );
    }
    if (stops.length > 0) {
      console.log(
        `     the next commit stops too (${files.length} file${
          files.length === 1 ? "" : "s"
        }) — resolving that …`,
      );
    }

    const replaying = run(
      ["git", "log", "-1", "--format=%h %s", "REBASE_HEAD"],
      { cwd: wt, allowFail: true },
    );
    const argv = argvFor(
      resolvePrompt(
        t,
        files,
        landedCommits,
        replaying.ok ? replaying.out.trim() : "",
      ),
    );
    if (!argv) return give("the agent declined the headless run");
    const { out } = run(argv, {
      cwd: wt,
      allowFail: true,
      timeoutMs: RESOLVE_TIMEOUT_MS,
    });
    stops.push({ files, out });

    const given = new Set(files);
    const problem = stopProblem({
      output: out,
      markerFiles: withMarkers(wt, files),
      stray: [
        ...new Set([
          ...pathsFrom(wt, ["diff", "--name-only"]),
          ...pathsFrom(wt, ["ls-files", "--others", "--exclude-standard"]),
        ]),
      ].filter((p) => !given.has(p)),
    });
    if (problem) return give(problem);

    const add = run(["git", "add", "-A", "--", ...files], {
      cwd: wt,
      allowFail: true,
    });
    if (!add.ok) return give(`git add failed: ${add.out}`);
    // GIT_EDITOR rather than `-c core.editor`: the environment variable wins
    // over the config, so an exported GIT_EDITOR would otherwise open an
    // editor nobody is at.
    continued = run(["git", "rebase", "--continue"], {
      cwd: wt,
      allowFail: true,
      env: { GIT_EDITOR: "true" },
    }).out;
  }

  const after = changedIn(wt, `${onto}...HEAD`);
  const state: ResolutionState = {
    base: `${baseBranch} at ${onto.slice(0, 7)}`,
    rebaseInProgress: rebaseInProgress(wt),
    dirty: run(["git", "status", "--porcelain"], { cwd: wt, allowFail: true })
      .out.split("\n")
      .map((l) => l.trim())
      .filter(Boolean),
    rebased: run(["git", "merge-base", "--is-ancestor", onto, "HEAD"], {
      cwd: wt,
      allowFail: true,
    }).ok,
    markerFiles: withMarkers(wt, after),
  };

  const problem = resolutionProblem(state);
  if (problem) return give(problem);

  const path = report(
    `ACCEPTED: rebased onto ${baseBranch} over ${stops.length} stop(s), clean, no conflict markers. The gates run next.`,
  );
  console.log(
    `     ✓ rebased onto ${baseBranch}, clean, no markers left — the gates run next`,
  );
  // Check 6: reported, never gated. See droppedFiles in slice-resolve.ts for
  // why a legitimate resolution is allowed to drop a file.
  for (const f of droppedFiles(before, after)) {
    console.log(`     ⚠ ${f} was in the diff before and is not now`);
  }
  console.log(`     transcript: ${path}`);
  resolvedByAgent.add(t.id);
  const now = baseHead();
  if (now && now !== onto) {
    console.log(
      `     ${baseBranch} moved during the resolution (${onto.slice(
        0,
        7,
      )} → ${now.slice(0, 7)}) — rebasing onto the new commits …`,
    );
  }
  return true;
}

/**
 * Why a ticket is not being retried, and what was true when it failed.
 *
 * THE BUG THIS EXISTS TO KILL. A land runs the gates and two `claude -p`
 * reviews. A spec review returning BLOCK failed the land, the ready marker
 * stayed on disk, and the next round tried the identical branch again — gates,
 * both reviews, same verdict, forever. A review verdict on an unchanged diff
 * cannot change, so the retry was not optimism, it was a paid loop. One run
 * burned about an hour of review calls on ticket #3 before anyone noticed.
 *
 * So a parked slice is retried only when something its failure depended on
 * has changed, and what that is depends on the kind of failure:
 *
 *  - its branch moved — every kind. Somebody committed a fix in the worktree.
 *  - the base branch moved — `gates` and `land` only, at most AUTO_RETRIES
 *    times per branch head. A lost fast-forward race and a flaky test fixed on
 *    the base both clear this way, and on consumer-a both had been worked
 *    around by rebasing a correct branch just to move it. Capped because every
 *    land moves the base, and a slice whose own code is red should not re-run
 *    the gates after each one.
 *  - the ticket body changed — `review` only. A BLOCK against a stale ticket
 *    is fixed on the tracker, not in the branch.
 *  - `azelf retry <id>` — every kind, through the `.slice-retry` marker.
 *
 * `rebase` gets no base trigger: each attempt can be a resolver run of up to
 * twenty minutes, against a conflict a moving base rarely removes.
 */
type ParkKind = "rebase" | "gates" | "review" | "land";
type Parked = {
  reason: string;
  kind: ParkKind;
  /** The slice branch's commit when it parked. */
  head: string;
  /**
   * The base-branch commit the branch was last tried against: its merge-base
   * when it parked. Not the base's head then, because a land that lost a
   * fast-forward race parks AFTER the other land moved the base, and the head
   * would already include the very move that should retry it.
   */
  base: string;
  /** `review` only: a hash of the ticket body the BLOCK was given against. */
  body?: string;
  /** Automatic retries on a base move, spent since the branch last moved. */
  autoRetries: number;
  /** The cap has been reported for this park, so it is not reported every round. */
  capNoted?: boolean;
};
const parked = new Map<TicketId, Parked>();

/** How many times a base move retries one `gates` or `land` park. */
const AUTO_RETRIES = 2;

/**
 * The automatic retries a retried ticket has already spent, handed from the
 * trigger to the `park` that follows it if the retry fails too. Not kept on
 * `Parked`, because a retry deletes that record. Counted per branch HEAD in
 * the author's sense: a retry's own rebase moves the branch as well, and
 * counting that as a new head would make the cap reset every time it bit.
 */
const retriesSpent = new Map<TicketId, number>();

/** The slice branch's current commit, or null if it cannot be read. */
function branchHead(id: TicketId): string | null {
  const { ok, out } = run(["git", "rev-parse", branchFor(id)], {
    allowFail: true,
  });
  return ok && out.trim() ? out.trim() : null;
}

/** The base branch's current commit, or null if it cannot be read. */
function baseHead(): string | null {
  const { ok, out } = run(["git", "rev-parse", baseBranch], {
    allowFail: true,
  });
  return ok && out.trim() ? out.trim() : null;
}

/** Where the slice branch meets the base branch, or null if it cannot be read. */
function mergeBase(id: TicketId): string | null {
  const { ok, out } = run(["git", "merge-base", baseBranch, branchFor(id)], {
    allowFail: true,
  });
  return ok && out.trim() ? out.trim() : null;
}

/**
 * A hash of the ticket body, or null when the tracker cannot say. Null never
 * reads as "changed": a tracker that errors every other call would otherwise
 * turn each error into a full retry, which is the paid loop again.
 */
function bodyHash(id: TicketId): string | null {
  try {
    return createHash("sha256").update(tracker.body(id)).digest("hex");
  } catch {
    return null;
  }
}

/** Written by `azelf retry <id>` into the slice's worktree; consumed by `isParked`. */
const RETRY_MARKER = ".slice-retry";

/**
 * Why a parked ticket should be retried now, with the automatic retries it
 * will have spent, or null if nothing it waits on has changed. Reads only:
 * the round's exit check asks too, and must not consume anything.
 */
function retryDue(
  id: TicketId,
  p: Parked,
): { line: string; spent: number } | null {
  if (existsSync(join(worktreeFor(id), RETRY_MARKER))) {
    return {
      line: `${ref(id)}: retry requested — retrying the land.`,
      spent: p.autoRetries,
    };
  }
  const head = branchHead(id);
  if (head && head !== p.head) {
    return {
      line: `${ref(id)} has moved since it was parked — retrying the land.`,
      spent: 0,
    };
  }
  if (p.kind === "review" && p.body !== undefined) {
    const now = bodyHash(id);
    if (now !== null && now !== p.body) {
      return {
        line: `${ref(id)}: the ticket was edited since the BLOCK — retrying.`,
        spent: p.autoRetries,
      };
    }
  }
  if (
    (p.kind === "gates" || p.kind === "land") &&
    p.autoRetries < AUTO_RETRIES
  ) {
    const base = baseHead();
    if (base && base !== p.base) {
      return {
        line: `${baseBranch} moved since ${ref(
          id,
        )} was parked — retrying (automatic retry ${
          p.autoRetries + 1
        } of ${AUTO_RETRIES}).`,
        spent: p.autoRetries + 1,
      };
    }
  }
  return null;
}

/**
 * Has this ticket been parked, with nothing it waits on changed since? A
 * ticket that is due a retry is un-parked here, which is what retries it.
 */
function isParked(id: TicketId): boolean {
  const p = parked.get(id);
  const due = p ? retryDue(id, p) : null;
  // Consumed whether or not the ticket is parked: a request for a slice that
  // is not parked has nothing to retry, and left on disk it would un-park
  // that slice's next failure for nothing.
  rmSync(join(worktreeFor(id), RETRY_MARKER), { force: true });
  if (!p) return false;
  if (due) {
    console.log(`  ${due.line}`);
    parked.delete(id);
    retriesSpent.set(id, due.spent);
    return false;
  }
  const base = baseHead();
  if (
    (p.kind === "gates" || p.kind === "land") &&
    p.autoRetries >= AUTO_RETRIES &&
    !p.capNoted &&
    base &&
    base !== p.base
  ) {
    p.capNoted = true;
    console.log(
      `  ${baseBranch} moved, and ${ref(
        id,
      )} has had its ${AUTO_RETRIES} automatic retries at this branch head — staying parked. azelf retry ${id} tries again.`,
    );
  }
  return true;
}

/**
 * Every way a parked slice comes back, for the line printed when it parks:
 * only the triggers that apply to its kind, and the base-branch one only while
 * it has retries left.
 */
function waysOut(id: TicketId, kind: ParkKind, spent: number): string {
  const when = ["when its branch moves"];
  if ((kind === "gates" || kind === "land") && spent < AUTO_RETRIES) {
    when.push(`when ${baseBranch} moves`);
  }
  if (kind === "review") when.push("when the ticket is edited");
  return `retried ${when.join(", ")}, or now with: azelf retry ${id}`;
}

export type Escalation = "resolve" | "retry" | "force" | "park" | "quit";

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
function askAboutBlocked(
  t: Ticket,
  reason: string,
  ways: string,
  conflicted?: string[],
): Escalation {
  console.log(`
  ✗ ${ref(t.id)} did not land — ${reason}`);
  console.log(`     worktree: ${worktreeFor(t.id)}`);
  // Only a rebase conflict passes a file list, and only a rebase conflict is
  // something an agent can be asked to resolve — so this one value answers both
  // "what conflicted" and "is [a] on the menu".
  if (conflicted?.length) {
    console.log(`     conflict: ${conflicted.join("  ")}`);
  }
  if (assumeYes || !process.stdin.isTTY) {
    console.log(`     parked (non-interactive) — ${ways}`);
    // Only where the flag would have done something: a conflict, a resolver,
    // and no attempt made yet (a failed attempt passes no file list).
    if (conflicted?.length && agent.resolve && autoResolve && !resolveUnasked) {
      console.log("     --auto-resolve lets the agent resolve it.");
    }
    return "park";
  }
  const canResolve = Boolean(
    conflicted?.length && agent.resolve && autoResolve,
  );
  console.log(
    `     ${
      canResolve ? "[a] let an agent resolve it   " : ""
    }[r] retry now   [f] land anyway   [p] park it   [q] stop the run`,
  );
  const answer = (
    prompt(`     what now? [${canResolve ? "a/" : ""}r/f/p/q]`) ?? ""
  )
    .trim()
    .toLowerCase();
  if (canResolve && answer.startsWith("a")) return "resolve";
  if (answer.startsWith("r")) return "retry";
  if (answer.startsWith("f")) return "force";
  if (answer.startsWith("q")) return "quit";
  console.log(`     parked — ${ways}`);
  return "park";
}

/** Set by the escalation prompt; the round loop checks it and stops cleanly. */
let stopRequested = false;

/** Resolver passes one land attempt gets when the base moves under it. */
const RESOLVE_PASSES = 2;

function tryLand(t: Ticket, opts: { force?: boolean } = {}): boolean {
  // A loop, because a resolution is made against the base as it was when the
  // resolver started, and a land elsewhere can move it meanwhile. After a
  // resolution the rebase is asked again: one `is-ancestor` call when nothing
  // moved, a clean rebase over the new commits most other times, and a second
  // resolver pass when those conflict too. Then it parks — each pass is up to
  // twenty minutes a stop, and a base that outruns the resolver twice will a
  // third time.
  for (let passes = 0; ; passes += 1) {
    const rebase = rebaseOntoBase(t);
    if (rebase.ok) break;
    // Under --auto there is nobody at the prompt to press [a], so the decision
    // is made here instead of being offered. The argument: --auto already lets
    // an unwatched agent write code that reaches the base branch gated only by
    // the gates and the spec review, and a resolution passes through the SAME
    // gates and the same review of the rebased diff. It is strictly less
    // exposure than the slice it is fixing. --no-auto-resolve opts out, and an
    // interactive run is asked rather than told. --auto-resolve asks for the
    // same without --auto, where `-y` or a missing TTY parks before any offer.
    const decide = resolveUnasked;
    if (decide && passes >= RESOLVE_PASSES) {
      return park(
        t,
        "rebase",
        `${baseBranch} moved twice while the agent was resolving, and the newest commits conflict too`,
      );
    }
    if (!decide || !resolveConflict(t, rebase.conflicted)) {
      return park(
        t,
        "rebase",
        decide
          ? "the rebase failed and the agent could not resolve it"
          : "the rebase onto the base branch failed",
        // No second [a] after an attempt that already failed: one attempt per
        // branch head, which is the rule `Parked` already encodes for reviews.
        decide ? undefined : rebase.conflicted,
      );
    }
  }
  if (!gatesPass(t.id)) {
    return park(t, "gates", "the gates are red");
  }
  // After the gates, not before: no point paying for a review of something
  // that doesn't compile, and the reviewer should see the rebased diff that
  // is actually about to land.
  if (!opts.force && !reviewSlice(t)) {
    return park(t, "review", "the spec review says BLOCK");
  }
  console.log(`  landing ${ref(t.id)} …`);
  // Read the file set BEFORE landing, because afterwards there is nothing to
  // read it from: `slice-land.sh` deletes the branch, and even before that the
  // fast-forward makes `base...branch` empty by definition. Taken here rather
  // than at the top of the function so it is the REBASED diff — what actually
  // reaches the base branch — and so a slice that never got past the gates
  // contributes nothing.
  const landing = changedFiles(t.id);
  // The slice is rebased, so this is where its commits start.
  const landedFrom = baseHead();
  // `--end-session` under --auto only: the session in that tab was launched
  // with --self-land, nobody is reading it, and ending its agent after the
  // removal is what lets the tab close. A manual land never ends a session.
  const { ok } = run(
    ["./scripts/slice-land.sh", t.id, ...(autoLand ? ["--end-session"] : [])],
    {
      inherit: true,
      allowFail: true,
    },
  );
  if (!ok) {
    return park(
      t,
      "land",
      "slice-land.sh refused — the branch is not fast-forwardable, or a hook rejected it",
    );
  }
  landedFiles.set(t.id, landing);
  closePending.set(t.id, { said: false });
  const landedAt = baseHead();
  if (landedAt) landedHeads.set(t.id, landedAt);
  if (landedFrom && landedAt) {
    landedRanges.set(t.id, { from: landedFrom, to: landedAt });
  }
  // Every slice that has a branch right now was open when this landed, and
  // stays so however often it is rebased or retried afterwards.
  for (const o of tickets) {
    if (!o.open || o.id === t.id || !branchHead(o.id)) continue;
    const under = landedWhileOpen.get(o.id);
    if (under) under.push(t.id);
    else landedWhileOpen.set(o.id, [t.id]);
  }
  noteLanded(t, landing);
  const flaky = flakyGates.get(t.id);
  if (flaky) landedOnRetry.set(t.id, flaky);
  parked.delete(t.id);
  retriesSpent.delete(t.id);
  t.open = false;
  return true;
}

/**
 * Done and waiting for a land: the round's landing filter and the round
 * line's "to land" count, in one place so the two cannot drift.
 *
 * The parked test is the caller's. The landing filter passes `isParked`,
 * which consumes a retry that is due; the round line only counts, and passes
 * a plain lookup.
 */
function awaitingLand(
  t: Ticket,
  isParkedNow: (id: TicketId) => boolean,
): boolean {
  return (
    t.open &&
    hasWorktree(t.id) &&
    // Before the parked test, which would consume a retry that is due: a base
    // that moved during someone's rebase is exactly when a land destroys
    // it. The retry waits for the rebase to end instead.
    !inProgress.has(t.id) &&
    // Parked slices are skipped until what they failed on changes. Without
    // this the same failing land is re-attempted every round for the life
    // of the run.
    !isParkedNow(t.id) &&
    (isReadyToLand(t.id) || (autoLand && autoFinished(t.id)))
  );
}

/**
 * Record the failure, ask what to do, and act on the answer.
 *
 * Split out of `tryLand` so that every failure path goes through the same
 * question. Before this, three of the four returned false with a different
 * message and identical behaviour — retry next round, indefinitely.
 */
function park(
  t: Ticket,
  kind: ParkKind,
  reason: string,
  conflicted?: string[],
): boolean {
  // Read before the question, which can take any amount of time to answer.
  const spent = retriesSpent.get(t.id) ?? 0;
  const record: Parked = {
    reason,
    kind,
    head: branchHead(t.id) ?? "",
    base: mergeBase(t.id) ?? "",
    // Only a review park can be un-parked by the ticket, so only it pays the
    // tracker call.
    body: kind === "review" ? bodyHash(t.id) ?? undefined : undefined,
    autoRetries: spent,
  };
  switch (askAboutBlocked(t, reason, waysOut(t.id, kind, spent), conflicted)) {
    case "resolve":
      // A successful resolution leaves the branch rebased, so the tryLand it
      // re-enters finds the base branch already an ancestor and goes straight
      // to the gates. A failed one falls through to the same question without
      // the [a] — the resolver has had its attempt at this branch head.
      if (resolveConflict(t, conflicted ?? [])) return tryLand(t);
      return park(t, "rebase", "the agent could not resolve the conflict");
    case "retry":
      return tryLand(t);
    case "force":
      console.log(
        `  landing ${ref(t.id)} without the review, at your request …`,
      );
      return tryLand(t, { force: true });
    case "quit":
      stopRequested = true;
      break;
  }
  // The count moves onto the record here, and only here: an answer that
  // tries again goes back through `tryLand`, whose next park reads it.
  retriesSpent.delete(t.id);
  parked.set(t.id, record);
  return false;
}

// ─── overlap ──────────────────────────────────────────────────────────────

/**
 * Changed files per slice, cached against the branch head they were read at.
 *
 * The poll loop asks every round, and a whole-branch `git diff` is not free at
 * four slices a round for an hour. A slice's answer can only change when its
 * branch moves, and `branchHead` is one `rev-parse` — so the diff fires on a
 * commit and never on a heartbeat.
 */
const changedCache = new Map<TicketId, { head: string; files: string[] }>();

/**
 * What this slice has changed relative to where it forked.
 *
 * Three dots, not two: `A...B` diffs from the MERGE BASE, so a base branch
 * that has moved on — and every land moves it — does not read as this slice
 * having reverted whatever somebody else landed.
 *
 * It also means a landed slice reports nothing here, which is why `tryLand`
 * snapshots the answer into `landedFiles` on its way past. This used to be
 * described as landed work dropping out of the report for free; it is the
 * opposite, and see slice-overlap.ts for the wave that demonstrated it.
 *
 * Empty for a branch that does not exist yet, or a diff that fails. No commits
 * is not an error here; it is a slice that has not written anything down yet.
 */
function changedFiles(id: TicketId): string[] {
  const head = branchHead(id);
  if (!head) return [];
  const hit = changedCache.get(id);
  if (hit?.head === head) return hit.files;
  const { ok, out } = run(
    ["git", "diff", "--name-only", `${baseBranch}...${branchFor(id)}`],
    { allowFail: true },
  );
  const files = ok
    ? out
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean)
    : [];
  changedCache.set(id, { head, files });
  return files;
}

/**
 * What each landed slice put on the base branch, kept for the rest of the run.
 *
 * A land is the thing that MOVES the base branch, which is what forces every
 * still-open slice to rebase over the landed files — so this is the moment the
 * overlap matters most, and the moment `changedFiles` can no longer see it.
 * Written by `tryLand`; never cleared, because the base branch does not
 * un-move.
 */
const landedFiles = new Map<TicketId, string[]>();

/**
 * The base branch's head right after each slice landed. An open slice whose
 * branch contains that commit was cut, or rebased, on top of the landed work
 * and has nothing left to rebase over: see `containsLanded`.
 */
const landedHeads = new Map<TicketId, string>();

/** The base branch before and after each land: that slice's commits. */
const landedRanges = new Map<TicketId, { from: string; to: string }>();

/**
 * Landed tickets the tracker has not yet been read as closed, and whether a
 * retry of the close has failed and said so. Kept from the land on.
 */
const closePending = new Map<TicketId, { said: boolean }>();

/**
 * The close after a land is `slice-land.sh`'s, and a failed one is only a
 * warning there: the code is pushed. On the same flaky network that ends a
 * read, it leaves a ticket open whose dependents' preps refuse while it is.
 * So once a round each landed ticket not yet seen closed is read, and if it
 * is still open the dispatcher closes it itself, with the comment the land
 * saved (see slice-land.sh) and a line saying whose close this is. A failed
 * read or close is tried again next round; seen closed, it is not read again.
 */
function retryCloses(): void {
  for (const [id, state] of closePending) {
    let open: boolean;
    try {
      open = tracker.get(id).state === "open";
    } catch {
      continue;
    }
    if (!open) {
      closePending.delete(id);
      continue;
    }
    const saved = join(
      run(["git", "rev-parse", "--path-format=absolute", "--git-common-dir"])
        .out,
      `azelf-close-${id}.txt`,
    );
    const head = landedHeads.get(id)?.slice(0, 7);
    let landed = `Landed on ${baseBranch}${head ? ` as ${head}` : ""}.`;
    try {
      landed = readFileSync(saved, "utf8").trim();
    } catch {}
    try {
      tracker.close(
        id,
        `${landed}\n\nClosed by the dispatcher on a later round: the close right after the land failed.`,
      );
    } catch (e) {
      if (!state.said) {
        console.log(
          `\n[round ${round}] couldn't close ${ref(id)} on ${
            tracker.name
          } — it landed; trying again every round: ${errorLine(e)}`,
        );
        state.said = true;
      }
      continue;
    }
    console.log(
      `\n[round ${round}] closed ${ref(
        id,
      )} — the close after its land had failed`,
    );
    rmSync(saved, { force: true });
    closePending.delete(id);
  }
}

/**
 * For each slice, the slices that landed while it had a branch, in order.
 * Recorded at the land and not derived from ancestry later, because a slice
 * parked on red gates has already been rebased onto the landed work by the
 * time its land is retried, and is no less a slice whose author did not see
 * it.
 */
const landedWhileOpen = new Map<TicketId, TicketId[]>();

/** `is-ancestor` answers, keyed on both commits: neither side un-happens. */
const containsCache = new Map<string, boolean>();

/**
 * Does this open slice's branch already contain what that slice landed?
 * False when either commit cannot be read, which keeps the warning.
 */
function containsLanded(landed: TicketId, open: TicketId): boolean {
  const at = landedHeads.get(landed);
  const head = branchHead(open);
  if (!at || !head) return false;
  const key = `${at} ${head}`;
  const hit = containsCache.get(key);
  if (hit !== undefined) return hit;
  const { ok } = run(["git", "merge-base", "--is-ancestor", at, head], {
    allowFail: true,
  });
  containsCache.set(key, ok);
  return ok;
}

/** The last report printed, so an unchanged one is not printed again. */
let lastOverlaps = "";

/** Files listed per collision before the rest are counted instead. */
const OVERLAP_FILES_SHOWN = 4;

/** Paths the report leaves out, from slice.config.ts. Matches nothing by default. */
const overlapIgnored = ignores(config.overlapIgnore ?? []);

/**
 * Say which open slices are editing the same files — once per change, not
 * once per round. A poll loop that reprints the same warning every 30s for an
 * hour has taught you to skip it by the third time.
 *
 * Printed BEFORE the land, so on the round where one of a colliding pair
 * lands, you read the collision and then read which half of it went to the
 * base branch, in that order.
 *
 * Warn-only, and deliberately: two slices touching one file is often correct
 * — a barrel file, a lockfile, the same test helper. The dispatcher cannot
 * tell which of those it is looking at, and a gate that guessed would block
 * the common case to catch the rare one. See slice-overlap.ts for the half of
 * the problem a rebase already covers.
 */
function reportOverlaps(all: Ticket[]): void {
  const changed = new Map<TicketId, string[]>();
  const open = new Set<TicketId>();
  for (const t of all) {
    if (t.open) {
      open.add(t.id);
      const files = changedFiles(t.id);
      if (files.length) changed.set(t.id, files);
      continue;
    }
    // Closed here means landed this run, and its files are still ahead of
    // every slice that was open then. `containsLanded` takes it back out for
    // a slice cut after the land. A ticket closed some other way never got a
    // snapshot.
    const landed = landedFiles.get(t.id);
    if (landed?.length) changed.set(t.id, landed);
  }

  const overlaps = findOverlaps(changed, {
    open,
    ignore: overlapIgnored,
    absorbed: containsLanded,
  });
  const key = overlaps
    .map((o) => `${o.tickets.join(",")}:${o.files.join(",")}`)
    .join("|");
  if (key === lastOverlaps) return;
  lastOverlaps = key;
  if (overlaps.length === 0) return;

  const anyLanded = overlaps.some((o) => o.tickets.some((id) => !open.has(id)));
  console.log("\n  ⚠ slices are editing the same files");
  for (const o of overlaps) {
    const shown = o.files.slice(0, OVERLAP_FILES_SHOWN).join("  ");
    const rest = o.files.length - OVERLAP_FILES_SHOWN;
    const more = rest > 0 ? `  +${rest} more` : "";
    const ids = o.tickets
      .map((id) => (open.has(id) ? ref(id) : `${ref(id)}✓`))
      .join(" ");
    console.log(`     ${ids}  ${shown}${more}`);
  }
  console.log(
    "     A land rebases, so edits that CLASH are already caught. These are",
  );
  console.log(
    "     the ones that apply cleanly and still disagree — worth a look while",
  );
  console.log("     both are open. Uncommitted work is not visible here.");
  if (anyLanded) {
    console.log(
      "     ✓ = already landed, so the open one has to rebase over it.",
    );
  }
}

// ─── main ─────────────────────────────────────────────────────────────────

// A ticket id is whatever the tracker says one is — `^[0-9]+$` on GitHub, so
// `--max 2` and `--interval 30` would read as tickets #2 and #30 if their
// values were not skipped here.
const explicit: TicketId[] = argv.filter(
  (a, i) => isTicketId(a) && !VALUE_FLAGS.has(argv[i - 1] ?? ""),
);
const planOnly = flag("--plan");
const once = flag("--once");
const assumeYes = flag("-y") || flag("--yes");
const autoLand = flag("--auto");
// The `[a]` option, and whether --auto takes it without asking. On by default
// wherever the agent has a resolver at all, because the failure it addresses —
// a rebase conflict between two slices of one wave — is the normal course of a
// wave finishing, and the four existing options do not resolve anything.
//
// The argument against, stated here rather than discovered later: a bad
// resolution is harder to spot in review than bad new code, because the diff
// reads as somebody else's work. If that proves true in practice the honest
// response is to make --auto offer rather than act — not to add a confidence
// heuristic on top of it.
const autoResolve = !flag("--no-auto-resolve");
if (flag("--auto-resolve") && !autoResolve) {
  console.error(
    "--auto-resolve and --no-auto-resolve contradict each other — pass one.",
  );
  process.exit(64);
}
// Whether a failed rebase goes to the agent without anyone being asked.
const resolveUnasked =
  Boolean(agent.resolve) && autoResolve && (autoLand || flag("--auto-resolve"));
const intervalMs = Number(value("--interval") ?? 30) * 1000;
// How long the round line stays quiet while nothing changes. A run that waits
// on one long slice otherwise prints the same line every 30 seconds for
// hours, and whoever reads the log later has to scroll past all of it. It
// still comes back this often, so a quiet run is not mistaken for a hung one.
// 0 prints it every round, as before; the tests use that as their clock.
const heartbeatMs = Number(process.env.SLICE_HEARTBEAT_SECONDS ?? 600) * 1000;

// `--retry <n>`: what `azelf retry` runs. It only writes the marker; the
// dispatcher that parked the slice consumes it next round (see `isParked`).
// Before any plan is loaded, because this answers without the tracker.
if (flag("--retry")) {
  const id = value("--retry") ?? "";
  if (!isTicketId(id)) {
    console.error("--retry needs one ticket id");
    process.exit(64);
  }
  if (!hasWorktree(id)) {
    console.error(
      `  ✗ ${ref(id)}: no worktree at ${worktreeFor(id)} — nothing to retry`,
    );
    process.exit(1);
  }
  writeFileSync(join(worktreeFor(id), RETRY_MARKER), `${Date.now()}\n`);
  console.log(
    `  the running dispatcher retries ${ref(
      id,
    )} next round; if none is running, \`azelf run --auto ${id}\` does`,
  );
  process.exit(0);
}

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
const { tickets, epics, namedEpics, unlabelled, missingEdges } =
  loadTickets(explicit);
// Before the empty check, not after: if every ready ticket turned out to be a
// heading over the others, "nothing to run" is true and useless. The reason has
// to come first or the run looks broken.
printEpics(epics);
if (tickets.length === 0) {
  console.log(
    epics.length
      ? `\nevery ready ticket is an epic — label a child ${config.readyLabel}, or run one by id.`
      : `no open ${config.readyLabel} tickets — nothing to run.`,
  );
  process.exit(0);
}

// Acts on the discrepancies instead of reporting them, and then stops: the
// edges it writes are the input to the plan, so a tree printed after this
// would be the one computed before the change.
if (flag("--sync-edges")) {
  syncEdges(missingEdges, assumeYes);
  process.exit(0);
}

assignWaves(tickets);
const width = printTree(tickets);
const ignoreBodyBlockers = flag("--ignore-body-blockers");
printMissingEdges(missingEdges, tickets, ignoreBodyBlockers);
printNamed(namedEpics, unlabelled, tickets);
noteBaseAgainstOrigin(!planOnly);
if (missingEdges.length > 0 && !ignoreBodyBlockers) {
  refuseOverBodyBlockers(!planOnly);
}
const maxParallel = Number(value("--max") ?? width);

if (planOnly) process.exit(0);

if (flag("--auto-resolve") && !agent.resolve) {
  console.error(
    `\n✗ ${agent.name} declares no resolver — --auto-resolve has nothing to run. Drop the flag, or give the agent a \`resolve\` in slice.config.ts.`,
  );
  process.exit(1);
}

console.log("");
// Every ticket's worktree shares a parent unless `worktreeDir` puts `{n}` in
// a directory name, so the first ticket's reading stands for the rest.
const freeAtStart = freeGbFor((tickets[0] as Ticket).id);
console.log(
  `  concurrency cap: ${maxParallel}${
    freeAtStart === null
      ? ""
      : ` · disk: ${gb(freeAtStart)} free where the worktrees go${
          minFreeDiskGb > 0
            ? `, nothing new prepped below ${minFreeDiskGb} GB (minFreeDiskGb)`
            : ""
        }`
  }`,
);
// Read now and every round after: a bump in the main checkout during a wave
// replaces the scripts every slice runs, but not this process's modules.
const azelfAtStart = installedVersion();
let azelfChangeNoted = false;
console.log(`  azelf: ${azelfAtStart}`);
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
    "  sessions stop when they are finished and do not mark themselves done.",
  );
  console.log(
    `  run ./scripts/slice-done.sh inside a finished slice to release it; this then verifies it, lands it and pushes ${config.baseBranch} to origin.`,
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
      }; plan-level review when the graph empties (findings exit 2).`
    : "  review: OFF — nothing reads the diff before it lands. --review to enable.",
);
if (lockEnabled) {
  console.log(
    `  ${dbLockStatusLine()} — ${config.exclusiveLockPaths.join(
      ", ",
    )}; a slice claims it before touching them, and parks if refused${
      config.exclusiveLockLabel
        ? `. Tickets labelled [${config.exclusiveLockLabel}] start one at a time`
        : ""
    }.`,
  );
}
console.log(
  !agent.resolve
    ? `  conflicts: ${agent.name} declares no resolver — a rebase conflict parks, as before.`
    : !autoResolve
      ? "  conflicts: --no-auto-resolve — a rebase conflict parks without offering [a]."
      : autoLand
        ? "  conflicts: a failed rebase is handed to the agent, then re-verified (rebased, clean, no markers) and gated. --no-auto-resolve to opt out."
        : resolveUnasked
          ? reviewEnabled
            ? "  conflicts: --auto-resolve — a failed rebase is handed to the agent, re-verified and gated; the spec review blocks a slice that was resolved."
            : "  conflicts: --auto-resolve — a failed rebase is handed to the agent, re-verified and gated. Review is OFF: the gates are the only check on a resolution."
          : "  conflicts: a failed rebase offers [a] — the agent resolves it, and the result is re-verified and gated.",
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

// A retry request is for a run's `parked`, and this run's starts empty — so a
// marker left over from before it would only un-park this run's first failure
// for nothing. This run's tickets only: another dispatcher may own the rest.
for (const t of tickets) {
  rmSync(join(worktreeFor(t.id), RETRY_MARKER), { force: true });
  // A `testOnBase` worktree a crashed run left behind.
  removeBaseTest(t.id);
}

/**
 * Said once, the first round the installed azelf differs from the one this
 * run started with. The dispatcher keeps its own code, but the sessions,
 * lands and `slice-done.sh` it runs from then on come from the shims, which
 * resolve to the new install. A warning only: the shims pin one version per
 * wave on purpose, and giving a wave its own copy of azelf is a bigger change
 * than the harm seen so far. Restarting between lands is what ends the mix.
 */
function noteAzelfChange(): void {
  if (azelfChangeNoted) return;
  const now = installedVersion();
  if (now === azelfAtStart || now === "unknown") return;
  azelfChangeNoted = true;
  console.log(
    `\n  azelf changed under this run: ${azelfAtStart} → ${now}. This dispatcher is still running ${azelfAtStart}; the sessions and lands it starts run ${now} from now on. Restart it (the same command) when nothing is landing.`,
  );
}

let round = 0;
// What the plan-level review found, for the run's last line and exit code.
let planReview: PlanReview | null = null;
// The round line last printed, without its round number, and when.
let lastRoundLine = "";
let lastRoundLineAt = 0;
// The exclusiveLockLabel line last printed, so a long wait says it once.
let lastLabelLine = "";
// The DB lock block last printed, without its round number, and when. Empty
// once the lock is seen free, which is also when "DB lock free" is said.
let lastLockBlock = "";
let lastLockBlockAt = 0;
// Set when the run stopped on an error rather than finishing or parking: the
// ending prints the resume command for it too.
let stoppedOnError = false;

/**
 * The run cannot go on, and slices may still be running: say so, name them,
 * and leave through the normal ending, which prints what is left and the
 * command that picks the run up. A restart adopts live sessions as they are.
 * Shared by a round that threw and by a tracker that stopped answering.
 */
function stopOnError(why: string): void {
  console.log(`\n✗ the dispatcher stopped in round ${round}: ${why}`);
  const live = tickets.filter((t) => t.open && occupied(t.id));
  if (live.length) {
    console.log(
      `  still running, with nothing to land them: ${live
        .map((t) => ref(t.id))
        .join(" ")}`,
    );
  }
  stoppedOnError = true;
  process.exitCode = 1;
}

// Around the loop, so a round that throws ends it the way the stops inside it
// do. A plan-time error is left to throw: nothing had started.
try {
  for (;;) {
    round += 1;
    sessionAnswers.clear();
    noteAzelfChange();
    if (round > 1) {
      const { failed, allFailed } = refreshOpenState(tickets);
      const outage = noteUnreadable(failed, allFailed);
      if (outage) {
        stopOnError(outage);
        break;
      }
      retryCloses();
      unparkClosed(tickets);
    }

    const remaining = tickets.filter((t) => t.open);
    if (remaining.length === 0) {
      console.log("\n✓ every ticket closed — plan complete.");
      planReview = reviewPlan(tickets, planBase);
      break;
    }

    reportOverlaps(tickets);
    noteHandWork(tickets);

    // Land before launching, so a slot freed this round is refilled this round.
    // One per round: every land fast-forwards the same master in the same main
    // worktree, so they cannot be done concurrently.
    const finished = tickets.filter((t) => awaitingLand(t, isParked));
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

    // The DB lock, read once per round. A held lock no longer stops the wave:
    // it used to ("DB lock held — not starting anything"), and on consumer-a
    // that turned one holder into a run that started nothing and said so once.
    // The claim protocol makes starting safe — a slice that needs the lock is
    // refused at `db-lock.sh claim`, exits, and is parked here until the lock
    // frees — so the only tickets held back are the ones that already tried.
    // The holder text is printed whole, indented, because it can be more than
    // a name: when worktrees are dirty with no claim it carries the diagnosis.
    // Like the round line, it is printed when it changes or on the heartbeat:
    // one holder used to fill 28 rounds with the same block. "DB lock free"
    // then says when it ended, which silence otherwise would have to.
    const holder = dbLockHolder();
    const lockParked = tickets.filter(
      (t) => t.open && holder !== "" && isWaitingOnLock(t.id),
    );
    if (holder) {
      const lockBlock = `DB lock held by:\n${holder
        .split("\n")
        .map((l) => `    ${l}`)
        .join("\n")}${
        lockParked.length
          ? `\n  waiting for it: ${lockParked
              .map((t) => ref(t.id))
              .join(", ")} — relaunched when it frees`
          : ""
      }`;
      if (
        lockBlock !== lastLockBlock ||
        Date.now() - lastLockBlockAt >= heartbeatMs
      ) {
        console.log(`\n[round ${round}] ${lockBlock}`);
        lastLockBlock = lockBlock;
        lastLockBlockAt = Date.now();
      }
    } else if (lastLockBlock) {
      console.log(`\n[round ${round}] DB lock free`);
      lastLockBlock = "";
    }

    const up = tickets.filter((t) => t.open && occupied(t.id));
    const free = maxParallel - up.length;
    const ready = runnable(tickets, holder !== "");

    // Once when it changes: a label wait lasts as long as a whole slice does.
    const flying = exclusiveInFlight(tickets);
    const labelWaiting = flying
      ? tickets.filter((t) => t.open && t.exclusive && t.id !== flying.id)
      : [];
    const labelLine = labelWaiting.length
      ? `[${config.exclusiveLockLabel}] one at a time: ${ref(
          (flying as Ticket).id,
        )} in flight; waiting on it: ${labelWaiting
          .map((t) => ref(t.id))
          .join(", ")}`
      : "";
    if (labelLine && labelLine !== lastLabelLine) {
      console.log(`\n[round ${round}] ${labelLine}`);
    }
    lastLabelLine = labelLine;

    // Below minFreeDiskGb, a slice that needs a NEW worktree waits. A relaunch
    // reuses its worktree, costs next to nothing on disk, and leads to a land,
    // which is what frees space, so it is never held. The first new one is
    // checked before the round's line, so a held round does not announce
    // starts it will not make.
    const wanted = free > 0 ? ready.slice(0, free) : [];
    const isNew = (t: Ticket) => !hasWorktree(t.id);
    const firstNew = wanted.find(isNew);
    let room = firstNew === undefined || roomToPrep(firstNew.id);
    const heldOnDisk = room ? [] : wanted.filter(isNew);
    const starting = wanted.filter((t) => !heldOnDisk.includes(t));
    const prepped: TicketId[] = [];

    if (starting.length > 0) {
      console.log(
        `\n[round ${round}] starting ${starting
          .map((t) => `${ref(t.id)}`)
          .join(", ")}`,
      );
      for (const t of starting) {
        // Serially, on purpose: concurrent `git worktree add` against one repo
        // contends on ref locks, and parallel `bun install`s are a pointless
        // spike. A failure here is reported and skipped, never fatal — the
        // other slices in this wave should still start.
        //
        // The disk is read again before every new worktree: the one before it
        // took its share.
        const fresh = isNew(t);
        if (fresh && !(room && roomToPrep(t.id))) {
          room = false;
          heldOnDisk.push(t);
          continue;
        }
        console.log(`  prepping ${ref(t.id)} …`);
        const { ok } = run(
          [
            "./scripts/slice-session.sh",
            t.id,
            ...flagsFor(t.id),
            "--prep-only",
            "--dispatched",
          ],
          { inherit: true, allowFail: true },
        );
        if (ok) {
          prepped.push(t.id);
          continue;
        }
        console.log(`  ! ${ref(t.id)} failed to prep — skipping this round`);
        if (fresh) removeHalfPrepped(t.id);
        // Running out of space is the usual way a prep fails partway, and says
        // so only in `bun install`'s output, which went straight to the
        // terminal. The disk is read instead: below the floor, the rest of this
        // round's new worktrees wait, and so does every round after it until a
        // land frees space. That is what stops the retries.
        if (!roomToPrep(t.id)) room = false;
      }
      if (prepped.length) {
        for (const n of prepped) launchedAt.set(n, Date.now());
        openSessions(prepped);
      }
    }

    if (once) {
      console.log("\n--once: stopping here.");
      break;
    }

    // A session that has been SEEN is one that came up. Forgetting the launch
    // time here is what keeps a slice that came up, worked, and exited without
    // declaring done — a refused DB-lock claim is the usual reason — from being
    // reported below as one that "never came up". `occupied` does not need the
    // entry once the live marker exists, and the marker outlives the window.
    for (const t of tickets) if (hasSession(t.id)) launchedAt.delete(t.id);

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

    // Only when its counts change, or once a heartbeat. Counted from the
    // tickets as they are now, after this round's land and launches, so a
    // ticket that just landed is not "open" and a slice that is done and
    // waiting its turn is not "blocked". `to land`, `queued` and `waiting on
    // a human` print only when they are not zero: a line with none of them
    // reads word for word as it always did, so a watcher that matches it keeps
    // working. A ticket waiting on a person is counted there and not as
    // blocked, even when its blocker is open: what it waits for is the person.
    const openNow = tickets.filter((t) => t.open);
    const stillOpen = new Set(openNow.map((t) => t.id));
    const waiting = waitingOnHuman(tickets);
    const onHuman = openNow.filter(
      (t) => !occupied(t.id) && !parked.has(t.id) && waiting.has(t.id),
    );
    const running = openNow.filter((t) => occupied(t.id));
    const toLand = openNow.filter(
      (t) => !occupied(t.id) && awaitingLand(t, (id) => parked.has(id)),
    );
    const blocked = openNow.filter(
      (t) =>
        !occupied(t.id) &&
        !parked.has(t.id) &&
        !waiting.has(t.id) &&
        (t.foreignBlockers.length > 0 ||
          t.blockedBy.some((b) => stillOpen.has(b))),
    );
    const queued =
      openNow.length -
      running.length -
      toLand.length -
      blocked.length -
      onHuman.length -
      openNow.filter((t) => parked.has(t.id) && !occupied(t.id)).length;
    const roundLine = `${running.length} running · ${
      toLand.length ? `${toLand.length} to land · ` : ""
    }${queued > 0 ? `${queued} queued · ` : ""}${blocked.length} blocked · ${
      onHuman.length ? `${onHuman.length} waiting on a human · ` : ""
    }${openNow.length} open${
      parked.size ? ` · ${parked.size} parked` : ""
    } — land one to advance`;
    if (
      roundLine !== lastRoundLine ||
      Date.now() - lastRoundLineAt >= heartbeatMs
    ) {
      console.log(`[round ${round}] ${roundLine}`);
      lastRoundLine = roundLine;
      lastRoundLineAt = Date.now();
    }

    /**
     * Nothing running, nothing startable, and everything left is parked: the run
     * cannot advance on its own, and every further round is a sleep that prints
     * the same line. Stop and say what is holding it, rather than looking busy.
     *
     * This is only reachable because parking exists. The old code could not
     * stall here — it retried the failing land forever instead, which looked
     * like progress and cost a review call every round.
     *
     * Not while a parked slice is already due a retry. Its triggers are outside
     * events, except one: this round's own land moved the base branch, and a
     * `gates` park waiting on exactly that must get its next round.
     *
     * Nor while someone has a rebase or merge in progress in a parked slice's
     * worktree: finishing it moves the branch, which retries the land, so this
     * run still has something coming.
     */
    if (
      up.length === 0 &&
      ready.length === 0 &&
      remaining.length > 0 &&
      remaining.every((t) => {
        const p = parked.get(t.id);
        return (
          p !== undefined && !inProgress.has(t.id) && retryDue(t.id, p) === null
        );
      })
    ) {
      console.log("\n  nothing can advance — every open slice is parked.");
      break;
    }

    /**
     * The same stop, when what holds the rest is a person: nothing running or
     * startable, and every ticket left either waits on a `humanLabel` ticket
     * or is parked with nothing due. It does not wait for the person, who may
     * be days: it names the tickets to close and the command that picks the
     * run up after.
     */
    if (
      up.length === 0 &&
      ready.length === 0 &&
      onHuman.length > 0 &&
      remaining.every((t) => {
        if (waiting.has(t.id)) return true;
        const p = parked.get(t.id);
        return (
          p !== undefined && !inProgress.has(t.id) && retryDue(t.id, p) === null
        );
      })
    ) {
      const gates = new Map<
        TicketId,
        { outside: boolean; blocks: TicketId[] }
      >();
      for (const t of openNow) {
        if (t.human) gates.set(t.id, { outside: false, blocks: [] });
      }
      for (const t of openNow) {
        for (const b of t.blockedBy) gates.get(b)?.blocks.push(t.id);
        for (const b of t.foreignHuman) {
          const g = gates.get(b) ?? { outside: true, blocks: [] };
          g.blocks.push(t.id);
          gates.set(b, g);
        }
      }
      console.log("\n  nothing can advance — what is left waits on a human:");
      for (const [id, g] of gates) {
        console.log(
          `    ${ref(id)}  ${config.humanLabel}${
            g.outside ? ", outside this set" : ""
          }${
            g.blocks.length ? ` — blocks ${g.blocks.map(ref).join(", ")}` : ""
          }`,
        );
      }
      console.log(
        `  Close ${
          gates.size === 1 ? "it" : "them"
        } when done, then pick the run up again:\n\n    ${resumeCommand()}`,
      );
      process.exitCode = 1;
      break;
    }

    /**
     * The same stop, when the disk is what holds the rest: nothing running,
     * nothing left to land, and a slice that could start is held below
     * minFreeDiskGb. Only a land frees space inside a run, and none is coming.
     * Exits 1 even with nothing parked, because the work is not done.
     */
    if (
      heldOnDisk.length > 0 &&
      up.length === 0 &&
      prepped.length === 0 &&
      remaining.every((t) => {
        if (inProgress.has(t.id)) return false;
        const p = parked.get(t.id);
        if (p) return retryDue(t.id, p) === null;
        return !(
          hasWorktree(t.id) &&
          (isReadyToLand(t.id) || (autoLand && autoFinished(t.id)))
        );
      })
    ) {
      const left = freeGbFor((heldOnDisk[0] as Ticket).id);
      console.log(
        `\n  nothing can advance — nothing is running or left to land, and ${heldOnDisk
          .map((t) => ref(t.id))
          .join(", ")} cannot start: ${
          left === null
            ? "the disk is"
            : `${gb(left)} free where the worktrees go,`
        } below minFreeDiskGb (${minFreeDiskGb}). Nothing in this run will free space; free some, or lower minFreeDiskGb in slice.config.ts, and run again:\n\n    ${resumeCommand()}`,
      );
      process.exitCode = 1;
      break;
    }

    await new Promise((r) => setTimeout(r, intervalMs));
  }
} catch (e) {
  stopOnError(errorLine(e));
  // Not a network blip, which never reaches here: a bug, and its stack is
  // what finds it.
  console.error(e);
}

// A landed ticket the tracker has not been read as closed. Read once more
// first, so a run that ends the round of its last land does not list a close
// that went through, and a close that failed gets one more try.
retryCloses();
if (closePending.size > 0) {
  console.log(
    `\n── landed, not seen closed on ${tracker.name} (${closePending.size}) ─────────`,
  );
  for (const id of closePending.keys()) {
    console.log(
      `  ${ref(
        id,
      )}  close it by hand if it is still open: its dependents' sessions refuse to start while it is`,
    );
  }
  process.exitCode ||= 1;
}

// Landed, but only because a gate was re-run. Before the parked list, which
// is the part that needs doing; this is the part that needs knowing.
if (landedOnRetry.size > 0) {
  console.log(
    `\n── landed on a retried gate (${landedOnRetry.size}) ─────────────────`,
  );
  for (const [id, flaky] of landedOnRetry) {
    for (const f of flaky) {
      console.log(`  ${ref(id)}  \`${f.gate}\` passed on retry ${f.retry}`);
    }
  }
  console.log(
    "\n  Each failed first and passed on a re-run. Find the flaky test before it",
  );
  console.log("  hides a real failure the same way.");
}

/**
 * The command that picks this run up where it stopped: its own flags, minus
 * `--once`, and the tickets it left open, which are the parked ones when
 * parking is what stopped it. Ids rather than none: a run of every ready
 * ticket would plan again from the tracker, and that can be a different set.
 */
function resumeCommand(): string {
  const flags = argv.filter(
    (a, i) =>
      a !== "--once" && !(isTicketId(a) && !VALUE_FLAGS.has(argv[i - 1] ?? "")),
  );
  const open = tickets.filter((t) => t.open).map((t) => t.id);
  return ["bunx azelf run", ...flags, ...open].join(" ");
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
  // Not the park line's "retried when …": that is a running dispatcher's
  // promise, and this one is exiting.
  console.log(
    "\n  Nothing retries them now that this run has stopped. The next run starts",
  );
  console.log(
    "  with nothing parked and tries each again: fix what the reason names first",
  );
  console.log("  (commit in the worktree, or correct the ticket).");
  console.log(
    `  To land one without the review: ./scripts/slice-land.sh <ticket>${
      parked.size > 1 ? "  (one at a time)" : ""
    }`,
  );
  console.log(`  To pick the run up again:\n\n    ${resumeCommand()}`);
  process.exitCode = 1;
} else if (stoppedOnError) {
  console.log(`\n  To pick the run up again:\n\n    ${resumeCommand()}`);
}

// The very last line, because it is the one an unwatched run is read by. Exit
// 2 only over a run that would otherwise say 0: 1 keeps meaning "work is
// left", and 2 means everything landed and the last review has something to
// read.
if (planReview) {
  const { findings, path } = planReview;
  if (findings === 0) {
    console.log("\n  plan review: no cross-cutting findings.");
  } else {
    console.log(
      findings === null
        ? `\n  plan review: no result — it did not return, or gave no count → ${path}`
        : `\n  plan review: ${findings} finding${
            findings === 1 ? "" : "s"
          }, all of it already landed → ${path}`,
    );
    if (!process.exitCode) process.exitCode = 2;
  }
}
