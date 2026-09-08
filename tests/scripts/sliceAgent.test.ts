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

  it("reviews headlessly with -p", () => {
    expect(claude({ which: present }).review("why")).toEqual([
      "claude",
      "-p",
      "why",
    ]);
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

  it("refuses an empty sessionCommand rather than building a broken agent", () => {
    expect(() => custom({ name: "a", sessionCommand: [] })).toThrow(
      /must name a binary/,
    );
  });
});
