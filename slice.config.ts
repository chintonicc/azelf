/**
 * azelf's own slice config — the package is its own first consumer.
 *
 * This file exists to keep the seams honest. Every one of them (gates, tracker,
 * launcher, the shell bridge) was built in consumer-a against consumer-a's shapes, and
 * a seam that has only ever been used by the project it was extracted from has
 * not been tested, only described. The second consumer is the test, and doing
 * the Phase 5 tickets through this config is the cheapest way to have one.
 *
 * It also means the thing dispatching a change to the dispatcher is the version
 * on `main`, not the version in the slice — which is the only arrangement in
 * which self-modifying tooling is safe to run at all.
 */

import {
  type SliceConfig,
  exitCode,
  exitCodeOverFiles,
  github,
  warp,
} from "@chintonicc/azelf";

export default {
  tracker: github(),

  /**
   * Warp, because this is the machine the hook is installed on. If you are
   * reading this on another machine and it is not Warp, the launcher says so
   * and the dispatcher falls back to printing commands rather than failing —
   * `problem()` exists precisely so a wrong launcher is a message, not a crash.
   */
  launcher: warp(),

  baseBranch: "main",
  branchPattern: "ticket/{n}",
  worktreeDir: "../{repo}-ticket-{n}",
  readyLabel: "ready-for-agent",

  /**
   * Empty, and worth stating rather than leaving to inference: this repo has no
   * shared mutable resource. A single live database with no point-in-time
   * recovery is what the lock was built for — consumer-a has one — and that is
   * the exception, not the pattern.
   */
  exclusiveLockPaths: [],

  /**
   * Empty for the same kind of reason. Nothing gitignored is load-bearing here —
   * no .env, and no generated type declaration a worktree would miss. A slice
   * worktree gets everything it needs from `bun install`.
   */
  provisionCopy: [],

  /**
   * Three gates, all read-only.
   *
   * tsc is a plain exit code here, NOT the baseline diff consumer-a needs. That gate
   * exists because consumer-a carries 9 pre-existing errors, so "did tsc pass" is
   * meaningless there and only the multiset difference means anything. This repo
   * starts at zero and should stay there; the day it does not, the honest fix is
   * to get back to zero, not to install a baseline.
   */
  gates: [
    exitCode(["bun", "run", "test"], { hint: "the unit suite is red" }),
    exitCode(["bunx", "tsc", "--noEmit"], {
      hint: "typecheck errors — this repo's baseline is zero",
    }),
    exitCodeOverFiles(["bunx", "biome", "check", "--no-errors-on-unmatched"], {
      hint: "run ./scripts/format.sh in the slice",
    }),
  ],

  /**
   * Names the `slice` skill rather than issuing a lone slash command: it reads
   * correctly whether or not the first message is parsed as a command, and it
   * points at `.slice-ticket.md`, which the session cannot fetch for itself.
   * The skill is shipped by this package and installed by `azelf init`, which
   * is what replaced the dependency on a third-party implement command.
   *
   * `slice-session.sh` appends the self-land instruction under `--self-land`;
   * that half is tool mechanics, not project preference, so it stays in the
   * script.
   */
  startPrompt:
    "Read .slice-ticket.md in this worktree — it is your ticket, #{n}. Follow the `slice` skill: build it, commit with explicit paths, run the gates, and run ./scripts/slice-done.sh only if they are green.",
} satisfies SliceConfig;
