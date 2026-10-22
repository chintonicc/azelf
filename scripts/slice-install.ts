/**
 * The install step of a slice worktree: what runs after a prep, and again after
 * a rebase that brought a new manifest or lockfile from the base branch.
 *
 *   import { installFor } from "./slice-install";
 *   installFor(config.install, worktree, "prep")   # → { argv, why }
 *
 * WHY THIS IS NOT `bun install`
 * -----------------------------
 * It was, unconditionally, in both places — slice-session.sh after the prep and
 * slice-run.ts after a rebase. That was right for the project this was extracted
 * from (a bun project) and wrong for the next two:
 *
 *  - A Python repo has no package.json. `bun install` there exits 1 ("could not
 *    find a package.json file to install from"), and slice-session.sh read that
 *    as a failed prep: every session in that repo died before its ticket was
 *    written.
 *  - An npm repo has package-lock.json and no bun.lock. `bun install` migrates
 *    the lockfile and writes a bun.lock the repo does not track, so the worktree
 *    was dirty before the agent typed a character — slice-done.sh refuses a dirty
 *    tree — and the dependencies it resolved were not the ones `npm ci` would
 *    have, so the gates judged a tree the CI never sees.
 *
 * So the lockfile decides, and the consumer can say otherwise in `install`.
 * A `package.json` with no lockfile at all still gets bun: it is the one tool
 * azelf already requires on PATH, where npm, pnpm and yarn may not be there.
 * It gets the frozen form in both phases, because it has no lockfile to keep
 * and the plain one would write one.
 *
 * TWO PHASES, ONE RULE
 * --------------------
 * At `prep` the worktree was just cut from the base, so its lockfile is the one
 * that was reviewed and an install may not rewrite it — but bun's plain install
 * on a lockfile that already matches writes nothing, and that is the command the
 * extracted project always ran. After a `reinstall` the lockfile came from the
 * base and the gates are about to judge the tree, so bun gets `--frozen-lockfile`
 * there, which is what it had before. `npm ci`, `pnpm --frozen-lockfile` and
 * `yarn --frozen-lockfile` are frozen by construction and the same in both.
 * A configured `install` is used as given in both phases: the consumer knows.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";

export type InstallPhase = "prep" | "reinstall";

/** The command, and where it came from — for the line the prep prints. */
export type InstallChoice = {
  /** argv; `[]` means there is nothing to install. */
  argv: string[];
  why: string;
};

/**
 * The files whose change on the base means a worktree's install is stale: the
 * manifest, and every lockfile a package manager this file knows would read.
 */
export const INSTALL_MANIFESTS: ReadonlySet<string> = new Set([
  "package.json",
  "bun.lock",
  "bun.lockb",
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
]);

/** What the lockfile in `dir` says, for `phase`. */
export function detectInstall(dir: string, phase: InstallPhase): InstallChoice {
  const at = (f: string): boolean => existsSync(join(dir, f));
  if (!at("package.json")) {
    return { argv: [], why: "no package.json — nothing to install" };
  }
  if (at("bun.lock") || at("bun.lockb")) {
    return {
      argv:
        phase === "prep"
          ? ["bun", "install"]
          : ["bun", "install", "--frozen-lockfile"],
      why: at("bun.lock") ? "bun.lock" : "bun.lockb",
    };
  }
  if (at("pnpm-lock.yaml")) {
    return {
      argv: ["pnpm", "install", "--frozen-lockfile"],
      why: "pnpm-lock.yaml",
    };
  }
  if (at("yarn.lock")) {
    return { argv: ["yarn", "install", "--frozen-lockfile"], why: "yarn.lock" };
  }
  if (at("package-lock.json")) {
    return { argv: ["npm", "ci"], why: "package-lock.json" };
  }
  // Frozen in both phases. With no lockfile at all it installs and writes no
  // lockfile (bun 1.3.5). The plain form wrote a bun.lock that git does not
  // track, so the prep left a dirty worktree, which slice-done.sh refuses, and
  // the reinstall changed the tree the gates were about to judge.
  return {
    argv: ["bun", "install", "--frozen-lockfile"],
    why: "package.json without a lockfile — bun, which azelf already requires",
  };
}

/**
 * The install step for a worktree: the consumer's `install` when it is set
 * (`[]` included — that is "install nothing", said on purpose), else what the
 * lockfile in `dir` says.
 */
export function installFor(
  configured: string[] | undefined,
  dir: string,
  phase: InstallPhase,
): InstallChoice {
  if (configured !== undefined) {
    return {
      argv: [...configured],
      why:
        configured.length > 0
          ? "install in slice.config.ts"
          : "install: [] in slice.config.ts",
    };
  }
  return detectInstall(dir, phase);
}

/** `npm ci`, for a message. */
export const installName = (argv: string[]): string => argv.join(" ");
