import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type Exec,
  type GateContext,
  baselineDiff,
  exitCode,
  exitCodeOverFiles,
  multisetDifference,
  runGates,
} from "@/scripts/slice-gates";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

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
    expect(r).toEqual({ ok: true });
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
