/**
 * The issue tracker, as a CONTRACT rather than a set of `gh` calls.
 *
 *   tracker.listReady(label)   # ids of the open tickets carrying `label`
 *   tracker.get(id)            # title, state, labels, url
 *   tracker.blockers(id)       # every ticket blocking `id`, each with its state
 *   tracker.body(id)           # the ticket text — the spec a slice is built to
 *   tracker.close(id, comment) # the step that unblocks the next wave (see below)
 *
 * and three optional ones: `children(id)` and `parentClaims()` for hierarchy,
 * `addBlocker(id, blockerId)` for `--sync-edges`.
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
  /**
   * Every ticket, OPEN OR CLOSED, whose body has a `## Parent` section.
   * Optional; the prose counterpart of `children`, for the hierarchy that
   * exists only as a heading someone typed.
   *
   * It exists because a parent's children leave the ready set as they land.
   * Read from the set alone, a spec whose tickets are all closed looks like an
   * ordinary ticket with nothing under it, and gets a session of its own. One
   * call per plan, not one per ticket. An adapter may return more than asked
   * for: the caller runs `parentFromBody` over every body itself.
   */
  parentClaims?(): { id: TicketId; state: TicketState; body: string }[];
  /**
   * Record that `id` is blocked by `blockerId`. Optional, and NOTHING calls it
   * unless the human asked for it in so many words (`--sync-edges`): every
   * other write azelf makes to a tracker is a close-on-land, which is a fact
   * about work that already happened. This one asserts a relationship, and a
   * wrong assertion here reshapes the plan.
   *
   * Must be idempotent-ish: an edge that already exists is the outcome asked
   * for, so re-recording it succeeds rather than throwing. Throws only when the
   * edge could not be made.
   */
  addBlocker?(id: TicketId, blockerId: TicketId): void;
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
 * The ticket ids a body says it is blocked by.
 *
 * Two places are read, and neither is "every id in the body":
 *
 *  1. Everything under a `## Blocked by` heading — unless the section opens
 *     with "None". Then it is empty, whatever it goes on to mention: "None.
 *     #62 and #63 have landed." names two tickets and no blocker.
 *  2. The rest of any sentence that says "blocked on" or "blocked by", up to
 *     the next `.`, `;` or line end. Ticket writers put the strongest form of
 *     the claim outside the section: "**Blocked on #2 (the egress trigger) and
 *     #3 (the authorizer).** Do not start early." A negated phrase ("not
 *     blocked by #19", "isn't blocked on", "no longer blocked by") is skipped.
 *
 * `section()` explains why a bare `#17` in a paragraph is a mention and not
 * structure. That still holds: "reads best after #19" is not read. This reads
 * one phrase whose only meaning is the claim.
 *
 * `[]` covers both "nothing is said" and "the section says None", which are
 * the same fact for scheduling. Note what this does NOT do: it reports what
 * the body CLAIMS, which may disagree with the tracker's own edges. Reconciling
 * the two is the caller's business, and azelf never writes the difference
 * unless asked in so many words.
 */
export function blockersFromBody(body: string, idPattern: string): TicketId[] {
  const sec = section(body, "blocked by");
  const first =
    sec
      .split("\n")
      .map((l) => l.trim())
      .find((l) => l !== "") ?? "";
  // Leading list and emphasis markers are decoration: "- None", "**None.**".
  const fromSection = /^[-*_>\s]*none\b/i.test(first)
    ? []
    : idsIn(sec, idPattern);

  const fromPhrases: TicketId[] = [];
  for (const m of body.matchAll(/\bblocked\s+(?:on|by)\b([^.;\n]*)/gi)) {
    const before = body.slice(Math.max(0, m.index - 12), m.index);
    if (/(?:\bnot|n't|\bno longer)\s+$/i.test(before)) continue;
    fromPhrases.push(...idsIn(m[1] ?? "", idPattern));
  }
  return [...new Set([...fromSection, ...fromPhrases])];
}

/**
 * The OPEN blockers a ticket's BODY claims that the tracker has no edge for.
 *
 * This is a DISAGREEMENT, not a defect, and the two sides fail differently: a
 * body is written once by whoever sliced the work and is never updated, while
 * the tracker's edges are what the dispatcher actually schedules on. So the
 * body is a claim about intent and the edge is the operative fact, and where
 * they differ the honest move is to say so and let a human decide — which is
 * why this returns a list rather than writing anything.
 *
 * `known` is the tracker's FULL blocker list, closed ones included. A claimed
 * edge whose blocker is already closed is not missing: the tracker recorded it
 * and then cleared it by closing, which is the normal end of an edge's life.
 * Passing only the open blockers here would re-report every edge the plan has
 * already worked through, and `--sync-edges` would then rewrite them.
 *
 * `self` drops a ticket that names itself, which is a typo rather than a cycle
 * — `addBlocker` would be rejected by any tracker, but reporting it as a
 * missing edge invites someone to try.
 *
 * `stateOf` drops a claimed blocker that is closed, edge or no edge: it blocks
 * nothing, and a body is never edited to say so. It answers `undefined` for a
 * ticket the tracker cannot read, and that one STAYS in the list — a typo in a
 * body should be seen, not swallowed. Without `stateOf` nothing is dropped.
 */
export function bodyOnlyBlockers(
  body: string,
  known: Blocker[],
  idPattern: string,
  self?: TicketId,
  stateOf?: (id: TicketId) => TicketState | undefined,
): TicketId[] {
  const have = new Set(known.map((b) => b.id));
  return blockersFromBody(body, idPattern).filter(
    (id) => id !== self && !have.has(id) && stateOf?.(id) !== "closed",
  );
}

/**
 * A ticket that other tickets hang under. `openChildren` is the subset still
 * open: empty means the epic is finished and only its label is left over.
 */
export type Epic = {
  id: TicketId;
  children: TicketId[];
  openChildren: TicketId[];
};

/**
 * The tickets in `ids` that other tickets hang under, wherever those are.
 *
 * Three sources, and the cheap one is not the trusted one. The `## Parent`
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
 * CHILDREN count wherever they are, and in whatever state. They used to count
 * only inside the set, and that had a hole exactly where it mattered: children
 * leave the ready set as they land, so a spec whose tickets were all done
 * stopped being an epic and became a wave-1 ticket — a session opened on the
 * whole spec. `children()` already returns closed children; `parentClaims()`
 * is how the prose ones outside the set are found. A tracker with neither
 * still sees the children in the set, as before.
 *
 * `state` answers for a child whose state nothing here has seen yet (a native
 * child outside the set). Without it, or when it throws, the child counts as
 * open: "this epic still has work under it" is the reading that is cheap to be
 * wrong about.
 *
 * Pure and injectable rather than reaching for the module's `tracker`, so the
 * inversion can be tested without a network or a config: `slice-run.ts` does
 * its work at import time and cannot host a testable function.
 */
export function findEpics(
  ids: TicketId[],
  from: Pick<Tracker, "idPattern" | "body"> &
    Partial<Pick<Tracker, "children" | "parentClaims">> & {
      state?: (id: TicketId) => TicketState;
    },
): Epic[] {
  const inSet = new Set(ids);
  const parentOf = new Map<TicketId, TicketId>();
  const seenState = new Map<TicketId, TicketState>();

  for (const id of ids) {
    const named = parentFromBody(from.body(id), from.idPattern);
    if (named && inSet.has(named) && named !== id) parentOf.set(id, named);
  }
  if (from.parentClaims) {
    for (const claim of from.parentClaims()) {
      seenState.set(claim.id, claim.state);
      const named = parentFromBody(claim.body, from.idPattern);
      if (named && inSet.has(named) && named !== claim.id) {
        parentOf.set(claim.id, named);
      }
    }
  }
  // Applied last so the tracker's own answer wins where it has one.
  if (from.children) {
    for (const id of ids) {
      for (const kid of from.children(id)) {
        if (kid !== id) parentOf.set(kid, id);
      }
    }
  }

  const isOpen = (id: TicketId): boolean => {
    const seen = seenState.get(id);
    if (seen) return seen === "open";
    if (!from.state) return true;
    try {
      return from.state(id) === "open";
    } catch {
      return true;
    }
  };

  const byParent = new Map<TicketId, TicketId[]>();
  for (const [child, parent] of parentOf) {
    byParent.set(parent, [...(byParent.get(parent) ?? []), child]);
  }
  return [...byParent.entries()]
    .map(([id, kids]) => {
      const children = kids.sort(compareIds);
      return { id, children, openChildren: children.filter(isOpen) };
    })
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
 * The ready list's query. `$endCursor` and `pageInfo` are what
 * `gh api --paginate` needs to walk the pages; `{owner}` and `{repo}` are
 * filled in by gh from the remote, as in the REST paths below.
 */
const READY_QUERY = `query($owner: String!, $repo: String!, $label: String!, $endCursor: String) {
  repository(owner: $owner, name: $repo) {
    issues(first: 100, after: $endCursor, states: OPEN, labels: [$label], orderBy: {field: CREATED_AT, direction: DESC}) {
      nodes { number }
      pageInfo { hasNextPage endCursor }
    }
  }
}`;

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
      // Not `gh issue list --label`: gh answers that through the search API,
      // which is indexed with a lag, so an issue filed seconds earlier was
      // missing and --sync-edges never read its body. The REST issues list
      // lags too. Probed on a scratch repo (gh 2.94.0, 2026-10-08) by filing
      // a labelled issue and listing straight away: this connection had it
      // 6 times out of 6 within 1.1s, the REST list had it 0 times out of 6
      // at 2s, and REST and search both took 4–12s to catch up. It also pages
      // (no cap of 100), returns no pull requests, and takes the label as a
      // variable, so a comma in it is just a comma. Newest first, as before,
      // so --max starts the same ticket.
      const args = [
        "api",
        "graphql",
        "--paginate",
        "-F",
        "owner={owner}",
        "-F",
        "repo={repo}",
        "-f",
        `label=${label}`,
        "-f",
        `query=${READY_QUERY}`,
        "--jq",
        ".data.repository.issues.nodes[].number",
      ];
      const r = gh(args);
      if (!r.ok) {
        throw new Error(
          `gh api graphql (open issues labelled ${label}) failed:\n${(
            r.stderr || r.stdout
          ).trim()}`,
        );
      }
      // --paginate with --jq prints one number per line, across all pages.
      const numbers = r.stdout
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean);
      if (!numbers.every((n) => /^[0-9]+$/.test(n))) {
        throw new Error(
          `gh api graphql (open issues labelled ${label}) returned something that is not a list of issue numbers:\n${r.stdout.trim()}`,
        );
      }
      return numbers;
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

    parentClaims() {
      // GitHub's search drops the `##` and matches the word, so this returns
      // every issue with "parent" in its body. That is a superset, which is
      // all the contract asks for: the caller reads the heading itself.
      // Checked against a repo of 84 issues by filtering a full listing
      // locally: 67 carried the heading and the search returned all 67.
      // 1000 is the search API's own ceiling.
      // Search is indexed with a lag (see listReady), so a child filed a
      // moment ago may be missing here. The ones that matter most, the
      // children in the ready set, are found through the ready set's own
      // bodies, which findEpics reads directly, not through this.
      return call<{ number: number; state: string; body: string | null }[]>([
        "issue",
        "list",
        "--state",
        "all",
        "--search",
        '"## Parent" in:body',
        "--limit",
        "1000",
        "--json",
        "number,state,body",
      ]).map((i) => ({
        id: String(i.number),
        state: stateOf(i.state),
        body: i.body ?? "",
      }));
    },

    addBlocker(id, blockerId) {
      // THE PAYLOAD TAKES AN INTERNAL DATABASE ID, NOT AN ISSUE NUMBER, and
      // getting that wrong does not fail — it silently records the WRONG EDGE.
      //
      // The endpoint's one required key is `issue_id`, and every other id in
      // this adapter is an issue number, so `issue_id: 20` is the obvious
      // reading. It is also accepted: probing this on a repo where #19 was the
      // intended blocker returned 201, and the edge it created pointed at
      // `sparklemotion/nokogiri#2` — a stranger's issue from 2008, which is
      // simply what internal id 19 happens to be. Ids are global to GitHub and
      // the endpoint does not require the blocker to be in this repo, so a
      // small number always resolves to SOMETHING, and never to the ticket
      // meant. There is no error to notice, only a dependency on a repository
      // nobody involved has heard of.
      //
      // So the number is resolved through the API first, always. The extra
      // call is the price of the write being the one asked for.
      const internal = call<{ id: number }>([
        "api",
        `repos/{owner}/{repo}/issues/${blockerId}`,
        "--jq",
        "{id}",
      ]).id;

      const r = gh([
        "api",
        "--method",
        "POST",
        `repos/{owner}/{repo}/issues/${id}/dependencies/blocked_by`,
        "-F",
        `issue_id=${internal}`,
      ]);
      if (r.ok) return;
      // An edge that is already there is the state this was asked to produce.
      // GitHub reports it as a 422 rather than a no-op; the contract above
      // says that is success, so that two runs of --sync-edges do not differ.
      if (/already been taken/i.test(r.stderr || r.stdout)) return;
      throw new Error(
        `could not record #${id} as blocked by #${blockerId}:\n${(
          r.stderr || r.stdout
        ).trim()}`,
      );
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
