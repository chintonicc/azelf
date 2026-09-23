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
});
