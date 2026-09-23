import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type Owner,
  acquire,
  processStart,
  readOwner,
  release,
} from "@/scripts/slice-lock";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AZELF, startScript } from "./fixture";

/**
 * The land lock and the gate lock share this. The contention tests use real
 * processes through the command line slice-land.sh calls, because what is
 * under test is exactly what happens between two of them.
 */

const LOCK_CLI = join(AZELF, "scripts", "slice-lock.ts");

let root: string;
let dir: string;
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "azelf-lock-")));
  dir = join(root, "azelf-test.lock");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

/** A pid nothing is running under any more. */
const deadPid = (): number => {
  const r = spawnSync("bash", ["-c", "echo $$"], { encoding: "utf8" });
  return Number(r.stdout.trim());
};

const plant = (o: Partial<Owner> & { pid: number }) => {
  mkdirSync(dir);
  writeFileSync(
    join(dir, "owner"),
    `pid=${o.pid}\nstarted=${o.started ?? ""}\nlabel=${
      o.label ?? "ticket/99"
    }\nsince=${o.since ?? "2026-09-23T10:00:00.000Z"}\n`,
  );
};

/**
 * A process that takes the lock through the command line, prints `taken`,
 * holds it until `go` exists, and releases it.
 */
const holder = (label: string, go: string) =>
  startScript(
    root,
    `bun ${LOCK_CLI} acquire ${dir} --pid $$ --label ${label} --what land
echo taken
while [ ! -f ${go} ]; do sleep 0.1; done
bun ${LOCK_CLI} release ${dir} --pid $$`,
  );

describe("slice-lock", () => {
  it("makes a second process wait, naming the first, then lets it through", async () => {
    const go = join(root, "go");
    const a = holder("ticket/40", go);
    try {
      await a.until("taken");
      const b = holder("ticket/41", join(root, "go-b"));
      try {
        await b.until(
          new RegExp(`waiting for ticket/40's land \\(pid ${a.pid}, since `),
        );
        expect(b.output()).not.toContain("taken");
        expect(readOwner(dir)?.label).toBe("ticket/40");

        writeFileSync(go, "");
        await b.until("taken");
        expect(await a.exited).toBe(0);
        expect(readOwner(dir)).toMatchObject({
          label: "ticket/41",
          pid: b.pid,
        });
        // Printed once, not once per poll.
        expect(b.output().match(/waiting for/g)).toHaveLength(1);

        writeFileSync(join(root, "go-b"), "");
        expect(await b.exited).toBe(0);
      } finally {
        await b.stop();
      }
    } finally {
      writeFileSync(go, "");
      await a.stop();
    }
    expect(existsSync(dir)).toBe(false);
    // Nothing left beside it: no private dirs, nothing moved aside.
    expect(readdirSync(root).filter((f) => f.startsWith("azelf-"))).toEqual([]);
  }, 30_000);

  it("takes over from a holder that is no longer running, and says so", () => {
    const pid = deadPid();
    plant({ pid });
    const gone: (Owner | null)[] = [];
    const r = acquire(dir, {
      pid: process.pid,
      label: "#40",
      onTakeover: (h) => gone.push(h),
    });
    expect(r).toEqual({ ok: true });
    expect(gone).toHaveLength(1);
    expect(gone[0]).toMatchObject({ pid, label: "ticket/99" });
    expect(readOwner(dir)).toMatchObject({ pid: process.pid, label: "#40" });
  });

  it("takes over from a pid that is running but was started after the lock was taken — a reused pid", () => {
    plant({ pid: process.pid, started: "Mon Jan  1 00:00:00 2001" });
    const gone: (Owner | null)[] = [];
    const r = acquire(dir, {
      pid: process.pid,
      label: "#40",
      onTakeover: (h) => gone.push(h),
    });
    expect(r.ok).toBe(true);
    expect(gone).toHaveLength(1);
  });

  it("takes over a lock with no owner file", () => {
    mkdirSync(dir);
    const r = acquire(dir, { pid: process.pid, label: "#40" });
    expect(r.ok).toBe(true);
    expect(readOwner(dir)?.label).toBe("#40");
  });

  it("does not take over from a live holder, and gives up at the deadline", () => {
    plant({
      pid: process.pid,
      started: processStart(process.pid) ?? "",
      label: "#31",
    });
    const waited: (Owner | null)[] = [];
    const t0 = Date.now();
    const r = acquire(dir, {
      pid: process.pid,
      label: "#40",
      waitMs: 300,
      pollMs: 50,
      onWait: (h) => waited.push(h),
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.holder?.label).toBe("#31");
    expect(Date.now() - t0).toBeGreaterThanOrEqual(280);
    expect(waited).toHaveLength(1);
    expect(readOwner(dir)?.label).toBe("#31");
  });

  it("says who it gave up on, from the command line, and exits 1", () => {
    // The first holder is the bash itself, alive while the second waits.
    const r = spawnSync(
      "bash",
      [
        "-c",
        `bun ${LOCK_CLI} acquire ${dir} --pid $$ --label ticket/40 --what land
         bun ${LOCK_CLI} acquire ${dir} --pid $PPID --label ticket/41 --what land --wait 1`,
      ],
      { encoding: "utf8" },
    );
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/waiting for ticket\/40's land \(pid \d+/);
    expect(r.stderr).toMatch(
      /error: gave up after 1s waiting for ticket\/40's land/,
    );
  });

  it("is released only by its holder", () => {
    expect(acquire(dir, { pid: process.pid, label: "#40" }).ok).toBe(true);
    expect(release(dir, process.pid + 1)).toBe(false);
    expect(existsSync(dir)).toBe(true);
    expect(release(dir, process.pid)).toBe(true);
    expect(existsSync(dir)).toBe(false);
    // Releasing a lock nobody holds is not an error.
    expect(release(dir, process.pid)).toBe(false);
  });

  it("reads no lock as undefined and a broken one as null", () => {
    expect(readOwner(dir)).toBeUndefined();
    mkdirSync(dir);
    expect(readOwner(dir)).toBeNull();
    writeFileSync(join(dir, "owner"), "pid=nope\n");
    expect(readOwner(dir)).toBeNull();
  });
});
