import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  AZELF,
  type Consumer,
  type Dispatcher,
  fakeSession,
  git,
  makeConsumer,
  runDispatcher,
  sh,
  startDispatcher,
  startScript,
} from "./fixture";

/**
 * slice-run.ts end to end: a real dispatcher process against a throwaway
 * consumer, a fake tracker it reads from a file, and a fake resolver.
 */

let c: Consumer | undefined;
let d: Dispatcher | undefined;
/** Fake sessions a test started, stopped after it. */
let sessions: Dispatcher[] = [];
afterEach(async () => {
  await d?.stop();
  d = undefined;
  for (const s of sessions) await s.stop();
  sessions = [];
  if (c) rmSync(c.root, { recursive: true, force: true });
  c = undefined;
});

const commitIn = (cwd: string, file: string, text: string, msg: string) => {
  writeFileSync(join(cwd, file), text);
  git(cwd, "add", file);
  git(cwd, "commit", "-qm", msg);
};

const rebaseInProgress = (wt: string) =>
  ["rebase-merge", "rebase-apply"].some((n) =>
    existsSync(git(wt, "rev-parse", "--path-format=absolute", "--git-path", n)),
  );

describe("the dispatcher", () => {
  it("lands a slice marked done and closes its ticket", () => {
    c = makeConsumer({ worktrees: [40], remote: true, agent: ["true"] });
    commitIn(c.wt(40), "a.txt", "a\n", "feat: a");
    sh(c.wt(40), "./scripts/slice-done.sh");

    const r = runDispatcher(c, ["--auto", "--once", "-y", "--no-review", "40"]);

    expect(r.out).toContain("landing #40");
    expect(r.code).toBe(0);
    expect(git(c.main, "log", "-1", "--format=%s")).toBe("feat: a");
    expect(readFileSync(c.closeFile, "utf8")).toContain(
      "40\nLanded on main via slice-land.sh.",
    );
    expect(existsSync(c.wt(40))).toBe(false);
  });

  it("lands a slice that is marked done while it is running", async () => {
    c = makeConsumer({ worktrees: [40], remote: true, agent: ["true"] });
    commitIn(c.wt(40), "a.txt", "a\n", "feat: a");
    sessions.push(fakeSession(c, 40));

    d = startDispatcher(c, ["-y", "--interval", "1", "40"]);
    await d.until("[round 1] 1 running");
    sh(c.wt(40), "./scripts/slice-done.sh");
    await d.until("plan complete");

    expect(await d.exited).toBe(0);
    expect(git(c.main, "log", "-1", "--format=%s")).toBe("feat: a");
  });
});

describe("the round line", () => {
  it("is printed when its counts change, and otherwise once a heartbeat", async () => {
    c = makeConsumer({ worktrees: [40] });
    const session = fakeSession(c, 40);
    sessions.push(session);
    d = startDispatcher(c, ["-y", "--interval", "1", "40"], {
      env: { SLICE_HEARTBEAT_SECONDS: "6" },
    });
    const RUNNING = "1 running · 0 blocked · 1 open — land one to advance";
    const printedAt = () =>
      [...(d?.output() ?? "").matchAll(/\[round (\d+)\] (.*)/g)]
        .filter((m) => m[2]?.endsWith("land one to advance"))
        .map((m) => [Number(m[1]), m[2]] as const);
    await d.until(`[round 1] ${RUNNING}`);
    await d.until(/\[round \d+\] 1 running[\s\S]*\[round \d+\] 1 running/);

    // Nothing changed in between: the second one is the heartbeat, rounds
    // later, and none of the rounds between said anything.
    const [first, second] = printedAt();
    expect(first?.[0]).toBe(1);
    expect(second?.[1]).toBe(RUNNING);
    expect((second?.[0] ?? 0) - (first?.[0] ?? 0)).toBeGreaterThanOrEqual(3);

    // A change is printed the round it happens, not at the next heartbeat.
    const before = printedAt().length;
    const stoppedAt = Date.now();
    await session.stop();
    await d.until(/0 running[^\n]*land one to advance/);
    expect(Date.now() - stoppedAt).toBeLessThan(3_500);
    expect(printedAt().length).toBe(before + 1);
  }, 60_000);
});

/**
 * A prep that ran out of space partway was retried every round, and each
 * retry left another half-built worktree. The floor holds new worktrees
 * before that happens, and a prep that fails anyway cleans up after itself.
 * `bun install` fails here on a `file:` dependency that does not exist, which
 * needs no network.
 */
describe("the disk floor and a failed prep", () => {
  const BAD_PACKAGE =
    '{ "name": "fx", "dependencies": { "nope": "file:./does-not-exist" } }\n';
  const REMOVED =
    "removed the half-prepped worktree for #40 — it held nothing but a partial install";

  it("preps nothing below the floor, and stops when that is all that is left", async () => {
    c = makeConsumer({ agent: ["true"], configExtra: "minFreeDiskGb: 1e9," });

    // In the background: without the floor this run would retry its prep
    // forever, and that has to fail the test, not hang it.
    d = startDispatcher(c, ["--auto", "-y", "--interval", "1", "40"]);
    await d.until(
      "nothing can advance — nothing is running or left to land, and #40 cannot start",
    );
    await d.exited;

    const out = d.output();
    expect(out).toContain(
      "and run again:\n\n    bunx azelf run --auto -y --interval 1 40\n",
    );
    expect(out).toMatch(/· disk: \d+\.\d GB free where the worktrees go/);
    const hold =
      /disk: \d+\.\d GB free where the worktrees go, below minFreeDiskGb \(1000000000\) — starting nothing until there is more/g;
    expect(out.match(hold)).toHaveLength(1);
    expect(out).not.toContain("prepping");
    expect(out).toContain("lower minFreeDiskGb in slice.config.ts");
    expect(await d.exited).toBe(1);
    expect(existsSync(c.wt(40))).toBe(false);
  }, 60_000);

  it("removes a worktree its failed prep created, every time, and keeps the branch", async () => {
    c = makeConsumer({
      remote: true,
      agent: ["true"],
      configExtra: "minFreeDiskGb: 0,",
    });
    writeFileSync(join(c.main, "package.json"), BAD_PACKAGE);
    git(c.main, "commit", "-qam", "chore: a dependency that is not there");
    git(c.main, "push", "-q", "origin", "main");

    d = startDispatcher(c, ["--auto", "-y", "--interval", "1", "40"]);
    await d.until(new RegExp(`(${REMOVED}[\\s\\S]*){2}\\[round`));

    expect(d.output()).toContain("! #40 failed to prep — skipping this round");
    expect(d.output()).toContain("on existing local branch ticket/40");
    expect(existsSync(c.wt(40))).toBe(false);
    expect(git(c.main, "worktree", "list")).not.toContain("ticket-40");
    expect(git(c.main, "branch", "--list", "ticket/40")).toContain("ticket/40");
  }, 60_000);

  it("never removes a worktree that was there before the prep", () => {
    c = makeConsumer({ worktrees: [40], agent: ["true"] });
    writeFileSync(join(c.wt(40), "package.json"), BAD_PACKAGE);

    const r = runDispatcher(c, ["--once", "-y", "40"]);

    expect(r.out).toContain("! #40 failed to prep — skipping this round");
    expect(r.out).not.toContain("removed the half-prepped");
    expect(readFileSync(join(c.wt(40), "package.json"), "utf8")).toBe(
      BAD_PACKAGE,
    );
  });
});

/**
 * A session that died without its EXIT trap (a crash, a restart, a killed
 * tab) leaves `.slice-live` behind. The dispatcher checks the pid in it, and
 * a slice whose session is gone is relaunched rather than landed, whatever it
 * left in the worktree. These consumers start sessions for real; the fake
 * agent writes the prompt it was given next to the worktree.
 */
describe("a session that crashed", () => {
  const WRITE_PROMPT = 'printf "%s\\n" "$1" > "$(dirname "$PWD")/prompt"';
  const ALREADY =
    "This worktree already has work from an earlier session of this ticket that ended before it finished — see `git log main..HEAD` and `git status`. Continue from it; don't start over.";
  const AUTO = ["--auto", "--once", "-y", "--no-review", "40"];

  /** A pid nothing is running under any more. */
  const deadPid = () =>
    Number(
      spawnSync("bash", ["-c", "echo $$"], { encoding: "utf8" }).stdout.trim(),
    );

  const waitFor = async (what: string, ok: () => boolean, ms = 30_000) => {
    const end = Date.now() + ms;
    while (!ok()) {
      if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
      await new Promise((r) => setTimeout(r, 100));
    }
  };

  /** ticket/40 with one commit, and an agent that records its prompt. */
  const withCommit = () => {
    const fx = makeConsumer({
      worktrees: [40],
      remote: true,
      agent: ["bash", "-c", WRITE_PROMPT, "agent"],
      launch: true,
    });
    commitIn(fx.wt(40), "a.txt", "a\n", "feat: a");
    return fx;
  };

  /** What the relaunched session's agent was told, once that session is over. */
  const relaunchPrompt = async (fx: Consumer) => {
    const prompt = join(fx.root, "prompt");
    await waitFor(
      "the relaunched session",
      () => existsSync(prompt) && !existsSync(join(fx.wt(40), ".slice-live")),
    );
    return readFileSync(prompt, "utf8");
  };

  const gone = (pid: number) =>
    `#40: its session (pid ${pid}) ended without clearing .slice-live — a crash, a restart, or a killed tab. Relaunching it.`;

  it("relaunches a slice whose session died, and does not land its dirty tree", async () => {
    c = withCommit();
    writeFileSync(join(c.wt(40), "b.txt"), "half\n");
    const pid = deadPid();
    writeFileSync(join(c.wt(40), ".slice-live"), `${pid}\n`);

    const r = runDispatcher(c, AUTO);

    expect(r.out).toContain(gone(pid));
    // Not tried and refused: not tried at all.
    expect(r.out).not.toContain("marked done");
    expect(r.out).toContain("started #40");
    expect(git(c.main, "log", "-1", "--format=%s")).toBe("init");
    expect(await relaunchPrompt(c)).toContain(ALREADY);
    // Deleted by the session that picked the work up.
    expect(existsSync(join(c.wt(40), ".slice-interrupted"))).toBe(false);
    expect(readFileSync(join(c.wt(40), "b.txt"), "utf8")).toBe("half\n");
  });

  it("relaunches it with a clean tree too: .slice-interrupted decides", async () => {
    c = withCommit();
    const pid = deadPid();
    writeFileSync(join(c.wt(40), ".slice-live"), `${pid}\n`);

    const r = runDispatcher(c, AUTO);

    expect(r.out).toContain(gone(pid));
    // Not tried and refused: not tried at all.
    expect(r.out).not.toContain("marked done");
    expect(git(c.main, "log", "-1", "--format=%s")).toBe("init");
    expect(await relaunchPrompt(c)).toContain(ALREADY);
  });

  it("relaunches a dirty slice whose marker was deleted by hand", async () => {
    c = withCommit();
    writeFileSync(join(c.wt(40), "b.txt"), "half\n");

    const r = runDispatcher(c, AUTO);

    expect(r.out).not.toContain("ended without clearing");
    // Not tried and refused: not tried at all.
    expect(r.out).not.toContain("marked done");
    expect(git(c.main, "log", "-1", "--format=%s")).toBe("init");
    expect(await relaunchPrompt(c)).toContain(ALREADY);
  });

  it("reads a pid that is running something else as gone", async () => {
    c = withCommit();
    writeFileSync(join(c.wt(40), ".slice-live"), `${process.pid}\n`);

    const r = runDispatcher(c, AUTO);

    expect(r.out).toContain(gone(process.pid));
    // Not tried and refused: not tried at all.
    expect(r.out).not.toContain("marked done");
    await relaunchPrompt(c);
  });

  it("leaves a real session alone across rounds, and tells a new one nothing extra", async () => {
    const tag = String(3000 + Math.floor(Math.random() * 5000));
    c = makeConsumer({
      worktrees: [40],
      remote: true,
      agent: ["bash", "-c", `${WRITE_PROMPT}; exec sleep ${tag}`, "agent"],
      launch: true,
    });
    const fx = c;
    try {
      d = startDispatcher(fx, ["--auto", "-y", "--interval", "1", "40"]);
      await d.until("started #40");
      await waitFor("the session's marker", () =>
        existsSync(join(fx.wt(40), ".slice-live")),
      );
      // Past the launcher's 5s grace, so only the pid check keeps it running.
      await new Promise((r) => setTimeout(r, 6_000));
      const rounds = () => d?.output().match(/\[round \d+\] 1 running/g) ?? [];
      const seen = rounds().length;
      await waitFor("two more rounds", () => rounds().length >= seen + 2);

      expect(d.output()).not.toContain("ended without clearing");
      expect(existsSync(join(fx.wt(40), ".slice-live"))).toBe(true);
      expect(readFileSync(join(fx.root, "prompt"), "utf8")).not.toContain(
        "already has work",
      );
    } finally {
      spawnSync("pkill", ["-f", `sleep ${tag}`]);
    }
  }, 60_000);

  it("still lands a slice that committed everything and closed its session", () => {
    c = makeConsumer({ worktrees: [40], remote: true, agent: ["true"] });
    commitIn(c.wt(40), "a.txt", "a\n", "feat: a");

    const r = runDispatcher(c, AUTO);

    expect(r.out).toContain("landing #40");
    expect(r.code).toBe(0);
    expect(git(c.main, "log", "-1", "--format=%s")).toBe("feat: a");
  });
});

/**
 * Someone fixing a slice by hand while the dispatcher runs. Its land used to
 * start a rebase of its own when the base had moved, fail on theirs, and
 * `git rebase --abort` it, resolution and all.
 */
describe("a hand fix in progress", () => {
  /**
   * ticket/40 marked done, conflicting with main in a.txt, and stopped
   * mid-rebase with the conflict resolved and staged but not continued. Then
   * main moves again, so the branch is behind it and a land would rebase.
   */
  const midRebase = () => {
    const fx = makeConsumer({ worktrees: [40], remote: true });
    commitIn(fx.wt(40), "a.txt", "branch\n", "feat: a");
    sh(fx.wt(40), "./scripts/slice-done.sh");
    commitIn(fx.main, "a.txt", "main\n", "main: a");
    expect(() => git(fx.wt(40), "rebase", "main")).toThrow();
    writeFileSync(join(fx.wt(40), "a.txt"), "resolved\n");
    git(fx.wt(40), "add", "a.txt");
    commitIn(fx.main, "b.txt", "b\n", "main: b");
    return fx;
  };

  const SEEN =
    "#40: a rebase is in progress in its worktree, with no session running there — someone is fixing it by hand, most likely. Not landing or relaunching it until the rebase is finished or aborted.";

  it("leaves a hand rebase alone when main has moved", () => {
    c = midRebase();

    const r = runDispatcher(c, ["--auto", "--once", "-y", "--no-review", "40"]);

    expect(r.out).toContain(SEEN);
    expect(r.out).not.toContain("marked done");
    expect(r.out).not.toContain("rebasing before the gates");
    expect(rebaseInProgress(c.wt(40))).toBe(true);
    expect(readFileSync(join(c.wt(40), "a.txt"), "utf8")).toBe("resolved\n");
    expect(git(c.main, "log", "-1", "--format=%s")).toBe("main: b");
  });

  it("says so once, and lands it once the rebase is finished", async () => {
    c = midRebase();
    d = startDispatcher(c, [
      "--auto",
      "-y",
      "--no-review",
      "--interval",
      "1",
      "40",
    ]);
    await d.until(SEEN);
    await d.until(/\[round 3\]/);

    git(c.wt(40), "-c", "core.editor=true", "rebase", "--continue");
    await d.until("plan complete");

    const out = d.output();
    expect(out.split(SEEN).length - 1).toBe(1);
    expect(out).toContain(
      "#40: nothing is in progress in its worktree any more — back in the run.",
    );
    expect(await d.exited).toBe(0);
    expect(readFileSync(join(c.main, "a.txt"), "utf8")).toBe("resolved\n");
    expect(git(c.main, "log", "--format=%s", "-3")).toBe(
      "feat: a\nmain: b\nmain: a",
    );
  }, 60_000);

  it("names a merge in progress, and leaves it alone too", () => {
    c = makeConsumer({ worktrees: [40], remote: true });
    commitIn(c.wt(40), "a.txt", "branch\n", "feat: a");
    sh(c.wt(40), "./scripts/slice-done.sh");
    commitIn(c.main, "a.txt", "main\n", "main: a");
    expect(() => git(c?.wt(40) as string, "merge", "main")).toThrow();

    const r = runDispatcher(c, ["--auto", "--once", "-y", "--no-review", "40"]);

    expect(r.out).toContain("#40: a merge is in progress in its worktree");
    expect(r.out).not.toContain("marked done");
    expect(
      existsSync(
        git(
          c.wt(40),
          "rev-parse",
          "--path-format=absolute",
          "--git-path",
          "MERGE_HEAD",
        ),
      ),
    ).toBe(true);
  });
});

/**
 * Bumping azelf in the main checkout mid-wave: the dispatcher keeps its own
 * code, and everything it starts from then on runs the new scripts. It runs
 * here from a copy of the package, with a `.bun-tag` as bun writes one, so
 * the test can replace the install under it; azelf has no runtime
 * dependencies, so a copy runs.
 */
describe("azelf changing under a running dispatcher", () => {
  it("says so once, naming both versions", async () => {
    c = makeConsumer({ worktrees: [40] });
    const pkg = join(c.root, "pkg");
    for (const f of ["scripts", "index.ts", "package.json"]) {
      cpSync(join(AZELF, f), join(pkg, f), { recursive: true });
    }
    const tag = (sha: string) =>
      writeFileSync(join(pkg, ".bun-tag"), `chintonicc-azelf-${sha}\n`);
    tag("a3899a5");
    sessions.push(fakeSession(c, 40));

    d = startDispatcher(c, ["-y", "--interval", "1", "40"], {
      dispatcher: join(pkg, "scripts", "slice-run.ts"),
    });
    await d.until("  azelf: a3899a5");
    await d.until("[round 1]");
    tag("6383445");
    const CHANGED =
      "azelf changed under this run: a3899a5 → 6383445. This dispatcher is still running a3899a5; the sessions and lands it starts run 6383445 from now on. Restart it (the same command) when nothing is landing.";
    await d.until(CHANGED);
    // Three more rounds, each of which reads the version again.
    await d.until(/6383445 from now on[\s\S]*(\[round \d+\][\s\S]*){3}/);

    expect(d.output().split(CHANGED).length - 1).toBe(1);
  }, 60_000);
});

/**
 * The resolver edits and azelf runs the git. The fake resolver below keeps
 * both sides of every hunk — the conflicts here are line-level, so that is a
 * correct resolution — and logs each call.
 */
describe("resolving a rebase conflict", () => {
  const RESOLVE_BOTH = `for f in $(git diff --name-only --diff-filter=U); do
  grep -vE '^(<<<<<<<|=======|>>>>>>>)' "$f" > "$f.resolved" || true
  mv "$f.resolved" "$f"
done`;

  /** A consumer whose ticket/40 conflicts with main in each of `files`. */
  const conflicting = (resolver: string, files = ["a.txt"]) => {
    const fx = makeConsumer({
      worktrees: [40],
      remote: true,
      resolve: ["bash", "-c", resolver, "resolver"],
    });
    for (const f of files) commitIn(fx.wt(40), f, "branch\n", `feat: ${f}`);
    for (const f of files) commitIn(fx.main, f, "main\n", `main: ${f}`);
    sh(fx.wt(40), "./scripts/slice-done.sh");
    return fx;
  };

  /** Logs the call and the prompt, then does `body`. */
  const logged = (root: string, body: string) =>
    `echo call >> ${JSON.stringify(join(root, "calls"))}
printf '%s\\n' "$1" >> ${JSON.stringify(join(root, "prompts"))}
${body}`;

  const calls = (fx: Consumer) =>
    existsSync(join(fx.root, "calls"))
      ? readFileSync(join(fx.root, "calls"), "utf8").trim().split("\n").length
      : 0;

  const auto = ["--auto", "--once", "-y", "--no-review", "40"];

  it("stages the resolution and continues the rebase itself", () => {
    // The resolver is written after the consumer, so it can log under its root.
    c = conflicting('bash "$(dirname "$PWD")/resolver.sh" "$1"');
    writeFileSync(join(c.root, "resolver.sh"), logged(c.root, RESOLVE_BOTH));

    const r = runDispatcher(c, auto);

    expect(r.out).toContain("✓ rebased onto main, clean, no markers left");
    expect(r.code).toBe(0);
    expect(calls(c)).toBe(1);
    // Both sides: main's first, because a rebase replays the branch onto it.
    expect(readFileSync(join(c.main, "a.txt"), "utf8")).toBe("main\nbranch\n");
    expect(
      readFileSync(join(c.main, ".slice-reviews", "conflict-40.md"), "utf8"),
    ).toContain("ACCEPTED");
    const prompt = readFileSync(join(c.root, "prompts"), "utf8");
    expect(prompt).toContain("  a.txt");
    expect(prompt).toMatch(/stopped replaying [0-9a-f]+ feat: a\.txt/);
    expect(prompt).toContain("azelf stages the files above");
  });

  it("calls the resolver again for every commit that stops", () => {
    c = conflicting('bash "$(dirname "$PWD")/resolver.sh" "$1"', [
      "a.txt",
      "b.txt",
    ]);
    writeFileSync(join(c.root, "resolver.sh"), logged(c.root, RESOLVE_BOTH));

    const r = runDispatcher(c, auto);

    expect(r.out).toContain("the next commit stops too (1 file)");
    expect(r.code).toBe(0);
    expect(calls(c)).toBe(2);
    expect(git(c.main, "log", "--format=%s", "-2")).toBe(
      "feat: b.txt\nfeat: a.txt",
    );
  });

  it("gives up when the resolver says the sides cannot coexist", () => {
    c = conflicting("echo 'IRRECONCILABLE: both sides rewrite the same line'");
    const head = git(c.wt(40), "rev-parse", "HEAD");

    const r = runDispatcher(c, auto);

    expect(r.out).toContain(
      "resolution rejected — the resolver says the two sides cannot coexist: both sides rewrite the same line",
    );
    expect(r.code).toBe(1);
    expect(git(c.wt(40), "rev-parse", "HEAD")).toBe(head);
    expect(rebaseInProgress(c.wt(40))).toBe(false);
    expect(existsSync(c.closeFile)).toBe(false);
    // The same run's flags, without --once.
    expect(r.out).toContain(
      "To pick the run up again:\n\n    bunx azelf run --auto -y --no-review 40\n",
    );

    // A second run gives up again, and the first attempt's report stays.
    expect(runDispatcher(c, auto).code).toBe(1);
    const report = readFileSync(
      join(c.main, ".slice-reviews", "conflict-40.md"),
      "utf8",
    );
    expect(report.split("# Conflict resolution — #40").length).toBe(2);
    expect(report).toMatch(
      /## Attempt 1 — .*\n\nREJECTED: [\s\S]*### Stop 1: a\.txt[\s\S]*## Attempt 2 — .*\n\nREJECTED: [\s\S]*### Stop 1: a\.txt/,
    );
  });

  it("rejects a resolution that edits a file it was not given", () => {
    c = conflicting(`${RESOLVE_BOTH}
echo stray >> package.json`);
    writeFileSync(join(c.main, "package.json"), "{}\n");
    git(c.main, "add", "package.json");
    git(c.main, "commit", "-qm", "chore: package.json");
    const head = git(c.wt(40), "rev-parse", "HEAD");

    const r = runDispatcher(c, auto);

    expect(r.out).toContain(
      "resolution rejected — the worktree is dirty outside the conflicted files (package.json)",
    );
    expect(r.code).toBe(1);
    expect(git(c.wt(40), "rev-parse", "HEAD")).toBe(head);
    expect(rebaseInProgress(c.wt(40))).toBe(false);
  });
});

/**
 * A parked slice retries when what it failed on changes, not only when its
 * branch moves. Ticket 41 holds a live session throughout, so the run keeps
 * polling instead of stopping on "every open slice is parked".
 */
describe("a parked slice", () => {
  const parkedRun = (
    opts: Parameters<typeof makeConsumer>[0],
    args: string[] = [],
  ) => {
    const fx = makeConsumer({ worktrees: [40, 41], remote: true, ...opts });
    commitIn(fx.wt(40), "a.txt", "a\n", "feat: a");
    sh(fx.wt(40), "./scripts/slice-done.sh");
    sessions.push(fakeSession(fx, 41));
    c = fx;
    d = startDispatcher(fx, [...args, "-y", "--interval", "1", "40", "41"]);
    return { c: fx, d };
  };

  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  /** `text` at least `n` times, then at least `rounds` more round lines. */
  const seen = (text: string, n: number, rounds = 0) =>
    new RegExp(
      `(${esc(text)}[\\s\\S]*){${n}}${"\\[round \\d+\\][\\s\\S]*".repeat(
        rounds,
      )}`,
    );
  const count = (out: string, text: string) => out.split(text).length - 1;

  const RED = "✗ #40 did not land — the gates are red";
  /** 41 still running, 40 gone: the round line once 40 has landed. */
  const LANDED = "1 running · 0 blocked · 1 open —";

  it("retries red gates when main moves, with nothing committed to the branch", async () => {
    const { c, d } = parkedRun({ gate: ["test", "-f", "fixed.txt"] });
    await d.until(
      "parked (non-interactive) — retried when its branch moves, when main moves, or now with: azelf retry 40",
    );

    commitIn(c.main, "fixed.txt", "fixed\n", "fix: fixed.txt");
    await d.until(
      "main moved since #40 was parked — retrying (automatic retry 1 of 2).",
    );
    await d.until(LANDED);

    expect(git(c.main, "log", "--format=%s", "-3")).toBe(
      "feat: a\nfix: fixed.txt\ninit",
    );
    expect(readFileSync(c.closeFile, "utf8")).toContain("40\n");
  }, 60_000);

  it("retries a land that lost the fast-forward race", () => {
    // The gate stands in for another dispatcher: the first time it runs, it
    // lands a commit on main, after this slice was rebased and before it lands.
    c = makeConsumer({
      worktrees: [40],
      remote: true,
      gate: [
        "bash",
        "-c",
        "[ -e ../raced ] || { touch ../raced && git -C ../repo commit -q --allow-empty -m 'race: another land'; }",
      ],
    });
    commitIn(c.wt(40), "a.txt", "a\n", "feat: a");
    sh(c.wt(40), "./scripts/slice-done.sh");

    const r = runDispatcher(c, ["-y", "--interval", "1", "40"]);

    expect(r.out).toContain("it has diverged");
    expect(r.out).toContain(
      "parked (non-interactive) — retried when its branch moves, when main moves, or now with: azelf retry 40",
    );
    expect(r.out).toContain(
      "main moved since #40 was parked — retrying (automatic retry 1 of 2).",
    );
    expect(r.code).toBe(0);
    expect(git(c.main, "log", "--format=%s", "-3")).toBe(
      "feat: a\nrace: another land\ninit",
    );
  });

  it("retries a BLOCK when the ticket is edited, and not before", async () => {
    // Blocks until the ticket body says FIXED. It runs in the worktree, so
    // ../reviews is next to it, under the consumer's root.
    const review = `echo call >> ../reviews
case "$1" in *FIXED*) echo "VERDICT: PASS" ;; *) echo "VERDICT: BLOCK" ;; esac`;
    const { c, d } = parkedRun(
      { review: ["bash", "-c", review, "reviewer"], body: "build a" },
      ["--auto"],
    );
    await d.until(
      "parked (non-interactive) — retried when its branch moves, when the ticket is edited, or now with: azelf retry 40",
    );
    await d.until(seen("parked (non-interactive)", 1, 3));
    // Spec and standards, once each: an unchanged ticket is not reviewed again.
    const reviews = () =>
      readFileSync(join(c.root, "reviews"), "utf8").trim().split("\n").length;
    expect(reviews()).toBe(2);
    // The ✗ line names the review file, right under it.
    expect(d.output()).toMatch(
      /#40 not landed — spec review says BLOCK\..*\n {5}review: \S+\/\.slice-reviews\/ticket-40\.md\n/,
    );

    c.setTicket("40", { body: "build a — FIXED" });
    await d.until("#40: the ticket was edited since the BLOCK — retrying.");
    await d.until(LANDED);

    expect(reviews()).toBe(4);
    expect(git(c.main, "log", "-1", "--format=%s")).toBe("feat: a");
    // The passing review did not replace the BLOCK that parked it.
    const report = readFileSync(
      join(c.main, ".slice-reviews", "ticket-40.md"),
      "utf8",
    );
    expect(count(report, "# Review — #40")).toBe(1);
    expect(report).toMatch(
      /## Attempt 1 — [\d-]+ \d\d:\d\d\n\n### Spec\n[\s\S]*VERDICT: BLOCK[\s\S]*## Attempt 2 — [\d-]+ \d\d:\d\d\n\n### Spec\n[\s\S]*VERDICT: PASS/,
    );
  }, 60_000);

  it("does not stop the run while a parked slice is due a retry", () => {
    // No session holds the run open here: 42's land is what moves main, in
    // the same round that leaves every open slice parked.
    c = makeConsumer({
      worktrees: [40, 42],
      remote: true,
      gate: ["test", "-f", "fixed.txt"],
    });
    commitIn(c.wt(40), "a.txt", "a\n", "feat: a");
    sh(c.wt(40), "./scripts/slice-done.sh");
    commitIn(c.wt(42), "fixed.txt", "fixed\n", "fix: fixed.txt");
    sh(c.wt(42), "./scripts/slice-done.sh");

    const r = runDispatcher(c, ["-y", "--interval", "1", "40", "42"]);

    expect(r.out).toContain(RED);
    expect(r.out).toContain(
      "main moved since #40 was parked — retrying (automatic retry 1 of 2).",
    );
    expect(r.out).not.toContain("nothing can advance");
    expect(r.out).toContain("plan complete");
    expect(r.code).toBe(0);
  });

  it("retries on azelf retry, and consumes the request", async () => {
    // Passes once ../ok exists next to the worktree, outside any repo.
    const { c, d } = parkedRun({ gate: ["test", "-f", "../ok"] });
    await d.until(RED);

    const r = azelfRetry(c, "40");
    expect(r.out).toContain(
      "the running dispatcher retries #40 next round; if none is running, `azelf run --auto 40` does",
    );
    expect(r.code).toBe(0);
    await d.until("#40: retry requested — retrying the land.");
    // Consumed: parked again, and three round lines later no third attempt.
    await d.until(seen(RED, 2, 3));
    expect(count(d.output(), RED)).toBe(2);
    expect(existsSync(join(c.wt(40), ".slice-retry"))).toBe(false);

    writeFileSync(join(c.root, "ok"), "");
    azelfRetry(c, "40");
    await d.until(LANDED);
    expect(git(c.main, "log", "-1", "--format=%s")).toBe("feat: a");
  }, 60_000);

  it("stops counting a ticket closed outside the run", async () => {
    const { c, d } = parkedRun({ gate: ["false"] });
    await d.until("· 1 parked");

    c.setTicket("40", { state: "closed" });
    await d.until("#40 was closed outside this run — no longer parked");
    await d.until(LANDED);
    c.setTicket("41", { state: "closed" });
    await d.until("plan complete");

    expect(await d.exited).toBe(0);
    expect(d.output()).not.toContain("── parked");
  }, 60_000);

  it("does not relaunch a slice --auto read as finished once it has parked", async () => {
    // No slice-done.sh: under --auto, commits and no session read as done.
    c = makeConsumer({
      worktrees: [40, 41],
      remote: true,
      agent: ["true"],
      gate: ["false"],
    });
    commitIn(c.wt(40), "a.txt", "a\n", "feat: a");
    sessions.push(fakeSession(c, 41));
    d = startDispatcher(c, ["--auto", "-y", "--interval", "1", "40", "41"]);
    await d.until(RED);
    await d.until(seen(RED, 1, 3));

    expect(d.output()).not.toContain("starting #40");
    expect(d.output()).not.toContain("prepping #40");
    expect(count(d.output(), RED)).toBe(1);
  }, 60_000);

  it("retries red gates twice as main moves, then stays parked", async () => {
    const { c, d } = parkedRun({ gate: ["false"] });
    await d.until(RED);

    commitIn(c.main, "m1.txt", "1\n", "main: 1");
    await d.until("retrying (automatic retry 1 of 2)");
    await d.until(seen(RED, 2));
    commitIn(c.main, "m2.txt", "2\n", "main: 2");
    await d.until("retrying (automatic retry 2 of 2)");
    await d.until(
      "parked (non-interactive) — retried when its branch moves, or now with: azelf retry 40",
    );
    commitIn(c.main, "m3.txt", "3\n", "main: 3");
    await d.until(seen("staying parked", 1, 3));

    expect(d.output()).toContain(
      "main moved, and #40 has had its 2 automatic retries at this branch head — staying parked.",
    );
    expect(count(d.output(), RED)).toBe(3);
    expect(count(d.output(), "staying parked")).toBe(1);
  }, 60_000);
});

/**
 * Two tickets that both need the DB lock, in one wave. The claim makes that
 * safe, but a session opened only to be refused at `db-lock.sh claim` is
 * wasted; the label keeps the second from starting at all.
 */
describe("exclusiveLockLabel", () => {
  const labelled = () => {
    const fx = makeConsumer({
      lockPaths: ["db"],
      remote: true,
      agent: ["true"],
      configExtra: 'exclusiveLockLabel: "db",',
    });
    fx.setTicket("40", { labels: ["db"] });
    fx.setTicket("44", { labels: ["db"] });
    return fx;
  };

  it("marks labelled tickets in the plan and counts them as one slot", () => {
    c = labelled();
    const r = runDispatcher(c, ["--plan", "40", "41", "44"]);

    expect(r.out).toContain("#40  t  [db]");
    expect(r.out).toContain("#44  t  [db]");
    expect(r.out).not.toContain("#41  t  [db]");
    expect(r.out).toContain(
      "#40, #44 carry [db] (exclusiveLockLabel): they run one at a time, in this order, whatever their wave says",
    );
    expect(r.out).toContain("widest wave: 2");
  });

  it("starts one labelled ticket at a time, and the next once it lands", async () => {
    c = labelled();
    d = startDispatcher(c, [
      "--auto",
      "-y",
      "--no-review",
      "--max",
      "3",
      "--interval",
      "1",
      "40",
      "41",
      "44",
    ]);
    await d.until("[db] one at a time: #40 in flight; waiting on it: #44");
    expect(d.output()).toContain("starting #40, #41");
    expect(d.output()).not.toContain("prepping #44");

    commitIn(c.wt(40), "a.txt", "a\n", "feat: a");
    sh(c.wt(40), "./scripts/slice-done.sh");
    await d.until("landing #40");
    await d.until("starting #44");

    expect(
      d.output().split("waiting on it: #44").length - 1,
      "said once, not every round",
    ).toBe(1);
  }, 60_000);

  it("is refused with no exclusiveLockPaths to protect", () => {
    c = makeConsumer({ configExtra: 'exclusiveLockLabel: "db",' });
    const r = runDispatcher(c, ["--plan", "40"]);

    expect(r.code).not.toBe(0);
    expect(r.out).toContain(
      "exclusiveLockLabel is set but exclusiveLockPaths is empty",
    );
  });
});

/** `azelf retry <id>` through the real CLI, from the consumer's main checkout. */
const azelfRetry = (fx: Consumer, id: string) => {
  const r = spawnSync("bun", [join(AZELF, "bin", "azelf.ts"), "retry", id], {
    cwd: fx.main,
    encoding: "utf8",
    env: { ...process.env, SLICE_REPO_ROOT: fx.main },
  });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
};

describe("azelf retry", () => {
  it("refuses a ticket with no worktree", () => {
    c = makeConsumer({});
    const r = azelfRetry(c, "99");
    expect(r.out).toContain("#99: no worktree at");
    expect(r.code).toBe(1);
  });
});

describe("the command line", () => {
  /** The real CLI, from a directory with no slice.config.ts above it. */
  const azelf = (cwd: string, ...args: string[]) => {
    const env = Object.fromEntries(
      Object.entries(process.env).filter(
        ([k]) => k !== "SLICE_REPO_ROOT" && k !== "SLICE_CONFIG",
      ),
    );
    const r = spawnSync("bun", [join(AZELF, "bin", "azelf.ts"), ...args], {
      cwd,
      encoding: "utf8",
      env,
    });
    return { code: r.status, stdout: r.stdout, stderr: r.stderr };
  };

  it("answers run --help with the flags, and plans nothing", () => {
    c = makeConsumer({ worktrees: [40] });
    const r = runDispatcher(c, ["--auto", "--help"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("-y ");
    expect(r.out).toContain("--interval");
    expect(r.out).not.toContain("reading the plan");
  });

  it("refuses a flag it does not know, and plans nothing", () => {
    c = makeConsumer({ worktrees: [40] });
    const r = runDispatcher(c, ["--hepl"]);
    expect(r.code).toBe(64);
    expect(r.out).toContain(
      "unknown flag --hepl — azelf run --help lists them",
    );
    expect(r.out).not.toContain("reading the plan");
  });

  it("leaves a value flag's argument alone", () => {
    c = makeConsumer({ worktrees: [40] });
    const r = runDispatcher(c, ["--max", "-1", "--plan"]);
    expect(r.out).not.toContain("unknown flag");
    expect(r.out).toContain("reading the plan");
  });

  it("prints azelf's usage to stdout on -h, and run's without a config", () => {
    c = makeConsumer({});
    const top = azelf(c.root, "-h");
    expect(top.code).toBe(0);
    expect(top.stdout).toContain("azelf run --help lists every flag");

    const run = azelf(c.root, "run", "--help");
    expect(run.code).toBe(0);
    expect(run.stdout).toContain("--no-auto-resolve");
  });
});

/**
 * Two dispatchers on one repo: each gates one slice at a time already, and
 * the gate lock stops the second one's gates running on top of the first's.
 */
describe("the gate lock", () => {
  it("waits for another run's gates, naming them, then runs its own", async () => {
    c = makeConsumer({ worktrees: [40], gate: ["true"] });
    commitIn(c.wt(40), "a.txt", "a\n", "feat: a");
    const lock = join(c.main, ".git", "azelf-gates.lock");
    const go = join(c.root, "go");
    // Another dispatcher, as far as the lock can tell: a live process that
    // holds it for #31 until the test says go.
    const other = startScript(
      c.main,
      `bun ${join(AZELF, "scripts", "slice-lock.ts")} acquire ${lock} --pid $$ --label '#31'
echo held
while [ ! -f ${go} ]; do sleep 0.1; done
bun ${join(AZELF, "scripts", "slice-lock.ts")} release ${lock} --pid $$`,
    );
    try {
      await other.until("held");
      d = startDispatcher(c, ["--gates", "40"]);
      await d.until(
        `waiting for #31's gates (another dispatcher, pid ${other.pid})`,
      );
      expect(d.output()).not.toContain("passes every gate");

      writeFileSync(go, "");
      expect(await d.exited).toBe(0);
      expect(d.output()).toContain("✓ #40 passes every gate");
      expect(existsSync(lock)).toBe(false);
    } finally {
      writeFileSync(go, "");
      await other.stop();
    }
  }, 60_000);
});

/**
 * A gate with `retries` that fails once and then passes lands the slice,
 * warns on the spot, and is named again when the run ends.
 */
describe("a gate that passes on a retry", () => {
  // Fails the first time it runs in this consumer, passes after. The flag
  // file is outside the worktree, which a gate must not write to.
  const FLAKY = [
    "bash",
    "-c",
    "[ -f ../flaked ] || { touch ../flaked; exit 1; }",
  ];

  it("lands, and the end of the run lists it", () => {
    c = makeConsumer({
      worktrees: [40],
      remote: true,
      agent: ["true"],
      gate: FLAKY,
      gateRetries: 1,
    });
    commitIn(c.wt(40), "a.txt", "a\n", "feat: a");
    sh(c.wt(40), "./scripts/slice-done.sh");

    const r = runDispatcher(c, ["--auto", "--once", "-y", "--no-review", "40"]);

    expect(r.out).toContain(
      `⚠ \`${FLAKY.join(
        " ",
      )}\` failed, then passed on retry 1 — flaky under load`,
    );
    expect(r.out).toContain("landing #40");
    expect(r.code).toBe(0);
    expect(r.out).toContain("── landed on a retried gate (1)");
    expect(r.out).toContain(`#40  \`${FLAKY.join(" ")}\` passed on retry 1`);
  });

  it("parks it without the retry", () => {
    c = makeConsumer({
      worktrees: [40],
      remote: true,
      agent: ["true"],
      gate: FLAKY,
    });
    commitIn(c.wt(40), "a.txt", "a\n", "feat: a");
    sh(c.wt(40), "./scripts/slice-done.sh");

    const r = runDispatcher(c, ["--auto", "--once", "-y", "--no-review", "40"]);

    expect(r.out).toContain("the gates are red");
    expect(r.out).not.toContain("landing #40");
    expect(r.out).not.toContain("landed on a retried gate");
  });
});
