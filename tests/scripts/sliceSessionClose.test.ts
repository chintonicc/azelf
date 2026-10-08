import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type Consumer, git, makeConsumer, sh, shResult } from "./fixture";

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

function startSession(c: Consumer): Session {
  let out = "";
  const child = spawn("./scripts/slice-session.sh", ["40", "--self-land"], {
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
    expect(prompt).toContain("Do NOT run ./scripts/slice-done.sh");
    expect(prompt).toContain("a human releases this slice");
    expect(prompt).not.toContain("and then exit");
  }, 60_000);

  it("with --self-land: run slice-done.sh and exit", () => {
    const prompt = promptOf("--self-land");
    expect(prompt).toContain("run ./scripts/slice-done.sh and then exit");
    expect(prompt).not.toContain("a human releases this slice");
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
