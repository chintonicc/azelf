import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  AZELF,
  type Consumer,
  git,
  makeConsumer,
  sh,
  shResult,
} from "./fixture";

/**
 * The tab of a landed --auto slice closes because `slice-session.sh` exits 86,
 * and it only can once its agent has ended. A finished Claude session commonly
 * sits at its REPL, so `slice-land.sh --end-session` ends it — after removing
 * the worktree, which is what the session reads as "landed" (see "Closing the
 * tab" in slice-session.sh).
 *
 * The agent here is a `sleep` with a duration unique to the test, so `pgrep -f`
 * finds exactly this one. Under `manual()`, the fixture's launcher, flags ride
 * on the command line: no `.slice-flags`, no hook.
 */

type Session = {
  child: ChildProcess;
  output: () => string;
  exited: Promise<number | null>;
};

let fx: Consumer | undefined;
let sleepArg = "";

afterEach(() => {
  if (sleepArg) spawnSync("pkill", ["-f", `sleep ${sleepArg}`]);
  if (fx) rmSync(fx.root, { recursive: true, force: true });
  fx = undefined;
  sleepArg = "";
});

function setup(): Consumer {
  sleepArg = String(3000 + Math.floor(Math.random() * 5000));
  fx = makeConsumer({
    worktrees: [40],
    remote: true,
    // `exec` so the agent IS the sleep, and the prompt slice-session.sh
    // appends lands in $0, where nothing reads it.
    agent: ["bash", "-c", `exec sleep ${sleepArg}`],
  });
  return fx;
}

function startSession(c: Consumer, flags = ["--self-land"]): Session {
  let out = "";
  const child = spawn("./scripts/slice-session.sh", ["40", ...flags], {
    cwd: c.main,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.on("data", (d) => {
    out += d;
  });
  child.stderr?.on("data", (d) => {
    out += d;
  });
  const exited = new Promise<number | null>((res) =>
    child.on("close", (code, signal) => res(code ?? (signal ? -1 : null))),
  );
  return { child, output: () => out, exited };
}

async function until(what: string, ok: () => boolean, ms = 30_000) {
  const end = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

const agentRunning = () =>
  spawnSync("pgrep", ["-f", `sleep ${sleepArg}`]).status === 0;

/** Up to the point a real slice reaches: live, committed, declared done. */
async function sessionDeclaredDone(c: Consumer): Promise<Session> {
  const s = startSession(c);
  await until(
    `.slice-live — session output so far:\n${s.output()}`,
    () => existsSync(join(c.wt(40), ".slice-live")) && agentRunning(),
  );
  writeFileSync(join(c.wt(40), "feature.txt"), "done\n");
  git(c.wt(40), "add", "feature.txt");
  git(c.wt(40), "commit", "-qm", "feature");
  sh(c.wt(40), "./scripts/slice-done.sh");
  return s;
}

describe("a landed --auto slice's session ends, so its tab closes", () => {
  it("--end-session removes the worktree, then ends the agent; the session exits 86", async () => {
    const c = setup();
    const s = await sessionDeclaredDone(c);

    const land = shResult(c.main, "./scripts/slice-land.sh 40 --end-session");
    expect(land.ok, land.out).toBe(true);
    expect(land.out).toContain("✓ removed worktree");
    expect(land.out).toContain("ended the agent in that tab");
    expect(existsSync(c.wt(40))).toBe(false);
    expect(agentRunning()).toBe(false);

    expect(await s.exited).toBe(86);
    expect(s.output()).toContain("worktree was landed and removed");
  }, 60_000);

  it("without --end-session the agent is left alone — a manual land never ends a session", async () => {
    const c = setup();
    const s = await sessionDeclaredDone(c);

    const land = shResult(c.main, "./scripts/slice-land.sh 40");
    expect(land.ok, land.out).toBe(true);
    expect(land.out).toContain("Nothing is lost — close that tab.");
    expect(land.out).not.toContain("ended the agent");
    expect(existsSync(c.wt(40))).toBe(false);

    await new Promise((r) => setTimeout(r, 1000));
    expect(agentRunning()).toBe(true);
    expect(s.child.exitCode).toBeNull();

    spawnSync("pkill", ["-f", `sleep ${sleepArg}`]);
    await s.exited;
  }, 60_000);

  it("an agent that dies with its worktree still there keeps the tab — a crash is not a land", async () => {
    const c = setup();
    const s = startSession(c);
    await until(
      "the agent",
      () => existsSync(join(c.wt(40), ".slice-live")) && agentRunning(),
    );

    spawnSync("pkill", ["-TERM", "-f", `sleep ${sleepArg}`]);
    const code = await s.exited;
    expect(code).toBe(128 + 15);
    expect(s.output()).not.toContain("closing this tab");
    expect(existsSync(c.wt(40))).toBe(true);
  }, 60_000);

  it("an agent ended while it waits on the DB lock closes the tab — the dispatcher starts it again", async () => {
    const c = setup();
    const s = startSession(c);
    await until(
      "the agent",
      () => existsSync(join(c.wt(40), ".slice-live")) && agentRunning(),
    );
    // What a refused `db-lock.sh claim` leaves.
    writeFileSync(join(c.wt(40), ".slice-lock-wait"), "ticket/44\n");

    spawnSync("pkill", ["-TERM", "-f", `sleep ${sleepArg}`]);
    expect(await s.exited).toBe(86);
    expect(s.output()).toContain(
      "── waiting on the DB lock — closing this tab; the dispatcher starts it again when the lock is free ─",
    );
    expect(existsSync(join(c.wt(40), ".slice-live"))).toBe(false);
  }, 60_000);

  it("without --self-land a lock wait keeps the tab, and the agent's status", async () => {
    const c = setup();
    const s = startSession(c, []);
    await until(
      "the agent",
      () => existsSync(join(c.wt(40), ".slice-live")) && agentRunning(),
    );
    writeFileSync(join(c.wt(40), ".slice-lock-wait"), "ticket/44\n");

    spawnSync("pkill", ["-TERM", "-f", `sleep ${sleepArg}`]);
    expect(await s.exited).toBe(128 + 15);
    expect(s.output()).not.toContain("closing this tab");
  }, 60_000);

  it("a session that never declared done is not ended, even with the flag", async () => {
    const c = setup();
    const s = startSession(c);
    await until(
      "the agent",
      () => existsSync(join(c.wt(40), ".slice-live")) && agentRunning(),
    );
    writeFileSync(join(c.wt(40), "feature.txt"), "wip\n");
    git(c.wt(40), "add", "feature.txt");
    git(c.wt(40), "commit", "-qm", "wip");

    const land = shResult(c.main, "./scripts/slice-land.sh 40 --end-session");
    expect(land.ok, land.out).toBe(true);
    expect(land.out).toContain("It never ran slice-done.sh");
    expect(land.out).not.toContain("ended the agent");
    expect(agentRunning()).toBe(true);

    spawnSync("pkill", ["-f", `sleep ${sleepArg}`]);
    await s.exited;
  }, 60_000);

  it("done, a follow-up commit, done again: the pid is kept and --end-session still ends the agent", async () => {
    const c = setup();
    const s = await sessionDeclaredDone(c);
    const marker = join(c.wt(40), ".slice-ready-to-land");
    const pid = readFileSync(marker, "utf8").split("\n")[0];
    expect(pid).toMatch(/^[0-9]+$/);

    writeFileSync(join(c.wt(40), "feature.txt"), "follow-up\n");
    git(c.wt(40), "commit", "-qam", "follow-up");
    sh(c.wt(40), "./scripts/slice-done.sh");
    const [again, head] = readFileSync(marker, "utf8").split("\n");
    expect(again).toBe(pid);
    expect(head).toBe(git(c.wt(40), "rev-parse", "HEAD"));

    const land = shResult(c.main, "./scripts/slice-land.sh 40 --end-session");
    expect(land.ok, land.out).toBe(true);
    expect(land.out).toContain("ended the agent in that tab");
    expect(agentRunning()).toBe(false);
    expect(await s.exited).toBe(86);
  }, 60_000);

  it("slice-land.sh rejects an unknown flag and a second ticket", () => {
    const c = setup();
    for (const args of ["40 --end-sesion", "40 41"]) {
      const r = shResult(c.main, `./scripts/slice-land.sh ${args}`);
      expect(r.ok).toBe(false);
      expect(r.out).toContain("usage:");
    }
  });
});

/**
 * A marker belongs to the pid on its first line. On consumer-b's Frontend #136
 * an old tab's exit deleted the marker of the session that had replaced it, and
 * the dispatcher, seeing no session on an uncommitted tree, opened a third.
 */
describe("a tab removes only its own marker, and a session does not start over a live one", () => {
  it("an old session's exit leaves a newer marker", async () => {
    const c = setup();
    const s = startSession(c);
    const marker = join(c.wt(40), ".slice-live");
    await until("the agent", () => existsSync(marker) && agentRunning());

    writeFileSync(marker, "999999\n");
    spawnSync("pkill", ["-TERM", "-f", `sleep ${sleepArg}`]);
    await s.exited;

    expect(readFileSync(marker, "utf8")).toBe("999999\n");
  }, 60_000);

  it("a session's exit still removes its own", async () => {
    const c = setup();
    const s = startSession(c);
    const marker = join(c.wt(40), ".slice-live");
    await until("the agent", () => existsSync(marker) && agentRunning());

    spawnSync("pkill", ["-TERM", "-f", `sleep ${sleepArg}`]);
    await s.exited;

    expect(existsSync(marker)).toBe(false);
  }, 60_000);

  it("a second start refuses, before it touches the worktree", async () => {
    const c = setup();
    const s = startSession(c);
    const marker = join(c.wt(40), ".slice-live");
    await until("the agent", () => existsSync(marker) && agentRunning());
    const before = readFileSync(marker, "utf8");
    writeFileSync(join(c.wt(40), ".slice-interrupted"), "1\n");

    // With a timeout: if it did not refuse, it would wait on an agent of its own.
    const again = spawnSync(
      "./scripts/slice-session.sh",
      ["40", "--self-land"],
      { cwd: c.main, encoding: "utf8", timeout: 20_000 },
    );
    expect(again.status).toBe(1);
    expect(again.stderr).toContain(
      `a session is running in ${c.wt(40)} (pid ${before.trim()})`,
    );
    expect(readFileSync(marker, "utf8")).toBe(before);
    expect(existsSync(join(c.wt(40), ".slice-interrupted"))).toBe(true);

    spawnSync("pkill", ["-TERM", "-f", `sleep ${sleepArg}`]);
    await s.exited;
  }, 60_000);

  it("a marker whose pid is another ticket's session does not refuse: a pid is reused", async () => {
    const c = setup();
    const script = join(c.root, "slice-session.sh");
    writeFileSync(script, "while :; do sleep 0.2; done\n");
    const other = spawn("bash", [script, "41"], { stdio: "ignore" });
    try {
      const marker = join(c.wt(40), ".slice-live");
      writeFileSync(marker, `${other.pid}\n`);

      const s = startSession(c);
      await until(
        `the agent — session output so far:\n${s.output()}`,
        agentRunning,
      );
      expect(s.output()).not.toContain("a session is running");
      expect(readFileSync(marker, "utf8")).not.toBe(`${other.pid}\n`);

      spawnSync("pkill", ["-TERM", "-f", `sleep ${sleepArg}`]);
      await s.exited;
    } finally {
      other.kill("SIGKILL");
    }
  }, 60_000);
});

/**
 * consumer-b's Backend #227: a run passed the guard, the Mac slept before it
 * wrote `.slice-live`, and a second run found no marker. Both started an
 * agent. A run claims its slice first now, before its tracker calls, which are
 * the slow part: the fixture's tracker holds them here, as a sleep did.
 */
describe("a run claims its slice before anything slow", () => {
  const markerOf = (c: Consumer) => join(c.wt(40), ".slice-live");
  const read = (path: string) =>
    existsSync(path) ? readFileSync(path, "utf8") : "";

  it("a run held in its tracker calls has claimed already, and a second run is refused", async () => {
    const c = setup();
    c.trackerHeld(true);
    const s = startSession(c);
    const marker = markerOf(c);
    await until("the claim", () => read(marker) === `${s.child.pid}\n`);
    expect(s.output()).toContain("── checking ticket #40");
    expect(agentRunning()).toBe(false);

    // With a timeout: if it were not refused, it would wait on the tracker too.
    const again = spawnSync(
      "./scripts/slice-session.sh",
      ["40", "--self-land"],
      { cwd: c.main, encoding: "utf8", timeout: 20_000 },
    );
    expect(again.status, `${again.stdout}${again.stderr}`).toBe(1);
    expect(again.stderr).toContain(
      `a session is running in ${c.wt(40)} (pid ${s.child.pid})`,
    );
    expect(read(marker)).toBe(`${s.child.pid}\n`);

    c.trackerHeld(false);
    await until(
      `the agent — session output so far:\n${s.output()}`,
      agentRunning,
    );
    expect(read(marker)).toBe(`${s.child.pid}\n`);

    spawnSync("pkill", ["-TERM", "-f", `sleep ${sleepArg}`]);
    await s.exited;
    expect(existsSync(marker)).toBe(false);
  }, 60_000);

  it("a marker whose session is gone is taken over at the claim, and kept as .slice-interrupted", async () => {
    const c = setup();
    const marker = markerOf(c);
    writeFileSync(marker, "999999\n");
    c.trackerHeld(true);
    const s = startSession(c);
    await until("the claim", () => read(marker) === `${s.child.pid}\n`);
    expect(read(join(c.wt(40), ".slice-interrupted"))).toBe("999999\n");

    c.trackerHeld(false);
    await until(
      `the agent — session output so far:\n${s.output()}`,
      agentRunning,
    );
    // The session that picks the work up clears it, as it always has.
    expect(existsSync(join(c.wt(40), ".slice-interrupted"))).toBe(false);

    spawnSync("pkill", ["-TERM", "-f", `sleep ${sleepArg}`]);
    await s.exited;
  }, 60_000);

  it("a run refused after its claim leaves no marker, and a dead session's stays on record", () => {
    const c = setup();
    const marker = markerOf(c);
    writeFileSync(marker, "999999\n");
    c.setTicket("40", { state: "closed" });

    const r = shResult(c.main, "./scripts/slice-session.sh 40");
    expect(r.ok).toBe(false);
    expect(r.out).toContain("#40 is closed, not open");
    expect(existsSync(marker)).toBe(false);
    // What the dispatcher would have written on reading the dead marker.
    expect(read(join(c.wt(40), ".slice-interrupted"))).toBe("999999\n");
  }, 60_000);

  it("--prep-only claims while it preps, and leaves no marker", async () => {
    const c = setup();
    c.trackerHeld(true);
    const p = startSession(c, ["--prep-only"]);
    const marker = markerOf(c);
    await until("the claim", () => read(marker) === `${p.child.pid}\n`);

    c.trackerHeld(false);
    expect(await p.exited, p.output()).toBe(0);
    expect(p.output()).toContain("✓ prepped, not launched");
    expect(existsSync(marker)).toBe(false);
  }, 60_000);

  it("a new worktree is claimed once it exists", async () => {
    fx = makeConsumer({ remote: true, agent: ["true"] });
    const c = fx;
    // Held in `body`, for the brief: after `git worktree add`.
    c.trackerHeld("body");
    const p = startSession(c, ["--prep-only"]);
    await until("the claim", () => read(markerOf(c)) === `${p.child.pid}\n`);
    expect(p.output()).toContain("✓ created worktree");

    c.trackerHeld(false);
    expect(await p.exited, p.output()).toBe(0);
    expect(existsSync(markerOf(c))).toBe(false);
  }, 60_000);

  it("--provision neither claims nor writes a marker", async () => {
    const c = setup();
    c.trackerHeld(true);
    const p = startSession(c, ["--provision"]);
    const marker = markerOf(c);
    // Held in `body`, for the brief, after the install: well past any claim.
    await until(`the install — output so far:\n${p.output()}`, () =>
      /dependencies installed|no install step/.test(p.output()),
    );
    await new Promise((r) => setTimeout(r, 500));
    expect(p.child.exitCode).toBeNull();
    expect(existsSync(marker)).toBe(false);

    c.trackerHeld(false);
    expect(await p.exited, p.output()).toBe(0);
    expect(p.output()).toContain("✓ provisioned");
    expect(existsSync(marker)).toBe(false);
  }, 60_000);
});

/**
 * `azelf relaunch` ends the session it replaces, which exits on a signal; kept
 * as a crash, every relaunch would leave a dead tab behind.
 */
describe("a session that was replaced closes its tab", () => {
  it("azelf relaunch ends a session that said done, and its tab exits 86", async () => {
    const c = setup();
    const s = await sessionDeclaredDone(c);
    const pid = readFileSync(
      join(c.wt(40), ".slice-ready-to-land"),
      "utf8",
    ).split("\n")[0];

    const r = spawnSync(
      "bun",
      [join(AZELF, "bin", "azelf.ts"), "relaunch", "40"],
      {
        cwd: c.main,
        encoding: "utf8",
        env: { ...process.env, SLICE_REPO_ROOT: c.main },
      },
    );

    expect(r.status, `${r.stdout}${r.stderr}`).toBe(0);
    expect(r.stdout).toContain(`Ended the old session (pid ${pid})`);
    expect(agentRunning()).toBe(false);
    expect(await s.exited).toBe(86);
    expect(s.output()).toContain("replaced by a new session of this slice");
    expect(existsSync(c.wt(40))).toBe(true);
  }, 60_000);

  it("a marker naming another session closes the tab too", async () => {
    const c = setup();
    const s = startSession(c);
    const marker = join(c.wt(40), ".slice-live");
    await until("the agent", () => existsSync(marker) && agentRunning());

    writeFileSync(marker, "999999\n");
    spawnSync("pkill", ["-TERM", "-f", `sleep ${sleepArg}`]);

    expect(await s.exited).toBe(86);
  }, 60_000);

  it("without --self-land the tab stays: a person may be reading it", async () => {
    const c = setup();
    const s = startSession(c, []);
    await until(
      "the agent",
      () => existsSync(join(c.wt(40), ".slice-live")) && agentRunning(),
    );
    writeFileSync(join(c.wt(40), ".slice-interrupted"), "relaunch\n");

    spawnSync("pkill", ["-TERM", "-f", `sleep ${sleepArg}`]);

    expect(await s.exited).toBe(128 + 15);
    expect(s.output()).not.toContain("closing this tab");
  }, 60_000);

  it("a crash with a pid on .slice-interrupted is still a crash", async () => {
    const c = setup();
    const s = startSession(c);
    await until(
      "the agent",
      () => existsSync(join(c.wt(40), ".slice-live")) && agentRunning(),
    );
    writeFileSync(join(c.wt(40), ".slice-interrupted"), "12345\n");

    spawnSync("pkill", ["-TERM", "-f", `sleep ${sleepArg}`]);

    expect(await s.exited).toBe(128 + 15);
  }, 60_000);
});

/**
 * A land pushes the base branch, so who declares a slice done is the whole
 * difference between the two modes. The prompt says it either way, because the
 * slice skill is a file the consumer may have edited.
 */
describe("the start prompt says who declares the slice done", () => {
  /** Runs a session whose agent writes the prompt it was given and exits. */
  function promptOf(...flags: string[]): string {
    fx = makeConsumer({
      worktrees: [40],
      remote: true,
      // The prompt lands in $0. The worktree is the cwd; its parent is the
      // fixture root, which keeps the file out of the slice's own tree.
      agent: ["bash", "-c", 'printf "%s" "$0" > ../prompt.txt'],
    });
    const r = spawnSync("./scripts/slice-session.sh", ["40", ...flags], {
      cwd: fx.main,
      encoding: "utf8",
    });
    const file = join(fx.root, "prompt.txt");
    expect(existsSync(file), `${r.stdout}${r.stderr}`).toBe(true);
    return readFileSync(file, "utf8");
  }

  it("without --self-land: stop, say it is ready, do NOT run slice-done.sh", () => {
    const prompt = promptOf();
    // The turn-is-over marker, named here too: the skill may be an edited copy.
    expect(prompt).toContain(
      "write your report with ./scripts/slice-finished.sh (the slice skill says how) and stop",
    );
    expect(prompt).toContain("Do NOT run ./scripts/slice-done.sh");
    expect(prompt).toContain("a human releases this slice");
    expect(prompt).not.toContain("and then exit");
    expect(prompt).not.toContain("--hand-over");
  }, 60_000);

  it("with --self-land: run slice-done.sh and exit, or hand it over to a person", () => {
    const prompt = promptOf("--self-land");
    expect(prompt).toContain("run ./scripts/slice-done.sh and then exit");
    expect(prompt).not.toContain("a human releases this slice");
    expect(prompt).toContain(
      'If only a person can get you further (a sign-in, a prompt nobody will answer in this tab, a device, a secret), do what the slice skill\'s "If only a person can get you further" says: commit what you have, run ./scripts/slice-done.sh --hand-over "<what the person has to do, and where your work is>", and end your turn.',
    );
  }, 60_000);
});

/**
 * A prompt written for the usual case ("read the parent spec") sent a session
 * in a worktree with no .slice-parent.md looking for the spec, and it stopped
 * there. The prompt says which case it is in: through `{parent}` where the
 * prompt has it, and by one appended sentence where it has not and there is
 * no parent.
 */
describe("the start prompt and the parent spec", () => {
  const NO_SPEC =
    "This ticket hangs under no spec: there is no .slice-parent.md in this worktree, and nothing takes precedence over .slice-ticket.md.";
  const SPEC =
    "The spec this ticket hangs under is in .slice-parent.md in this worktree — read the ticket first; where the two disagree, the parent decides.";

  /** The prompt a session of #40 is given, with or without a parent. */
  function promptOf(opts: {
    parent: boolean;
    startPrompt?: string;
    relaunch?: boolean;
  }): string {
    fx = makeConsumer({
      worktrees: [40],
      remote: true,
      agent: ["bash", "-c", 'printf "%s" "$0" > ../prompt.txt'],
      startPrompt: opts.startPrompt,
    });
    fx.setTicket("40", {
      body: opts.parent ? "Build.\n\n## Parent\n\n#17\n" : "Build.",
    });
    fx.setTicket("17", { title: "Spec: the feed", body: "PARENT-BODY" });
    if (opts.relaunch) {
      writeFileSync(join(fx.wt(40), "a.txt"), "a\n");
      git(fx.wt(40), "add", "a.txt");
      git(fx.wt(40), "commit", "-qm", "feat: a");
    }
    const r = spawnSync("./scripts/slice-session.sh", ["40"], {
      cwd: fx.main,
      encoding: "utf8",
    });
    const file = join(fx.root, "prompt.txt");
    expect(existsSync(file), `${r.stdout}${r.stderr}`).toBe(true);
    return readFileSync(file, "utf8");
  }

  it("appends the no-spec sentence to a prompt without {parent}, before the rest", () => {
    const prompt = promptOf({ parent: false });
    expect(prompt.startsWith(`x ${NO_SPEC} When it is finished`)).toBe(true);
  }, 60_000);

  it("leaves a prompt without {parent} alone when there is a parent", () => {
    const prompt = promptOf({ parent: true });
    expect(prompt.startsWith("x When it is finished")).toBe(true);
    expect(prompt).not.toContain("hangs under no spec");
    expect(prompt).not.toContain(".slice-parent.md");
  }, 60_000);

  it("expands {parent} to the sentence naming the file, and appends nothing", () => {
    const prompt = promptOf({
      parent: true,
      startPrompt: "Ticket #{n}. {parent} Go.",
    });
    expect(
      prompt.startsWith(`Ticket #40. ${SPEC} Go. When it is finished`),
    ).toBe(true);
    expect(prompt).not.toContain("hangs under no spec");
  }, 60_000);

  it("expands {parent} to nothing without a parent, space included, and appends nothing", () => {
    const prompt = promptOf({
      parent: false,
      startPrompt: "Ticket #{n}. {parent} Go.",
    });
    expect(prompt.startsWith("Ticket #40. Go. When it is finished")).toBe(true);
    expect(prompt).not.toContain("hangs under no spec");
    expect(prompt).not.toContain("{parent}");
  }, 60_000);

  it("keeps the relaunch sentence after it", () => {
    const prompt = promptOf({ parent: false, relaunch: true });
    expect(prompt).toContain(
      `${NO_SPEC} This worktree already has work from an earlier session`,
    );
  }, 60_000);
});

/**
 * The ticket checks a prep runs before anything is cut. A ticket named on the
 * dispatcher's command line without the ready label comes with `--named`, and
 * is prepped; a person's ticket (`humanLabel`) is refused either way.
 */
describe("which tickets a prep refuses", () => {
  /** Preps #40 as the fake tracker describes it, with each set of flags. */
  function prep(ticket: { ready?: boolean; labels?: string[] }) {
    const c = makeConsumer({
      remote: true,
      agent: ["true"],
      configExtra: 'humanLabel: "human",',
    });
    fx = c;
    c.setTicket("40", ticket);
    return (...flags: string[]) =>
      shResult(
        c.main,
        `./scripts/slice-session.sh 40 --prep-only ${flags.join(" ")}`,
      );
  }

  it("refuses a ticket without the ready label, unless it was named", () => {
    const run = prep({ ready: false });
    const refused = run();
    expect(refused.ok).toBe(false);
    expect(refused.out).toContain("error: #40 is missing the 'ready' label.");

    const named = run("--named");
    expect(named.ok, named.out).toBe(true);
    expect(named.out).toContain(
      "has no open blockers — not labelled ready, run because it was named",
    );
    expect(named.out).toContain("✓ prepped");
  }, 60_000);

  it("refuses a person's ticket, named or not", () => {
    const run = prep({ labels: ["human"] });
    for (const r of [run(), run("--named")]) {
      expect(r.ok).toBe(false);
      expect(r.out).toContain(
        "error: #40 is labelled human — a person does this one, not a session.",
      );
    }
  }, 60_000);
});
