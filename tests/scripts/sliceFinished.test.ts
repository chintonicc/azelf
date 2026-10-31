import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type Consumer, git, makeConsumer, sh, shResult } from "./fixture";

/**
 * slice-finished.sh: a session says its turn is over, with its report, and
 * lands nothing. The marker is the head it was said at, the kind, a blank
 * line, the report — what slice-run.ts reads as "waiting for you".
 */

let c: Consumer | undefined;
afterEach(() => {
  if (c) rmSync(c.root, { recursive: true, force: true });
  c = undefined;
});

const commitIn = (cwd: string, file: string, text: string, msg: string) => {
  writeFileSync(join(cwd, file), text);
  git(cwd, "add", file);
  git(cwd, "commit", "-qm", msg);
};

const ready = () => {
  const fx = makeConsumer({ worktrees: [40] });
  commitIn(fx.wt(40), "a.txt", "a\n", "feat: a");
  return fx;
};

describe("slice-finished.sh", () => {
  it("writes the head, the kind and the report, and lands nothing", () => {
    c = ready();

    const out = sh(c.wt(40), "./scripts/slice-finished.sh -m 'Built a.txt.'");

    expect(out).toContain("✓ #40 finished at ");
    expect(out).toContain("waiting for a person. End your turn.");
    expect(out).toContain("./scripts/slice-done.sh here is what lands it");
    expect(readFileSync(join(c.wt(40), ".slice-finished"), "utf8")).toBe(
      `${git(c.wt(40), "rev-parse", "HEAD")}\nfinished\n\nBuilt a.txt.\n`,
    );
    expect(existsSync(join(c.wt(40), ".slice-ready-to-land"))).toBe(false);
  });

  it("reads the report from stdin with -F -, and from a file", () => {
    c = ready();

    sh(
      c.wt(40),
      "./scripts/slice-finished.sh -F - <<'EOF'\n# Done\n\n- a.txt, line 1\nEOF\n",
    );
    expect(readFileSync(join(c.wt(40), ".slice-finished"), "utf8")).toContain(
      "\nfinished\n\n# Done\n\n- a.txt, line 1\n",
    );

    writeFileSync(join(c.root, "report.md"), "From a file.\n");
    sh(c.wt(40), `./scripts/slice-finished.sh -F ${join(c.root, "report.md")}`);
    expect(readFileSync(join(c.wt(40), ".slice-finished"), "utf8")).toContain(
      "\n\nFrom a file.\n",
    );
  });

  it("refuses an empty report, two reports, and a dirty tree unless --stuck", () => {
    c = ready();

    const empty = shResult(c.wt(40), "./scripts/slice-finished.sh -m '  '");
    expect(empty.code).toBe(64);
    expect(empty.out).toContain("the report is empty");

    const two = shResult(c.wt(40), "./scripts/slice-finished.sh -m a -F b");
    expect(two.code).toBe(64);
    expect(two.out).toContain("-m and -F are two reports");

    writeFileSync(join(c.wt(40), "b.txt"), "b\n");
    const dirty = shResult(c.wt(40), "./scripts/slice-finished.sh -m 'done'");
    expect(dirty.code).toBe(1);
    expect(dirty.out).toContain("uncommitted changes");
    expect(dirty.out).toContain("?? b.txt");
    expect(existsSync(join(c.wt(40), ".slice-finished"))).toBe(false);

    const stuck = sh(
      c.wt(40),
      "./scripts/slice-finished.sh --stuck -m 'gates red: b is half done'",
    );
    expect(stuck).toContain("✓ #40 stuck at ");
    expect(stuck).toContain("waits for a person. End your turn.");
    expect(readFileSync(join(c.wt(40), ".slice-finished"), "utf8")).toContain(
      "\nstuck\n\ngates red: b is half done\n",
    );
  });

  it("is removed by slice-done.sh, which is the act that lands", () => {
    c = ready();
    sh(c.wt(40), "./scripts/slice-finished.sh -m 'done'");

    sh(c.wt(40), "./scripts/slice-done.sh");

    expect(existsSync(join(c.wt(40), ".slice-finished"))).toBe(false);
    expect(existsSync(join(c.wt(40), ".slice-ready-to-land"))).toBe(true);
  });

  it("refuses outside a slice branch", () => {
    c = makeConsumer({});

    const r = shResult(c.main, "./scripts/slice-finished.sh -m x");

    expect(r.code).toBe(1);
    expect(r.out).toContain("is not a slice branch");
    expect(existsSync(join(c.main, ".slice-finished"))).toBe(false);
  });
});
