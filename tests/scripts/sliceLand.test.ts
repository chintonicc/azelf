import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type Consumer,
  git,
  makeConsumer,
  sh,
  shResult,
  startScript,
} from "./fixture";

/**
 * slice-done.sh and slice-land.sh, end to end against a real repo with a bare
 * origin: the ticket close comment must carry the commit the slice declared
 * done at AND the commit it landed as, because the two differ whenever the
 * branch was rebased in between — and that is the normal case.
 */
describe("slice-done.sh → slice-land.sh", () => {
  let c: Consumer;
  beforeEach(() => {
    c = makeConsumer({ worktrees: [40], remote: true });
  });
  afterEach(() => rmSync(c.root, { recursive: true, force: true }));

  it("records the declared and the landed SHA on the ticket", () => {
    const wt = c.wt(40);
    writeFileSync(join(wt, "a.txt"), "a\n");
    git(wt, "add", "a.txt");
    git(wt, "commit", "-qm", "feat: a");
    const declared = git(wt, "rev-parse", "HEAD");

    const done = sh(wt, "./scripts/slice-done.sh");
    expect(done).toContain("marked done (1 commit(s) to land)");
    const marker = readFileSync(join(wt, ".slice-ready-to-land"), "utf8");
    expect(marker.split("\n")[1]).toBe(declared);

    // Base moves, and the branch is rebased onto it — what the dispatcher does
    // before every land. The declared commit is rewritten by this.
    writeFileSync(join(c.main, "b.txt"), "b\n");
    git(c.main, "add", "b.txt");
    git(c.main, "commit", "-qm", "feat: b");
    git(c.main, "push", "-q", "origin", "main");
    git(wt, "rebase", "-q", "main");
    expect(git(wt, "rev-parse", "HEAD")).not.toBe(declared);

    const land = sh(c.main, "./scripts/slice-land.sh 40");
    const landed = git(c.main, "rev-parse", "HEAD");
    const short = (sha: string) => sha.slice(0, 7);

    const line = `declared done at ${short(
      declared,
    )}, landed on main as ${short(landed)} (1 commit(s))`;
    expect(land).toContain(`✓ ${line}`);
    expect(land).toContain("✓ closed #40");
    // Closed before the cleanup: an interrupted removal must not leave the
    // ticket open and its dependents blocked.
    expect(land.indexOf("✓ closed #40")).toBeLessThan(
      land.indexOf("── cleaning up"),
    );
    expect(readFileSync(c.closeFile, "utf8")).toContain(`40\n`);
    expect(readFileSync(c.closeFile, "utf8")).toContain(line);

    // The recorded landed SHA is the one a later ancestry check says yes to;
    // the declared one is not, which is the whole reason both are recorded.
    expect(() =>
      git(c.main, "merge-base", "--is-ancestor", landed, "main"),
    ).not.toThrow();
    expect(() =>
      git(c.main, "merge-base", "--is-ancestor", declared, "main"),
    ).toThrow();
    // A land that finished leaves nothing to finish.
    expect(existsSync(join(c.main, ".git", "azelf-landed-40.txt"))).toBe(false);
  });

  it("still lands, and says so, when nobody declared done", () => {
    const wt = c.wt(40);
    writeFileSync(join(wt, "a.txt"), "a\n");
    git(wt, "add", "a.txt");
    git(wt, "commit", "-qm", "feat: a");
    const head = git(wt, "rev-parse", "HEAD");

    const land = sh(c.main, "./scripts/slice-land.sh 40");
    expect(land).toContain(
      `✓ landed on main as ${head.slice(0, 7)} (1 commit(s))`,
    );
    expect(land).not.toContain("declared done at");
  });
});

/**
 * The DB lock across a land: a slice that claimed it (through
 * session-commit.sh) holds it until this moment, and this is where it is
 * released — from the main checkout, never fatally.
 */
describe("slice-land.sh and the DB lock", () => {
  const LOCK_PATH = "supabase/migrations";
  let c: Consumer;
  beforeEach(() => {
    c = makeConsumer({
      lockPaths: [LOCK_PATH],
      worktrees: [40],
      remote: true,
    });
  });
  afterEach(() => rmSync(c.root, { recursive: true, force: true }));

  it("releases the lock the slice held, once its migration is on base", () => {
    const wt = c.wt(40);
    writeFileSync(join(wt, LOCK_PATH, "001_a.sql"), "-- sql\n");
    const commit = sh(
      wt,
      `./scripts/session-commit.sh -y -m "feat: migration" ${LOCK_PATH}/001_a.sql`,
    );
    expect(commit).toContain("✓ DB lock claimed by ticket/40");
    sh(wt, "./scripts/slice-done.sh");

    const land = sh(c.main, "./scripts/slice-land.sh 40");
    expect(land).toContain("✓ DB lock released — ticket/40 landed");
    expect(land).toContain("✓ closed #40");
    expect(existsSync(c.lockDir)).toBe(false);
    expect(sh(c.main, "./scripts/db-lock.sh status")).toContain(
      "DB lock: free",
    );
    expect(readFileSync(c.lockLog, "utf8")).toMatch(
      /\tclaim\tticket\/40\t[\s\S]*\trelease\tticket\/40\tlanded\t/,
    );
  });

  it("says so when a landed migration never held the lock", () => {
    const wt = c.wt(40);
    writeFileSync(join(wt, LOCK_PATH, "001_a.sql"), "-- sql\n");
    git(wt, "add", `${LOCK_PATH}/001_a.sql`);
    git(wt, "commit", "-qm", "feat: migration, raw git");

    const land = sh(c.main, "./scripts/slice-land.sh 40");
    expect(land).toContain("✓ closed #40");
    expect(land).toContain("without ever holding the DB lock");
    expect(land).toContain("it skipped the claim");
  });

  it("leaves another branch's lock alone, and lands anyway", () => {
    // A second worktree holds the lock; #40 lands unrelated work.
    git(c.main, "worktree", "add", "-q", c.wt(44), "-b", "ticket/44");
    sh(c.wt(44), "./scripts/db-lock.sh claim");
    const wt = c.wt(40);
    writeFileSync(join(wt, "a.txt"), "a\n");
    git(wt, "add", "a.txt");
    git(wt, "commit", "-qm", "feat: a");

    const land = sh(c.main, "./scripts/slice-land.sh 40");
    expect(land).toContain("✓ closed #40");
    expect(land).not.toContain("DB lock");
    expect(existsSync(c.lockDir)).toBe(true);
  });
});

/**
 * The land lock: one `slice-land.sh` at a time per repo, whoever runs it.
 * Two dispatchers on consumer-a landed five slices onto one master in one
 * main checkout with nothing between them, and a hand land raced them too.
 */
describe("slice-land.sh and the land lock", () => {
  let c: Consumer;
  let lock: string;
  const commitIn = (n: number) => {
    const wt = c.wt(n);
    writeFileSync(join(wt, `${n}.txt`), `${n}\n`);
    git(wt, "add", `${n}.txt`);
    git(wt, "commit", "-qm", `feat: ${n}`);
  };
  beforeEach(() => {
    c = makeConsumer({ worktrees: [40, 41], remote: true });
    lock = join(c.main, ".git", "azelf-land.lock");
    commitIn(40);
    commitIn(41);
  });
  afterEach(() => rmSync(c.root, { recursive: true, force: true }));

  it("makes a second land wait for the first, which it then refuses as diverged — never a git lock error", async () => {
    // A pre-push hook that holds the first land open until the test says go:
    // by then it has fast-forwarded main and is pushing, which is the window
    // two unlocked lands collided in.
    const go = join(c.root, "go");
    writeFileSync(
      join(c.main, ".git", "hooks", "pre-push"),
      `#!/usr/bin/env bash\nwhile [ ! -f ${go} ]; do sleep 0.1; done\n`,
      { mode: 0o755 },
    );
    const first = startScript(c.main, "./scripts/slice-land.sh 40");
    try {
      await first.until("pushing main");
      const second = startScript(c.main, "./scripts/slice-land.sh 41");
      try {
        await second.until(/waiting for ticket\/40's land \(pid \d+, since /);
        expect(second.output()).not.toContain("fast-forwarding");

        writeFileSync(go, "");
        expect(await first.exited).toBe(0);
        expect(await second.exited).toBe(1);
      } finally {
        await second.stop();
      }
      expect(first.output()).toContain("✓ closed #40");
      expect(second.output()).toContain("can't fast-forward onto ticket/41");
      expect(second.output()).toContain("it has diverged");
      for (const out of [first.output(), second.output()]) {
        expect(out).not.toMatch(/index\.lock|Unable to create/);
      }
    } finally {
      writeFileSync(go, "");
      await first.stop();
    }
    // The refusal released it too.
    expect(existsSync(lock)).toBe(false);
  }, 60_000);

  it("takes the lock over from a land that died holding it, and lands", () => {
    const dead = Number(
      spawnSync("bash", ["-c", "echo $$"], { encoding: "utf8" }).stdout.trim(),
    );
    mkdirSync(lock);
    writeFileSync(
      join(lock, "owner"),
      `pid=${dead}\nstarted=\nlabel=ticket/39\nsince=2026-09-23T10:00:00.000Z\n`,
    );
    const land = sh(c.main, "./scripts/slice-land.sh 40");
    expect(land).toContain(
      `took over the land lock from ticket/39 (pid ${dead}) — that process is no longer running`,
    );
    expect(land).toContain("✓ closed #40");
    expect(existsSync(lock)).toBe(false);
  });

  it("is not taken by a land that is refused before it", () => {
    // A live holder, which a refused land must never wait on: the branch
    // check comes first.
    mkdirSync(lock);
    writeFileSync(
      join(lock, "owner"),
      `pid=${process.pid}\nstarted=\nlabel=ticket/39\nsince=2026-09-23T10:00:00.000Z\n`,
    );
    const r = shResult(c.main, "./scripts/slice-land.sh 77");
    expect(r.ok).toBe(false);
    expect(r.out).toContain("no local branch 'ticket/77'");
    expect(r.out).not.toContain("waiting for");
    expect(readFileSync(join(lock, "owner"), "utf8")).toContain("ticket/39");
  });

  it("is not waited on by a land of a held ticket, which git will not remove either", () => {
    mkdirSync(lock);
    writeFileSync(
      join(lock, "owner"),
      `pid=${process.pid}\nstarted=\nlabel=ticket/39\nsince=2026-09-23T10:00:00.000Z\n`,
    );
    git(
      c.main,
      "worktree",
      "lock",
      "--reason",
      `azelf hold: the re-port session since ${new Date().toISOString()} — re-porting onto #39`,
      c.wt(40),
    );

    const r = shResult(c.main, "./scripts/slice-land.sh 40");

    expect(r.code).toBe(1);
    expect(r.out).toMatch(
      /error: #40 is held by the re-port session since \d\d:\d\d \(re-porting onto #39\) — azelf release 40 first\./,
    );
    expect(r.out).not.toContain("waiting for");
    expect(git(c.main, "log", "-1", "--format=%s")).toBe("init");
    expect(() =>
      git(c.main, "worktree", "remove", "--force", c.wt(40)),
    ).toThrow();
    expect(existsSync(c.wt(40))).toBe(true);
  });
});

/**
 * A land interrupted after its push: the work is public, the ticket open, and
 * the worktree or the branch may be half gone. The record slice-land.sh writes
 * after the push is what a second run finishes from. A close that fails stands
 * in for the interruption here — the record stays for the same reason.
 */
describe("finishing a land that was interrupted after the push", () => {
  let c: Consumer;
  const record = () => join(c.main, ".git", "azelf-landed-40.txt");
  const closes = () =>
    existsSync(c.closeFile) ? readFileSync(c.closeFile, "utf8") : "";
  /** Lands 40 with its close failing; returns the landed head. */
  const interrupted = (leave?: string) => {
    const wt = c.wt(40);
    writeFileSync(join(wt, "a.txt"), "a\n");
    writeFileSync(join(wt, "b.txt"), "b\n");
    git(wt, "add", "a.txt", "b.txt");
    git(wt, "commit", "-qm", "feat: a and b");
    // Something untracked makes the plain removal refuse, so the worktree
    // stays for the test to cut into.
    if (leave) writeFileSync(join(wt, leave), "x\n");
    c.closeFails(true);
    const land = shResult(c.main, "./scripts/slice-land.sh 40");
    expect(land.out).toContain("couldn't close #40");
    expect(existsSync(record())).toBe(true);
    c.closeFails(false);
    return git(c.main, "rev-parse", "HEAD");
  };
  beforeEach(() => {
    c = makeConsumer({ worktrees: [40], remote: true });
  });
  afterEach(() => rmSync(c.root, { recursive: true, force: true }));

  it("closes the ticket with the saved comment and removes a half-deleted worktree", () => {
    const head = interrupted("scratch.log");
    const wt = c.wt(40);
    expect(existsSync(wt)).toBe(true);
    // The removal got as far as two files.
    rmSync(join(wt, "scratch.log"));
    rmSync(join(wt, "a.txt"));

    const land = sh(c.main, "./scripts/slice-land.sh 40");

    expect(land).toContain(
      `── finishing the land of #40 — it pushed as ${head.slice(0, 7)} at `,
    );
    expect(land).toContain("✓ closed #40");
    expect(land).toContain(
      "its interrupted removal had already deleted part of it",
    );
    expect(land).toContain(`✓ removed worktree ${wt}`);
    expect(land).toContain("✓ deleted local branch ticket/40");
    expect(land).toContain("✓ finished the land of #40");
    expect(land).not.toContain("fast-forwarding");
    expect(closes()).toContain(
      `40\nLanded on main via slice-land.sh.\n\nlanded on main as ${head.slice(
        0,
        7,
      )} (1 commit(s))`,
    );
    expect(existsSync(wt)).toBe(false);
    expect(git(c.main, "branch", "--list", "ticket/40")).toBe("");
    expect(existsSync(record())).toBe(false);
  });

  it("finishes one whose branch is already gone", () => {
    interrupted();
    expect(git(c.main, "branch", "--list", "ticket/40")).toBe("");

    const land = sh(c.main, "./scripts/slice-land.sh 40");

    expect(land).toContain("── finishing the land of #40");
    expect(land).not.toContain("no local branch");
    expect(land).toContain("✓ closed #40");
    expect(existsSync(record())).toBe(false);
  });

  it("closes the ticket but leaves a worktree with a modified file", () => {
    interrupted("scratch.log");
    const wt = c.wt(40);
    rmSync(join(wt, "scratch.log"));
    writeFileSync(join(wt, "a.txt"), "changed after the land\n");

    const land = sh(c.main, "./scripts/slice-land.sh 40");

    expect(land).toContain("✓ closed #40");
    expect(land).toContain(
      `left ${wt} in place — it has modified or untracked files`,
    );
    expect(readFileSync(join(wt, "a.txt"), "utf8")).toBe(
      "changed after the land\n",
    );
    expect(existsSync(record())).toBe(false);
  });

  it("leaves a worktree git can no longer read, and says how to remove it", () => {
    const head = interrupted("scratch.log");
    const wt = c.wt(40);
    rmSync(join(wt, ".git"));

    const land = sh(c.main, "./scripts/slice-land.sh 40");

    expect(land).toContain("✓ closed #40");
    expect(land).toContain(
      `left ${wt} — git can no longer read it (its removal was interrupted).`,
    );
    expect(land).toContain(
      `Everything in it landed as ${head.slice(
        0,
        7,
      )}; delete the directory and run git worktree prune.`,
    );
    expect(existsSync(join(wt, "a.txt"))).toBe(true);
  });

  it("refuses, and changes nothing, when origin does not have what the record says landed", () => {
    interrupted();
    const stray = git(
      c.main,
      "commit-tree",
      "HEAD^{tree}",
      "-m",
      "never pushed",
    );
    writeFileSync(
      record(),
      readFileSync(record(), "utf8").replace(/^landed \w+/m, `landed ${stray}`),
    );

    const land = shResult(c.main, "./scripts/slice-land.sh 40");

    expect(land.ok).toBe(false);
    expect(land.out).toContain("but origin/main does not contain it");
    expect(closes()).toBe("");
    expect(existsSync(record())).toBe(true);
  });
});
