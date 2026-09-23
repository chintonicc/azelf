import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

/**
 * A throwaway consumer checkout the shell scripts can run in for real: a git
 * repo with the shims, a `slice.config.ts`, optionally a bare `origin`, and
 * linked worktrees on `ticket/<n>` branches.
 *
 * Built by hand rather than through `init`, because `init`'s starter config
 * imports the package by name and a temp dir has no node_modules; this one
 * imports it by absolute path. The shims are the same one-liners `init` would
 * write, pointed at this checkout.
 *
 * The tracker is a fake that answers nothing and records every close into
 * `closeFile` as `<id>\n<comment>` — so a test can read back what a land wrote
 * to the ticket without a network, and `slice-land.sh`'s close step succeeds
 * instead of printing a gh error.
 */
export const AZELF = resolve(__dirname, "..", "..");

export const git = (cwd: string, ...args: string[]): string =>
  execFileSync(
    "git",
    ["-c", "user.email=t@t", "-c", "user.name=t", "-C", cwd, ...args],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  ).trim();

export const sh = (cwd: string, script: string): string =>
  execFileSync("bash", ["-c", `set -euo pipefail\n${script}`], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });

export type Consumer = {
  /** The temp dir everything lives under. */
  root: string;
  /** The main checkout, on `main`. */
  main: string;
  /** Where the fake tracker writes closes. */
  closeFile: string;
  /** A linked worktree's path, by ticket number. */
  wt: (n: number) => string;
};

export function makeConsumer(opts: {
  lockPaths?: string[];
  /** Ticket numbers to add worktrees for, on `ticket/<n>`. */
  worktrees?: number[];
  /** Add a bare `origin` with `main` pushed — slice-land.sh needs one. */
  remote?: boolean;
}): Consumer {
  // Resolved, because git prints worktree paths canonicalized and macOS's
  // tmpdir is a symlink.
  const root = realpathSync(mkdtempSync(join(tmpdir(), "azelf-fx-")));
  const main = join(root, "repo");
  const closeFile = join(root, "closes.txt");
  const lockPaths = opts.lockPaths ?? [];

  git(root, "init", "-q", "-b", "main", "repo");
  mkdirSync(join(main, "scripts"));
  for (const s of ["slice-config.sh", "db-lock-check.sh"]) {
    writeFileSync(
      join(main, "scripts", s),
      `source ${JSON.stringify(join(AZELF, "scripts", s))}\n`,
    );
  }
  for (const s of ["slice-done.sh", "slice-land.sh", "session-commit.sh"]) {
    writeFileSync(
      join(main, "scripts", s),
      `#!/usr/bin/env bash\nexec ${JSON.stringify(
        join(AZELF, "scripts", s),
      )} "$@"\n`,
      { mode: 0o755 },
    );
  }
  writeFileSync(
    join(main, "slice.config.ts"),
    `import { appendFileSync } from "node:fs";
import type { SliceConfig, Tracker } from ${JSON.stringify(
      join(AZELF, "index.ts"),
    )};
const tracker: Tracker = {
  name: "Fake",
  idPattern: "^[0-9]+$",
  refTemplate: "#{n}",
  listReady: () => [],
  get: (id) => ({ id, title: "t", state: "open", labels: [], url: "" }),
  blockers: () => [],
  body: () => "",
  close: (id, comment) =>
    appendFileSync(${JSON.stringify(closeFile)}, \`\${id}\\n\${comment}\\n\`),
};
export default {
  tracker,
  baseBranch: "main",
  branchPattern: "ticket/{n}",
  worktreeDir: "../{repo}-ticket-{n}",
  readyLabel: "ready",
  exclusiveLockPaths: ${JSON.stringify(lockPaths)},
  provisionCopy: [],
  gates: [],
  startPrompt: "x",
} satisfies SliceConfig;
`,
  );
  for (const p of lockPaths) {
    mkdirSync(join(main, p), { recursive: true });
    writeFileSync(join(main, p, ".keep"), "");
  }
  git(main, "add", "-A");
  git(main, "commit", "-qm", "init");

  if (opts.remote) {
    git(root, "init", "-q", "--bare", "remote");
    git(main, "remote", "add", "origin", join(root, "remote"));
    git(main, "push", "-q", "-u", "origin", "main");
  }

  const wt = (n: number) => join(root, `repo-ticket-${n}`);
  for (const n of opts.worktrees ?? []) {
    git(main, "worktree", "add", "-q", wt(n), "-b", `ticket/${n}`);
  }
  return { root, main, closeFile, wt };
}
