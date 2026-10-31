import { type Which, claude, codex, custom } from "@/scripts/slice-agent";
import { describe, expect, it } from "vitest";

const present: Which = () => true;
const absent: Which = () => false;

describe("claude", () => {
  it("starts a session with the bare binary, prompt appended by the shell", () => {
    expect(claude({ which: present }).sessionCommand).toEqual(["claude"]);
  });

  it("carries session flags into the prefix, in order", () => {
    expect(
      claude({
        which: present,
        sessionFlags: ["--permission-mode", "acceptEdits"],
      }).sessionCommand,
    ).toEqual(["claude", "--permission-mode", "acceptEdits"]);
  });

  it("reviews headlessly with -p, and no MCP servers", () => {
    expect(claude({ which: present }).review("why")).toEqual([
      "claude",
      "-p",
      "--strict-mcp-config",
      "why",
    ]);
  });

  it("resolves with tools, and says so with the permission flag", () => {
    expect(claude({ which: present }).resolve?.("fix it")).toEqual([
      "claude",
      "-p",
      "--strict-mcp-config",
      "--permission-mode",
      "acceptEdits",
      "fix it",
    ]);
  });

  /**
   * The resolver may run only what the config names. The flag is variadic,
   * so it comes before `-p`, which ends it: after the prompt it would take
   * the prompt as a tool name. A prefix with a space is one pattern.
   */
  it("allows the configured commands to the resolver, before -p, one pattern each", () => {
    expect(
      claude({ which: present }).resolve?.("fix it", {
        commands: ["npm run test", "pytest"],
      }),
    ).toEqual([
      "claude",
      "--allowedTools",
      "Bash(npm run test:*)",
      "Bash(pytest:*)",
      "-p",
      "--strict-mcp-config",
      "--permission-mode",
      "acceptEdits",
      "fix it",
    ]);
    expect(
      claude({ which: present }).resolve?.("fix it", { commands: [] }),
    ).not.toContain("--allowedTools");
  });

  it("lets the reviewer read the configured directories, before -p", () => {
    expect(
      claude({ which: present }).review("why", {
        readDirs: ["/srv/api", "/srv/specs"],
      }),
    ).toEqual([
      "claude",
      "--add-dir",
      "/srv/api",
      "/srv/specs",
      "-p",
      "--strict-mcp-config",
      "why",
    ]);
    // And never the write permission, however far it may read.
    expect(
      claude({ which: present }).review("why", { readDirs: ["/srv/api"] }),
    ).not.toContain("--permission-mode");
  });

  /**
   * The two headless capabilities are not one capability. A reviewer that can
   * edit the tree is a reviewer that can make its own findings go away, so the
   * review argv must stay the one without write permission.
   */
  /**
   * Neither headless run uses an MCP server, and the session is where the
   * consumer's servers are wanted.
   */
  it("loads no MCP servers headlessly, and every one in the session", () => {
    const a = claude({ which: present });
    expect(a.review("why")).not.toContain("--mcp-config");
    expect(a.resolve?.("fix it")).not.toContain("--mcp-config");
    expect(a.sessionCommand).not.toContain("--strict-mcp-config");
  });

  it("keeps the review argv free of the write permission", () => {
    expect(claude({ which: present }).review("why")).not.toContain(
      "--permission-mode",
    );
  });

  it("names the missing binary rather than saying 'not found'", () => {
    const p = claude({ which: absent, bin: "claude-next" }).problem();
    expect(p).toContain("claude-next");
    expect(p).toContain("not on PATH");
  });

  it("has no problem when the binary is there", () => {
    expect(claude({ which: present }).problem()).toBeNull();
  });
});

describe("codex", () => {
  it("passes the opening instruction as a trailing argument", () => {
    expect(codex({ which: present }).sessionCommand).toEqual(["codex"]);
  });

  /**
   * The refusal is the feature. An unverified headless mode that returns prose
   * without a parseable VERDICT line is read as BLOCK, which stalls every land
   * — strictly worse than declaring no headless mode at all.
   */
  it("declines to review by default", () => {
    expect(codex({ which: present }).review("why")).toBeNull();
  });

  it("reviews once headless is explicitly enabled", () => {
    expect(codex({ which: present, headless: true }).review("why")).toEqual([
      "codex",
      "exec",
      "why",
    ]);
  });

  /**
   * And `headless: true` does not grant it either: an unverified resolver does
   * not fail the way an unverified reviewer does — it fails with a half-rebased
   * worktree.
   */
  it("declares no resolver at all, headless or not", () => {
    expect(codex({ which: present }).resolve).toBeUndefined();
    expect(codex({ which: present, headless: true }).resolve).toBeUndefined();
  });

  it("reports a missing binary", () => {
    expect(codex({ which: absent }).problem()).toContain("codex");
  });
});

describe("custom", () => {
  it("describes an agent this file has never heard of", () => {
    const a = custom({
      name: "aider",
      sessionCommand: ["aider", "--message"],
      which: present,
    });
    expect(a.name).toBe("aider");
    expect(a.sessionCommand).toEqual(["aider", "--message"]);
    expect(a.problem()).toBeNull();
  });

  it("probes the first word of sessionCommand for the binary", () => {
    expect(
      custom({
        name: "aider",
        sessionCommand: ["aider"],
        which: absent,
      }).problem(),
    ).toContain("aider");
  });

  it("has no headless mode unless one is given", () => {
    expect(
      custom({ name: "a", sessionCommand: ["a"], which: present }).review("x"),
    ).toBeNull();
    expect(
      custom({
        name: "a",
        sessionCommand: ["a"],
        review: (p) => ["a", "--headless", p],
        which: present,
      }).review("x"),
    ).toEqual(["a", "--headless", "x"]);
  });

  it("passes a resolver through, and stays valid without one", () => {
    expect(
      custom({ name: "a", sessionCommand: ["a"], which: present }).resolve,
    ).toBeUndefined();
    expect(
      custom({
        name: "a",
        sessionCommand: ["a"],
        resolve: (p) => ["a", "--write", p],
        which: present,
      }).resolve?.("x"),
    ).toEqual(["a", "--write", "x"]);
  });

  it("hands the options through to a custom headless run that wants them", () => {
    const a = custom({
      name: "a",
      sessionCommand: ["a"],
      review: (p, o) => ["a", ...(o?.readDirs ?? []), p],
      resolve: (p, o) => ["a", ...(o?.commands ?? []), p],
      which: present,
    });
    expect(a.review("x", { readDirs: ["/d"] })).toEqual(["a", "/d", "x"]);
    expect(a.resolve?.("x", { commands: ["t"] })).toEqual(["a", "t", "x"]);
  });

  it("refuses an empty sessionCommand rather than building a broken agent", () => {
    expect(() => custom({ name: "a", sessionCommand: [] })).toThrow(
      /must name a binary/,
    );
  });
});
