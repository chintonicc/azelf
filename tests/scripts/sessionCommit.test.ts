import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Consumer, git, makeConsumer, shResult } from "./fixture";

/**
 * session-commit.sh and the DB lock: a commit that touches an exclusive path
 * requires the claim, takes it when nobody holds it, and is refused — with
 * nothing staged and nothing committed — when another branch does.
 */
const LOCK_PATH = "supabase/migrations";

const commit = (cwd: string, msg: string, ...paths: string[]) =>
  shResult(
    cwd,
    `./scripts/session-commit.sh -y -m ${JSON.stringify(msg)} ${paths
      .map((p) => JSON.stringify(p))
      .join(" ")}`,
  );

describe("session-commit.sh under an exclusive path", () => {
  let c: Consumer;
  const migration = (n: number, name = `00${n}_x.sql`) => {
    writeFileSync(join(c.wt(n), LOCK_PATH, name), "-- sql\n");
    return `${LOCK_PATH}/${name}`;
  };

  beforeEach(() => {
    c = makeConsumer({ lockPaths: [LOCK_PATH], worktrees: [40, 44] });
  });
  afterEach(() => rmSync(c.root, { recursive: true, force: true }));

  it("takes the claim for a late claimer and commits", () => {
    const p = migration(40);
    const r = commit(c.wt(40), "feat: migration", p);
    expect(r.ok).toBe(true);
    expect(r.out).toContain("✓ DB lock claimed by ticket/40");
    expect(r.out).toContain("✓ committed:");
    expect(readFileSync(join(c.lockDir, "owner"), "utf8")).toContain(
      "branch=ticket/40\n",
    );
    expect(git(c.wt(40), "log", "--oneline", "main..HEAD")).toContain(
      "feat: migration",
    );
  });

  it("refuses, unstages and parks when another branch holds the lock", () => {
    expect(shResult(c.wt(44), "./scripts/db-lock.sh claim").ok).toBe(true);
    const p = migration(40);
    const r = commit(c.wt(40), "feat: migration", p);
    expect(r.ok).toBe(false);
    expect(r.out).toContain("the DB lock is not yours");
    expect(r.out).toContain(`${c.wt(44)} (ticket/44, holds the DB lock since `);
    expect(r.out).toContain('transfer 40 --reason "…"');
    expect(r.out).toContain("Nothing was committed");
    expect(r.out).not.toContain("--force");
    expect(git(c.wt(40), "diff", "--cached", "--name-only")).toBe("");
    expect(git(c.wt(40), "log", "--oneline", "main..HEAD")).toBe("");
    expect(existsSync(join(c.wt(40), ".slice-lock-wait"))).toBe(true);
    // The file itself is left alone: it is the agent's work, not the tool's.
    expect(existsSync(join(c.wt(40), p))).toBe(true);
  });

  it("does not touch the lock for a commit outside those paths", () => {
    expect(shResult(c.wt(44), "./scripts/db-lock.sh claim").ok).toBe(true);
    writeFileSync(join(c.wt(40), "a.txt"), "a\n");
    const r = commit(c.wt(40), "feat: a", "a.txt");
    expect(r.ok).toBe(true);
    expect(r.out).not.toContain("DB lock");
    expect(existsSync(join(c.wt(40), ".slice-lock-wait"))).toBe(false);
  });

  it("keeps committing for the owner when someone else skips the claim", () => {
    const first = migration(40, "001_a.sql");
    expect(commit(c.wt(40), "feat: a", first).ok).toBe(true);
    migration(44); // no claim, no commit — the protocol skipped
    const second = migration(40, "002_b.sql");
    const r = commit(c.wt(40), "feat: b", second);
    expect(r.ok).toBe(true);
    expect(r.out).toContain("already held by this worktree (ticket/40)");
    expect(r.out).toContain("without the claim");
    expect(r.out).toContain("✓ committed:");
  });
});

/**
 * session-commit.sh and ordinary git: a path `git rm` or `git mv` already
 * removed is in neither the worktree nor the index, and must still commit; a
 * run that is going to be refused must be refused before it stages anything.
 */
describe("session-commit.sh with removals, renames and no terminal", () => {
  let c: Consumer;
  let wt: string;
  beforeEach(() => {
    c = makeConsumer({ worktrees: [40] });
    wt = c.wt(40);
    mkdirSync(join(wt, "lib"));
    writeFileSync(join(wt, "lib", "a.txt"), "a\n");
    writeFileSync(join(wt, "old.txt"), "old\n");
    git(wt, "add", "lib", "old.txt");
    git(wt, "commit", "-qm", "files");
  });
  afterEach(() => rmSync(c.root, { recursive: true, force: true }));

  it("commits a file removed with git rm", () => {
    git(wt, "rm", "-q", "old.txt");
    const r = commit(wt, "chore: drop old", "old.txt");
    expect(r.out).toContain("✓ committed:");
    expect(r.ok).toBe(true);
    expect(git(wt, "show", "--name-status", "--format=", "HEAD")).toBe(
      "D\told.txt",
    );
  });

  it("commits a directory moved with git mv as a rename", () => {
    git(wt, "mv", "lib", "src");
    const r = commit(wt, "refactor: lib is src", "lib", "src");
    expect(r.out).toContain("✓ committed:");
    expect(r.ok).toBe(true);
    expect(git(wt, "show", "-M", "--name-status", "--format=", "HEAD")).toBe(
      "R100\tlib/a.txt\tsrc/a.txt",
    );
  });

  it("still refuses a path that matches nothing anywhere", () => {
    writeFileSync(join(wt, "new.txt"), "new\n");
    const r = commit(wt, "feat: new", "new.txt", "nwe.txt");
    expect(r.ok).toBe(false);
    expect(r.out).toContain("did not match any files");
    expect(git(wt, "log", "-1", "--format=%s")).toBe("files");
  });

  it("refuses without -y and without a terminal before staging anything", () => {
    writeFileSync(join(wt, "new.txt"), "new\n");
    const r = shResult(
      wt,
      './scripts/session-commit.sh -m "feat: new" new.txt',
    );
    expect(r.ok).toBe(false);
    expect(r.out).toContain("Pass -y to confirm");
    expect(r.out).toContain("Nothing was staged.");
    expect(git(wt, "diff", "--cached", "--name-only")).toBe("");
  });
});
