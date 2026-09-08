/**
 * What kind of project is this, and what should its gates be?
 *
 * `azelf init` used to copy one static `slice.config.ts` template whose gates
 * were `npm test` and a comment saying "EDIT IT". That is the shape of a
 * starter nobody edits: it runs, it is wrong, and the wrongness only shows up
 * as a slice that will not land.
 *
 * So init reads `package.json` and writes a config that already fits. The
 * detection is deliberately SHALLOW — dependency names and lockfiles, nothing
 * that executes — because a wrong guess must be cheap to correct, and every
 * generated line carries the comment saying what it assumed.
 *
 * Four stacks: an Expo app, a Next.js app, plain TypeScript, and Python.
 * Anything unrecognised with a package.json falls back to plain TypeScript,
 * which is the subset the JavaScript ones are built on.
 *
 * A NOTE ON PYTHON. The config is still a TypeScript file, so a Python project
 * needs bun on PATH to run this workflow at all — the loader reads
 * `slice.config.ts`, and the shell bridge shells out to it. That is a real cost
 * and it is stated in the generated config rather than discovered later. The
 * gates themselves are just argv, so pytest and ruff are no harder to express
 * than vitest and biome.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export type Stack = "expo" | "nextjs" | "typescript" | "python";
export type JsRunner = "bun" | "pnpm" | "yarn" | "npm";
export type PyRunner = "uv" | "poetry" | "pip";
export type Runner = JsRunner | PyRunner;

export const isPython = (s: Stack): boolean => s === "python";

export type Detected = {
  stack: Stack;
  runner: Runner;
  /** The test script, if `package.json` has one. No script means no test gate. */
  testScript: string | null;
  /** Which linter/formatter is installed. Decides the third gate's shape. */
  linter: "biome" | "eslint" | "ruff" | null;
  /** Notes worth printing — things detected that change what you should check. */
  notes: string[];
};

type PackageJson = {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  scripts?: Record<string, string>;
};

/**
 * How this project runs a tool from its own environment.
 *
 * For Python this is the whole ballgame: `pytest` on PATH and `uv run pytest`
 * are different programs against different dependency sets, and a gate that
 * runs the wrong one is a gate that passes in the main checkout and fails in
 * every worktree.
 */
export const execFor = (runner: Runner): string[] =>
  runner === "uv"
    ? ["uv", "run"]
    : runner === "poetry"
      ? ["poetry", "run"]
      : runner === "pip"
        ? []
        : runner === "bun"
          ? ["bunx"]
          : runner === "pnpm"
            ? ["pnpm", "dlx"]
            : runner === "yarn"
              ? ["yarn", "dlx"]
              : ["npx"];

/** `bun run test` / `npm run test` — how this project runs a package script. */
export const runFor = (runner: Runner): string[] =>
  runner === "npm" ? ["npm", "run"] : [runner, "run"];

export function detect(root: string): Detected {
  const pkgPath = join(root, "package.json");
  const pkg: PackageJson = existsSync(pkgPath)
    ? JSON.parse(readFileSync(pkgPath, "utf8"))
    : {};
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  const has = (name: string): boolean => name in deps;
  const notes: string[] = [];
  const at = (f: string): boolean => existsSync(join(root, f));

  const pyproject = at("pyproject.toml");
  const isPy = pyproject || at("setup.py") || at("requirements.txt");
  const pyText = pyproject
    ? readFileSync(join(root, "pyproject.toml"), "utf8")
    : "";

  // package.json wins when both are present. A Python service with a small JS
  // frontend is common; the reverse is rarer, and guessing wrong here writes
  // gates that cannot run at all rather than gates that are merely incomplete.
  if (isPy && existsSync(pkgPath)) {
    notes.push(
      "both package.json and Python project files found — assuming the JavaScript side; edit the gates if the Python side is the one that matters",
    );
  }

  const stack: Stack =
    isPy && !existsSync(pkgPath)
      ? "python"
      : has("expo")
        ? "expo"
        : has("next")
          ? "nextjs"
          : "typescript";

  // Lockfiles first: they say what is actually used, where a `packageManager`
  // field says what someone once intended.
  const runner: Runner =
    stack === "python"
      ? at("uv.lock")
        ? "uv"
        : at("poetry.lock")
          ? "poetry"
          : "pip"
      : at("bun.lock") || at("bun.lockb")
        ? "bun"
        : at("pnpm-lock.yaml")
          ? "pnpm"
          : at("yarn.lock")
            ? "yarn"
            : "npm";
  if (runner === "pip") {
    notes.push(
      "no uv.lock or poetry.lock — gates call pytest/ruff directly, which assumes the right virtualenv is active in each worktree",
    );
  }

  const testScript =
    stack === "python"
      ? at("tests") || at("test") || /pytest/.test(pyText)
        ? "pytest"
        : null
      : pkg.scripts?.test
        ? "test"
        : null;
  if (!testScript) {
    notes.push(
      stack === "python"
        ? "no tests/ directory and no pytest in pyproject.toml — the test gate is written commented out"
        : "no `test` script in package.json — the test gate is written commented out",
    );
  }

  const linter: Detected["linter"] =
    stack === "python"
      ? /ruff/.test(pyText)
        ? "ruff"
        : null
      : has("@biomejs/biome")
        ? "biome"
        : has("eslint")
          ? "eslint"
          : null;
  if (!linter) {
    notes.push(
      stack === "python"
        ? "no ruff in pyproject.toml — the lint gate is written commented out"
        : "no biome or eslint found — the lint gate is written commented out",
    );
  }

  if (stack === "python") {
    notes.push(
      "Python project: slice.config.ts is TypeScript, so this workflow needs bun on PATH even though your code does not",
    );
  }

  if (stack === "expo") {
    notes.push(
      "Expo detected: .gitignore is a fingerprint source, so NEVER add tooling entries to it — azelf writes markers to .git/info/exclude for exactly this reason",
    );
  }
  // Only a FALLBACK is worth reporting. A Python project has no package.json by
  // design, and saying so as if it were a shortfall is noise that reads as an error.
  if (!existsSync(pkgPath) && stack !== "python") {
    notes.push("no package.json — falling back to plain TypeScript defaults");
  }
  return { stack, runner, testScript, linter, notes };
}

const lintCmd = (d: Detected): string[] | null => {
  const exec = execFor(d.runner);
  if (d.linter === "biome") {
    return [...exec, "biome", "check", "--no-errors-on-unmatched"];
  }
  if (d.linter === "eslint") {
    return [...exec, "eslint", "--no-error-on-unmatched-pattern"];
  }
  // `ruff check` observes; `ruff check --fix` and `ruff format` rewrite. The
  // gate contract admits only the first.
  if (d.linter === "ruff") return [...exec, "ruff", "check"];
  return null;
};

/** The typecheck gate, which has no cross-stack answer. */
const typeCmd = (d: Detected): { cmd: string[]; note: string } | null => {
  const exec = execFor(d.runner);
  if (d.stack === "python") {
    return {
      cmd: [...exec, "mypy", "."],
      note: `mypy, guessed. Python typecheckers are not interchangeable — swap in
     * \`pyright\` if that is what this project uses, and delete this gate entirely
     * if it uses neither. A gate for a checker nobody runs fails every slice for
     * a reason that has nothing to do with the slice.`,
    };
  }
  return {
    cmd: [...exec, "tsc", "--noEmit"],
    note: `assumes your typecheck baseline is ZERO. If this project already has
     * pre-existing errors the total is meaningless and only NEW errors matter —
     * swap this for \`baselineDiff\`, which runs the typechecker in the main
     * checkout and in the slice and compares the multiset.`,
  };
};

const q = (words: string[]): string =>
  `[${words.map((w) => JSON.stringify(w)).join(", ")}]`;

/**
 * Per-stack `provisionCopy`: gitignored files a `git worktree add` never
 * creates and the slice cannot work without.
 */
function provision(stack: Stack): { entries: string[]; comment: string } {
  if (stack === "expo") {
    return {
      entries: [".env", "expo-env.d.ts"],
      comment: `   *  - \`.env\` — without it the session cannot run the app or reach your backend.
   *  - \`expo-env.d.ts\` — generated and gitignored, and it carries the module
   *    declaration for the \`./global.css\` side-effect import. Without it EVERY
   *    worktree reports a phantom typecheck error the main checkout does not
   *    have, which then gets blamed on whichever slice touched that file.
   *
   * \`.env\` means real secrets land in up to N sibling directories that outlive a
   * failed land. Tolerable for public keys; NOT for production credentials —
   * empty this list if yours are the second kind.`,
    };
  }
  if (stack === "nextjs") {
    return {
      entries: [".env.local"],
      comment: `   *  - \`.env.local\` — Next reads it at build and dev time; a worktree without
   *    it fails in ways that look like code errors.
   *
   * Real secrets land in up to N sibling directories that outlive a failed land.
   * Tolerable for public keys; NOT for production credentials.`,
    };
  }
  if (stack === "python") {
    return {
      entries: [".env"],
      comment: `   *  - \`.env\` — configuration a worktree has no other way to get.
   *
   * NOT the virtualenv: \`.venv\` is machine- and path-specific, and copying one
   * into a worktree produces an environment whose interpreter points back at the
   * main checkout. Let each worktree create its own.
   *
   * Real secrets land in up to N sibling directories that outlive a failed land.
   * Tolerable for local config; NOT for production credentials.`,
    };
  }
  return {
    entries: [],
    comment: `   * Empty: nothing gitignored is load-bearing in a plain TypeScript project.
   * A slice worktree gets what it needs from an install.`,
  };
}

/** The generated `slice.config.ts`. */
export function configFor(d: Detected, opts: { baseBranch: string }): string {
  const run = runFor(d.runner);
  const exec = execFor(d.runner);
  const lint = lintCmd(d);
  const p = provision(d.stack);

  // A package script on the JS side; the tool itself on the Python side, since
  // there is no equivalent of `package.json` scripts to go through.
  const testArgv =
    d.stack === "python"
      ? [...exec, "pytest"]
      : [...run, d.testScript ?? "test"];
  const testGate = d.testScript
    ? `    exitCode(${q(testArgv)}, { hint: "the unit suite is red" }),`
    : `    // no test runner was detected when this was generated:
    // exitCode(${q(testArgv)}, { hint: "the unit suite is red" }),`;
  const type = typeCmd(d);

  const lintGate = lint
    ? `    exitCodeOverFiles(${q(lint)}, {
      hint: "run your formatter in the slice, then commit the result",
    }),`
    : `    // no linter was found when this was generated:
    // exitCodeOverFiles(${q([
      ...exec,
      "biome",
      "check",
      "--no-errors-on-unmatched",
    ])}),`;

  return `/**
 * Project settings for the azelf slice workflow.
 *
 * Generated by \`azelf init\` for a detected ${d.stack} project using ${
   d.runner
 }.
 * Detection is shallow — dependency names and lockfiles — so check the gates
 * below before the first run. Everything here is meant to be edited; it is
 * TypeScript rather than JSON because half of what makes a value correct is an
 * incident, and JSON has nowhere to put that.
 */

import {
  type SliceConfig,
  exitCode,
  exitCodeOverFiles,
  github,
} from "@chintonicc/azelf";

export default {
  /** Where tickets and their blocking edges live. Read and written through \`gh\`. */
  tracker: github(),

  /**
   * Which coding agent runs a session. \`claude()\` is the default and does not
   * need naming. \`codex()\` and \`custom()\` ship — note that \`codex()\` declares
   * no headless mode, so the pre-land reviews are skipped and landing rests on
   * the gates alone.
   */
  // agent: codex(),

  /**
   * A command the agent's own command runs INSIDE — a sandbox, a container.
   * Empty by default. This package ships no profile on purpose: the one it used
   * to carry was macOS-only, pinned to one tool's settings schema, and broken.
   * Note that a wrapper restricting the network breaks \`gh\`, and so the tracker.
   */
  // wrapCommand: ["srt", "--settings", ".sandbox.json"],

  /**
   * How a prepped worktree becomes an open session. Left out on purpose: the
   * default prints one pasteable command per slice and opens nothing, which
   * works in every terminal. \`warp()\` needs the autostart hook (\`azelf init
   * --hook\`); \`tmux()\` carries the command itself.
   */
  // launcher: warp(),

  baseBranch: ${JSON.stringify(opts.baseBranch)},

  /** Must hold exactly one \`{n}\`, and must ROUND-TRIP — a branch name is read back into a ticket id. */
  branchPattern: "ticket/{n}",

  /**
   * Kept OUTSIDE the repo on purpose. A worktree nested inside the checkout is
   * walked by every linter, typechecker and bundler in the project, and then
   * every gate judges every slice.
   */
  worktreeDir: "../{repo}-ticket-{n}",

  readyLabel: "ready-for-agent",

  /**
   * Paths only ONE worktree may hold changes to at a time — the lock. \`[]\`
   * makes it a no-op, which is right almost everywhere. Set it only for a
   * genuinely shared mutable resource: one live database, one generated
   * artifact, something two concurrent slices would corrupt.
   */
  exclusiveLockPaths: [],

  /**
   * Gitignored files copied from the main checkout into each new worktree.
   * \`git worktree add\` never populates these.
   *
${p.comment}
   */
  provisionCopy: ${q(p.entries)},

  /**
   * What a finished slice must pass before it lands, in order. The dispatcher
   * re-runs these itself: "the agent said its gates were green" is not a check.
   *
   * EVERY GATE MUST BE READ-ONLY, and it is enforced — the runner checks
   * \`git status\` after each one and fails the land by name if a gate wrote
   * anything. The distinction is one word wide: \`check\` observes, \`--write\`
   * rewrites the tree it is judging and lands changes nobody reviewed.
   */
  gates: [
${testGate}

    /**
     * A plain exit code, ${type?.note ?? ""}
     */
    exitCode(${q(type?.cmd ?? [])}, {
      hint: "typecheck errors",
    }),

${lintGate}
  ],

  /**
   * Names the \`slice\` skill rather than issuing a lone slash command: it reads
   * correctly whether or not the first message is parsed as a command, and it
   * points at \`.slice-ticket.md\`, which the session cannot fetch for itself.
   */
  startPrompt:
    "Read .slice-ticket.md in this worktree — it is your ticket, #{n}. Follow the \`slice\` skill: build it, commit with explicit paths, run the gates, and run ./scripts/slice-done.sh only if they are green.",
} satisfies SliceConfig;
`;
}
