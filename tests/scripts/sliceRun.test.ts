import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  type Consumer,
  type Dispatcher,
  git,
  makeConsumer,
  runDispatcher,
  sh,
  startDispatcher,
} from "./fixture";

/**
 * slice-run.ts end to end: a real dispatcher process against a throwaway
 * consumer, a fake tracker it reads from a file, and a fake resolver.
 */

let c: Consumer | undefined;
let d: Dispatcher | undefined;
afterEach(async () => {
  await d?.stop();
  d = undefined;
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
    writeFileSync(join(c.wt(40), ".slice-live"), "99999\n");

    d = startDispatcher(c, ["-y", "--interval", "1", "40"]);
    await d.until("[round 1] 1 running");
    sh(c.wt(40), "./scripts/slice-done.sh");
    await d.until("plan complete");

    expect(await d.exited).toBe(0);
    expect(git(c.main, "log", "-1", "--format=%s")).toBe("feat: a");
  });
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
  const conflicting = (resolver: string, files = ["a.txt"]) => {
    const fx = makeConsumer({
      worktrees: [40],
      remote: true,
      resolve: ["bash", "-c", resolver, "resolver"],
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
