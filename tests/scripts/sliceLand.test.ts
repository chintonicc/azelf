import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Consumer, git, makeConsumer, sh } from "./fixture";

/**
 * slice-done.sh and slice-land.sh, end to end against a real repo with a bare
 * origin: the ticket close comment must carry the commit the slice declared
 * done at AND the commit it landed as, because the two differ whenever the
 * branch was rebased in between — and that is the normal case.
 */
describe("slice-done.sh → slice-land.sh", () => {
  let c: Consumer;
  beforeEach(() => {
    c = makeConsumer({ worktrees: [40], remote: true });
  });
  afterEach(() => rmSync(c.root, { recursive: true, force: true }));

  it("records the declared and the landed SHA on the ticket", () => {
    const wt = c.wt(40);
    writeFileSync(join(wt, "a.txt"), "a\n");
    git(wt, "add", "a.txt");
    git(wt, "commit", "-qm", "feat: a");
    const declared = git(wt, "rev-parse", "HEAD");

    const done = sh(wt, "./scripts/slice-done.sh");
    expect(done).toContain("marked done (1 commit(s) to land)");
    const marker = readFileSync(join(wt, ".slice-ready-to-land"), "utf8");
    expect(marker.split("\n")[1]).toBe(declared);

    // Base moves, and the branch is rebased onto it — what the dispatcher does
    // before every land. The declared commit is rewritten by this.
    writeFileSync(join(c.main, "b.txt"), "b\n");
    git(c.main, "add", "b.txt");
    git(c.main, "commit", "-qm", "feat: b");
    git(c.main, "push", "-q", "origin", "main");
    git(wt, "rebase", "-q", "main");
    expect(git(wt, "rev-parse", "HEAD")).not.toBe(declared);

    const land = sh(c.main, "./scripts/slice-land.sh 40");
    const landed = git(c.main, "rev-parse", "HEAD");
    const short = (sha: string) => sha.slice(0, 7);

    const line = `declared done at ${short(
      declared,
    )}, landed on main as ${short(landed)} (1 commit(s))`;
    expect(land).toContain(`✓ ${line}`);
    expect(land).toContain("✓ closed #40");
    expect(readFileSync(c.closeFile, "utf8")).toContain(`40\n`);
    expect(readFileSync(c.closeFile, "utf8")).toContain(line);

    // The recorded landed SHA is the one a later ancestry check says yes to;
    // the declared one is not, which is the whole reason both are recorded.
    expect(() =>
      git(c.main, "merge-base", "--is-ancestor", landed, "main"),
    ).not.toThrow();
    expect(() =>
      git(c.main, "merge-base", "--is-ancestor", declared, "main"),
    ).toThrow();
  });

  it("still lands, and says so, when nobody declared done", () => {
    const wt = c.wt(40);
    writeFileSync(join(wt, "a.txt"), "a\n");
    git(wt, "add", "a.txt");
    git(wt, "commit", "-qm", "feat: a");
    const head = git(wt, "rev-parse", "HEAD");

    const land = sh(c.main, "./scripts/slice-land.sh 40");
    expect(land).toContain(
      `✓ landed on main as ${head.slice(0, 7)} (1 commit(s))`,
    );
    expect(land).not.toContain("declared done at");
  });
});
