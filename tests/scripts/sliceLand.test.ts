import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { landLockDir } from "@/scripts/slice-lock";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  AZELF,
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
 * A slice only a person can get further hands itself over. On consumer-a one
 * session stopped on a confirmation prompt nobody was there to answer, and
 * one on a sign-in that needed a browser. Both sat idle in their tabs, and the
 * run waited on them and said nothing.
 */
describe("slice-done.sh --hand-over", () => {
  let c: Consumer;
  beforeEach(() => {
    c = makeConsumer({ worktrees: [40] });
  });
  afterEach(() => rmSync(c.root, { recursive: true, force: true }));

  /** Git's own list, with `-z` so the reason's `—` is not C-quoted. */
  const locked = () => git(c.main, "worktree", "list", "--porcelain", "-z");

  it("holds a dirty worktree with no commits for its session, and marks it not finished", () => {
    const wt = c.wt(40);
    writeFileSync(join(wt, "a.txt"), "half\n");
    writeFileSync(join(wt, ".slice-live"), "4242\n");

    const r = shResult(wt, './scripts/slice-done.sh --hand-over "sign in"');

    expect(r.code, r.out).toBe(0);
    expect(locked()).toMatch(
      /\0locked azelf hold: its session since \d{4}-\d\d-\d\dT\S+ — sign in\0/,
    );
    expect(readFileSync(join(wt, ".slice-interrupted"), "utf8")).toBe("4242\n");
    expect(existsSync(join(wt, ".slice-ready-to-land"))).toBe(false);
    expect(readFileSync(join(wt, ".slice-live"), "utf8")).toBe("4242\n");
    expect(r.out).toContain(
      "✓ held #40 for its session — nothing lands, relaunches or removes it until azelf release 40",
    );
    expect(r.out.trimEnd()).toMatch(
      /end your turn — a person takes it from here$/,
    );
  });

  it("refuses an empty reason with 64, and holds nothing", () => {
    const wt = c.wt(40);
    for (const why of ['""', '"  "', ""]) {
      const r = shResult(wt, `./scripts/slice-done.sh --hand-over ${why}`);
      expect(r.code, why).toBe(64);
      expect(r.out).toContain("--hand-over needs what a person has to do");
    }
    expect(locked()).not.toContain("locked");
    expect(existsSync(join(wt, ".slice-interrupted"))).toBe(false);
  });

  it("refuses a worktree that is already held, and names the hold", () => {
    const wt = c.wt(40);
    git(c.main, "worktree", "lock", "--reason", "bisecting", wt);

    const r = shResult(wt, './scripts/slice-done.sh --hand-over "sign in"');

    expect(r.code).toBe(1);
    expect(r.out).toContain(
      `#40 is already locked in git (bisecting) — git worktree unlock ${wt} first`,
    );
    expect(existsSync(join(wt, ".slice-interrupted"))).toBe(false);
  });

  /** Today a typo marks the slice done, and under --auto that lands it. */
  it("refuses an argument it does not know, and marks nothing done", () => {
    const wt = c.wt(40);
    writeFileSync(join(wt, "a.txt"), "a\n");
    git(wt, "add", "a.txt");
    git(wt, "commit", "-qm", "feat: a");

    const r = shResult(wt, './scripts/slice-done.sh --handover "sign in"');

    expect(r.code).toBe(64);
    expect(r.out).toContain("unknown argument: --handover");
    expect(existsSync(join(wt, ".slice-ready-to-land"))).toBe(false);
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
    lock = landLockDir(c.main);
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
        expect(await second.exited).toBe(75);
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
 * A command after every land. consumer-b deploys from main, and under --auto
 * nobody checked the deploy before the next slice landed on top of it. It runs
 * last, in the main checkout, under the land lock; a failure leaves the land
 * as it is and exits 3.
 */
describe("slice-land.sh and afterLand", () => {
  let c: Consumer;
  const commitIn = (n: number) => {
    const wt = c.wt(n);
    writeFileSync(join(wt, `${n}.txt`), `${n}\n`);
    git(wt, "add", `${n}.txt`);
    git(wt, "commit", "-qm", `feat: ${n}`);
  };
  const consumer = (script: string) => {
    c = makeConsumer({
      worktrees: [40, 41],
      remote: true,
      configExtra: `afterLand: ["bash", "-c", ${JSON.stringify(script)}],`,
    });
    commitIn(40);
    commitIn(41);
  };
  afterEach(() => rmSync(c.root, { recursive: true, force: true }));

  it("runs after the push and the close, in the main checkout, with the ticket and the landed head", () => {
    consumer(
      'echo "$PWD|$SLICE_TICKET|$SLICE_LANDED_HEAD|$(git rev-parse origin/main)|$(cat ../closes.txt | head -n 1)" > ../after-land.txt',
    );

    const land = sh(c.main, "./scripts/slice-land.sh 40");

    const head = git(c.main, "rev-parse", "HEAD");
    expect(land).toContain('── after the land: bash -c echo "$PWD|');
    expect(land).toContain("✓ afterLand passed");
    expect(readFileSync(join(c.root, "after-land.txt"), "utf8").trim()).toBe(
      `${c.main}|40|${head}|${head}|40`,
    );
  });

  it("exits 3 when it fails, and leaves the land pushed and the ticket closed", () => {
    consumer("echo the health check is red; exit 7");
    const lock = landLockDir(c.main);

    const r = shResult(c.main, "./scripts/slice-land.sh 40");

    expect(r.code).toBe(3);
    expect(r.out).toContain("the health check is red");
    expect(r.out).toContain(
      "✗ afterLand failed (exit 7) — #40 is landed and closed; main needs a look before anything else lands",
    );
    expect(git(c.main, "log", "-1", "--format=%s", "origin/main")).toBe(
      "feat: 40",
    );
    expect(readFileSync(c.closeFile, "utf8")).toContain("40\n");
    expect(existsSync(lock)).toBe(false);
  });

  it("does not run for a land that is refused", () => {
    consumer("echo AFTER-LAND-RAN");

    const r = shResult(c.main, "./scripts/slice-land.sh 77");

    expect(r.code).toBe(1);
    expect(r.out).not.toContain("AFTER-LAND-RAN");
    expect(r.out).not.toContain("after the land");
  });

  it("holds the land lock while it runs, so the next land waits for it", async () => {
    consumer("while [ ! -f ../go ]; do sleep 0.1; done");
    const first = startScript(c.main, "./scripts/slice-land.sh 40");
    try {
      await first.until("── after the land");
      const second = startScript(c.main, "./scripts/slice-land.sh 41");
      try {
        await second.until(/waiting for ticket\/40's land \(pid \d+, since /);
        expect(second.output()).not.toContain("fast-forwarding");

        writeFileSync(join(c.root, "go"), "");
        expect(await first.exited).toBe(0);
        // 41 was cut from the old main, so it is refused as diverged.
        expect(await second.exited).toBe(75);
      } finally {
        await second.stop();
      }
    } finally {
      writeFileSync(join(c.root, "go"), "");
      await first.stop();
    }
  }, 60_000);
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

/**
 * The base the land works from is origin's. On consumer-b the land
 * fast-forwarded onto the slice first and fetched afterwards: a push origin
 * refused left the local base on the slice, and a dispatcher clone nobody
 * pulled by hand was rebased onto for a day. Now the local base is brought
 * onto origin's head before anything moves, and a refused push is undone.
 */
describe("slice-land.sh and origin's base", () => {
  let c: Consumer;
  let other: string;
  /** A commit pushed to origin from another checkout. */
  const theirs = (msg: string, file = "theirs.txt") => {
    writeFileSync(join(other, file), `${msg}\n`);
    git(other, "add", file);
    git(other, "commit", "-qm", msg);
    git(other, "push", "-q", "origin", "main");
  };
  const commitIn = (wt: string, file: string, msg: string) => {
    writeFileSync(join(wt, file), `${file}\n`);
    git(wt, "add", file);
    git(wt, "commit", "-qm", msg);
  };
  beforeEach(() => {
    c = makeConsumer({ remote: true });
    other = join(c.root, "other");
    git(c.root, "clone", "-q", join(c.root, "remote"), other);
  });
  afterEach(() => rmSync(c.root, { recursive: true, force: true }));

  it("fast-forwards a local base that is behind, then lands a slice cut from origin onto it", () => {
    theirs("feat: theirs");
    git(c.main, "fetch", "-q", "origin");
    git(
      c.main,
      "worktree",
      "add",
      "-q",
      c.wt(40),
      "-b",
      "ticket/40",
      "origin/main",
    );
    commitIn(c.wt(40), "a.txt", "feat: a");

    const land = sh(c.main, "./scripts/slice-land.sh 40");

    expect(land).toContain(
      "✓ main fast-forwarded onto origin/main — it was 1 commit(s) behind",
    );
    expect(land.indexOf("fast-forwarded onto origin/main")).toBeLessThan(
      land.indexOf("── fast-forwarding main onto ticket/40"),
    );
    // The slice's own commit, not origin's as well.
    expect(land).toMatch(/landed on main as [0-9a-f]{7} \(1 commit\(s\)\)/);
    expect(land).toContain("✓ closed #40");
    expect(git(c.main, "log", "--format=%s")).toBe(
      "feat: a\nfeat: theirs\ninit",
    );
    expect(git(c.main, "rev-parse", "main")).toBe(
      git(c.main, "rev-parse", "origin/main"),
    );
  });

  it("refuses with 75 before moving anything when the slice lacks origin's head, and lands once rebased", () => {
    git(c.main, "worktree", "add", "-q", c.wt(40), "-b", "ticket/40");
    commitIn(c.wt(40), "a.txt", "feat: a");
    theirs("feat: theirs");

    const r = shResult(c.main, "./scripts/slice-land.sh 40");

    expect(r.code).toBe(75);
    expect(r.out).toContain(
      "✓ main fast-forwarded onto origin/main — it was 1 commit(s) behind",
    );
    expect(r.out).toContain(
      "main can't fast-forward onto ticket/40 — it has diverged",
    );
    expect(r.out).not.toContain("pushing main");
    // The base is origin's now, which is what the rebase it asks for needs.
    expect(git(c.main, "log", "-1", "--format=%s")).toBe("feat: theirs");
    expect(git(c.main, "rev-parse", "main")).toBe(
      git(c.main, "rev-parse", "origin/main"),
    );
    expect(git(c.wt(40), "log", "-1", "--format=%s")).toBe("feat: a");
    expect(existsSync(landLockDir(c.main))).toBe(false);

    git(c.wt(40), "rebase", "-q", "main");
    const land = sh(c.main, "./scripts/slice-land.sh 40");
    expect(land).toContain("✓ closed #40");
    expect(git(c.main, "log", "--format=%s")).toBe(
      "feat: a\nfeat: theirs\ninit",
    );
  });

  it("undoes the fast-forward when origin moved between the fetch and the push, and exits 75 on origin's new head", () => {
    git(c.main, "worktree", "add", "-q", c.wt(40), "-b", "ticket/40");
    commitIn(c.wt(40), "a.txt", "feat: a");
    const branchHead = git(c.wt(40), "rev-parse", "HEAD");
    const baseBefore = git(c.main, "rev-parse", "main");
    // Another checkout pushes while this land is pushing: the window a
    // rejected push used to leave the local base sitting on the slice.
    writeFileSync(
      join(c.main, ".git", "hooks", "pre-push"),
      `#!/usr/bin/env bash
set -e
cd ${JSON.stringify(other)}
echo theirs > theirs.txt
git add theirs.txt
git -c user.email=t@t -c user.name=t commit -qm "feat: theirs"
git push -q origin main
`,
      { mode: 0o755 },
    );

    const r = shResult(c.main, "./scripts/slice-land.sh 40");

    expect(r.code).toBe(75);
    expect(r.out).toContain("── pushing main");
    expect(r.out).toContain(
      `✗ origin refused the push — undoing the fast-forward: main back to ${baseBefore.slice(
        0,
        7,
      )}`,
    );
    expect(r.out).toContain(
      "✓ main fast-forwarded onto origin/main — it was 1 commit(s) behind",
    );
    expect(r.out).toMatch(
      /error: origin\/main moved while #40 was landing — main is now at its head, [0-9a-f]{7}\./,
    );
    expect(r.out).not.toContain("✓ pushed");
    expect(r.out).not.toContain("closed #40");
    // The base is origin's, not the slice's; the branch and its worktree are
    // as they were; nothing says a land happened.
    expect(git(c.main, "log", "-1", "--format=%s")).toBe("feat: theirs");
    expect(git(c.main, "rev-parse", "main")).toBe(
      git(c.main, "rev-parse", "origin/main"),
    );
    expect(git(c.main, "rev-parse", "ticket/40")).toBe(branchHead);
    expect(existsSync(c.wt(40))).toBe(true);
    expect(existsSync(c.closeFile)).toBe(false);
    expect(existsSync(join(c.main, ".git", "azelf-landed-40.txt"))).toBe(false);
    expect(existsSync(landLockDir(c.main))).toBe(false);
  });

  it("exits 1 after the undo when the push was refused for another reason", () => {
    git(c.main, "worktree", "add", "-q", c.wt(40), "-b", "ticket/40");
    commitIn(c.wt(40), "a.txt", "feat: a");
    const baseBefore = git(c.main, "rev-parse", "main");
    writeFileSync(
      join(c.main, ".git", "hooks", "pre-push"),
      "#!/usr/bin/env bash\necho 'not today' >&2\nexit 1\n",
      { mode: 0o755 },
    );

    const r = shResult(c.main, "./scripts/slice-land.sh 40");

    expect(r.code).toBe(1);
    expect(r.out).toContain("not today");
    expect(r.out).toContain("undoing the fast-forward");
    expect(r.out).toContain(
      "the push was refused for a reason a rebase would not change",
    );
    expect(git(c.main, "rev-parse", "main")).toBe(baseBefore);
    expect(existsSync(c.closeFile)).toBe(false);
  });
});

/**
 * A push that fails on the network is tried again before anything is undone. A
 * `git` first on PATH fails the first `push` it sees (or every one), as a real
 * one does when the network is gone, and passes everything else through.
 */
describe("slice-land.sh and a network that comes and goes", () => {
  let c: Consumer;
  afterEach(() => rmSync(c.root, { recursive: true, force: true }));

  /** The command line for a land under a `git` that fails `failures` pushes. */
  const landWithFlakyGit = (failures: number) => {
    const bin = join(c.root, "bin");
    mkdirSync(bin);
    const real = spawnSync("which", ["git"], {
      encoding: "utf8",
    }).stdout.trim();
    writeFileSync(
      join(bin, "git"),
      `#!/usr/bin/env bash
if [[ "$1" == "push" ]]; then
  n=$(cat ${JSON.stringify(join(c.root, "pushes"))} 2>/dev/null || echo 0)
  echo $((n + 1)) > ${JSON.stringify(join(c.root, "pushes"))}
  if [[ $n -lt ${failures} ]]; then
    echo "fatal: unable to access 'x': Failed to connect to github.com port 443: Can't assign requested address" >&2
    exit 128
  fi
fi
exec ${JSON.stringify(real)} "$@"
`,
      { mode: 0o755 },
    );
    return spawnSync("./scripts/slice-land.sh", ["40"], {
      cwd: c.main,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        SLICE_NET_RETRY_SECONDS: "0 0",
      },
    });
  };

  const sliced = () => {
    c = makeConsumer({ worktrees: [40], remote: true });
    writeFileSync(join(c.wt(40), "a.txt"), "a\n");
    git(c.wt(40), "add", "a.txt");
    git(c.wt(40), "commit", "-qm", "feat: a");
  };

  it("lands when a later try reaches origin, with nothing undone", () => {
    sliced();
    const r = landWithFlakyGit(2);
    const out = `${r.stdout}${r.stderr}`;

    expect(r.status, out).toBe(0);
    expect(out).toContain("couldn't reach origin — trying again in 0s");
    expect(out).toContain("✓ pushed");
    expect(out).not.toContain("undoing the fast-forward");
    expect(readFileSync(join(c.root, "pushes"), "utf8").trim()).toBe("3");
    expect(git(c.main, "rev-parse", "main")).toBe(
      git(c.main, "rev-parse", "origin/main"),
    );
  });

  it("says origin could not be reached when the tries run out, and undoes the fast-forward", () => {
    sliced();
    const before = git(c.main, "rev-parse", "main");
    const r = landWithFlakyGit(99);
    const out = `${r.stdout}${r.stderr}`;

    expect(r.status, out).toBe(1);
    expect(out).toContain("✗ couldn't reach origin to push");
    expect(out).toContain("origin could not be reached");
    expect(out).not.toContain("refused");
    expect(readFileSync(join(c.root, "pushes"), "utf8").trim()).toBe("3");
    expect(git(c.main, "rev-parse", "main")).toBe(before);
    expect(existsSync(c.wt(40))).toBe(true);
    expect(existsSync(c.closeFile)).toBe(false);
  });

  it("does not retry a push origin refused", () => {
    sliced();
    writeFileSync(
      join(c.main, ".git", "hooks", "pre-push"),
      "#!/usr/bin/env bash\necho 'not today' >&2\nexit 1\n",
      { mode: 0o755 },
    );
    const r = shResult(c.main, "./scripts/slice-land.sh 40");
    expect(r.code).toBe(1);
    expect(r.out).toContain("✗ origin refused the push");
    expect(r.out).not.toContain("trying again");
  });
});

/**
 * What slice-done.sh counts. A slice cut from origin, in a checkout whose
 * local base is behind it, has origin's commits in `base..HEAD`; on
 * consumer-b that read as seven commits to land for one commit of work.
 */
describe("slice-done.sh counts against origin's base", () => {
  let c: Consumer;
  beforeEach(() => {
    c = makeConsumer({ remote: true });
    const other = join(c.root, "other");
    git(c.root, "clone", "-q", join(c.root, "remote"), other);
    for (let i = 1; i <= 6; i += 1) {
      writeFileSync(join(other, `t${i}.txt`), `${i}\n`);
      git(other, "add", `t${i}.txt`);
      git(other, "commit", "-qm", `feat: theirs ${i}`);
    }
    git(other, "push", "-q", "origin", "main");
    git(c.main, "fetch", "-q", "origin");
    git(
      c.main,
      "worktree",
      "add",
      "-q",
      c.wt(40),
      "-b",
      "ticket/40",
      "origin/main",
    );
  });
  afterEach(() => rmSync(c.root, { recursive: true, force: true }));

  it("counts the slice's own commit, and says which base it counted against", () => {
    const wt = c.wt(40);
    writeFileSync(join(wt, "a.txt"), "a\n");
    git(wt, "add", "a.txt");
    git(wt, "commit", "-qm", "feat: a");
    expect(git(wt, "rev-list", "--count", "main..HEAD")).toBe("7");

    const done = sh(wt, "./scripts/slice-done.sh");

    expect(done).toContain(
      "✓ #40 marked done (1 commit(s) to land) — counted against origin/main; the local main is 6 commit(s) behind it, so git log main..HEAD shows more",
    );
  });

  it("refuses a slice with nothing of its own, whatever the local base lacks", () => {
    const r = shResult(c.wt(40), "./scripts/slice-done.sh");

    expect(r.code).toBe(1);
    expect(r.out).toContain(
      "error: ticket/40 has no commits that aren't already on main origin/main — nothing to land.",
    );
    expect(existsSync(join(c.wt(40), ".slice-ready-to-land"))).toBe(false);
  });
});

/**
 * Phase 3 of the stale-base plan: the land lock is keyed by the remote and
 * kept under ~/.azelf/locks (AZELF_LOCKS_DIR in the tests), so a push by hand
 * from another clone of the same origin — `azelf push-main` — and a land
 * queue behind each other instead of racing for origin.
 */
describe("the land lock across clones of one remote, and azelf push-main", () => {
  let c: Consumer;
  let other: string;
  const commitIn = (cwd: string, file: string, msg: string) => {
    writeFileSync(join(cwd, file), `${file}\n`);
    git(cwd, "add", file);
    git(cwd, "commit", "-qm", msg);
  };
  /** A pre-push hook in `repo` that holds its push until `go` exists. */
  const holdPushes = (repo: string) => {
    const go = join(c.root, `go-${Math.random().toString(36).slice(2)}`);
    mkdirSync(join(repo, ".git", "hooks"), { recursive: true });
    writeFileSync(
      join(repo, ".git", "hooks", "pre-push"),
      `#!/usr/bin/env bash\nwhile [ ! -f ${go} ]; do sleep 0.1; done\n`,
      { mode: 0o755 },
    );
    return () => writeFileSync(go, "");
  };
  beforeEach(() => {
    c = makeConsumer({ worktrees: [40], remote: true });
    commitIn(c.wt(40), "a.txt", "feat: a");
    other = join(c.root, "other");
    git(c.root, "clone", "-q", join(c.root, "remote"), other);
  });
  afterEach(() => rmSync(c.root, { recursive: true, force: true }));

  it("is one directory for every clone of the remote, outside both git dirs, and the git dir without a remote", () => {
    const lock = landLockDir(c.main);
    expect(landLockDir(other)).toBe(lock);
    expect(landLockDir(c.wt(40))).toBe(lock);
    expect(lock.startsWith(process.env.AZELF_LOCKS_DIR as string)).toBe(true);
    expect(lock.endsWith("/land")).toBe(true);
    expect(lock.startsWith(c.main)).toBe(false);
    // The shell half asks the same function.
    expect(
      sh(other, `bun ${AZELF}/scripts/slice-lock.ts land-dir .`).trim(),
    ).toBe(lock);

    const alone = makeConsumer({});
    try {
      expect(landLockDir(alone.main)).toBe(
        join(alone.main, ".git", "azelf-land.lock"),
      );
    } finally {
      rmSync(alone.root, { recursive: true, force: true });
    }
  });

  it("pushes a fast-forward from another clone, and says when there is nothing to push", () => {
    commitIn(other, "theirs.txt", "feat: theirs");
    const first = sh(other, "./scripts/slice-push-main.sh");
    expect(first).toContain("── pushing main");
    expect(first).toMatch(
      /✓ pushed main — origin\/main is now [0-9a-f]{7} \(1 commit\(s\)\)/,
    );
    expect(
      git(c.root, "--git-dir=remote", "log", "-1", "--format=%s", "main"),
    ).toBe("feat: theirs");

    const again = shResult(other, "./scripts/slice-push-main.sh");
    expect(again.code).toBe(0);
    expect(again.out).toMatch(
      /✓ origin\/main already has main \([0-9a-f]{7}\) — nothing to push/,
    );
    expect(again.out).not.toContain("── pushing");
    expect(existsSync(landLockDir(other))).toBe(false);
  });

  it("refuses a base that is behind, one that has diverged, a checkout off the base, and an argument, and pushes nothing", () => {
    commitIn(other, "theirs.txt", "feat: theirs");
    sh(other, "./scripts/slice-push-main.sh");

    const behind = shResult(c.main, "./scripts/slice-push-main.sh");
    expect(behind.code).toBe(1);
    expect(behind.out).toContain(
      "main is 1 commit(s) behind origin/main and has nothing of its own — nothing to push.",
    );
    expect(behind.out).toContain(
      "git merge --ff-only origin/main brings it level",
    );

    commitIn(c.main, "mine.txt", "feat: mine");
    const diverged = shResult(c.main, "./scripts/slice-push-main.sh");
    expect(diverged.code).toBe(1);
    expect(diverged.out).toContain(
      "main and origin/main have diverged (1 and 1 commits) — only a fast-forward is pushed.",
    );
    expect(diverged.out).toContain("Nothing was pushed.");
    expect(git(c.main, "log", "-1", "--format=%s", "main")).toBe("feat: mine");

    // From a slice worktree it acts on the main checkout, as slice-land.sh
    // does: the same refusal. A main checkout on another branch is refused.
    const worktree = shResult(c.wt(40), "./scripts/slice-push-main.sh");
    expect(worktree.code).toBe(1);
    expect(worktree.out).toContain("main and origin/main have diverged");
    git(other, "checkout", "-q", "-b", "side");
    const side = shResult(other, "./scripts/slice-push-main.sh");
    expect(side.code).toBe(1);
    expect(side.out).toContain(
      "run this from the main worktree, on main — currently on 'side'",
    );
    git(other, "checkout", "-q", "main");

    const arg = shResult(other, "./scripts/slice-push-main.sh main");
    expect(arg.code).toBe(64);
    expect(arg.out).toContain("usage:");

    expect(
      git(c.root, "--git-dir=remote", "log", "-1", "--format=%s", "main"),
    ).toBe("feat: theirs");
    expect(existsSync(landLockDir(c.main))).toBe(false);
  });

  it("is azelf push-main, which takes no argument", () => {
    const run = (...args: string[]) =>
      spawnSync("bun", [join(AZELF, "bin", "azelf.ts"), "push-main", ...args], {
        cwd: other,
        encoding: "utf8",
      });
    const r = run();
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("nothing to push");
    const bad = run("main");
    expect(bad.status).toBe(2);
    expect(bad.stderr).toContain("usage:");
    expect(bad.stderr).toContain("azelf push-main");
  });

  it("makes a hand push from another clone wait for a running land, which it then sees", async () => {
    const go = holdPushes(c.main);
    const land = startScript(c.main, "./scripts/slice-land.sh 40");
    try {
      await land.until("pushing main");
      commitIn(other, "theirs.txt", "feat: theirs");
      const push = startScript(other, "./scripts/slice-push-main.sh");
      try {
        await push.until(/waiting for ticket\/40's land \(pid \d+, since /);
        expect(push.output()).not.toContain("── pushing");

        go();
        expect(await land.exited).toBe(0);
        // It fetched under the lock, so it saw the land and refused as
        // diverged — never a push origin rejected.
        expect(await push.exited).toBe(1);
      } finally {
        await push.stop();
      }
      expect(push.output()).toContain(
        "main and origin/main have diverged (1 and 1 commits)",
      );
      expect(push.output()).not.toMatch(/rejected|── pushing/);
    } finally {
      go();
      await land.stop();
    }
    expect(land.output()).toContain("✓ closed #40");
    expect(
      git(c.root, "--git-dir=remote", "log", "-1", "--format=%s", "main"),
    ).toBe("feat: a");
    expect(existsSync(landLockDir(c.main))).toBe(false);
  });

  it("makes a land wait for a hand push from another clone, and work from what it pushed", async () => {
    const go = holdPushes(other);
    commitIn(other, "theirs.txt", "feat: theirs");
    const push = startScript(other, "./scripts/slice-push-main.sh");
    try {
      await push.until("── pushing main");
      const land = startScript(c.main, "./scripts/slice-land.sh 40");
      try {
        await land.until(/waiting for push-main's land \(pid \d+, since /);
        expect(land.output()).not.toContain("fast-forwarding");

        go();
        expect(await push.exited).toBe(0);
        // The land fetched after the push: its base is origin's new head,
        // the slice lacks it, and the answer is 75 before anything moved —
        // not a push origin refused and undid.
        expect(await land.exited).toBe(75);
      } finally {
        await land.stop();
      }
      expect(land.output()).toContain(
        "✓ main fast-forwarded onto origin/main — it was 1 commit(s) behind",
      );
      expect(land.output()).toContain(
        "can't fast-forward onto ticket/40 — it has diverged",
      );
      expect(land.output()).not.toContain("origin refused the push");
    } finally {
      go();
      await push.stop();
    }
    expect(git(c.main, "rev-parse", "main")).toBe(
      git(c.main, "rev-parse", "origin/main"),
    );
    expect(git(c.wt(40), "log", "-1", "--format=%s")).toBe("feat: a");

    git(c.wt(40), "rebase", "-q", "main");
    expect(sh(c.main, "./scripts/slice-land.sh 40")).toContain("✓ closed #40");
    expect(git(c.root, "--git-dir=remote", "log", "--format=%s", "main")).toBe(
      "feat: a\nfeat: theirs\ninit",
    );
  }, 60_000);
});
