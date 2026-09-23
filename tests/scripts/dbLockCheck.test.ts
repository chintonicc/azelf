import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Consumer, makeConsumer, sh } from "./fixture";

/**
 * `db_lock_holder`, driven the way its callers drive it: sourced into bash
 * inside a real consumer checkout, with real linked worktrees.
 */
const LOCK_PATH = "supabase/migrations";

/** The holder text, or "" when free — exactly what `holder=$(…) || true` yields. */
const holder = (cwd: string, exclude: string): string =>
  sh(
    cwd,
    `source scripts/db-lock-check.sh; db_lock_holder ${JSON.stringify(
      exclude,
    )} || true`,
  ).trim();

describe("db_lock_holder, across real worktrees", () => {
  let c: Consumer;
  const dirty = (n: number) =>
    writeFileSync(join(c.wt(n), LOCK_PATH, `00${n}_x.sql`), "-- sql\n");

  beforeEach(() => {
    c = makeConsumer({ lockPaths: [LOCK_PATH], worktrees: [40, 44] });
  });
  afterEach(() => rmSync(c.root, { recursive: true, force: true }));

  it("is free while nobody touches an exclusive path", () => {
    expect(holder(c.wt(40), "ticket/40")).toBe("");
  });

  it("names the one other worktree that does, and nothing more", () => {
    dirty(44);
    const out = holder(c.wt(40), "ticket/40");
    expect(out).toBe(`${c.wt(44)} (ticket/44, dirty)`);
  });

  /**
   * The case that stranded two slices: each side saw the other as holder and
   * was told to wait for it. The text must now say that waiting cannot work.
   */
  it("diagnoses the mutual case when the caller is dirty too", () => {
    dirty(40);
    dirty(44);
    const out = holder(c.wt(40), "ticket/40");
    expect(out).toContain(`${c.wt(44)} (ticket/44, dirty)`);
    expect(out).toContain("and this worktree — ticket/40 — is dirty");
    expect(out).toContain("2 worktrees hold uncommitted changes");
    expect(out).toContain("does NOT clear by waiting");
    expect(out).toContain(`git stash push -- ${LOCK_PATH}`);
  });

  /** The dispatcher excludes nobody; it should still see that two are stuck. */
  it("diagnoses the mutual case from outside, listing every holder", () => {
    dirty(40);
    dirty(44);
    const out = holder(c.main, "");
    expect(out).toContain(`${c.wt(40)} (ticket/40, dirty)`);
    expect(out).toContain(`${c.wt(44)} (ticket/44, dirty)`);
    expect(out).toContain("2 worktrees hold uncommitted changes");
  });

  it("does not raise the alarm for a single holder seen from outside", () => {
    dirty(44);
    expect(holder(c.main, "")).not.toContain("⚠️");
  });

  /**
   * Fails closed, and the failure wins over the diagnosis: a worktree whose
   * directory is gone cannot be scanned, so nothing about the scan is trusted.
   */
  it("reports an unverifiable worktree instead of diagnosing anything", () => {
    dirty(40);
    dirty(44);
    rmSync(c.wt(44), { recursive: true, force: true });
    const out = holder(c.wt(40), "ticket/40");
    expect(out).toContain("UNVERIFIABLE");
    expect(out).not.toContain("⚠️");
  });
});
