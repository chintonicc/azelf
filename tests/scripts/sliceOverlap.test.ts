import {
  findNumberClashes,
  findOverlaps,
  ignores,
  numberClashes,
} from "@/scripts/slice-overlap";
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

/**
 * A landed slice stays in the report for the slices that were open when it
 * landed. One cut afterwards already contains it; the caller says which.
 */
describe("findOverlaps — a landed slice the open one already contains", () => {
  const both = changed({ "18": ["a.ts"], "19": ["a.ts"] });

  it("drops the pair when the open slice contains the landed one", () => {
    expect(
      findOverlaps(both, { open: ids("19"), absorbed: () => true }),
    ).toEqual([]);
  });

  it("keeps the pair when it does not", () => {
    expect(
      findOverlaps(both, { open: ids("19"), absorbed: () => false }),
    ).toEqual([{ tickets: ["18", "19"], files: ["a.ts"] }]);
  });

  it("keeps the landed slice for everyone while one open slice lacks it", () => {
    const three = changed({ "18": ["a.ts"], "19": ["a.ts"], "20": ["a.ts"] });
    // 18 landed; 19 was cut on top of it, 20 was open before.
    expect(
      findOverlaps(three, {
        open: ids("19", "20"),
        absorbed: (_landed, open) => open === "19",
      }),
    ).toEqual([{ tickets: ["18", "19", "20"], files: ["a.ts"] }]);
  });

  it("leaves the open slices paired once both contain it", () => {
    const three = changed({ "18": ["a.ts"], "19": ["a.ts"], "20": ["a.ts"] });
    expect(
      findOverlaps(three, { open: ids("19", "20"), absorbed: () => true }),
    ).toEqual([{ tickets: ["19", "20"], files: ["a.ts"] }]);
  });

  it("never asks about two open slices", () => {
    const asked: string[] = [];
    findOverlaps(both, {
      open: ids("18", "19"),
      absorbed: (landed, open) => {
        asked.push(`${landed} ${open}`);
        return true;
      },
    });
    expect(asked).toEqual([]);
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

describe("numberClashes — a file added under a number the tree already has", () => {
  const ADR = [
    "docs/adr/0013-c.md",
    "docs/adr/0014-d.md",
    "docs/adr/0015-event-log.md",
  ];

  it("names the file, what took its number, and the next free one", () => {
    expect(
      numberClashes(
        ["docs/adr/0015-read-models.md", "app/x.ts"],
        [...ADR, "docs/adr/0015-read-models.md", "app/x.ts"],
      ),
    ).toEqual([
      {
        file: "docs/adr/0015-read-models.md",
        taken: ["docs/adr/0015-event-log.md"],
        to: "docs/adr/0016-read-models.md",
      },
    ]);
  });

  it("is empty when the added number is free", () => {
    expect(
      numberClashes(
        ["docs/adr/0016-read-models.md"],
        [...ADR, "docs/adr/0016-read-models.md"],
      ),
    ).toEqual([]);
  });

  it("counts from the highest number in the directory, and keeps the width", () => {
    expect(
      numberClashes(
        ["db/7_add.sql"],
        ["db/7_add.sql", "db/7_drop.sql", "db/12_other.sql"],
      ).map((x) => x.to),
    ).toEqual(["db/13_add.sql"]);
  });

  it("gives each clashing entry its own number, and one entry's files one", () => {
    expect(
      numberClashes(
        ["m/0002_a.up.sql", "m/0002_a.down.sql", "m/0003_b.sql"],
        [
          "m/0002_a.up.sql",
          "m/0002_a.down.sql",
          "m/0003_b.sql",
          "m/0002_x.sql",
          "m/0003_y.sql",
        ],
      ).map((x) => x.to),
    ).toEqual(["m/0004_a.down.sql", "m/0004_a.up.sql", "m/0005_b.sql"]);
  });

  it("reads one entry in two files as one entry, not a clash", () => {
    expect(
      numberClashes(
        ["m/0002_a.down.sql"],
        ["m/0002_a.up.sql", "m/0002_a.down.sql"],
      ),
    ).toEqual([]);
  });

  it("does not compare across directories", () => {
    expect(numberClashes(["a/01-x.md"], ["a/01-x.md", "b/01-y.md"])).toEqual(
      [],
    );
  });

  it("leaves names without a number and a - or _ alone", () => {
    expect(
      numberClashes(
        ["img/1.webp", "app/404.tsx", "a/2x-icon.png"],
        [
          "img/1.webp",
          "img/1.png",
          "app/404.tsx",
          "app/404.html",
          "a/2x-icon.png",
        ],
      ),
    ).toEqual([]);
  });

  it("skips what the ignore predicate matches", () => {
    expect(
      numberClashes(
        ["docs/adr/0015-read-models.md"],
        [...ADR, "docs/adr/0015-read-models.md"],
        ignores(["docs/adr/"]),
      ),
    ).toEqual([]);
  });
});

describe("findNumberClashes — slices adding the same number", () => {
  it("groups two slices that took one number in one directory", () => {
    expect(
      findNumberClashes(
        changed({
          "31": ["docs/adr/0015-event-log.md", "lib/a.ts"],
          "32": ["docs/adr/0015-read-models.md"],
          "33": ["docs/adr/0016-other.md"],
        }),
      ),
    ).toEqual([
      {
        tickets: ["31", "32"],
        files: ["docs/adr/0015-event-log.md", "docs/adr/0015-read-models.md"],
      },
    ]);
  });

  it("drops a group with nobody open, and keeps a landed one beside an open one", () => {
    const c = changed({
      "31": ["docs/adr/0015-event-log.md"],
      "32": ["docs/adr/0015-read-models.md"],
    });
    expect(findNumberClashes(c, { open: new Set() })).toEqual([]);
    expect(findNumberClashes(c, { open: new Set(["32"]) })).toHaveLength(1);
  });

  it("is empty for one slice, and for the same entry in two slices", () => {
    expect(
      findNumberClashes(
        changed({ "31": ["docs/adr/0015-a.md", "docs/adr/0015-b.md"] }),
      ),
    ).toEqual([]);
    expect(
      findNumberClashes(
        changed({ "1": ["m/0002_a.up.sql"], "2": ["m/0002_a.down.sql"] }),
      ),
    ).toEqual([]);
  });
});
