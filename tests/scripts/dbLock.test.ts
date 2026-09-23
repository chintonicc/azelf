import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Consumer, git, makeConsumer, sh, shResult } from "./fixture";

/**
 * db-lock.sh — the claim — end to end in a real consumer checkout with two
 * linked worktrees. The contract under test is the one docs/db-lock-plan.md
 * states: exactly one claimer wins, the owner's re-claim is a no-op, nobody
 * but the owner (or a land from the main checkout) releases, `transfer` is the
 * operator's and only the operator's, and anything the lock cannot vouch for
 * is UNVERIFIABLE rather than taken over.
 */
const LOCK_PATH = "supabase/migrations";

const lock = (cwd: string, args: string) =>
  shResult(cwd, `./scripts/db-lock.sh ${args}`);

describe("db-lock.sh", () => {
  let c: Consumer;
  const owner = () => readFileSync(join(c.lockDir, "owner"), "utf8");
  const log = () => readFileSync(c.lockLog, "utf8");
  const dirty = (n: number) =>
    writeFileSync(join(c.wt(n), LOCK_PATH, `00${n}_x.sql`), "-- sql\n");

  beforeEach(() => {
    c = makeConsumer({ lockPaths: [LOCK_PATH], worktrees: [40, 44] });
  });
  afterEach(() => rmSync(c.root, { recursive: true, force: true }));

  it("the first claim wins and the second is refused by name", () => {
    const first = lock(c.wt(40), "claim");
    expect(first.ok).toBe(true);
    expect(first.out).toContain("✓ DB lock claimed by ticket/40");
    expect(owner()).toContain("branch=ticket/40\n");
    expect(owner()).toContain("ticket=40\n");
    expect(owner()).toContain(`worktree=${c.wt(40)}\n`);
    expect(log()).toMatch(/\tclaim\tticket\/40\t/);

    const second = lock(c.wt(44), "claim");
    expect(second.ok).toBe(false);
    expect(second.out).toContain("DB lock refused for ticket/44");
    expect(second.out).toContain(
      `${c.wt(40)} (ticket/40, holds the DB lock since `,
    );
    expect(second.out).toContain("do not poll");
    expect(second.out).toContain('transfer 44 --reason "…"');
    // The marker the dispatcher parks on, holding the same text.
    const marker = readFileSync(join(c.wt(44), ".slice-lock-wait"), "utf8");
    expect(marker).toContain("(ticket/40, holds the DB lock since ");
    expect(existsSync(join(c.wt(40), ".slice-lock-wait"))).toBe(false);
  });

  /** mkdir is the claim, so a real race has exactly one winner. */
  it("a concurrent race has exactly one winner", () => {
    const out = sh(
      c.main,
      `
      (cd ${JSON.stringify(c.wt(40))} && ./scripts/db-lock.sh claim >/dev/null 2>&1; echo "40 $?") &
      (cd ${JSON.stringify(c.wt(44))} && ./scripts/db-lock.sh claim >/dev/null 2>&1; echo "44 $?") &
      wait
      `,
    );
    const wins = out
      .trim()
      .split("\n")
      .filter((l) => l.endsWith(" 0"));
    expect(wins).toHaveLength(1);
    const winner = wins[0]?.split(" ")[0];
    expect(owner()).toContain(`branch=ticket/${winner}\n`);
  });

  it("the owner's re-claim is a no-op, and logged once", () => {
    lock(c.wt(40), "claim");
    const again = lock(c.wt(40), "claim");
    expect(again.ok).toBe(true);
    expect(again.out).toContain("already held by this worktree (ticket/40)");
    expect(
      log()
        .split("\n")
        .filter((l) => l.includes("\tclaim\t")),
    ).toHaveLength(1);
  });

  it("release: refused for a non-owner, frees for the owner", () => {
    lock(c.wt(40), "claim");
    const other = lock(c.wt(44), "release");
    expect(other.ok).toBe(false);
    expect(other.out).toContain("held by ticket/40");
    expect(other.out).toContain("not by this worktree (ticket/44)");
    expect(existsSync(c.lockDir)).toBe(true);

    const mine = lock(c.wt(40), "release");
    expect(mine.ok).toBe(true);
    expect(mine.out).toContain("✓ DB lock released by ticket/40");
    expect(existsSync(c.lockDir)).toBe(false);
    expect(lock(c.main, "status").out).toContain("DB lock: free");
    expect(log()).toMatch(/\trelease\tticket\/40\tby-owner\t/);
  });

  it("release --landed: main checkout only, and only for the owner", () => {
    lock(c.wt(40), "claim");
    const fromSlice = lock(c.wt(44), "release --landed ticket/40");
    expect(fromSlice.ok).toBe(false);
    expect(fromSlice.out).toContain("runs from the main checkout on main");

    const wrongBranch = lock(c.main, "release --landed ticket/44");
    expect(wrongBranch.ok).toBe(false);
    expect(wrongBranch.out).toContain("held by ticket/40");
    expect(wrongBranch.out).toContain("not by ticket/44");

    const right = lock(c.main, "release --landed ticket/40");
    expect(right.ok).toBe(true);
    expect(right.out).toContain("✓ DB lock released — ticket/40 landed");
    expect(log()).toMatch(/\trelease\tticket\/40\tlanded\t/);

    // Idempotent for the caller slice-land.sh is: a free lock is not an error.
    const free = lock(c.main, "release --landed ticket/40");
    expect(free.ok).toBe(true);
    expect(free.out).toContain("nothing to release");
  });

  it("transfer: operator only, reason required, logged, and un-parks the target", () => {
    lock(c.wt(40), "claim");
    expect(lock(c.wt(44), "claim").ok).toBe(false);
    expect(existsSync(join(c.wt(44), ".slice-lock-wait"))).toBe(true);

    const fromSlice = lock(c.wt(44), 'transfer 44 --reason "me first"');
    expect(fromSlice.ok).toBe(false);
    expect(fromSlice.out).toContain("runs from the main checkout on main");

    const noReason = lock(c.main, "transfer 44");
    expect(noReason.ok).toBe(false);
    expect(noReason.out).toContain("--reason is required");
    expect(owner()).toContain("branch=ticket/40\n");

    const ok = lock(
      c.main,
      'transfer 44 --reason "44 is the smaller migration"',
    );
    expect(ok.ok).toBe(true);
    expect(ok.out).toContain(
      "✓ DB lock transferred from ticket/40 to ticket/44",
    );
    expect(owner()).toContain("branch=ticket/44\n");
    expect(owner()).toContain(`worktree=${c.wt(44)}\n`);
    expect(log()).toContain(
      '\ttransfer\tticket/40 -> ticket/44\treason="44 is the smaller migration"\t',
    );
    expect(existsSync(join(c.wt(44), ".slice-lock-wait"))).toBe(false);
    expect(lock(c.main, "status --porcelain").out).toMatch(
      /^held\tticket\/44\t/,
    );

    // The loser finds out at its next claim.
    const loser = lock(c.wt(40), "claim");
    expect(loser.ok).toBe(false);
    expect(loser.out).toContain("(ticket/44, holds the DB lock since ");

    // Transferring to the holder is a no-op; transferring a free lock is refused.
    expect(lock(c.main, 'transfer 44 --reason "again"').out).toContain(
      "already held by ticket/44",
    );
    lock(c.main, "release --landed ticket/44");
    const onFree = lock(c.main, 'transfer 40 --reason "x"');
    expect(onFree.ok).toBe(false);
    expect(onFree.out).toContain("DB lock is free — nothing to transfer");
  });

  /** A lock dir with no readable owner is never taken over, by anyone. */
  it("a lock dir without an owner file is UNVERIFIABLE for every subcommand", () => {
    mkdirSync(c.lockDir);
    const claim = lock(c.wt(40), "claim");
    expect(claim.ok).toBe(false);
    expect(claim.out).toContain("UNVERIFIABLE, treating as locked");
    expect(claim.out).toContain(`rm -r ${c.lockDir}`);
    expect(lock(c.main, "status").out).toContain("DB lock: UNVERIFIABLE");
    expect(lock(c.main, "status --porcelain").out.trim()).toBe("unverifiable");
    expect(lock(c.wt(40), "release").ok).toBe(false);
    expect(lock(c.main, "release --landed ticket/40").ok).toBe(false);
    expect(lock(c.main, 'transfer 40 --reason "x"').ok).toBe(false);
    expect(existsSync(c.lockDir)).toBe(true);
  });

  it("a claim whose branch is gone is STALE: reported, never auto-released", () => {
    lock(c.wt(40), "claim");
    git(c.main, "worktree", "remove", "--force", c.wt(40));
    git(c.main, "branch", "-D", "ticket/40");

    expect(lock(c.main, "status").out).toContain("STALE");
    expect(lock(c.main, "status --porcelain").out).toMatch(
      /^stale\tticket\/40\t/,
    );
    const claim = lock(c.wt(44), "claim");
    expect(claim.ok).toBe(false);
    expect(claim.out).toContain("branch ticket/40 no longer exists");
    expect(claim.out).toContain("release --landed ticket/40");
    expect(existsSync(c.lockDir)).toBe(true);

    // The documented way out, from the main checkout, works on a gone branch.
    expect(lock(c.main, "release --landed ticket/40").ok).toBe(true);
    expect(lock(c.wt(44), "claim").ok).toBe(true);
  });

  /** The backstop: an unclaimed migration elsewhere blocks a claim … */
  it("refuses a claim while another worktree is dirty with no claim", () => {
    dirty(44);
    const claim = lock(c.wt(40), "claim");
    expect(claim.ok).toBe(false);
    expect(claim.out).toContain(
      `${c.wt(
        44,
      )} (ticket/44, dirty under ${LOCK_PATH} with no claim — it skipped db-lock.sh claim)`,
    );
    expect(existsSync(c.lockDir)).toBe(false);
    // … but not the dirty worktree's own, late, claim: it is just late.
    const late = lock(c.wt(44), "claim");
    expect(late.ok).toBe(true);
    expect(late.out).toContain("✓ DB lock claimed by ticket/44");
  });

  /** … and never refuses the owner, who followed the rules. */
  it("warns the owner, rather than refusing it, when someone else skips the claim", () => {
    lock(c.wt(40), "claim");
    dirty(44);
    const again = lock(c.wt(40), "claim");
    expect(again.ok).toBe(true);
    expect(again.out).toContain("already held by this worktree (ticket/40)");
    expect(again.out).toContain("without the claim");
    expect(again.out).toContain("it skipped db-lock.sh claim");
  });

  it("is a no-op for every subcommand when no exclusive paths are configured", () => {
    rmSync(c.root, { recursive: true, force: true });
    c = makeConsumer({ lockPaths: [], worktrees: [40] });
    for (const args of [
      "claim",
      "release",
      "status",
      'transfer 40 --reason "x"',
    ]) {
      const r = lock(c.wt(40), args);
      expect(r.ok).toBe(true);
      expect(r.out).toContain("(no-op)");
    }
    expect(existsSync(c.lockDir)).toBe(false);
  });
});
