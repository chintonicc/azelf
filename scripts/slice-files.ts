/**
 * The files `azelf init` puts into a consumer's repo, as one list, because two
 * halves of azelf need it: `slice-init.ts` writes them, and the prep
 * (`slice-session.sh`, through the config bridge) carries them into every
 * slice worktree the main checkout has them in and the worktree does not.
 *
 * WHY THE PREP NEEDS THE LIST
 * ---------------------------
 * `git worktree add` populates tracked files only. A consumer that commits the
 * shims (the README's advice) never notices. consumer-b keeps every one of
 * them untracked, in `.git/info/exclude`, and carried them into worktrees by
 * naming each in `provisionCopy` — a list copied by hand from this one, in
 * October 2026, when it was eight shims long. Two were added here since
 * (`slice-gates.sh`, `slice-push-main.sh`); `azelf init` wrote them into the
 * main checkouts, and the consumer's list did not move. Ten sessions in one
 * day found `./scripts/slice-gates.sh: no such file or directory` and went
 * looking for the package's copy by hand. A list a consumer copies drifts;
 * the prep reads this one instead.
 *
 * `slice.config.ts` is NOT here, on purpose: whether sessions may read it is
 * the consumer's decision (`provisionCopy`), and the shims read it from the
 * main checkout without a copy.
 */

/**
 * A shim in the consumer's `scripts/`: a few lines that find the package and
 * run (or source) the real file there.
 *
 * `source` vs `exec` is not a style choice: slice-config.sh and
 * db-lock-check.sh export variables and define functions into the CALLER's
 * shell, so running them in a subshell would leave the caller with nothing.
 *
 * `target` is what the shim runs, relative to the package root; left out, it
 * is `scripts/<name>`. `via: "bun"` runs a TypeScript target through bun
 * rather than executing it — the launcher, whose target is the CLI.
 */
export type Shim = {
  name: string;
  how: "source" | "exec";
  target?: string;
  via?: "bun";
};

/**
 * The scripts a consumer calls by name, and how.
 *
 * `azelf`, the launcher, is last and is the one that is not a `.sh`: it is
 * what `./scripts/azelf run --plan` runs. It exists because `bunx azelf` is a
 * trap in a repo without `node_modules/.bin/azelf` — a Python repo, an npm
 * repo whose lockfile cannot list this package: bunx finds no local binary
 * and asks the registry, where the name `azelf` belongs to something else.
 * On consumer-b that downloaded a stranger's package on the way to "could
 * not determine executable to run". The launcher resolves the package by the
 * same rule as every other shim and can reach nothing but it.
 */
export const SHIMS: Shim[] = [
  { name: "slice-config.sh", how: "source" },
  { name: "db-lock-check.sh", how: "source" },
  { name: "db-lock.sh", how: "exec" },
  { name: "slice-session.sh", how: "exec" },
  { name: "slice-land.sh", how: "exec" },
  { name: "slice-done.sh", how: "exec" },
  { name: "slice-finished.sh", how: "exec" },
  { name: "session-commit.sh", how: "exec" },
  { name: "format.sh", how: "exec" },
  { name: "slice-gates.sh", how: "exec" },
  { name: "slice-on-base.sh", how: "exec" },
  { name: "slice-push-main.sh", how: "exec" },
  { name: "azelf", how: "exec", target: "bin/azelf.ts", via: "bun" },
];

/** What a shim runs, relative to the package root. */
export const shimTarget = (s: Shim): string => s.target ?? `scripts/${s.name}`;

/**
 * The prompt-shaped half: the `/azelf` command and the slice skill. `from` is
 * the path in this package, `to` the path in the consumer's repo.
 */
export const AGENT_FILES: { from: string[]; to: string[] }[] = [
  {
    from: ["agent", "commands", "azelf.md"],
    to: [".claude", "commands", "azelf.md"],
  },
  {
    from: ["agent", "skills", "slice", "SKILL.md"],
    to: [".claude", "skills", "slice", "SKILL.md"],
  },
];

/**
 * Every file above as a path relative to the consumer's root — what the prep
 * copies into a worktree when the main checkout has it and the worktree does
 * not. In the order init writes them, so the prep's output reads like init's.
 */
export function azelfFiles(): string[] {
  return [
    ...SHIMS.map((s) => `scripts/${s.name}`),
    ...AGENT_FILES.map((f) => f.to.join("/")),
  ];
}
