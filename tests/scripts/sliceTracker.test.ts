import {
  type GhRunner,
  blockerLine,
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

  describe("listReady — the repository's issue list, not search", () => {
    /** Answers every call with `answer`; records the arguments. */
    const scripted = (answer: Answer) => {
      const calls: string[][] = [];
      const gh: GhRunner = (args) => {
        calls.push(args);
        return {
          ok: answer.ok ?? true,
          stdout: answer.stdout ?? "",
          stderr: answer.stderr ?? "",
        };
      };
      return { gh, calls };
    };
    const field = (args: string[], name: string) =>
      args.find((a) => a.startsWith(`${name}=`))?.slice(name.length + 1);

    it("asks the paged GraphQL issue list for open issues with the label, newest first", () => {
      const { gh, calls } = scripted({ stdout: "12\n9\n" });
      expect(github({ gh }).listReady("ready-for-agent")).toEqual(["12", "9"]);
      expect(calls).toHaveLength(1);
      const args = calls[0] ?? [];
      expect(args.slice(0, 3)).toEqual(["api", "graphql", "--paginate"]);
      // gh fills these from the remote, as it does the REST paths.
      expect(field(args, "owner")).toBe("{owner}");
      expect(field(args, "repo")).toBe("{repo}");
      expect(field(args, "label")).toBe("ready-for-agent");
      const query = field(args, "query") ?? "";
      expect(query).toMatch(/repository\(owner: \$owner, name: \$repo\)/);
      expect(query).toMatch(/issues\(first: 100, after: \$endCursor/);
      expect(query).toMatch(/states: OPEN, labels: \[\$label\]/);
      expect(query).toMatch(/orderBy: \{field: CREATED_AT, direction: DESC\}/);
      expect(query).toMatch(/pageInfo \{ hasNextPage endCursor \}/);
      expect(query).not.toMatch(/search/);
      expect(args.slice(-2)).toEqual([
        "--jq",
        ".data.repository.issues.nodes[].number",
      ]);
      // Not the search-backed listing the adapter used to call.
      expect(args).not.toContain("list");
    });

    it("reads every page --paginate prints as one list", () => {
      // 100 on the first page, two on the second: gh prints them one per line.
      const first = Array.from({ length: 100 }, (_, i) => String(300 - i));
      const { gh } = scripted({ stdout: `${first.join("\n")}\n150\n149\n` });
      const ids = github({ gh }).listReady("ready-for-agent");
      expect(ids).toHaveLength(102);
      expect(ids.slice(98)).toEqual(["202", "201", "150", "149"]);
    });

    it("a label no open issue carries gives no tickets, not an error", () => {
      expect(github({ gh: scripted({}).gh }).listReady("x")).toEqual([]);
    });

    it("passes a label with a comma or quotes through as one value", () => {
      const { gh, calls } = scripted({ stdout: "3\n" });
      github({ gh }).listReady('needs, "agent"');
      expect(field(calls[0] ?? [], "label")).toBe('needs, "agent"');
    });

    it("output that is not issue numbers throws, and says what came back", () => {
      const { gh } = scripted({ stdout: '{"data":null}\n' });
      expect(() => github({ gh }).listReady("x")).toThrow(
        /not a list of issue numbers:\n\{"data":null\}/,
      );
    });

    it("a failure throws with gh's output under a '… failed:' header", () => {
      const { gh } = scripted({
        ok: false,
        stderr:
          "gh: Could not resolve to a Repository with the name 'o/gone'.\n",
      });
      expect(() => github({ gh }).listReady("x")).toThrow(
        /^gh api graphql \(open issues labelled x\) failed:\ngh: Could not resolve to a Repository/,
      );
    });
  });

  it("parentClaims searches every state and returns id, state and body", () => {
    const { gh } = fakeGh({
      'issue list --state all --search "## Parent" in:body --limit 1000 --json number,state,body':
        {
          stdout:
            '[{"number":47,"state":"CLOSED","body":"## Parent\\n\\n#45"},{"number":50,"state":"OPEN","body":null}]',
        },
    });
    expect(github({ gh }).parentClaims?.()).toEqual([
      { id: "47", state: "closed", body: "## Parent\n\n#45" },
      { id: "50", state: "open", body: "" },
    ]);
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

  /** The blocked_by answer for `id`, each blocker in the repo its url names. */
  const BLOCKED_BY = (id: string) =>
    `api repos/{owner}/{repo}/issues/${id}/dependencies/blocked_by --jq [.[] | {number, state, repository_url}]`;
  const REPO_VIEW = "repo view --json nameWithOwner";
  const blocker = (number: number, state: string, repo = "acme/app") => ({
    number,
    state,
    repository_url: `https://api.github.com/repos/${repo}`,
  });

  it("blockers reads the blocked_by direction only, closed ones included", () => {
    const { gh, calls } = fakeGh({
      [BLOCKED_BY("7")]: {
        stdout: JSON.stringify([blocker(5, "closed"), blocker(6, "open")]),
      },
      [REPO_VIEW]: { stdout: '{"nameWithOwner":"acme/app"}' },
    });
    const all = github({ gh }).blockers("7");
    expect(all).toEqual([
      { id: "5", state: "closed" },
      { id: "6", state: "open" },
    ]);
    expect(openBlockers(all)).toEqual([{ id: "6", state: "open" }]);
    // The forward edge, and the reverse is never asked for.
    const edges = calls.filter((c) => c[0] === "api");
    expect(edges).toHaveLength(1);
    expect(edges[0]?.[1]).toMatch(/\/dependencies\/blocked_by$/);
  });

  it("blockers names a blocker in another repo as owner/repo#n", () => {
    // A frontend ticket blocked by a backend one. Read as a bare 140, it was
    // this repo's #140: another ticket, with a state of its own.
    const { gh } = fakeGh({
      [BLOCKED_BY("7")]: {
        stdout: JSON.stringify([
          blocker(139, "closed"),
          blocker(140, "open", "acme/api"),
        ]),
      },
      [REPO_VIEW]: { stdout: '{"nameWithOwner":"acme/app"}' },
    });
    expect(github({ gh }).blockers("7")).toEqual([
      { id: "139", state: "closed" },
      { id: "acme/api#140", state: "open" },
    ]);
  });

  it("blockers compares repos without case, and writes another repo's in lower case", () => {
    const { gh } = fakeGh({
      [BLOCKED_BY("7")]: {
        stdout: JSON.stringify([
          blocker(5, "open", "Acme/App"),
          blocker(140, "open", "Acme/API"),
        ]),
      },
      [REPO_VIEW]: { stdout: '{"nameWithOwner":"acme/app"}' },
    });
    expect(
      github({ gh })
        .blockers("7")
        .map((b) => b.id),
    ).toEqual(["5", "acme/api#140"]);
  });

  it("blockers reads its own repo once, and only once a blocker comes back", () => {
    const { gh, calls } = fakeGh({
      [BLOCKED_BY("1")]: { stdout: "[]" },
      [BLOCKED_BY("7")]: { stdout: JSON.stringify([blocker(5, "open")]) },
      [BLOCKED_BY("8")]: { stdout: JSON.stringify([blocker(6, "open")]) },
      [REPO_VIEW]: { stdout: '{"nameWithOwner":"acme/app"}' },
    });
    const t = github({ gh });
    t.blockers("1");
    expect(calls.filter((c) => c[0] === "repo")).toHaveLength(0);
    t.blockers("7");
    t.blockers("8");
    expect(calls.filter((c) => c[0] === "repo")).toHaveLength(1);
  });

  it("get reads a ticket in another repo through -R, and keeps its id", () => {
    const { gh } = fakeGh({
      "issue view 140 -R acme/api --json number,title,state,url,labels": {
        stdout:
          '{"number":140,"title":"the endpoint","state":"CLOSED","url":"https://github.com/acme/api/issues/140","labels":[]}',
      },
    });
    expect(github({ gh }).get("acme/api#140")).toEqual({
      id: "acme/api#140",
      title: "the endpoint",
      state: "closed",
      labels: [],
      url: "https://github.com/acme/api/issues/140",
    });
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

  it("addBlocker resolves a blocker in another repo under that repo's path", () => {
    // Under this repo's path, `acme/api#140` would find nothing, or this
    // repo's #140. The edge itself is still this repo's: it goes on #20.
    const { gh, calls } = fakeGh({
      "api repos/acme/api/issues/140 --jq {id}": { stdout: '{"id":777}' },
      "api --method POST repos/{owner}/{repo}/issues/20/dependencies/blocked_by -F issue_id=777":
        { stdout: '{"number":20}' },
    });
    expect(() =>
      github({ gh }).addBlocker?.("20", "acme/api#140"),
    ).not.toThrow();
    expect(calls.map((c) => c.join(" "))).toEqual([
      "api repos/acme/api/issues/140 --jq {id}",
      "api --method POST repos/{owner}/{repo}/issues/20/dependencies/blocked_by -F issue_id=777",
    ]);
  });

  it("addBlocker treats an edge across repos that already exists as the outcome asked for", () => {
    const { gh } = fakeGh({
      "api repos/acme/api/issues/140 --jq {id}": { stdout: '{"id":777}' },
      "api --method POST repos/{owner}/{repo}/issues/20/dependencies/blocked_by -F issue_id=777":
        {
          ok: false,
          stderr:
            "Validation failed: Target issue has already been taken (HTTP 422)",
        },
    });
    expect(() =>
      github({ gh }).addBlocker?.("20", "acme/api#140"),
    ).not.toThrow();
  });

  it("addBlocker writes nothing when a blocker in another repo cannot be resolved", () => {
    const { gh, calls } = fakeGh({
      "api repos/acme/api/issues/140 --jq {id}": {
        ok: false,
        stderr: "HTTP 404: Not Found",
      },
    });
    expect(() => github({ gh }).addBlocker?.("20", "acme/api#140")).toThrow(
      /404/,
    );
    expect(calls).toHaveLength(1);
  });

  it("addBlocker names a blocker in another repo by its own id when the post fails", () => {
    const { gh } = fakeGh({
      "api repos/acme/api/issues/140 --jq {id}": { stdout: '{"id":777}' },
      "api --method POST repos/{owner}/{repo}/issues/20/dependencies/blocked_by -F issue_id=777":
        { ok: false, stderr: "HTTP 403: Resource not accessible" },
    });
    expect(() => github({ gh }).addBlocker?.("20", "acme/api#140")).toThrow(
      /could not record #20 as blocked by acme\/api#140:[\s\S]*403/,
    );
  });

  it("a failed gh call throws with gh's output — never an empty list", () => {
    const { gh } = fakeGh({
      "issue view 1 --json body": {
        ok: false,
        stderr: "gh: Not logged in",
      },
      "api repos/{owner}/{repo}/issues/1/dependencies/blocked_by --jq [.[] | {number, state, repository_url}]":
        { ok: false, stderr: "HTTP 404" },
    });
    const t = github({ gh });
    expect(() => t.body("1")).toThrow(/Not logged in/);
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

  it("a section that opens with None is empty, whatever it goes on to mention", () => {
    const body = "## Blocked by\n\nNone. #62 and #63 have landed.\n";
    expect(blockersFromBody(body, N)).toEqual([]);
    expect(
      blockersFromBody("## Blocked by\n\n- **None**, see #4\n", N),
    ).toEqual([]);
  });

  it("reads 'Blocked on #N' wherever it stands, to the end of the sentence", () => {
    const body =
      "## What to build\n\n**Blocked on #2 (the egress trigger) and #3 (the authorizer).** Do not start early; see #9.\n";
    expect(blockersFromBody(body, N)).toEqual(["2", "3"]);
    expect(
      blockersFromBody("This is blocked by #81; #82 is a sibling.", N),
    ).toEqual(["81"]);
  });

  it("joins the section and the phrase without duplicates", () => {
    const body = "Blocked on #2.\n\n## Blocked by\n\n#2 and #5\n";
    expect(blockersFromBody(body, N)).toEqual(["2", "5"]);
  });

  it("skips a negated phrase, and a mention that is not a claim", () => {
    expect(blockersFromBody("It is not blocked by #19.", N)).toEqual([]);
    expect(blockersFromBody("This isn't blocked on #19.", N)).toEqual([]);
    expect(blockersFromBody("No longer blocked by #19.", N)).toEqual([]);
    expect(blockersFromBody("Unblocked by #19 landing.", N)).toEqual([]);
    expect(blockersFromBody("Reads best after #19.", N)).toEqual([]);
  });

  it("reads only the list items when the section has any", () => {
    const body =
      "## Blocked by\n\n- #99 — the storage policy\n* #100\n+ #101\n  1. #102\n2) #103\n\n#97 and #98 landed already.\n";
    expect(blockersFromBody(body, N)).toEqual([
      "99",
      "100",
      "101",
      "102",
      "103",
    ]);
  });

  it("reads owner/repo#n as a ticket in another repo, and never as #n", () => {
    const body =
      "## Blocked by\n\n- Acme/API#140 — the endpoint\n- #19\n\nBlocked on acme/api#141.\n";
    expect(blockersFromBody(body, N)).toEqual([
      "acme/api#140",
      "19",
      "acme/api#141",
    ]);
  });

  it("reads every line when the section has no list item", () => {
    const body = "## Blocked by\n\n#19, then\n#20 once it lands\n";
    expect(blockersFromBody(body, N)).toEqual(["19", "20"]);
  });

  it("an italic note is prose, not a list item", () => {
    const body = "## Blocked by\n\n- #19\n\n*#99 is close, ask first*\n";
    expect(blockersFromBody(body, N)).toEqual(["19"]);
    expect(
      blockersFromBody("## Blocked by\n\n*#99 is close, ask first*\n", N),
    ).toEqual(["99"]);
  });

  it("a list keeps the None rule and the phrase rule", () => {
    expect(
      blockersFromBody("## Blocked by\n\n- None\n- #4 landed\n", N),
    ).toEqual([]);
    const body = "Blocked on #2.\n\n## Blocked by\n\n- #5\n\nSee #6.\n";
    expect(blockersFromBody(body, N)).toEqual(["5", "2"]);
  });

  it("does not pick up the parent from its own section", () => {
    const body = "## Parent\n\n#17\n\n## Blocked by\n\nNone.\n";
    expect(blockersFromBody(body, N)).toEqual([]);
  });
});

describe("blockerLine — the line a blocker is read from", () => {
  it("quotes the list item, trimmed", () => {
    const body = "## Blocked by\n\n  - #99 — the storage policy\n\n#97 too\n";
    expect(blockerLine(body, "99", N)).toBe("- #99 — the storage policy");
    expect(blockerLine(body, "97", N)).toBeNull();
  });

  it("quotes the line a phrase stands on", () => {
    const body =
      "## What\n\n**Blocked on #2 (the trigger).** Do not start early.\n";
    expect(blockerLine(body, "2", N)).toBe(
      "**Blocked on #2 (the trigger).** Do not start early.",
    );
  });

  it("prefers the section, where the id is read first", () => {
    const body = "Blocked by #5.\n\n## Blocked by\n\n- #5, the schema\n";
    expect(blockerLine(body, "5", N)).toBe("- #5, the schema");
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
    expect(epics).toEqual([
      {
        id: "17",
        children: ["18", "19", "20", "21"],
        openChildren: ["18", "19", "20", "21"],
      },
    ]);
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
    expect(epics).toEqual([
      { id: "18", children: ["19"], openChildren: ["19"] },
    ]);
  });

  it("still reads the prose when the tracker knows no hierarchy at all", () => {
    // The case this was written for: GitHub's sub-issue graph was empty while
    // four bodies named a parent. A native-only reading finds nothing.
    const epics = findEpics(
      ["17", "18"],
      from({ "17": "", "18": child("17") }, {}),
    );
    expect(epics).toEqual([
      { id: "17", children: ["18"], openChildren: ["18"] },
    ]);
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
      { id: "1", children: ["20"], openChildren: ["20"] },
      { id: "2", children: ["10"], openChildren: ["10"] },
    ]);
  });

  // Children leave the ready set as they land. Counted only inside the set, a
  // spec whose tickets were all done became an ordinary wave-1 ticket.
  it("counts native children outside the set, and reads which are still open", () => {
    const epics = findEpics(["45"], {
      ...from({ "45": "" }, { "45": ["47", "48", "49"] }),
      state: (id) => (id === "48" ? "open" : "closed"),
    });
    expect(epics).toEqual([
      { id: "45", children: ["47", "48", "49"], openChildren: ["48"] },
    ]);
  });

  it("finds a parent named only by a closed ticket's body, through parentClaims", () => {
    const epics = findEpics(["80"], {
      ...from({ "80": "## Problem Statement\n\nA spec." }),
      parentClaims: () => [
        { id: "81", state: "closed", body: child("80") },
        { id: "82", state: "closed", body: child("80") },
        // A claim on a parent outside the set stays context.
        { id: "90", state: "open", body: child("70") },
        // GitHub's search matches the word, not the heading.
        { id: "91", state: "open", body: "The parent of this is unclear." },
      ],
    });
    expect(epics).toEqual([
      { id: "80", children: ["81", "82"], openChildren: [] },
    ]);
  });

  it("counts a child as open when its state cannot be read", () => {
    const epics = findEpics(["45"], {
      ...from({ "45": "" }, { "45": ["47"] }),
      state: () => {
        throw new Error("gone");
      },
    });
    expect(epics).toEqual([
      { id: "45", children: ["47"], openChildren: ["47"] },
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

  it("matches a claim on another repo's ticket to that edge, not to this repo's #n", () => {
    const edge = [{ id: "acme/api#140", state: "open" as const }];
    expect(B("## Blocked by\n\n- acme/api#140\n", edge)).toEqual([]);
    expect(B("## Blocked by\n\n- #140\n", edge)).toEqual(["140"]);
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
    // The #19 is under the heading, but the section opens with "None": it is
    // empty, whatever it goes on to mention.
    expect(B(body, [])).toEqual([]);
    expect(
      B("## Notes\n\nSupersedes #4.\n\n## Blocked by\n\nNone.\n", []),
    ).toEqual([]);
  });

  it("drops a claimed blocker that is closed, and keeps one that cannot be read", () => {
    const state = (id: string) =>
      ({ "18": "closed", "19": "open" })[id] as "open" | "closed" | undefined;
    expect(
      bodyOnlyBlockers("## Blocked by\n\n#18 #19 #999\n", [], N, "20", state),
    ).toEqual(["19", "999"]);
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
