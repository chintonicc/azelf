import { spawn, spawnSync } from "node:child_process";
import {
  appendFileSync,
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  AZELF,
  type Consumer,
  type Dispatcher,
  PMSET_AC,
  PMSET_BATTERY,
  asleepSession,
  fakeSession,
  git,
  makeConsumer,
  runDispatcher,
  sh,
  shResult,
  startAzelf,
  startDispatcher,
  startScript,
} from "./fixture";

/**
 * A fake reviewer's line for keeping its prompt, under a lock because the two
 * axes run at once and a long prompt is more than one write.
 */
const RECORD_PROMPT =
  'until mkdir ../prompts.lock 2>/dev/null; do sleep 0.01; done; printf "%s\\n=====\\n" "$1" >> ../prompts; rmdir ../prompts.lock';

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

/**
 * slice-land.sh runs the config's afterLand last and exits 3 when it fails.
 * The land stands; what must not happen is the next slice landing on top of a
 * base nobody has looked at. Two slices are done, so without the stop one run
 * lands both.
 */
describe("afterLand in the dispatcher", () => {
  const twoDone = (script: string) => {
    c = makeConsumer({
      worktrees: [40, 41],
      remote: true,
      agent: ["true"],
      configExtra: `afterLand: ["bash", "-c", ${JSON.stringify(script)}],`,
    });
    commitIn(c.wt(40), "a.txt", "a\n", "feat: a");
    commitIn(c.wt(41), "b.txt", "b\n", "feat: b");
    sh(c.wt(40), "./scripts/slice-done.sh");
    sh(c.wt(41), "./scripts/slice-done.sh");
  };
  const RUN = ["--auto", "-y", "--no-review", "--interval", "1", "40", "41"];

  it("lands the slice whose afterLand failed, then lands nothing more and says how to resume", () => {
    twoDone("exit 7");

    const r = runDispatcher(c as Consumer, RUN);

    expect(r.out).toContain(
      "✗ afterLand failed (exit 7) — #40 is landed and closed",
    );
    expect(r.out).toContain(
      "stopping: #40 landed, and afterLand failed after it.",
    );
    expect(r.out).toContain(
      "\n    ./scripts/azelf run --auto -y --no-review --interval 1 41\n",
    );
    expect(r.code).toBe(1);
    const cc = c as Consumer;
    expect(git(cc.main, "log", "-1", "--format=%s")).toBe("feat: a");
    expect(readFileSync(cc.closeFile, "utf8")).toContain("40\n");
    expect(readFileSync(cc.closeFile, "utf8")).not.toContain("41\n");
    expect(existsSync(cc.wt(41))).toBe(true);
  });

  it("changes nothing in a run when it passes, and the header names it", () => {
    twoDone("true");

    const r = runDispatcher(c as Consumer, RUN);

    expect(r.out).toContain("afterLand: bash -c true");
    expect(r.out).toContain("✓ every ticket closed — plan complete.");
    expect(r.code).toBe(0);
  });

  it("the config refuses resolverCommands that are not a list of prefixes", () => {
    for (const value of ['"pytest"', '["pytest", " "]']) {
      c = makeConsumer({ configExtra: `resolverCommands: ${value},` });
      const r = runDispatcher(c, ["--plan"]);
      expect(r.code).not.toBe(0);
      expect(r.out).toContain(
        "resolverCommands must be an array of non-empty command prefixes",
      );
      rmSync(c.root, { recursive: true, force: true });
    }
  });

  it("the config refuses an afterLand that is not a list of words", () => {
    for (const value of ['"./health.sh"', '["./health.sh", ""]']) {
      c = makeConsumer({ configExtra: `afterLand: ${value},` });
      const r = runDispatcher(c, ["--plan"]);
      expect(r.code).not.toBe(0);
      expect(r.out).toContain(
        "afterLand must be an array of non-empty strings",
      );
      rmSync(c.root, { recursive: true, force: true });
    }
  });
});

describe("the round line", () => {
  it("is printed when its counts change, and otherwise once a heartbeat", async () => {
    // The stop below is a crash to the dispatcher, which relaunches the slice.
    // Its prep fails on the install, so the slice drops to queued: that is the
    // count change. It used to fail by accident, on a `bun install` with no
    // package.json in the fixture.
    c = makeConsumer({ worktrees: [40], configExtra: 'install: ["false"],' });
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
 * The DB lock block follows the round line's rule: printed when it changes or
 * on the heartbeat, plus one "DB lock free" when a held lock goes. #44 holds
 * the lock from its own worktree while #40's session keeps the run going.
 */
describe("the DB lock block", () => {
  const holding = () => {
    c = makeConsumer({ lockPaths: ["db"], worktrees: [40, 44] });
    sessions.push(fakeSession(c, 40));
    return c;
  };
  const start = (fx: Consumer) =>
    startDispatcher(fx, ["-y", "--interval", "1", "40"], {
      env: { SLICE_HEARTBEAT_SECONDS: "6" },
    });
  const count = (text: string, s: string) => text.split(s).length - 1;
  const roundOf = (text: string, s: string) =>
    Number(text.match(new RegExp(`\\[round (\\d+)\\] ${s}`))?.[1]);

  it("is printed once while the same holder keeps it, and the free once", async () => {
    const fx = holding();
    sh(fx.wt(44), "./scripts/db-lock.sh claim");
    d = start(fx);
    await d.until("DB lock held by:");
    // About four rounds with the same holder: still one block.
    await new Promise((r) => setTimeout(r, 4_500));
    expect(count(d.output(), "DB lock held by:")).toBe(1);
    expect(d.output()).toContain("ticket/44, holds the DB lock since");

    sh(fx.wt(44), "./scripts/db-lock.sh release");
    await d.until("DB lock free");
    await new Promise((r) => setTimeout(r, 2_500));
    const out = d.output();
    expect(count(out, "DB lock held by:")).toBe(1);
    expect(count(out, "DB lock free")).toBe(1);
    expect(
      roundOf(out, "DB lock free") - roundOf(out, "DB lock held by:"),
    ).toBeGreaterThanOrEqual(3);
  }, 60_000);

  it("is printed again when the lock is claimed again after it freed", async () => {
    const fx = holding();
    sh(fx.wt(44), "./scripts/db-lock.sh claim");
    d = start(fx);
    await d.until("DB lock held by:");
    sh(fx.wt(44), "./scripts/db-lock.sh release");
    await d.until("DB lock free");
    sh(fx.wt(44), "./scripts/db-lock.sh claim");
    await d.until(/DB lock free[\s\S]*DB lock held by:/);

    expect(count(d.output(), "DB lock held by:")).toBe(2);
    expect(count(d.output(), "DB lock free")).toBe(1);
  }, 60_000);

  it("is never said free when it was never held", async () => {
    const fx = holding();
    d = start(fx);
    await d.until("[round 1] 1 running");
    await new Promise((r) => setTimeout(r, 2_500));
    // The header says "DB lock: free"; no round says anything about it.
    expect(d.output()).not.toMatch(/\[round \d+\] DB lock/);
  }, 60_000);
});

/**
 * A tracker read that fails mid-run is no news: the ticket keeps its last
 * state and the round goes on. Only a tracker that has stopped answering
 * altogether ends the run, and then through its normal ending.
 */
describe("a tracker that stops answering", () => {
  const count = (text: string, want: string) => text.split(want).length - 1;

  it("rides out a brief outage, says so once each way, and lands", async () => {
    c = makeConsumer({ worktrees: [40], remote: true, agent: ["true"] });
    commitIn(c.wt(40), "a.txt", "a\n", "feat: a");
    sessions.push(fakeSession(c, 40));
    d = startDispatcher(c, ["-y", "--interval", "1", "40"], {
      env: { SLICE_HEARTBEAT_SECONDS: "600" },
    });
    await d.until("[round 1] 1 running");

    c.trackerDown(true);
    await d.until(
      'couldn\'t read #40 from Fake — keeping its last state, trying again next round: Post "https://api.github.com/graphql": EOF',
    );
    await new Promise((r) => setTimeout(r, 3_000));
    c.trackerDown(false);
    await d.until(/Fake answers again \(#40 unreadable for \d+ rounds\)/);

    sh(c.wt(40), "./scripts/slice-done.sh");
    await d.until("plan complete");
    expect(await d.exited).toBe(0);
    expect(count(d.output(), "couldn't read")).toBe(1);
    expect(count(d.output(), "answers again")).toBe(1);
    expect(git(c.main, "log", "-1", "--format=%s")).toBe("feat: a");
  }, 60_000);

  describe("at the start", () => {
    const UNREACHABLE =
      /tracker unreachable: gh issue view 40 \(Post "https:\/\/api\.github\.com\/graphql": EOF\)/;

    it("under -y waits for it, says so once, and goes on", async () => {
      c = makeConsumer({ worktrees: [40] });
      sessions.push(fakeSession(c, 40));
      c.trackerDown(true);
      d = startDispatcher(c, ["--once", "-y", "40"], {
        env: { SLICE_TRACKER_OUTAGE_SECONDS: "20" },
      });
      await d.until("— trying again for up to 20 seconds");
      expect(d.output()).toMatch(UNREACHABLE);

      c.trackerDown(false);
      await d.until("--once: stopping here.");
      expect(await d.exited).toBe(0);
      expect(count(d.output(), "tracker unreachable")).toBe(1);
    }, 60_000);

    it("under -y stops at the ceiling with one line and exit 75, no stack", () => {
      c = makeConsumer({ worktrees: [40] });
      c.trackerDown(true);
      const r = runDispatcher(c, ["--once", "-y", "40"], {
        env: { SLICE_TRACKER_OUTAGE_SECONDS: "1" },
      });
      expect(r.code).toBe(75);
      expect(r.out).toMatch(UNREACHABLE);
      expect(r.out).toContain("✗ tracker unreachable");
      expect(r.out).not.toMatch(/^\s+at /m);
    }, 60_000);

    it("without -y says it at once, exit 75", () => {
      c = makeConsumer({ worktrees: [40] });
      c.trackerDown(true);
      const r = runDispatcher(c, ["--plan", "40"]);
      expect(r.code).toBe(75);
      expect(r.out).toMatch(UNREACHABLE);
      expect(r.out).not.toContain("trying again");
      expect(r.out).not.toMatch(/^\s+at /m);
    }, 60_000);
  });

  it("stops after the outage ceiling, names what is still running, and says how to resume", async () => {
    c = makeConsumer({ worktrees: [40] });
    sessions.push(fakeSession(c, 40));
    d = startDispatcher(c, ["-y", "--interval", "1", "40"], {
      env: {
        SLICE_HEARTBEAT_SECONDS: "600",
        SLICE_TRACKER_OUTAGE_SECONDS: "2",
      },
    });
    await d.until("[round 1] 1 running");

    c.trackerDown(true);
    expect(await d.exited).toBe(1);
    const out = d.output();
    expect(out).toMatch(
      /✗ the dispatcher stopped in round \d+: Fake has not answered for 2 seconds\n {2}still running, with nothing to land them: #40\n/,
    );
    expect(out).toContain(
      "To pick the run up again:\n\n    ./scripts/azelf run -y --interval 1 40\n",
    );
  }, 60_000);

  it("does not start a landed ticket whose close failed, and closes it itself", async () => {
    c = makeConsumer({ worktrees: [40, 41], remote: true, agent: ["true"] });
    c.setTicket("40", {});
    c.setTicket("41", {});
    commitIn(c.wt(40), "a.txt", "a\n", "feat: a");
    sh(c.wt(40), "./scripts/slice-done.sh");
    sessions.push(fakeSession(c, 41));
    c.closeFails(true);

    d = startDispatcher(c, ["-y", "--interval", "1", "40", "41"], {
      env: { SLICE_HEARTBEAT_SECONDS: "600" },
    });
    await d.until("warning: couldn't close #40");
    await d.until(
      "couldn't close #40 on Fake — it landed; trying again every round: Post",
    );
    // The rounds in between read #40 open. None of them starts it again.
    await new Promise((r) => setTimeout(r, 2_500));
    expect(d.output()).not.toContain("prepping #40");
    expect(count(d.output(), "couldn't close #40 on Fake")).toBe(1);

    c.closeFails(false);
    await d.until("closed #40 — the close after its land had failed");
    const tickets = JSON.parse(readFileSync(c.ticketsFile, "utf8"));
    expect(tickets["40"].state).toBe("closed");
    // With the comment the land would have left, and whose close this was.
    const closes = readFileSync(c.closeFile, "utf8");
    expect(closes).toContain("40\nLanded on main via slice-land.sh.");
    expect(closes).toContain("Closed by the dispatcher on a later round");
    expect(existsSync(join(c.main, ".git", "azelf-close-40.txt"))).toBe(false);
    // Its worktree and branch went with the land: nothing is left to finish.
    expect(existsSync(join(c.main, ".git", "azelf-landed-40.txt"))).toBe(false);
    expect(d.output()).not.toContain("prepping #40");
  }, 60_000);
});

/**
 * The line is counted after the round's land and launches. A ticket that
 * just landed is not open, a slice that is done and waiting its turn is "to
 * land" and not "blocked", and a slice cut on top of a landed one is not
 * reported as editing the same files.
 */
/**
 * The worktree was installed when it was prepped; a base that changed its
 * dependencies since then leaves the gates running against the old ones.
 * The base's package.json gains a postinstall, and it and the gate write to
 * one log outside the worktree, so the order is visible.
 */
describe("a rebase that brings new dependencies", () => {
  const prep = (postinstall: string, configExtra?: string) => {
    c = makeConsumer({
      worktrees: [40],
      remote: true,
      agent: ["true"],
      configExtra,
    });
    const log = join(c.root, "order.log");
    // Written after makeConsumer, because the gate needs the log's path.
    const config = join(c.main, "slice.config.ts");
    writeFileSync(
      config,
      readFileSync(config, "utf8").replace(
        "gates: []",
        `gates: [exitCode(["bash", "-c", "echo gate >> ${log}"])]`,
      ),
    );
    git(c.main, "commit", "-qam", "chore: a gate");
    git(c.main, "push", "-q", "origin", "main");
    git(c.wt(40), "rebase", "-q", "main");
    commitIn(c.wt(40), "a.txt", "a\n", "feat: a");
    sh(c.wt(40), "./scripts/slice-done.sh");
    return {
      log,
      postinstall: postinstall.replace("LOG", log),
    };
  };
  const read = (f: string) => (existsSync(f) ? readFileSync(f, "utf8") : "");

  it("installs once in the worktree, before the gates", () => {
    const { log, postinstall } = prep("echo install >> LOG");
    commitIn(
      c!.main,
      "package.json",
      JSON.stringify({ name: "fx", scripts: { postinstall } }),
      "chore: a dependency",
    );

    const r = runDispatcher(c!, [
      "--auto",
      "--once",
      "-y",
      "--no-review",
      "40",
    ]);

    expect(r.out).toContain(
      "#40: the rebase brought a new package.json — reinstalling in its worktree (bun install --frozen-lockfile) …",
    );
    expect(read(log)).toBe("install\ngate\n");
    expect(r.code).toBe(0);
    expect(git(c!.main, "log", "-1", "--format=%s")).toBe("feat: a");
  });

  it("installs nothing when the base moved without a manifest", () => {
    const { log } = prep("");
    commitIn(c!.main, "b.txt", "b\n", "feat: b");

    const r = runDispatcher(c!, [
      "--auto",
      "--once",
      "-y",
      "--no-review",
      "40",
    ]);

    expect(r.out).toContain("#40 is behind main — rebasing before the gates");
    expect(r.out).not.toContain("reinstalling");
    expect(read(log)).toBe("gate\n");
    expect(r.code).toBe(0);
  });

  it("parks a slice whose install fails, and runs no gate", () => {
    const { log, postinstall } = prep("echo broken lockfile >&2; exit 1");
    commitIn(
      c!.main,
      "package.json",
      JSON.stringify({ name: "fx", scripts: { postinstall } }),
      "chore: a dependency",
    );

    const r = runDispatcher(c!, [
      "--auto",
      "--once",
      "-y",
      "--no-review",
      "40",
    ]);

    // The fixture has a package.json and no lockfile, so the install is bun's
    // frozen form, and the message names the command that ran.
    expect(r.out).toContain(
      "bun install --frozen-lockfile failed after the rebase (the lockfile may not match package.json) — run bun install --frozen-lockfile in the worktree, commit the lockfile if it changed, and azelf retry 40",
    );
    expect(r.out).toContain("broken lockfile");
    expect(read(log)).toBe("");
    expect(git(c!.main, "log", "-1", "--format=%s")).toBe(
      "chore: a dependency",
    );
  });

  /**
   * An npm repo: the base moves package-lock.json, and the worktree's lockfile
   * decides the command. `npm` is a fake on PATH that logs its argv, or fails,
   * so the test needs neither npm nor a registry.
   */
  const npmRepo = (npm: string) => {
    const { log } = prep("");
    const bin = join(c!.root, "bin");
    mkdirSync(bin);
    writeFileSync(
      join(bin, "npm"),
      `#!/usr/bin/env bash\n${npm.replace("LOG", log)}\n`,
      { mode: 0o755 },
    );
    commitIn(c!.main, "package-lock.json", "{}\n", "chore: a lockfile");
    return { log, env: { PATH: `${bin}:${process.env.PATH}` } };
  };

  it("runs npm ci where the lockfile is npm's, before the gates", () => {
    const { log, env } = npmRepo('echo "npm $*" >> LOG');

    const r = runDispatcher(
      c!,
      ["--auto", "--once", "-y", "--no-review", "40"],
      { env },
    );

    expect(r.out).toContain(
      "#40: the rebase brought a new package-lock.json — reinstalling in its worktree (npm ci) …",
    );
    expect(read(log)).toBe("npm ci\ngate\n");
    expect(r.code).toBe(0);
    expect(git(c!.main, "log", "-1", "--format=%s")).toBe("feat: a");
  });

  it("parks a slice whose npm ci fails, naming npm ci", () => {
    const { log, env } = npmRepo(
      "echo 'npm ERR! lockfile out of sync' >&2; exit 1",
    );

    const r = runDispatcher(
      c!,
      ["--auto", "--once", "-y", "--no-review", "40"],
      { env },
    );

    expect(r.out).toContain(
      "npm ci failed after the rebase (the lockfile may not match package.json) — run npm ci in the worktree, commit the lockfile if it changed, and azelf retry 40",
    );
    expect(r.out).not.toContain("bun install");
    expect(r.out).toContain("npm ERR! lockfile out of sync");
    expect(read(log)).toBe("");
    expect(git(c!.main, "log", "-1", "--format=%s")).toBe("chore: a lockfile");
  });

  it("installs nothing when the config says [], and lands", () => {
    const { log, postinstall } = prep("echo install >> LOG", "install: [],");
    commitIn(
      c!.main,
      "package.json",
      JSON.stringify({ name: "fx", scripts: { postinstall } }),
      "chore: a dependency",
    );

    const r = runDispatcher(c!, [
      "--auto",
      "--once",
      "-y",
      "--no-review",
      "40",
    ]);

    expect(r.out).toContain(
      "#40: the rebase brought a new package.json — no install step (install: [] in slice.config.ts)",
    );
    expect(read(log)).toBe("gate\n");
    expect(r.code).toBe(0);
    expect(git(c!.main, "log", "-1", "--format=%s")).toBe("feat: a");
  });
});

/**
 * A land that pushed and was cut off before it finished leaves a record (see
 * slice-land.sh). A failing close stands in for the cut here: it leaves the
 * record, the ticket open, and the worktree and branch gone.
 */
describe("a land interrupted after its push", () => {
  const interrupt = (n: number) => {
    commitIn(c!.wt(n), `${n}.txt`, `${n}\n`, `feat: ${n}`);
    c!.closeFails(true);
    shResult(c!.main, `./scripts/slice-land.sh ${n}`);
    c!.closeFails(false);
    expect(existsSync(join(c!.main, ".git", `azelf-landed-${n}.txt`))).toBe(
      true,
    );
  };

  it("is finished by the run, never prepped again", () => {
    c = makeConsumer({ worktrees: [40], remote: true, agent: ["true"] });
    interrupt(40);

    const r = runDispatcher(c, ["--auto", "--once", "-y", "--no-review", "40"]);

    expect(r.out).toContain(
      "#40: its land was interrupted after the push — finishing it …",
    );
    expect(r.out).toContain("✓ finished the land of #40");
    expect(r.out).not.toContain("✓ prepped");
    expect(existsSync(c.wt(40))).toBe(false);
    expect(readFileSync(c.closeFile, "utf8")).toContain("40\nLanded on main");
    expect(existsSync(join(c.main, ".git", "azelf-landed-40.txt"))).toBe(false);
    expect(r.code).toBe(0);
  });

  it("is named, and left alone, when its ticket is not in the run", () => {
    c = makeConsumer({ worktrees: [40, 41], remote: true, agent: ["true"] });
    interrupt(41);
    commitIn(c.wt(40), "a.txt", "a\n", "feat: a");
    sh(c.wt(40), "./scripts/slice-done.sh");

    const r = runDispatcher(c, ["--auto", "--once", "-y", "--no-review", "40"]);

    expect(r.out).toContain(
      "#41: its land was interrupted after the push — ./scripts/slice-land.sh 41 finishes it",
    );
    expect(r.out).not.toContain("finishing the land of #41");
    expect(existsSync(join(c.main, ".git", "azelf-landed-41.txt"))).toBe(true);
    expect(readFileSync(c.closeFile, "utf8")).not.toContain("41\n");
    expect(git(c.main, "log", "-1", "--format=%s")).toBe("feat: a");
  });

  /** Finishing runs the land's last step too, afterLand included. */
  it("stops the run before any other land when its afterLand fails", () => {
    c = makeConsumer({
      worktrees: [40, 41],
      remote: true,
      agent: ["true"],
      configExtra: 'afterLand: ["false"],',
    });
    interrupt(40);
    commitIn(c.wt(41), "b.txt", "b\n", "feat: b");
    sh(c.wt(41), "./scripts/slice-done.sh");

    const r = runDispatcher(c, [
      "--auto",
      "-y",
      "--no-review",
      "--interval",
      "1",
      "40",
      "41",
    ]);

    expect(r.out).toContain("✓ finished the land of #40");
    expect(r.out).toContain(
      "stopping: #40 landed, and afterLand failed after it.",
    );
    expect(r.out).not.toContain("landing #41");
    expect(readFileSync(c.closeFile, "utf8")).toContain("40\nLanded on main");
    expect(git(c.main, "log", "-1", "--format=%s")).toBe("feat: 40");
    expect(r.code).toBe(1);
  });
});

describe("what the run log says after a land", () => {
  it("does not count the landed ticket, and preps the next in one line", async () => {
    c = makeConsumer({ worktrees: [40], remote: true, agent: ["true"] });
    c.setTicket("40", {});
    c.setTicket("41", { blockedBy: ["40"] });
    commitIn(c.wt(40), "a.txt", "a\n", "feat: a");
    sh(c.wt(40), "./scripts/slice-done.sh");

    d = startDispatcher(c, ["-y", "--interval", "1", "40", "41"]);
    await d.until(
      "[round 1] 1 running · 0 blocked · 1 open — land one to advance",
    );
    expect(d.output()).toContain(`✓ prepped — worktree ready at ${c.wt(41)}\n`);
    expect(d.output()).toContain("fetching origin/main …");
    expect(d.output()).not.toContain("launch it with");
    expect(d.output()).not.toContain("not launched");

    // 41 was cut after 40 landed, so it contains a.txt's commit already.
    commitIn(c.wt(41), "a.txt", "a\nb\n", "feat: more a");
    await d.until(/(\[round \d+\] 1 running[\s\S]*){4}/);
    expect(d.output()).not.toContain("editing the same files");
  }, 60_000);

  it("still warns for a slice that was open when the other landed", async () => {
    c = makeConsumer({ worktrees: [40, 41], remote: true, agent: ["true"] });
    commitIn(c.wt(40), "a.txt", "a\n", "feat: a");
    sh(c.wt(40), "./scripts/slice-done.sh");
    sessions.push(fakeSession(c, 41));

    d = startDispatcher(c, ["-y", "--interval", "1", "40", "41"]);
    await d.until("[round 1] 1 running · 0 blocked · 1 open");
    // 41 was cut before the land: its branch does not contain 40's commit.
    commitIn(c.wt(41), "a.txt", "b\n", "feat: another a");
    await d.until(/#40✓ #41 {2}a\.txt/);
    expect(d.output()).toContain("✓ = already landed");
    // Both added a.txt with different text: the open one meets a conflict at
    // its rebase, and the report says so — the base stands in for the landed.
    expect(d.output()).toContain("⚠ slices will conflict at the land");
  }, 60_000);

  it("reads a finished slice behind another land as to land, not blocked", () => {
    c = makeConsumer({ worktrees: [40, 41], remote: true });
    commitIn(c.wt(40), "a.txt", "a\n", "feat: a");
    commitIn(c.wt(41), "b.txt", "b\n", "feat: b");
    sh(c.wt(40), "./scripts/slice-done.sh");
    sh(c.wt(41), "./scripts/slice-done.sh");

    const r = runDispatcher(c, ["-y", "--interval", "1", "40", "41"]);

    expect(r.out).toContain(
      "[round 1] 0 running · 1 to land · 0 blocked · 1 open — land one to advance",
    );
    expect(r.code).toBe(0);
  });
});

/**
 * Without --auto a session finishes, says so in its tab and sits at its
 * prompt, and its shell is alive: on consumer-b the run said "3 running" for
 * hours over three sessions that were done inside ten minutes, and the report
 * each wrote was in its tab and nowhere else. slice-finished.sh is what a
 * session says instead; the dispatcher counts it as waiting for a person and
 * names the report. It lands nothing: slice-done.sh stays the act that does.
 */
describe("a session whose turn is over", () => {
  const finished = () => {
    const fx = makeConsumer({ worktrees: [40], remote: true, agent: ["true"] });
    commitIn(fx.wt(40), "a.txt", "a\n", "feat: a");
    sessions.push(fakeSession(fx, 40));
    return fx;
  };

  it("is waiting for you, not running, until its branch moves or it is marked done", async () => {
    c = finished();
    d = startDispatcher(c, ["-y", "--interval", "1", "40"]);
    await d.until("[round 1] 1 running · 0 blocked · 1 open");

    sh(
      c.wt(40),
      "./scripts/slice-finished.sh -m 'Built a.txt. Look at line 1.'",
    );
    await d.until("0 running · 1 waiting for you · 0 blocked · 1 open");
    const head = git(c.wt(40), "rev-parse", "--short=7", "HEAD");
    expect(d.output()).toContain(
      `#40 finished its turn at ${head} — report in ${c.wt(
        40,
      )}/.slice-finished\n  read it, then ./scripts/slice-done.sh there lands it, or tell the session to go on`,
    );
    expect(d.output()).not.toContain("landing #40");

    // The session went on: the marker names an older head, and it is running.
    commitIn(c.wt(40), "a.txt", "aa\n", "feat: more a");
    await d.until(/(1 running · 0 blocked · 1 open[\s\S]*){2}/);

    // Said again at the new head, once.
    sh(c.wt(40), "./scripts/slice-finished.sh -m 'Built more a.'");
    await d.until(/(finished its turn at [\s\S]*){2}/);
    expect(d.output().match(/finished its turn at/g)?.length).toBe(2);

    // Marked done: the marker goes, and the slice is to land.
    sh(c.wt(40), "./scripts/slice-done.sh");
    expect(existsSync(join(c.wt(40), ".slice-finished"))).toBe(false);
    await d.until("✓ closed #40");
  }, 60_000);

  it("says a stuck session is stuck, with the first line of its report", async () => {
    c = finished();
    writeFileSync(join(c.wt(40), "b.txt"), "half\n");
    sh(
      c.wt(40),
      "./scripts/slice-finished.sh --stuck -m $'gates red: test_b fails\\nb.txt is uncommitted'",
    );

    d = startDispatcher(c, ["-y", "--interval", "1", "40"]);
    await d.until("0 running · 1 waiting for you · 0 blocked · 1 open");
    expect(d.output()).toContain(
      `#40 is stuck: gates red: test_b fails\n  its report: ${c.wt(
        40,
      )}/.slice-finished — a person takes it from here`,
    );
  }, 60_000);

  // A run that ends (--once here, a signal in the next test) says
  // at the end what is still waiting, and what releases it.
  it("lists them when the run exits", () => {
    c = finished();
    sh(c.wt(40), "./scripts/slice-finished.sh -m 'Built a.txt.'");

    const r = runDispatcher(c, ["-y", "--once", "40"]);

    // --once stops before the round line; the block at the end is the point.
    expect(r.out).toContain("── waiting for you (1)");
    const head = git(c.wt(40), "rev-parse", "--short=7", "HEAD");
    expect(r.out).toContain(
      `  #40  finished at ${head}\n     report: ${c.wt(
        40,
      )}/.slice-finished\n     ./scripts/slice-done.sh in ${c.wt(40)} lands it`,
    );
    expect(r.out).toContain("Their sessions are still open in their tabs");
  });

  // A run stopped by a signal used to end where it stood, with none of this.
  it("lists them when the run is stopped with SIGTERM, and exits 143", async () => {
    c = finished();
    sh(c.wt(40), "./scripts/slice-finished.sh -m 'Built a.txt.'");

    d = startDispatcher(c, ["-y", "--interval", "30", "40"]);
    await d.until("1 waiting for you");
    const code = await d.stop();

    expect(code).toBe(143);
    expect(d.output()).toContain(
      "SIGTERM — stopping after this round. Sessions keep running in their tabs.",
    );
    expect(d.output()).toContain("── waiting for you (1)");
    expect(d.output()).toContain(
      "To pick the run up again:\n\n    ./scripts/azelf run -y --interval 30 40",
    );
  }, 60_000);
});

/**
 * `azelf run` passes a stop signal on to the dispatcher it started. It used
 * to block in spawnSync: a SIGINT sent to its pid alone ended the wrapper,
 * and slice-run.ts ran on under init, holding its claims, so consumer-b's
 * restart of its backend dispatcher was refused as "already being dispatched
 * by another run".
 */
describe("the wrapper passes signals on", () => {
  const waiting = () => {
    const fx = makeConsumer({ worktrees: [40], remote: true, agent: ["true"] });
    commitIn(fx.wt(40), "a.txt", "a\n", "feat: a");
    sessions.push(fakeSession(fx, 40));
    sh(fx.wt(40), "./scripts/slice-finished.sh -m 'Built a.txt.'");
    return fx;
  };

  for (const [sig, code] of [
    ["SIGINT", 130],
    ["SIGTERM", 143],
  ] as const) {
    it(`stops the dispatcher on a ${sig} to the wrapper alone, which exits with its code`, async () => {
      c = waiting();
      d = startAzelf(c, ["run", "-y", "--interval", "30", "40"]);
      await d.until("1 waiting for you");
      expect(existsSync(claimOf(c, "40"))).toBe(true);

      process.kill(d.pid, sig);
      expect(await d.exited).toBe(code);

      expect(d.output()).toContain(
        `${sig} — stopping after this round. Sessions keep running in their tabs.`,
      );
      // The normal ending, and the claim released with it: the wrapper
      // exits only once the dispatcher has.
      expect(d.output()).toContain("── waiting for you (1)");
      expect(existsSync(claimOf(c, "40"))).toBe(false);
    }, 60_000);
  }

  /**
   * Ctrl-C signals the whole foreground group: the dispatcher gets the
   * terminal's SIGINT, and the wrapper's forwarded copy a moment later. A
   * second signal quits at once, with no ending and no resume command, and
   * the copy must not be taken for one. The gate here ignores SIGINT and goes
   * on, as a long suite that traps it would, so both copies arrive while the
   * dispatcher is busy.
   */
  it("stops after the round under Ctrl-C, though the dispatcher gets SIGINT twice", async () => {
    const started = join(tmpdir(), `azelf-gate-${process.pid}-${Date.now()}`);
    c = makeConsumer({
      worktrees: [40],
      remote: true,
      agent: ["true"],
      gate: ["bash", "-c", `trap '' INT; touch ${started}; sleep 2`],
    });
    commitIn(c.wt(40), "a.txt", "a\n", "feat: a");
    sh(c.wt(40), "./scripts/slice-done.sh");

    d = startAzelf(c, ["run", "-y", "--no-review", "--interval", "30", "40"], {
      group: true,
    });
    const deadline = Date.now() + 20_000;
    while (!existsSync(started) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
    }
    rmSync(started, { force: true });

    process.kill(-d.pid, "SIGINT");
    expect(await d.exited).toBe(130);

    expect(d.output()).toContain("SIGINT — stopping after this round.");
    expect(d.output()).toContain("To pick the run up again:");
    expect(existsSync(claimOf(c, "40"))).toBe(false);
  }, 60_000);

  /**
   * `provision` and `push-main` run bash: a stand-in on PATH that records
   * its pid and sleeps, so the signal finds it still running.
   */
  for (const args of [["provision", "40"], ["push-main"]]) {
    it(`leaves no child behind for azelf ${args[0]} under SIGTERM`, async () => {
      c = makeConsumer({});
      const bin = join(c.root, "fake-bin");
      mkdirSync(bin);
      const pidFile = join(c.root, "child.pid");
      writeFileSync(
        join(bin, "bash"),
        `#!/bin/sh\necho $$ > "${pidFile}"\nexec sleep 30\n`,
      );
      chmodSync(join(bin, "bash"), 0o755);

      d = startAzelf(c, args, {
        env: { PATH: `${bin}:${process.env.PATH}` },
      });
      const deadline = Date.now() + 10_000;
      while (!existsSync(pidFile) && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 50));
      }
      const child = Number(readFileSync(pidFile, "utf8").trim());

      process.kill(d.pid, "SIGTERM");
      expect(await d.exited).toBe(143);
      const alive = (() => {
        try {
          process.kill(child, 0);
          return true;
        } catch {
          return false;
        }
      })();
      expect(alive).toBe(false);
    }, 30_000);
  }
});

/**
 * A live session that shows no sign of work is quiet, not running. On
 * consumer-b a session died when the Mac slept and the run said "1 running"
 * for 1.5 hours. Everything a sign could come from is backdated here.
 */
describe("a quiet session", () => {
  const old = (path: string) => {
    const t = new Date(Date.now() - 10 * 60_000);
    utimesSync(path, t, t);
  };
  const quietOne = (extra = "quietAfterMinutes: 1,") => {
    const fx = makeConsumer({
      worktrees: [40],
      remote: true,
      agent: ["true"],
      configExtra: extra,
    });
    writeFileSync(join(fx.wt(40), "a.txt"), "a\n");
    git(fx.wt(40), "add", "a.txt");
    sh(
      fx.wt(40),
      `GIT_COMMITTER_DATE=@${
        Math.floor(Date.now() / 1000) - 600
      } git commit -qm 'feat: a' --date=@${
        Math.floor(Date.now() / 1000) - 600
      }`,
    );
    sessions.push(fakeSession(fx, 40));
    old(join(fx.wt(40), ".slice-live"));
    return fx;
  };
  const cfg = () => {
    const dir = join(tmpdir(), `azelf-claude-${process.pid}-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    return dir;
  };

  it("is counted apart from running and said once, until a file changes", async () => {
    c = quietOne();
    d = startDispatcher(c, ["-y", "--interval", "1", "40"], {
      env: { CLAUDE_CONFIG_DIR: cfg() },
    });

    await d.until("0 running · 1 quiet · 0 blocked · 1 open");
    expect(d.output()).toMatch(
      /#40 has been quiet for 10 min — no changed file, no commit since \d\d:\d\d\n {2}its session may have stopped \(the Mac slept, an API error\), be waiting at its prompt, or still be thinking: look at its tab/,
    );
    await d.until(/(\[round \d+\][^\n]*\n[\s\S]*){3}/);
    expect(d.output().match(/has been quiet for/g)?.length).toBe(1);

    writeFileSync(join(c.wt(40), "b.txt"), "b\n");
    await d.until("1 running · 0 blocked · 1 open");
    await d.stop();
    expect(d.output()).not.toContain("── quiet (");
  }, 60_000);

  it("is not quiet while its transcript moves, and names the transcript when it stops", () => {
    c = quietOne();
    const root = cfg();
    const dir = join(
      root,
      "projects",
      realpathSync(c.wt(40)).replace(/[^a-zA-Z0-9]/g, "-"),
    );
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "s.jsonl"), "{}\n");

    const live = runDispatcher(c, ["-y", "--once", "40"], {
      env: { CLAUDE_CONFIG_DIR: root },
    });
    expect(live.out).not.toContain("has been quiet");

    old(join(dir, "s.jsonl"));
    const quiet = runDispatcher(c, ["-y", "--once", "40"], {
      env: { CLAUDE_CONFIG_DIR: root },
    });
    expect(quiet.out).toContain(
      "#40 has been quiet for 10 min — no changed file, no commit, nothing in its transcript since",
    );
    expect(quiet.out).toContain("── quiet (1)");
    expect(quiet.out).toContain("  #40  no sign of work since ");
  });

  it("is never said with quietAfterMinutes: 0", () => {
    c = quietOne("quietAfterMinutes: 0,");
    const r = runDispatcher(c, ["-y", "--once", "40"], {
      env: { CLAUDE_CONFIG_DIR: cfg() },
    });
    expect(r.out).not.toContain("has been quiet");
    expect(r.out).not.toContain("── quiet (");
  });
});

/**
 * caffeinate for the life of the run, on macOS: started with the run's pid,
 * so it ends when the run does.
 */
describe("keepAwake", () => {
  it.runIf(process.platform === "darwin")(
    "keeps the Mac awake while the run lasts, and not after",
    async () => {
      c = makeConsumer({
        worktrees: [40],
        remote: true,
        agent: ["true"],
        configExtra: "keepAwake: true,",
      });
      sessions.push(fakeSession(c, 40));
      d = startDispatcher(c, ["-y", "--interval", "1", "40"]);
      await d.until("keeping this Mac awake while the run lasts");
      const pgrep = () =>
        spawnSync("pgrep", ["-f", `caffeinate -is -w ${d?.pid}$`], {
          encoding: "utf8",
        }).stdout.trim();
      expect(pgrep()).not.toBe("");

      await d.stop();
      const deadline = Date.now() + 5000;
      while (pgrep() && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 100));
      }
      expect(pgrep()).toBe("");
    },
    60_000,
  );

  it("is off with keepAwake: false, and for --once", () => {
    c = makeConsumer({ worktrees: [40], remote: true, agent: ["true"] });
    sessions.push(fakeSession(c, 40));
    expect(runDispatcher(c, ["-y", "--once", "40"]).out).not.toContain(
      "keeping this Mac awake",
    );
  });
});

/**
 * On battery a closed lid sleeps the Mac whatever caffeinate holds, and a
 * sleeping Mac pauses the run. On consumer-b's #227 evening both happened and
 * the run said neither. The power source comes from a stand-in `pmset`
 * (fixture.ts) reading the file FAKE_PMSET names.
 */
describe("the run says when the Mac sleeps", () => {
  const BATTERY_LINE = "on battery: closing the lid puts this Mac to sleep";
  const ASLEEP = "this Mac was asleep";
  const count = (part: string) => (d?.output() ?? "").split(part).length - 1;
  const rounds = () => (d?.output().match(/\[round \d+\]/g) ?? []).length;
  const waitFor = async (what: string, ok: () => boolean, ms = 20_000) => {
    const end = Date.now() + ms;
    while (!ok()) {
      if (Date.now() > end) {
        throw new Error(`timed out waiting for ${what}:\n${d?.output()}`);
      }
      await new Promise((r) => setTimeout(r, 100));
    }
  };
  /** Two more round lines than now: the state has been read again since. */
  const twoMoreRounds = () => {
    const now = rounds();
    return waitFor("two more rounds", () => rounds() >= now + 2);
  };
  const running = (power: string) => {
    c = makeConsumer({ worktrees: [40], remote: true, agent: ["true"] });
    sessions.push(fakeSession(c, 40));
    const file = join(c.root, "power");
    writeFileSync(file, power);
    return file;
  };

  it.runIf(process.platform === "darwin")(
    "says it is on battery at the start, once",
    async () => {
      const power = running(PMSET_BATTERY);
      d = startDispatcher(c!, ["-y", "--interval", "1", "40"], {
        env: { FAKE_PMSET: power },
      });
      await d.until(/\[round 3\]/);
      expect(count(BATTERY_LINE)).toBe(1);
      expect(d.output()).toContain(
        "the run and its sessions pause until it wakes. Keep the lid open, or plug it in.",
      );
    },
    60_000,
  );

  it.runIf(process.platform === "darwin")(
    "says nothing on mains power, and says it once at each change to battery",
    async () => {
      const power = running(PMSET_AC);
      d = startDispatcher(c!, ["-y", "--interval", "1", "40"], {
        env: { FAKE_PMSET: power },
      });
      await d.until(/\[round 2\]/);
      expect(count(BATTERY_LINE)).toBe(0);

      writeFileSync(power, PMSET_BATTERY);
      await waitFor("the battery line", () => count(BATTERY_LINE) === 1);
      await twoMoreRounds();
      expect(count(BATTERY_LINE)).toBe(1);

      // Plugged in, then out again: a new change to battery, said again.
      writeFileSync(power, PMSET_AC);
      await twoMoreRounds();
      writeFileSync(power, PMSET_BATTERY);
      await waitFor("the second battery line", () => count(BATTERY_LINE) === 2);
    },
    60_000,
  );

  it("is not said for --once", () => {
    const power = running(PMSET_BATTERY);
    expect(
      runDispatcher(c!, ["-y", "--once", "40"], { env: { FAKE_PMSET: power } })
        .out,
    ).not.toContain(BATTERY_LINE);
  });

  /**
   * A stopped process stands in for a sleeping Mac: either way the wait
   * between two rounds takes longer by the wall clock than --interval.
   */
  it("says the run was paused when a wait between rounds took far longer than the interval", async () => {
    running(PMSET_AC);
    d = startDispatcher(c!, ["-y", "--interval", "2", "40"], {
      env: { SLICE_SLEEP_GAP_SECONDS: "1" },
    });
    await d.until(/\[round 2\]/);
    expect(count(ASLEEP)).toBe(0);

    process.kill(d.pid, "SIGSTOP");
    await new Promise((r) => setTimeout(r, 3000));
    process.kill(d.pid, "SIGCONT");

    await d.until(
      /this Mac was asleep, or this run was stopped, for about \d+ s between \d\d:\d\d and \d\d:\d\d; the run was paused, and so were its sessions/,
    );
    await twoMoreRounds();
    expect(count(ASLEEP)).toBe(1);
  }, 60_000);
});

/**
 * The overlap report asks git whether a pair will conflict. Two slices that
 * raised one inventory total by one (consumer-b, #89 and #109) shared a file
 * and conflicted at the land; the report used to say the opposite — "edits
 * that CLASH are already caught, these apply cleanly" — and the second to land
 * was parked at its rebase an hour later.
 */
describe("which overlaps will conflict", () => {
  // The base has a five-line file, and both slices are cut on top of it.
  const onFile = () => {
    const fx = makeConsumer({
      worktrees: [40, 41],
      remote: true,
      agent: ["true"],
    });
    commitIn(fx.main, "n.txt", "1\n2\n3\n4\n5\n", "chore: n");
    git(fx.main, "push", "-q", "origin", "main");
    for (const n of [40, 41]) git(fx.wt(n), "rebase", "-q", "main");
    return fx;
  };

  it("says a pair that edits one line will conflict, and names the file", () => {
    c = onFile();
    commitIn(c.wt(40), "n.txt", "1\n2\n3a\n4\n5\n", "feat: 40");
    commitIn(c.wt(41), "n.txt", "1\n2\n3b\n4\n5\n", "feat: 41");
    sessions.push(fakeSession(c, 40), fakeSession(c, 41));

    const r = runDispatcher(c, ["-y", "--once", "40", "41"]);

    expect(r.out).toContain(
      "⚠ slices will conflict at the land\n     #40 #41  n.txt",
    );
    expect(r.out).toContain("meets this at its rebase: the resolver,");
    expect(r.out).not.toContain("editing the same files");
  });

  it("keeps a pair that merges clean under the soft warning", () => {
    c = onFile();
    commitIn(c.wt(40), "n.txt", "1a\n2\n3\n4\n5\n", "feat: 40");
    commitIn(c.wt(41), "n.txt", "1\n2\n3\n4\n5b\n", "feat: 41");
    sessions.push(fakeSession(c, 40), fakeSession(c, 41));

    const r = runDispatcher(c, ["-y", "--once", "40", "41"]);

    expect(r.out).toContain(
      "⚠ slices are editing the same files\n     #40 #41  n.txt",
    );
    expect(r.out).toContain("merge cleanly onto each other");
    expect(r.out).not.toContain("will conflict at the land");
  });

  it("reprints when a later commit turns clean into a conflict", async () => {
    c = onFile();
    commitIn(c.wt(40), "n.txt", "1a\n2\n3\n4\n5\n", "feat: 40");
    commitIn(c.wt(41), "n.txt", "1\n2\n3\n4\n5b\n", "feat: 41");
    sessions.push(fakeSession(c, 40), fakeSession(c, 41));

    d = startDispatcher(c, ["-y", "--interval", "1", "40", "41"]);
    await d.until("⚠ slices are editing the same files");
    commitIn(c.wt(41), "n.txt", "1b\n2\n3\n4\n5b\n", "feat: 41 again");
    await d.until("⚠ slices will conflict at the land\n     #40 #41  n.txt");
  }, 60_000);

  // Before 2.38 git has no `merge-tree --write-tree`. A `git` first on PATH
  // that refuses the flag the way an old one does, and is the real one for
  // everything else.
  it("falls back to file names, once, on a git without merge-tree --write-tree", () => {
    c = onFile();
    commitIn(c.wt(40), "n.txt", "1\n2\n3a\n4\n5\n", "feat: 40");
    commitIn(c.wt(41), "n.txt", "1\n2\n3b\n4\n5\n", "feat: 41");
    sessions.push(fakeSession(c, 40), fakeSession(c, 41));
    const realGit = spawnSync("bash", ["-c", "command -v git"], {
      encoding: "utf8",
    }).stdout.trim();
    const bin = join(c.root, "old-git");
    mkdirSync(bin);
    writeFileSync(
      join(bin, "git"),
      `#!/usr/bin/env bash
if [[ "$1" == merge-tree && " $* " == *" --write-tree "* ]]; then
  echo "error: unknown option \\\`write-tree'" >&2
  echo "usage: git merge-tree [--write-tree] [<options>] <branch1> <branch2>" >&2
  exit 129
fi
exec ${realGit} "$@"
`,
    );
    chmodSync(join(bin, "git"), 0o755);

    const r = runDispatcher(c, ["-y", "--once", "40", "41"], {
      env: { PATH: `${bin}:${process.env.PATH}` },
    });

    expect(r.out).toContain(
      "note: this git cannot say which overlapping slices will conflict (error: unknown option `write-tree'); git 2.38 or later can.",
    );
    expect(r.out.match(/this git cannot say/g)?.length).toBe(1);
    expect(r.out).toContain(
      "⚠ slices are editing the same files\n     #40 #41  n.txt",
    );
    expect(r.out).toContain(
      "A land rebases, so edits that CLASH are caught there.",
    );
    expect(r.out).not.toContain("will conflict at the land");
  });
});

/**
 * The spec reviewer is text in, text out: it cannot fetch the parent spec, so
 * the dispatcher pastes it. The fake reviewer writes every prompt it is given
 * next to the worktree.
 */
describe("the spec review and the parent spec", () => {
  const RECORD = [
    "bash",
    "-c",
    `${RECORD_PROMPT}; echo "VERDICT: PASS"`,
    "reviewer",
  ];
  const specPrompt = (fx: Consumer) =>
    readFileSync(join(fx.root, "prompts"), "utf8")
      .split("\n=====\n")
      .find((p) => p.includes("faithfully implement the spec")) ?? "";
  const reviewed = (body: string) => {
    const fx = makeConsumer({ worktrees: [40], remote: true, review: RECORD });
    c = fx;
    fx.setTicket("40", { title: "Filter pills", body });
    fx.setTicket("17", {
      title: "Spec: the feed",
      body: "Pills are single-select. PARENT-DECISION",
      ready: false,
    });
    commitIn(fx.wt(40), "a.txt", "a\n", "feat: a");
    sh(fx.wt(40), "./scripts/slice-done.sh");
    const r = runDispatcher(fx, ["--review", "-y", "--interval", "1", "40"]);
    expect(r.out).toContain("landing #40");
    return { fx, r };
  };

  it("pastes the parent a ticket names, and says the parent decides", () => {
    const { fx } = reviewed("Build the pills.\n\n## Parent\n\n#17\n");
    const prompt = specPrompt(fx);
    expect(prompt).toContain(
      "PARENT SPEC:\n#17 — Spec: the feed\n\nPills are single-select. PARENT-DECISION",
    );
    expect(prompt).toContain('"ticket and parent disagree"');
    expect(prompt.indexOf("PARENT SPEC:")).toBeGreaterThan(
      prompt.indexOf("SPEC:\n#40 — Filter pills"),
    );
  });

  it("leaves the prompt as it was for a ticket with no parent", () => {
    const { fx } = reviewed("Build the pills.");
    const prompt = specPrompt(fx);
    expect(prompt).toContain("SPEC:\n#40 — Filter pills");
    expect(prompt).not.toContain("PARENT");
    expect(prompt).not.toContain("parent");
  });

  /**
   * `reviewReadDirs`: the spec reviewer is told where else to look, and the
   * agent is given the directories (fixture.ts passes them after the prompt;
   * sliceAgent.test.ts has claude's flag). The standards review is about this
   * repo and is told nothing.
   */
  it("names the directories the reviewer may read beyond the worktree", () => {
    const fx = makeConsumer({
      worktrees: [40],
      remote: true,
      review: [
        "bash",
        "-c",
        `${RECORD_PROMPT}; shift; printf "%s\\n" "$@" >> ../dirs; echo "VERDICT: PASS"`,
        "reviewer",
      ],
      configExtra: 'reviewReadDirs: ["../extra"],',
    });
    c = fx;
    mkdirSync(join(fx.root, "extra"));
    commitIn(fx.wt(40), "a.txt", "a\n", "feat: a");
    sh(fx.wt(40), "./scripts/slice-done.sh");
    const r = runDispatcher(fx, ["--review", "-y", "--interval", "1", "40"]);
    expect(r.out).toContain("landing #40");

    expect(specPrompt(fx)).toContain(
      "You may also read these directories outside the worktree, where this repo's tickets place facts the repo does not hold (another repo's fields, a spec folder): ",
    );
    expect(specPrompt(fx)).toContain(
      "/extra. What you find there counts as checked.",
    );
    const standards = readFileSync(join(fx.root, "prompts"), "utf8")
      .split("\n=====\n")
      .find((p) => p.includes("coding standards"));
    expect(standards).not.toContain("You may also read");
    expect(readFileSync(join(fx.root, "dirs"), "utf8")).toMatch(/\/extra\n/);
  });

  describe("a read dir is only as fresh as its last run", () => {
    /** A review that logs its prompt, its directories and what it found there. */
    const LOG_REVIEW = [
      "bash",
      "-c",
      `${RECORD_PROMPT}
case "$1" in *"coding standards"*) axis=standards ;; *) axis=spec ;; esac
shift
echo "$axis $#" >> ../dir-counts
for d in "$@"; do
  printf "%s\\n" "$d" >> ../dirs
  [[ -f "$d/new.txt" ]] && echo found >> ../found
done
echo "VERDICT: PASS"`,
      "reviewer",
    ];

    /** A consumer whose read dir `../frontend` is a clone of a bare origin. */
    const withClone = () => {
      const fx = makeConsumer({
        worktrees: [40],
        remote: true,
        review: LOG_REVIEW,
        configExtra: 'reviewReadDirs: ["../frontend"],',
      });
      c = fx;
      const origin = join(fx.root, "frontend.git");
      const seed = join(fx.root, "frontend-seed");
      git(fx.root, "init", "-q", "--bare", "-b", "main", origin);
      git(fx.root, "clone", "-q", origin, seed);
      commitIn(seed, "old.txt", "old\n", "old");
      git(seed, "push", "-q", "origin", "HEAD:main");
      git(fx.root, "clone", "-q", origin, join(fx.root, "frontend"));
      commitIn(fx.wt(40), "a.txt", "a\n", "feat: a");
      sh(fx.wt(40), "./scripts/slice-done.sh");
      return { fx, seed, origin };
    };
    const dirsOf = (fx: Consumer) =>
      readFileSync(join(fx.root, "dirs"), "utf8").trim().split("\n");
    const land = (fx: Consumer) =>
      runDispatcher(fx, ["--review", "-y", "--interval", "1", "40"]);

    it("one behind origin reaches the agent as an export of origin's head, removed at the end", () => {
      const { fx, seed } = withClone();
      commitIn(seed, "new.txt", "new\n", "new");
      git(seed, "push", "-q", "origin", "HEAD:main");
      const originHead = git(seed, "rev-parse", "HEAD");

      const r = land(fx);
      expect(r.out).toContain("landing #40");

      const [dir] = dirsOf(fx);
      expect(dir).toMatch(
        new RegExp(`azelf-read-\\d+/frontend-${originHead.slice(0, 12)}$`),
      );
      // It had the file the checkout lacks, when the reviewer read it.
      expect(readFileSync(join(fx.root, "found"), "utf8")).toBe("found\n");
      expect(specPrompt(fx)).toContain(
        `${dir} is origin's head (${originHead.slice(0, 12)})`,
      );
      expect(r.out).toContain(`read dir: ${dir} is origin's head`);
      // The checkout did not move, and the export is gone.
      expect(existsSync(join(fx.root, "frontend", "new.txt"))).toBe(false);
      expect(existsSync(dir as string)).toBe(false);
    }, 60_000);

    it("one level with origin reaches the agent as itself", () => {
      const { fx } = withClone();
      expect(land(fx).out).toContain("landing #40");

      expect(dirsOf(fx)).toEqual([join(fx.root, "frontend")]);
      expect(specPrompt(fx)).toMatch(
        /\/frontend has origin's head \([0-9a-f]{12}\)\./,
      );
    }, 60_000);

    it("one that cannot be fetched is used as it is, and the prompt says it may be behind", () => {
      const { fx, origin } = withClone();
      rmSync(origin, { recursive: true, force: true });
      expect(land(fx).out).toContain("landing #40");

      expect(dirsOf(fx)).toEqual([join(fx.root, "frontend")]);
      expect(specPrompt(fx)).toContain(
        "/frontend may be behind origin (the fetch failed)",
      );
    }, 60_000);

    it("the standards review gets no directories, and is told of none", () => {
      const { fx } = withClone();
      expect(land(fx).out).toContain("landing #40");
      expect(
        readFileSync(join(fx.root, "dir-counts"), "utf8")
          .trim()
          .split("\n")
          .sort(),
      ).toEqual(["spec 1", "standards 0"]);
    }, 60_000);
  });

  it("the spec review is told of .slice-refs.md only when the worktree has it", () => {
    const review = [
      "bash",
      "-c",
      `${RECORD_PROMPT}; echo "VERDICT: PASS"`,
      "reviewer",
    ];
    const SENTENCE =
      "The tickets and comments this ticket names are in .slice-refs.md in the worktree";
    const reviewed = (withFile: boolean) => {
      const fx = makeConsumer({ worktrees: [40], remote: true, review });
      c = fx;
      commitIn(fx.wt(40), "a.txt", "a\n", "feat: a");
      if (withFile) writeFileSync(join(fx.wt(40), ".slice-refs.md"), "refs\n");
      sh(fx.wt(40), "./scripts/slice-done.sh");
      runDispatcher(fx, ["--review", "-y", "--interval", "1", "40"]);
      return specPrompt(fx);
    };
    expect(reviewed(true)).toContain(SENTENCE);
    expect(reviewed(false)).not.toContain(SENTENCE);
  }, 60_000);

  it("the config refuses a directory that is not there", () => {
    c = makeConsumer({ configExtra: 'reviewReadDirs: ["../nope"],' });
    const r = runDispatcher(c, ["--plan"]);
    expect(r.code).not.toBe(0);
    expect(r.out).toContain("reviewReadDirs[0] (../nope) is not a directory: ");
  });

  it("says so in the report when the parent cannot be read", () => {
    const fx = makeConsumer({
      worktrees: [40],
      remote: true,
      review: RECORD,
      // A tracker that cannot read #17, as for a ticket in another repository.
      configExtra:
        'tracker: { ...tracker, get: (id) => { if (id === "17") throw new Error("no such ticket"); return tracker.get(id); } },',
    });
    c = fx;
    fx.setTicket("40", { body: "Build.\n\n## Parent\n\n#17\n" });
    commitIn(fx.wt(40), "a.txt", "a\n", "feat: a");
    sh(fx.wt(40), "./scripts/slice-done.sh");
    const r = runDispatcher(fx, ["--review", "-y", "--interval", "1", "40"]);
    expect(r.out).toContain(
      "(the parent spec #17 could not be read — reviewed against the ticket alone)",
    );
    expect(r.out).toContain(
      "  spec review: PASS — 1 thing it could not check:\n    - the parent spec #17 could not be read — reviewed against the ticket alone\n",
    );
    expect(specPrompt(fx)).not.toContain("PARENT SPEC");
    expect(r.out).toContain("landing #40");
  });

  /** #40 under a parent whose body is `size` characters and ends in END. */
  const withParent = (size: number, opts: { file: boolean }) => {
    const fx = makeConsumer({ worktrees: [40], remote: true, review: RECORD });
    c = fx;
    fx.setTicket("40", {
      title: "Filter pills",
      body: "Build.\n\n## Parent\n\n#17\n",
    });
    fx.setTicket("17", {
      title: "Spec: the feed",
      body: `${"x".repeat(size - 3)}END`,
      ready: false,
    });
    if (opts.file) {
      writeFileSync(join(fx.wt(40), ".slice-parent.md"), "the whole parent\n");
    }
    commitIn(fx.wt(40), "a.txt", "a\n", "feat: a");
    sh(fx.wt(40), "./scripts/slice-done.sh");
    const r = runDispatcher(fx, ["--review", "-y", "--interval", "1", "40"]);
    expect(r.out).toContain("landing #40");
    return { fx, r };
  };

  // consumer-a's parent was 22 912 characters, and the old budget of 20 000
  // cut its last section off.
  it("pastes a 30 000-character parent whole", () => {
    const { fx } = withParent(30_000, { file: false });
    expect(specPrompt(fx)).toContain("xEND");
    expect(specPrompt(fx)).not.toContain("truncated");
  });

  it("cuts a longer one, and points at .slice-parent.md when the worktree has it", () => {
    const { fx, r } = withParent(70_000, { file: true });
    const prompt = specPrompt(fx);
    expect(prompt).not.toContain("xEND");
    expect(prompt).toMatch(
      /\[parent spec truncated to 60000 of \d+ chars — the whole text is in \.slice-parent\.md in your working directory; read it there\]/,
    );
    // The reviewer can read the rest, so the cut is nothing it missed.
    expect(r.out).toContain("  spec review: PASS\n");
  });

  it("says in the run log what was cut when there is no file to point at", () => {
    const { fx, r } = withParent(70_000, { file: false });
    expect(specPrompt(fx)).toMatch(
      /\[parent spec truncated to 60000 of \d+ chars\]\n/,
    );
    expect(r.out).toContain(
      "  spec review: PASS — 1 thing it could not check:",
    );
    expect(r.out).toMatch(
      /\n {4}- the parent spec #17 was cut to 60000 of \d+ chars, and the worktree has no \.slice-parent\.md — reviewed against the first part\n/,
    );
  });
});

/**
 * Both reviews run after the gates, and on consumer-a the spec review still
 * tried to run the tests, was refused, and called them unconfirmed in a PASS.
 */
/**
 * A prompt goes to the agent as an argument, and an argument cannot hold a
 * NUL: spawnSync throws on one. On consumer-a a diff carried four, and the
 * throw took the whole run down from inside the spec review.
 */
describe("a review that cannot run", () => {
  const RECORD = [
    "bash",
    "-c",
    `${RECORD_PROMPT}; echo "VERDICT: PASS"`,
    "reviewer",
  ];

  it("writes a NUL in the diff as \\0, and lands", () => {
    const fx = makeConsumer({ worktrees: [40], remote: true, review: RECORD });
    c = fx;
    // The attribute makes git diff the file as text, raw NUL and all.
    commitIn(fx.wt(40), ".gitattributes", "keys.txt diff\n", "chore: attrs");
    commitIn(fx.wt(40), "keys.txt", "id\0name\n", "feat: keys");
    sh(fx.wt(40), "./scripts/slice-done.sh");
    const r = runDispatcher(fx, ["--review", "-y", "--once", "40"]);
    expect(r.out).toContain("landing #40");
    expect(r.code).toBe(0);
    const prompts = readFileSync(join(fx.root, "prompts"), "utf8");
    expect(prompts).toContain("+id\\0name");
    expect(prompts).not.toContain("\0");
  });

  const parked = (review: string[]) => {
    const fx = makeConsumer({ worktrees: [40], remote: true, review });
    c = fx;
    commitIn(fx.wt(40), "a.txt", "a\n", "feat: a");
    sh(fx.wt(40), "./scripts/slice-done.sh");
    return runDispatcher(fx, ["--auto", "--once", "-y", "40"]);
  };

  it("parks a slice whose reviewer cannot be spawned, and the run ends normally", () => {
    // The prompt is made safe; an argument of the reviewer's own is not.
    const r = parked(["bash", "-c", "echo 'VERDICT: PASS'", "rev\0iewer"]);
    expect(r.out).toContain(
      "  spec review: did not run — ERR_INVALID_ARG_VALUE: The argument",
    );
    expect(r.out).toMatch(
      /#40 not landed — the spec review could not run — ERR_INVALID_ARG_VALUE: .*\. Retry it once the reviewer can run \(azelf retry 40\), or land it without the review: \.\/scripts\/slice-land\.sh 40\./,
    );
    expect(r.out).toContain(
      "the spec review could not run — ERR_INVALID_ARG_VALUE",
    );
    expect(r.out).not.toContain("says BLOCK");
    expect(r.out).not.toContain("TypeError");
    expect(r.code).toBe(1);
  });

  it("names a reviewer binary that does not exist", () => {
    const r = parked(["azelf-no-such-reviewer"]);
    expect(r.out).toContain("the spec review could not run — ENOENT");
    expect(r.code).toBe(1);
  });
});

describe("what the spec review is told, and what it says it could not check", () => {
  const land = (opts: Parameters<typeof makeConsumer>[0]) => {
    const fx = makeConsumer({ worktrees: [40], remote: true, ...opts });
    c = fx;
    commitIn(fx.wt(40), "a.txt", "a\n", "feat: a");
    sh(fx.wt(40), "./scripts/slice-done.sh");
    const r = runDispatcher(fx, ["--review", "-y", "--interval", "1", "40"]);
    expect(r.out).toContain("landing #40");
    return { fx, r };
  };

  it("names the gates that passed to both reviews, and tells them to run nothing", () => {
    const { fx } = land({
      gate: ["true"],
      review: [
        "bash",
        "-c",
        `${RECORD_PROMPT}; echo "VERDICT: PASS"`,
        "reviewer",
      ],
    });
    const prompts = readFileSync(join(fx.root, "prompts"), "utf8").split(
      "\n=====\n",
    );
    const said =
      "The gates (`true`) ran on this exact diff, rebased onto main, and passed. Do not run tests, builds, git or gh";
    expect(prompts.find((p) => p.includes("faithfully implement"))).toContain(
      said,
    );
    const standards = prompts.find((p) => p.includes("coding standards")) ?? "";
    expect(standards).toContain(said);
    expect(standards).not.toContain("biome, tsc, vitest");
  });

  it("lists the review's UNVERIFIED lines under its verdict, and still lands", () => {
    const { r } = land({
      review: [
        "bash",
        "-c",
        "printf '%s\\n' 'Looks right.' 'UNVERIFIED: the rejected alternatives (cut off)' '**UNVERIFIED:** the swipe, on a device' 'VERDICT: PASS'",
        "reviewer",
      ],
    });
    expect(r.out).toContain(
      "  spec review: PASS — 2 things it could not check:\n    - the rejected alternatives (cut off)\n    - the swipe, on a device\n",
    );
  });

  it("prints the verdict alone when there is nothing it could not check", () => {
    const { r } = land({
      review: ["bash", "-c", "echo 'VERDICT: PASS'", "reviewer"],
    });
    expect(r.out).toContain("  spec review: PASS\n");
    expect(r.out).not.toContain("could not check");
  });
});

/**
 * Two siblings change one file and both apply cleanly. The one that lands
 * second is reviewed against the first, and is left a note about it while it
 * is still open. `shared.txt` has room for both edits, so no rebase conflicts.
 */
describe("a slice that lands onto a sibling's files", () => {
  const RECORD = [
    "bash",
    "-c",
    `${RECORD_PROMPT}; echo "VERDICT: PASS"`,
    "reviewer",
  ];
  const specPrompts = (fx: Consumer) =>
    readFileSync(join(fx.root, "prompts"), "utf8")
      .split("\n=====\n")
      .filter((p) => p.includes("faithfully implement the spec"));
  const BASE = "top\n\n\n\nmiddle\n\n\n\nbottom\n";

  /** A consumer whose main has shared.txt, and worktrees cut from it. */
  const siblings = (
    opts: Parameters<typeof makeConsumer>[0],
    worktrees: number[],
  ) => {
    const fx = makeConsumer({ remote: true, ...opts });
    c = fx;
    commitIn(fx.main, "shared.txt", BASE, "chore: shared");
    git(fx.main, "push", "-q", "origin", "main");
    for (const n of worktrees) {
      git(fx.main, "worktree", "add", "-q", fx.wt(n), "-b", `ticket/${n}`);
    }
    fx.setTicket("40", { title: "The guard" });
    fx.setTicket("41", { title: "The sibling" });
    commitIn(
      fx.wt(40),
      "shared.txt",
      BASE.replace("top", "top GUARD-LINE"),
      "feat: a guard every writer joins",
    );
    sh(fx.wt(40), "./scripts/slice-done.sh");
    return fx;
  };

  it("shows the second one's review what the first landed, and leaves a note", async () => {
    const fx = siblings({ review: RECORD }, [40, 41]);
    commitIn(
      fx.wt(41),
      "shared.txt",
      BASE.replace("bottom", "bottom SIBLING"),
      "feat: the sibling",
    );
    const session = fakeSession(fx, 41);
    sessions.push(session);

    d = startDispatcher(fx, ["--review", "-y", "--interval", "1", "40", "41"]);
    await d.until("noted in #41's worktree: .slice-landed.md");
    const note = readFileSync(join(fx.wt(41), ".slice-landed.md"), "utf8");
    expect(note).toContain("## #40 — The guard");
    expect(note).toContain("- shared.txt");
    expect(note).toMatch(/ {4}[0-9a-f]+ feat: a guard every writer joins/);
    // Ignored, so the note does not make the slice dirty.
    expect(git(fx.wt(41), "status", "--porcelain")).toBe("");
    // 40's own review had nothing landed under it.
    expect(specPrompts(fx)[0]).not.toContain("LANDED WHILE");
    expect(specPrompts(fx)[0]).not.toContain("(d)");

    await session.stop();
    sh(fx.wt(41), "./scripts/slice-done.sh");
    await d.until("plan complete");

    const prompt = specPrompts(fx)[1] ?? "";
    expect(prompt).toContain("LANDED WHILE THIS SLICE WAS OPEN:");
    expect(prompt).toContain("#40 — The guard");
    expect(prompt).toContain("files this diff also changes: shared.txt");
    expect(prompt).toMatch(/[0-9a-f]+ feat: a guard every writer joins/);
    expect(prompt).toContain("+top GUARD-LINE");
    expect(prompt).toContain(" (d) something the landed work below set up");
    expect(prompt).toContain("BLOCK only for (a), (c) or (d)");
  }, 60_000);

  it("writes the note with review off", async () => {
    const fx = siblings({}, [40, 41]);
    commitIn(
      fx.wt(41),
      "shared.txt",
      BASE.replace("bottom", "bottom SIBLING"),
      "feat: the sibling",
    );
    sessions.push(fakeSession(fx, 41));

    d = startDispatcher(fx, ["-y", "--interval", "1", "40", "41"]);
    await d.until("noted in #41's worktree: .slice-landed.md");
    expect(existsSync(join(fx.wt(41), ".slice-landed.md"))).toBe(true);
  }, 60_000);

  it("says the rebase goes through when it does", async () => {
    const fx = siblings({}, [40, 41]);
    commitIn(
      fx.wt(41),
      "shared.txt",
      BASE.replace("bottom", "bottom SIBLING"),
      "feat: the sibling",
    );
    sessions.push(fakeSession(fx, 41));

    d = startDispatcher(fx, ["-y", "--interval", "1", "40", "41"]);
    await d.until("noted in #41's worktree: .slice-landed.md\n");
    const note = readFileSync(join(fx.wt(41), ".slice-landed.md"), "utf8");
    const at = git(fx.wt(41), "rev-parse", "HEAD").slice(0, 12);
    expect(note).not.toContain(".slice-baseline");
    expect(note).toContain(
      `A rebase onto main goes through cleanly (checked at ${at}, committed work only).`,
    );
    expect(note).not.toContain("Rebasing now conflicts");
  }, 60_000);

  // Both on the line "top": the rebase at 41's land would stop there.
  it("says the rebase conflicts, and in which files, when it does", async () => {
    const fx = siblings({}, [40, 41]);
    commitIn(
      fx.wt(41),
      "shared.txt",
      BASE.replace("top", "top SIBLING"),
      "feat: the sibling",
    );
    sessions.push(fakeSession(fx, 41));
    writeFileSync(
      join(fx.wt(41), ".slice-baseline"),
      "base: 0123456789abcdef\ncommand: true\nexit: 0\n",
    );

    d = startDispatcher(fx, ["-y", "--interval", "1", "40", "41"]);
    await d.until(
      "noted in #41's worktree: .slice-landed.md (rebase conflicts in shared.txt)",
    );
    const note = readFileSync(join(fx.wt(41), ".slice-landed.md"), "utf8");
    expect(note).toContain(
      "### Rebasing now conflicts\n\nA rebase of this branch onto main conflicts in:\n- shared.txt\n",
    );
    expect(note).toContain("Rebase onto main in this worktree now");
    expect(note).toContain(
      "Your .slice-baseline is on 0123456789ab; the base has moved since.",
    );
    expect(note).not.toContain("goes through cleanly");
  }, 60_000);

  it("says neither on a git without merge-tree --write-tree", async () => {
    const fx = siblings({}, [40, 41]);
    commitIn(
      fx.wt(41),
      "shared.txt",
      BASE.replace("top", "top SIBLING"),
      "feat: the sibling",
    );
    sessions.push(fakeSession(fx, 41));
    const realGit = spawnSync("bash", ["-c", "command -v git"], {
      encoding: "utf8",
    }).stdout.trim();
    const bin = join(fx.root, "old-git");
    mkdirSync(bin);
    writeFileSync(
      join(bin, "git"),
      `#!/usr/bin/env bash
if [[ "$1" == merge-tree && " $* " == *" --write-tree "* ]]; then
  echo "usage: git merge-tree [--write-tree] [<options>] <branch1> <branch2>" >&2
  exit 129
fi
exec ${realGit} "$@"
`,
    );
    chmodSync(join(bin, "git"), 0o755);

    d = startDispatcher(fx, ["-y", "--interval", "1", "40", "41"], {
      env: { PATH: `${bin}:${process.env.PATH}` },
    });
    await d.until("noted in #41's worktree: .slice-landed.md\n");
    const note = readFileSync(join(fx.wt(41), ".slice-landed.md"), "utf8");
    expect(note).toContain("- shared.txt");
    expect(note).not.toContain("Rebasing now conflicts");
    expect(note).not.toContain("goes through cleanly");
  }, 60_000);

  it("shows nothing to a slice that was prepped after the land", async () => {
    const fx = siblings({ review: RECORD, agent: ["true"] }, [40]);
    fx.setTicket("41", { blockedBy: ["40"] });

    d = startDispatcher(fx, ["--review", "-y", "--interval", "1", "40", "41"]);
    await d.until(`✓ prepped — worktree ready at ${fx.wt(41)}`);
    commitIn(
      fx.wt(41),
      "shared.txt",
      BASE.replace("top", "top GUARD-LINE").replace("bottom", "bottom SIBLING"),
      "feat: the sibling",
    );
    sh(fx.wt(41), "./scripts/slice-done.sh");
    await d.until("plan complete");

    expect(specPrompts(fx)).toHaveLength(2);
    expect(specPrompts(fx)[1]).not.toContain("LANDED WHILE");
    expect(existsSync(join(fx.wt(41), ".slice-landed.md"))).toBe(false);
    expect(d.output()).not.toContain("noted in");
  }, 60_000);
});

/**
 * `testOnBase`: the test files a slice adds or changes are run against the
 * base as it was before the slice, in a throwaway worktree, and the result
 * goes into the spec review's prompt. Here a "test" is a shell script, and
 * the runner runs each one.
 */
describe("new tests run against the base", () => {
  const RECORD = [
    "bash",
    "-c",
    `${RECORD_PROMPT}; echo "VERDICT: PASS"`,
    "reviewer",
  ];
  const TEST_ON_BASE = `testOnBase: { command: (files) => ["bash", "-c", 'for f in "$@"; do bash "$f" || exit 1; done', "runner", ...files] },`;
  const specPrompt = (fx: Consumer) =>
    readFileSync(join(fx.root, "prompts"), "utf8")
      .split("\n=====\n")
      .find((p) => p.includes("faithfully implement the spec")) ?? "";
  const noThrowaway = (fx: Consumer) => {
    expect(existsSync(`${fx.wt(40)}-base-test`)).toBe(false);
    expect(git(fx.main, "worktree", "list")).not.toContain("base-test");
  };
  /** A slice with a.test.sh running `test`, and fix.txt beside it. */
  const slice = (test: string, configExtra = TEST_ON_BASE) => {
    const fx = makeConsumer({
      worktrees: [40],
      remote: true,
      review: RECORD,
      configExtra,
    });
    c = fx;
    commitIn(fx.wt(40), "fix.txt", "fix\n", "fix: the fix");
    commitIn(fx.wt(40), "a.test.sh", test, "test: the fix");
    sh(fx.wt(40), "./scripts/slice-done.sh");
    return fx;
  };
  const ARGS = ["--review", "-y", "--interval", "1", "40"];

  it("tells the review the tests fail on the base", () => {
    const fx = slice("test -f fix.txt || { echo FIX-MISSING; exit 1; }\n");
    // A throwaway worktree a crashed run left behind is in the way.
    git(fx.main, "worktree", "add", "-q", "--detach", `${fx.wt(40)}-base-test`);

    const r = runDispatcher(fx, ARGS);

    expect(r.out).toContain("new tests on base: fail (expected for a fix)");
    const prompt = specPrompt(fx);
    expect(prompt).toContain("NEW TESTS AGAINST THE BASE:");
    expect(prompt).toContain("only these files from the slice:\na.test.sh\n");
    expect(prompt).toContain(
      "result: exited 1 — the tests FAIL on the base\nlast 40 lines of output:\nFIX-MISSING",
    );
    expect(r.out).toContain("landing #40");
    noThrowaway(fx);
  });

  it("tells the review when they pass on the base", () => {
    const fx = slice("echo ALWAYS-GREEN\n");

    const r = runDispatcher(fx, ARGS);

    expect(r.out).toContain("new tests on base: pass\n");
    expect(specPrompt(fx)).toContain(
      "result: exited 0 — the tests PASS on the base\nlast 40 lines of output:\nALWAYS-GREEN",
    );
    noThrowaway(fx);
  });

  it("runs nothing when the config leaves it out", () => {
    const fx = slice("echo ALWAYS-GREEN\n", "");

    const r = runDispatcher(fx, ARGS);

    expect(r.out).not.toContain("new tests on base");
    expect(specPrompt(fx)).not.toContain("NEW TESTS");
    expect(r.out).toContain("landing #40");
    noThrowaway(fx);
  });

  it("says nothing for a slice that touches no test file", () => {
    const fx = makeConsumer({
      worktrees: [40],
      remote: true,
      review: RECORD,
      configExtra: TEST_ON_BASE,
    });
    c = fx;
    commitIn(fx.wt(40), "fix.txt", "fix\n", "fix: the fix");
    sh(fx.wt(40), "./scripts/slice-done.sh");

    const r = runDispatcher(fx, ARGS);

    expect(r.out).not.toContain("new tests on base");
    expect(specPrompt(fx)).not.toContain("NEW TESTS");
  });

  it("skips a slice that changes a manifest, and says so in the report", () => {
    const fx = slice("exit 1\n");
    sh(fx.wt(40), "rm .slice-ready-to-land");
    commitIn(fx.wt(40), "package.json", "{}\n", "chore: a dependency");
    sh(fx.wt(40), "./scripts/slice-done.sh");

    const r = runDispatcher(fx, ARGS);

    expect(r.out).toContain(
      "new tests on base: skipped — the slice changes package.json",
    );
    expect(r.out).toContain(
      "(new tests on base: skipped — the slice changes package.json",
    );
    expect(specPrompt(fx)).not.toContain("NEW TESTS");
    expect(r.out).toContain("landing #40");
    noThrowaway(fx);
  });

  it("removes the worktree when the command times out, and still lands", async () => {
    const fx = slice("sleep 30\n");

    d = startDispatcher(fx, ARGS, {
      env: { SLICE_TEST_ON_BASE_TIMEOUT_SECONDS: "1" },
    });
    await d.until("plan complete");

    expect(d.output()).toContain(
      "new tests on base: skipped — the command did not finish in 1s",
    );
    expect(specPrompt(fx)).not.toContain("NEW TESTS");
    noThrowaway(fx);
  }, 60_000);
});

/**
 * The two axes run together. Each review waits to see the other start, so run
 * one after the other, neither would, and the answers say which it was.
 */
describe("the two review axes", () => {
  const axisReview = (spec: string, standards: string) => [
    "bash",
    "-c",
    `case "$1" in *"coding standards"*) me=standards other=spec ;; *) me=spec other=standards ;; esac
touch ../started-$me
for _ in $(seq 100); do [ -f ../started-$other ] && break; sleep 0.1; done
[ -f ../started-$other ] && echo saw >> ../saw-$me
case $me in spec) ${spec} ;; standards) ${standards} ;; esac`,
    "reviewer",
  ];
  const landed = (
    review: string[],
    args = ["--auto", "--once", "-y", "40"],
  ) => {
    const fx = makeConsumer({ worktrees: [40], remote: true, review });
    c = fx;
    commitIn(fx.wt(40), "a.txt", "a\n", "feat: a");
    sh(fx.wt(40), "./scripts/slice-done.sh");
    const r = runDispatcher(fx, args);
    const report = () =>
      readFileSync(join(fx.main, ".slice-reviews", "ticket-40.md"), "utf8");
    return { fx, r, report };
  };

  it("run at once, and the report has spec, then standards", () => {
    const { fx, r, report } = landed(
      axisReview(
        'echo "SPEC-SAID"; echo "VERDICT: PASS"',
        'echo "STANDARDS-SAID"',
      ),
    );

    expect(existsSync(join(fx.root, "saw-spec"))).toBe(true);
    expect(existsSync(join(fx.root, "saw-standards"))).toBe(true);
    expect(r.out).toContain("spec review: PASS");
    expect(report()).toMatch(
      /### Spec\n\nSPEC-SAID\nVERDICT: PASS\n\n### Standards\n\nSTANDARDS-SAID/,
    );
    expect(git(fx.main, "log", "-1", "--format=%s")).toBe("feat: a");
  }, 60_000);

  it("standards failing leaves the spec's report, and it lands", () => {
    const { fx, report } = landed(
      axisReview('echo "SPEC-SAID"; echo "VERDICT: PASS"', "exit 1"),
    );

    expect(report()).toContain("SPEC-SAID");
    expect(report()).toContain("(standards review did not return — skipped)");
    expect(git(fx.main, "log", "-1", "--format=%s")).toBe("feat: a");
  }, 60_000);

  it("the spec failing leaves the standards' report, and parks as a review that could not run", () => {
    const { fx, r, report } = landed(
      axisReview('echo "nobody home" >&2; exit 1', 'echo "STANDARDS-SAID"'),
    );

    expect(r.out).toContain(
      "#40 not landed — the spec review could not run — nobody home",
    );
    expect(report()).toContain("STANDARDS-SAID");
    expect(git(fx.main, "log", "-1", "--format=%s")).toBe("init");
  }, 60_000);
});

describe("slice-session.sh and .slice-refs.md", () => {
  const SENTENCE =
    "The tickets and comments this ticket names are in .slice-refs.md in this worktree";
  const refsFile = (fx: Consumer) => join(fx.wt(40), ".slice-refs.md");
  /** A session of #40 whose agent writes its prompt next to the worktree. */
  const session = (threads: boolean) => {
    const fx = makeConsumer({
      worktrees: [40],
      remote: true,
      threads,
      agent: ["bash", "-c", 'printf "%s" "$0" > ../prompt.txt'],
    });
    c = fx;
    return fx;
  };
  const start = (fx: Consumer) => {
    const out = sh(fx.main, "./scripts/slice-session.sh 40");
    return { out, prompt: readFileSync(join(fx.root, "prompt.txt"), "utf8") };
  };

  it("writes what the ticket names, and the prompt says so", () => {
    const fx = session(true);
    fx.setTicket("40", {
      body: "See #7 and other/repo#8.",
      comments: [{ author: "alex", at: "then", body: "OWN-COMMENT" }],
    });
    fx.setTicket("7", { title: "Seven", body: "SEVEN-BODY" });
    fx.setTicket("other/repo#8", { title: "Eight", body: "EIGHT-BODY" });

    const { out, prompt } = start(fx);

    expect(out).toContain("✓ wrote .slice-refs.md");
    const refs = readFileSync(refsFile(fx), "utf8");
    expect(refs).not.toContain("OWN-COMMENT");
    expect(refs).toContain("SEVEN-BODY");
    expect(refs).toContain("EIGHT-BODY");
    expect(prompt).toContain(SENTENCE);
    expect(git(fx.wt(40), "status", "--porcelain")).toBe("");
  }, 60_000);

  it("the ticket's own comments go in .slice-ticket.md, with no file when it names nothing", () => {
    const fx = session(true);
    fx.setTicket("40", {
      body: "Just build.",
      comments: [
        { author: "alex", at: "then", body: "DO-NOT-TOUCH-THAT-FILE" },
      ],
    });

    const { prompt } = start(fx);

    const ticket = readFileSync(join(fx.wt(40), ".slice-ticket.md"), "utf8");
    expect(ticket).toContain("Just build.");
    expect(ticket).toContain("## Comments on this ticket");
    expect(ticket).toContain("### alex, then\n\nDO-NOT-TOUCH-THAT-FILE");
    expect(existsSync(refsFile(fx))).toBe(false);
    expect(prompt).not.toContain(".slice-refs.md");
  }, 60_000);

  it("a name that cannot be read does not stop the prep", () => {
    const fx = session(true);
    fx.setTicket("40", { body: "See #7 and #9." });
    fx.setTicket("7", { unreadable: true });
    fx.setTicket("9", { title: "Nine", body: "NINE-BODY" });

    start(fx);

    const refs = readFileSync(refsFile(fx), "utf8");
    expect(refs).toContain("could not be read: HTTP 404: Not Found");
    expect(refs).toContain("NINE-BODY");
  }, 60_000);

  it("a tracker without thread: no file, and no sentence", () => {
    const fx = session(false);
    fx.setTicket("40", { body: "See #7." });

    const { prompt } = start(fx);

    expect(existsSync(refsFile(fx))).toBe(false);
    expect(prompt).not.toContain(".slice-refs.md");
  }, 60_000);

  it("nothing named: an old file goes, and no sentence", () => {
    const fx = session(true);
    fx.setTicket("40", { body: "Just build." });
    writeFileSync(refsFile(fx), "stale\n");

    const { prompt } = start(fx);

    expect(existsSync(refsFile(fx))).toBe(false);
    expect(prompt).not.toContain(".slice-refs.md");
  }, 60_000);

  it("where git does not ignore it: no file, and the hint", () => {
    const fx = session(true);
    fx.setTicket("40", { body: "See #7." });
    fx.setTicket("7", { title: "Seven" });
    const exclude = join(fx.main, ".git", "info", "exclude");
    writeFileSync(
      exclude,
      readFileSync(exclude, "utf8").replace(".slice-refs.md\n", ""),
    );

    const { out, prompt } = start(fx);

    expect(existsSync(refsFile(fx))).toBe(false);
    expect(out).toContain("no .slice-refs.md: git does not ignore it here yet");
    expect(prompt).not.toContain(".slice-refs.md");
    expect(git(fx.wt(40), "status", "--porcelain")).toBe("");
  }, 60_000);
});

describe("slice-session.sh and .slice-parent.md", () => {
  const prep = (body: string) => {
    const fx = makeConsumer({ worktrees: [40], agent: ["true"] });
    c = fx;
    fx.setTicket("40", { body });
    fx.setTicket("17", { title: "Spec: the feed", body: "PARENT-BODY" });
    return fx;
  };

  it("writes the parent for a child, and names both files", () => {
    const fx = prep("Build.\n\n## Parent\n\n#17\n");
    const out = sh(fx.main, "./scripts/slice-session.sh 40");
    expect(readFileSync(join(fx.wt(40), ".slice-parent.md"), "utf8")).toBe(
      "# #17 — Spec: the feed\n\n\n\n---\n\nPARENT-BODY\n",
    );
    expect(out).toContain(
      "your ticket is in .slice-ticket.md, and the spec it hangs under in .slice-parent.md",
    );
    // Ignored, so the worktree is still clean and still lands.
    expect(git(fx.wt(40), "status", "--porcelain")).toBe("");
  });

  it("writes none for a ticket with no parent, and removes a stale one", () => {
    const fx = prep("Build.");
    writeFileSync(join(fx.wt(40), ".slice-parent.md"), "stale\n");
    const out = sh(fx.main, "./scripts/slice-session.sh 40 --prep-only");
    expect(existsSync(join(fx.wt(40), ".slice-parent.md"))).toBe(false);
    expect(out).not.toContain(".slice-parent.md");
  });

  it("writes none where git would not ignore it, and says why", () => {
    const fx = prep("Build.\n\n## Parent\n\n#17\n");
    // A checkout whose exclude block predates the file.
    const exclude = join(fx.main, ".git", "info", "exclude");
    writeFileSync(
      exclude,
      readFileSync(exclude, "utf8").replace(".slice-parent.md\n", ""),
    );
    const out = sh(fx.main, "./scripts/slice-session.sh 40 --prep-only");
    expect(existsSync(join(fx.wt(40), ".slice-parent.md"))).toBe(false);
    expect(out).toContain("run `azelf init` once");
  });
});

describe("slice-session.sh --prep-only by hand", () => {
  it("says it was not launched, and how to launch it", () => {
    c = makeConsumer({ worktrees: [40], agent: ["true"] });
    const out = sh(c.main, "./scripts/slice-session.sh 40 --prep-only");
    expect(out).toContain("✓ prepped, not launched — worktree ready at");
    expect(out).toContain("launch it with:");
  });
});

/**
 * The prep's install step is the config's `install`, else what the lockfile
 * says — never a `bun install` written into the script. A repo with no
 * package.json (a Python service) lost every session to bun's exit 1 before
 * its ticket was written, and an npm repo got an untracked bun.lock in every
 * worktree. See scripts/slice-install.ts.
 */
describe("the prep's install step", () => {
  it("installs nothing where there is no package.json, and says why", () => {
    // `resolve` gives the config a fake agent without `agent`, which is the
    // option that writes a package.json into the fixture.
    c = makeConsumer({ worktrees: [40], resolve: ["true"] });
    const out = sh(c.main, "./scripts/slice-session.sh 40 --prep-only");
    expect(out).toContain(
      "no install step (no package.json — nothing to install)",
    );
    expect(out).not.toContain("bun install");
    expect(out).toContain("✓ prepped, not launched");
  });

  it("installs nothing when the config says [], whatever the checkout holds", () => {
    c = makeConsumer({
      worktrees: [40],
      agent: ["true"],
      configExtra: "install: [],",
    });
    const out = sh(c.main, "./scripts/slice-session.sh 40 --prep-only");
    expect(out).toContain("no install step (install: [] in slice.config.ts)");
    expect(existsSync(join(c.wt(40), "node_modules"))).toBe(false);
  });

  it("runs the configured command in the worktree, and names it", () => {
    c = makeConsumer({
      worktrees: [40],
      agent: ["true"],
      configExtra: 'install: ["touch", "../installed-marker"],',
    });
    const out = sh(c.main, "./scripts/slice-session.sh 40 --prep-only");
    expect(out).toContain(
      "✓ dependencies installed (touch ../installed-marker)",
    );
    expect(existsSync(join(c.root, "installed-marker"))).toBe(true);
  });

  /**
   * A plain `bun install` with no lockfile writes a bun.lock that git does not
   * track, and slice-done.sh refuses a dirty tree. The frozen form installs
   * and writes none (bun 1.3.5). The dependency is a `file:` one, so no network.
   */
  it("leaves no bun.lock behind where package.json has no lockfile", () => {
    c = makeConsumer({ remote: true, agent: ["true"] });
    mkdirSync(join(c.main, "dep"));
    writeFileSync(
      join(c.main, "dep", "package.json"),
      '{ "name": "dep", "version": "1.0.0" }\n',
    );
    writeFileSync(
      join(c.main, "package.json"),
      '{ "name": "fx", "dependencies": { "dep": "file:./dep" } }\n',
    );
    git(c.main, "add", "-A");
    git(c.main, "commit", "-qm", "chore: a dependency, and no lockfile");
    git(c.main, "push", "-q", "origin", "main");

    const out = sh(c.main, "./scripts/slice-session.sh 40 --prep-only");

    expect(out).toContain(
      "✓ dependencies installed (bun install --frozen-lockfile)",
    );
    expect(existsSync(join(c.wt(40), "node_modules", "dep"))).toBe(true);
    expect(existsSync(join(c.wt(40), "bun.lock"))).toBe(false);
    expect(git(c.wt(40), "status", "--porcelain")).toBe("");
  });

  it("fails the prep when the configured command fails, naming it", () => {
    c = makeConsumer({
      worktrees: [40],
      agent: ["true"],
      configExtra: 'install: ["false"],',
    });
    const r = shResult(c.main, "./scripts/slice-session.sh 40 --prep-only");
    expect(r.ok).toBe(false);
    expect(r.out).toContain("error: 'false' failed in the new worktree.");
  });

  it("the config refuses an install that is not a list of words", () => {
    for (const value of ['"npm ci"', '["npm", ""]']) {
      c = makeConsumer({ configExtra: `install: ${value},` });
      const r = runDispatcher(c, ["--plan"]);
      expect(r.code).not.toBe(0);
      expect(r.out).toContain("install must be an array of non-empty strings");
      rmSync(c.root, { recursive: true, force: true });
    }
  });
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
      "and run again:\n\n    ./scripts/azelf run --auto -y --interval 1 40\n",
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
 * consumer-b's Backend #227: a tab's slice-session.sh started, the Mac slept
 * before it wrote `.slice-live`, and the dispatcher woke past its launch
 * window by the wall clock, found no marker and opened a second tab. A
 * slice-session.sh for the ticket that is still running is a start on its
 * way, whatever the clock says. The stand-ins never claim; `wake` ends them.
 */
describe("a start the Mac slept on", () => {
  const AUTO = ["--auto", "-y", "--no-review", "--interval", "1", "40"];
  const starts = () => d?.output().match(/started #40/g)?.length ?? 0;

  it("is not launched again while its slice-session.sh runs, and is once that is gone", async () => {
    c = makeConsumer({ worktrees: [40], remote: true, launch: "asleep" });
    const fx = c;
    d = startDispatcher(fx, AUTO);
    await d.until("started #40");
    // Past the launcher's 5s window, by several rounds.
    await new Promise((r) => setTimeout(r, 8_000));

    expect(d.output()).not.toContain("never came up");
    expect(starts()).toBe(1);
    expect(existsSync(join(fx.wt(40), ".slice-live"))).toBe(false);

    // Gone without coming up: launched again, as before.
    writeFileSync(join(fx.root, "wake"), "");
    await d.until(/started #40[\s\S]*started #40/);
  }, 60_000);

  it("counts one started by hand in the main checkout", () => {
    c = makeConsumer({ worktrees: [40], remote: true });
    asleepSession(c, 40, c.main);

    const r = runDispatcher(c, ["--auto", "--once", "-y", "--no-review", "40"]);

    expect(r.out).toContain("--once: stopping here.");
    expect(r.out).not.toContain("starting #40");
  });

  it("does not count one for the same number in another checkout", () => {
    c = makeConsumer({ worktrees: [40], remote: true });
    const other = join(c.root, "other");
    mkdirSync(other);
    asleepSession(c, 40, other);

    const r = runDispatcher(c, ["--auto", "--once", "-y", "--no-review", "40"]);

    expect(r.out).toContain("starting #40");
  });
});

/**
 * A slice refused the DB lock ends its turn, and an agent in a REPL can do no
 * more: its process stays, so the session stays live and the dispatcher never
 * relaunched it. On consumer-a one waited twelve hours on a free lock. #44
 * holds the lock from its worktree; #40's real session claims, is refused,
 * and its agent then idles as a REPL would, until something ends it.
 */
describe("a session waiting on a lock that frees", () => {
  const waitFor = async (what: string, ok: () => boolean, ms = 30_000) => {
    const end = Date.now() + ms;
    while (!ok()) {
      if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
      await new Promise((r) => setTimeout(r, 100));
    }
  };
  let tag = "";
  afterEach(() => {
    if (tag) spawnSync("pkill", ["-f", `azelf-idle-${tag}`]);
    tag = "";
  });

  /**
   * The first session commits the part that needs no lock, claims, is
   * refused and idles; `idle` is what it idles as. A later session records
   * its prompt, commits the rest and exits 0, as a finished slice does.
   */
  const waiting = (idle: string) => {
    tag = String(3000 + Math.floor(Math.random() * 5000));
    const agent = `if [ -e ../first ]; then printf "%s\\n" "$1" > ../relaunched; echo b > b.txt; git add b.txt; git commit -qm "feat: b"; else touch ../first; echo a > a.txt; git add a.txt; git commit -qm "feat: a"; ./scripts/db-lock.sh claim; exec bash -c '${idle}' azelf-idle-${tag}; fi`;
    const fx = makeConsumer({
      lockPaths: ["db"],
      worktrees: [40, 44],
      remote: true,
      agent: ["bash", "-c", agent, "agent"],
      launch: true,
    });
    c = fx;
    sh(fx.wt(44), "./scripts/db-lock.sh claim");
    return fx;
  };
  const idling = () =>
    spawnSync("pgrep", ["-f", `azelf-idle-${tag}`]).status === 0;
  const WAITING = "waiting for it: #40 — relaunched when it frees";
  const ENDING =
    /#40: the DB lock is free — ending its session, which has waited on it since \d\d:\d\d, to start it again\n {4}ended the agent in that tab — the session exits and the tab closes\./;

  it("ends the session once the lock is free and it is quiet, and starts it again", async () => {
    const fx = waiting("while :; do sleep 1; done");
    d = startDispatcher(fx, [
      "--auto",
      "--no-review",
      "-y",
      "--interval",
      "1",
      "40",
    ]);
    await d.until(WAITING);
    expect(idling()).toBe(true);

    sh(fx.wt(44), "./scripts/db-lock.sh release");
    await d.until(ENDING);
    expect(idling()).toBe(false);
    // Not on the round the lock freed: two quiet rounds after it, each of
    // which ends on its round line.
    const out = d.output();
    const between = out.slice(out.indexOf("DB lock free"), out.search(ENDING));
    expect(between.match(/\[round \d+\] \d+ running/g)?.length).toBe(2);

    await waitFor("the relaunched session", () =>
      existsSync(join(fx.root, "relaunched")),
    );
    // Not landed as half a ticket when its first session ended: the commit
    // the lock wait left is under the one the new session made.
    await waitFor(
      "the land",
      () => git(fx.main, "log", "-1", "--format=%s") === "feat: b",
    );
    expect(git(fx.main, "log", "-2", "--format=%s")).toBe("feat: b\nfeat: a");
    expect(readFileSync(join(fx.root, "relaunched"), "utf8")).toContain(
      "already has work from an earlier session of this ticket",
    );
  }, 60_000);

  it("does not end a session whose worktree changes every round", async () => {
    const fx = waiting(
      "while :; do date +%s%N >> busy.txt; git add busy.txt; git commit -qm busy; sleep 0.4; done",
    );
    d = startDispatcher(fx, [
      "--auto",
      "--no-review",
      "-y",
      "--interval",
      "1",
      "40",
    ]);
    await d.until(WAITING);
    sh(fx.wt(44), "./scripts/db-lock.sh release");
    await d.until("DB lock free");
    const rounds = () => d?.output().match(/\[round \d+\]/g)?.length ?? 0;
    const seen = rounds();
    await waitFor("four more rounds", () => rounds() >= seen + 4);

    expect(d.output()).not.toContain("ending its session");
    expect(idling()).toBe(true);
  }, 60_000);

  it("without --auto, says once that the lock is free and leaves the session alone", async () => {
    const fx = waiting("while :; do sleep 1; done");
    d = startDispatcher(fx, ["-y", "--interval", "1", "40"]);
    await waitFor("the refused claim", () =>
      existsSync(join(fx.wt(40), ".slice-lock-wait")),
    );
    sh(fx.wt(44), "./scripts/db-lock.sh release");
    const TOLD =
      "#40 waits on the DB lock, which is free now — tell its session to go on, or end it and it is started again";
    await d.until(TOLD);
    const rounds = () => d?.output().match(/\[round \d+\]/g)?.length ?? 0;
    const seen = rounds();
    await waitFor("four more rounds", () => rounds() >= seen + 4);

    expect(d.output().split(TOLD).length - 1).toBe(1);
    expect(d.output()).not.toContain("ending its session");
    expect(idling()).toBe(true);
  }, 60_000);
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

  it("names the dead dispatcher whose resolver left the rebase", () => {
    c = midRebase();
    const dead = spawnSync("true").pid;
    writeFileSync(
      join(
        git(
          c.wt(40),
          "rev-parse",
          "--path-format=absolute",
          "--git-path",
          "rebase-merge",
        ),
        "azelf-resolver",
      ),
      `pid=${dead}\nstarted=\nlabel=#40\nsince=2026-10-09T12:00:00.000Z\n`,
    );

    const r = runDispatcher(c, ["--auto", "--once", "-y", "--no-review", "40"]);

    expect(r.out).toContain(
      `#40: a rebase is in progress in its worktree, left by the conflict resolver of a dispatcher that is no longer running (pid ${dead}). Nothing will finish it: finish it by hand, or git -C ${c.wt(
        40,
      )} rebase --abort — either way it is back in the run once the rebase is over.`,
    );
    expect(r.out).not.toContain(SEEN);
    expect(rebaseInProgress(c.wt(40))).toBe(true);
  });

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
 * `refresh`: after a rebase that brought a matching file from the base, a
 * step runs in the worktree and what it changes is committed. On consumer-b a
 * generated file's count was merged wrong by hand, and a shared venv was
 * behind main's pins; both are "run the generator again after the rebase".
 */
describe("refreshing after a rebase", () => {
  const REGEN = `refresh: [{ when: ["gen/*.txt"], run: ["bash", "-c", "cat gen/in.txt gen/in.txt > gen/out.txt"], name: "regen" }],`;
  const withBase = (extra: string) => {
    const fx = makeConsumer({
      worktrees: [40],
      remote: true,
      agent: ["true"],
      configExtra: extra,
    });
    commitIn(fx.wt(40), "a.txt", "a\n", "feat: a");
    sh(fx.wt(40), "./scripts/slice-done.sh");
    return fx;
  };
  const auto = ["--auto", "--once", "-y", "--no-review", "40"];

  it("runs the step the base's change matched, commits its output, and lands", () => {
    c = withBase(REGEN);
    mkdirSync(join(c.main, "gen"));
    commitIn(c.main, "gen/in.txt", "2\n", "main: in");

    const r = runDispatcher(c, auto);

    expect(r.out).toContain(
      "#40: the rebase brought gen/in.txt — refreshing: regen …",
    );
    expect(r.out).toContain("✓ refreshed: committed gen/out.txt (regen)");
    expect(r.code).toBe(0);
    expect(readFileSync(join(c.main, "gen/out.txt"), "utf8")).toBe("2\n2\n");
    expect(git(c.main, "log", "--format=%s", "-2")).toBe(
      "chore: refresh after the rebase — regen\nfeat: a",
    );
  });

  it("runs nothing when the base's change matches no step, or the base did not move", () => {
    c = withBase(REGEN);
    commitIn(c.main, "other.txt", "x\n", "main: other");

    const r = runDispatcher(c, auto);

    expect(r.out).not.toContain("refreshing:");
    expect(r.code).toBe(0);
  });

  it("parks on a step that fails, and says how to go on", () => {
    c = withBase(
      'refresh: [{ when: ["gen/**"], run: ["false"], name: "broken" }],',
    );
    mkdirSync(join(c.main, "gen"));
    commitIn(c.main, "gen/in.txt", "2\n", "main: in");

    const r = runDispatcher(c, auto);

    expect(r.out).toContain(
      "refresh step `broken` failed after the rebase — run it in the worktree, commit what it changes, and azelf retry 40",
    );
    expect(r.code).toBe(1);
    expect(existsSync(join(c.wt(40), "a.txt"))).toBe(true);
  });

  it("the config refuses a step without patterns or without a command", () => {
    for (const value of [
      '[{ when: [], run: ["true"] }]',
      '[{ when: ["a"], run: "true" }]',
      '"true"',
    ]) {
      c = makeConsumer({ configExtra: `refresh: ${value},` });
      const r = runDispatcher(c, ["--plan"]);
      expect(r.code).not.toBe(0);
      expect(r.out).toContain(
        "refresh must be an array of { when: [path patterns], run: [argv], name? }",
      );
      rmSync(c.root, { recursive: true, force: true });
    }
  });
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
  const conflicting = (
    resolver: string,
    files = ["a.txt"],
    opts: Parameters<typeof makeConsumer>[0] = {},
  ) => {
    const fx = makeConsumer({
      worktrees: [40],
      remote: true,
      resolve: ["bash", "-c", resolver, "resolver"],
      ...opts,
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

  it("says in the rebase's own state that the rebase is its resolver's", () => {
    c = conflicting('bash "$(dirname "$PWD")/resolver.sh" "$1"');
    writeFileSync(
      join(c.root, "resolver.sh"),
      `cp "$(git rev-parse --git-path rebase-merge)/azelf-resolver" ../mark
${RESOLVE_BOTH}`,
    );

    const r = runDispatcher(c, auto);

    expect(r.code).toBe(0);
    const mark = readFileSync(join(c.root, "mark"), "utf8");
    expect(mark).toMatch(/^pid=\d+\nstarted=.+\nlabel=#40\nsince=/);
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

  /**
   * The resolver may run what the config names, and is told so; without a
   * list it is told it can run nothing. The fake resolver gets the allowed
   * prefixes after the prompt (fixture.ts) and logs them.
   */
  it("tells the resolver what it may run, and allows exactly that", () => {
    c = conflicting('bash "$(dirname "$PWD")/resolver.sh" "$@"', ["a.txt"], {
      configExtra: 'resolverCommands: ["npm run test", "pytest"],',
    });
    writeFileSync(
      join(c.root, "resolver.sh"),
      `${logged(c.root, RESOLVE_BOTH)}
shift; printf '%s\n' "$@" > ../allowed`,
    );

    const r = runDispatcher(c, auto);

    expect(r.code).toBe(0);
    expect(readFileSync(join(c.root, "prompts"), "utf8")).toContain(
      "The checks you may run, and the only commands you may run: `npm run test`, `pytest`. Run them before you finish.",
    );
    expect(readFileSync(join(c.root, "allowed"), "utf8")).toBe(
      "npm run test\npytest\n",
    );
  });

  it("tells a resolver with no commands that the gates run after it", () => {
    c = conflicting('bash "$(dirname "$PWD")/resolver.sh" "$1"');
    writeFileSync(join(c.root, "resolver.sh"), logged(c.root, RESOLVE_BOTH));

    runDispatcher(c, auto);

    expect(readFileSync(join(c.root, "prompts"), "utf8")).toContain(
      "You cannot run commands in this session. azelf runs the project's gates after you, and calls you once more with their output if they are red.",
    );
  });

  /**
   * A red gate right after a resolution goes back to the resolver once, with
   * the gate's output. On consumer-b that was a generated file's count, one
   * too high, and the slice parked on it. The gate here wants a.txt to read
   * `fixed`; the resolver's second call, told what the gates said, writes it.
   */
  describe("when the gates are red after the resolution", () => {
    const REPAIR = `if [[ "$1" == *"WHAT THE GATES SAID"* ]]; then
  echo fixed > a.txt
else
${RESOLVE_BOTH}
fi`;
    const redUntilFixed = (repair = REPAIR) => {
      const fx = conflicting(
        'bash "$(dirname "$PWD")/resolver.sh" "$1"',
        ["a.txt"],
        {
          gate: ["grep", "-qx", "fixed", "a.txt"],
        },
      );
      writeFileSync(join(fx.root, "resolver.sh"), logged(fx.root, repair));
      return fx;
    };

    it("gives the resolver one round with the gate's output, commits the repair, and lands", () => {
      c = redUntilFixed();

      const r = runDispatcher(c, auto);

      expect(r.out).toContain(
        "the gates are red after the resolution — giving the resolver one round with their output …",
      );
      expect(r.out).toContain(
        "✓ repaired a.txt and committed — the gates run again",
      );
      expect(r.code).toBe(0);
      expect(calls(c)).toBe(2);
      expect(readFileSync(join(c.main, "a.txt"), "utf8")).toBe("fixed\n");
      expect(git(c.main, "log", "--format=%s", "-1")).toMatch(
        /^fix: the resolution — the gates said: /,
      );
      const prompts = readFileSync(join(c.root, "prompts"), "utf8");
      expect(prompts).toContain("WHAT THE GATES SAID:");
      expect(prompts).toContain(
        "1. Edit only the files this branch changes:\n\n  a.txt",
      );
      expect(
        readFileSync(join(c.main, ".slice-reviews", "repair-40.md"), "utf8"),
      ).toContain("ACCEPTED: a.txt edited and committed");
    });

    it("tells the repair where the gate's whole output is", () => {
      const fx = conflicting(
        'bash "$(dirname "$PWD")/resolver.sh" "$1"',
        ["a.txt"],
        {
          gate: [
            "bash",
            "-c",
            'for i in $(seq 40); do echo "row $i"; done; grep -qx fixed a.txt',
          ],
        },
      );
      writeFileSync(join(fx.root, "resolver.sh"), logged(fx.root, REPAIR));
      c = fx;

      const r = runDispatcher(c, auto);

      expect(r.code).toBe(0);
      expect(readFileSync(join(c.root, "prompts"), "utf8")).toMatch(
        /The whole output is in \S+\/\.slice-reviews\/last-gate\.log\./,
      );
      expect(readFileSync(join(c.main, "a.txt"), "utf8")).toBe("fixed\n");
    });

    it("rejects a repair that strays, resets the branch, and parks", () => {
      c = redUntilFixed(`if [[ "$1" == *"WHAT THE GATES SAID"* ]]; then
  echo fixed > a.txt; echo x > other.txt
else
${RESOLVE_BOTH}
fi`);

      const r = runDispatcher(c, auto);

      expect(r.out).toContain(
        "✗ repair rejected — it changed other.txt, which this slice does not; the branch is as the gates judged it.",
      );
      expect(r.out).toContain("the gates are red");
      expect(r.code).toBe(1);
      expect(existsSync(join(c.wt(40), "other.txt"))).toBe(false);
      expect(readFileSync(join(c.wt(40), "a.txt"), "utf8")).toBe(
        "main\nbranch\n",
      );
    });

    it("parks when the gates are red after the repair too, once", () => {
      c = redUntilFixed(`if [[ "$1" == *"WHAT THE GATES SAID"* ]]; then
  echo still-wrong > a.txt
else
${RESOLVE_BOTH}
fi`);

      const r = runDispatcher(c, auto);

      expect(r.out).toContain("✓ repaired a.txt and committed");
      expect(r.out).toContain("the gates are red after the repair too");
      expect(r.code).toBe(1);
      expect(calls(c)).toBe(2);
    });

    it("does not call the resolver for a slice whose rebase was clean", () => {
      c = makeConsumer({
        worktrees: [40],
        remote: true,
        resolve: ["bash", "-c", `echo call >> ../calls`, "resolver"],
        gate: ["false"],
      });
      commitIn(c.wt(40), "a.txt", "a\n", "feat: a");
      sh(c.wt(40), "./scripts/slice-done.sh");

      const r = runDispatcher(c, auto);

      expect(r.out).toContain("the gates are red");
      expect(r.out).not.toContain("giving the resolver one round");
      expect(existsSync(join(c.root, "calls"))).toBe(false);
    });
  });

  /**
   * Another process holds the worktree's index lock when azelf stages the
   * resolution: on consumer-a it was gone seconds later, and a correct
   * resolution had been thrown away. The resolver here resolves, then takes
   * the lock itself, the way that outside process did.
   */
  describe("when the worktree's index is locked", () => {
    // Its own stdio, or the dispatcher would wait for the pipe it holds open.
    const takeLock = (releaseAfter: string | null) => `${RESOLVE_BOTH}
lock="$(git rev-parse --absolute-git-dir)/index.lock"
touch "$lock"
${
  releaseAfter
    ? `(sleep ${releaseAfter}; rm -f "$lock") </dev/null >/dev/null 2>&1 &`
    : ""
}`;
    const fast = { env: { SLICE_LOCK_RETRY_MS: "40" } };

    it("waits for a lock that goes, and keeps the resolution", () => {
      c = conflicting('bash "$(dirname "$PWD")/resolver.sh" "$1"');
      writeFileSync(join(c.root, "resolver.sh"), takeLock("1"));

      const r = runDispatcher(c, auto, fast);

      expect(
        r.out.match(
          /the worktree's index is locked \(another git process\?\)/g,
        ),
      ).toHaveLength(1);
      expect(r.out).toContain("✓ rebased onto main, clean, no markers left");
      expect(r.out).not.toContain("resolution rejected");
      expect(r.code).toBe(0);
      expect(readFileSync(join(c.main, "a.txt"), "utf8")).toBe(
        "main\nbranch\n",
      );
    });

    it("rejects with the lock's path when it stays, and says the rebase is still there", () => {
      c = conflicting('bash "$(dirname "$PWD")/resolver.sh" "$1"');
      writeFileSync(join(c.root, "resolver.sh"), takeLock(null));

      const r = runDispatcher(c, auto, fast);

      const lock = join(
        git(c.wt(40), "rev-parse", "--absolute-git-dir"),
        "index.lock",
      );
      expect(r.out).toContain(
        `✗ resolution rejected — the worktree's index stayed locked for 3 s (${lock}) — if no git process is running there, it is stale: remove it and run azelf retry 40`,
      );
      expect(r.out).toContain(
        "the rebase could not be aborted either — it is still in progress in",
      );
      expect(r.out).not.toContain("the branch is as it was");
      expect(r.code).toBe(1);
      expect(rebaseInProgress(c.wt(40))).toBe(true);
    });
  });

  /**
   * A land elsewhere moves the base while the resolver works: a second
   * dispatcher on consumer-a did, a minute before a two-stop resolution
   * finished, and the resolution was judged against the new commit.
   */
  describe("when the base moves during the resolution", () => {
    /** Shell that commits `text` to `file` on main. */
    const moveMain = (fx: Consumer, file: string, text: string) =>
      `(cd ${JSON.stringify(
        fx.main,
      )} && printf '%s\\n' ${text} > ${file} && git add ${file} && git commit -qm "main: moved ${file}")`;

    const withResolver = (body: (fx: Consumer) => string) => {
      const fx = conflicting('bash "$(dirname "$PWD")/resolver.sh" "$1"');
      writeFileSync(join(fx.root, "resolver.sh"), logged(fx.root, body(fx)));
      return fx;
    };

    it("keeps the resolution and rebases over the new commits", () => {
      c = withResolver(
        (fx) => `${RESOLVE_BOTH}\n${moveMain(fx, "other.txt", "other")}`,
      );

      const r = runDispatcher(c, auto);

      expect(r.out).toMatch(
        /main moved during the resolution \([0-9a-f]{7} → [0-9a-f]{7}\) — rebasing onto the new commits/,
      );
      expect(r.out).not.toContain("resolution rejected");
      expect(r.code).toBe(0);
      expect(calls(c)).toBe(1);
      expect(git(c.main, "log", "--format=%s", "-2")).toBe(
        "feat: a.txt\nmain: moved other.txt",
      );
      expect(
        readFileSync(join(c.main, ".slice-reviews", "conflict-40.md"), "utf8"),
      ).toContain("ACCEPTED");
    });

    it("resolves once more when the new commits conflict too", () => {
      c = withResolver(
        (fx) => `${RESOLVE_BOTH}
if [ ! -f ${JSON.stringify(join(fx.root, "moved"))} ]; then
  touch ${JSON.stringify(join(fx.root, "moved"))}
  ${moveMain(fx, "a.txt", "main2")}
fi`,
      );

      const r = runDispatcher(c, auto);

      expect(r.code).toBe(0);
      expect(calls(c)).toBe(2);
      expect(git(c.main, "log", "--format=%s", "-2")).toBe(
        "feat: a.txt\nmain: moved a.txt",
      );
    });

    it("parks after two passes, and keeps what was resolved", () => {
      c = withResolver(
        (fx) => `${RESOLVE_BOTH}
${moveMain(
  fx,
  "a.txt",
  `"main$(wc -l < ${JSON.stringify(join(fx.root, "calls"))} | tr -d ' ')"`,
)}`,
      );

      const r = runDispatcher(c, auto);

      expect(r.out).toContain(
        "✗ #40 did not land — main moved twice while the agent was resolving, and the newest commits conflict too",
      );
      expect(r.code).toBe(1);
      expect(calls(c)).toBe(2);
      expect(rebaseInProgress(c.wt(40))).toBe(false);
      // On the base the second pass rebased onto: main before its last move.
      const wt = c.wt(40);
      expect(() =>
        git(wt, "merge-base", "--is-ancestor", "main~1", "HEAD"),
      ).not.toThrow();
    });
  });

  /**
   * Without --auto the conflict is only offered at a prompt, and `-y` parks
   * before the offer. --auto-resolve hands it over anyway.
   */
  describe("--auto-resolve without --auto", () => {
    const released = ["--once", "-y", "40"];
    const BLOCK = ["bash", "-c", "echo 'VERDICT: BLOCK'", "reviewer"];

    it("hands the conflict to the agent and lands the slice", () => {
      c = conflicting('bash "$(dirname "$PWD")/resolver.sh" "$1"');
      writeFileSync(join(c.root, "resolver.sh"), logged(c.root, RESOLVE_BOTH));

      const r = runDispatcher(c, ["--auto-resolve", ...released]);

      expect(r.out).toContain(
        "conflicts: --auto-resolve — a failed rebase is handed to the agent, re-verified and gated. Review is OFF: the gates are the only check on a resolution.",
      );
      expect(r.code).toBe(0);
      expect(calls(c)).toBe(1);
      expect(readFileSync(join(c.main, "a.txt"), "utf8")).toBe(
        "main\nbranch\n",
      );
    });

    it("parks without the flag, and names it", () => {
      c = conflicting('bash "$(dirname "$PWD")/resolver.sh" "$1"');
      writeFileSync(join(c.root, "resolver.sh"), logged(c.root, RESOLVE_BOTH));

      const r = runDispatcher(c, released);

      expect(r.out).toMatch(
        /parked \(non-interactive\) — .*\n {5}--auto-resolve lets the agent resolve it\./,
      );
      expect(r.code).toBe(1);
      expect(calls(c)).toBe(0);
    });

    it("does not name the flag once the agent has tried", () => {
      c = conflicting("echo 'IRRECONCILABLE: no'");
      const r = runDispatcher(c, ["--auto-resolve", ...released]);
      expect(r.code).toBe(1);
      expect(r.out).not.toContain("--auto-resolve lets the agent");
    });

    it("lets the spec review block a slice that was resolved", () => {
      c = conflicting(RESOLVE_BOTH, ["a.txt"], { review: BLOCK });

      const r = runDispatcher(c, ["--auto-resolve", "--review", ...released]);

      expect(r.out).toContain(
        "the spec review blocks a slice that was resolved.",
      );
      expect(r.out).toContain("#40 not landed — spec review says BLOCK.");
      expect(r.code).toBe(1);
      expect(git(c.main, "log", "-1", "--format=%s")).toBe("main: a.txt");
    });

    it("leaves the review advisory for a slice that was not resolved", () => {
      c = makeConsumer({
        worktrees: [40],
        remote: true,
        review: BLOCK,
        resolve: ["true"],
      });
      commitIn(c.wt(40), "a.txt", "branch\n", "feat: a.txt");
      sh(c.wt(40), "./scripts/slice-done.sh");

      const r = runDispatcher(c, ["--auto-resolve", "--review", ...released]);

      expect(r.out).toContain("review is advisory here");
      expect(r.code).toBe(0);
      expect(git(c.main, "log", "-1", "--format=%s")).toBe("feat: a.txt");
    });

    it("refuses both flags together", () => {
      c = conflicting(RESOLVE_BOTH);
      const r = runDispatcher(c, [
        "--auto-resolve",
        "--no-auto-resolve",
        ...released,
      ]);
      expect(r.code).toBe(64);
      expect(r.out).toContain("contradict each other");
    });

    it("refuses before dispatch when the agent has no resolver", () => {
      // A fake agent that can review and cannot resolve.
      c = makeConsumer({ worktrees: [40], remote: true, review: ["true"] });
      commitIn(c.wt(40), "a.txt", "branch\n", "feat: a.txt");
      sh(c.wt(40), "./scripts/slice-done.sh");

      const r = runDispatcher(c, ["--auto-resolve", ...released]);

      expect(r.code).toBe(1);
      expect(r.out).toContain(
        "declares no resolver — --auto-resolve has nothing to run",
      );
      expect(git(c.main, "log", "-1", "--format=%s")).not.toBe("feat: a.txt");
    });
  });

  it("gives up when the resolver says the sides cannot coexist", () => {
    c = conflicting("echo 'IRRECONCILABLE: both sides rewrite the same line'");
    const head = git(c.wt(40), "rev-parse", "HEAD");

    const r = runDispatcher(c, auto);

    expect(r.out).toContain(
      "resolution rejected — the resolver says the two sides cannot coexist: both sides rewrite the same line",
    );
    expect(r.out).toContain(
      "to re-port it by hand: azelf hold 40, rebase it onto main in its worktree and commit, then azelf release 40 — the moved branch retries the land",
    );
    // Nothing of this run's landed under it.
    expect(r.out).not.toContain("it collides with");
    expect(r.code).toBe(1);
    expect(git(c.wt(40), "rev-parse", "HEAD")).toBe(head);
    expect(rebaseInProgress(c.wt(40))).toBe(false);
    expect(existsSync(c.closeFile)).toBe(false);
    // The same run's flags, without --once.
    expect(r.out).toContain(
      "To pick the run up again:\n\n    ./scripts/azelf run --auto -y --no-review 40\n",
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

  it("names the land it collided with, when this run made it", () => {
    c = makeConsumer({
      worktrees: [40, 41],
      remote: true,
      resolve: [
        "bash",
        "-c",
        "echo 'IRRECONCILABLE: both rewrite a.txt'",
        "resolver",
      ],
    });
    commitIn(c.wt(40), "a.txt", "forty\n", "feat: 40");
    sh(c.wt(40), "./scripts/slice-done.sh");
    commitIn(c.wt(41), "a.txt", "forty-one\n", "feat: 41");
    sh(c.wt(41), "./scripts/slice-done.sh");

    const r = runDispatcher(c, [
      "--auto",
      "-y",
      "--no-review",
      "--interval",
      "1",
      "40",
      "41",
    ]);

    expect(r.out).toContain(
      "it collides with #40, which landed a.txt while #41 was open",
    );
    expect(r.out).toContain(
      "to re-port it by hand: azelf hold 41, rebase it onto main in its worktree and commit, then azelf release 41 — the moved branch retries the land",
    );
    expect(r.code).toBe(1);
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
 * The plan-level review runs after everything has landed, so it cannot block.
 * Its count is the run's last line, and findings are exit 2: three waves on
 * consumer-a ended "plan complete", exit 0, with findings in a file.
 */
describe("the plan-level review's outcome", () => {
  /** Passes every spec review; answers the plan prompt with `plan`. */
  const reviewer = (plan: string) => [
    "bash",
    "-c",
    `case "$1" in *cross-cutting*) ${plan} ;; *) echo "VERDICT: PASS" ;; esac`,
    "reviewer",
  ];

  /** Two slices by default: the plan review needs a seam to read. */
  const landed = (
    plan: string,
    flags: string[] = [],
    slices: number[] = [40, 41],
  ) => {
    c = makeConsumer({
      worktrees: slices,
      remote: true,
      review: reviewer(plan),
    });
    for (const n of slices) {
      commitIn(c.wt(n), `f${n}.txt`, `${n}\n`, `feat: ${n}`);
      sh(c.wt(n), "./scripts/slice-done.sh");
    }
    const r = runDispatcher(c, [
      "--auto",
      "-y",
      "--interval",
      "1",
      ...flags,
      ...slices.map(String),
    ]);
    const log = git(c.main, "log", "--format=%s");
    for (const n of slices) expect(log).toContain(`feat: ${n}`);
    return { ...r, last: r.stdout.trimEnd().split("\n").pop() ?? "" };
  };

  it("exits 2 on findings, and ends on the count and the report", () => {
    const r = landed(
      'echo "**1.** one"; echo "**2.** two"; echo "FINDINGS: 2"',
    );
    expect(r.out).toContain("✓ every ticket closed — plan complete.");
    expect(r.code).toBe(2);
    expect(r.last).toMatch(
      /^ {2}plan review: 2 findings, all of it already landed → \S+\/\.slice-reviews\/plan-\S+\.md$/,
    );
  });

  it("exits 0 when there are none, and says so last", () => {
    const r = landed(
      'echo "No cross-cutting findings."; echo "**FINDINGS: 0**"',
    );
    expect(r.code).toBe(0);
    expect(r.last).toBe("  plan review: no cross-cutting findings.");
  });

  it("exits 2 when the review gives no count", () => {
    const r = landed('echo "Looks fine to me."');
    expect(r.code).toBe(2);
    expect(r.last).toMatch(
      /^ {2}plan review: no result — it did not return, or gave no count → \S+plan-\S+\.md$/,
    );
  });

  it("exits 2 when the review does not return", () => {
    const r = landed("exit 1");
    expect(r.code).toBe(2);
    expect(r.last).toContain("plan review: no result");
  });

  it("says nothing when review is off", () => {
    const r = landed('echo "FINDINGS: 2"', ["--no-review"]);
    expect(r.code).toBe(0);
    expect(r.out).not.toContain("plan review:");
  });

  it("asks no agent when one slice landed, and says why", () => {
    const asked = join(
      tmpdir(),
      `azelf-plan-asked-${process.pid}-${Date.now()}`,
    );
    const r = landed(`touch ${asked}; echo "FINDINGS: 0"`, [], [40]);
    expect(existsSync(asked), "the reviewer was asked").toBe(false);
    expect(r.code).toBe(0);
    expect(r.out).not.toContain("── plan-level review");
    expect(r.last).toBe(
      "plan review: skipped — one slice landed in this run (#40), and its own review covered it.",
    );
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

  it("rebases a land that lost the fast-forward race again, and lands it", () => {
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
    expect(r.out).toMatch(
      /#40: main moved while it was being gated \(now [0-9a-f]{7}\) — rebasing again\n/,
    );
    expect(r.out).not.toContain("parked");
    expect(r.code).toBe(0);
    expect(git(c.main, "log", "--format=%s", "-3")).toBe(
      "feat: a\nrace: another land\ninit",
    );
  });

  it("sends a BLOCK back to a session when the ticket is edited, with the ticket and the finding", async () => {
    // Blocks until the ticket body says FIXED. Each step adds a line to one
    // file, next to the worktree, so the order is what the test reads.
    const review = `echo review >> ../events
case "$1" in *FIXED*) echo "VERDICT: PASS" ;; *) echo "the screen is missing"; echo "VERDICT: BLOCK" ;; esac`;
    const agent = `echo session >> ../events
printf "%s" "$1" > ../prompt
cp .slice-ticket.md ../ticket-seen
cp .slice-reviews/last-block.md ../finding-seen
git status --porcelain > ../status-seen`;
    const { c, d } = parkedRun(
      {
        review: ["bash", "-c", review, "reviewer"],
        gate: ["bash", "-c", "echo gate >> ../events"],
        agent: ["bash", "-c", agent, "agent"],
        launch: true,
        body: "build a",
      },
      ["--auto"],
    );
    const seenFile = (name: string) => readFileSync(join(c.root, name), "utf8");
    await d.until(
      "parked (non-interactive) — retried when its branch moves, or now with: azelf retry 40; sent back to a session when the ticket is edited, or now with: azelf relaunch 40",
    );
    await d.until(seen("parked (non-interactive)", 1, 3));
    // An unchanged ticket is not reviewed again.
    expect(seenFile("events")).toBe("gate\nreview\nreview\n");
    // The ✗ line names the way back, and the review file right under it.
    expect(d.output()).toMatch(
      /#40 not landed — spec review says BLOCK\. Send it back to a session with the finding \(azelf relaunch 40\).*\n {5}review: \S+\/\.slice-reviews\/ticket-40\.md\n/,
    );

    c.setTicket("40", { body: "build a — FIXED" });
    await d.until(
      "#40: the ticket was edited since the BLOCK — sending it back to a session with the finding.",
    );
    await d.until(LANDED);

    // The session comes first: no gate or review of unchanged code against
    // the new ticket. The land after it is the ordinary one.
    expect(seenFile("events")).toBe(
      "gate\nreview\nreview\nsession\ngate\nreview\nreview\n",
    );
    expect(seenFile("prompt")).toContain(
      "The last land of this slice was refused by the spec review. Its finding is in .slice-reviews/last-block.md in this worktree",
    );
    expect(seenFile("ticket-seen")).toContain("build a — FIXED");
    expect(seenFile("finding-seen")).toContain("the screen is missing");
    expect(seenFile("status-seen")).toBe("");
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

  it("a new comment after a BLOCK counts as an edit, and both the session and the review read it", async () => {
    const review = `printf "%s" "$1" >> ../review-prompts
case "$1" in *CORRECTED*) echo "VERDICT: PASS" ;; *) echo "VERDICT: BLOCK" ;; esac`;
    const { c, d } = parkedRun(
      {
        review: ["bash", "-c", review, "reviewer"],
        agent: ["bash", "-c", "cp .slice-ticket.md ../ticket-seen", "agent"],
        launch: true,
        threads: true,
        body: "build a",
      },
      ["--auto"],
    );
    await d.until("sent back to a session when the ticket is edited");

    c.setTicket("40", {
      comments: [{ author: "alex", at: "then", body: "CORRECTED: as it is" }],
    });
    await d.until(
      "#40: the ticket was edited since the BLOCK — sending it back",
    );
    await d.until(LANDED);

    expect(readFileSync(join(c.root, "ticket-seen"), "utf8")).toContain(
      "CORRECTED: as it is",
    );
    expect(git(c.main, "log", "-1", "--format=%s")).toBe("feat: a");
  }, 60_000);

  it("comments that cannot be read do not read as an edit", async () => {
    const { c, d } = parkedRun(
      {
        review: ["bash", "-c", 'echo "VERDICT: BLOCK"', "reviewer"],
        threads: true,
        body: "build a",
      },
      ["--auto"],
    );
    await d.until("sent back to a session when the ticket is edited");

    c.setTicket("40", { unreadable: true });
    await d.until(seen("[round", 3));
    expect(d.output()).not.toContain("the ticket was edited since the BLOCK");
  }, 60_000);

  it("a review that could not run has no finding: an edited ticket reviews again", async () => {
    const review = `case "$1" in *FIXED*) echo "VERDICT: PASS" ;; *) echo "no reviewer" >&2; exit 1 ;; esac`;
    const { c, d } = parkedRun(
      {
        review: ["bash", "-c", review, "reviewer"],
        launch: true,
        body: "build a",
      },
      ["--auto"],
    );
    await d.until(
      "parked (non-interactive) — retried when its branch moves, when the ticket is edited, or now with: azelf retry 40; sent back to a session with: azelf relaunch 40",
    );

    c.setTicket("40", { body: "build a — FIXED" });
    await d.until("#40: the ticket was edited since the BLOCK — retrying.");
    await d.until(LANDED);

    expect(d.output()).not.toContain("starting #40");
    expect(git(c.main, "log", "-1", "--format=%s")).toBe("feat: a");
  }, 60_000);

  it("azelf relaunch opens a session for a parked slice in the running dispatcher", async () => {
    // Red until the session has run: it leaves ../ok next to the worktree.
    const { c, d } = parkedRun(
      {
        gate: ["test", "-f", "../ok"],
        agent: [
          "bash",
          "-c",
          "echo session >> ../events; touch ../ok",
          "agent",
        ],
        launch: true,
      },
      ["--auto", "--no-review"],
    );
    await d.until(RED);

    const r = azelfRelaunch(c, "40");
    expect(r.code).toBe(0);
    expect(r.out).toContain("#40 goes back to a session");
    expect(r.out).toContain("its last review gave no BLOCK to pass on");
    expect(r.out).toContain(
      `the running dispatcher (pid ${d.pid}) opens it next round`,
    );
    await d.until("#40: relaunch requested — opening a session.");
    await d.until(LANDED);

    expect(readFileSync(join(c.root, "events"), "utf8")).toBe("session\n");
    expect(count(d.output(), RED)).toBe(1);
    expect(git(c.main, "log", "-1", "--format=%s")).toBe("feat: a");
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
      `the running dispatcher (pid ${d.pid}) retries #40 next round`,
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
/**
 * A land refused because the base moved after the slice was rebased: on
 * consumer-a another run landed during #103's spec review, and the refusal
 * parked it until the base moved again, hours later. Here the fake reviewer
 * is that other run: during the spec review it commits to main, in the main
 * checkout next to the worktree, `moves` times in all.
 */
describe("a land overtaken during the review", () => {
  const racer = (file: string, moves: number) => [
    "bash",
    "-c",
    `case "$1" in *"faithfully implement"*)
  echo spec >> ../reviews
  n=$(cat ../moves 2>/dev/null | wc -l | tr -d ' ')
  if [ "$n" -lt ${moves} ]; then
    echo move >> ../moves
    cd ../repo && echo "move $n" >> ${file} && git add ${file} && git commit -qm "race: move $n"
  fi ;;
esac
echo "VERDICT: PASS"`,
    "reviewer",
  ];
  const lines = (fx: Consumer, name: string) =>
    existsSync(join(fx.root, name))
      ? readFileSync(join(fx.root, name), "utf8").trim().split("\n").length
      : 0;
  /** #40 changes the first line of shared.txt, which main has too. */
  const overtaken = (file: string, moves: number) => {
    const fx = makeConsumer({
      worktrees: [40],
      remote: true,
      gate: ["bash", "-c", "echo gate >> ../gates"],
      review: racer(file, moves),
    });
    c = fx;
    commitIn(fx.main, "shared.txt", "1\n2\n3\n4\n5\n6\n7\n", "base: shared");
    git(fx.main, "push", "-q", "origin", "main");
    git(fx.wt(40), "rebase", "-q", "main");
    commitIn(fx.wt(40), "shared.txt", "one\n2\n3\n4\n5\n6\n7\n", "feat: one");
    sh(fx.wt(40), "./scripts/slice-done.sh");
    const r = runDispatcher(fx, ["--review", "-y", "--once", "40"]);
    return { fx, r };
  };
  const RACED =
    /#40: main moved while it was being gated and reviewed \(now [0-9a-f]{7}\) — rebasing again\n/g;

  it("rebases and gates it again, skips the review when the new commits miss its files, and lands it in the same round", () => {
    const { fx, r } = overtaken("other.txt", 1);
    expect(r.out).toContain("it has diverged");
    expect(r.out.match(RACED)).toHaveLength(1);
    expect(r.out).toContain(
      "  review skipped — the new commits on main touch none of #40's files\n",
    );
    expect(lines(fx, "gates")).toBe(2);
    expect(lines(fx, "reviews")).toBe(1);
    expect(r.out).not.toContain("parked");
    expect(r.code).toBe(0);
    expect(git(fx.main, "log", "--format=%s", "-3")).toBe(
      "feat: one\nrace: move 0\nbase: shared",
    );
    expect(readFileSync(fx.closeFile, "utf8")).toContain("40\n");
  });

  it("reviews it again when the new commits touch one of its files", () => {
    const { fx, r } = overtaken("shared.txt", 1);
    expect(r.out.match(RACED)).toHaveLength(1);
    expect(r.out).not.toContain("review skipped");
    expect(lines(fx, "gates")).toBe(2);
    expect(lines(fx, "reviews")).toBe(2);
    expect(r.code).toBe(0);
    expect(readFileSync(join(fx.main, "shared.txt"), "utf8")).toBe(
      "one\n2\n3\n4\n5\n6\n7\nmove 0\n",
    );
  });

  it("parks it as a land after two races", () => {
    const { fx, r } = overtaken("shared.txt", 99);
    expect(r.out.match(RACED)).toHaveLength(2);
    expect(lines(fx, "reviews")).toBe(3);
    expect(r.out).toContain(
      "main moved under it 3 times between its rebase and its land",
    );
    expect(r.out).toContain(
      "parked (non-interactive) — retried when its branch moves, when main moves, or now with: azelf retry 40",
    );
    expect(r.code).not.toBe(0);
    expect(git(fx.main, "log", "--format=%s", "-1")).toBe("race: move 2");
  });
});

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

const azelfRelaunch = (fx: Consumer, ...args: string[]) => {
  const r = spawnSync(
    "bun",
    [join(AZELF, "bin", "azelf.ts"), "relaunch", ...args],
    {
      cwd: fx.main,
      encoding: "utf8",
      env: { ...process.env, SLICE_REPO_ROOT: fx.main },
    },
  );
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
};

describe("a red gate's whole output", () => {
  /** A gate that prints the red part first and a long table after it. */
  const LONG = [
    "bash",
    "-c",
    'echo "RED-PART-NAME"; for i in $(seq 40); do echo "row $i"; done; exit 1',
  ];
  const gateRun = (gate: string[]) => {
    const fx = makeConsumer({ worktrees: [40], gate });
    c = fx;
    commitIn(fx.wt(40), "a.txt", "a\n", "feat: a");
    return { fx, r: runDispatcher(fx, ["--gates", "40"]) };
  };
  const logOf = (fx: Consumer) =>
    join(fx.wt(40), ".slice-reviews", "last-gate.log");

  it("is kept and named when the lines shown are not all of it, and the tree stays clean", () => {
    const { fx, r } = gateRun(LONG);

    expect(r.code).toBe(1);
    expect(r.out).toContain("row 40");
    // Not among the lines shown; the gate's name is its script, which has it.
    expect(r.out).not.toMatch(/^ *RED-PART-NAME$/m);
    expect(r.out).toContain(`whole output: ${logOf(fx)}`);
    const log = readFileSync(logOf(fx), "utf8");
    expect(log).toContain("RED-PART-NAME");
    expect(log).toContain("row 40");
    expect(git(fx.wt(40), "status", "--porcelain")).toBe("");
  }, 60_000);

  it("writes nothing when it was all shown", () => {
    const { fx, r } = gateRun(["bash", "-c", 'echo "short"; exit 1']);

    expect(r.code).toBe(1);
    expect(r.out).toContain("short");
    expect(r.out).not.toContain("whole output");
    expect(existsSync(logOf(fx))).toBe(false);
  }, 60_000);

  it("writes nothing where git does not ignore it, and the gate still reports", () => {
    const fx = makeConsumer({ worktrees: [40], gate: LONG });
    c = fx;
    commitIn(fx.wt(40), "a.txt", "a\n", "feat: a");
    const exclude = join(fx.main, ".git", "info", "exclude");
    writeFileSync(
      exclude,
      readFileSync(exclude, "utf8").replace(".slice-reviews/\n", ""),
    );

    const r = runDispatcher(fx, ["--gates", "40"]);

    expect(r.code).toBe(1);
    expect(r.out).toContain("row 40");
    expect(r.out).not.toContain("whole output");
    expect(existsSync(logOf(fx))).toBe(false);
    expect(git(fx.wt(40), "status", "--porcelain")).toBe("");
  }, 60_000);
});

describe("--gates --keep-going", () => {
  const FIRST =
    'echo FIRST-RED; for i in $(seq 40); do echo "row $i"; done; exit 1';
  const SECOND = "echo SECOND-RED; exit 1";
  /** A consumer whose two gates are both red, the first with a long output. */
  const twoRed = (first = FIRST) => {
    const fx = makeConsumer({ worktrees: [40], gate: ["true"] });
    c = fx;
    commitIn(fx.wt(40), "a.txt", "a\n", "feat: a");
    const config = join(fx.main, "slice.config.ts");
    const gate = (script: string) =>
      `exitCode(["bash", "-c", ${JSON.stringify(script)}])`;
    writeFileSync(
      config,
      readFileSync(config, "utf8").replace(
        /gates: \[.*\],/,
        `gates: [${gate(first)}, ${gate(SECOND)}],`,
      ),
    );
    return fx;
  };
  const logOf = (fx: Consumer) =>
    join(fx.wt(40), ".slice-reviews", "last-gate.log");

  it("stops at the first red gate without it", () => {
    const fx = twoRed();
    const r = runDispatcher(fx, ["--gates", "40"]);

    expect(r.code).toBe(1);
    expect(r.out).not.toContain("SECOND-RED");
    expect(readFileSync(logOf(fx), "utf8")).not.toContain("SECOND-RED");
  }, 60_000);

  it("reports every red gate, and the tree stays clean", () => {
    const fx = twoRed();
    const r = runDispatcher(fx, ["--gates", "--keep-going", "40"]);

    expect(r.code).toBe(1);
    expect(r.out).toContain("SECOND-RED");
    expect(r.out).toMatch(/✗ `bash -c echo FIRST-RED.*` failed/);
    expect(r.out).toContain("✗ `bash -c echo SECOND-RED; exit 1` failed");
    expect(r.out).toContain("✗ #40 not landed — 2 gates are red");
    expect(git(fx.wt(40), "status", "--porcelain")).toBe("");
  }, 60_000);

  it("keeps each red gate's output under its name", () => {
    const fx = twoRed();
    const r = runDispatcher(fx, ["--gates", "--keep-going", "40"]);

    expect(r.out).toContain(`whole output: ${logOf(fx)}`);
    const log = readFileSync(logOf(fx), "utf8");
    expect(log).toMatch(/`bash -c echo FIRST-RED.*`\n/);
    expect(log).toContain("FIRST-RED\n");
    expect(log).toContain("`bash -c echo SECOND-RED; exit 1`\n");
    expect(log).toContain("SECOND-RED\n");
  }, 60_000);

  it("writes no file when every red gate was shown whole", () => {
    const fx = twoRed("echo SHORT-RED; exit 1");
    const r = runDispatcher(fx, ["--gates", "--keep-going", "40"]);

    expect(r.code).toBe(1);
    expect(r.out).toContain("SHORT-RED");
    expect(r.out).toContain("SECOND-RED");
    expect(r.out).not.toContain("whole output");
    expect(existsSync(logOf(fx))).toBe(false);
  }, 60_000);

  it("is what `azelf gates` passes on, and a flag it does not know is still refused", () => {
    const fx = twoRed();
    const verb = (...args: string[]) =>
      spawnSync("bun", [join(AZELF, "bin", "azelf.ts"), "gates", ...args], {
        cwd: fx.main,
        encoding: "utf8",
        env: { ...process.env, SLICE_REPO_ROOT: fx.main },
      });

    const r = verb("40", "--keep-going");
    expect(r.status).toBe(1);
    expect(r.stdout).toContain("2 gates are red");

    expect(verb("--keep-going", "40").stdout).toContain("2 gates are red");
    expect(verb("40", "--bogus").stdout).not.toContain("gate(s) for #40");
    expect(verb("40", "41").stdout).not.toContain("gate(s) for #40");
  }, 60_000);

  it("is what the skill's slice-gates.sh passes on, from inside the worktree", () => {
    const fx = twoRed();
    const r = spawnSync(
      "bash",
      [join(AZELF, "scripts", "slice-gates.sh"), "--keep-going"],
      {
        cwd: fx.wt(40),
        encoding: "utf8",
        env: { ...process.env, SLICE_REPO_ROOT: fx.main },
      },
    );

    expect(r.status).toBe(1);
    expect(r.stdout).toContain("2 gates are red");
  }, 60_000);
});

/**
 * One slice at a time goes from rebase to land, across runs. Under the old rule
 * each land threw away another run's rebase, gates and review.
 */
describe("the land reservation", () => {
  const LOCK = join(AZELF, "scripts", "slice-lock.ts");
  const dirOf = (fx: Consumer) =>
    spawnSync("bun", [LOCK, "next-land-dir", fx.main], {
      encoding: "utf8",
      env: process.env,
    }).stdout.trim();
  const WAITS = "#40 waits for #99's land (another run, pid";
  /** Another run on its way: a live process holding the reservation. */
  const holdFor = (fx: Consumer) => {
    const other = spawn("sleep", ["120"], { stdio: "ignore" });
    const r = spawnSync(
      "bun",
      [
        LOCK,
        "acquire",
        dirOf(fx),
        "--pid",
        String(other.pid),
        "--label",
        "#99",
        "--what",
        "land",
      ],
      { encoding: "utf8", env: process.env },
    );
    expect(r.status, r.stderr).toBe(0);
    return other;
  };

  it("held by another run: nothing is gated, the run goes on, and it lands when that one ends", async () => {
    const fx = makeConsumer({
      worktrees: [40, 41],
      remote: true,
      gate: ["bash", "-c", "echo gate >> ../gates"],
    });
    c = fx;
    commitIn(fx.wt(40), "a.txt", "a\n", "feat: a");
    sh(fx.wt(40), "./scripts/slice-done.sh");
    sessions.push(fakeSession(fx, 41));
    const other = holdFor(fx);
    try {
      d = startDispatcher(fx, ["--auto", "-y", "--interval", "1", "40", "41"]);
      await d.until(WAITS);
      await d.until(/waits for[\s\S]*\[round \d+\][\s\S]*\[round \d+\]/);
      expect(d.output().split(WAITS).length - 1).toBe(1);
      expect(existsSync(join(fx.root, "gates"))).toBe(false);
      expect(git(fx.main, "log", "-1", "--format=%s")).toBe("init");
    } finally {
      other.kill("SIGKILL");
    }
    await d.until("took over the land reservation from #99");
    await d.until("1 running · 0 blocked · 1 open —");
    expect(git(fx.main, "log", "-1", "--format=%s")).toBe("feat: a");
    expect(existsSync(dirOf(fx))).toBe(false);
  }, 60_000);

  it("two real runs on two slices run the gates twice, not three times", async () => {
    const fx = makeConsumer({
      worktrees: [40, 42],
      remote: true,
      gate: ["bash", "-c", "sleep 1; echo gate >> ../gates"],
    });
    c = fx;
    commitIn(fx.wt(40), "a.txt", "a\n", "feat: a");
    commitIn(fx.wt(42), "b.txt", "b\n", "feat: b");
    sh(fx.wt(40), "./scripts/slice-done.sh");
    sh(fx.wt(42), "./scripts/slice-done.sh");

    const args = ["--auto", "--no-review", "-y", "--interval", "1"];
    const a = startDispatcher(fx, [...args, "40"]);
    const b = startDispatcher(fx, [...args, "42"]);
    const [codeA, codeB] = await Promise.all([a.exited, b.exited]);

    expect(codeA, a.output()).toBe(0);
    expect(codeB, b.output()).toBe(0);
    expect(
      readFileSync(join(fx.root, "gates"), "utf8").trim().split("\n").length,
    ).toBe(2);
    expect(`${a.output()}${b.output()}`).not.toContain("rebasing again");
    expect(git(fx.main, "log", "--format=%s", "-2").split("\n").sort()).toEqual(
      ["feat: a", "feat: b"],
    );
    expect(existsSync(dirOf(fx))).toBe(false);
  }, 90_000);

  it("is given back after a park", () => {
    const fx = makeConsumer({ worktrees: [40], remote: true, gate: ["false"] });
    c = fx;
    commitIn(fx.wt(40), "a.txt", "a\n", "feat: a");
    sh(fx.wt(40), "./scripts/slice-done.sh");

    const r = runDispatcher(fx, [
      "--auto",
      "--once",
      "-y",
      "--no-review",
      "40",
    ]);

    expect(r.out).toContain("did not land");
    expect(existsSync(dirOf(fx))).toBe(false);
  }, 60_000);
});

/**
 * A session has the prompt of the run that started it. A run under --auto that
 * finds one started without it says so in the worktree, where the session can
 * check it, and does not land it for that.
 */
describe(".slice-run-mode", () => {
  const AUTO = ["--auto", "--once", "-y", "--no-review", "40"];
  const mode = (fx: Consumer) => join(fx.wt(40), ".slice-run-mode");
  /** A commit in #40, and a session the dispatcher takes for #40's. */
  const open = (extra: string[] = []) => {
    const fx = makeConsumer({ worktrees: [40], remote: true });
    c = fx;
    commitIn(fx.wt(40), "a.txt", "a\n", "feat: a");
    const script = join(fx.root, "slice-session.sh");
    writeFileSync(script, "while :; do sleep 0.2; done\n");
    const s = spawn("bash", [script, "40", ...extra], { stdio: "ignore" });
    stray.push(s);
    writeFileSync(join(fx.wt(40), ".slice-live"), `${s.pid}\n`);
    return { fx, pid: s.pid };
  };
  const stray: ReturnType<typeof spawn>[] = [];
  afterEach(() => {
    for (const s of stray.splice(0)) s.kill("SIGKILL");
  });

  it("is written for a session started without --auto, and the slice is not landed for it", () => {
    const { fx, pid } = open();

    const r = runDispatcher(fx, AUTO);

    expect(readFileSync(mode(fx), "utf8")).toMatch(/^auto\nWritten at /);
    expect(r.out).toContain(
      `#40: its session (pid ${pid}) was started without --auto, so it still waits for a person — ./scripts/slice-done.sh in its tab releases it; .slice-run-mode tells it, if it asks`,
    );
    expect(git(fx.main, "log", "-1", "--format=%s")).toBe("init");
    expect(git(fx.wt(40), "status", "--porcelain")).toBe("");
  }, 60_000);

  it("is not written for a session told to land itself, on its command line or in its flags", () => {
    const a = open(["--self-land"]);
    expect(runDispatcher(a.fx, AUTO).out).not.toContain(
      "started without --auto",
    );
    expect(existsSync(mode(a.fx))).toBe(false);
    rmSync(a.fx.root, { recursive: true, force: true });

    const b = open();
    writeFileSync(join(b.fx.wt(40), ".slice-flags"), "--self-land\n");
    expect(runDispatcher(b.fx, AUTO).out).not.toContain(
      "started without --auto",
    );
    expect(existsSync(mode(b.fx))).toBe(false);
  }, 60_000);

  it("is not written where git does not ignore it, and the run still says so", () => {
    const { fx } = open();
    const exclude = join(fx.main, ".git", "info", "exclude");
    writeFileSync(
      exclude,
      readFileSync(exclude, "utf8").replace(".slice-run-mode\n", ""),
    );

    const r = runDispatcher(fx, AUTO);

    expect(existsSync(mode(fx))).toBe(false);
    expect(r.out).toContain("was started without --auto");
    expect(r.out).not.toContain(".slice-run-mode tells it");
    expect(git(fx.wt(40), "status", "--porcelain")).toBe("");
  }, 60_000);

  it("is removed by a run without --auto", () => {
    const { fx } = open();
    writeFileSync(mode(fx), "auto\nold\n");

    const r = runDispatcher(fx, ["--once", "-y", "40"]);

    expect(existsSync(mode(fx))).toBe(false);
    expect(r.out).not.toContain("started without --auto");
  }, 60_000);

  it("is gone when the next session starts", () => {
    const fx = makeConsumer({ worktrees: [40], remote: true, agent: ["true"] });
    c = fx;
    writeFileSync(mode(fx), "auto\nold\n");

    sh(fx.main, "./scripts/slice-session.sh 40");

    expect(existsSync(mode(fx))).toBe(false);
  }, 60_000);
});

describe("azelf relaunch", () => {
  /** Two attempts on file for #40, in the review's own shape. */
  const reviewed = (fx: Consumer, spec: string) => {
    mkdirSync(join(fx.main, ".slice-reviews"), { recursive: true });
    writeFileSync(
      join(fx.main, ".slice-reviews", "ticket-40.md"),
      `# Review — #40 t

## Attempt 1 — 2026-11-02 10:00

### Spec

the first finding
VERDICT: BLOCK

### Standards

nothing

## Attempt 2 — 2026-11-02 11:00

### Spec

${spec}

### Standards

VERDICT: BLOCK is not this section's to say
`,
    );
  };
  const done = () => {
    const fx = makeConsumer({
      worktrees: [40],
      remote: true,
      agent: ["bash", "-c", 'printf "%s" "$1" > ../prompt', "agent"],
      launch: true,
    });
    commitIn(fx.wt(40), "a.txt", "a\n", "feat: a");
    sh(fx.wt(40), "./scripts/slice-done.sh");
    c = fx;
    return fx;
  };
  const marker = (fx: Consumer, name: string) => join(fx.wt(40), name);
  const FINDING = ".slice-reviews/last-block.md";

  it("with no dispatcher: marks the slice, and the next run opens the session with the finding", async () => {
    const fx = done();
    reviewed(fx, "the second finding\nVERDICT: BLOCK");

    const r = azelfRelaunch(fx, "40");

    expect(r.code).toBe(0);
    expect(r.out).toContain(
      `#40 goes back to a session, with the review's finding in ${fx.wt(
        40,
      )}/${FINDING}.`,
    );
    expect(r.out).toContain(
      "no running dispatcher has #40 — azelf run --auto 40 starts one",
    );
    expect(existsSync(marker(fx, ".slice-ready-to-land"))).toBe(false);
    expect(readFileSync(marker(fx, ".slice-interrupted"), "utf8")).toBe(
      "relaunch\n",
    );
    const finding = readFileSync(marker(fx, FINDING), "utf8");
    expect(finding).toContain("the second finding");
    expect(finding).not.toContain("the first finding");
    // In the exclude block: a dirty tree would read as unfinished work.
    expect(git(fx.wt(40), "status", "--porcelain")).toBe("");

    const run = runDispatcher(fx, [
      "--auto",
      "--once",
      "-y",
      "--no-review",
      "40",
    ]);
    expect(run.out).toContain("started #40");
    expect(run.out).not.toContain("marked done");
    expect(git(fx.main, "log", "-1", "--format=%s")).toBe("init");
    const prompt = join(fx.root, "prompt");
    const end = Date.now() + 30_000;
    while (!existsSync(prompt) && Date.now() < end) {
      await new Promise((res) => setTimeout(res, 100));
    }
    expect(readFileSync(prompt, "utf8")).toContain(
      "Its finding is in .slice-reviews/last-block.md",
    );
  }, 60_000);

  it("no BLOCK, no file: a PASS on the last attempt takes back an older finding", () => {
    const fx = done();
    mkdirSync(join(fx.wt(40), ".slice-reviews"));
    writeFileSync(marker(fx, FINDING), "from an earlier relaunch\n");
    reviewed(fx, "fine\nVERDICT: PASS");

    const r = azelfRelaunch(fx, "40");

    expect(r.code).toBe(0);
    expect(r.out).toContain("its last review gave no BLOCK to pass on");
    expect(existsSync(marker(fx, FINDING))).toBe(false);
  });

  it("a review that could not run is no finding", () => {
    const fx = done();
    reviewed(fx, "(spec review did not return — treating as BLOCK)");

    const r = azelfRelaunch(fx, "40");

    expect(r.code).toBe(0);
    expect(existsSync(marker(fx, FINDING))).toBe(false);
  });

  it("refuses a ticket with no worktree, and an unusable id", () => {
    c = makeConsumer({});
    const none = azelfRelaunch(c, "99");
    expect(none.code).toBe(1);
    expect(none.out).toContain("#99: no worktree at");
    expect(azelfRelaunch(c, "nope").code).toBe(64);
    expect(azelfRelaunch(c, "99", "100").code).not.toBe(0);
  });

  /** A refusal changes nothing: the ready marker is still there. */
  const refused = (fx: Consumer, text: string) => {
    const r = azelfRelaunch(fx, "40");
    expect(r.code).toBe(1);
    expect(r.out).toContain(text);
    expect(existsSync(marker(fx, ".slice-ready-to-land"))).toBe(true);
    expect(existsSync(marker(fx, ".slice-interrupted"))).toBe(false);
  };

  it("refuses a held worktree", () => {
    const fx = done();
    sh(fx.main, "./scripts/azelf hold 40 --why 'by hand'");
    refused(fx, "#40: it is held");
  });

  it("refuses with a git operation in progress", () => {
    const fx = done();
    const dir = git(fx.wt(40), "rev-parse", "--git-path", "rebase-merge");
    mkdirSync(isAbsolute(dir) ? dir : join(fx.wt(40), dir), {
      recursive: true,
    });
    refused(fx, "is in progress in its worktree");
  });

  it("refuses a live session", () => {
    const fx = done();
    const session = fakeSession(fx, 40);
    sessions.push(session);
    refused(fx, `a session is running in it (pid ${session.pid})`);
  });

  it("refuses a slice whose land only has to finish", () => {
    const fx = done();
    writeFileSync(join(fx.main, ".git", "azelf-landed-40.txt"), "x\n");
    refused(fx, "it is pushed already");
  });
});

describe("azelf retry", () => {
  it("refuses a ticket with no worktree", () => {
    c = makeConsumer({});
    const r = azelfRetry(c, "99");
    expect(r.out).toContain("#99: no worktree at");
    expect(r.code).toBe(1);
  });

  it("names the running dispatcher that has the ticket, or says none does", () => {
    c = makeConsumer({ worktrees: [40] });
    expect(azelfRetry(c, "40").out).toContain(
      "no running dispatcher has #40 — azelf run --auto 40 starts one",
    );

    holdClaim(c, "40", process.pid, "azelf run -y --auto 40");
    const r = azelfRetry(c, "40");
    expect(r.out).toContain(
      `the running dispatcher (pid ${process.pid}) retries #40 next round`,
    );
    expect(r.code).toBe(0);
    expect(existsSync(join(c.wt(40), ".slice-retry"))).toBe(true);
  });
});

/**
 * A claim on `id` as another dispatcher leaves one: the lock directory with
 * its owner file, for `pid` as it is running now.
 */
function holdClaim(fx: Consumer, id: string, pid: number, label: string) {
  const dir = join(fx.main, ".git", `azelf-run-${id}.lock`);
  mkdirSync(dir);
  const started = spawnSync("ps", ["-o", "lstart=", "-p", String(pid)], {
    encoding: "utf8",
  }).stdout.trim();
  writeFileSync(
    join(dir, "owner"),
    `pid=${pid}\nstarted=${started}\nlabel=${label}\nsince=${new Date().toISOString()}\n`,
  );
  return dir;
}

const claimOf = (fx: Consumer, id: string) =>
  join(fx.main, ".git", `azelf-run-${id}.lock`);

/**
 * One dispatcher per ticket: a second run over a ticket another running
 * dispatcher holds refuses before `proceed?`, and names that run.
 */
describe("one dispatcher per ticket", () => {
  /** ticket/40, marked done, ready to land. */
  const doneSlice = () => {
    const fx = makeConsumer({ worktrees: [40], remote: true, agent: ["true"] });
    commitIn(fx.wt(40), "a.txt", "a\n", "feat: a");
    sh(fx.wt(40), "./scripts/slice-done.sh");
    return fx;
  };

  it("refuses a run over a held ticket, names the holder and the rest, and preps nothing", () => {
    c = makeConsumer({ agent: ["true"] });
    holdClaim(c, "41", process.pid, "azelf run -y --auto 41 42");

    const r = runDispatcher(c, ["--auto", "--once", "-y", "40", "41"]);

    expect(r.code).toBe(1);
    expect(r.out).toMatch(
      new RegExp(
        `✗ #41 is already being dispatched by another run \\(pid ${process.pid}, since \\d\\d:\\d\\d\\): azelf run -y --auto 41 42`,
      ),
    );
    expect(r.out).toContain(
      "Two dispatchers on one ticket race each other's rebases, sessions and lands. Stop that one first, or run the rest on their own:\n\n    ./scripts/azelf run --auto -y 40\n",
    );
    expect(r.out).not.toContain("prepping");
    expect(existsSync(c.wt(40))).toBe(false);
    expect(existsSync(claimOf(c, "40"))).toBe(false);
    expect(readFileSync(join(claimOf(c, "41"), "owner"), "utf8")).toContain(
      `pid=${process.pid}\n`,
    );
  });

  it("gives no command when every ticket is held", () => {
    c = makeConsumer({ agent: ["true"] });
    holdClaim(c, "40", process.pid, "azelf run 40");

    const r = runDispatcher(c, ["--auto", "--once", "-y", "40"]);

    expect(r.code).toBe(1);
    expect(r.out).toContain("sessions and lands. Stop that one first.\n");
    expect(r.out).not.toContain("./scripts/azelf run");
  });

  it("runs beside a dispatcher holding other tickets, and lets its own go", () => {
    c = doneSlice();
    holdClaim(c, "41", process.pid, "azelf run 41");

    const r = runDispatcher(c, ["--auto", "--once", "-y", "--no-review", "40"]);

    expect(r.code).toBe(0);
    expect(git(c.main, "log", "-1", "--format=%s")).toBe("feat: a");
    expect(existsSync(claimOf(c, "40"))).toBe(false);
    expect(existsSync(claimOf(c, "41"))).toBe(true);
  });

  it("takes over a claim left by a dispatcher that is no longer running", () => {
    c = doneSlice();
    const dead = spawnSync("true").pid;
    holdClaim(c, "40", dead, "azelf run 40");

    const r = runDispatcher(c, ["--auto", "--once", "-y", "--no-review", "40"]);

    expect(r.out).toContain(
      `took over #40 from a dispatcher that is no longer running (pid ${dead})`,
    );
    expect(r.code).toBe(0);
    expect(git(c.main, "log", "-1", "--format=%s")).toBe("feat: a");
  });

  it("only reports the holder under --plan, and takes nothing", () => {
    c = makeConsumer({});
    holdClaim(c, "41", process.pid, "azelf run 41");

    const r = runDispatcher(c, ["--plan", "40", "41"]);

    expect(r.code).toBe(0);
    expect(r.out).toContain("⚠ #41 is already being dispatched by another run");
    expect(r.out).toContain(
      "A dispatch of this plan stops there until that run ends.",
    );
    expect(existsSync(claimOf(c, "40"))).toBe(false);
  });
});

/** `azelf <args…>` from the main checkout, as a person types it. */
const azelfCli = (fx: Consumer, ...args: string[]) => {
  const r = spawnSync("bun", [join(AZELF, "bin", "azelf.ts"), ...args], {
    cwd: fx.main,
    encoding: "utf8",
    env: { ...process.env, SLICE_REPO_ROOT: fx.main },
  });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
};

/**
 * A worktree in use by hand. On consumer-a a second session aborted a hand
 * re-port's rebase and removed its worktree, reading it as a leftover; the
 * hold is git's own worktree lock, which every part of azelf now respects.
 */
describe("a held worktree", () => {
  /** ticket/40 committed and marked done: what a land is waiting for. */
  const done = () => {
    const fx = makeConsumer({ worktrees: [40], remote: true });
    commitIn(fx.wt(40), "a.txt", "a\n", "feat: a");
    sh(fx.wt(40), "./scripts/slice-done.sh");
    return fx;
  };

  const SEEN =
    /#40 is held by the re-port session since \d\d:\d\d \(re-porting onto #39\) — not landing or relaunching it until azelf release 40/g;

  it("is not landed while held, says so once, and lands the round after its release", async () => {
    c = done();
    const held = azelfCli(
      c,
      "hold",
      "40",
      "--by",
      "the re-port session",
      "--why",
      "re-porting onto #39",
    );
    expect(held.code).toBe(0);
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
    expect(d.output()).toContain("1 open · 1 held — land one to advance");
    expect(d.output()).not.toContain("marked done");

    const released = azelfCli(c, "release", "40");
    expect(released.out).toContain(
      `the running dispatcher (pid ${d.pid}) takes it back next round`,
    );
    await d.until("plan complete");

    const out = d.output();
    expect(out.match(SEEN)).toHaveLength(1);
    expect(out).toContain("#40 is no longer held — back in the run.");
    expect(await d.exited).toBe(0);
    expect(git(c.main, "log", "-1", "--format=%s")).toBe("feat: a");
  }, 60_000);

  it("is taken and given back from the command line, and git will not remove it meanwhile", () => {
    c = makeConsumer({ worktrees: [40] });
    const wt = c.wt(40);

    const none = azelfCli(c, "hold", "99");
    expect(none.out).toContain("#99: no worktree at");
    expect(none.code).toBe(1);

    const held = azelfCli(c, "hold", "40", "--by", "the re-port session");
    expect(held.code).toBe(0);
    expect(held.out).toContain(
      "✓ held #40 for the re-port session — nothing lands, relaunches or removes it until azelf release 40",
    );
    expect(readFileSync(join(wt, ".slice-hold"), "utf8")).toContain(
      "azelf release 40",
    );
    // Ignored, so the slice is still clean.
    expect(git(wt, "status", "--porcelain")).toBe("");
    expect(git(c.main, "worktree", "list", "--porcelain")).toContain(
      "locked azelf hold: the re-port session since ",
    );

    const again = azelfCli(c, "hold", "40");
    expect(again.code).toBe(1);
    expect(again.out).toMatch(
      /#40 is already held by the re-port session since \d\d:\d\d — azelf release 40 first/,
    );
    expect(() =>
      git(c?.main as string, "worktree", "remove", "--force", wt),
    ).toThrow();

    const released = azelfCli(c, "release", "40");
    expect(released.code).toBe(0);
    expect(released.out).toContain("✓ released #40");
    expect(released.out).toContain(
      "no running dispatcher has #40 — azelf run --auto 40 picks it up",
    );
    expect(existsSync(join(wt, ".slice-hold"))).toBe(false);
    expect(azelfCli(c, "release", "40").out).toContain(
      "#40 is not held — nothing to release",
    );
  });

  it("says a session running in it carries on", async () => {
    c = makeConsumer({ worktrees: [40] });
    const s = fakeSession(c, 40);
    sessions.push(s);
    expect(azelfCli(c, "hold", "40").out).toContain(
      `a session is running in it (pid ${s.pid}): it carries on, and is neither landed nor relaunched while the hold stands`,
    );
  });

  it("counts a lock someone put on with git, which release leaves to git, and the run's end lists it", () => {
    c = done();
    git(c.main, "worktree", "lock", "--reason", "bisecting", c.wt(40));

    const r = runDispatcher(c, ["--auto", "--once", "-y", "--no-review", "40"]);

    expect(r.out).toContain(
      `#40 is locked in git (bisecting) — not landing or relaunching it until git worktree unlock ${c.wt(
        40,
      )}`,
    );
    expect(r.out).not.toContain("marked done");
    expect(r.out).toContain(
      `── held (1) ───────────────────────────────\n  #40  locked in git (bisecting)\n     release: git worktree unlock ${c.wt(
        40,
      )}`,
    );
    expect(git(c.main, "log", "-1", "--format=%s")).toBe("init");

    const released = azelfCli(c, "release", "40");
    expect(released.code).toBe(1);
    expect(released.out).toContain(
      `#40's worktree is locked in git (bisecting), not held by azelf hold — if whoever locked it is done: git worktree unlock ${c.wt(
        40,
      )}`,
    );
  });

  it("gets no session, though it can be provisioned", () => {
    c = makeConsumer({ worktrees: [40], agent: ["true"] });
    azelfCli(c, "hold", "40", "--by", "the re-port session");

    const r = shResult(c.main, "./scripts/slice-session.sh 40");
    expect(r.code).toBe(1);
    expect(r.out).toMatch(
      /error: #40 is held by the re-port session since \d\d:\d\d — azelf release 40 first\. A held worktree gets no session; azelf provision 40 provisions it without one\./,
    );
    expect(existsSync(join(c.wt(40), ".slice-live"))).toBe(false);

    const p = azelfCli(c, "provision", "40");
    expect(p.code).toBe(0);
    expect(p.out).toContain("✓ provisioned — nothing launched");
  });
});

/**
 * A slice only a person can get further hands itself over with
 * `slice-done.sh --hand-over`. On consumer-a two such slices sat idle in their
 * tabs instead. Had either tab been closed on a clean tree with commits, the
 * slice would have read as finished under --auto and landed half a ticket.
 */
describe("a slice that handed itself over", () => {
  const WRITE_PROMPT = 'printf "%s\\n" "$1" > "$(dirname "$PWD")/prompt"';
  const AUTO = ["--auto", "--once", "-y", "--no-review", "40"];
  const SAID =
    /#40 is held by its session since \d\d:\d\d \(sign in to the database\) — not landing or relaunching it until azelf release 40, then tell its session to go on, or finish it by hand and run \.\/scripts\/slice-done\.sh in its worktree — a session that has ended is started again\n/;

  /** ticket/40, committed and clean, handed over by a session with this pid. */
  const handedOver = (pid: number) => {
    const fx = makeConsumer({
      worktrees: [40],
      remote: true,
      agent: ["bash", "-c", WRITE_PROMPT, "agent"],
      launch: true,
    });
    commitIn(fx.wt(40), "a.txt", "a\n", "feat: a");
    writeFileSync(join(fx.wt(40), ".slice-live"), `${pid}\n`);
    sh(
      fx.wt(40),
      './scripts/slice-done.sh --hand-over "sign in to the database"',
    );
    return fx;
  };

  /** What the relaunched session's agent was told, once it is over. */
  const relaunchPrompt = async (fx: Consumer) => {
    const prompt = join(fx.root, "prompt");
    const end = Date.now() + 30_000;
    while (!existsSync(prompt) || existsSync(join(fx.wt(40), ".slice-live"))) {
      if (Date.now() > end) throw new Error("no relaunched session");
      await new Promise((r) => setTimeout(r, 100));
    }
    return readFileSync(prompt, "utf8");
  };

  it("is neither landed nor relaunched while held, and is relaunched, not landed, after its release", async () => {
    c = handedOver(4242);
    // The session ended the way one does: its EXIT trap cleared the marker.
    rmSync(join(c.wt(40), ".slice-live"));

    const held = runDispatcher(c, AUTO);
    expect(held.out).toMatch(SAID);
    expect(held.out).not.toContain("marked done");
    expect(held.out).not.toContain("started #40");
    expect(git(c.main, "log", "-1", "--format=%s")).toBe("init");

    expect(azelfCli(c, "release", "40").code).toBe(0);
    const after = runDispatcher(c, AUTO);
    expect(after.out).toContain("started #40");
    expect(after.out).not.toContain("marked done");
    expect(git(c.main, "log", "-1", "--format=%s")).toBe("init");
    expect(await relaunchPrompt(c)).toContain("Continue from it");
  });

  it("says a session gone from under the hold is relaunched after the release, not now", () => {
    const pid = Number(
      spawnSync("bash", ["-c", "echo $$"], { encoding: "utf8" }).stdout.trim(),
    );
    c = handedOver(pid);

    const r = runDispatcher(c, AUTO);

    expect(r.out).toMatch(SAID);
    expect(r.out).toContain(
      `#40: its session (pid ${pid}) ended without clearing .slice-live — a crash, a restart, or a killed tab. Relaunching it after azelf release 40.`,
    );
    expect(r.out).not.toContain("started #40");
    expect(existsSync(join(c.wt(40), ".slice-interrupted"))).toBe(true);
  });
});

/**
 * A worktree re-added by hand with `git worktree add` has the branch and
 * nothing else: none of the provisionCopy files, no install, no brief.
 */
describe("azelf provision", () => {
  const readded = () => {
    const fx = makeConsumer({
      agent: ["true"],
      configExtra: 'provisionCopy: [".env", ".env.local"],',
    });
    writeFileSync(join(fx.main, ".env"), "MAIN_ENV\n");
    writeFileSync(join(fx.main, ".env.local"), "MAIN_LOCAL\n");
    writeFileSync(
      join(fx.main, ".git", "info", "exclude"),
      `${readFileSync(
        join(fx.main, ".git", "info", "exclude"),
        "utf8",
      )}\n.env\n.env.local\n`,
    );
    fx.setTicket("40", { title: "The re-port", body: "Port it." });
    git(fx.main, "branch", "ticket/40");
    git(fx.main, "worktree", "add", "-q", fx.wt(40), "ticket/40");
    return fx;
  };

  it("copies what is missing, leaves what is there, writes the brief, and launches nothing", () => {
    c = readded();
    writeFileSync(join(c.wt(40), ".env.local"), "EDITED\n");

    const r = azelfCli(c, "provision", "40");

    expect(r.code).toBe(0);
    expect(r.out).toContain("✓ copied .env");
    expect(r.out).toContain(".env.local is already there — left as it is");
    expect(readFileSync(join(c.wt(40), ".env"), "utf8")).toBe("MAIN_ENV\n");
    expect(readFileSync(join(c.wt(40), ".env.local"), "utf8")).toBe("EDITED\n");
    expect(readFileSync(join(c.wt(40), ".slice-ticket.md"), "utf8")).toContain(
      "Port it.",
    );
    expect(existsSync(join(c.wt(40), ".slice-flags"))).toBe(false);
    expect(existsSync(join(c.wt(40), ".slice-live"))).toBe(false);
    expect(r.out).not.toContain("checking ticket");
  });

  it("re-adds the worktree from its branch when git no longer lists it", () => {
    c = readded();
    git(c.main, "worktree", "remove", "--force", c.wt(40));

    const r = azelfCli(c, "provision", "40");

    expect(r.code).toBe(0);
    expect(r.out).toContain("on existing local branch ticket/40");
    expect(readFileSync(join(c.wt(40), ".env"), "utf8")).toBe("MAIN_ENV\n");
  });

  /**
   * azelf's own files, by azelf's own list. consumer-b keeps the shims
   * untracked and named each in provisionCopy; that copy of the list was two
   * shims behind on 2026-10-30, and ten sessions in one day had no
   * ./scripts/slice-gates.sh. The prep and `provision` copy what init wrote
   * and the worktree lacks, whether or not provisionCopy names it; a tracked
   * one came with the checkout.
   */
  const untrackedOwnFiles = (fx: Consumer) => {
    // format.sh is in SHIMS and not among the fixture's tracked shims; the
    // command file likewise. Both untracked, both excluded, as on consumer-b.
    writeFileSync(
      join(fx.main, "scripts", "format.sh"),
      "#!/usr/bin/env bash\necho fmt\n",
      { mode: 0o755 },
    );
    mkdirSync(join(fx.main, ".claude", "commands"), { recursive: true });
    writeFileSync(
      join(fx.main, ".claude", "commands", "azelf.md"),
      "# /azelf\n",
    );
    appendFileSync(
      join(fx.main, ".git", "info", "exclude"),
      "scripts/format.sh\n.claude/\n",
    );
  };

  it("copies the shims and agent files the main checkout has untracked, by its own list", () => {
    c = readded();
    untrackedOwnFiles(c);

    const r = azelfCli(c, "provision", "40");

    expect(r.code).toBe(0);
    expect(r.out).toContain(
      "✓ copied scripts/format.sh — azelf's own, untracked here",
    );
    expect(r.out).toContain(
      "✓ copied .claude/commands/azelf.md — azelf's own, untracked here",
    );
    // Tracked shims came with the checkout: nothing to copy, nothing said.
    expect(r.out).not.toContain("copied scripts/slice-done.sh");
    expect(
      statSync(join(c.wt(40), "scripts", "format.sh")).mode & 0o111,
    ).not.toBe(0);
    expect(
      readFileSync(join(c.wt(40), ".claude", "commands", "azelf.md"), "utf8"),
    ).toBe("# /azelf\n");
  });

  it("the prep copies them too, before the session is opened", () => {
    // A prep fetches origin, which `readded()` has no need of.
    c = makeConsumer({ agent: ["true"], remote: true });
    untrackedOwnFiles(c);
    c.setTicket("41", {});

    const r = runDispatcher(c, ["-y", "--once", "41"]);

    expect(r.out).toContain(`✓ prepped — worktree ready at ${c.wt(41)}`);
    expect(r.out).toContain(
      "✓ copied scripts/format.sh — azelf's own, untracked here",
    );
    expect(existsSync(join(c.wt(41), "scripts", "format.sh"))).toBe(true);
    expect(existsSync(join(c.wt(41), "scripts", "slice-done.sh"))).toBe(true);
  });

  it("refuses with neither a worktree nor a branch, and while a session runs there", () => {
    c = readded();
    const none = azelfCli(c, "provision", "41");
    expect(none.code).toBe(1);
    expect(none.out).toContain(
      "#41 has neither a worktree nor a branch 'ticket/41' — nothing to provision. azelf run 41 starts it.",
    );

    const s = fakeSession(c, 40);
    sessions.push(s);
    const busy = azelfCli(c, "provision", "40");
    expect(busy.code).toBe(1);
    expect(busy.out).toContain(
      `a session is running in ${c.wt(40)} (pid ${
        s.pid
      }) — its files would change under it. End it first.`,
    );
    expect(existsSync(join(c.wt(40), ".env"))).toBe(false);
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

/**
 * A parent is a heading over work, not work. Its children leave the ready set
 * as they land, so they are counted wherever they are; naming the parent still
 * runs it, and the plan says that it did.
 */
describe("a parent is not a slice", () => {
  const PARENT = "## Parent\n\n#45 — the spec\n";

  const spec = (childState: "open" | "closed"): Consumer => {
    const fx = makeConsumer({});
    fx.setTicket("45", { title: "Spec: the feature" });
    fx.setTicket("47", { body: PARENT, state: "closed" });
    fx.setTicket("48", { body: PARENT, state: childState });
    return fx;
  };

  it("a bare plan leaves out a parent whose children are all closed, and says what to do", () => {
    c = spec("closed");
    const r = runDispatcher(c, ["--plan"]);

    expect(r.code).toBe(0);
    expect(r.out).toContain(
      "⚠ #45 excluded — its 2 children are all closed. Close it, or remove ready.",
    );
    expect(r.out).toContain("Run it anyway with: azelf run 45");
    expect(r.out).not.toContain("wave 1");
  });

  it("a bare plan counts the closed children of a parent that still has an open one", () => {
    c = spec("open");
    const r = runDispatcher(c, ["--plan"]);

    expect(r.out).toContain(
      "⚠ #45 excluded — named as Parent by #47 #48 (1 open)",
    );
    expect(r.out).toContain("#48  t");
    expect(r.out).not.toContain("#45  Spec");
  });

  it("a parent the tracker knows natively is left out too, with its children outside the set", () => {
    c = makeConsumer({});
    c.setTicket("45", { children: ["47", "48"] });
    c.setTicket("47", { state: "closed" });
    c.setTicket("48", { state: "closed" });
    const r = runDispatcher(c, ["--plan"]);

    expect(r.out).toContain("⚠ #45 excluded — its 2 children are all closed.");
  });

  it("a named parent is planned, and the plan says it is one", () => {
    c = spec("closed");
    const r = runDispatcher(c, ["--plan", "45"]);

    expect(r.code).toBe(0);
    expect(r.out).toContain("#45  Spec: the feature");
    expect(r.out).toContain(
      "⚠ #45 is a parent (#47 #48, all closed) — running it as a slice because you named it",
    );
    expect(r.out).not.toContain("excluded");
  });

  it("a named ticket without the ready label is planned, and the plan says so", () => {
    c = makeConsumer({});
    c.setTicket("2", { ready: false });
    c.setTicket("4", { ready: false });
    const r = runDispatcher(c, ["--plan", "2", "3", "4"]);

    expect(r.out).toContain(
      "⚠ not labelled ready: #2 #4 — running them because you named them",
    );
    expect(runDispatcher(c, ["--plan", "3"]).out).not.toContain("not labelled");
  });
});

/**
 * A `humanLabel` ticket is a gate, not a slice: never dispatched, even when
 * named, and its dependents wait for it. A run with nothing else to do stops
 * and says which tickets to close.
 */
describe("a ticket for a person (humanLabel)", () => {
  const HUMAN = 'humanLabel: "human",';

  it("is held in the plan, and the plan says what waits on it", () => {
    c = makeConsumer({ configExtra: HUMAN });
    c.setTicket("2", { ready: false, labels: ["human"] });
    c.setTicket("3", { blockedBy: ["2"] });
    const r = runDispatcher(c, ["--plan", "2", "3"]);

    expect(r.code).toBe(0);
    expect(r.out).toContain("wave 1  1 ticket, 1 waiting on a human");
    expect(r.out).toContain("#2  t  [waiting on a human]");
    expect(r.out).toContain(
      "⚠ #2 is labelled human — not starting it; #3 waits until it is closed",
    );
    expect(r.out).not.toContain("not labelled ready");
    expect(r.out).toContain("widest wave: 1");
  });

  it("is never prepped, and a run with only it left stops with the resume line", () => {
    c = makeConsumer({ remote: true, agent: ["true"], configExtra: HUMAN });
    c.setTicket("2", { labels: ["human"] });
    c.setTicket("3", { blockedBy: ["2"] });
    const r = runDispatcher(c, ["-y", "--interval", "1", "2", "3"]);

    expect(r.code).toBe(1);
    expect(r.out).not.toContain("prepping #2");
    expect(r.out).toContain(
      "[round 1] 0 running · 0 blocked · 2 waiting on a human · 2 open — land one to advance",
    );
    expect(r.out).toContain(
      "nothing can advance — what is left waits on a human:\n    #2  human — blocks #3\n  Close it when done, then pick the run up again:\n\n    ./scripts/azelf run -y --interval 1 2 3\n",
    );
  });

  it("stops the same way when the person's ticket is outside the set", () => {
    c = makeConsumer({ remote: true, agent: ["true"], configExtra: HUMAN });
    c.setTicket("2", { ready: false, labels: ["human"] });
    c.setTicket("3", { blockedBy: ["2"] });
    const r = runDispatcher(c, ["-y", "--interval", "1"]);

    expect(r.code).toBe(1);
    expect(r.out).toContain(
      "#3  t  ← blocked by #2 (outside this set, waiting on a human)",
    );
    expect(r.out).toContain(
      "    #2  human, outside this set — blocks #3\n  Close it when done, then pick the run up again:\n\n    ./scripts/azelf run -y --interval 1 3\n",
    );
  });

  it("starts a ticket the round after its outside blocker is closed", async () => {
    c = makeConsumer({ remote: true, agent: ["true"] });
    c.setTicket("3", { blockedBy: ["5"] });
    c.setTicket("5", { ready: false });
    d = startDispatcher(c, ["-y", "--interval", "1", "3"]);
    await d.until("[round 2]");
    expect(d.output()).not.toContain("prepping #3");

    c.setTicket("5", { state: "closed" });
    await d.until("prepping #3");
    await d.until("✓ prepped");
  }, 60_000);

  it("stops the same way when the person's ticket is in another repo", () => {
    c = makeConsumer({ remote: true, agent: ["true"], configExtra: HUMAN });
    c.setTicket("acme/web#2", { ready: false, labels: ["human"] });
    c.setTicket("3", { blockedBy: ["acme/web#2"] });
    const r = runDispatcher(c, ["-y", "--interval", "1", "3"]);

    expect(r.code).toBe(1);
    expect(r.out).toContain(
      "    acme/web#2  human, in another repo — blocks #3\n",
    );
  });

  it("refuses a humanLabel that is the readyLabel", () => {
    c = makeConsumer({ configExtra: 'humanLabel: "ready",' });
    c.setTicket("2", {});
    expect(runDispatcher(c, ["--plan"]).out).toContain(
      "humanLabel is the same as readyLabel",
    );
  });
});

/**
 * A blocker in another repo comes back from the tracker as `acme/web#7`, an id
 * outside `idPattern`. It is never run here, only waited for, and a ticket in
 * the set with the same number is another ticket.
 */
describe("a blocker in another repo", () => {
  it("is shown under its own id, as in another repo, and holds only its ticket", () => {
    c = makeConsumer({ remote: true, agent: ["true"] });
    c.setTicket("3", { blockedBy: ["acme/web#7"] });
    c.setTicket("7", {});
    c.setTicket("acme/web#7", { ready: false });
    const r = runDispatcher(c, ["--plan", "3", "7"]);

    expect(r.code).toBe(0);
    expect(r.out).toContain("wave 1  2 tickets");
    expect(r.out).toContain(
      "#3  t  ← blocked by acme/web#7 (in another repo)\n",
    );
    expect(r.out).not.toContain("← blocked by #7");
  });

  it("is waited for, and the ticket starts the round after it closes", async () => {
    c = makeConsumer({ remote: true, agent: ["true"] });
    c.setTicket("3", { blockedBy: ["acme/web#7"] });
    // This repo's #7 is closed. It is not the blocker, and releases nothing.
    c.setTicket("7", { ready: false, state: "closed" });
    c.setTicket("acme/web#7", { ready: false });
    d = startDispatcher(c, ["-y", "--interval", "1", "3"]);
    await d.until(
      "[round 1] 0 running · 1 blocked · 1 open — waiting on another repo: acme/web#7\n",
    );
    expect(d.output()).not.toContain("prepping #3");

    c.setTicket("acme/web#7", { ready: false, state: "closed" });
    await d.until("prepping #3");
    await d.until("✓ prepped");
  }, 60_000);
});

/**
 * A slice is cut from what will land: local main when it is ahead of origin,
 * because a land rebases onto local main and pushes it. The plan says so
 * before anything is cut, and a main that has diverged stops the dispatch.
 */
describe("the base branch ahead of origin", () => {
  it("is where a new slice is cut from, and the plan names the commits", () => {
    c = makeConsumer({ remote: true, agent: ["true"] });
    c.setTicket("40", {});
    commitIn(c.main, "local.txt", "x\n", "feat: only on local main");
    const sha = git(c.main, "rev-parse", "--short", "HEAD");
    const r = runDispatcher(c, ["--once", "-y", "40"]);

    expect(r.out).toContain(
      `ℹ main is 1 commit ahead of origin/main. Slices are cut from it, and the first land pushes it:\n      ${sha} feat: only on local main\n`,
    );
    expect(r.out).toContain(
      "on new branch ticket/40, from local main (1 commit(s) ahead of origin — the first land pushes them)",
    );
    expect(git(c.wt(40), "log", "--format=%s")).toContain(
      "feat: only on local main",
    );
  });

  it("stops a dispatch when main and origin have diverged, and the prep refuses too", () => {
    c = makeConsumer({ remote: true, agent: ["true"] });
    c.setTicket("40", {});
    const other = join(c.root, "other");
    git(c.root, "clone", "-q", join(c.root, "remote"), other);
    commitIn(other, "theirs.txt", "x\n", "feat: theirs");
    git(other, "push", "-q", "origin", "main");
    commitIn(c.main, "ours.txt", "x\n", "feat: ours");

    const LINE =
      "✗ main and origin/main have diverged (1 and 1 commits), so no land could push. Pull or rebase main first.";
    const plan = runDispatcher(c, ["--plan", "40"]);
    expect(plan.code).toBe(0);
    expect(plan.out).toContain(LINE);

    const r = runDispatcher(c, ["-y", "40"]);
    expect(r.code).toBe(1);
    expect(r.out).toContain(LINE);
    expect(r.out).toContain(
      "not dispatching: main and origin/main have diverged.",
    );
    expect(r.out).not.toContain("prepping #40");
    expect(existsSync(c.wt(40))).toBe(false);

    const prep = shResult(c.main, "./scripts/slice-session.sh 40 --prep-only");
    expect(prep.ok).toBe(false);
    expect(prep.out).toContain(
      "error: main and origin/main have diverged (1 and 1 commits), so no land could push.",
    );
    expect(existsSync(c.wt(40))).toBe(false);
  });

  it("says nothing when main is level with origin", () => {
    c = makeConsumer({ remote: true, agent: ["true"] });
    c.setTicket("40", {});
    const r = runDispatcher(c, ["--once", "-y", "40"]);

    expect(r.out).toContain("prepping #40");
    expect(r.out).not.toContain("ahead of origin");
    expect(r.out).not.toContain("diverged");
    expect(r.out).toContain("on new branch ticket/40\n");
  });
});

/**
 * A gate with `when` runs only for a slice that touches one of its paths. The
 * gate here always fails, so a land proves it was skipped and a park that it
 * ran.
 */
describe("a gate scoped by path", () => {
  const scoped = (file: string, review?: string[]): Consumer => {
    const fx = makeConsumer({
      worktrees: [40],
      remote: true,
      agent: ["true"],
      gate: ["false"],
      gateWhen: ["ios/**"],
      review,
    });
    mkdirSync(join(fx.wt(40), "ios", "App"), { recursive: true });
    commitIn(fx.wt(40), file, "x\n", "feat: x");
    sh(fx.wt(40), "./scripts/slice-done.sh");
    return fx;
  };

  it("runs for a slice that touches its paths, and a red one parks it", () => {
    c = scoped("ios/App/x.swift");
    const r = runDispatcher(c, ["--auto", "--once", "-y", "--no-review", "40"]);

    expect(r.out).toContain("running 1 gate(s) for #40");
    expect(r.out).not.toContain("skipped `false`");
    expect(r.out).toContain("the gates are red");
    expect(r.out).not.toContain("landing #40");
  });

  it("is skipped, and said to be, for a slice that touches none of them", () => {
    c = scoped("a.txt");
    const r = runDispatcher(c, ["--auto", "--once", "-y", "--no-review", "40"]);

    expect(r.out).toContain(
      "  skipped `false` — #40 touches none of ios/**\n  running 0 gate(s) for #40",
    );
    expect(r.out).toContain("landing #40");
    expect(git(c.main, "log", "--format=%s", "-1")).toBe("feat: x");
  });

  it("azelf run --gates prints the same line", () => {
    c = scoped("a.txt");
    const r = runDispatcher(c, ["--gates", "40"]);

    expect(r.code).toBe(0);
    expect(r.out).toContain("skipped `false` — #40 touches none of ios/**");
    expect(r.out).toContain("✓ #40 passes every gate");
  });

  it("prints what a gate says while it runs, under the gate count", () => {
    c = scoped("a.txt");
    const config = join(c.main, "slice.config.ts");
    writeFileSync(
      config,
      readFileSync(config, "utf8").replace(
        /gates: \[.*\],/,
        `gates: [{ name: "slow", run: (ctx) => { ctx.log?.("still waiting"); return { ok: true }; } }],`,
      ),
    );
    const r = runDispatcher(c, ["--gates", "40"]);

    expect(r.code).toBe(0);
    expect(r.out).toContain(
      "  running 1 gate(s) for #40 (1 files) …\n    still waiting\n",
    );
  });

  it("tells the reviews it was skipped, not that it passed", () => {
    c = scoped("a.txt", [
      "bash",
      "-c",
      `${RECORD_PROMPT}; echo "VERDICT: PASS"`,
      "reviewer",
    ]);
    const r = runDispatcher(c, ["--review", "-y", "--interval", "1", "40"]);
    expect(r.out).toContain("landing #40");

    const prompts = readFileSync(join(c.root, "prompts"), "utf8").split(
      "\n=====\n",
    );
    const said =
      "No gate ran on this diff. Not run, because the diff touches none of the paths they judge: `false` (ios/**). Do not run tests";
    expect(prompts.find((p) => p.includes("faithfully implement"))).toContain(
      said,
    );
    expect(prompts.find((p) => p.includes("coding standards"))).toContain(said);
    expect(prompts.join("")).not.toContain("The gates (`false`) ran");
  });

  it("the config refuses an empty when, and a bare string", () => {
    for (const gateWhen of [[], "ios/**"]) {
      c = makeConsumer({ gate: ["true"], gateWhen });
      const r = runDispatcher(c, ["--plan"]);

      expect(r.code).not.toBe(0);
      expect(r.out).toContain(
        'gates[0] (`true`): when must be a non-empty array of path patterns, like ["ios/**"]',
      );
      rmSync(c.root, { recursive: true, force: true });
    }
  });
});

describe("a named ticket without the ready label", () => {
  it("is prepped, not refused for the label", () => {
    c = makeConsumer({ remote: true, agent: ["true"] });
    c.setTicket("2", { ready: false });
    const r = runDispatcher(c, ["--once", "-y", "2"]);

    expect(r.out).toContain("prepping #2");
    expect(r.out).toContain("✓ prepped");
    expect(r.out).not.toContain("missing the 'ready' label");
  });
});

/**
 * A body that names a blocker the tracker has no edge for. The plan is still
 * built from edges, but a dispatch does not start over the claim: someone
 * records the edge or says to run anyway.
 */
describe("a blocker only the body names stops the dispatch", () => {
  const claimed = (): Consumer => {
    const fx = makeConsumer({ remote: true, agent: ["true"] });
    fx.setTicket("81", {});
    fx.setTicket("82", { body: "## Blocked by\n\n#81\n" });
    return fx;
  };
  const LINE =
    "✗ #82's body says it is blocked by #81 (in this run, wave 1). Fake has no edge.";

  it("--plan prints where the blocker is and the two ways out, and exits 0", () => {
    c = claimed();
    const r = runDispatcher(c, ["--plan"]);

    expect(r.code).toBe(0);
    expect(r.out).toContain(LINE);
    expect(r.out).toContain("record the edges:  azelf run --sync-edges -y");
    expect(r.out).toContain(
      "or run as planned: azelf run --ignore-body-blockers",
    );
  });

  it("a dispatch exits 1 before anything is prepped, -y included", () => {
    c = claimed();
    const r = runDispatcher(c, ["-y", "--once", "81", "82"]);

    expect(r.code).toBe(1);
    expect(r.out).toContain(LINE);
    expect(r.out).toContain("not dispatching");
    expect(r.out).toContain("azelf run --sync-edges -y 81 82");
    expect(r.out).toContain("azelf run --ignore-body-blockers -y --once 81 82");
    expect(existsSync(c.wt(81))).toBe(false);
    expect(existsSync(c.wt(82))).toBe(false);
  });

  it("quotes the list item it read, and not the prose under the list", () => {
    c = claimed();
    c.setTicket("83", {});
    c.setTicket("82", {
      body: "## Blocked by\n\n- #81 — the storage policy\n\n#83 landed its half already.\n",
    });
    const r = runDispatcher(c, ["--plan"]);

    expect(r.out).toContain(
      `${LINE}\n      read from: "- #81 — the storage policy"`,
    );
    expect(r.out).not.toContain("blocked by #83");
  });

  it("names a blocker outside the run as open, not in this run", () => {
    c = claimed();
    const r = runDispatcher(c, ["--plan", "82"]);

    expect(r.out).toContain(
      "✗ #82's body says it is blocked by #81 (open, not in this run). Fake has no edge.",
    );
  });

  it("--ignore-body-blockers runs as planned, and the line is a note", () => {
    c = claimed();
    const r = runDispatcher(c, [
      "--ignore-body-blockers",
      "-y",
      "--once",
      "--no-start",
    ]);

    expect(r.out).toContain(
      "ℹ #82's body says it is blocked by #81 (in this run, wave 1). Fake has no edge.",
    );
    expect(r.out).not.toContain("not dispatching");
    expect(existsSync(c.wt(81))).toBe(true);
    expect(existsSync(c.wt(82))).toBe(true);
  }, 60_000);

  it("a closed blocker is not a claim: the run proceeds and says nothing", () => {
    c = claimed();
    c.setTicket("81", { state: "closed" });
    const r = runDispatcher(c, ["-y", "--once", "--no-start", "82"]);

    expect(r.out).not.toContain("body says");
    expect(r.out).not.toContain("not dispatching");
    expect(existsSync(c.wt(82))).toBe(true);
  }, 60_000);

  it("--sync-edges -y writes the edge, and the next plan schedules on it", () => {
    c = claimed();
    const sync = runDispatcher(c, ["--sync-edges", "-y"]);
    expect(sync.code).toBe(0);
    expect(sync.out).toContain("✓ #82 blocked by #81");

    const r = runDispatcher(c, ["--plan"]);
    expect(r.out).not.toContain("body says");
    expect(r.out).toContain("wave 2");
  });

  it("--sync-edges writes a blocker in another repo under its own id", () => {
    c = claimed();
    c.setTicket("82", { body: "## Blocked by\n\nacme/web#7\n" });
    c.setTicket("acme/web#7", { ready: false });
    const sync = runDispatcher(c, ["--sync-edges", "-y"]);

    expect(sync.code).toBe(0);
    expect(sync.out).toContain("    #82 blocked by acme/web#7\n");
    expect(sync.out).toContain("  ✓ #82 blocked by acme/web#7\n");
    expect(sync.out).not.toContain("#acme/web#7");
    const tickets = JSON.parse(readFileSync(c.ticketsFile, "utf8"));
    expect(tickets["82"].blockedBy).toEqual(["acme/web#7"]);
  });

  it("--sync-edges without -y and without a terminal says how to confirm", () => {
    c = claimed();
    const r = runDispatcher(c, ["--sync-edges"]);

    expect(r.out).toContain(
      "stopped. Nothing was written. Confirm without a prompt with: azelf run --sync-edges -y",
    );
  });
});

/**
 * Two slices cut from one base both take the next ADR number under different
 * names: no rebase stops, and the base would end with two of one number.
 * Here main's 0002-x.md stands for the slice that landed first; ticket/40
 * added 0002-b.md and a note that names it.
 */
describe("a file added under a number the base took meanwhile", () => {
  const ADR = "docs/adr";

  const taken = (opts: Parameters<typeof makeConsumer>[0] = {}) => {
    const fx = makeConsumer({ worktrees: [40], remote: true, ...opts });
    mkdirSync(join(fx.main, ADR), { recursive: true });
    commitIn(fx.main, `${ADR}/0001-a.md`, "# 1. a\n", "docs: adr 1");
    git(fx.wt(40), "rebase", "-q", "main");
    mkdirSync(join(fx.wt(40), ADR), { recursive: true });
    commitIn(fx.wt(40), `${ADR}/0002-b.md`, "# ADR 0002: b\n", "docs: adr b");
    commitIn(fx.wt(40), "NOTES.md", "see ADR 0002 (0002-b.md)\n", "docs: note");
    commitIn(fx.main, `${ADR}/0002-x.md`, "# 2. x\n", "docs: adr x");
    sh(fx.wt(40), "./scripts/slice-done.sh");
    return fx;
  };

  const auto = ["--auto", "--once", "-y", "--no-review", "40"];

  it("parks without a resolver, and names the file and the next free number", () => {
    c = taken();

    const r = runDispatcher(c, [...auto, "--no-auto-resolve"]);

    expect(r.out).toContain(
      `#40 did not land — ${ADR}/0002-b.md takes a number main already has for ${ADR}/0002-x.md — the next free one is ${ADR}/0003-b.md. Rename it in the worktree, fix what refers to it, and commit`,
    );
    expect(existsSync(join(c.main, ADR, "0002-b.md"))).toBe(false);
    expect(git(c.main, "log", "-1", "--format=%s")).toBe("docs: adr x");
  });

  it("renames the file, lets the agent fix the references, and lands", () => {
    c = taken({
      resolve: [
        "bash",
        "-c",
        `printf '%s\\n' "$1" > ../prompt; perl -pi -e 's/0002/0003/g' NOTES.md ${ADR}/0003-b.md`,
        "resolver",
      ],
    });

    const r = runDispatcher(c, auto);

    expect(r.out).toContain(`${ADR}/0002-b.md → ${ADR}/0003-b.md`);
    expect(r.out).toContain("✓ renamed and committed — the gates run next");
    expect(r.code).toBe(0);
    expect(readFileSync(join(c.main, ADR, "0003-b.md"), "utf8")).toBe(
      "# ADR 0003: b\n",
    );
    expect(readFileSync(join(c.main, ADR, "0002-x.md"), "utf8")).toBe(
      "# 2. x\n",
    );
    expect(existsSync(join(c.main, ADR, "0002-b.md"))).toBe(false);
    expect(readFileSync(join(c.main, "NOTES.md"), "utf8")).toBe(
      "see ADR 0003 (0003-b.md)\n",
    );
    expect(git(c.main, "log", "-1", "--format=%s")).toBe(
      `chore: renumber ${ADR}/0002-b.md → ${ADR}/0003-b.md — main took the number`,
    );
    const prompt = readFileSync(join(c.root, "prompt"), "utf8");
    expect(prompt).toContain(`main's ${ADR}/0002-x.md keeps the old number`);
    expect(prompt).toMatch(/ {3}NOTES\.md\n/);
  });

  it("throws the renumbering away when the agent edits a file the slice does not", () => {
    c = taken({
      resolve: ["bash", "-c", `echo oops >> ${ADR}/0001-a.md`, "resolver"],
    });

    const r = runDispatcher(c, auto);

    expect(r.out).toContain(
      `✗ renumbering rejected — it changed ${ADR}/0001-a.md, which this slice does not`,
    );
    expect(r.out).toContain("#40 did not land");
    // Rebased onto main, as a land does first, and nothing on top.
    expect(git(c.wt(40), "log", "-2", "--format=%s")).toBe(
      "docs: note\ndocs: adr b",
    );
    expect(git(c.wt(40), "status", "--porcelain")).toBe("");
    expect(existsSync(join(c.wt(40), ADR, "0002-b.md"))).toBe(true);
    expect(git(c.main, "log", "-1", "--format=%s")).toBe("docs: adr x");
  });

  it("lands as it is in a directory numberedIgnore names", () => {
    c = taken({ configExtra: `numberedIgnore: ["${ADR}/"],` });

    const r = runDispatcher(c, [...auto, "--no-auto-resolve"]);

    expect(r.code).toBe(0);
    expect(existsSync(join(c.main, ADR, "0002-b.md"))).toBe(true);
    expect(existsSync(join(c.main, ADR, "0002-x.md"))).toBe(true);
  });

  it("warns while both slices are open", () => {
    c = makeConsumer({ worktrees: [40, 41], remote: true });
    for (const [n, name] of [
      [40, "0002-b.md"],
      [41, "0002-c.md"],
    ] as const) {
      mkdirSync(join(c.wt(n), ADR), { recursive: true });
      commitIn(c.wt(n), `${ADR}/${name}`, "x\n", `docs: ${name}`);
    }

    const r = runDispatcher(c, ["--once", "-y", "--no-start", "40", "41"]);

    expect(r.out).toContain("⚠ slices are adding files under the same number");
    expect(r.out).toContain(`#40 #41  ${ADR}/0002-b.md  ${ADR}/0002-c.md`);
    expect(r.out).not.toContain("editing the same files");
  });

  it("the config refuses a numberedIgnore that is not a list of relative patterns", () => {
    for (const [value, says] of [
      ['"docs/adr/"', "numberedIgnore must be an array of path patterns"],
      [
        '["./docs/adr/"]',
        'numberedIgnore[0] ("./docs/adr/") must be repo-relative',
      ],
    ]) {
      c = makeConsumer({ configExtra: `numberedIgnore: ${value},` });
      const r = runDispatcher(c, ["--plan"]);

      expect(r.code).not.toBe(0);
      expect(r.out).toContain(says);
      rmSync(c.root, { recursive: true, force: true });
    }
  });
});

/**
 * The local base is origin's at the start of every round. Before this the
 * dispatcher fetched once, at the start, and said nothing when the base was
 * merely behind; every rebase, diff and overlap check then used a base origin
 * had left behind. On consumer-b that was a dispatcher clone nobody pulled by
 * hand, stale for a day of hand merges from another checkout.
 */
describe("the base branch behind origin", () => {
  /** A commit pushed to origin from another checkout. */
  const theirs = (fx: Consumer) => {
    const other = join(fx.root, "other");
    git(fx.root, "clone", "-q", join(fx.root, "remote"), other);
    commitIn(other, "theirs.txt", "x\n", "feat: theirs");
    git(other, "push", "-q", "origin", "main");
  };

  it("is fast-forwarded at the start, before the rebase, and the slice's files are only its own", () => {
    c = makeConsumer({
      worktrees: [40],
      remote: true,
      agent: ["true"],
      gate: ["true"],
    });
    theirs(c);
    commitIn(c.wt(40), "a.txt", "a\n", "feat: a");
    sh(c.wt(40), "./scripts/slice-done.sh");

    const r = runDispatcher(c, ["--auto", "--once", "-y", "--no-review", "40"]);

    expect(r.out).toMatch(
      /main was 1 commit behind origin\/main — fast-forwarded onto it \(now [0-9a-f]{7}\)/,
    );
    expect(r.out.indexOf("fast-forwarded onto it")).toBeLessThan(
      r.out.indexOf("#40 is behind main — rebasing before the gates"),
    );
    expect(r.out).toContain("running 1 gate(s) for #40 (1 files)");
    expect(r.code).toBe(0);
    expect(git(c.main, "log", "--format=%s")).toBe(
      "feat: a\nfeat: theirs\ninit",
    );
    expect(git(c.main, "rev-parse", "main")).toBe(
      git(c.main, "rev-parse", "origin/main"),
    );
  });

  it("is fast-forwarded at the start of a later round, before that round's land", async () => {
    c = makeConsumer({ worktrees: [40], remote: true, agent: ["true"] });
    sessions.push(fakeSession(c, 40));

    d = startDispatcher(c, ["-y", "--no-review", "--interval", "1", "40"]);
    await d.until("[round 1] 1 running");
    theirs(c);
    commitIn(c.wt(40), "a.txt", "a\n", "feat: a");
    sh(c.wt(40), "./scripts/slice-done.sh");
    await d.until("plan complete");

    expect(await d.exited).toBe(0);
    const out = d.output();
    expect(out).toMatch(
      /main was 1 commit behind origin\/main — fast-forwarded onto it/,
    );
    expect(out.indexOf("fast-forwarded onto it")).toBeLessThan(
      out.indexOf("#40 is behind main — rebasing before the gates"),
    );
    expect(git(c.main, "log", "--format=%s")).toBe(
      "feat: a\nfeat: theirs\ninit",
    );
  });

  it("parks a branch the base already contains as a land, not as red gates, and runs no gate", () => {
    c = makeConsumer({
      worktrees: [40],
      remote: true,
      agent: ["true"],
      gate: ["bash", "-c", "touch ../gate-ran"],
    });
    commitIn(c.wt(40), "a.txt", "a\n", "feat: a");
    sh(c.wt(40), "./scripts/slice-done.sh");
    // Moved past it by hand, and pushed.
    git(c.main, "merge", "-q", "--ff-only", "ticket/40");
    git(c.main, "push", "-q", "origin", "main");

    const r = runDispatcher(c, ["--auto", "--once", "-y", "--no-review", "40"]);

    expect(r.out).toContain(
      "ticket/40 adds nothing to main — every commit on it is already there. Did it land already, or was main moved past it by hand? If its work is on main, ./scripts/slice-land.sh 40 from the main checkout closes the ticket and removes the worktree",
    );
    expect(r.out).not.toContain("the gates are red");
    expect(r.out).not.toContain("nothing to land");
    expect(r.out).not.toContain("running 1 gate(s)");
    expect(existsSync(join(c.root, "gate-ran"))).toBe(false);
    expect(r.code).toBe(1);
  });
});

/**
 * `azelf gates`, and its shim `./scripts/slice-gates.sh`: the landing gates on
 * the worktree a session is in, before it declares itself done. No land, no
 * lock, and a gate that judges the pushed commit is skipped and said to be.
 */
describe("azelf gates — the gates from inside the worktree", () => {
  /** #40 with one change, a local gate, and a land-only gate that is always red. */
  const withGates = (local: string[]): Consumer => {
    const fx = makeConsumer({
      worktrees: [40],
      remote: true,
      agent: ["true"],
      gate: local,
    });
    const config = join(fx.main, "slice.config.ts");
    writeFileSync(
      config,
      readFileSync(config, "utf8").replace(
        /gates: \[(.*)\],/,
        `gates: [$1, { name: "CI: Tests", landOnly: true, run: () => ({ ok: false, why: "CI ran where nothing was pushed" }) }],`,
      ),
    );
    commitIn(fx.wt(40), "a.txt", "a\n", "feat: a");
    return fx;
  };

  it("runs the local gates on the worktree it is in, skips the land-only one, and exits 0", () => {
    c = withGates(["bash", "-c", "touch ../gate-ran"]);
    const r = shResult(c.wt(40), "./scripts/slice-gates.sh");

    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain(
      "  skipped `CI: Tests` — it judges the pushed commit, and runs at the land\n  running 1 gate(s) for #40 (1 files) …\n",
    );
    expect(r.out).toContain("✓ #40 passes every gate");
    expect(r.out).not.toContain("CI ran");
    expect(existsSync(join(c.root, "gate-ran"))).toBe(true);
    // Nothing landed, nothing closed.
    expect(git(c.main, "log", "--format=%s", "-1")).toBe("init");
    expect(existsSync(c.closeFile)).toBe(false);
  });

  it("exits 1 when a local gate is red, naming it", () => {
    c = withGates(["bash", "-c", "echo boom >&2; exit 1"]);
    const r = shResult(c.wt(40), "./scripts/slice-gates.sh");

    expect(r.code).toBe(1);
    expect(r.out).toContain(
      "✗ #40 not landed — `bash -c echo boom >&2; exit 1` failed",
    );
    expect(r.out).not.toContain("passes every gate");
  });

  it("does not wait for the gate lock another run holds", async () => {
    c = withGates(["true"]);
    const lock = join(c.main, ".git", "azelf-gates.lock");
    const go = join(c.root, "go");
    const other = startScript(
      c.main,
      `bun ${join(AZELF, "scripts", "slice-lock.ts")} acquire ${lock} --pid $$ --label '#31'
echo held
while [ ! -f ${go} ]; do sleep 0.1; done
bun ${join(AZELF, "scripts", "slice-lock.ts")} release ${lock} --pid $$`,
    );
    try {
      await other.until("held");
      const r = shResult(c.wt(40), "./scripts/slice-gates.sh");
      expect(r.code, r.out).toBe(0);
      expect(r.out).not.toContain("waiting for");
      expect(r.out).toContain("✓ #40 passes every gate");
      // The holder's lock is still its own.
      expect(existsSync(lock)).toBe(true);
    } finally {
      writeFileSync(go, "");
      await other.stop();
    }
  }, 60_000);

  it("needs a ticket from the main checkout, and says why", () => {
    c = withGates(["true"]);
    const r = shResult(c.main, "./scripts/slice-gates.sh");

    expect(r.code).toBe(64);
    expect(r.out).toContain(
      "--gates needs a ticket id, or a slice worktree to run from — `main` is not a slice branch (branchPattern is ticket/{n})",
    );
  });

  it("takes one ticket through the binary, and no flags", () => {
    c = withGates(["true"]);
    const azelf = (...args: string[]) =>
      spawnSync("bun", [join(AZELF, "bin", "azelf.ts"), "gates", ...args], {
        cwd: c?.main,
        encoding: "utf8",
      });

    const ok = azelf("40");
    expect(ok.status, ok.stdout + ok.stderr).toBe(0);
    expect(ok.stdout).toContain("✓ #40 passes every gate");

    const flag = azelf("40", "--no-review");
    expect(flag.status).toBe(2);
    expect(flag.stderr).toContain("azelf gates [<ticket>]");

    const missing = azelf("41");
    expect(missing.status).toBe(1);
    expect(missing.stdout).toContain("✗ #41: no worktree at");
  });
});

/**
 * Phase 3 of the stale-base plan: among the slices ready in one round, one
 * retried only because the base moved goes after the rest.
 */
describe("the land order after a park", () => {
  it("lands a branch that moved before a slice retried only because the base moved", async () => {
    // Both park on the same red gate. Then, in one round, #41 gets the fix
    // on its branch and the base moves for an unrelated reason: #40 is due
    // because the base moved, #41 because its branch did. Ticket order would
    // try #40 first, fail the same gate again and spend an automatic retry;
    // #41 goes first, and #40 passes once it is rebased onto #41's fix. #42
    // keeps running so the run does not stop with everything parked.
    c = makeConsumer({
      worktrees: [40, 41, 42],
      remote: true,
      gate: ["test", "-f", "fixed.txt"],
    });
    commitIn(c.wt(40), "a.txt", "a\n", "feat: a");
    sh(c.wt(40), "./scripts/slice-done.sh");
    commitIn(c.wt(41), "b.txt", "b\n", "feat: b");
    sh(c.wt(41), "./scripts/slice-done.sh");
    sessions.push(fakeSession(c, 42));
    d = startDispatcher(c, ["-y", "--interval", "1", "40", "41", "42"]);
    await d.until("✗ #40 did not land — the gates are red");
    await d.until("✗ #41 did not land — the gates are red");

    commitIn(c.wt(41), "fixed.txt", "fixed\n", "fix: fixed.txt");
    commitIn(c.main, "unrelated.txt", "x\n", "chore: unrelated");

    await d.until("#41 first — #40 is retried only because main moved");
    await d.until("✓ closed #41");
    await d.until("✓ closed #40", 40_000);

    const out = d.output();
    expect(out).toContain(
      "main moved since #40 was parked — retrying (automatic retry 1 of 2).",
    );
    expect(out).toContain(
      "#41 has moved since it was parked — retrying the land.",
    );
    expect(out.indexOf("landing #41 …")).toBeLessThan(
      out.indexOf("landing #40 …"),
    );
    // #40 was not tried first and parked again: one red park, no second retry.
    expect(out.split("✗ #40 did not land — the gates are red").length - 1).toBe(
      1,
    );
    expect(out).not.toContain("automatic retry 2 of 2");
    expect(git(c.main, "log", "--format=%s", "main")).toBe(
      "feat: a\nfix: fixed.txt\nfeat: b\nchore: unrelated\ninit",
    );
  }, 90_000);
});

/**
 * `azelf on-base`: one command at the slice's merge base, without its changes,
 * in a throwaway checkout installed like a prep, the result in
 * `.slice-baseline`. consumer-b's Backend #240 built that checkout by hand for
 * a suite baseline.
 */
describe("azelf on-base — a command on the slice's base", () => {
  /**
   * #40 adds mine.txt; the base has base.txt. The install touches
   * installed-here, and provisionCopy brings .env.local from the main checkout.
   */
  const slice = () => {
    const fx = makeConsumer({
      worktrees: [40],
      configExtra:
        'provisionCopy: [".env.local"],\n  install: ["bash", "-c", "touch installed-here"],',
    });
    c = fx;
    writeFileSync(join(fx.main, ".env.local"), "LOCAL\n");
    commitIn(fx.main, "base.txt", "base\n", "chore: base");
    git(fx.wt(40), "rebase", "-q", "main");
    commitIn(fx.wt(40), "mine.txt", "mine\n", "feat: mine");
    return fx;
  };
  const gone = (fx: Consumer) => {
    expect(existsSync(`${fx.wt(40)}-on-base`)).toBe(false);
    expect(git(fx.main, "worktree", "list")).not.toContain("on-base");
  };
  const baseline = (fx: Consumer) =>
    readFileSync(join(fx.wt(40), ".slice-baseline"), "utf8");
  const PROBE =
    "test ! -e mine.txt && test -f base.txt && test -f installed-here && test -f .env.local && git rev-parse HEAD > ../probe-at && echo BASE-OUTPUT";

  it("runs the command at the merge base, without the slice's change, and writes .slice-baseline", () => {
    const fx = slice();
    const at = git(fx.main, "rev-parse", "main");

    const r = shResult(
      fx.wt(40),
      `./scripts/slice-on-base.sh -- bash -c ${JSON.stringify(PROBE)}`,
    );

    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain(`  base ${at.slice(0, 12)}\n`);
    expect(r.out).toContain("BASE-OUTPUT");
    expect(readFileSync(join(fx.root, "probe-at"), "utf8").trim()).toBe(at);
    expect(r.out).toContain(`✓ on the base (${at.slice(0, 12)}): exit 0`);
    const b = baseline(fx);
    expect(b).toContain(`base: ${at}\n`);
    expect(b).toContain(`command: bash -c ${PROBE}\n`);
    expect(b).toContain("exit: 0\n");
    expect(b).toContain("BASE-OUTPUT");
    gone(fx);
    // Ignored, so the baseline does not make the slice dirty.
    expect(git(fx.wt(40), "status", "--porcelain")).toBe("");
  });

  it("exits with the command's code, and removes the checkout after a failure too", () => {
    const fx = slice();
    // A checkout a crashed run left behind is in the way.
    git(fx.main, "worktree", "add", "-q", "--detach", `${fx.wt(40)}-on-base`);

    const r = shResult(
      fx.wt(40),
      "./scripts/slice-on-base.sh -- bash -c 'echo RED; exit 3'",
    );

    expect(r.code, r.out).toBe(3);
    expect(r.out).toContain("✗ on the base");
    expect(baseline(fx)).toContain("exit: 3\n");
    expect(baseline(fx)).toContain("RED");
    gone(fx);
  });

  it("says how far the base branch has moved past the slice's base", () => {
    const fx = slice();
    commitIn(fx.main, "later.txt", "later\n", "chore: later");

    const r = shResult(fx.wt(40), "./scripts/slice-on-base.sh -- true");

    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain(
      "(main is 1 commit(s) ahead — rebase first for the land's baseline)",
    );
    expect(baseline(fx)).toContain("main was 1 commit(s) ahead of this base");
  });

  it("runs by ticket from the main checkout through azelf on-base, and passes the command's flags through", () => {
    const fx = slice();
    const r = shResult(
      fx.main,
      "./scripts/azelf on-base 40 -- bash -c 'test ! -e mine.txt' -x",
    );
    expect(r.code, r.out).toBe(0);
    expect(baseline(fx)).toContain("command: bash -c test ! -e mine.txt -x\n");
    gone(fx);
  });

  it("is a usage error without a command", () => {
    const fx = slice();
    expect(shResult(fx.main, "./scripts/azelf on-base 40").code).toBe(2);
    expect(shResult(fx.wt(40), "./scripts/slice-on-base.sh").code).toBe(64);
    gone(fx);
  });

  it("removes the checkout when it is stopped", async () => {
    const fx = slice();
    const p = spawn(
      join(fx.wt(40), "scripts", "slice-on-base.sh"),
      ["--", "sleep", "30"],
      {
        cwd: fx.wt(40),
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let out = "";
    p.stdout.on("data", (b) => {
      out += b;
    });
    const exited = new Promise<number | null>((r) => p.on("exit", r));
    while (!out.includes("running in")) {
      await new Promise((r) => setTimeout(r, 50));
    }
    p.kill("SIGTERM");

    expect(await exited).toBe(143);
    gone(fx);
    expect(baseline(fx)).toContain("exit: 143\n");
  }, 30_000);
});
