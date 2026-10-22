/**
 * The landing gates, as SHAPES rather than commands.
 *
 *   exitCode(cmd)                                   # `bun run test`
 *   exitCodeOverFiles(cmd)                          # `biome check <changed files>`
 *   baselineDiff({ cmd, errorMatch, normalize })    # `tsc`, with standing debt
 *   ciRuns({ workflows })                           # GitHub Actions on the slice's SHA
 *
 * `slice.config.ts` picks and orders them under `gates`; `slice-run.ts` hands
 * them to `runGates` before every land. Nothing here reads the config, on
 * purpose — the config imports the constructors from this file, and a module
 * that imported the config back would be a cycle.
 *
 * WHY SHAPES AND NOT COMMANDS
 * ---------------------------
 * A gate that is just a command string cannot express what the three real
 * gates need. A test suite is an exit code. A linter is an exit code, but it
 * has to be handed the changed-file list or it judges the whole tree. And a
 * typechecker with a standing baseline of pre-existing errors is neither: it
 * must run TWICE, in the main checkout and in the slice, and fail only on the
 * errors that are new. The differences are in the shape of the check, so the
 * seam is a function per shape, not a string per project.
 *
 * THE CONTRACT: A GATE IS READ-ONLY
 * ---------------------------------
 * A gate observes the worktree it is judging and must not write to it. This
 * is not a style preference; it is what makes the land safe to automate:
 *
 *  - A gate that edits files dirties the worktree, and the dispatcher then
 *    refuses to land it as "someone kept working after marking it done".
 *  - Worse, if it edits AND the land still goes through, it lands changes
 *    nobody reviewed — the reviewer saw the diff before the gate rewrote it.
 *
 * The trap is real and it is one word wide: `biome check <files>` observes;
 * `bun run format` is `biome check --apply .`, which rewrites the whole tree.
 * This repo hit the human-facing half of that on 2026-09-07, when the tree-wide
 * form rewrote 891 files under another live session (see scripts/format.sh).
 *
 * `runGates` enforces the contract rather than trusting it: after every gate
 * it checks `git status` in the worktree, and a gate that left anything behind
 * fails the land by name, regardless of its own verdict. So configuring the
 * mutating command is still a mistake, but it is now a loud one that lands
 * nothing, instead of a quiet one that lands everything.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { ignores } from "./slice-overlap";

// ─── the seam ─────────────────────────────────────────────────────────────

/**
 * Runs a command and never throws — a gate's verdict IS the exit status, so
 * a non-zero exit is an answer, not an error. `out` must carry stdout and
 * stderr joined: tsc reports on stdout, biome on stderr, and a gate that reads
 * output has to see both.
 */
export type Exec = (cmd: string[], cwd: string) => { ok: boolean; out: string };

export type GateContext = {
  /** The slice's worktree — the checkout being judged. Every gate runs here. */
  worktree: string;
  /**
   * The checkout whose errors are the standing debt — in practice the main
   * checkout, on the base branch. Only `baselineDiff` reads it. The slice was
   * rebased onto that branch just before the gates run, so what it is compared
   * against is what it will actually land on.
   */
  baselineDir: string;
  /** Paths changed on the branch relative to the base, as `git diff --name-only` prints them. */
  changedFiles: string[];
  exec: Exec;
};

export type GateResult =
  | { ok: true }
  | {
      ok: false;
      /** One line, printed after "✗ #n not landed —". */
      why: string;
      /** Supporting lines: the errors introduced, the tail of a failing run. */
      detail?: string[];
    };

export type Gate = {
  /** Shown while running and named in the failure line. */
  name: string;
  run: (ctx: GateContext) => GateResult;
  /**
   * How many times `runGates` re-runs this gate after it fails, before the
   * failure counts. 0 when absent. See `runGates` for why it is per gate.
   */
  retries?: number;
  /** The paths it judges; it runs only when the diff touches one. See `gateApplies`. */
  when?: string[];
};

/** What every gate shape takes besides its command. */
export type GateOptions = {
  /** Appended to the failure line: what a human should do about it. */
  hint?: string;
  /** Re-runs after a failure, for a gate that is flaky under load. Default 0. */
  retries?: number;
  /**
   * Path patterns, as `ignores()` in slice-overlap.ts reads them: `*` within a
   * directory, `**` across them, a trailing `/` for a directory's contents.
   * The gate runs only for a slice that changes a file matching one of them,
   * and runs always without it. For a check that is expensive and judges one
   * part of the tree: a native build, `["ios/**", "android/**"]`.
   */
  when?: string[];
};

// ─── the three shapes ─────────────────────────────────────────────────────

const withHint = (why: string, hint?: string) =>
  hint ? `${why} (${hint})` : why;

/** The last few lines of a run, for a failure that would otherwise be just "exited non-zero". */
const tail = (out: string, n = 10): string[] =>
  out
    .split("\n")
    .filter((l) => l.trim())
    .slice(-n);

/**
 * Pass iff the command exits zero in the worktree. Test suites.
 *
 * `hint` is appended to the failure line — the place to say what a human
 * should do about it, in the project's own words.
 */
export function exitCode(cmd: string[], opts: GateOptions = {}): Gate {
  const name = cmd.join(" ");
  return {
    name,
    retries: opts.retries,
    when: opts.when,
    run(ctx) {
      const { ok, out } = ctx.exec(cmd, ctx.worktree);
      if (ok) return { ok: true };
      return {
        ok: false,
        why: withHint(`\`${name}\` failed`, opts.hint),
        detail: tail(out),
      };
    },
  };
}

/**
 * Pass iff the command exits zero when handed the changed-file list. Linters.
 *
 * Only files that still exist in the worktree are passed: a slice that deletes
 * a file has "changed" it, and a linter handed a path that is gone reports an
 * I/O error rather than nothing. With no surviving files there is nothing to
 * lint and the gate passes without running — running the linter with NO paths
 * would have it check the whole tree, which is a different gate.
 */
export function exitCodeOverFiles(cmd: string[], opts: GateOptions = {}): Gate {
  const name = cmd.join(" ");
  return {
    name,
    retries: opts.retries,
    when: opts.when,
    run(ctx) {
      const files = ctx.changedFiles.filter((f) =>
        existsSync(join(ctx.worktree, f)),
      );
      if (files.length === 0) return { ok: true };
      const { ok, out } = ctx.exec([...cmd, ...files], ctx.worktree);
      if (ok) return { ok: true };
      return {
        ok: false,
        why: withHint(`\`${name}\` failed on the changed files`, opts.hint),
        detail: tail(out),
      };
    },
  };
}

/**
 * Multiset difference: every element of `candidate` that is not matched by a
 * still-unconsumed element of `baseline`.
 *
 * A multiset, not a Set: each baseline entry is consumed once, so a SECOND
 * copy of an error that already exists counts as introduced. That is the
 * case a Set difference gets wrong — a slice that duplicates a broken pattern
 * has added an error even though the text is not new.
 */
export function multisetDifference(
  baseline: string[],
  candidate: string[],
): string[] {
  const remaining = [...baseline];
  return candidate.filter((e) => {
    const at = remaining.indexOf(e);
    if (at === -1) return true;
    remaining.splice(at, 1);
    return false;
  });
}

export type BaselineDiffOptions = {
  cmd: string[];
  /**
   * Which output lines are errors. Tool-specific and unavoidable: tsc says
   * `error TS2345`, mypy says `error:`, clippy says `error[E0308]`. A RegExp
   * is tested per line; a function is called per line.
   */
  errorMatch: RegExp | ((line: string) => boolean);
  /**
   * Strips the parts of an error line that move when unrelated code moves.
   * For tsc that is `(line,col)`: inserting one line near the top of a file
   * shifts every error below it, and without this every one of those would
   * read as new. Required, because what counts as position is per-tool too.
   */
  normalize: (line: string) => string;
} & GateOptions;

/**
 * For tools with a standing baseline of errors, where a non-zero exit is
 * normal and the only question is which errors are NEW.
 *
 * Runs the command twice — in `baselineDir` and in the worktree — and fails
 * on the multiset difference of the normalized error lines.
 *
 * This replaced the obvious shortcut, "does any error name a file the slice
 * touched?", because that check is wrong in both directions (ADR 0001, #28):
 * a file can be both in the baseline and one slices routinely touch, so the
 * slice inherits blame for errors already on master; and a type change breaks
 * files the slice never edited, which the shortcut cannot see. #12 was blocked
 * on 2026-09-04 by four "errors it touched", three of them verbatim on master.
 *
 * A worktree run that exits non-zero without a single matching line is
 * reported as a crash, not a pass: a compiler that fell over has judged
 * nothing, and "no new errors" would be the wrong reading of its silence.
 */
export function baselineDiff(opts: BaselineDiffOptions): Gate {
  const name = opts.cmd.join(" ");
  // A /g or /y RegExp is stateful across `.test` calls and would skip every
  // other line. Rebuilt without those flags so a caller can't be bitten by it.
  const matches =
    typeof opts.errorMatch === "function"
      ? opts.errorMatch
      : (() => {
          const re = new RegExp(
            opts.errorMatch.source,
            opts.errorMatch.flags.replace(/[gy]/g, ""),
          );
          return (line: string) => re.test(line);
        })();
  const errorsIn = (ctx: GateContext, cwd: string) => {
    const { ok, out } = ctx.exec(opts.cmd, cwd);
    const errors = out.split("\n").filter(matches).map(opts.normalize);
    return { ok, errors, out };
  };
  return {
    name,
    retries: opts.retries,
    when: opts.when,
    run(ctx) {
      const baseline = errorsIn(ctx, ctx.baselineDir);
      const candidate = errorsIn(ctx, ctx.worktree);
      if (!candidate.ok && candidate.errors.length === 0) {
        return {
          ok: false,
          why: `\`${name}\` exited non-zero in the slice without reporting a single error — did it crash?`,
          detail: tail(candidate.out),
        };
      }
      const introduced = multisetDifference(baseline.errors, candidate.errors);
      if (introduced.length === 0) return { ok: true };
      return {
        ok: false,
        why: withHint(
          `${introduced.length} error(s) from \`${name}\` it introduced (baseline is ${baseline.errors.length})`,
          opts.hint,
        ),
        detail: introduced,
      };
    },
  };
}

// ─── CI on the slice's SHA ────────────────────────────────────────────────

export type CiRunsOptions = {
  /**
   * The GitHub Actions workflows that must succeed on the slice's SHA, by the
   * name GitHub shows for them. All of them; one that never runs is a red gate
   * at the deadline, not a pass.
   */
  workflows: string[];
  /** How long to wait for them before the gate is red. Default 45. */
  deadlineMinutes?: number;
  /** The pause between two looks at the runs. Default 20. */
  pollSeconds?: number;
} & GateOptions;

type CiRun = {
  databaseId: number;
  name: string;
  status: string;
  conclusion: string;
  url: string;
};

type CiVerdict =
  | { kind: "green" }
  | { kind: "red"; run: CiRun }
  | { kind: "open"; running: string[]; missing: string[] };

/**
 * `owner/repo` for a remote URL on github.com, `host/owner/repo` for any other
 * host (GitHub Enterprise), as `gh -R` takes it. null for a URL with no host,
 * like a local path: there is no GitHub to ask.
 */
export function ghRepoOf(url: string): string | null {
  const bare = url
    .trim()
    .replace(/\/+$/, "")
    .replace(/\.git$/, "");
  // Two forms: a URL with a scheme, and scp's `user@host:path`. Kept apart,
  // because read as the second, `file:///srv/app` is host `file`.
  const m =
    bare.match(
      /^[a-z][a-z0-9+.-]*:\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/(.+)$/i,
    ) ?? bare.match(/^(?:[^@/]+@)?([^/:]+):(?!\/\/)(.+)$/);
  if (!m) return null;
  const [, host, path] = m as unknown as [string, string, string];
  const parts = path.split("/").filter(Boolean);
  if (parts.length < 2) return null;
  const repo = parts.slice(-2).join("/");
  return host.toLowerCase() === "github.com" ? repo : `${host}/${repo}`;
}

/**
 * Pass iff GitHub Actions ran every named workflow on exactly the SHA that is
 * about to land, and each succeeded. For a project whose rule is "green CI on
 * the pushed SHA before the base branch moves": the dispatcher gates locally
 * and pushes the base right after, so the CI run has to happen inside a gate.
 *
 *   ciRuns({ workflows: ["Tests", "Docker-Gate"] })
 *
 * Ported from consumer-b's backend, whose own script did this from its
 * adoption. What it does, and why:
 *
 *  - **Already green, no push.** A retry with no new head costs one call.
 *  - **A branch of its own per SHA**, `azelf-ci/<branch>-<sha12>`, never the
 *    slice's branch. Under `--auto` the base moves, the land rebases, and a
 *    second push of the slice's branch would be a force push. A name per SHA
 *    never needs one. It is deleted at the end, green or red; the runs stay
 *    readable through `gh run list --commit <sha>`. The workflows have to run
 *    on a push to it: on every branch, or at least on `azelf-ci/**`.
 *  - **The branch is deleted before the push too.** A dispatcher killed while
 *    it waited leaves the branch at this SHA, and pushing it again would change
 *    nothing on GitHub and start no workflow.
 *  - **Only runs created after the push count.** The newest run on the SHA is
 *    noted before it, so an old red run from an earlier attempt does not fail
 *    the retry. After the push, the newest run per workflow decides.
 *  - **A deadline, counted in waits.** Every look and every sleep goes through
 *    `ctx.exec`, so the tests drive it with no clock; the real wait runs past
 *    the deadline by what the looks themselves take, a second or two each.
 *  - **gh failing before the push fails the gate** (not installed, signed out,
 *    no such repo). During the wait it is one look that found nothing, and the
 *    deadline names the last failure.
 *
 * The repo is origin's, from its URL, because origin is where the push goes:
 * gh's own guess prefers an `upstream` remote. Read-only like every gate: the
 * pushes move refs, which `git status` does not show.
 *
 * It holds the dispatcher for as long as CI takes, gate lock included, like
 * any slow gate. Put it last, so a red local suite never pushes.
 */
export function ciRuns(opts: CiRunsOptions): Gate {
  const { workflows } = opts;
  if (!workflows.length || workflows.some((w) => !w.trim())) {
    throw new Error(
      "ciRuns: workflows must name at least one workflow, and no empty name — with none, every SHA would pass",
    );
  }
  const deadlineMinutes = opts.deadlineMinutes ?? 45;
  const pollSeconds = opts.pollSeconds ?? 20;
  for (const [key, v] of [
    ["deadlineMinutes", deadlineMinutes],
    ["pollSeconds", pollSeconds],
  ] as const) {
    if (!Number.isFinite(v) || v <= 0) {
      throw new Error(`ciRuns: ${key} must be a positive number, not ${v}`);
    }
  }
  const polls = Math.ceil((deadlineMinutes * 60) / pollSeconds);
  const name = `CI: ${workflows.join(", ")}`;

  return {
    name,
    retries: opts.retries,
    when: opts.when,
    run(ctx) {
      const red = (why: string, detail?: string[]): GateResult => ({
        ok: false,
        why: withHint(`CI: ${why}`, opts.hint),
        ...(detail ? { detail } : {}),
      });
      const git = (...args: string[]) =>
        ctx.exec(["git", ...args], ctx.worktree);

      const branch = git("branch", "--show-current").out.trim();
      if (!branch) {
        return red(
          "the worktree is on a detached HEAD — the CI push is named after its branch",
        );
      }
      const head = git("rev-parse", "HEAD");
      const sha = head.out.trim();
      if (!head.ok || !/^[0-9a-f]{40}$/.test(sha)) {
        return red("could not read the worktree's HEAD", tail(head.out));
      }
      const short = sha.slice(0, 7);
      const originUrl = git("remote", "get-url", "origin").out.trim();
      const repo = ghRepoOf(originUrl);
      if (!repo) {
        return red(
          `origin is not a GitHub repository (${originUrl}) — ciRuns reads GitHub Actions through gh`,
        );
      }
      const listArgv = ["gh", "run", "list", "-R", repo, "--commit", sha];
      const listCmd = listArgv.join(" ");

      const look = (): { runs: CiRun[] } | { error: string[] } => {
        const r = ctx.exec(
          [
            ...listArgv,
            "--limit",
            "30",
            "--json",
            "databaseId,name,status,conclusion,url",
          ],
          ctx.worktree,
        );
        // `out` carries stderr too; gh prints its JSON as one line of its own.
        const json = r.ok
          ? r.out.split("\n").find((l) => l.trim().startsWith("["))
          : undefined;
        if (json === undefined) return { error: tail(r.out) };
        try {
          return { runs: JSON.parse(json) as CiRun[] };
        } catch {
          return { error: tail(r.out) };
        }
      };
      const verdict = (runs: CiRun[], after: number): CiVerdict => {
        const counted = runs
          .filter((r) => r.databaseId > after)
          .sort((a, b) => b.databaseId - a.databaseId);
        const running: string[] = [];
        const missing: string[] = [];
        for (const wf of workflows) {
          const newest = counted.find((r) => r.name === wf);
          if (!newest) missing.push(wf);
          else if (newest.status !== "completed") running.push(wf);
          else if (newest.conclusion !== "success") {
            return { kind: "red", run: newest };
          }
        }
        return running.length || missing.length
          ? { kind: "open", running, missing }
          : { kind: "green" };
      };

      const first = look();
      if ("error" in first) {
        return red(`gh could not list the runs on ${short}`, first.error);
      }
      if (verdict(first.runs, 0).kind === "green") return { ok: true };
      const after = Math.max(0, ...first.runs.map((r) => r.databaseId));

      const ciRef = `refs/heads/azelf-ci/${branch.replaceAll(
        "/",
        "-",
      )}-${sha.slice(0, 12)}`;
      const ciBranch = ciRef.slice("refs/heads/".length);
      const remove = () => git("push", "-q", "origin", `:${ciRef}`);
      remove();
      const pushed = git("push", "-q", "origin", `HEAD:${ciRef}`);
      if (!pushed.ok) {
        return red(
          `the push of ${short} to ${ciBranch} was refused`,
          tail(pushed.out),
        );
      }
      try {
        let last: CiVerdict = { kind: "open", running: [], missing: workflows };
        let lastError: string[] | null = null;
        for (let i = 0; i < polls; i++) {
          ctx.exec(["sleep", String(pollSeconds)], ctx.worktree);
          const now = look();
          if ("error" in now) {
            lastError = now.error;
            continue;
          }
          lastError = null;
          last = verdict(now.runs, after);
          if (last.kind === "green") return { ok: true };
          if (last.kind === "red") {
            return red(
              `\`${last.run.name}\` is ${
                last.run.conclusion || "not a success"
              } on ${short}`,
              [last.run.url, listCmd],
            );
          }
        }
        const open = last.kind === "open" ? last : { running: [], missing: [] };
        const state = [
          ...open.running.map((w) => `\`${w}\` still running`),
          ...open.missing.map((w) => `\`${w}\` never started`),
        ].join(", ");
        const minutes = `${deadlineMinutes} minute${
          deadlineMinutes === 1 ? "" : "s"
        }`;
        return red(`not finished on ${short} after ${minutes} — ${state}`, [
          listCmd,
          ...(lastError
            ? [`The last look at the runs failed: ${lastError.join(" ")}`]
            : open.missing.length
              ? [
                  "A workflow that never starts: check its name, and that it runs on a push to azelf-ci/**.",
                ]
              : []),
        ]);
      } finally {
        remove();
      }
    },
  };
}

// ─── the runner ───────────────────────────────────────────────────────────

/**
 * `null` when git itself could not answer — a missing worktree, a broken
 * checkout. That is not "clean": an empty answer from a failed command is how
 * a gate that wrote to a tree we couldn't even see would slip through.
 */
const dirtyPaths = (ctx: GateContext): string[] | null => {
  const { ok, out } = ctx.exec(["git", "status", "--porcelain"], ctx.worktree);
  if (!ok) return null;
  return out
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
};

const unreadable = (worktree: string): GateResult => ({
  ok: false,
  why: `could not read the worktree's git status at ${worktree} — refusing to judge what cannot be seen`,
});

/** A gate that failed and then passed: `retry` is the run that passed, 1-based. */
export type Flaky = { gate: string; retry: number };

/**
 * What `runGates` answers: the verdict, which gates passed only on a retry,
 * and which were skipped because the diff touches none of their paths.
 */
export type GatesResult = GateResult & { flaky: Flaky[]; skipped: string[] };

/**
 * Whether `gate` judges a diff that changed `changedFiles`: always without
 * `when`, and otherwise when one file matches one of its patterns. A deleted
 * file counts — removing a native source is a change to the native build.
 */
export function gateApplies(gate: Gate, changedFiles: string[]): boolean {
  if (!gate.when) return true;
  return changedFiles.some(ignores(gate.when));
}

/**
 * Run the gates in order and stop at the first failure.
 *
 * The worktree must be clean going in, and is checked again after EVERY gate:
 * that is how the read-only contract at the top of this file is enforced
 * rather than hoped for. A gate that left the tree dirty fails the land by
 * name — before its own verdict is even considered, because a gate that
 * writes has disqualified itself whatever it concluded.
 *
 * A gate with `retries` is re-run after a failure, and the write check runs
 * after every attempt. Opt-in and per gate, because retrying a deterministic
 * gate (tsc, a linter) only doubles what a real failure costs. It is for the
 * test suite under a wave's load: on consumer-a, at a load average near 30, a
 * 5-second test timeout parked three green slices that never touched the code
 * under test. A pass on a retry is still a pass, and is reported in `flaky`
 * so that it is seen, not buried.
 *
 * A gate whose `when` matches none of `ctx.changedFiles` is not run, and is
 * named in `skipped`. Skipped is not passed: the caller says which is which.
 */
export function runGates(gates: Gate[], ctx: GateContext): GatesResult {
  const flaky: Flaky[] = [];
  const skipped: string[] = [];
  const before = dirtyPaths(ctx);
  if (before === null) return { ...unreadable(ctx.worktree), flaky, skipped };
  if (before.length) {
    return {
      ok: false,
      why: "worktree is dirty before any gate ran — commit or revert first",
      detail: before,
      flaky,
      skipped,
    };
  }
  for (const gate of gates) {
    if (!gateApplies(gate, ctx.changedFiles)) {
      skipped.push(gate.name);
      continue;
    }
    const retries = Math.max(0, Math.floor(gate.retries ?? 0));
    for (let attempt = 0; ; attempt++) {
      const result = gate.run(ctx);
      const after = dirtyPaths(ctx);
      if (after === null) {
        return { ...unreadable(ctx.worktree), flaky, skipped };
      }
      if (after.length) {
        return {
          ok: false,
          why: `gate \`${gate.name}\` modified the worktree — gates must be read-only (scripts/slice-gates.ts). Revert it, then fix the gate.`,
          detail: after,
          flaky,
          skipped,
        };
      }
      if (result.ok) {
        if (attempt > 0) flaky.push({ gate: gate.name, retry: attempt });
        break;
      }
      if (attempt >= retries) {
        return {
          ...result,
          why: attempt
            ? `${result.why}, and again on ${attempt} retr${
                attempt === 1 ? "y" : "ies"
              }`
            : result.why,
          flaky,
          skipped,
        };
      }
    }
  }
  return { ok: true, flaky, skipped };
}
