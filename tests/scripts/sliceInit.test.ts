import { execFileSync, spawn, spawnSync } from "node:child_process";
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
import { type Shim, azelfFiles } from "@/scripts/slice-files";
import {
  EXCLUDE_BLOCK,
  GENERATED,
  SHIMS,
  agentFiles,
  hookBlock,
  hookStep,
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
  it("carries exactly the seventeen markers", () => {
    const patterns = EXCLUDE_BLOCK.split("\n").filter(
      (l) => l.length > 0 && !l.startsWith("#"),
    );
    expect(patterns).toEqual([
      ".slice-ticket.md",
      ".slice-parent.md",
      ".slice-refs.md",
      ".slice-landed.md",
      ".slice-baseline",
      ".slice-autostart",
      ".slice-live",
      ".slice-ready-to-land",
      ".slice-finished",
      ".slice-ports",
      ".slice-lock-wait",
      ".slice-flags",
      ".slice-retry",
      ".slice-run-mode",
      ".slice-interrupted",
      ".slice-hold",
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

  /** bash's TMOUT logs the shell out whatever it is doing: no watch there. */
  it("sets no idle watch under bash", () => {
    expect(sourceHookWithSession(0)).not.toContain("closes by itself");
  });
});

/**
 * v5's idle watch, in a real interactive zsh on a pty: zle runs the TMOUT alarm
 * only with a terminal, so piped input would test nothing. The block is the
 * installed one with TMOUT=15 cut to 1, to keep this short. The shell's pid is
 * the contract — the terminal closes the tab when it exits.
 */
describe("a landed slice's idle tab (hook v5, zsh)", () => {
  type Tab = {
    dir: string;
    wt: string;
    pid: number;
    output: () => string;
    type: (line: string) => void;
    close: () => void;
  };
  let tab: Tab | undefined;
  afterEach(() => {
    tab?.close();
    tab = undefined;
  });

  const alive = (pid: number) =>
    spawnSync("kill", ["-0", String(pid)]).status === 0;
  async function until(
    what: string | (() => string),
    ok: () => boolean,
    ms = 10_000,
  ) {
    const end = Date.now() + ms;
    while (!ok()) {
      if (Date.now() > end)
        throw new Error(
          `timed out waiting for ${typeof what === "string" ? what : what()}`,
        );
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  async function openTab(opts: { warp?: boolean; rcBefore?: string } = {}) {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "azelf-hook-pty-")));
    const wt = join(dir, "wt");
    mkdirSync(join(wt, "scripts"), { recursive: true });
    mkdirSync(join(dir, "zdot"));
    // The assignment, not the comment that names it.
    const setting = /^(\s+)TMOUT=15$/m;
    const block = hookBlock();
    expect(block).toMatch(setting);
    writeFileSync(
      join(dir, "zdot", ".zshrc"),
      `${opts.rcBefore ?? ""}\n${block.replace(
        setting,
        "$1TMOUT=1",
      )}\nprint -r -- $$ > ${dir}/pid\n`,
    );
    writeFileSync(
      join(wt, "scripts", "slice-session.sh"),
      "#!/bin/sh\necho SESSION RAN\nexit 0\n",
      { mode: 0o755 },
    );
    writeFileSync(join(wt, ".slice-autostart"), "21\n");
    // `cat |` because macOS `script` refuses a socket for stdin, and node's
    // pipes are sockets. Its own group, so closing the tab takes all of it.
    const script =
      process.platform === "darwin"
        ? "script -q /dev/null zsh -i"
        : "script -qc 'zsh -i' /dev/null";
    const child = spawn("sh", ["-c", `cat | ${script}`], {
      cwd: wt,
      detached: true,
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        ZDOTDIR: join(dir, "zdot"),
        TERM_PROGRAM: opts.warp ? "WarpTerminal" : "",
        WARP_BOOTSTRAPPED: opts.warp ? "1" : "",
        TMOUT: "",
      },
    });
    let out = "";
    child.stdout?.on("data", (d) => {
      out += d;
    });
    const pidFile = join(dir, "pid");
    await until(
      () => `the shell — output so far:\n${out}`,
      () => {
        try {
          return /^\d+$/.test(readFileSync(pidFile, "utf8").trim());
        } catch {
          return false;
        }
      },
    );
    const pid = Number(readFileSync(pidFile, "utf8").trim());
    tab = {
      dir,
      wt,
      pid,
      output: () => out,
      type: (line) => child.stdin?.write(`${line}\n`),
      close: () => {
        if (alive(pid)) spawnSync("kill", ["-9", String(pid)]);
        try {
          process.kill(-(child.pid as number), "SIGKILL");
        } catch {}
        rmSync(dir, { recursive: true, force: true });
      },
    };
    // Under Warp the session starts at the first prompt, not in the rc file.
    if (opts.warp) tab.type("true");
    await until(
      () => `the session — output so far:\n${out}`,
      () => out.includes("SESSION RAN"),
    );
    return tab;
  }

  it("exits once the slice's directory is gone, and says so first", async () => {
    const t = await openTab();
    await until("the line", () => t.output().includes("closes by itself"));
    await new Promise((r) => setTimeout(r, 1500));
    expect(alive(t.pid)).toBe(true);

    rmSync(t.wt, { recursive: true, force: true });
    await until("the shell to exit", () => !alive(t.pid));
  }, 30_000);

  it("under Warp, where the session ran from precmd, exits too", async () => {
    const t = await openTab({ warp: true });
    rmSync(t.wt, { recursive: true, force: true });
    await until("the shell to exit", () => !alive(t.pid));
  }, 30_000);

  it("keeps a shell that cd'ed out of the slice", async () => {
    const t = await openTab();
    t.type(`cd ${t.dir}`);
    await until("the cd", () => {
      const r = spawnSync(
        "lsof",
        ["-a", "-p", String(t.pid), "-d", "cwd", "-Fn"],
        {
          encoding: "utf8",
        },
      );
      return r.stdout.includes(`n${t.dir}\n`);
    });
    rmSync(t.wt, { recursive: true, force: true });
    await new Promise((r) => setTimeout(r, 3000));
    expect(alive(t.pid)).toBe(true);
  }, 30_000);

  it("keeps a shell with a job running in it", async () => {
    const t = await openTab();
    t.type("sleep 60 &");
    await until(
      "the job",
      () => spawnSync("pgrep", ["-P", String(t.pid), "sleep"]).status === 0,
    );
    rmSync(t.wt, { recursive: true, force: true });
    await new Promise((r) => setTimeout(r, 3000));
    expect(alive(t.pid)).toBe(true);
    spawnSync("pkill", ["-P", String(t.pid), "sleep"]);
  }, 30_000);

  it("is not set over a TMOUT the shell already has", async () => {
    const t = await openTab({ rcBefore: "TMOUT=300" });
    rmSync(t.wt, { recursive: true, force: true });
    await new Promise((r) => setTimeout(r, 3000));
    expect(alive(t.pid)).toBe(true);
    expect(t.output()).not.toContain("closes by itself");
  }, 30_000);
});

describe("init --hook against an installed block", () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "azelf-hook-home-"));
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  const v4 =
    "# ─── slice autostart v4 ───\necho old\n# ─── end slice autostart ───\n";

  it("names a v4 block as older, and --hook replaces it", () => {
    writeFileSync(join(home, ".zshrc"), `x=1\n${v4}`);
    const env = { SHELL: "/bin/zsh" };
    const version = hookVersion(hookBlock());
    expect(version).toBe("v5");

    const told = hookStep({ installHook: false, home, env });
    expect(told.line).toContain(
      `carries an OLDER block — rerun with --hook to replace it with ${version}`,
    );

    const wrote = hookStep({ installHook: true, home, env });
    expect(wrote.changed).toBe(true);
    const rc = readFileSync(join(home, ".zshrc"), "utf8");
    expect(rc).toContain("# ─── slice autostart v5");
    expect(rc).not.toContain("echo old");
    expect(rc.startsWith("x=1\n")).toBe(true);
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

  /**
   * The launcher: `./scripts/azelf run --plan`. `bunx azelf` in a repo with no
   * node_modules/.bin/azelf asks the registry, where the name is a stranger's
   * package, and consumer-b downloaded it. This one can reach nothing but the
   * package, and names the CLI, not a script, in its check and its exec.
   */
  it("the launcher runs bin/azelf.ts through bun", () => {
    const launcher = SHIMS.find((s) => s.name === "azelf");
    expect(launcher).toEqual({
      name: "azelf",
      how: "exec",
      target: "bin/azelf.ts",
      via: "bun",
    });
    const text = shimText({ ...(launcher as Shim), fallback: null });
    expect(text).toContain('exec bun "$_azelf_dir/bin/azelf.ts" "$@"');
    expect(text).toContain('if [ ! -f "$_azelf_dir/bin/azelf.ts" ]; then');
    expect(text).toContain("'bun' is not on PATH");
    expect(text).not.toContain('scripts/azelf"');
  });

  /** What the prep copies: every shim, the launcher among them, and both agent files. */
  it("lists every file init writes, for the prep", () => {
    expect(azelfFiles()).toEqual([
      ...SHIMS.map((s) => `scripts/${s.name}`),
      ".claude/commands/azelf.md",
      ".claude/skills/slice/SKILL.md",
    ]);
    expect(azelfFiles()).toContain("scripts/slice-gates.sh");
    expect(azelfFiles()).toContain("scripts/azelf");
    expect(azelfFiles()).not.toContain("slice.config.ts");
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

  /**
   * The error for a missing package says what to do in THIS repo. "run 'bun
   * install' here" is the wrong advice where azelf is no dependency: a Python
   * repo with no package.json, or an npm repo that runs azelf from a checkout.
   */
  describe("with no package to run", () => {
    let repo: string;
    const runShim = (env: Record<string, string> = {}) => {
      const r = spawnSync(join(repo, "scripts", "x.sh"), {
        cwd: repo,
        encoding: "utf8",
        env: { ...process.env, AZELF_DIR: "", ...env },
      });
      return { code: r.status, err: r.stderr };
    };

    beforeEach(() => {
      repo = realpathSync(mkdtempSync(join(tmpdir(), "azelf-shimmiss-")));
      mkdirSync(join(repo, "scripts"));
      writeFileSync(
        join(repo, "scripts", "x.sh"),
        shimText({ name: "x.sh", how: "exec", fallback: null }),
        { mode: 0o755 },
      );
    });
    afterEach(() => rmSync(repo, { recursive: true, force: true }));

    it("says to install it where package.json lists it", () => {
      writeFileSync(
        join(repo, "package.json"),
        '{ "devDependencies": { "@chintonicc/azelf": "github:chintonicc/azelf" } }',
      );

      const r = runShim();

      expect(r.code).toBe(1);
      expect(r.err).toContain("run 'bun install' here");
    });

    it("says to set AZELF_DIR where the repo does not depend on it", () => {
      for (const manifest of [
        null,
        '{ "devDependencies": { "vite": "^5" } }',
      ]) {
        rmSync(join(repo, "package.json"), { force: true });
        if (manifest) writeFileSync(join(repo, "package.json"), manifest);

        const r = runShim();

        expect(r.code).toBe(1);
        expect(r.err).not.toContain("bun install");
        expect(r.err).toContain("set AZELF_DIR to an azelf checkout");
      }
    });

    it("the launcher says the same, naming the CLI", () => {
      writeFileSync(
        join(repo, "scripts", "azelf"),
        shimText({
          name: "azelf",
          how: "exec",
          target: "bin/azelf.ts",
          via: "bun",
          fallback: null,
        }),
        { mode: 0o755 },
      );

      const r = spawnSync(join(repo, "scripts", "azelf"), ["run", "--plan"], {
        cwd: repo,
        encoding: "utf8",
        env: { ...process.env, AZELF_DIR: "" },
      });

      expect(r.status).toBe(1);
      expect(r.stderr).toContain(
        `no ${join(
          repo,
          "node_modules",
          "@chintonicc",
          "azelf",
          "bin",
          "azelf.ts",
        )}`,
      );
    });

    it("names AZELF_DIR when that is what points nowhere", () => {
      const empty = join(repo, "empty");
      mkdirSync(empty);

      const r = runShim({ AZELF_DIR: empty });

      expect(r.code).toBe(1);
      expect(r.err).toContain(`AZELF_DIR=${empty} is not`);
      expect(r.err).not.toContain("bun install");
    });
  });

  it("is valid bash for every kind", () => {
    const dir = mkdtempSync(join(tmpdir(), "azelf-shim-"));
    for (const how of ["source", "exec"] as const) {
      const f = join(dir, `${how}.sh`);
      writeFileSync(f, shimText({ name: "x.sh", how, fallback: "/opt/azelf" }));
      expect(() => execFileSync("bash", ["-n", f])).not.toThrow();
    }
    const launcher = join(dir, "azelf");
    writeFileSync(
      launcher,
      shimText({
        name: "azelf",
        how: "exec",
        target: "bin/azelf.ts",
        via: "bun",
        fallback: "/opt/azelf",
      }),
    );
    expect(() => execFileSync("bash", ["-n", launcher])).not.toThrow();
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
    expect(lines.join("\n")).toContain(
      ".git/info/exclude — 17 marker patterns",
    );
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

  /**
   * The launcher it wrote runs: this temp repo has no node_modules, so the
   * shim carries the fallback to this checkout, and `--help` is the CLI's.
   */
  it("writes a launcher that reaches the CLI", () => {
    const lines = run().map((r) => r.line);
    expect(lines.join("\n")).toMatch(/wrote +scripts\/azelf \(exec\)/);
    const out = execFileSync(join(dir, "scripts", "azelf"), ["--help"], {
      cwd: dir,
      encoding: "utf8",
      env: { ...process.env, AZELF_DIR: "" },
    });
    expect(out).toContain("usage:");
    expect(out).toContain("azelf run [args…]");
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

  // A session that runs slice-done.sh unasked lands and pushes a slice nobody
  // released. The "do not" half is what keeps a non---auto run in human hands.
  it("the skill finishes two ways: run slice-done.sh when told to, otherwise do not", () => {
    agentFiles(dir);
    const skill = readFileSync(
      join(dir, ".claude", "skills", "slice", "SKILL.md"),
      "utf8",
    );
    expect(skill).toContain("It told you to run `./scripts/slice-done.sh`.");
    expect(skill).toContain("It did not, or there was no start instruction.");
    expect(skill).toContain("Do **not** run it yourself");
    // The turn-is-over marker, which lands nothing, is how the second ending
    // is seen by the dispatcher — and how the stuck endings are.
    expect(skill).toContain("./scripts/slice-finished.sh -F - <<'EOF'");
    expect(skill).toContain("./scripts/slice-finished.sh --stuck -m");
    expect(
      SHIMS.some((s) => s.name === "slice-finished.sh" && s.how === "exec"),
    ).toBe(true);
  });

  // A session has the shims and not the binary, and it has no slice.config.ts
  // to read when that file is untracked: the skill names the one command and
  // points at no file.
  it("the skill names ./scripts/slice-gates.sh for the gates, and not slice.config.ts", () => {
    agentFiles(dir);
    const skill = readFileSync(
      join(dir, ".claude", "skills", "slice", "SKILL.md"),
      "utf8",
    );
    expect(skill).toContain("./scripts/slice-gates.sh");
    expect(skill).not.toContain("slice.config.ts");
    expect(
      SHIMS.some((s) => s.name === "slice-gates.sh" && s.how === "exec"),
    ).toBe(true);
  });

  // The hand push under the land lock is reached the same way from a checkout
  // without the binary on PATH.
  it("writes a shim for slice-push-main.sh", () => {
    expect(
      SHIMS.some((s) => s.name === "slice-push-main.sh" && s.how === "exec"),
    ).toBe(true);
  });

  // A session runs a command on its base through the shim, and the skill says
  // so, so it does not build a worktree of its own.
  it("writes a shim for slice-on-base.sh, and the skill names it", () => {
    expect(
      SHIMS.some((s) => s.name === "slice-on-base.sh" && s.how === "exec"),
    ).toBe(true);
    agentFiles(dir);
    const skill = readFileSync(
      join(dir, ".claude", "skills", "slice", "SKILL.md"),
      "utf8",
    );
    expect(skill).toContain("./scripts/slice-on-base.sh -- ");
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
