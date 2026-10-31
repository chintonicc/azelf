import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type Consumer, git, makeConsumer } from "./fixture";

/**
 * `ports` in slice.config.ts: the prep gives each slice a block, keeps it in
 * .slice-ports, and hands it to the session in its environment and its
 * prompt. The agent here writes what it was given and exits.
 */

let c: Consumer | undefined;
afterEach(() => {
  if (c) rmSync(c.root, { recursive: true, force: true });
  c = undefined;
});

const RECORD = [
  "bash",
  "-c",
  'printf "%s\\n%s\\n%s" "${SLICE_PORT_BASE-unset}" "${SLICE_PORT_COUNT-unset}" "$0" > "../given-$(basename "$PWD")"',
];

const withPorts = (extra = "ports: { from: 41000, size: 5 },") =>
  makeConsumer({
    worktrees: [40, 41],
    remote: true,
    agent: RECORD,
    configExtra: extra,
  });

/** Runs slice-session.sh for one ticket; returns what its session was given. */
function session(fx: Consumer, n: number) {
  const r = spawnSync("./scripts/slice-session.sh", [String(n)], {
    cwd: fx.main,
    encoding: "utf8",
  });
  const file = join(fx.root, `given-${fx.wt(n).split("/").pop()}`);
  expect(existsSync(file), `${r.stdout}${r.stderr}`).toBe(true);
  const [base, count, ...prompt] = readFileSync(file, "utf8").split("\n");
  return {
    base,
    count,
    prompt: prompt.join("\n"),
    out: `${r.stdout}${r.stderr}`,
  };
}

describe("a block of ports per slice", () => {
  it("gives two slices two blocks, and says so in the prompt", () => {
    c = withPorts();

    const a = session(c, 40);
    const b = session(c, 41);

    expect([a.base, a.count]).toEqual(["41000", "5"]);
    expect([b.base, b.count]).toEqual(["41005", "5"]);
    expect(a.out).toContain(
      "✓ ports 41000–41004 are this slice's (SLICE_PORT_BASE, SLICE_PORT_COUNT)",
    );
    expect(a.prompt).toContain(
      "Ports 41000–41004 are this slice's alone ($SLICE_PORT_BASE and $SLICE_PORT_COUNT in your environment): start every server you need on one of them, and stop only processes you started, by their PID — never pkill -f, which reaches other slices' servers.",
    );
    expect(readFileSync(join(c.wt(40), ".slice-ports"), "utf8")).toBe(
      "41000\n",
    );
    // Ignored, so the slice stays clean and lands.
    expect(git(c.wt(40), "status", "--porcelain")).toBe("");
  }, 60_000);

  it("keeps a slice's block across a relaunch, even with its own server listening in it", async () => {
    c = withPorts();
    session(c, 40);
    const server = createServer();
    await new Promise<void>((r) => server.listen(41002, "127.0.0.1", r));
    try {
      expect(session(c, 40).base).toBe("41000");
      // Another slice skips both the held block and the listening port's.
      rmSync(join(c.wt(40), ".slice-ports"));
      expect(session(c, 41).base).toBe("41005");
      expect(session(c, 40).base).toBe("41010");
    } finally {
      server.close();
    }
  }, 60_000);

  it("gives nothing, and says nothing, without ports in the config", () => {
    c = withPorts("");

    const a = session(c, 40);

    expect([a.base, a.count]).toEqual(["unset", "unset"]);
    expect(a.prompt).not.toContain("Ports ");
    expect(existsSync(join(c.wt(40), ".slice-ports"))).toBe(false);
  }, 60_000);

  it("refuses a block past 65535 in the config", () => {
    c = withPorts("ports: { from: 65530, size: 10 },");

    const r = spawnSync("./scripts/slice-session.sh", ["40"], {
      cwd: c.main,
      encoding: "utf8",
    });

    expect(r.status).not.toBe(0);
    expect(`${r.stdout}${r.stderr}`).toContain("ports must be { from, size? }");
  }, 60_000);
});
