import {
  type ResolutionState,
  droppedFiles,
  hasConflictMarkers,
  resolutionProblem,
} from "@/scripts/slice-resolve";
import { describe, expect, it } from "vitest";

/** A resolution that worked; each test spoils exactly one thing. */
const clean = (over: Partial<ResolutionState> = {}): ResolutionState => ({
  base: "master",
  rebaseInProgress: false,
  dirty: [],
  rebased: true,
  markerFiles: [],
  ...over,
});

describe("resolutionProblem", () => {
  it("lets a rebased, clean, marker-free worktree through to the gates", () => {
    expect(resolutionProblem(clean())).toBeNull();
  });

  it("catches a resolver that stopped part-way through the rebase", () => {
    expect(resolutionProblem(clean({ rebaseInProgress: true }))).toContain(
      "still in progress",
    );
  });

  it("catches edits left lying about after the rebase", () => {
    const why = resolutionProblem(clean({ dirty: [" M lib/a.ts"] }));
    expect(why).toContain("dirty");
  });

  it("catches a rebase that was abandoned rather than resolved, and names the base", () => {
    const why = resolutionProblem(clean({ rebased: false }));
    expect(why).toContain("master");
    expect(why).toContain("abandoned");
  });

  /**
   * The cheap check that would have caught the by-hand union resolution before
   * tsc did — see the file header.
   */
  it("catches conflict markers left in the tree, and names the files", () => {
    const why = resolutionProblem(clean({ markerFiles: ["lib/a.ts"] }));
    expect(why).toContain("lib/a.ts");
  });

  it("stops listing marker files once there are too many to read", () => {
    const why = resolutionProblem(
      clean({ markerFiles: ["a", "b", "c", "d", "e"] }),
    );
    expect(why).toContain("a, b, c and 2 more");
  });

  /**
   * A run that timed out mid-rebase is ALSO dirty and ALSO not rebased. The
   * message has to name what happened, not a downstream symptom of it.
   */
  it("reports the earliest failure when several are true at once", () => {
    expect(
      resolutionProblem(
        clean({
          rebaseInProgress: true,
          dirty: ["UU lib/a.ts"],
          rebased: false,
          markerFiles: ["lib/a.ts"],
        }),
      ),
    ).toContain("still in progress");
  });
});

describe("hasConflictMarkers", () => {
  it("finds a whole conflict", () => {
    expect(
      hasConflictMarkers(
        [
          "const a = 1;",
          "<<<<<<< HEAD",
          "b();",
          "=======",
          "c();",
          ">>>>>>> master",
          "",
        ].join("\n"),
      ),
    ).toBe(true);
  });

  it("passes a file with no markers", () => {
    expect(hasConflictMarkers("const a = 1;\nconst b = 2;\n")).toBe(false);
  });

  /**
   * The false positive that matters. `=======` under a line is a markdown H1,
   * and the shared manual-test document these conflicts keep landing in is full
   * of them — flagging it would abort resolutions that worked.
   */
  it("does not read a markdown heading underline as a conflict", () => {
    expect(
      hasConflictMarkers("Manual tests\n=======\n\n1. open the app\n"),
    ).toBe(false);
  });

  it("does not read a run of arrows in prose as a marker", () => {
    expect(hasConflictMarkers(">>>>>>>>>> and <<<<<<<<<<\n=======\n")).toBe(
      false,
    );
  });

  it("still catches a conflict whose closing marker is the only fence left", () => {
    expect(hasConflictMarkers("a();\n=======\nb();\n>>>>>>> master\n")).toBe(
      true,
    );
  });
});

describe("droppedFiles", () => {
  it("names a file the slice was changing and no longer is", () => {
    expect(droppedFiles(["a.ts", "b.json"], ["a.ts"])).toEqual(["b.json"]);
  });

  it("says nothing when the resolution kept everything", () => {
    expect(droppedFiles(["a.ts"], ["a.ts", "new.ts"])).toEqual([]);
  });

  it("reports each path once, in a stable order", () => {
    expect(droppedFiles(["b.ts", "a.ts", "b.ts"], [])).toEqual([
      "a.ts",
      "b.ts",
    ]);
  });
});
