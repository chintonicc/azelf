import { spawnSync } from "node:child_process";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AZELF } from "./fixture";

type Result = { ok: boolean; out: string; status: number | null };

const SCRIPT = join(AZELF, "scripts", "slice-par.ts");

function par(commands: string[][], timeoutMs = 20_000, cwd = process.cwd()) {
  const r = spawnSync("bun", [SCRIPT], {
    input: JSON.stringify({ cwd, timeoutMs, commands }),
    encoding: "utf8",
  });
  expect(r.status, r.stderr).toBe(0);
  return JSON.parse(r.stdout) as Result[];
}

describe("slice-par.ts", () => {
  it("answers in the order of the commands, with stdout then stderr", () => {
    expect(
      par([
        ["bash", "-c", "sleep 0.3; echo first"],
        ["bash", "-c", "echo second; echo err >&2; exit 3"],
      ]),
    ).toEqual([
      { ok: true, out: "first", status: 0 },
      { ok: false, out: "second\nerr", status: 3 },
    ]);
  });

  it("runs them at once: each sees the other start", () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "azelf-par-")));
    const waitFor = (me: string, other: string) => [
      "bash",
      "-c",
      `touch ${me}; for _ in $(seq 100); do [ -f ${other} ] && exit 0; sleep 0.1; done; exit 1`,
    ];
    const [a, b] = par([waitFor("a", "b"), waitFor("b", "a")], 20_000, dir);
    expect(a?.ok).toBe(true);
    expect(b?.ok).toBe(true);
  });

  it("a command that cannot start is a failed answer, and leaves the others alone", () => {
    const [missing, fine] = par([["azelf-no-such-binary"], ["echo", "fine"]]);
    expect(missing?.ok).toBe(false);
    expect(missing?.status).toBeNull();
    expect(missing?.out).toMatch(/ENOENT|not found|azelf-no-such-binary/i);
    expect(fine).toEqual({ ok: true, out: "fine", status: 0 });
  });

  it("a timeout ends that command, keeps what it printed, and says so", () => {
    const [slow, fine] = par(
      [
        ["bash", "-c", "echo partial; exec sleep 30"],
        ["echo", "fine"],
      ],
      500,
    );
    expect(slow?.ok).toBe(false);
    expect(slow?.out).toBe("partial\ntimed out after 1 s");
    expect(fine?.ok).toBe(true);
  }, 30_000);

  it("keeps a long answer whole, characters split across chunks included", () => {
    const [long] = par([
      ["bash", "-c", 'for _ in $(seq 60000); do printf "ä—"; done'],
    ]);
    expect(long?.ok).toBe(true);
    expect(long?.out).toBe("ä—".repeat(60000));
  });

  it("an argument spawn cannot pass at all is a failed answer too", () => {
    const [bad] = par([["echo", "a\u0000b"]]);
    expect(bad?.ok).toBe(false);
    expect(bad?.status).toBeNull();
  });
});
