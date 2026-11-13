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
  AZELF,
  type Consumer,
  git,
  makeConsumer,
  sh,
  shResult,
} from "./fixture";

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

/**
 * A gate marked `atCommit` runs after a slice session's commit, as advice: red
 * or not, the commit stands, and the exit is the commit's. From consumer-b's
 * Backend #197, whose zone gate went red on a file from the slice's first
 * commit, at the end of a finished build.
 */
describe("session-commit.sh and atCommit gates", () => {
  let c: Consumer;
  /** The common git dir: a gate's marks go there, out of the tree it judges. */
  const D = 'd="$(git rev-parse --path-format=absolute --git-common-dir)"';
  const mark = (name: string) => join(c.main, ".git", name);
  const slice = (script: string, atCommit: unknown = true) => {
    c = makeConsumer({
      worktrees: [40],
      gate: ["bash", "-c", `${D}; ${script}`],
      gateAtCommit: atCommit,
    });
    writeFileSync(join(c.wt(40), ".slice-ticket.md"), "# 40\n");
  };
  const commitA = (cwd = c.wt(40)) => {
    writeFileSync(join(cwd, "a.txt"), "a\n");
    return commit(cwd, "feat: a", "a.txt");
  };
  afterEach(() => rmSync(c.root, { recursive: true, force: true }));

  it("warns on a red gate, and the commit stands with exit 0", () => {
    slice("echo ZONE-RED; exit 1");
    const r = commitA();

    expect(r.code).toBe(0);
    expect(r.out).toContain("✓ committed:");
    expect(r.out).toMatch(/⚠ `bash -c .*` failed/);
    expect(r.out).toContain("      ZONE-RED");
    expect(r.out).toContain(
      "The commit stands. The land runs this gate too, and refuses the slice while it is red",
    );
    expect(git(c.wt(40), "log", "--format=%s", "main..HEAD")).toBe("feat: a");
  });

  it("says nothing on a green one", () => {
    slice('touch "$d/ran"');
    const r = commitA();

    expect(r.code).toBe(0);
    expect(existsSync(mark("ran"))).toBe(true);
    expect(r.out).not.toContain("⚠");
  });

  it("runs with the commit lock released", () => {
    slice(
      'if [ -d "$d/session-commit.lock" ]; then echo held; else echo free; fi > "$d/lockstate"',
    );
    commitA();

    expect(readFileSync(mark("lockstate"), "utf8")).toBe("free\n");
    expect(existsSync(mark("session-commit.lock"))).toBe(false);
  });

  it("does not run in the main checkout", () => {
    slice('touch "$d/ran"');
    const r = commitA(c.main);

    expect(r.ok).toBe(true);
    expect(existsSync(mark("ran"))).toBe(false);
  });

  it("starts no second bun in a config without one", () => {
    slice('touch "$d/ran"', false);
    const log = join(c.root, "bun.log");
    const realBun = sh(c.root, "command -v bun").trim();
    mkdirSync(join(c.root, "bin"));
    writeFileSync(
      join(c.root, "bin", "bun"),
      `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> ${JSON.stringify(
        log,
      )}\nexec ${JSON.stringify(realBun)} "$@"\n`,
      { mode: 0o755 },
    );
    writeFileSync(join(c.wt(40), "a.txt"), "a\n");
    const r = shResult(
      c.wt(40),
      `PATH=${JSON.stringify(
        join(c.root, "bin"),
      )}:"$PATH" ./scripts/session-commit.sh -y -m "feat: a" a.txt`,
    );

    expect(r.ok).toBe(true);
    const calls = readFileSync(log, "utf8");
    expect(calls).toContain("--sh");
    expect(calls).not.toContain("--at-commit");
    expect(existsSync(mark("ran"))).toBe(false);
  });

  it("runs on a tree with work in progress, and leaves it", () => {
    slice("echo ZONE-RED; exit 1");
    writeFileSync(join(c.wt(40), "wip.txt"), "wip\n");
    const r = commitA();

    expect(r.code).toBe(0);
    expect(r.out).toContain("ZONE-RED");
    expect(r.out).not.toContain("dirty");
    expect(readFileSync(join(c.wt(40), "wip.txt"), "utf8")).toBe("wip\n");
  });

  it("names a gate that writes to the tree", () => {
    slice("touch written.txt");
    const r = commitA();

    expect(r.code).toBe(0);
    expect(r.out).toMatch(/⚠ gate `bash -c .*` modified the worktree/);
    expect(r.out).toContain("      ?? written.txt");
  });

  it("azelf run --gates --at-commit exits 0 on its own, red or not", () => {
    slice("echo ZONE-RED; exit 1");
    commitA();
    const r = shResult(c.wt(40), "./scripts/azelf run --gates --at-commit");

    expect(r.code).toBe(0);
    expect(r.out).toContain("ZONE-RED");
  });

  it("the config refuses atCommit together with landOnly", () => {
    c = makeConsumer({ worktrees: [40] });
    const config = join(c.main, "slice.config.ts");
    writeFileSync(
      config,
      readFileSync(config, "utf8").replace(
        /gates: \[.*\],/,
        `gates: [{ name: "ci", run: () => ({ ok: true }), landOnly: true, atCommit: true }],`,
      ),
    );
    const r = shResult(
      c.main,
      `bun ${JSON.stringify(join(AZELF, "scripts", "slice-config.ts"))} --sh`,
    );

    expect(r.ok).toBe(false);
    expect(r.out).toContain("gates[0] (`ci`): atCommit and landOnly");
  });
});

/**
 * `--amend` folds docs into the last commit, or fixes its message — in a slice
 * worktree only, and only on a commit nobody else has. consumer-b's Backend
 * #233: behaviour and docs belong in one commit, and without `--amend` the
 * docs went in as a second one and a wrong message stayed wrong.
 */
describe("session-commit.sh --amend", () => {
  let c: Consumer;
  let wt: string;
  const amend = (args: string) =>
    shResult(wt, `./scripts/session-commit.sh --amend -y ${args}`);
  const files = (rev = "HEAD") =>
    git(wt, "show", "--name-only", "--format=", rev).split("\n").sort();
  const subject = () => git(wt, "log", "-1", "--format=%s");
  const count = () => git(wt, "rev-list", "--count", "main..HEAD");

  /** A slice worktree with one commit of its own: code.ts. */
  const slice = (opts: Parameters<typeof makeConsumer>[0] = {}) => {
    c = makeConsumer({ worktrees: [40], ...opts });
    wt = c.wt(40);
    writeFileSync(join(wt, ".slice-ticket.md"), "# 40\n");
    writeFileSync(join(wt, "code.ts"), "code\n");
    git(wt, "add", "code.ts");
    git(wt, "commit", "-qm", "feat: the code");
  };
  afterEach(() => rmSync(c.root, { recursive: true, force: true }));

  it("adds a named path to the last commit and keeps its message and changes", () => {
    slice();
    const before = git(wt, "rev-parse", "--short", "HEAD");
    writeFileSync(join(wt, "docs.md"), "docs\n");

    const r = amend("docs.md");

    expect(r.ok).toBe(true);
    expect(r.out).toMatch(
      new RegExp(`✓ amended: ${before} → [0-9a-f]+ feat: the code`),
    );
    expect(subject()).toBe("feat: the code");
    expect(files()).toEqual(["code.ts", "docs.md"]);
    expect(count()).toBe("1");
  });

  it("with -m and no path changes only the message, and leaves a stray staged file out and staged", () => {
    slice();
    writeFileSync(join(wt, "stray.txt"), "stray\n");
    git(wt, "add", "stray.txt");

    const r = amend('-m "feat: the code, counted right"');

    expect(r.ok).toBe(true);
    expect(r.out).toContain("✓ amended:");
    expect(subject()).toBe("feat: the code, counted right");
    expect(files()).toEqual(["code.ts"]);
    expect(git(wt, "diff", "--cached", "--name-only")).toBe("stray.txt");
    expect(count()).toBe("1");
  });

  it("with -m and a path changes both", () => {
    slice();
    writeFileSync(join(wt, "docs.md"), "docs\n");

    const r = amend('-m "feat: the code and its docs" docs.md');

    expect(r.ok).toBe(true);
    expect(subject()).toBe("feat: the code and its docs");
    expect(files()).toEqual(["code.ts", "docs.md"]);
  });

  it("wants paths or a message", () => {
    slice();
    const r = amend("");
    expect(r.code).toBe(64);
    expect(r.out).toContain("--amend needs paths to add to the last commit");
  });

  it("is a usage error together with --push", () => {
    slice();
    writeFileSync(join(wt, "docs.md"), "docs\n");
    const r = amend("--push docs.md");
    expect(r.code).toBe(64);
    expect(r.out).toContain("--amend and --push together");
    expect(files()).toEqual(["code.ts"]);
  });

  const refused = (r: ReturnType<typeof amend>, why: string) => {
    expect(r.ok).toBe(false);
    expect(r.out).toContain("--amend refused");
    expect(r.out).toContain(why);
    expect(r.out).toContain("Nothing was staged.");
    expect(git(wt, "diff", "--cached", "--name-only")).toBe("");
  };

  it("is refused outside a slice worktree", () => {
    slice();
    wt = c.main;
    writeFileSync(join(wt, "x.txt"), "x\n");
    git(wt, "add", "x.txt");
    git(wt, "commit", "-qm", "feat: someone's");
    writeFileSync(join(wt, "docs.md"), "docs\n");
    refused(amend("docs.md"), "this is not a slice worktree");
    expect(git(wt, "log", "-1", "--format=%s")).toBe("feat: someone's");
  });

  it("is refused once the slice has handed itself in", () => {
    for (const marker of [".slice-ready-to-land", ".slice-finished"]) {
      slice();
      writeFileSync(join(wt, marker), "");
      writeFileSync(join(wt, "docs.md"), "docs\n");
      refused(amend("docs.md"), `this slice has handed itself in (${marker})`);
      expect(files()).toEqual(["code.ts"]);
      rmSync(c.root, { recursive: true, force: true });
    }
  });

  it("is refused on a commit that is on the base branch", () => {
    c = makeConsumer({ worktrees: [40] });
    wt = c.wt(40);
    writeFileSync(join(wt, ".slice-ticket.md"), "# 40\n");
    writeFileSync(join(wt, "docs.md"), "docs\n");
    refused(amend("docs.md"), "the last commit is on main");
  });

  it("is refused on a commit a remote branch has", () => {
    slice({ remote: true });
    git(wt, "push", "-q", "origin", "HEAD:refs/heads/ticket/40");
    git(wt, "fetch", "-q", "origin");
    writeFileSync(join(wt, "docs.md"), "docs\n");
    refused(
      amend("docs.md"),
      "the last commit is already pushed (origin/ticket/40)",
    );
  });

  it("is refused on a merge", () => {
    slice();
    git(c.main, "commit", "-q", "--allow-empty", "-m", "chore: on main");
    git(wt, "merge", "-q", "--no-ff", "-m", "merge main", "main");
    writeFileSync(join(wt, "docs.md"), "docs\n");
    refused(amend("docs.md"), "the last commit is a merge");
  });

  it("runs the atCommit gates after an amend", () => {
    const D = 'd="$(git rev-parse --path-format=absolute --git-common-dir)"';
    slice({
      gate: ["bash", "-c", `${D}; touch "$d/ran"`],
      gateAtCommit: true,
    });
    writeFileSync(join(wt, "docs.md"), "docs\n");

    const r = amend("docs.md");

    expect(r.ok).toBe(true);
    expect(existsSync(join(c.main, ".git", "ran"))).toBe(true);
  });
});
