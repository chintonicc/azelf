/**
 * The issue tracker, as a CONTRACT rather than a set of `gh` calls.
 *
 *   tracker.listReady(label)   # ids of the open tickets carrying `label`
 *   tracker.get(id)            # title, state, labels, url
 *   tracker.blockers(id)       # every ticket blocking `id`, each with its state
 *   tracker.body(id)           # the ticket text — the spec a slice is built to
 *   tracker.close(id, comment) # the step that unblocks the next wave (see below)
 *
 * `slice.config.ts` names one under `tracker`; `github()` below is the adapter
 * that ships. Nothing here reads the config, on purpose — the config imports
 * this file's constructor, and a module that imported the config back would
 * be a cycle. Same shape as scripts/slice-gates.ts.
 *
 * WHY A CONTRACT AND NOT A CONFIG STRING
 * --------------------------------------
 * Three things about the graph are load-bearing, and none of them fits in a
 * string:
 *
 *  1. EDGES ARE READ IN ONE DIRECTION. `blockers(id)` is the only edge query
 *     there is; there is no `blocking(id)`. GitHub's dependency endpoint reads
 *     only `blocked_by` — the `blocks` side 404s — so the dispatcher derives
 *     every reverse edge by inverting the forward ones over the set it holds
 *     (assignWaves / printTree in slice-run.ts). An adapter is never asked for
 *     the reverse direction, and must not need it. Linear and Jira model the
 *     relation as a symmetric link with a type; an adapter for them answers
 *     `blockers` from that link and ignores the rest.
 *
 *  2. CLOSING IS LOAD-BEARING, NOT COSMETIC. A blocker counts as cleared iff
 *     its state is `closed` — that is the whole scheduling rule, and `close`
 *     is what makes it true. On GitHub the dependency is cleared only when the
 *     blocking issue is closed, so `gh issue close` is what lets the next wave
 *     start. THE CONTRACT: `close(id)` must leave the ticket in whatever state
 *     `blockers()` reports as `closed`. A tracker whose "done" is not its
 *     "closed" — a Linear workflow with a Done column that keeps its relations,
 *     say — must map `close` onto the state its `blockers` reads as cleared,
 *     or the loop deadlocks silently: every downstream ticket stays blocked,
 *     and nothing anywhere says why.
 *
 *  3. TWO CONSUMERS READ THE GRAPH DIFFERENTLY. slice-run.ts needs the full
 *     blocker list WITH states, to split a ticket's blockers into "in this
 *     run's set" and "outside it" (the second kind is reported, never
 *     scheduled around). slice-session.sh needs only the count of open ones,
 *     as a refuse-to-launch check. So `blockers` returns everything with
 *     states and `openBlockers` below is the one filter both halves use; the
 *     shell reaches it through the bridge in scripts/slice-config.ts rather
 *     than re-implementing the graph in bash.
 *
 * TICKET IDS ARE STRINGS, AND THE TRACKER SAYS WHAT THEY LOOK LIKE
 * ---------------------------------------------------------------
 * GitHub's are digits; Linear's are `ENG-123`. An id has to survive branch
 * naming (`ticket/{n}`), argv parsing in the dispatcher and the shell scripts,
 * the round trip back out of a branch name, and the autostart marker — so
 * every one of those reads `idPattern` from the tracker instead of assuming
 * `[0-9]+`. The pattern is tested by bash's `=~` as well as by JavaScript,
 * which is why it must be written in the subset both understand: see
 * `idPatternProblem` for the rules.
 */

import { spawnSync } from "node:child_process";

export type TicketId = string;

/**
 * Two states, on purpose. A tracker may have twelve; the loop cares about one
 * question — does this ticket still block its dependents — and `closed` is
 * the answer "no". Map everything else to `open`.
 */
export type TicketState = "open" | "closed";

export type TicketInfo = {
  id: TicketId;
  title: string;
  state: TicketState;
  labels: string[];
  url: string;
};

export type Blocker = { id: TicketId; state: TicketState };

export type Tracker = {
  /** Shown in the dispatcher's banner and in error messages. */
  name: string;
  /**
   * What a ticket id looks like, as a regex SOURCE valid in both JavaScript
   * and POSIX ERE (bash `=~`), anchored with `^` and `$`. `^[0-9]+$` for
   * GitHub. See `idPatternProblem`.
   */
  idPattern: string;
  /** How a ticket is written for humans; `{n}` is the id. `#{n}` for GitHub. */
  refTemplate: string;
  /** Ids of every OPEN ticket carrying `label`. */
  listReady(label: string): TicketId[];
  /** Throws if the ticket cannot be read — an unreadable ticket is not an open one. */
  get(id: TicketId): TicketInfo;
  /** Every ticket blocking `id`, closed ones included, each with its state. */
  blockers(id: TicketId): Blocker[];
  /** The ticket text; empty string when it has none. */
  body(id: TicketId): string;
  /**
   * The tickets hanging UNDER this one, if the tracker models hierarchy
   * natively; `[]` when it has none. Optional — most trackers do not model it
   * at all, and an adapter that omits this stays valid: the dispatcher falls
   * back to the `## Parent` convention through `parentFromBody`.
   *
   * Children and not parent, for the same reason `blockers` is blocked-by and
   * not blocks (point 1 in the header): this is the direction GitHub can
   * actually answer. `/issues/{n}/sub_issues` lists children; nothing returns a
   * parent, and deriving one would mean scanning every candidate. A tracker
   * that natively knows the parent instead — Jira's epic link, Linear's parent
   * — answers this by querying its children, which both support.
   *
   * A parent is not a blocker and must never be reported as one. A blocker says
   * "do that first"; a parent says "this is not work, it is a heading over
   * work". They schedule differently: a blocker delays a slice by a wave, a
   * parent means there is no slice here at all.
   */
  children?(id: TicketId): TicketId[];
  /** Put the ticket in the state `blockers` reports as `closed`. Throws on failure. */
  close(id: TicketId, comment: string): void;
};

// ─── shared by both consumers ─────────────────────────────────────────────

/** The blockers that still block. The ONE definition of "still", used by both halves. */
export const openBlockers = (blockers: Blocker[]): Blocker[] =>
  blockers.filter((b) => b.state !== "closed");

/**
 * Sort order for ids: numeric where they are numbers, so `#9` sorts before
 * `#12`, and the same numeric-aware collation for `ENG-9` before `ENG-12`.
 * Replaces `a.number - b.number`, which needed the ids to BE numbers.
 */
export const compareIds = (a: TicketId, b: TicketId): number =>
  a.localeCompare(b, "en", { numeric: true });

/** `{n}` → the id. `.split().join()` rather than `replaceAll`, which needs a newer lib target. */
export const refFor = (tpl: string, id: TicketId): string =>
  tpl.split("{n}").join(id);

/**
 * Why an `idPattern` is unusable, or `null` if it is fine.
 *
 * The same string is compiled by JavaScript AND handed to bash's `=~`, which
 * on macOS is the system regcomp — POSIX ERE, with no `\d`, no `\w`, no `\b`
 * and no `(?:…)`. A pattern that uses any of those works in the dispatcher
 * and silently rejects every ticket in the shell, which is exactly the kind of
 * half-widened failure this phase exists to prevent.
 */
export function idPatternProblem(source: string): string | null {
  if (!source.startsWith("^") || !source.endsWith("$")) {
    return "must be anchored with ^ and $ — it is tested against a whole argument";
  }
  if (/\\[dDwWsSbB]/.test(source)) {
    return "must be POSIX ERE as well as JavaScript: no \\d, \\w, \\s or \\b (bash's =~ on macOS has none of them) — spell the class out, e.g. [0-9]";
  }
  if (source.includes("(?")) {
    return "must be POSIX ERE as well as JavaScript: no (?…) groups";
  }
  try {
    new RegExp(source);
  } catch (e) {
    return `does not compile: ${e instanceof Error ? e.message : String(e)}`;
  }
  return null;
}

const escapeRegExp = (s: string): string =>
  s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * The inverse of `ticket/{n}` + id: read the id back out of a branch name, or
 * `null` if the branch is not a slice branch. The id is matched by
 * `idPattern` with its anchors folded into the branch's own, so what comes
 * back is a whole id and not a prefix of one.
 */
export function idFromBranch(
  branchPattern: string,
  idPattern: string,
  branch: string,
): TicketId | null {
  const [pre = "", suf = ""] = branchPattern.split("{n}");
  const inner = idPattern.slice(1, -1);
  const m = branch.match(
    new RegExp(`^${escapeRegExp(pre)}(${inner})${escapeRegExp(suf)}$`),
  );
  return m?.[1] ?? null;
}

/**
 * The lines under a `## <name>` heading, up to the next heading of the same
 * level or deeper. Shared by the two body readers below.
 *
 * Section-scoped on purpose, and that scope is the whole point: a bare `#17`
 * somewhere in a paragraph is a MENTION, not a hierarchy. Ticket bodies
 * cross-reference each other constantly — "reads best after #19", "supersedes
 * #4" — and a parser that read those as structure would exclude tickets that
 * are merely being polite about context. Only what sits under the heading
 * counts.
 */
function section(body: string, name: string): string {
  const lines = body.split("\n");
  const start = lines.findIndex((l) =>
    new RegExp(`^#{1,6}\\s+${name}\\s*$`, "i").test(l.trim()),
  );
  if (start < 0) return "";
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => /^#{1,6}\s/.test(l.trim()));
  return (end < 0 ? rest : rest.slice(0, end)).join("\n");
}

/** Every id matching `idPattern` in `text`, in order, without duplicates. */
function idsIn(text: string, idPattern: string): TicketId[] {
  // The tracker's refTemplate is `#{n}` on GitHub, so the marker is the `#`.
  // Anchors are stripped: this searches within a line rather than matching one.
  const inner = idPattern.slice(1, -1);
  const found = text.match(new RegExp(`#(${inner})\\b`, "g")) ?? [];
  return [...new Set(found.map((s) => s.slice(1)))];
}

/**
 * The ticket this one names as its parent, or `null`.
 *
 * Reads the `## Parent` convention that ticket-writing skills emit. This is a
 * FALLBACK: a tracker that models hierarchy natively should answer through
 * `Tracker.parent`, and the dispatcher prefers that. It exists because the
 * convention is real and the native edge frequently is not — a body can assert
 * a parent that GitHub has no record of, which is exactly the case that made
 * five overlapping slices look like five independent ones.
 */
export function parentFromBody(
  body: string,
  idPattern: string,
): TicketId | null {
  return idsIn(section(body, "parent"), idPattern)[0] ?? null;
}

/**
 * Ticket ids named under a `## Blocked by` heading.
 *
 * `[]` covers both "the section is absent" and "the section says None", which
 * are the same fact for scheduling. Note what this does NOT do: it reports what
 * the body CLAIMS, which may disagree with the tracker's own edges. Reconciling
 * the two is the caller's business, and azelf only ever reports the difference
 * unless asked in so many words to write it.
 */
export function blockersFromBody(body: string, idPattern: string): TicketId[] {
  return idsIn(section(body, "blocked by"), idPattern);
}

/** A ticket that other tickets in the same set hang under. */
export type Epic = { id: TicketId; children: TicketId[] };

/**
 * The tickets in `ids` that other tickets in `ids` hang under.
 *
 * Two sources, and the cheap one is not the trusted one. The `## Parent`
 * convention is read from bodies the dispatcher fetches anyway; a tracker that
 * models hierarchy natively answers `children()` and OVERRIDES the prose,
 * because structured data beats a heading someone typed. The prose path cannot
 * simply be dropped in its favour, though: the case this was written for had
 * four tickets naming `#17` as their parent while GitHub's sub-issue graph was
 * empty, so the native answer alone would have found nothing at all.
 *
 * Only parents INSIDE the set count. A parent outside it is context, not a
 * scheduling fact — it is not competing for a worktree, and excluding on it
 * would drop a runnable ticket because of a heading somewhere else entirely.
 *
 * Pure and injectable rather than reaching for the module's `tracker`, so the
 * inversion can be tested without a network or a config: `slice-run.ts` does
 * its work at import time and cannot host a testable function.
 */
export function findEpics(
  ids: TicketId[],
  from: Pick<Tracker, "idPattern" | "body"> &
    Partial<Pick<Tracker, "children">>,
): Epic[] {
  const inSet = new Set(ids);
  const parentOf = new Map<TicketId, TicketId>();

  for (const id of ids) {
    const named = parentFromBody(from.body(id), from.idPattern);
    if (named && inSet.has(named) && named !== id) parentOf.set(id, named);
  }
  // Applied second so the tracker's own answer wins where it has one.
  if (from.children) {
    for (const id of ids) {
      for (const kid of from.children(id)) {
        if (inSet.has(kid) && kid !== id) parentOf.set(kid, id);
      }
    }
  }

  const byParent = new Map<TicketId, TicketId[]>();
  for (const [child, parent] of parentOf) {
    byParent.set(parent, [...(byParent.get(parent) ?? []), child]);
  }
  return [...byParent.entries()]
    .map(([id, children]) => ({ id, children: children.sort(compareIds) }))
    .sort((a, b) => compareIds(a.id, b.id));
}

// ─── the GitHub adapter ───────────────────────────────────────────────────

/**
 * Runs `gh` with these arguments. stdout and stderr are kept APART, unlike the
 * gates' exec: the adapter parses stdout as JSON, and a `gh` update notice on
 * stderr must not be able to break that.
 */
export type GhRunner = (args: string[]) => {
  ok: boolean;
  stdout: string;
  stderr: string;
};

export type GithubOptions = {
  /** Scripted in tests; the real binary otherwise. */
  gh?: GhRunner;
  /**
   * Where `gh` runs — it resolves `{owner}/{repo}` from the git remote there.
   * Any checkout of the repo will do, the slice worktrees included; defaults
   * to the current directory, which every caller has already set.
   */
  cwd?: string;
};

function realGh(cwd?: string): GhRunner {
  return (args) => {
    const proc = spawnSync("gh", args, {
      cwd,
      encoding: "utf8",
      // A 100-ticket listing is small, but the default 1MB truncates silently
      // and the failure would then look like malformed JSON, not a limit.
      maxBuffer: 16 * 1024 * 1024,
    });
    return {
      ok: proc.status === 0,
      stdout: proc.stdout ?? "",
      // A missing binary surfaces as proc.error with nothing on stderr; say so.
      stderr: `${proc.stderr ?? ""}${proc.error ? proc.error.message : ""}`,
    };
  };
}

/** GitHub says OPEN/CLOSED from `gh issue view` and open/closed from the REST API. */
const stateOf = (raw: string): TicketState =>
  raw.toLowerCase() === "closed" ? "closed" : "open";

/**
 * The adapter for GitHub Issues with native issue dependencies, through `gh`.
 *
 * Ids are the issue numbers, as strings. Every failure throws with `gh`'s own
 * output attached: a ticket that cannot be read is not one the loop can
 * schedule, and "0 blockers" from a failed call would be the wrong reading.
 */
export function github(opts: GithubOptions = {}): Tracker {
  const gh = opts.gh ?? realGh(opts.cwd);

  const call = <T>(args: string[]): T => {
    const r = gh(args);
    if (!r.ok) {
      throw new Error(
        `gh ${args.join(" ")} failed:\n${(r.stderr || r.stdout).trim()}`,
      );
    }
    try {
      return JSON.parse(r.stdout) as T;
    } catch {
      throw new Error(
        `gh ${args.join(
          " ",
        )} returned something that is not JSON:\n${r.stdout.trim()}`,
      );
    }
  };

  return {
    name: "GitHub",
    idPattern: "^[0-9]+$",
    refTemplate: "#{n}",

    listReady(label) {
      return call<{ number: number }[]>([
        "issue",
        "list",
        "--state",
        "open",
        "--label",
        label,
        "--limit",
        "100",
        "--json",
        "number",
      ]).map((i) => String(i.number));
    },

    get(id) {
      const i = call<{
        number: number;
        title: string;
        state: string;
        url: string;
        labels: { name: string }[];
      }>(["issue", "view", id, "--json", "number,title,state,url,labels"]);
      return {
        id: String(i.number),
        title: i.title,
        state: stateOf(i.state),
        labels: i.labels.map((l) => l.name),
        url: i.url,
      };
    },

    blockers(id) {
      // The dependencies endpoint reads only in the blocked_by direction —
      // `blocks` 404s. See point 1 in the header for what that means.
      return call<{ number: number; state: string }[]>([
        "api",
        `repos/{owner}/{repo}/issues/${id}/dependencies/blocked_by`,
        "--jq",
        "[.[] | {number, state}]",
      ]).map((b) => ({ id: String(b.number), state: stateOf(b.state) }));
    },

    body(id) {
      return (
        call<{ body: string | null }>(["issue", "view", id, "--json", "body"])
          .body ?? ""
      );
    },

    children(id) {
      // `sub_issues_summary` rides along on the issue object, so the count is
      // free and the listing call only happens for issues that HAVE children.
      // On a repo that uses no sub-issues — most of them — this costs one API
      // call per ticket and never the second.
      const summary = call<{ sub_issues_summary?: { total?: number } }>([
        "api",
        `repos/{owner}/{repo}/issues/${id}`,
        "--jq",
        "{sub_issues_summary}",
      ]).sub_issues_summary;
      if (!summary?.total) return [];
      return call<{ number: number }[]>([
        "api",
        `repos/{owner}/{repo}/issues/${id}/sub_issues`,
        "--jq",
        "[.[] | {number}]",
      ]).map((c) => String(c.number));
    },

    close(id, comment) {
      // `gh issue close` prints a confirmation, not JSON — so not `call`.
      const r = gh(["issue", "close", id, "--comment", comment]);
      if (!r.ok) {
        throw new Error(
          `gh issue close ${id} failed:\n${(r.stderr || r.stdout).trim()}`,
        );
      }
    },
  };
}
