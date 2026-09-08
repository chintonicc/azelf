import {
  type GhRunner,
  blockersFromBody,
  bodyOnlyBlockers,
  compareIds,
  findEpics,
  github,
  idFromBranch,
  idPatternProblem,
  openBlockers,
  parentFromBody,
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

  it("addBlocker resolves the issue NUMBER to its internal id before posting", () => {
    // The endpoint's `issue_id` is the internal database id. Posting the issue
    // number instead does not fail — it links whatever issue in all of GitHub
    // carries that id, which is how a probe with issue_id=19 produced an edge
    // to nokogiri#2. So the resolution below is the whole point of the method.
    const { gh, calls } = fakeGh({
      "api repos/{owner}/{repo}/issues/19 --jq {id}": {
        stdout: '{"id":5385303756}',
      },
      "api --method POST repos/{owner}/{repo}/issues/20/dependencies/blocked_by -F issue_id=5385303756":
        { stdout: '{"number":20}' },
    });
    expect(() => github({ gh }).addBlocker?.("20", "19")).not.toThrow();
    expect(calls).toHaveLength(2);
    expect(calls[0]).toEqual([
      "api",
      "repos/{owner}/{repo}/issues/19",
      "--jq",
      "{id}",
    ]);
    // The number never reaches the payload.
    expect(calls[1]?.at(-1)).toBe("issue_id=5385303756");
  });

  it("addBlocker treats an edge that already exists as the outcome asked for", () => {
    const { gh } = fakeGh({
      "api repos/{owner}/{repo}/issues/19 --jq {id}": { stdout: '{"id":42}' },
      "api --method POST repos/{owner}/{repo}/issues/20/dependencies/blocked_by -F issue_id=42":
        {
          ok: false,
          stderr:
            "Validation failed: Target issue has already been taken (HTTP 422)",
        },
    });
    // Two syncs in a row must not differ.
    expect(() => github({ gh }).addBlocker?.("20", "19")).not.toThrow();
  });

  it("addBlocker throws with gh's output on any other failure", () => {
    const { gh } = fakeGh({
      "api repos/{owner}/{repo}/issues/19 --jq {id}": { stdout: '{"id":42}' },
      "api --method POST repos/{owner}/{repo}/issues/20/dependencies/blocked_by -F issue_id=42":
        { ok: false, stderr: "HTTP 403: Resource not accessible" },
    });
    expect(() => github({ gh }).addBlocker?.("20", "19")).toThrow(
      /could not record #20 as blocked by #19[\s\S]*403/,
    );
  });

  it("addBlocker writes nothing when the blocker cannot be resolved", () => {
    const { gh, calls } = fakeGh({
      "api repos/{owner}/{repo}/issues/999 --jq {id}": {
        ok: false,
        stderr: "HTTP 404: Not Found",
      },
    });
    expect(() => github({ gh }).addBlocker?.("20", "999")).toThrow(/404/);
    // The POST never happened — a failed lookup must not fall through to one.
    expect(calls).toHaveLength(1);
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

/**
 * The body readers exist because a ticket can assert a hierarchy the tracker
 * has no record of. That is not hypothetical: the case they were written for
 * had four tickets naming `## Parent — #17` while GitHub's own sub-issue and
 * dependency graphs were completely empty, so a dispatcher trusting only the
 * native edges scheduled the parent and its four children as five peers.
 *
 * The risk runs the other way too, which is what most of these cases guard:
 * ticket bodies cross-reference each other constantly, and a parser that read
 * every `#17` as structure would exclude tickets that were only being polite
 * about context. Hence section scoping, and hence the false-positive tests.
 */
const N = "^[0-9]+$";

describe("parentFromBody — the `## Parent` convention", () => {
  it("reads the id under the heading", () => {
    const body =
      "## Parent\n\n#17 — The time-boxed category\n\n## What to build";
    expect(parentFromBody(body, N)).toBe("17");
  });

  it("is null when there is no Parent section", () => {
    expect(parentFromBody("## What to build\n\nA thing.", N)).toBeNull();
  });

  it("is null when the section names nothing", () => {
    expect(parentFromBody("## Parent\n\nNone.\n\n## Next", N)).toBeNull();
  });

  it("ignores ids OUTSIDE the section — a mention is not a hierarchy", () => {
    const body = "## Blocked by\n\nNone. Reads best after #19.\n";
    expect(parentFromBody(body, N)).toBeNull();
  });

  it("stops at the next heading, so a later section cannot leak in", () => {
    const body = "## Parent\n\nNone.\n\n## Blocked by\n\n#19\n";
    expect(parentFromBody(body, N)).toBeNull();
  });

  it("takes the first id when the section names several", () => {
    expect(parentFromBody("## Parent\n\n#17, see also #4\n", N)).toBe("17");
  });

  it("accepts any heading level and any case", () => {
    expect(parentFromBody("### parent\n\n#17\n", N)).toBe("17");
    expect(parentFromBody("# PARENT\n\n#17\n", N)).toBe("17");
  });

  it("respects the tracker's idPattern rather than assuming digits", () => {
    const body = "## Parent\n\n#ENG-17 — a thing\n";
    expect(parentFromBody(body, "^ENG-[0-9]+$")).toBe("ENG-17");
    expect(parentFromBody(body, N)).toBeNull();
  });

  it("survives an empty body", () => {
    expect(parentFromBody("", N)).toBeNull();
  });
});

describe("blockersFromBody — the `## Blocked by` convention", () => {
  it("reads every id under the heading, without duplicates", () => {
    const body = "## Blocked by\n\n#19 and #20, plus #19 again\n\n## Next";
    expect(blockersFromBody(body, N)).toEqual(["19", "20"]);
  });

  it("reads 'None (can start immediately)' as no blockers", () => {
    const body = "## Blocked by\n\nNone (can start immediately).\n";
    expect(blockersFromBody(body, N)).toEqual([]);
  });

  it("is empty when the section is absent", () => {
    expect(blockersFromBody("## Parent\n\n#17\n", N)).toEqual([]);
  });

  it("does not pick up the parent from its own section", () => {
    const body = "## Parent\n\n#17\n\n## Blocked by\n\nNone.\n";
    expect(blockersFromBody(body, N)).toEqual([]);
  });
});

describe("findEpics — which tickets are headings, not work", () => {
  /** A tracker stub: bodies by id, and optionally a native child map. */
  const from = (
    bodies: Record<string, string>,
    children?: Record<string, string[]>,
  ) => ({
    idPattern: N,
    body: (id: string) => bodies[id] ?? "",
    ...(children ? { children: (id: string) => children[id] ?? [] } : {}),
  });

  const child = (parent: string) => `## Parent\n\n#${parent} — a thing\n`;

  it("finds the parent named by every other ticket in the set", () => {
    const epics = findEpics(
      ["17", "18", "19", "20", "21"],
      from({
        "17": "## Problem Statement\n\nA feature.",
        "18": child("17"),
        "19": child("17"),
        "20": child("17"),
        "21": child("17"),
      }),
    );
    expect(epics).toEqual([{ id: "17", children: ["18", "19", "20", "21"] }]);
  });

  it("is empty when no ticket names a parent — the common case", () => {
    const epics = findEpics(
      ["18", "19"],
      from({ "18": "## Blocked by\n\nNone.", "19": "## Blocked by\n\nNone." }),
    );
    expect(epics).toEqual([]);
  });

  it("ignores a parent OUTSIDE the set — it is context, not a competitor", () => {
    // #17 is not being run, so nothing it is a heading over needs excluding.
    expect(
      findEpics(["18", "19"], from({ "18": child("17"), "19": child("17") })),
    ).toEqual([]);
  });

  it("lets the tracker's native hierarchy override the prose", () => {
    // The body of #19 claims #17; the tracker says #19 hangs under #18.
    const epics = findEpics(
      ["17", "18", "19"],
      from({ "17": "", "18": "", "19": child("17") }, { "18": ["19"] }),
    );
    expect(epics).toEqual([{ id: "18", children: ["19"] }]);
  });

  it("still reads the prose when the tracker knows no hierarchy at all", () => {
    // The case this was written for: GitHub's sub-issue graph was empty while
    // four bodies named a parent. A native-only reading finds nothing.
    const epics = findEpics(
      ["17", "18"],
      from({ "17": "", "18": child("17") }, {}),
    );
    expect(epics).toEqual([{ id: "17", children: ["18"] }]);
  });

  it("ignores a ticket naming itself", () => {
    expect(findEpics(["17"], from({ "17": child("17") }))).toEqual([]);
  });

  it("reports several epics, and sorts them and their children numerically", () => {
    const epics = findEpics(
      ["1", "2", "10", "20"],
      from({
        "1": "",
        "2": "",
        "10": child("2"),
        "20": child("1"),
      }),
    );
    expect(epics).toEqual([
      { id: "1", children: ["20"] },
      { id: "2", children: ["10"] },
    ]);
  });
});

describe("bodyOnlyBlockers — what the prose claims and the tracker has not got", () => {
  const B = (body: string, known: { id: string; state: "open" | "closed" }[]) =>
    bodyOnlyBlockers(body, known, N);

  it("reports a claimed blocker the tracker has no edge for", () => {
    expect(B("## Blocked by\n\n#19\n", [])).toEqual(["19"]);
  });

  it("is empty when the tracker already has the edge", () => {
    expect(B("## Blocked by\n\n#19\n", [{ id: "19", state: "open" }])).toEqual(
      [],
    );
  });

  it("counts a CLOSED edge as recorded, not missing", () => {
    // The tracker drew this edge and then cleared it by closing #19. Reporting
    // it would ask --sync-edges to redraw every edge the plan has worked
    // through, which would block the ticket on work that is already done.
    expect(
      B("## Blocked by\n\n#19\n", [{ id: "19", state: "closed" }]),
    ).toEqual([]);
  });

  it("is empty for 'None (can start immediately)' — the common case", () => {
    expect(B("## Blocked by\n\nNone (can start immediately).\n", [])).toEqual(
      [],
    );
  });

  it("does not read a mention outside the section as a claim", () => {
    // The live case: #20 said it "reads best after #19" but declared no
    // blocker. That sentence must not become an edge.
    const body =
      "## Blocked by\n\nNone (can start immediately). Reads best after #19, but does not depend on it.\n";
    // The #19 here IS under the heading, so it is claimed — the guard that
    // matters is the one below, where the mention sits in another section.
    expect(B(body, [])).toEqual(["19"]);
    expect(
      B("## Notes\n\nSupersedes #4.\n\n## Blocked by\n\nNone.\n", []),
    ).toEqual([]);
  });

  it("drops a ticket that names itself", () => {
    expect(bodyOnlyBlockers("## Blocked by\n\n#20\n", [], N, "20")).toEqual([]);
  });

  it("reports only the missing half of a mixed list", () => {
    expect(
      B("## Blocked by\n\n#18, #19 and #20\n", [{ id: "19", state: "open" }]),
    ).toEqual(["18", "20"]);
  });
});
