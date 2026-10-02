import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Consumer, git, makeConsumer, sh, shResult } from "./fixture";

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

/**
 * `--push` with no message and no paths pushes what is already committed:
 * the same lock, fetch and fast-forward check as a commit's push.
 */
describe("session-commit.sh --push alone", () => {
  let c: Consumer;
  const remoteLog = () =>
    git(join(c.root, "remote"), "log", "--format=%s", "main");
  const commitHere = (file: string, msg: string) => {
    writeFileSync(join(c.main, file), `${file}\n`);
    git(c.main, "add", file);
    git(c.main, "commit", "-qm", msg);
  };
  beforeEach(() => {
    c = makeConsumer({ remote: true });
  });
  afterEach(() => rmSync(c.root, { recursive: true, force: true }));

  it("pushes the commits that exist, and lists them first", () => {
    commitHere("a.txt", "feat: a");
    commitHere("b.txt", "feat: b");
    const r = shResult(c.main, "./scripts/session-commit.sh --push -y");
    expect(r.ok, r.out).toBe(true);
    expect(r.out).toMatch(/[0-9a-f]+ feat: b\n[0-9a-f]+ feat: a\n/);
    expect(r.out).toContain("✓ pushed to origin/main");
    expect(remoteLog()).toBe("feat: b\nfeat: a\ninit");
    expect(existsSync(join(c.main, ".git", "session-commit.lock"))).toBe(false);
  });

  it("refuses when the remote is ahead", () => {
    sh(
      c.root,
      `git clone -q remote other && cd other && git -c user.email=t@t -c user.name=t commit -q --allow-empty -m "feat: theirs" && git push -q origin main`,
    );
    commitHere("a.txt", "feat: a");
    const r = shResult(c.main, "./scripts/session-commit.sh --push -y");
    expect(r.ok).toBe(false);
    expect(r.out).toContain(
      "origin/main has commits you don't have — pull/rebase before pushing.",
    );
    expect(remoteLog()).toBe("feat: theirs\ninit");
  });

  it("exits 0 with nothing to push", () => {
    const r = shResult(c.main, "./scripts/session-commit.sh --push -y");
    expect(r.ok).toBe(true);
    expect(r.out).toContain("nothing to push — origin/main already has HEAD.");
  });

  it("refuses without -y and without a terminal, before fetching", () => {
    commitHere("a.txt", "feat: a");
    // A remote that cannot be fetched: reaching it would print git's error.
    git(c.main, "remote", "set-url", "origin", join(c.root, "nowhere"));
    const r = shResult(c.main, "./scripts/session-commit.sh --push");
    expect(r.ok).toBe(false);
    expect(r.out).toContain("Pass -y to confirm");
    expect(r.out).not.toContain("nowhere");
  });

  it("still wants a message when paths are named", () => {
    writeFileSync(join(c.main, "a.txt"), "a\n");
    const r = shResult(c.main, "./scripts/session-commit.sh --push -y a.txt");
    expect(r.ok).toBe(false);
    expect(r.out).toContain("-m/--message or -F/--file is required");
  });
});

describe("session-commit.sh -F", () => {
  let c: Consumer;
  const MESSAGE = "feat: a\n\nA body, over\ntwo lines.\n\n- and a list";
  beforeEach(() => {
    c = makeConsumer({});
    writeFileSync(join(c.main, "a.txt"), "a\n");
  });
  afterEach(() => rmSync(c.root, { recursive: true, force: true }));

  it("takes the message from a file, verbatim", () => {
    writeFileSync(join(c.root, "msg.txt"), `${MESSAGE}\n`);
    const r = shResult(
      c.main,
      "./scripts/session-commit.sh -y -F ../msg.txt a.txt",
    );
    expect(r.ok, r.out).toBe(true);
    expect(git(c.main, "log", "-1", "--format=%B")).toBe(MESSAGE);
  });

  it("takes it from stdin with -F -", () => {
    writeFileSync(join(c.root, "msg.txt"), `${MESSAGE}\n`);
    const r = shResult(
      c.main,
      "./scripts/session-commit.sh -y -F - a.txt < ../msg.txt",
    );
    expect(r.ok, r.out).toBe(true);
    expect(git(c.main, "log", "-1", "--format=%B")).toBe(MESSAGE);
  });

  it("-F - without -y is refused, with nothing staged", () => {
    const r = shResult(
      c.main,
      "echo msg | ./scripts/session-commit.sh -F - a.txt",
    );
    expect(r.ok).toBe(false);
    expect(r.out).toContain("pass -y");
    expect(git(c.main, "diff", "--cached", "--name-only")).toBe("");
  });

  it("-m and -F together is a usage error", () => {
    writeFileSync(join(c.root, "msg.txt"), "x\n");
    const r = shResult(
      c.main,
      './scripts/session-commit.sh -y -m "x" -F ../msg.txt a.txt || echo "exit=$?"',
    );
    expect(r.out).toContain("-m and -F are two messages");
    expect(r.out).toContain("exit=64");
  });

  it("a message file that is not there fails before anything is staged", () => {
    const r = shResult(
      c.main,
      "./scripts/session-commit.sh -y -F ../nope.txt a.txt",
    );
    expect(r.ok).toBe(false);
    expect(r.out).toContain("no such message file: ../nope.txt");
    expect(git(c.main, "diff", "--cached", "--name-only")).toBe("");
    expect(existsSync(join(c.main, ".git", "session-commit.lock"))).toBe(false);
  });
});
