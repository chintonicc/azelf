import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

/**
 * `db_lock_holder`, driven the way its callers drive it: sourced into bash
 * inside a real consumer checkout, with real linked worktrees.
 *
 * The consumer is built by hand rather than through `init`, because `init`'s
 * starter config imports the package by name and a temp dir has no
 * node_modules; this one imports it by absolute path. The shims are the same
 * one-liners `init` would write, pointed at this checkout.
 */
const AZELF = resolve(__dirname, "..", "..");
const LOCK_PATH = "supabase/migrations";

const sh = (cwd: string, script: string): string =>
  execFileSync("bash", ["-c", `set -euo pipefail\n${script}`], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });

const git = (cwd: string, ...args: string[]): string =>
  execFileSync(
    "git",
    ["-c", "user.email=t@t", "-c", "user.name=t", "-C", cwd, ...args],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  ).trim();

/** The holder text, or "" when free — exactly what `holder=$(…) || true` yields. */
const holder = (cwd: string, exclude: string): string =>
  sh(
    cwd,
    `source scripts/db-lock-check.sh; db_lock_holder ${JSON.stringify(
      exclude,
    )} || true`,
  ).trim();

describe("db_lock_holder, across real worktrees", () => {
  let root: string;
  let main: string;
  const wt = (n: number) => join(root, `repo-ticket-${n}`);
  const dirty = (n: number) =>
    writeFileSync(join(wt(n), LOCK_PATH, `00${n}_x.sql`), "-- sql\n");

  beforeEach(() => {
    // Resolved, because git prints worktree paths canonicalized and macOS's
    // tmpdir is a symlink.
    root = realpathSync(mkdtempSync(join(tmpdir(), "azelf-dblock-")));
    main = join(root, "repo");
    git(root, "init", "-q", "-b", "main", "repo");
    mkdirSync(join(main, "scripts"));
    mkdirSync(join(main, LOCK_PATH), { recursive: true });
    for (const s of ["slice-config.sh", "db-lock-check.sh"]) {
      writeFileSync(
        join(main, "scripts", s),
        `source ${JSON.stringify(join(AZELF, "scripts", s))}\n`,
      );
    }
    writeFileSync(
      join(main, "slice.config.ts"),
      `import { type SliceConfig, github } from ${JSON.stringify(
        join(AZELF, "index.ts"),
      )};
export default {
  tracker: github(),
  baseBranch: "main",
  branchPattern: "ticket/{n}",
  worktreeDir: "../{repo}-ticket-{n}",
  readyLabel: "ready",
  exclusiveLockPaths: [${JSON.stringify(LOCK_PATH)}],
  provisionCopy: [],
  gates: [],
  startPrompt: "x",
} satisfies SliceConfig;
`,
    );
    writeFileSync(join(main, LOCK_PATH, ".keep"), "");
    git(main, "add", "-A");
    git(main, "commit", "-qm", "init");
    for (const n of [40, 44]) {
      git(main, "worktree", "add", "-q", wt(n), "-b", `ticket/${n}`);
    }
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("is free while nobody touches an exclusive path", () => {
    expect(holder(wt(40), "ticket/40")).toBe("");
  });

  it("names the one other worktree that does, and nothing more", () => {
    dirty(44);
    const out = holder(wt(40), "ticket/40");
    expect(out).toBe(`${wt(44)} (ticket/44, dirty)`);
  });

  /**
   * The case that stranded two slices: each side saw the other as holder and
   * was told to wait for it. The text must now say that waiting cannot work.
   */
  it("diagnoses the mutual case when the caller is dirty too", () => {
    dirty(40);
    dirty(44);
    const out = holder(wt(40), "ticket/40");
    expect(out).toContain(`${wt(44)} (ticket/44, dirty)`);
    expect(out).toContain("and this worktree — ticket/40 — is dirty");
    expect(out).toContain("2 worktrees hold uncommitted changes");
    expect(out).toContain("does NOT clear by waiting");
    expect(out).toContain(`git stash push -- ${LOCK_PATH}`);
  });

  /** The dispatcher excludes nobody; it should still see that two are stuck. */
  it("diagnoses the mutual case from outside, listing every holder", () => {
    dirty(40);
    dirty(44);
    const out = holder(main, "");
    expect(out).toContain(`${wt(40)} (ticket/40, dirty)`);
    expect(out).toContain(`${wt(44)} (ticket/44, dirty)`);
    expect(out).toContain("2 worktrees hold uncommitted changes");
  });

  it("does not raise the alarm for a single holder seen from outside", () => {
    dirty(44);
    expect(holder(main, "")).not.toContain("⚠️");
  });

  /**
   * Fails closed, and the failure wins over the diagnosis: a worktree whose
   * directory is gone cannot be scanned, so nothing about the scan is trusted.
   */
  it("reports an unverifiable worktree instead of diagnosing anything", () => {
    dirty(40);
    dirty(44);
    rmSync(wt(44), { recursive: true, force: true });
    const out = holder(wt(40), "ticket/40");
    expect(out).toContain("UNVERIFIABLE");
    expect(out).not.toContain("⚠️");
  });
});
