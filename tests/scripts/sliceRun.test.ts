import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
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
  shResult,
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
      "To pick the run up again:\n\n    bunx azelf run -y --interval 1 40\n",
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
    expect(d.output()).not.toContain("prepping #40");
  }, 60_000);
});

/**
 * The line is counted after the round's land and launches. A ticket that
 * just landed is not open, a slice that is done and waiting its turn is "to
 * land" and not "blocked", and a slice cut on top of a landed one is not
 * reported as editing the same files.
 */
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
 * The spec reviewer is text in, text out: it cannot fetch the parent spec, so
 * the dispatcher pastes it. The fake reviewer writes every prompt it is given
 * next to the worktree.
 */
describe("the spec review and the parent spec", () => {
  const RECORD = [
    "bash",
    "-c",
    'printf "%s\\n=====\\n" "$1" >> ../prompts; echo "VERDICT: PASS"',
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
    expect(specPrompt(fx)).not.toContain("PARENT SPEC");
    expect(r.out).toContain("landing #40");
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
    'printf "%s\\n=====\\n" "$1" >> ../prompts; echo "VERDICT: PASS"',
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
    'printf "%s\\n=====\\n" "$1" >> ../prompts; echo "VERDICT: PASS"',
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
      "nothing can advance — what is left waits on a human:\n    #2  human — blocks #3\n  Close it when done, then pick the run up again:\n\n    bunx azelf run -y --interval 1 2 3\n",
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
      "    #2  human, outside this set — blocks #3\n  Close it when done, then pick the run up again:\n\n    bunx azelf run -y --interval 1 3\n",
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

  it("refuses a humanLabel that is the readyLabel", () => {
    c = makeConsumer({ configExtra: 'humanLabel: "ready",' });
    c.setTicket("2", {});
    expect(runDispatcher(c, ["--plan"]).out).toContain(
      "humanLabel is the same as readyLabel",
    );
  });
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

  it("--sync-edges without -y and without a terminal says how to confirm", () => {
    c = claimed();
    const r = runDispatcher(c, ["--sync-edges"]);

    expect(r.out).toContain(
      "stopped. Nothing was written. Confirm without a prompt with: azelf run --sync-edges -y",
    );
  });
});
