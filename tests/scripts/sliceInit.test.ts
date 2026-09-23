import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  EXCLUDE_BLOCK,
  GENERATED,
  agentFiles,
  hookBlock,
  hookVersion,
  init,
  shimText,
  upsertBlock,
} from "@/scripts/slice-init";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const BEGIN = "# ─── azelf ──────";
const END = "# ─── end azelf ──";

describe("upsertBlock", () => {
  it("appends when no block is present", () => {
    const { text, changed } = upsertBlock(
      "x\n",
      BEGIN,
      END,
      `${BEGIN}\na\n${END}`,
    );
    expect(changed).toBe(true);
    expect(text).toContain("x\n");
    expect(text).toContain("a\n");
  });

  it("replaces in place rather than appending a second copy", () => {
    const first = upsertBlock("", BEGIN, END, `${BEGIN}\na\n${END}`).text;
    const second = upsertBlock(first, BEGIN, END, `${BEGIN}\nb\n${END}`).text;
    expect(second.split(BEGIN)).toHaveLength(2);
    expect(second).toContain("b");
    expect(second).not.toContain("\na\n");
  });

  it("is idempotent — rewriting the same block changes nothing", () => {
    const block = `${BEGIN}\na\n${END}`;
    const first = upsertBlock("head\n", BEGIN, END, block).text;
    const again = upsertBlock(first, BEGIN, END, block);
    expect(again.changed).toBe(false);
    expect(again.text).toBe(first);
  });

  /**
   * The delimiters in the real blocks are followed by box-drawing rules, so a
   * naive `to + end.length` leaves a row of stray `─` behind — and leaves one
   * more on every subsequent run.
   */
  it("cuts to the end of the delimiter LINE, not the delimiter string", () => {
    const existing = `pre\n${BEGIN}────\nold\n${END}────────\npost\n`;
    const { text } = upsertBlock(existing, BEGIN, END, `${BEGIN}\nnew\n${END}`);
    expect(text).toBe(`pre\n${BEGIN}\nnew\n${END}\npost\n`);
    // The trailing rules from the OLD delimiter lines are gone; the ones the
    // new block brings with it are its own.
    expect(text).not.toContain("────────");
  });

  it("keeps what follows the block", () => {
    const existing = `${BEGIN}\nold\n${END}\nkeep me\n`;
    const { text } = upsertBlock(existing, BEGIN, END, `${BEGIN}\nnew\n${END}`);
    expect(text).toContain("keep me");
  });
});

describe("the exclude block", () => {
  it("carries exactly the nine markers", () => {
    const patterns = EXCLUDE_BLOCK.split("\n").filter(
      (l) => l.length > 0 && !l.startsWith("#"),
    );
    expect(patterns).toEqual([
      ".slice-ticket.md",
      ".slice-autostart",
      ".slice-live",
      ".slice-ready-to-land",
      ".slice-lock-wait",
      ".slice-flags",
      ".slice-retry",
      ".slice-interrupted",
      ".slice-reviews/",
    ]);
  });

  /** The whole reason this is not `.gitignore`. If the explanation goes, the reason goes. */
  it("says why it is not in .gitignore", () => {
    expect(EXCLUDE_BLOCK).toContain("fingerprint");
  });
});

describe("the hook block", () => {
  it("is delimited and versioned", () => {
    const block = hookBlock();
    expect(hookVersion(block)).toMatch(/^v\d+$/);
    expect(block.trimEnd().endsWith("─")).toBe(true);
  });

  /** Commentary after the end delimiter is for the package, not for someone's rc file. */
  it("stops at the end delimiter", () => {
    expect(hookBlock()).not.toContain("LOAD-BEARING");
  });

  it("is valid sh", () => {
    const dir = mkdtempSync(join(tmpdir(), "azelf-hook-"));
    const f = join(dir, "hook.sh");
    writeFileSync(f, hookBlock());
    expect(() => execFileSync("sh", ["-n", f])).not.toThrow();
    rmSync(dir, { recursive: true, force: true });
  });

  /**
   * The tab-closing half, run for real rather than grepped for: the block is
   * sourced by an INTERACTIVE sh (it guards on `$-`, so a non-interactive one
   * would skip the whole thing and every case below would pass vacuously) in a
   * directory carrying a marker and a stub session script of a chosen exit
   * status. Whether the shell survives is the entire contract — that is what
   * the terminal closes the tab on.
   */
  const sourceHookWithSession = (status: number): string => {
    const dir = mkdtempSync(join(tmpdir(), "azelf-hook-run-"));
    const wt = join(dir, "wt");
    mkdirSync(join(wt, "scripts"), { recursive: true });
    writeFileSync(join(dir, "hook.sh"), hookBlock());
    writeFileSync(
      join(wt, "scripts", "slice-session.sh"),
      `#!/bin/sh\necho "SESSION RAN $1"\nexit ${status}\n`,
      { mode: 0o755 },
    );
    writeFileSync(join(wt, ".slice-autostart"), "21\n");
    const out = execFileSync("sh", ["-i"], {
      cwd: wt,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "ignore"],
      input: `. ${join(dir, "hook.sh")}\necho STILL_AT_PROMPT\n`,
    });
    rmSync(dir, { recursive: true, force: true });
    return out;
  };

  /**
   * Under Warp the session must wait for the bootstrap: an exit before it is,
   * to Warp, a shell that crashed starting up, and the tab stays. zsh, the
   * marker read and deleted at rc time, the session run from precmd at the
   * first prompt after WARP_BOOTSTRAPPED — simulated here as a later line.
   */
  const zshUnderWarp = (status: number, termProgram = "WarpTerminal") => {
    const dir = mkdtempSync(join(tmpdir(), "azelf-hook-warp-"));
    const wt = join(dir, "wt");
    mkdirSync(join(wt, "scripts"), { recursive: true });
    writeFileSync(join(dir, "hook.sh"), hookBlock());
    writeFileSync(
      join(wt, "scripts", "slice-session.sh"),
      `#!/bin/sh\necho "SESSION RAN $1"\nexit ${status}\n`,
      { mode: 0o755 },
    );
    writeFileSync(join(wt, ".slice-autostart"), "21\n");
    const out = execFileSync("zsh", ["-f", "-i"], {
      cwd: wt,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "ignore"],
      env: { ...process.env, TERM_PROGRAM: termProgram, WARP_BOOTSTRAPPED: "" },
      input: `. ${join(
        dir,
        "hook.sh",
      )}\necho AFTER_RC\n[ -f .slice-autostart ] || echo MARKER_GONE\nWARP_BOOTSTRAPPED=1\necho AFTER_BOOTSTRAP\necho STILL_AT_PROMPT\n`,
    })
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => /^(SESSION|AFTER|MARKER|STILL)/.test(l));
    rmSync(dir, { recursive: true, force: true });
    return out;
  };

  it("under Warp, starts the session only after the bootstrap", () => {
    expect(zshUnderWarp(0)).toEqual([
      "AFTER_RC",
      "MARKER_GONE",
      "SESSION RAN 21",
      "AFTER_BOOTSTRAP",
      "STILL_AT_PROMPT",
    ]);
  });

  it("under Warp, ends the shell on 86 after the bootstrap", () => {
    expect(zshUnderWarp(86)).toEqual([
      "AFTER_RC",
      "MARKER_GONE",
      "SESSION RAN 21",
    ]);
  });

  it("outside Warp, zsh still starts the session at once", () => {
    expect(zshUnderWarp(0, "Apple_Terminal")[0]).toBe("SESSION RAN 21");
  });

  it("runs the session script named by the marker", () => {
    expect(sourceHookWithSession(0)).toContain("SESSION RAN 21");
  });

  /** 86 is slice-session.sh saying "--self-land, agent clean — close the tab". */
  it("ends the shell on 86, which is what closes the tab", () => {
    expect(sourceHookWithSession(86)).not.toContain("STILL_AT_PROMPT");
  });

  /**
   * A human is reading this tab, or the agent died in it. Either way the tab
   * holds the only copy of what happened, so it stays.
   */
  it("leaves the shell alive on every other status", () => {
    expect(sourceHookWithSession(0)).toContain("STILL_AT_PROMPT");
    expect(sourceHookWithSession(1)).toContain("STILL_AT_PROMPT");
    expect(sourceHookWithSession(130)).toContain("STILL_AT_PROMPT");
  });
});

describe("shimText", () => {
  it("sources the sourced ones and execs the rest", () => {
    expect(
      shimText({ name: "slice-config.sh", how: "source", fallback: null }),
    ).toContain('source "$_azelf_dir/scripts/slice-config.sh"');
    expect(
      shimText({ name: "slice-done.sh", how: "exec", fallback: null }),
    ).toContain('exec "$_azelf_dir/scripts/slice-done.sh" "$@"');
  });

  /** A sourced shim that called `exit` would kill the caller's interactive shell. */
  it("returns rather than exits when it is sourced", () => {
    const sourced = shimText({ name: "a.sh", how: "source", fallback: null });
    expect(sourced).toContain("return 1");
    expect(sourced).not.toContain("exit 1");
  });

  /**
   * The usage line a shim produces must name the command you actually typed.
   * `exec -a` cannot deliver this — a shebang makes bash reset `$0` to the
   * script path — so the name travels in the environment instead.
   */
  it("exports the invoked name so messages do not point into node_modules", () => {
    expect(shimText({ name: "a.sh", how: "exec", fallback: null })).toContain(
      'export AZELF_INVOKED_AS="$0"',
    );
  });

  it("resolves by rule, and records an absolute path only as a fallback", () => {
    const byRule = shimText({ name: "a.sh", how: "exec", fallback: null });
    expect(byRule).toContain("node_modules/@chintonicc/azelf");
    expect(byRule).not.toContain("_azelf_dir=/");
    const withFallback = shimText({
      name: "a.sh",
      how: "exec",
      fallback: "/opt/azelf",
    });
    expect(withFallback).toContain('_azelf_dir="/opt/azelf"');
  });

  /**
   * One version per wave: a worktree's `bun install` can leave a stale copy
   * of a git dependency, so a shim in a slice worktree runs the MAIN
   * checkout's package, and its own only when main has none. Each fake
   * package answers with where it lives.
   */
  describe("in a slice worktree", () => {
    let root: string;
    const g = (cwd: string, ...args: string[]) =>
      execFileSync(
        "git",
        ["-c", "user.email=t@t", "-c", "user.name=t", "-C", cwd, ...args],
        { stdio: "ignore" },
      );
    const fakePackage = (repo: string, answer: string) => {
      const d = join(repo, "node_modules", "@chintonicc", "azelf", "scripts");
      mkdirSync(d, { recursive: true });
      writeFileSync(join(d, "x.sh"), `#!/usr/bin/env bash\necho ${answer}\n`, {
        mode: 0o755,
      });
    };
    const runShim = (repo: string, env: Record<string, string> = {}) =>
      execFileSync(join(repo, "scripts", "x.sh"), {
        cwd: repo,
        encoding: "utf8",
        env: { ...process.env, AZELF_DIR: "", ...env },
      }).trim();

    beforeEach(() => {
      root = realpathSync(mkdtempSync(join(tmpdir(), "azelf-shimwt-")));
      const main = join(root, "main");
      mkdirSync(join(main, "scripts"), { recursive: true });
      writeFileSync(
        join(main, "scripts", "x.sh"),
        shimText({ name: "x.sh", how: "exec", fallback: null }),
        { mode: 0o755 },
      );
      writeFileSync(join(main, ".gitignore"), "node_modules/\n");
      g(root, "init", "-q", "-b", "main", "main");
      g(main, "add", "-A");
      g(main, "commit", "-qm", "init");
      g(main, "worktree", "add", "-q", join(root, "wt"), "-b", "ticket/1");
      fakePackage(join(root, "wt"), "worktree");
    });
    afterEach(() => rmSync(root, { recursive: true, force: true }));

    it("runs the main checkout's package, not the worktree's own", () => {
      fakePackage(join(root, "main"), "main");
      expect(runShim(join(root, "wt"))).toBe("main");
    });

    it("falls back to the worktree's own when main has none", () => {
      expect(runShim(join(root, "wt"))).toBe("worktree");
    });

    it("AZELF_DIR still wins", () => {
      fakePackage(join(root, "main"), "main");
      const other = join(root, "other");
      fakePackage(other, "other");
      expect(
        runShim(join(root, "wt"), {
          AZELF_DIR: join(other, "node_modules", "@chintonicc", "azelf"),
        }),
      ).toBe("other");
    });
  });

  it("is valid bash for both kinds", () => {
    const dir = mkdtempSync(join(tmpdir(), "azelf-shim-"));
    for (const how of ["source", "exec"] as const) {
      const f = join(dir, `${how}.sh`);
      writeFileSync(f, shimText({ name: "x.sh", how, fallback: "/opt/azelf" }));
      expect(() => execFileSync("bash", ["-n", f])).not.toThrow();
    }
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("init, against a real git repo", () => {
  let dir: string;
  const env = { SHELL: "/bin/zsh" } as NodeJS.ProcessEnv;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "azelf-init-"));
    execFileSync("git", ["init", "-q", dir]);
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const run = () =>
    init({ cwd: dir, installHook: false, home: join(dir, "home"), env });

  it("writes the markers, the shims and a starter config", () => {
    const lines = run().map((r) => r.line);
    expect(lines.join("\n")).toContain(".git/info/exclude — 9 marker patterns");
    expect(
      readFileSync(join(dir, ".git", "info", "exclude"), "utf8"),
    ).toContain(".slice-autostart");
    expect(
      readFileSync(join(dir, "scripts", "session-commit.sh"), "utf8"),
    ).toContain("_azelf_dir");
    expect(readFileSync(join(dir, "slice.config.ts"), "utf8")).toContain(
      "satisfies SliceConfig",
    );
  });

  it("changes nothing on a second run", () => {
    run();
    expect(run().filter((r) => r.changed)).toEqual([]);
  });

  /** A config someone has edited is theirs. init must never overwrite it. */
  it("never overwrites an existing slice.config.ts", () => {
    writeFileSync(join(dir, "slice.config.ts"), "// mine\n");
    run();
    expect(readFileSync(join(dir, "slice.config.ts"), "utf8")).toBe(
      "// mine\n",
    );
  });

  it("does not touch the rc file without --hook", () => {
    const line = run().find((r) => r.line.startsWith("hook"));
    expect(line?.changed).toBe(false);
    expect(line?.line).toContain("--hook");
  });

  it("names the shell when it has no rc file for it", () => {
    const out = init({
      cwd: dir,
      installHook: false,
      home: join(dir, "home"),
      env: { SHELL: "/usr/bin/fish-but-not-really" } as NodeJS.ProcessEnv,
    });
    expect(out.find((r) => r.line.startsWith("hook"))?.line).toContain(
      "fish-but-not-really",
    );
  });
});

describe("the agent-facing files", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "azelf-agent-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("installs the command and the skill", () => {
    const out = agentFiles(dir);
    expect(out.every((r) => r.changed)).toBe(true);
    expect(
      readFileSync(join(dir, ".claude", "commands", "azelf.md"), "utf8"),
    ).toContain("--plan");
    expect(
      readFileSync(join(dir, ".claude", "skills", "slice", "SKILL.md"), "utf8"),
    ).toContain("slice-done.sh");
  });

  it("changes nothing on a second run", () => {
    agentFiles(dir);
    expect(agentFiles(dir).filter((r) => r.changed)).toEqual([]);
  });

  /**
   * The whole point of the marker. A file you have edited is yours; init may
   * upgrade only what it wrote itself.
   */
  it("leaves an edited file alone and says so", () => {
    agentFiles(dir);
    const dest = join(dir, ".claude", "commands", "azelf.md");
    writeFileSync(dest, "# mine\n");
    const out = agentFiles(dir);
    expect(readFileSync(dest, "utf8")).toBe("# mine\n");
    expect(out.some((r) => r.line.startsWith("yours"))).toBe(true);
  });

  it("upgrades a stale copy it recognises as its own", () => {
    const dest = join(dir, ".claude", "commands", "azelf.md");
    agentFiles(dir);
    writeFileSync(dest, `old text\n<!-- ${GENERATED} -->\n`);
    const out = agentFiles(dir);
    expect(
      out.some((r) => r.line === "wrote    .claude/commands/azelf.md"),
    ).toBe(true);
    expect(readFileSync(dest, "utf8")).toContain("--plan");
  });

  /** Both shipped files must carry the marker, or init can never upgrade them. */
  it("ships files that carry the marker", () => {
    agentFiles(dir);
    for (const f of [
      join(dir, ".claude", "commands", "azelf.md"),
      join(dir, ".claude", "skills", "slice", "SKILL.md"),
    ]) {
      expect(readFileSync(f, "utf8")).toContain(GENERATED);
    }
  });
});
