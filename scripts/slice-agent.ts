/**
 * The AGENT seam: which coding agent a slice session runs, and which one reviews
 * a diff before it lands.
 *
 * The fifth seam, and the last hardcoded assumption in this package. Until this
 * file existed, `slice-session.sh` ran the literal word `claude` and
 * `slice-run.ts` shelled out to `claude -p`, which meant azelf was a Claude Code
 * tool that happened to be shaped like a workflow tool. Nothing else about the
 * design cared.
 *
 * Same shape as slice-gates.ts, slice-tracker.ts and slice-launcher.ts: a
 * contract, constructors the config imports, validation in the loader, and the
 * shell told only what it can carry. See slice-launcher.ts for the fullest
 * statement of why these are contracts rather than name strings.
 *
 * TWO CAPABILITIES, AND THEY ARE NOT THE SAME ONE
 * -----------------------------------------------
 * `session` is interactive: a terminal, a human-shaped conversation, an opening
 * instruction, and it runs until someone (or the self-land instruction) ends it.
 * `review` is headless: one prompt in, text out, no tools, bounded time. An
 * agent can have the first without the second — and one that does is still
 * perfectly usable, because the reviews are an enhancement to landing, not a
 * requirement of it.
 *
 * That is why `review` returns `null` rather than throwing: `slice-run.ts` skips
 * the review step and says so, instead of refusing to land.
 *
 * WHAT THE SHELL GETS
 * -------------------
 * `sessionCommand` only, as an array, with the opening prompt appended by
 * `slice-session.sh` as the final argument. The review half never reaches the
 * shell because nothing in the shell reviews anything — the dispatcher owns
 * landing, and it is TypeScript.
 */

import { spawnSync } from "node:child_process";

export type Agent = {
  /** Short, lowercase, for the shell bridge and error messages. */
  name: string;

  /**
   * Why this agent cannot run HERE, or null. Checked by the dispatcher before
   * anything is prepped, exactly like `Launcher.problem()` — a missing binary
   * should be one clear line before a single worktree is created, not a
   * confusing failure in each session afterwards.
   */
  problem(): string | null;

  /**
   * argv PREFIX for an interactive session. `slice-session.sh` appends the
   * opening instruction as the last argument, or runs the prefix alone when
   * started with `--no-start`.
   *
   * A prefix rather than a function of the prompt because this one crosses the
   * shell bridge, and an array of words is the most a bridge can carry. An agent
   * that cannot take its opening instruction as a trailing argument does not fit
   * this seam, and should say so in `problem()` rather than pretend.
   */
  sessionCommand: string[];

  /**
   * Full argv for one headless prompt, or null if this agent has no headless
   * mode. The prompt is passed in because agents differ on whether it is an
   * argument, a flag value, or stdin — and the ones that want stdin can return
   * null until this seam grows a stdin variant, which nothing needs yet.
   */
  review(prompt: string): string[] | null;
};

/** Injected so tests never look for a real binary. */
export type Which = (cmd: string) => boolean;

const realWhich: Which = (cmd) =>
  spawnSync("command", ["-v", cmd], { shell: true, encoding: "utf8" })
    .status === 0;

const missing = (agent: string, bin: string): string =>
  `slice.config.ts names the ${agent} agent, but '${bin}' is not on PATH`;

export type ClaudeOptions = {
  /** The binary, if it is not on PATH as `claude`. */
  bin?: string;
  /** Extra flags for the interactive session, e.g. `["--permission-mode", "acceptEdits"]`. */
  sessionFlags?: string[];
  which?: Which;
};

/**
 * Claude Code. The default, and the only one of the two proven end to end —
 * every slice this workflow has run has been a `claude` session.
 *
 * `-p` is its headless mode: one prompt, printed answer, no interactive input.
 * The review prompts ask for a verdict line and nothing else, which is why they
 * need no tools and no MCP servers.
 */
export function claude(opts: ClaudeOptions = {}): Agent {
  const bin = opts.bin ?? "claude";
  const which = opts.which ?? realWhich;
  return {
    name: "claude",
    problem: () => (which(bin) ? null : missing("claude", bin)),
    sessionCommand: [bin, ...(opts.sessionFlags ?? [])],
    review: (prompt) => [bin, "-p", prompt],
  };
}

export type CodexOptions = {
  bin?: string;
  sessionFlags?: string[];
  /**
   * Whether this Codex build has a headless mode the reviews can use. Defaults
   * to FALSE, deliberately — see the comment in `codex()`.
   */
  headless?: boolean;
  which?: Which;
};

/**
 * OpenAI Codex.
 *
 * `sessionCommand` is `codex "<prompt>"`, which is the documented shape: the
 * first positional argument is the opening instruction.
 *
 * `review` returns null by DEFAULT, and that is a deliberate refusal rather than
 * an omission. Codex's non-interactive invocation (`codex exec`) exists, but it
 * has not been run against this workflow's review prompts on this machine, and a
 * review seam that silently produces nothing — or worse, produces prose with no
 * parseable `VERDICT:` line, which the dispatcher treats as BLOCK — would turn
 * every land into a stall. Skipping the review loudly is the honest failure.
 *
 * Pass `headless: true` once you have verified it; the wiring is here and
 * costs one flag.
 */
export function codex(opts: CodexOptions = {}): Agent {
  const bin = opts.bin ?? "codex";
  const which = opts.which ?? realWhich;
  return {
    name: "codex",
    problem: () => (which(bin) ? null : missing("codex", bin)),
    sessionCommand: [bin, ...(opts.sessionFlags ?? [])],
    review: (prompt) => (opts.headless ? [bin, "exec", prompt] : null),
  };
}

/**
 * Any other agent, described rather than special-cased.
 *
 *   agent: custom({ name: "aider", sessionCommand: ["aider", "--message"] })
 *
 * This exists so that adding an agent does not require editing this file. The
 * four constructors above are conveniences; this is the actual contract.
 */
export type CustomOptions = {
  name: string;
  sessionCommand: string[];
  review?: (prompt: string) => string[] | null;
  which?: Which;
};

export function custom(opts: CustomOptions): Agent {
  const which = opts.which ?? realWhich;
  const bin = opts.sessionCommand[0];
  if (!bin) {
    throw new Error("custom agent: sessionCommand must name a binary");
  }
  return {
    name: opts.name,
    problem: () => (which(bin) ? null : missing(opts.name, bin)),
    sessionCommand: opts.sessionCommand,
    review: opts.review ?? (() => null),
  };
}
