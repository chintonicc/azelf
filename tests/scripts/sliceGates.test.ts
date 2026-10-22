import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type Exec,
  type GateContext,
  baselineDiff,
  ciRuns,
  exitCode,
  exitCodeOverFiles,
  gateApplies,
  ghRepoOf,
  multisetDifference,
  runGates,
} from "@/scripts/slice-gates";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { git } from "./fixture";

/**
 * Every behaviour here exists because the gate got it wrong once for real —
 * ADR 0001 #28 (the tsc gate blamed #12 for three errors that were verbatim
 * on master) and the 2026-09-07 tree-wide format under a live session. The
 * commands are scripted, not run: what is under test is the SHAPE of each
 * check, and a fake exec makes the shape visible in the assertions.
 */

type Call = { cmd: string[]; cwd: string };

/** An exec that answers by (first word of cmd, cwd) and records every call. */
function fakeExec(answers: Record<string, { ok: boolean; out: string }>): {
  exec: Exec;
  calls: Call[];
} {
  const calls: Call[] = [];
  const exec: Exec = (cmd, cwd) => {
    calls.push({ cmd, cwd });
    const key = `${cmd[0]}@${cwd}`;
    return answers[key] ?? answers[cmd[0] as string] ?? { ok: true, out: "" };
  };
  return { exec, calls };
}

let worktree: string;
const BASELINE = "/main";

beforeEach(() => {
  worktree = mkdtempSync(join(tmpdir(), "slice-gates-"));
});
afterEach(() => {
  rmSync(worktree, { recursive: true, force: true });
});

const ctxWith = (
  exec: Exec,
  changedFiles: string[] = ["lib/a.ts"],
): GateContext => ({ worktree, baselineDir: BASELINE, changedFiles, exec });

describe("exitCode", () => {
  it("passes on exit zero and runs in the worktree", () => {
    const { exec, calls } = fakeExec({ bun: { ok: true, out: "" } });
    const gate = exitCode(["bun", "run", "test"]);
    expect(gate.run(ctxWith(exec))).toEqual({ ok: true });
    expect(calls).toEqual([{ cmd: ["bun", "run", "test"], cwd: worktree }]);
  });

  it("fails on a non-zero exit, naming the command and carrying the hint", () => {
    const { exec } = fakeExec({
      bun: { ok: false, out: "1 failed\n\nFAIL lib/a.test.ts" },
    });
    const gate = exitCode(["bun", "run", "test"], {
      hint: "the unit suite is red",
    });
    const r = gate.run(ctxWith(exec));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.why).toBe("`bun run test` failed (the unit suite is red)");
    expect(r.detail).toEqual(["1 failed", "FAIL lib/a.test.ts"]);
  });
});

describe("exitCodeOverFiles", () => {
  it("appends the changed files that still exist, and only those", () => {
    writeFileSync(join(worktree, "kept.ts"), "");
    const { exec, calls } = fakeExec({});
    const gate = exitCodeOverFiles(["bunx", "biome", "check"]);
    expect(
      gate.run(ctxWith(exec, ["kept.ts", "deleted-by-the-slice.ts"])).ok,
    ).toBe(true);
    expect(calls).toEqual([
      { cmd: ["bunx", "biome", "check", "kept.ts"], cwd: worktree },
    ]);
  });

  it("passes WITHOUT running when nothing changed survives — no paths would mean the whole tree", () => {
    const { exec, calls } = fakeExec({});
    const gate = exitCodeOverFiles(["bunx", "biome", "check"]);
    expect(gate.run(ctxWith(exec, ["gone.ts"])).ok).toBe(true);
    expect(calls).toEqual([]);
  });

  it("fails on a non-zero exit with the hint", () => {
    writeFileSync(join(worktree, "a.ts"), "");
    const { exec } = fakeExec({ bunx: { ok: false, out: "a.ts lint/x" } });
    const gate = exitCodeOverFiles(["bunx", "biome", "check"], {
      hint: "run ./scripts/format.sh",
    });
    const r = gate.run(ctxWith(exec, ["a.ts"]));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.why).toBe(
      "`bunx biome check` failed on the changed files (run ./scripts/format.sh)",
    );
  });
});

describe("multisetDifference", () => {
  it("is empty when the candidate is a permutation of the baseline", () => {
    expect(multisetDifference(["a", "b", "c"], ["c", "a", "b"])).toEqual([]);
  });

  it("reports what is not in the baseline", () => {
    expect(multisetDifference(["a"], ["a", "b"])).toEqual(["b"]);
  });

  it("counts a DUPLICATE of a baseline entry as new — a multiset, not a Set", () => {
    expect(multisetDifference(["a"], ["a", "a"])).toEqual(["a"]);
  });

  it("does not care about errors the candidate fixed", () => {
    expect(multisetDifference(["a", "b"], ["b"])).toEqual([]);
  });
});

describe("baselineDiff", () => {
  // The tsc configuration from slice.config.ts, spelled out so the test does
  // not depend on the config module (which reads git at import time).
  const tsc = () =>
    baselineDiff({
      cmd: ["bunx", "tsc", "--noEmit"],
      errorMatch: /error TS/,
      normalize: (l) => l.replace(/\(\d+,\d+\)/, ""),
    });

  const MAIN = [
    "db/remote/queries.ts(40,3): error TS2345: Argument of type 'X'",
    "app/_layout.tsx(12,9): error TS2322: Type 'A' is not assignable",
    "Found 2 errors.",
  ].join("\n");

  it("runs the command in the baseline dir AND the worktree", () => {
    const { exec, calls } = fakeExec({
      [`bunx@${BASELINE}`]: { ok: false, out: MAIN },
      [`bunx@${worktree}`]: { ok: false, out: MAIN },
    });
    expect(tsc().run(ctxWith(exec))).toEqual({ ok: true });
    expect(calls.map((c) => c.cwd)).toEqual([BASELINE, worktree]);
  });

  it("does NOT block on an error already on master, even in a file the slice touched", () => {
    const { exec } = fakeExec({
      [`bunx@${BASELINE}`]: { ok: false, out: MAIN },
      [`bunx@${worktree}`]: { ok: false, out: MAIN },
    });
    const r = tsc().run(
      ctxWith(exec, ["db/remote/queries.ts", "app/_layout.tsx"]),
    );
    expect(r).toEqual({ ok: true });
  });

  it("does NOT block when an existing error only moved lines", () => {
    const shifted = MAIN.replace("(40,3)", "(57,3)").replace(
      "(12,9)",
      "(13,9)",
    );
    const { exec } = fakeExec({
      [`bunx@${BASELINE}`]: { ok: false, out: MAIN },
      [`bunx@${worktree}`]: { ok: false, out: shifted },
    });
    expect(tsc().run(ctxWith(exec))).toEqual({ ok: true });
  });

  it("DOES block on a new error, in a file the slice never edited", () => {
    const introduced =
      "lib/untouched.ts(3,1): error TS2554: Expected 1 arguments, but got 2";
    const { exec } = fakeExec({
      [`bunx@${BASELINE}`]: { ok: false, out: MAIN },
      [`bunx@${worktree}`]: { ok: false, out: `${MAIN}\n${introduced}` },
    });
    const r = tsc().run(ctxWith(exec, ["lib/other.ts"]));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.why).toBe(
      "1 error(s) from `bunx tsc --noEmit` it introduced (baseline is 2)",
    );
    expect(r.detail).toEqual([
      "lib/untouched.ts: error TS2554: Expected 1 arguments, but got 2",
    ]);
  });

  it("DOES block on a second copy of an existing error", () => {
    const dup = MAIN.split("\n")[0] as string;
    const { exec } = fakeExec({
      [`bunx@${BASELINE}`]: { ok: false, out: MAIN },
      [`bunx@${worktree}`]: { ok: false, out: `${MAIN}\n${dup}` },
    });
    const r = tsc().run(ctxWith(exec));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.detail).toEqual([
      "db/remote/queries.ts: error TS2345: Argument of type 'X'",
    ]);
  });

  it("passes when the slice fixed some of the baseline", () => {
    const fewer = MAIN.split("\n").slice(1).join("\n");
    const { exec } = fakeExec({
      [`bunx@${BASELINE}`]: { ok: false, out: MAIN },
      [`bunx@${worktree}`]: { ok: false, out: fewer },
    });
    expect(tsc().run(ctxWith(exec))).toEqual({ ok: true });
  });

  it("reports a non-zero exit with no matching lines as a crash, not a pass", () => {
    const { exec } = fakeExec({
      [`bunx@${BASELINE}`]: { ok: false, out: MAIN },
      [`bunx@${worktree}`]: {
        ok: false,
        out: "RangeError: Maximum call stack size exceeded",
      },
    });
    const r = tsc().run(ctxWith(exec));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.why).toMatch(/did it crash/);
  });

  it("accepts a function matcher and survives a /g RegExp", () => {
    const out = "x error: one\ny error: two";
    const { exec } = fakeExec({
      [`mypy@${BASELINE}`]: { ok: false, out: "" },
      [`mypy@${worktree}`]: { ok: false, out },
    });
    const byFn = baselineDiff({
      cmd: ["mypy"],
      errorMatch: (l) => l.includes("error:"),
      normalize: (l) => l,
    }).run(ctxWith(exec));
    const byGlobal = baselineDiff({
      cmd: ["mypy"],
      errorMatch: /error:/g,
      normalize: (l) => l,
    }).run(ctxWith(exec));
    for (const r of [byFn, byGlobal]) {
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.detail).toHaveLength(2);
    }
  });
});

describe("runGates", () => {
  const clean = { ok: true, out: "" };
  const dirty = { ok: true, out: " M lib/a.ts\n?? lib/new.ts" };

  it("runs every gate in order and passes when all do", () => {
    const { exec, calls } = fakeExec({ git: clean });
    const r = runGates([exitCode(["one"]), exitCode(["two"])], ctxWith(exec));
    expect(r).toEqual({ ok: true, flaky: [], skipped: [] });
    expect(calls.map((c) => c.cmd[0])).toEqual([
      "git",
      "one",
      "git",
      "two",
      "git",
    ]);
  });

  it("stops at the first failing gate", () => {
    const { exec, calls } = fakeExec({
      git: clean,
      one: { ok: false, out: "" },
    });
    const r = runGates([exitCode(["one"]), exitCode(["two"])], ctxWith(exec));
    expect(r.ok).toBe(false);
    expect(calls.some((c) => c.cmd[0] === "two")).toBe(false);
  });

  it("fails closed when git status itself cannot run — an empty answer is not 'clean'", () => {
    const { exec, calls } = fakeExec({
      git: { ok: false, out: "fatal: not a git repository" },
    });
    const r = runGates([exitCode(["one"])], ctxWith(exec));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.why).toMatch(/could not read the worktree's git status/);
    expect(calls.some((c) => c.cmd[0] === "one")).toBe(false);
  });

  it("refuses to start on a dirty worktree", () => {
    const { exec, calls } = fakeExec({ git: dirty });
    const r = runGates([exitCode(["one"])], ctxWith(exec));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.why).toMatch(/dirty before any gate ran/);
    expect(calls.some((c) => c.cmd[0] === "one")).toBe(false);
  });

  it("fails a gate BY NAME when it modified the worktree, even if the gate itself passed", () => {
    // Clean going in; dirty after the first gate ran.
    let statusCalls = 0;
    const exec: Exec = (cmd, _cwd) => {
      if (cmd[0] === "git") return ++statusCalls === 1 ? clean : dirty;
      return { ok: true, out: "" };
    };
    const r = runGates(
      [exitCode(["bun", "run", "format"]), exitCode(["two"])],
      ctxWith(exec),
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.why).toMatch(
      /^gate `bun run format` modified the worktree — gates must be read-only/,
    );
    expect(r.detail).toEqual(["M lib/a.ts", "?? lib/new.ts"]);
  });
});

/**
 * `when`: a gate that judges one part of the tree runs only for a diff that
 * touches it. A native build is minutes; a slice that changed a locale file
 * should not wait for it, and should not be told it passed.
 */
describe("runGates with when", () => {
  const clean = { ok: true, out: "" };
  const native = exitCode(["native"], { when: ["ios/**", "scripts/*.swift"] });

  it("skips a gate whose paths the diff does not touch, and names it", () => {
    const { exec, calls } = fakeExec({ git: clean });
    const r = runGates(
      [exitCode(["test"]), native],
      ctxWith(exec, ["lib/a.ts", "ios.md"]),
    );
    expect(r).toEqual({ ok: true, flaky: [], skipped: ["native"] });
    expect(calls.some((c) => c.cmd[0] === "native")).toBe(false);
  });

  it("runs it when one changed file matches", () => {
    const { exec, calls } = fakeExec({
      git: clean,
      native: { ok: false, out: "build failed" },
    });
    const r = runGates(
      [native],
      ctxWith(exec, ["lib/a.ts", "ios/App/x.swift"]),
    );
    expect(r.ok).toBe(false);
    expect(r.skipped).toEqual([]);
    expect(calls.some((c) => c.cmd[0] === "native")).toBe(true);
  });

  it("`**` crosses directories and `*` stays in one", () => {
    expect(gateApplies(native, ["ios/a/b/c/x.swift"])).toBe(true);
    expect(gateApplies(native, ["scripts/encode.swift"])).toBe(true);
    expect(gateApplies(native, ["scripts/tools/encode.swift"])).toBe(false);
    expect(gateApplies(native, ["src/ios/x.swift"])).toBe(false);
  });

  it("a gate without when always runs, on every shape", () => {
    expect(gateApplies(exitCode(["test"]), [])).toBe(true);
    expect(gateApplies(exitCode(["test"]), ["anything"])).toBe(true);
    const shapes = [
      exitCodeOverFiles(["lint"], { when: ["ios/"] }),
      baselineDiff({
        cmd: ["tsc"],
        errorMatch: /error/,
        normalize: (l) => l,
        when: ["ios/"],
      }),
    ];
    for (const g of shapes) {
      expect(g.when).toEqual(["ios/"]);
      expect(gateApplies(g, ["ios/x.swift"])).toBe(true);
      expect(gateApplies(g, ["lib/x.ts"])).toBe(false);
    }
  });

  it("still checks the worktree is clean when every gate is skipped", () => {
    const { exec } = fakeExec({ git: { ok: true, out: " M lib/a.ts" } });
    const r = runGates([native], ctxWith(exec));
    expect(r.ok).toBe(false);
  });
});

/**
 * `retries`: a gate that is flaky under a wave's load may be re-run, and a
 * pass on a retry is reported rather than buried. Off by default, because
 * re-running a deterministic gate only doubles what a real failure costs.
 */
describe("runGates with retries", () => {
  const clean = { ok: true, out: "" };

  /** An exec where `test` fails its first `failures` calls, then passes. */
  const flakyTest = (failures: number) => {
    let calls = 0;
    const exec: Exec = (cmd) => {
      if (cmd[0] === "git") return clean;
      calls += 1;
      return calls <= failures
        ? { ok: false, out: "Test timed out in 5000ms" }
        : { ok: true, out: "" };
    };
    return { exec, calls: () => calls };
  };

  it("passes a gate that failed once and passed on its retry, and names it flaky", () => {
    const { exec, calls } = flakyTest(1);
    const r = runGates([exitCode(["test"], { retries: 1 })], ctxWith(exec));
    expect(r).toEqual({
      ok: true,
      flaky: [{ gate: "test", retry: 1 }],
      skipped: [],
    });
    expect(calls()).toBe(2);
  });

  it("fails the same gate without retries, running it once", () => {
    const { exec, calls } = flakyTest(1);
    const r = runGates([exitCode(["test"])], ctxWith(exec));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.why).toBe("`test` failed");
    expect(r.flaky).toEqual([]);
    expect(calls()).toBe(1);
  });

  it("fails once the retries are spent, and says it was retried", () => {
    const { exec, calls } = flakyTest(3);
    const r = runGates([exitCode(["test"], { retries: 2 })], ctxWith(exec));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.why).toBe("`test` failed, and again on 2 retries");
    expect(r.detail).toEqual(["Test timed out in 5000ms"]);
    expect(calls()).toBe(3);
  });

  it("does not re-run a gate that passed, and reports the retry that passed", () => {
    const { exec, calls } = flakyTest(2);
    const r = runGates(
      [exitCode(["test"], { retries: 3 }), exitCodeOverFiles(["lint"])],
      ctxWith(exec, []),
    );
    expect(r).toEqual({
      ok: true,
      flaky: [{ gate: "test", retry: 2 }],
      skipped: [],
    });
    expect(calls()).toBe(3);
  });

  it("checks for writes after every attempt, not only the last", () => {
    let status = 0;
    let runs = 0;
    const exec: Exec = (cmd) => {
      if (cmd[0] === "git") {
        status += 1;
        // Clean going in and after the first attempt; dirty after the retry.
        return status <= 2 ? clean : { ok: true, out: " M lib/a.ts" };
      }
      runs += 1;
      return { ok: runs > 1, out: "" };
    };
    const r = runGates([exitCode(["test"], { retries: 1 })], ctxWith(exec));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.why).toMatch(/^gate `test` modified the worktree/);
  });

  it("is carried by every shape", () => {
    expect(exitCode(["a"], { retries: 1 }).retries).toBe(1);
    expect(exitCodeOverFiles(["a"], { retries: 1 }).retries).toBe(1);
    expect(
      baselineDiff({
        cmd: ["tsc"],
        errorMatch: /error/,
        normalize: (l) => l,
        retries: 1,
      }).retries,
    ).toBe(1);
    expect(exitCode(["a"]).retries).toBeUndefined();
  });
});

/**
 * `ciRuns`: CI on the slice's own SHA as a gate, ported from consumer-b's
 * backend, whose script had done this since its adoption. The world is
 * scripted: `gh run list` answers from a list in turn, and the sleep is a call
 * like any other, so a 45-minute wait is a count of calls and no clock.
 */
describe("ciRuns", () => {
  const SHA = "0123456789abcdef0123456789abcdef01234567";
  const CI_REF = "refs/heads/azelf-ci/ticket-40-0123456789ab";
  const LIST = `gh run list -R acme/app --commit ${SHA} --limit 30 --json databaseId,name,status,conclusion,url`;

  type CiRun = {
    databaseId: number;
    name: string;
    status: string;
    conclusion: string;
    url: string;
  };
  const runOf =
    (status: string, conclusion: string) =>
    (databaseId: number, name: string): CiRun => ({
      databaseId,
      name,
      status,
      conclusion,
      url: `https://github.com/acme/app/actions/runs/${databaseId}`,
    });
  const green = runOf("completed", "success");
  const red = runOf("completed", "failure");
  const running = runOf("in_progress", "");

  /** One slice on `ticket/40`, an origin on GitHub, and `gh` answering `lists` in turn; the last repeats. */
  function ciWorld(o: {
    lists: (CiRun[] | { ok: false; out: string })[];
    branch?: string;
    origin?: string;
    push?: { ok: boolean; out: string };
  }) {
    const calls: Call[] = [];
    let listed = 0;
    const exec: Exec = (cmd, cwd) => {
      calls.push({ cmd, cwd });
      const line = cmd.join(" ");
      if (line === "git branch --show-current") {
        return { ok: true, out: `${o.branch ?? "ticket/40"}\n` };
      }
      if (line === "git rev-parse HEAD") return { ok: true, out: `${SHA}\n` };
      if (line === "git remote get-url origin") {
        return {
          ok: true,
          out: `${o.origin ?? "git@github.com:acme/app.git"}\n`,
        };
      }
      if (cmd[0] === "git" && cmd[1] === "push") {
        const deleting = (cmd.at(-1) ?? "").startsWith(":");
        // Deleting a branch that is not there fails, and the gate ignores it.
        if (deleting) return { ok: false, out: "remote ref does not exist" };
        return o.push ?? { ok: true, out: "" };
      }
      if (cmd[0] === "gh") {
        const answer = o.lists[Math.min(listed++, o.lists.length - 1)];
        return Array.isArray(answer)
          ? { ok: true, out: JSON.stringify(answer) }
          : (answer as { ok: false; out: string });
      }
      return { ok: true, out: "" };
    };
    const lines = () => calls.map((c) => c.cmd.join(" "));
    const count = (prefix: string) =>
      lines().filter((l) => l.startsWith(prefix)).length;
    return { exec, calls, lines, count };
  }

  const gate = (opts: Partial<Parameters<typeof ciRuns>[0]> = {}) =>
    ciRuns({ workflows: ["Tests", "Docker-Gate"], ...opts });

  it("passes without a push when every workflow is already green on the SHA", () => {
    const w = ciWorld({
      lists: [[green(5, "Tests"), green(6, "Docker-Gate")]],
    });
    expect(gate().run(ctxWith(w.exec))).toEqual({ ok: true });
    expect(w.count("git push")).toBe(0);
    expect(w.count("sleep")).toBe(0);
  });

  it("pushes the SHA under a branch of its own, waits for every workflow, and deletes the branch", () => {
    const w = ciWorld({
      lists: [
        [],
        [running(11, "Tests")],
        [green(11, "Tests"), green(12, "Docker-Gate")],
      ],
    });
    expect(gate().run(ctxWith(w.exec))).toEqual({ ok: true });
    expect(w.lines()).toEqual([
      "git branch --show-current",
      "git rev-parse HEAD",
      "git remote get-url origin",
      LIST,
      `git push -q origin :${CI_REF}`,
      `git push -q origin HEAD:${CI_REF}`,
      "sleep 20",
      LIST,
      "sleep 20",
      LIST,
      `git push -q origin :${CI_REF}`,
    ]);
    expect(w.calls.every((c) => c.cwd === worktree)).toBe(true);
  });

  it("is named after its workflows", () => {
    expect(gate().name).toBe("CI: Tests, Docker-Gate");
  });

  it("fails on a workflow that did not succeed, names the run, and deletes the branch", () => {
    const w = ciWorld({
      lists: [[], [running(11, "Tests"), red(12, "Docker-Gate")]],
    });
    const r = gate({ hint: "see the run" }).run(ctxWith(w.exec));
    expect(r).toEqual({
      ok: false,
      why: "CI: `Docker-Gate` is failure on 0123456 (see the run)",
      detail: [
        "https://github.com/acme/app/actions/runs/12",
        `gh run list -R acme/app --commit ${SHA}`,
      ],
    });
    expect(w.lines().at(-1)).toBe(`git push -q origin :${CI_REF}`);
  });

  it("does not count a run that finished before the push", () => {
    // A red `Tests` from an earlier attempt on the same SHA. The retry pushes
    // again, and only what that push starts decides.
    const before = [red(5, "Tests"), green(6, "Docker-Gate")];
    const w = ciWorld({
      lists: [
        before,
        before,
        [...before, running(11, "Tests")],
        [...before, green(11, "Tests"), green(12, "Docker-Gate")],
      ],
    });
    expect(gate().run(ctxWith(w.exec))).toEqual({ ok: true });
    expect(w.count("sleep")).toBe(3);
  });

  it("is red at the deadline, and says which workflow ran and which never started", () => {
    const w = ciWorld({ lists: [[], [running(11, "Tests")]] });
    const r = gate({ deadlineMinutes: 1, pollSeconds: 20 }).run(
      ctxWith(w.exec),
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.why).toBe(
      "CI: not finished on 0123456 after 1 minute — `Tests` still running, `Docker-Gate` never started",
    );
    expect(r.detail).toEqual([
      `gh run list -R acme/app --commit ${SHA}`,
      "A workflow that never starts: check its name, and that it runs on a push to azelf-ci/**.",
    ]);
    expect(w.count("sleep 20")).toBe(3);
    expect(w.lines().at(-1)).toBe(`git push -q origin :${CI_REF}`);
  });

  it("fails without waiting when the push is refused", () => {
    const w = ciWorld({
      lists: [[]],
      push: { ok: false, out: "! [remote rejected] (permission denied)" },
    });
    const r = gate().run(ctxWith(w.exec));
    expect(r).toEqual({
      ok: false,
      why: "CI: the push of 0123456 to azelf-ci/ticket-40-0123456789ab was refused",
      detail: ["! [remote rejected] (permission denied)"],
    });
    expect(w.count("sleep")).toBe(0);
    expect(w.count("gh")).toBe(1);
  });

  it("deletes a branch a killed run left behind before it pushes, so the push starts CI", () => {
    // A push of a branch already at this SHA changes nothing on GitHub, and
    // starts no workflow: the wait would end at the deadline, red.
    const w = ciWorld({
      lists: [[], [green(11, "Tests"), green(12, "Docker-Gate")]],
    });
    gate().run(ctxWith(w.exec));
    const pushes = w.lines().filter((l) => l.startsWith("git push"));
    expect(pushes.slice(0, 2)).toEqual([
      `git push -q origin :${CI_REF}`,
      `git push -q origin HEAD:${CI_REF}`,
    ]);
  });

  it("refuses a detached HEAD, before it asks GitHub anything", () => {
    const w = ciWorld({ lists: [[]], branch: "" });
    const r = gate().run(ctxWith(w.exec));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.why).toMatch(/^CI: the worktree is on a detached HEAD/);
    expect(w.count("gh")).toBe(0);
    expect(w.count("git push")).toBe(0);
  });

  it("refuses an origin that is not on GitHub", () => {
    const w = ciWorld({ lists: [[]], origin: "/srv/git/app.git" });
    const r = gate().run(ctxWith(w.exec));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.why).toBe(
      "CI: origin is not a GitHub repository (/srv/git/app.git) — ciRuns reads GitHub Actions through gh",
    );
    expect(w.count("gh")).toBe(0);
  });

  it("fails at once when gh cannot list the runs before the push", () => {
    const w = ciWorld({
      lists: [
        {
          ok: false,
          out: "To get started with GitHub CLI, please run:  gh auth login",
        },
      ],
    });
    const r = gate().run(ctxWith(w.exec));
    expect(r).toEqual({
      ok: false,
      why: "CI: gh could not list the runs on 0123456",
      detail: ["To get started with GitHub CLI, please run:  gh auth login"],
    });
    expect(w.count("git push")).toBe(0);
  });

  it("keeps waiting through a gh call that fails during the wait", () => {
    const w = ciWorld({
      lists: [
        [],
        { ok: false, out: "HTTP 502: Bad Gateway" },
        [green(11, "Tests"), green(12, "Docker-Gate")],
      ],
    });
    expect(gate().run(ctxWith(w.exec))).toEqual({ ok: true });
  });

  it("names the last gh failure when the deadline passes", () => {
    const w = ciWorld({
      lists: [[], { ok: false, out: "HTTP 502: Bad Gateway" }],
    });
    const r = gate({ deadlineMinutes: 1 }).run(ctxWith(w.exec));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.detail).toContain(
      "The last look at the runs failed: HTTP 502: Bad Gateway",
    );
  });

  it("reads gh's answer past a warning on stderr", () => {
    const w = ciWorld({ lists: [] });
    const exec: Exec = (cmd, cwd) =>
      cmd[0] === "gh"
        ? {
            ok: true,
            out: `warning: something about gh\n${JSON.stringify([
              green(5, "Tests"),
              green(6, "Docker-Gate"),
            ])}`,
          }
        : w.exec(cmd, cwd);
    expect(gate().run(ctxWith(exec))).toEqual({ ok: true });
  });

  /** A context whose `log` collects what the gate says while it waits. */
  const heard = (exec: Exec) => {
    const said: string[] = [];
    const ctx = { ...ctxWith(exec), log: (line: string) => said.push(line) };
    return { ctx, said };
  };

  it("says the push, then each change in the workflows, and not every look", () => {
    const w = ciWorld({
      lists: [
        [],
        [],
        [running(11, "Tests")],
        [running(11, "Tests")],
        [running(11, "Tests"), green(12, "Docker-Gate")],
        [green(11, "Tests"), green(12, "Docker-Gate")],
      ],
    });
    const { ctx, said } = heard(w.exec);
    expect(gate().run(ctx)).toEqual({ ok: true });
    expect(said).toEqual([
      "CI: pushed 0123456 as azelf-ci/ticket-40-0123456789ab — waiting for `Tests`, `Docker-Gate`, at most 45 minutes",
      "CI: `Tests` running, `Docker-Gate` not started (after 40s)",
      "CI: `Tests` running, `Docker-Gate` passed (after 1m20s)",
    ]);
  });

  it("says a failed look once, and the workflows again when gh answers", () => {
    const w = ciWorld({
      lists: [
        [],
        { ok: false, out: "HTTP 502: Bad Gateway" },
        { ok: false, out: "HTTP 502: Bad Gateway" },
        [running(11, "Tests")],
        [green(11, "Tests"), green(12, "Docker-Gate")],
      ],
    });
    const { ctx, said } = heard(w.exec);
    expect(gate().run(ctx)).toEqual({ ok: true });
    expect(said.slice(1)).toEqual([
      "CI: gh could not list the runs — looking again (after 20s)",
      "CI: `Tests` running, `Docker-Gate` not started (after 1m)",
    ]);
  });

  it("says nothing when there is nothing to wait for", () => {
    const w = ciWorld({
      lists: [[green(5, "Tests"), green(6, "Docker-Gate")]],
    });
    const { ctx, said } = heard(w.exec);
    expect(gate().run(ctx)).toEqual({ ok: true });
    expect(said).toEqual([]);
  });

  it("is refused when it is built with no workflow, an empty name, or an interval that is not positive", () => {
    expect(() => ciRuns({ workflows: [] })).toThrow(/at least one workflow/);
    expect(() => ciRuns({ workflows: ["Tests", ""] })).toThrow(
      /at least one workflow/,
    );
    expect(() => ciRuns({ workflows: ["Tests"], deadlineMinutes: 0 })).toThrow(
      /deadlineMinutes/,
    );
    expect(() => ciRuns({ workflows: ["Tests"], pollSeconds: -1 })).toThrow(
      /pollSeconds/,
    );
  });

  it("carries retries and when like every shape", () => {
    const g = gate({ retries: 1, when: ["app/**"] });
    expect(g.retries).toBe(1);
    expect(g.when).toEqual(["app/**"]);
  });
});

describe("ghRepoOf", () => {
  it.each([
    ["git@github.com:acme/app.git", "acme/app"],
    ["https://github.com/acme/app", "acme/app"],
    ["https://github.com/acme/app.git/", "acme/app"],
    ["ssh://git@github.com:22/acme/app.git", "acme/app"],
    ["https://x-access-token:t0k@github.com/acme/app.git", "acme/app"],
    ["git@ghe.example.com:acme/app.git", "ghe.example.com/acme/app"],
    ["/srv/git/app.git", null],
    ["file:///srv/git/app.git", null],
    ["", null],
  ])("%s → %s", (url, repo) => {
    expect(ghRepoOf(url)).toBe(repo);
  });
});

/**
 * The same gate against a real git remote, under runGates. Only `gh` is
 * faked, by a script on PATH: the pushes and the deletion are git's own, and
 * runGates' read-only check sees the worktree after them.
 */
describe("ciRuns against a real remote", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "slice-ci-"));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("pushes the branch for CI, deletes it after, and leaves the worktree clean", () => {
    const bare = join(root, "origin.git");
    const wt = join(root, "wt");
    const bin = join(root, "bin");
    git(root, "init", "-q", "--bare", bare);
    git(root, "init", "-q", "-b", "main", wt);
    writeFileSync(join(wt, "a.txt"), "a\n");
    git(wt, "add", "a.txt");
    git(wt, "commit", "-q", "-m", "a");
    git(wt, "switch", "-q", "-c", "ticket/40");
    // origin reads as GitHub, and pushes go to the bare repo.
    git(wt, "remote", "add", "origin", "https://github.com/acme/app");
    git(
      wt,
      "config",
      `url.${bare}.pushInsteadOf`,
      "https://github.com/acme/app",
    );
    const sha = git(wt, "rev-parse", "HEAD");

    // The first look is before the push and finds nothing; every later one
    // finds Tests green. Each records what branches origin has at that moment.
    mkdirSync(bin);
    writeFileSync(
      join(bin, "gh"),
      `#!/usr/bin/env bash
echo "$*" >> "${root}/gh-args"
git --git-dir="${bare}" for-each-ref --format='%(refname)' refs/heads/azelf-ci >> "${root}/refs-seen"
if [ -f "${root}/looked" ]; then
  echo '[{"databaseId":11,"name":"Tests","status":"completed","conclusion":"success","url":"u"}]'
else
  touch "${root}/looked"
  echo '[]'
fi
`,
    );
    chmodSync(join(bin, "gh"), 0o755);
    const exec: Exec = (cmd, cwd) => {
      const r = spawnSync(cmd[0] as string, cmd.slice(1), {
        cwd,
        encoding: "utf8",
        env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
      });
      return { ok: r.status === 0, out: `${r.stdout}${r.stderr}` };
    };

    const r = runGates([ciRuns({ workflows: ["Tests"], pollSeconds: 0.01 })], {
      worktree: wt,
      baselineDir: wt,
      changedFiles: ["a.txt"],
      exec,
    });

    expect(r).toEqual({ ok: true, flaky: [], skipped: [] });
    expect(readFileSync(join(root, "refs-seen"), "utf8")).toBe(
      `refs/heads/azelf-ci/ticket-40-${sha.slice(0, 12)}\n`,
    );
    expect(readFileSync(join(root, "gh-args"), "utf8")).toContain(
      `-R acme/app --commit ${sha}`,
    );
    expect(
      git(root, "--git-dir", bare, "for-each-ref", "refs/heads/azelf-ci"),
    ).toBe("");
    expect(git(wt, "for-each-ref", "refs/remotes/origin/azelf-ci")).toBe("");
  });
});
