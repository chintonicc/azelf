import { findOverlaps, ignores } from "@/scripts/slice-overlap";
import type { TicketId } from "@/scripts/slice-tracker";
import { describe, expect, it } from "vitest";

/**
 * Pure set algebra — no git, no repository. What is asserted here is the
 * CONTRACT slice-run.ts relies on: overlaps are grouped by the slices that
 * share them rather than listed per file, and the whole result is totally
 * ordered, because the caller compares one round's result to the last to
 * decide whether it has anything new to say.
 */

const changed = (o: Record<string, string[]>): Map<TicketId, string[]> =>
  new Map(Object.entries(o));

describe("findOverlaps", () => {
  it("is empty when no two slices share a file", () => {
    expect(
      findOverlaps(changed({ "18": ["a.ts"], "19": ["b.ts", "c.ts"] })),
    ).toEqual([]);
  });

  it("is empty for a single slice, however many files it touches", () => {
    expect(findOverlaps(changed({ "18": ["a.ts", "b.ts"] }))).toEqual([]);
  });

  it("groups the shared files under the slices that share them", () => {
    expect(
      findOverlaps(
        changed({
          "18": ["a.ts", "b.ts", "only-18.ts"],
          "19": ["b.ts", "a.ts", "only-19.ts"],
        }),
      ),
    ).toEqual([{ tickets: ["18", "19"], files: ["a.ts", "b.ts"] }]);
  });

  it("reports a three-way overlap as one group, not three pairs", () => {
    expect(
      findOverlaps(
        changed({
          "18": ["shared.ts"],
          "19": ["shared.ts"],
          "20": ["shared.ts"],
        }),
      ),
    ).toEqual([{ tickets: ["18", "19", "20"], files: ["shared.ts"] }]);
  });

  it("keeps a pair and a triple over different files apart", () => {
    expect(
      findOverlaps(
        changed({
          "18": ["pair.ts", "triple.ts"],
          "19": ["pair.ts", "triple.ts"],
          "20": ["triple.ts"],
        }),
      ),
    ).toEqual([
      { tickets: ["18", "19"], files: ["pair.ts"] },
      { tickets: ["18", "19", "20"], files: ["triple.ts"] },
    ]);
  });

  it("does not overlap a slice with itself when a file is listed twice", () => {
    expect(findOverlaps(changed({ "18": ["a.ts", "a.ts"] }))).toEqual([]);
  });

  it("ignores a slice with no committed files", () => {
    expect(findOverlaps(changed({ "18": [], "19": ["a.ts"] }))).toEqual([]);
  });

  it("orders tickets numerically, not as strings", () => {
    const [only] = findOverlaps(changed({ "10": ["a.ts"], "9": ["a.ts"] }));
    expect(only?.tickets).toEqual(["9", "10"]);
  });

  it("gives the same answer whatever order the slices arrive in", () => {
    const forward = findOverlaps(
      changed({ "18": ["b.ts", "a.ts"], "19": ["a.ts"], "20": ["b.ts"] }),
    );
    const backward = findOverlaps(
      changed({ "20": ["b.ts"], "19": ["a.ts"], "18": ["a.ts", "b.ts"] }),
    );
    expect(forward).toEqual(backward);
    expect(forward).toEqual([
      { tickets: ["18", "19"], files: ["a.ts"] },
      { tickets: ["18", "20"], files: ["b.ts"] },
    ]);
  });
});

const ids = (...xs: string[]): Set<TicketId> => new Set(xs as TicketId[]);

/**
 * The `open` filter exists because a land is what MOVES the base branch, and
 * so is exactly when the open slice has to rebase over the landed files. The
 * report must keep saying so; what it must stop saying is anything about two
 * slices that have BOTH landed, which the base branch already reconciled.
 */
describe("findOverlaps — open slices", () => {
  const both = changed({ "18": ["a.ts"], "19": ["a.ts"] });

  it("keeps a group where one side has landed", () => {
    expect(findOverlaps(both, { open: ids("19") })).toEqual([
      { tickets: ["18", "19"], files: ["a.ts"] },
    ]);
  });

  it("drops a group where everyone has landed", () => {
    expect(findOverlaps(both, { open: ids() })).toEqual([]);
  });

  it("reports everything when the caller tracks no landings", () => {
    expect(findOverlaps(both)).toEqual([
      { tickets: ["18", "19"], files: ["a.ts"] },
    ]);
  });

  it("drops only the settled group, not its neighbours", () => {
    const c = changed({
      "18": ["a.ts", "b.ts"],
      "19": ["a.ts"],
      "20": ["b.ts"],
    });
    // 18 and 19 have both landed; 20 is still open and still shares b.ts.
    expect(findOverlaps(c, { open: ids("20") })).toEqual([
      { tickets: ["18", "20"], files: ["b.ts"] },
    ]);
  });
});

describe("ignores", () => {
  it("matches nothing when given nothing", () => {
    const skip = ignores([]);
    expect(skip("anything.ts")).toBe(false);
  });

  it("matches an exact path and nothing near it", () => {
    const skip = ignores(["bun.lock"]);
    expect(skip("bun.lock")).toBe(true);
    expect(skip("bun.lockb")).toBe(false);
    expect(skip("sub/bun.lock")).toBe(false);
  });

  it("keeps a single star inside one path segment", () => {
    const skip = ignores(["lib/i18n/locales/*.json"]);
    expect(skip("lib/i18n/locales/de.json")).toBe(true);
    expect(skip("lib/i18n/locales/nested/de.json")).toBe(false);
  });

  it("lets a double star cross segments", () => {
    const skip = ignores(["**/*.snap"]);
    expect(skip("a.snap")).toBe(false); // no leading segment to match
    expect(skip("tests/a.snap")).toBe(true);
    expect(skip("tests/deep/a.snap")).toBe(true);
  });

  it("reads a trailing slash as everything beneath a directory", () => {
    const skip = ignores(["generated/"]);
    expect(skip("generated/api.ts")).toBe(true);
    expect(skip("generated/deep/api.ts")).toBe(true);
    expect(skip("generated")).toBe(false);
    expect(skip("other/generated/api.ts")).toBe(false);
  });

  it("treats a dot as a literal, not as a regex wildcard", () => {
    const skip = ignores(["a.ts"]);
    expect(skip("axts")).toBe(false);
  });

  it("does not let a pattern with a space become a wildcard", () => {
    // The `**` pass uses NUL as its placeholder precisely so that a path
    // which legally contains a space is not silently turned into `.*`.
    const skip = ignores(["my docs/a.md"]);
    expect(skip("my docs/a.md")).toBe(true);
    expect(skip("myXdocs/a.md")).toBe(false);
  });
});

describe("findOverlaps — ignored paths", () => {
  it("leaves an ignored file out of the report", () => {
    const c = changed({
      "18": ["bun.lock", "a.ts"],
      "19": ["bun.lock", "a.ts"],
    });
    expect(findOverlaps(c, { ignore: ignores(["bun.lock"]) })).toEqual([
      { tickets: ["18", "19"], files: ["a.ts"] },
    ]);
  });

  it("drops the group entirely when every shared file is ignored", () => {
    const c = changed({ "18": ["bun.lock"], "19": ["bun.lock"] });
    expect(findOverlaps(c, { ignore: ignores(["bun.lock"]) })).toEqual([]);
  });
});
