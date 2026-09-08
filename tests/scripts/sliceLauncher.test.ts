import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AUTOSTART_MARKER,
  type Session,
  type Spawn,
  autostartHook,
  manual,
  rcFilesFor,
  shellLine,
  shellWord,
  tmux,
  warp,
} from "@/scripts/slice-launcher";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

/**
 * No terminal is opened here. Every launcher is driven through a scripted
 * spawn, the same way the gates use a scripted exec and the tracker a
 * scripted gh, and the assertions are about the CONTRACT in
 * scripts/slice-launcher.ts's header: what each launcher declares it carries,
 * that a missing hook is detected by name and never assumed, that the grace
 * window is the launcher's, and that a failed launch throws rather than
 * reporting sessions that were never opened.
 */

/** Answers keyed by the first two words of the command; records every call. */
function fakeSpawn(answers: Record<string, { ok: boolean; out?: string }>): {
  spawn: Spawn;
  calls: string[][];
} {
  const calls: string[][] = [];
  const spawn: Spawn = (cmd) => {
    calls.push(cmd);
    const a =
      answers[cmd.slice(0, 2).join(" ")] ??
      answers[cmd[0] as string] ??
      ({ ok: true } as { ok: boolean; out?: string });
    return { ok: a.ok, out: a.out ?? "" };
  };
  return { spawn, calls };
}

let home: string;
let sessions: Session[];

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "slice-launcher-"));
  sessions = ["3", "4"].map((id) => {
    const dir = join(home, `wt-${id}`);
    mkdirSync(dir);
    return {
      id,
      ref: `#${id}`,
      dir,
      cmd: ["/repo/scripts/slice-session.sh", id, "--self-land"],
    };
  });
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

const warpEnv = { TERM_PROGRAM: "WarpTerminal", SHELL: "/bin/zsh" };

describe("shell quoting — what a pasted or exec'd command line has to survive", () => {
  it("leaves plain words alone and quotes the rest", () => {
    expect(shellWord("/repo/scripts/slice-session.sh")).toBe(
      "/repo/scripts/slice-session.sh",
    );
    expect(shellWord("--self-land")).toBe("--self-land");
    expect(shellWord("ENG-123")).toBe("ENG-123");
    expect(shellWord("/Users/me/My Projects/x")).toBe(
      "'/Users/me/My Projects/x'",
    );
    expect(shellWord("it's")).toBe("'it'\\''s'");
    expect(shellLine(["a", "b c", "--d"])).toBe("a 'b c' --d");
  });
});

describe("manual() — the default", () => {
  it("declares that it carries the command, and needs nothing", () => {
    const m = manual();
    expect(m.name).toBe("manual");
    expect(m.starts).toBe("command");
    expect(m.problem()).toBeNull();
  });

  it("prints one pasteable command per session, flags included, and opens nothing", () => {
    const lines = manual().open(sessions);
    expect(lines[0]).toMatch(/open these yourself/);
    expect(lines.slice(1)).toEqual([
      "    /repo/scripts/slice-session.sh 3 --self-land",
      "    /repo/scripts/slice-session.sh 4 --self-land",
    ]);
    for (const s of sessions) {
      expect(existsSync(join(s.dir, AUTOSTART_MARKER))).toBe(false);
    }
  });

  it("gives a human long enough to paste before the dispatcher asks again", () => {
    expect(manual().startingGraceMs).toBeGreaterThanOrEqual(5 * 60_000);
  });
});

describe("autostartHook() — a missing hook is detected by name, never assumed", () => {
  it("knows where zsh, bash and fish read their rc, and honours ZDOTDIR / XDG_CONFIG_HOME", () => {
    expect(rcFilesFor("/bin/zsh", "/h", {})).toEqual(["/h/.zshrc"]);
    expect(rcFilesFor("zsh", "/h", { ZDOTDIR: "/z" })).toEqual(["/z/.zshrc"]);
    expect(rcFilesFor("/bin/bash", "/h", {})).toEqual([
      "/h/.bashrc",
      "/h/.bash_profile",
      "/h/.profile",
    ]);
    expect(rcFilesFor("/opt/homebrew/bin/fish", "/h", {})).toEqual([
      "/h/.config/fish/config.fish",
    ]);
    expect(rcFilesFor("fish", "/h", { XDG_CONFIG_HOME: "/x" })).toEqual([
      "/x/fish/config.fish",
    ]);
    expect(rcFilesFor("/bin/tcsh", "/h", {})).toBeNull();
  });

  it("finds the hook in ~/.zshrc for zsh", () => {
    writeFileSync(
      join(home, ".zshrc"),
      `# stuff\nif [ -f "$PWD/${AUTOSTART_MARKER}" ]; then :; fi\n`,
    );
    expect(autostartHook({ shell: "/bin/zsh", home, env: {} })).toEqual({
      installed: true,
      file: join(home, ".zshrc"),
    });
  });

  it("finds it in any of bash's three files", () => {
    writeFileSync(join(home, ".bash_profile"), `${AUTOSTART_MARKER}\n`);
    expect(autostartHook({ shell: "/bin/bash", home, env: {} })).toEqual({
      installed: true,
      file: join(home, ".bash_profile"),
    });
  });

  it("says which files it looked in when the hook is absent", () => {
    writeFileSync(join(home, ".zshrc"), "# nothing here\n");
    const r = autostartHook({ shell: "/bin/zsh", home, env: {} });
    expect(r.installed).toBe(false);
    if (r.installed) return;
    expect(r.why).toContain(join(home, ".zshrc"));
    expect(r.why).toContain("scripts/slice-autostart.sh");

    const b = autostartHook({ shell: "/bin/bash", home, env: {} });
    expect(b.installed).toBe(false);
    if (b.installed) return;
    expect(b.why).toContain(".bashrc");
    expect(b.why).toContain(".bash_profile");
  });

  it("answers for fish: honours a hook the user wrote, and says plainly that none ships", () => {
    const cfg = join(home, ".config", "fish");
    mkdirSync(cfg, { recursive: true });
    const absent = autostartHook({ shell: "/usr/bin/fish", home, env: {} });
    expect(absent.installed).toBe(false);
    if (absent.installed) return;
    expect(absent.why).toContain("config.fish");
    expect(absent.why).toMatch(/no fish version ships/);

    writeFileSync(
      join(cfg, "config.fish"),
      `# my own ${AUTOSTART_MARKER} hook\n`,
    );
    expect(autostartHook({ shell: "/usr/bin/fish", home, env: {} })).toEqual({
      installed: true,
      file: join(cfg, "config.fish"),
    });
  });

  it("fails loudly for a shell it does not know, and for no shell at all", () => {
    const t = autostartHook({ shell: "/bin/tcsh", home, env: {} });
    expect(t.installed).toBe(false);
    if (t.installed) return;
    expect(t.why).toContain("tcsh");

    const u = autostartHook({ shell: undefined, home, env: {} });
    expect(u.installed).toBe(false);
    if (u.installed) return;
    expect(u.why).toContain("$SHELL is unset");
  });
});

describe("warp()", () => {
  it("declares the marker protocol and a grace window that covers a shell startup", () => {
    const w = warp({ spawn: fakeSpawn({}).spawn, env: warpEnv, home });
    expect(w.name).toBe("warp");
    expect(w.starts).toBe("marker");
    expect(w.startingGraceMs).toBeGreaterThan(
      tmux({ spawn: fakeSpawn({}).spawn }).startingGraceMs,
    );
  });

  it("is a problem outside Warp — the sniff is a check now, not the selector", () => {
    const { spawn } = fakeSpawn({});
    expect(
      warp({ spawn, env: { TERM_PROGRAM: "iTerm.app" }, home }).problem(),
    ).toMatch(/not Warp \(TERM_PROGRAM=iTerm.app\)/);
    expect(warp({ spawn, env: {}, home }).problem()).toMatch(
      /TERM_PROGRAM=unset/,
    );
    expect(warp({ spawn, env: warpEnv, home }).problem()).toBeNull();
  });

  it("with the hook installed: one marker per worktree, one new_tab URI each, no YAML", () => {
    writeFileSync(join(home, ".zshrc"), `${AUTOSTART_MARKER}\n`);
    const { spawn, calls } = fakeSpawn({});
    const lines = warp({ spawn, env: warpEnv, home }).open(sessions);

    for (const s of sessions) {
      expect(readFileSync(join(s.dir, AUTOSTART_MARKER), "utf8")).toBe(
        `${s.id}\n`,
      );
    }
    expect(calls).toEqual(
      sessions.map((s) => [
        "open",
        `warp://action/new_tab?path=${encodeURIComponent(s.dir)}`,
      ]),
    );
    expect(existsSync(join(home, ".warp"))).toBe(false);
    expect(lines[0]).toBe("→ opened 2 tabs here: #3, #4");
    expect(lines[1]).toContain(join(home, ".zshrc"));
  });

  it("without the hook: a launch configuration carrying every command, a launch URI, and the reason", () => {
    const { spawn, calls } = fakeSpawn({});
    const lines = warp({ spawn, env: warpEnv, home }).open(sessions);

    for (const s of sessions) {
      expect(existsSync(join(s.dir, AUTOSTART_MARKER))).toBe(false);
    }
    const dir = join(home, ".warp", "launch_configurations");
    expect(readdirSync(dir)).toEqual(["slice-3-4.yaml"]);
    const yaml = readFileSync(join(dir, "slice-3-4.yaml"), "utf8");
    expect(yaml).toContain("name: slice-3-4");
    for (const s of sessions) {
      expect(yaml).toContain(`cwd: ${s.dir}`);
      expect(yaml).toContain(
        `- exec: /repo/scripts/slice-session.sh ${s.id} --self-land`,
      );
    }
    expect(calls).toEqual([["open", "warp://launch/slice-3-4"]]);
    expect(lines[0]).toBe("→ opened a window with 2 tabs: #3, #4");
    expect(lines[1]).toContain(join(home, ".zshrc"));
    expect(lines[2]).toContain(join(dir, "slice-3-4.yaml"));
    expect(lines[2]).toMatch(/outside the repo/);
  });

  it("a shell with no hook shipped goes to a window and says which shell", () => {
    const { spawn, calls } = fakeSpawn({});
    const lines = warp({
      spawn,
      env: { TERM_PROGRAM: "WarpTerminal", SHELL: "/usr/bin/fish" },
      home,
    }).open(sessions);
    expect(calls[0]?.[1]).toBe("warp://launch/slice-3-4");
    expect(lines[1]).toMatch(/fish/);
  });

  it("throws with open's output when a URI cannot be dispatched", () => {
    writeFileSync(join(home, ".zshrc"), `${AUTOSTART_MARKER}\n`);
    const { spawn } = fakeSpawn({
      open: { ok: false, out: "Unable to find application named 'Warp'" },
    });
    expect(() => warp({ spawn, env: warpEnv, home }).open(sessions)).toThrow(
      /a tab for #3.*\n.*Unable to find application/,
    );
  });
});

describe("tmux()", () => {
  it("declares that the command travels with the launch — no marker, no parked flags", () => {
    const t = tmux({
      spawn: fakeSpawn({}).spawn,
      env: { TMUX: "/tmp/tmux-1/default,1,0" },
    });
    expect(t.name).toBe("tmux");
    expect(t.starts).toBe("command");
    expect(t.problem()).toBeNull();
  });

  it("is a problem when tmux cannot run, or when no server exists and this is not inside one", () => {
    const missing = fakeSpawn({
      "tmux -V": { ok: false, out: "spawnSync tmux ENOENT" },
    });
    expect(tmux({ spawn: missing.spawn, env: {} }).problem()).toMatch(
      /tmux cannot be run: spawnSync tmux ENOENT/,
    );

    const noServer = fakeSpawn({
      "tmux -V": { ok: true, out: "tmux 3.4" },
      "tmux has-session": { ok: false, out: "no server running" },
    });
    expect(tmux({ spawn: noServer.spawn, env: {} }).problem()).toMatch(
      /no tmux server is running/,
    );
    // Inside a session the server is by definition running; has-session is not asked.
    const inside = fakeSpawn({
      "tmux -V": { ok: true },
      "tmux has-session": { ok: false },
    });
    expect(
      tmux({ spawn: inside.spawn, env: { TMUX: "x" } }).problem(),
    ).toBeNull();
    expect(inside.calls.map((c) => c[1])).toEqual(["-V"]);
  });

  it("opens one detached window per session, with the cwd and the whole command", () => {
    const { spawn, calls } = fakeSpawn({});
    const lines = tmux({ spawn, env: { TMUX: "x" } }).open(sessions);
    expect(calls).toEqual(
      sessions.map((s) => [
        "tmux",
        "new-window",
        "-d",
        "-c",
        s.dir,
        "-n",
        `ticket-${s.id}`,
        `/repo/scripts/slice-session.sh ${s.id} --self-land`,
      ]),
    );
    for (const s of sessions) {
      expect(existsSync(join(s.dir, AUTOSTART_MARKER))).toBe(false);
    }
    expect(lines).toEqual(["→ opened 2 tmux windows: #3, #4"]);
  });

  it("throws with tmux's output when a window cannot be opened", () => {
    const { spawn } = fakeSpawn({
      "tmux new-window": { ok: false, out: "can't find session: main" },
    });
    expect(() => tmux({ spawn, env: { TMUX: "x" } }).open(sessions)).toThrow(
      /new-window for #3 failed:\ncan't find session/,
    );
  });
});
