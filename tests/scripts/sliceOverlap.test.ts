import { findOverlaps } from "@/scripts/slice-overlap";
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
