import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Consumer, makeConsumer, sh } from "./fixture";

/**
 * `db_lock_holder`, driven the way its callers drive it: sourced into bash
 * inside a real consumer checkout, with real linked worktrees. The claim is
 * read first; the scan of worktrees is the backstop for when nobody holds it.
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

const SKIPPED = (wt: string, n: number) =>
  `${wt} (ticket/${n}, dirty under ${LOCK_PATH} with no claim — it skipped db-lock.sh claim)`;

describe("db_lock_holder, across real worktrees", () => {
  let c: Consumer;
  const dirty = (n: number) =>
    writeFileSync(join(c.wt(n), LOCK_PATH, `00${n}_x.sql`), "-- sql\n");
  const claim = (n: number) => sh(c.wt(n), "./scripts/db-lock.sh claim");

  beforeEach(() => {
    c = makeConsumer({ lockPaths: [LOCK_PATH], worktrees: [40, 44] });
  });
  afterEach(() => rmSync(c.root, { recursive: true, force: true }));

  it("is free while nobody claims or touches an exclusive path", () => {
    expect(holder(c.wt(40), "ticket/40")).toBe("");
  });

  // ─── the claim ───────────────────────────────────────────────────────────

  it("names the claim's owner, and consults nothing else", () => {
    claim(44);
    dirty(40); // the caller's own dirt is not a holder …
    expect(holder(c.wt(40), "ticket/40")).toMatch(
      new RegExp(
        `^${c.wt(
          44,
        )} \\(ticket/44, holds the DB lock since \\d{4}-\\d\\d-\\d\\dT[\\d:]+Z\\)$`,
      ),
    );
    // … and the owner being dirty too changes nothing: the claim is the answer.
    dirty(44);
    expect(holder(c.wt(40), "ticket/40").split("\n")).toHaveLength(1);
  });

  it("is free for the owner, who is exempt from its own claim", () => {
    claim(40);
    dirty(40);
    expect(holder(c.wt(40), "ticket/40")).toBe("");
  });

  it("tells the owner who skipped the claim, and not to wait for them", () => {
    claim(40);
    dirty(44);
    const out = holder(c.wt(40), "ticket/40");
    expect(out).toContain(SKIPPED(c.wt(44), 44));
    expect(out).toContain(
      "this worktree — ticket/40 — holds the claim; they must stash or wait, not you",
    );
    expect(out).not.toContain("⚠️");
  });

  it("flags a stale claim whose branch is gone, without releasing it", () => {
    claim(44);
    sh(c.main, `git worktree remove --force ${JSON.stringify(c.wt(44))}`);
    sh(c.main, "git branch -D ticket/44");
    const out = holder(c.wt(40), "ticket/40");
    expect(out).toContain("(ticket/44, holds the DB lock since ");
    expect(out).toContain(
      "branch ticket/44 no longer exists, so this claim is STALE",
    );
    expect(out).toContain("release --landed ticket/44");
  });

  it("treats a lock dir without an owner file as held, and says why", () => {
    mkdirSync(c.lockDir);
    const out = holder(c.wt(40), "ticket/40");
    expect(out).toContain("UNVERIFIABLE, treating as locked");
    expect(out).toContain(`rm -r ${c.lockDir}`);
  });

  // ─── the scan, when nobody claims ────────────────────────────────────────

  it("names the one worktree that skipped the claim, and nothing more", () => {
    dirty(44);
    expect(holder(c.wt(40), "ticket/40")).toBe(SKIPPED(c.wt(44), 44));
  });

  /**
   * The case that stranded two slices: each side saw the other as holder and
   * was told to wait for it. The text must say that waiting cannot work, and
   * now ends in the claim.
   */
  it("diagnoses the mutual case when the caller is dirty too", () => {
    dirty(40);
    dirty(44);
    const out = holder(c.wt(40), "ticket/40");
    expect(out).toContain(SKIPPED(c.wt(44), 44));
    expect(out).toContain(
      "and this worktree — ticket/40 — is dirty there too, with no claim",
    );
    expect(out).toContain("2 worktrees hold uncommitted changes");
    expect(out).toContain("does NOT clear by waiting");
    expect(out).toContain(`git stash push -- ${LOCK_PATH}`);
    expect(out).toContain("./scripts/db-lock.sh claim");
  });

  /** The dispatcher excludes nobody; it should still see that two are stuck. */
  it("diagnoses the mutual case from outside, listing every holder", () => {
    dirty(40);
    dirty(44);
    const out = holder(c.main, "");
    expect(out).toContain(SKIPPED(c.wt(40), 40));
    expect(out).toContain(SKIPPED(c.wt(44), 44));
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
