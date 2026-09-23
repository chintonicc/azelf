import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AZELF, type Consumer, makeConsumer, shResult } from "./fixture";

/**
 * slice-session.sh names the tab after the ticket (and the spec it hangs
 * under) and tells Claude Code not to rename it. The fake agent records the
 * variable it was launched with and exits, so the session runs to the end
 * synchronously; the title is the OSC 2 sequence in the session's output.
 */

let fx: Consumer | undefined;

afterEach(() => {
  if (fx) rmSync(fx.root, { recursive: true, force: true });
  fx = undefined;
});

const OSC = (title: string) => `\x1b]2;${title}\x07`;

function session(opts: Parameters<typeof makeConsumer>[0]) {
  fx = makeConsumer({
    worktrees: [40],
    agent: [
      "bash",
      "-c",
      'printf "%s" "${CLAUDE_CODE_DISABLE_TERMINAL_TITLE:-unset}" > .agent-env',
    ],
    ...opts,
  });
  const r = shResult(fx.main, "./scripts/slice-session.sh 40");
  expect(r.ok, r.out).toBe(true);
  const agentEnv = readFileSync(join(fx.wt(40), ".agent-env"), "utf8");
  return { out: r.out, agentEnv };
}

describe("slice-session.sh names the tab", () => {
  it("parent › ticket title by default, and keeps Claude Code from renaming it", () => {
    const { out, agentEnv } = session({
      title: "Add export button",
      body: "Some text.\n\n## Parent\n\n#17\n",
    });
    expect(out).toContain(OSC("#17 › #40 Add export button"));
    expect(agentEnv).toBe("1");
  });

  it("just the ticket when it names no parent", () => {
    const { out } = session({ title: "Add export button" });
    expect(out).toContain(OSC("#40 Add export button"));
  });

  it("tabTitle: false leaves the tab, and the agent's own titles, alone", () => {
    const { out, agentEnv } = session({ configExtra: "tabTitle: false," });
    expect(out).not.toContain("\x1b]2;");
    expect(agentEnv).toBe("unset");
  });

  it("a tabTitle function decides the text", () => {
    const { out } = session({
      title: "Add export button",
      body: "## Parent\n#17\n",
      configExtra:
        "tabTitle: ({ ref, title, parentRef }) => `[${parentRef}] ${title} (${ref})`,",
    });
    expect(out).toContain(OSC("[#17] Add export button (#40)"));
  });

  it("control characters in a tracker title never reach the terminal, in the title or the log", () => {
    const { out } = session({ title: "evil\x07\x1b]0;pwned\x1b\\ title\n" });
    expect(out).toContain(OSC("#40 evil ]0;pwned \\ title"));
    expect(out).toContain('#40 "evil ]0;pwned \\ title" is ready');
    expect(out).not.toContain("pwned\x1b");
    expect(out).not.toContain("\x1b]0;");
  });

  it("a tracker that cannot answer costs the tab its name, not the session", () => {
    fx = makeConsumer({
      worktrees: [40],
      agent: ["true"],
      configExtra: 'tabTitle: () => { throw new Error("tracker down"); },',
    });
    const r = shResult(fx.main, "./scripts/slice-session.sh 40");
    expect(r.ok, r.out).toBe(true);
    expect(r.out).not.toContain("\x1b]2;");
    expect(r.out).toContain("── launching fake");
  });

  it("a tabTitle that is neither false nor a function is a config error", () => {
    fx = makeConsumer({ configExtra: 'tabTitle: "x" as never,' });
    const r = shResult(
      fx.main,
      `bun ${JSON.stringify(join(AZELF, "scripts", "slice-config.ts"))} --sh`,
    );
    expect(r.ok).toBe(false);
    expect(r.out).toContain("tabTitle must be a function");
  });
});
