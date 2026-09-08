/**
 * The landing gates, as three SHAPES rather than three commands.
 *
 *   exitCode(cmd)                                   # `bun run test`
 *   exitCodeOverFiles(cmd)                          # `biome check <changed files>`
 *   baselineDiff({ cmd, errorMatch, normalize })    # `tsc`, with standing debt
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
export function exitCode(cmd: string[], opts: { hint?: string } = {}): Gate {
  const name = cmd.join(" ");
  return {
    name,
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
export function exitCodeOverFiles(
  cmd: string[],
  opts: { hint?: string } = {},
): Gate {
  const name = cmd.join(" ");
  return {
    name,
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
  hint?: string;
};

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

/**
 * Run the gates in order and stop at the first failure.
 *
 * The worktree must be clean going in, and is checked again after EVERY gate:
 * that is how the read-only contract at the top of this file is enforced
 * rather than hoped for. A gate that left the tree dirty fails the land by
 * name — before its own verdict is even considered, because a gate that
 * writes has disqualified itself whatever it concluded.
 */
export function runGates(gates: Gate[], ctx: GateContext): GateResult {
  const before = dirtyPaths(ctx);
  if (before === null) return unreadable(ctx.worktree);
  if (before.length) {
    return {
      ok: false,
      why: "worktree is dirty before any gate ran — commit or revert first",
      detail: before,
    };
  }
  for (const gate of gates) {
    const result = gate.run(ctx);
    const after = dirtyPaths(ctx);
    if (after === null) return unreadable(ctx.worktree);
    if (after.length) {
      return {
        ok: false,
        why: `gate \`${gate.name}\` modified the worktree — gates must be read-only (scripts/slice-gates.ts). Revert it, then fix the gate.`,
        detail: after,
      };
    }
    if (!result.ok) return result;
  }
  return { ok: true };
}
