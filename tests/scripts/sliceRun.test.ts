import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  AZELF,
  type Consumer,
  type Dispatcher,
  git,
  makeConsumer,
  runDispatcher,
  sh,
  startDispatcher,
  startScript,
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

/**
 * A parked slice retries when what it failed on changes, not only when its
 * branch moves. Ticket 41 holds a live session throughout, so the run keeps
 * polling instead of stopping on "every open slice is parked".
 */
describe("a parked slice", () => {
  const parkedRun = (
    opts: Parameters<typeof makeConsumer>[0],
    args: string[] = [],
  ) => {
    const fx = makeConsumer({ worktrees: [40, 41], remote: true, ...opts });
    commitIn(fx.wt(40), "a.txt", "a\n", "feat: a");
    sh(fx.wt(40), "./scripts/slice-done.sh");
    writeFileSync(join(fx.wt(41), ".slice-live"), "99999\n");
    c = fx;
    d = startDispatcher(fx, [...args, "-y", "--interval", "1", "40", "41"]);
    return { c: fx, d };
  };

  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  /** `text` at least `n` times, then at least `rounds` more round lines. */
  const seen = (text: string, n: number, rounds = 0) =>
    new RegExp(
      `(${esc(text)}[\\s\\S]*){${n}}${"\\[round \\d+\\][\\s\\S]*".repeat(
        rounds,
      )}`,
    );
  const count = (out: string, text: string) => out.split(text).length - 1;

  const RED = "✗ #40 did not land — the gates are red";
  /** 41 still running, 40 gone: the round line once 40 has landed. */
  const LANDED = "1 running · 0 blocked · 1 open —";

  it("retries red gates when main moves, with nothing committed to the branch", async () => {
    const { c, d } = parkedRun({ gate: ["test", "-f", "fixed.txt"] });
    await d.until(
      "parked (non-interactive) — retried when its branch moves, when main moves, or now with: azelf retry 40",
    );

    commitIn(c.main, "fixed.txt", "fixed\n", "fix: fixed.txt");
    await d.until(
      "main moved since #40 was parked — retrying (automatic retry 1 of 2).",
    );
    await d.until(LANDED);

    expect(git(c.main, "log", "--format=%s", "-3")).toBe(
      "feat: a\nfix: fixed.txt\ninit",
    );
    expect(readFileSync(c.closeFile, "utf8")).toContain("40\n");
  }, 60_000);

  it("retries a land that lost the fast-forward race", () => {
    // The gate stands in for another dispatcher: the first time it runs, it
    // lands a commit on main, after this slice was rebased and before it lands.
    c = makeConsumer({
      worktrees: [40],
      remote: true,
      gate: [
        "bash",
        "-c",
        "[ -e ../raced ] || { touch ../raced && git -C ../repo commit -q --allow-empty -m 'race: another land'; }",
      ],
    });
    commitIn(c.wt(40), "a.txt", "a\n", "feat: a");
    sh(c.wt(40), "./scripts/slice-done.sh");

    const r = runDispatcher(c, ["-y", "--interval", "1", "40"]);

    expect(r.out).toContain("it has diverged");
    expect(r.out).toContain(
      "parked (non-interactive) — retried when its branch moves, when main moves, or now with: azelf retry 40",
    );
    expect(r.out).toContain(
      "main moved since #40 was parked — retrying (automatic retry 1 of 2).",
    );
    expect(r.code).toBe(0);
    expect(git(c.main, "log", "--format=%s", "-3")).toBe(
      "feat: a\nrace: another land\ninit",
    );
  });

  it("retries a BLOCK when the ticket is edited, and not before", async () => {
    // Blocks until the ticket body says FIXED. It runs in the worktree, so
    // ../reviews is next to it, under the consumer's root.
    const review = `echo call >> ../reviews
case "$1" in *FIXED*) echo "VERDICT: PASS" ;; *) echo "VERDICT: BLOCK" ;; esac`;
    const { c, d } = parkedRun(
      { review: ["bash", "-c", review, "reviewer"], body: "build a" },
      ["--auto"],
    );
    await d.until(
      "parked (non-interactive) — retried when its branch moves, when the ticket is edited, or now with: azelf retry 40",
    );
    await d.until(seen("parked (non-interactive)", 1, 3));
    // Spec and standards, once each: an unchanged ticket is not reviewed again.
    const reviews = () =>
      readFileSync(join(c.root, "reviews"), "utf8").trim().split("\n").length;
    expect(reviews()).toBe(2);

    c.setTicket("40", { body: "build a — FIXED" });
    await d.until("#40: the ticket was edited since the BLOCK — retrying.");
    await d.until(LANDED);

    expect(reviews()).toBe(4);
    expect(git(c.main, "log", "-1", "--format=%s")).toBe("feat: a");
  }, 60_000);

  it("does not stop the run while a parked slice is due a retry", () => {
    // No session holds the run open here: 42's land is what moves main, in
    // the same round that leaves every open slice parked.
    c = makeConsumer({
      worktrees: [40, 42],
      remote: true,
      gate: ["test", "-f", "fixed.txt"],
    });
    commitIn(c.wt(40), "a.txt", "a\n", "feat: a");
    sh(c.wt(40), "./scripts/slice-done.sh");
    commitIn(c.wt(42), "fixed.txt", "fixed\n", "fix: fixed.txt");
    sh(c.wt(42), "./scripts/slice-done.sh");

    const r = runDispatcher(c, ["-y", "--interval", "1", "40", "42"]);

    expect(r.out).toContain(RED);
    expect(r.out).toContain(
      "main moved since #40 was parked — retrying (automatic retry 1 of 2).",
    );
    expect(r.out).not.toContain("nothing can advance");
    expect(r.out).toContain("plan complete");
    expect(r.code).toBe(0);
  });

  it("retries on azelf retry, and consumes the request", async () => {
    // Passes once ../ok exists next to the worktree, outside any repo.
    const { c, d } = parkedRun({ gate: ["test", "-f", "../ok"] });
    await d.until(RED);

    const r = azelfRetry(c, "40");
    expect(r.out).toContain(
      "the running dispatcher retries #40 next round; if none is running, `azelf run --auto 40` does",
    );
    expect(r.code).toBe(0);
    await d.until("#40: retry requested — retrying the land.");
    // Consumed: parked again, and three round lines later no third attempt.
    await d.until(seen(RED, 2, 3));
    expect(count(d.output(), RED)).toBe(2);
    expect(existsSync(join(c.wt(40), ".slice-retry"))).toBe(false);

    writeFileSync(join(c.root, "ok"), "");
    azelfRetry(c, "40");
    await d.until(LANDED);
    expect(git(c.main, "log", "-1", "--format=%s")).toBe("feat: a");
  }, 60_000);

  it("stops counting a ticket closed outside the run", async () => {
    const { c, d } = parkedRun({ gate: ["false"] });
    await d.until("· 1 parked");

    c.setTicket("40", { state: "closed" });
    await d.until("#40 was closed outside this run — no longer parked");
    await d.until(LANDED);
    c.setTicket("41", { state: "closed" });
    await d.until("plan complete");

    expect(await d.exited).toBe(0);
    expect(d.output()).not.toContain("── parked");
  }, 60_000);

  it("retries red gates twice as main moves, then stays parked", async () => {
    const { c, d } = parkedRun({ gate: ["false"] });
    await d.until(RED);

    commitIn(c.main, "m1.txt", "1\n", "main: 1");
    await d.until("retrying (automatic retry 1 of 2)");
    await d.until(seen(RED, 2));
    commitIn(c.main, "m2.txt", "2\n", "main: 2");
    await d.until("retrying (automatic retry 2 of 2)");
    await d.until(
      "parked (non-interactive) — retried when its branch moves, or now with: azelf retry 40",
    );
    commitIn(c.main, "m3.txt", "3\n", "main: 3");
    await d.until(seen("staying parked", 1, 3));

    expect(d.output()).toContain(
      "main moved, and #40 has had its 2 automatic retries at this branch head — staying parked.",
    );
    expect(count(d.output(), RED)).toBe(3);
    expect(count(d.output(), "staying parked")).toBe(1);
  }, 60_000);
});

/** `azelf retry <id>` through the real CLI, from the consumer's main checkout. */
const azelfRetry = (fx: Consumer, id: string) => {
  const r = spawnSync("bun", [join(AZELF, "bin", "azelf.ts"), "retry", id], {
    cwd: fx.main,
    encoding: "utf8",
    env: { ...process.env, SLICE_REPO_ROOT: fx.main },
  });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
};

describe("azelf retry", () => {
  it("refuses a ticket with no worktree", () => {
    c = makeConsumer({});
    const r = azelfRetry(c, "99");
    expect(r.out).toContain("#99: no worktree at");
    expect(r.code).toBe(1);
  });
});

/**
 * Two dispatchers on one repo: each gates one slice at a time already, and
 * the gate lock stops the second one's gates running on top of the first's.
 */
describe("the gate lock", () => {
  it("waits for another run's gates, naming them, then runs its own", async () => {
    c = makeConsumer({ worktrees: [40], gate: ["true"] });
    commitIn(c.wt(40), "a.txt", "a\n", "feat: a");
    const lock = join(c.main, ".git", "azelf-gates.lock");
    const go = join(c.root, "go");
    // Another dispatcher, as far as the lock can tell: a live process that
    // holds it for #31 until the test says go.
    const other = startScript(
      c.main,
      `bun ${join(AZELF, "scripts", "slice-lock.ts")} acquire ${lock} --pid $$ --label '#31'
echo held
while [ ! -f ${go} ]; do sleep 0.1; done
bun ${join(AZELF, "scripts", "slice-lock.ts")} release ${lock} --pid $$`,
    );
    try {
      await other.until("held");
      d = startDispatcher(c, ["--gates", "40"]);
      await d.until(
        `waiting for #31's gates (another dispatcher, pid ${other.pid})`,
      );
      expect(d.output()).not.toContain("passes every gate");

      writeFileSync(go, "");
      expect(await d.exited).toBe(0);
      expect(d.output()).toContain("✓ #40 passes every gate");
      expect(existsSync(lock)).toBe(false);
    } finally {
      writeFileSync(go, "");
      await other.stop();
    }
  }, 60_000);
});

/**
 * A gate with `retries` that fails once and then passes lands the slice,
 * warns on the spot, and is named again when the run ends.
 */
describe("a gate that passes on a retry", () => {
  // Fails the first time it runs in this consumer, passes after. The flag
  // file is outside the worktree, which a gate must not write to.
  const FLAKY = [
    "bash",
    "-c",
    "[ -f ../flaked ] || { touch ../flaked; exit 1; }",
  ];

  it("lands, and the end of the run lists it", () => {
    c = makeConsumer({
      worktrees: [40],
      remote: true,
      agent: ["true"],
      gate: FLAKY,
      gateRetries: 1,
    });
    commitIn(c.wt(40), "a.txt", "a\n", "feat: a");
    sh(c.wt(40), "./scripts/slice-done.sh");

    const r = runDispatcher(c, ["--auto", "--once", "-y", "--no-review", "40"]);

    expect(r.out).toContain(
      `⚠ \`${FLAKY.join(
        " ",
      )}\` failed, then passed on retry 1 — flaky under load`,
    );
    expect(r.out).toContain("landing #40");
    expect(r.code).toBe(0);
    expect(r.out).toContain("── landed on a retried gate (1)");
    expect(r.out).toContain(`#40  \`${FLAKY.join(" ")}\` passed on retry 1`);
  });

  it("parks it without the retry", () => {
    c = makeConsumer({
      worktrees: [40],
      remote: true,
      agent: ["true"],
      gate: FLAKY,
    });
    commitIn(c.wt(40), "a.txt", "a\n", "feat: a");
    sh(c.wt(40), "./scripts/slice-done.sh");

    const r = runDispatcher(c, ["--auto", "--once", "-y", "--no-review", "40"]);

    expect(r.out).toContain("the gates are red");
    expect(r.out).not.toContain("landing #40");
    expect(r.out).not.toContain("landed on a retried gate");
  });
});
