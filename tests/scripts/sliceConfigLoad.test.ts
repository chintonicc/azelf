import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AZELF, git } from "./fixture";

/**
 * A repo that cannot take azelf as a dependency has no `@chintonicc/azelf` in
 * node_modules: a Python repo with no package.json, or an npm repo whose CI
 * runs `npm ci` against a lockfile that does not list it. It runs azelf from
 * a checkout, and its slice.config.ts still imports the package by name. The
 * loader failed there before the first ticket, with `Cannot find module`.
 * The other tests never load a config like that: fixture.ts writes the
 * absolute path to index.ts into theirs.
 */
let root: string;
let repo: string;
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "azelf-load-")));
  repo = join(root, "repo");
  mkdirSync(repo);
  git(repo, "init", "-q", "-b", "main");
  writeFileSync(join(repo, "pyproject.toml"), '[project]\nname = "x"\n');
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

/** A config that imports the package by name, with `head` as its imports. */
const writeConfig = (head: string, startPrompt = '"#{n}"') =>
  writeFileSync(
    join(repo, "slice.config.ts"),
    `${head}
export default {
  tracker: github(),
  baseBranch: "main",
  branchPattern: "ticket/{n}",
  worktreeDir: "../{repo}-ticket-{n}",
  readyLabel: "ready-for-agent",
  exclusiveLockPaths: [],
  provisionCopy: [],
  install: [],
  gates: [exitCode(["true"])],
  startPrompt: ${startPrompt},
} satisfies SliceConfig;
`,
  );

const NAMED = `import { exitCode, github } from "@chintonicc/azelf";
import type { SliceConfig } from '@chintonicc/azelf';`;

/** The shell bridge, run from the repo, with `env` on top. */
const bridge = (env: Record<string, string> = {}) => {
  const r = spawnSync(
    "bun",
    [join(AZELF, "scripts", "slice-config.ts"), "--sh"],
    {
      cwd: repo,
      encoding: "utf8",
      env: { ...process.env, SLICE_REPO_ROOT: repo, SLICE_CONFIG: "", ...env },
    },
  );
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
};

describe("a config that imports azelf by name, with no node_modules", () => {
  it("loads, in either quote style, value and type imports alike", () => {
    writeConfig(NAMED);

    const r = bridge();

    expect(r.out).not.toContain("Cannot find module");
    expect(r.code).toBe(0);
    expect(r.out).toContain("SLICE_BASE_BRANCH='main'");
    expect(r.out).toContain(
      "SLICE_INSTALL_WHY='install: [] in slice.config.ts'",
    );
  });

  it("reads the package.json of the azelf that is running", () => {
    writeConfig(
      `${NAMED}
import pkg from "@chintonicc/azelf/package.json";`,
      "`${pkg.name} #{n}`",
    );

    const r = bridge();

    expect(r.code).toBe(0);
    expect(r.out).toContain("SLICE_START_PROMPT='@chintonicc/azelf #{n}'");
  });

  /** Bun hands the loader the path with symlinks resolved. */
  it("loads through a symlinked path in SLICE_CONFIG", () => {
    writeConfig(NAMED);
    symlinkSync(repo, join(root, "link"));

    const r = bridge({ SLICE_CONFIG: join(root, "link", "slice.config.ts") });

    expect(r.out).not.toContain("Cannot find module");
    expect(r.code).toBe(0);
  });

  /** Only the two exports are pointed anywhere; the rest fails as it did. */
  it("still fails on a path the package does not export, and names it", () => {
    writeConfig(`${NAMED}
import { slug } from "@chintonicc/azelf/scripts/slice-gates";
void slug;`);

    const r = bridge();

    expect(r.code).not.toBe(0);
    expect(r.out).toContain("@chintonicc/azelf/scripts/slice-gates");
  });
});
