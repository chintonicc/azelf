import {
  type GhRunner,
  compareIds,
  github,
  idFromBranch,
  idPatternProblem,
  openBlockers,
  refFor,
} from "@/scripts/slice-tracker";
import { describe, expect, it } from "vitest";

/**
 * The GitHub adapter is tested through a scripted `gh` — no network, and the
 * assertions are about the CONTRACT in scripts/slice-tracker.ts's header: ids
 * come back as strings, states collapse to open/closed, the edge query is the
 * blocked_by direction and nothing else, and every failure throws rather than
 * reading as "no tickets" or "no blockers".
 */

type Answer = { ok?: boolean; stdout?: string; stderr?: string };

/** Answers keyed by the joined argument list; records every call. */
function fakeGh(answers: Record<string, Answer>): {
  gh: GhRunner;
  calls: string[][];
} {
  const calls: string[][] = [];
  const gh: GhRunner = (args) => {
    calls.push(args);
    const a = answers[args.join(" ")];
    if (!a) {
      return {
        ok: false,
        stdout: "",
        stderr: `unscripted: gh ${args.join(" ")}`,
      };
    }
    return { ok: a.ok ?? true, stdout: a.stdout ?? "", stderr: a.stderr ?? "" };
  };
  return { gh, calls };
}

describe("github() — the adapter that ships", () => {
  it("declares numeric ids and the #n ref", () => {
    const t = github({ gh: fakeGh({}).gh });
    expect(t.name).toBe("GitHub");
    expect(idPatternProblem(t.idPattern)).toBeNull();
    expect(new RegExp(t.idPattern).test("42")).toBe(true);
    expect(new RegExp(t.idPattern).test("ENG-42")).toBe(false);
    expect(new RegExp(t.idPattern).test("")).toBe(false);
    expect(refFor(t.refTemplate, "42")).toBe("#42");
  });

  it("listReady asks for open issues with the label and returns ids as strings", () => {
    const { gh, calls } = fakeGh({
      "issue list --state open --label ready-for-agent --limit 100 --json number":
        { stdout: '[{"number":12},{"number":9}]' },
    });
    expect(github({ gh }).listReady("ready-for-agent")).toEqual(["12", "9"]);
    expect(calls).toHaveLength(1);
  });

  it("get normalizes OPEN/CLOSED and carries title, labels and url", () => {
    const { gh } = fakeGh({
      "issue view 3 --json number,title,state,url,labels": {
        stdout:
          '{"number":3,"title":"R2 Phase 2","state":"OPEN","url":"https://github.com/o/r/issues/3","labels":[{"name":"r2-migration"},{"name":"ready-for-agent"}]}',
      },
      "issue view 4 --json number,title,state,url,labels": {
        stdout:
          '{"number":4,"title":"done","state":"CLOSED","url":"u","labels":[]}',
      },
    });
    const t = github({ gh });
    expect(t.get("3")).toEqual({
      id: "3",
      title: "R2 Phase 2",
      state: "open",
      labels: ["r2-migration", "ready-for-agent"],
      url: "https://github.com/o/r/issues/3",
    });
    expect(t.get("4").state).toBe("closed");
  });

  it("blockers reads the blocked_by direction only, closed ones included", () => {
    const { gh, calls } = fakeGh({
      "api repos/{owner}/{repo}/issues/7/dependencies/blocked_by --jq [.[] | {number, state}]":
        {
          stdout: '[{"number":5,"state":"closed"},{"number":6,"state":"open"}]',
        },
    });
    const all = github({ gh }).blockers("7");
    expect(all).toEqual([
      { id: "5", state: "closed" },
      { id: "6", state: "open" },
    ]);
    expect(openBlockers(all)).toEqual([{ id: "6", state: "open" }]);
    // One call, and it is the forward edge; the reverse is never asked for.
    expect(calls).toHaveLength(1);
    expect(calls[0]?.[1]).toMatch(/\/dependencies\/blocked_by$/);
  });

  it("body returns the text, and an empty string for a ticket with none", () => {
    const { gh } = fakeGh({
      "issue view 3 --json body": { stdout: '{"body":"Do the thing."}' },
      "issue view 8 --json body": { stdout: '{"body":null}' },
    });
    const t = github({ gh });
    expect(t.body("3")).toBe("Do the thing.");
    expect(t.body("8")).toBe("");
  });

  it("close runs `gh issue close` with the comment and throws when it fails", () => {
    const { gh, calls } = fakeGh({
      "issue close 3 --comment Landed on master via slice-land.sh.": {
        stdout: "✓ Closed issue #3",
      },
      "issue close 9 --comment c": {
        ok: false,
        stderr: "GraphQL: Could not resolve to an Issue",
      },
    });
    const t = github({ gh });
    expect(() =>
      t.close("3", "Landed on master via slice-land.sh."),
    ).not.toThrow();
    expect(calls[0]).toEqual([
      "issue",
      "close",
      "3",
      "--comment",
      "Landed on master via slice-land.sh.",
    ]);
    expect(() => t.close("9", "c")).toThrow(/Could not resolve to an Issue/);
  });

  it("a failed gh call throws with gh's output — never an empty list", () => {
    const { gh } = fakeGh({
      "issue list --state open --label x --limit 100 --json number": {
        ok: false,
        stderr: "gh: Not logged in",
      },
      "api repos/{owner}/{repo}/issues/1/dependencies/blocked_by --jq [.[] | {number, state}]":
        { ok: false, stderr: "HTTP 404" },
    });
    const t = github({ gh });
    expect(() => t.listReady("x")).toThrow(/Not logged in/);
    expect(() => t.blockers("1")).toThrow(/HTTP 404/);
    expect(() => t.get("2")).toThrow(/unscripted/);
  });

  it("a gh update notice on stderr does not break the JSON on stdout", () => {
    const { gh } = fakeGh({
      "issue view 3 --json body": {
        stdout: '{"body":"b"}',
        stderr: "A new release of gh is available",
      },
    });
    expect(github({ gh }).body("3")).toBe("b");
  });

  it("non-JSON on stdout is an error that names the call", () => {
    const { gh } = fakeGh({
      "issue view 3 --json body": { stdout: "Welcome to GitHub CLI!" },
    });
    expect(() => github({ gh }).body("3")).toThrow(
      /gh issue view 3 --json body returned something that is not JSON/,
    );
  });
});

describe("idPatternProblem — the pattern must work in bash too", () => {
  it("accepts patterns in the shared subset", () => {
    expect(idPatternProblem("^[0-9]+$")).toBeNull();
    expect(idPatternProblem("^[A-Z][A-Z0-9]*-[0-9]+$")).toBeNull();
    expect(idPatternProblem("^(ENG|OPS)-[0-9]+$")).toBeNull();
  });

  it("rejects what POSIX ERE cannot express", () => {
    expect(idPatternProblem("^\\d+$")).toMatch(/no \\d/);
    expect(idPatternProblem("^\\w+-\\d+$")).toMatch(/no \\d/);
    expect(idPatternProblem("^(?:ENG)-[0-9]+$")).toMatch(/no \(\?/);
  });

  it("rejects an unanchored or broken pattern", () => {
    expect(idPatternProblem("[0-9]+")).toMatch(/anchored/);
    expect(idPatternProblem("^[0-9]+")).toMatch(/anchored/);
    expect(idPatternProblem("^[0-9$")).toMatch(/does not compile/);
  });
});

describe("idFromBranch — the round trip out of a branch name", () => {
  it("reads a numeric id back", () => {
    expect(idFromBranch("ticket/{n}", "^[0-9]+$", "ticket/42")).toBe("42");
  });

  it("reads a Linear-shaped id back when the tracker says so", () => {
    expect(
      idFromBranch("ticket/{n}", "^[A-Z]+-[0-9]+$", "ticket/ENG-123"),
    ).toBe("ENG-123");
    expect(
      idFromBranch("slices/{n}-work", "^[A-Z]+-[0-9]+$", "slices/ENG-123-work"),
    ).toBe("ENG-123");
  });

  it("refuses an id the tracker's pattern does not accept, and non-slice branches", () => {
    expect(idFromBranch("ticket/{n}", "^[0-9]+$", "ticket/ENG-123")).toBeNull();
    expect(idFromBranch("ticket/{n}", "^[0-9]+$", "ticket/")).toBeNull();
    expect(idFromBranch("ticket/{n}", "^[0-9]+$", "master")).toBeNull();
    expect(
      idFromBranch("ticket/{n}", "^[0-9]+$", "ticket/42/extra"),
    ).toBeNull();
  });

  it("treats the literal parts of the pattern as literal", () => {
    expect(idFromBranch("t.{n}", "^[0-9]+$", "tx1")).toBeNull();
    expect(idFromBranch("t.{n}", "^[0-9]+$", "t.1")).toBe("1");
  });
});

describe("compareIds — the tree's sort order", () => {
  it("sorts numeric ids numerically, not lexically", () => {
    expect(["12", "9", "100", "3"].sort(compareIds)).toEqual([
      "3",
      "9",
      "12",
      "100",
    ]);
  });

  it("sorts prefixed ids by their number too", () => {
    expect(["ENG-12", "ENG-9", "ENG-100"].sort(compareIds)).toEqual([
      "ENG-9",
      "ENG-12",
      "ENG-100",
    ]);
  });
});
