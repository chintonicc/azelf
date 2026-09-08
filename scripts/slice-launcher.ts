/**
 * The terminal launcher, as a CONTRACT rather than a TERM_PROGRAM sniff.
 *
 *   launcher.name              # shown in the dispatcher's banner
 *   launcher.starts            # "command" | "marker" — what the launch carries (below)
 *   launcher.startingGraceMs   # how long "launched, no .slice-live yet" is normal
 *   launcher.problem()         # why it cannot run HERE, or null
 *   launcher.open(sessions)    # one session per entry; lines to print, or throws
 *
 * `slice.config.ts` may name one under `launcher`; `manual()` is the default
 * when it does not, and `warp()` and `tmux()` ship. Nothing here reads the
 * config, on purpose — the config imports these constructors, and a module
 * that imported the config back would be a cycle. Same shape as
 * scripts/slice-gates.ts and scripts/slice-tracker.ts.
 *
 * WHY A CONTRACT AND NOT A CONFIG STRING
 * --------------------------------------
 * "Which terminal" sounds like one word of config, and it would be if every
 * terminal could be handed a directory and a command. Warp cannot, and that
 * one fact reaches three places outside this file:
 *
 *  1. WARP'S TWO MECHANISMS HAVE COMPLEMENTARY DEFICIENCIES.
 *     `warp://action/new_tab` opens a tab in the CURRENT window and carries no
 *     command; `warp://launch/<name>` runs commands and always opens a NEW
 *     window. The nicer path therefore needs help from the shell: the
 *     dispatcher writes a one-shot `.slice-autostart` marker into the prepped
 *     worktree, and a hook in the user's rc file runs the session when the
 *     tab's shell starts. The whole marker protocol exists only to bridge
 *     that gap.
 *
 *  2. SO THE PROTOCOL LEAKS INTO slice-session.sh. The hook passes the ticket
 *     id and nothing else, so `--prep-only` parks `--sandbox`/`--self-land`/
 *     `--no-start` in `.slice-flags` for the hook's run to pick up (ADR 0001
 *     #26). `tmux new-window -c <dir> <cmd>` and a pasted command carry the
 *     flags themselves; neither the marker nor the flags file is needed there,
 *     and a stale flags file would only ever turn something ON. That is what
 *     `starts` declares — `"marker"` for Warp, `"command"` for the rest — and
 *     the shell bridge hands it to slice-session.sh as SLICE_LAUNCHER_STARTS.
 *
 *  3. A MISSING HOOK MUST STAY DETECTABLE. The hook lives in a file outside
 *     the repo, so it may simply not be there — and an absent hook is not an
 *     error, it is three tabs silently sitting at a prompt. `autostartHook`
 *     looks in the rc file of the shell the tab will start ($SHELL: zsh, bash
 *     or fish, each with its own file) and says which file it looked in and
 *     why it gave up, so the fallback to a window is reported, never assumed.
 *     A shell it does not know is refused by name rather than guessed at.
 *
 *  4. THE GRACE WINDOW IS THE LAUNCHER'S. `startingGraceMs` covers "launched,
 *     but the session has not yet written `.slice-live`". Under Warp that
 *     spans a URI dispatch, a full shell startup and the hook; under tmux the
 *     command starts at once and only the session's own prep (three tracker
 *     calls, a warm `bun install`) remains; under `manual` a human has to
 *     paste something. The dispatcher's "never came up" report keys off the
 *     same number, so it is a diagnostic threshold as much as a timeout —
 *     which is why each launcher declares its own instead of sharing one.
 *
 * WHAT WRITES OUTSIDE THE WORKTREE
 * --------------------------------
 * `warp()` on the window path writes a launch configuration to
 * `~/.warp/launch_configurations/<label>.yaml`, one per launch, and does not
 * remove it — Warp reads the file when the URI is opened, and deleting it
 * straight after would race that read. The line it prints names the file.
 * The tab path writes only the marker, inside the worktree. `tmux()` and
 * `manual()` write nothing.
 *
 * Both Warp mechanisms were verified against Warp v0.2026.08.12 on macOS,
 * where `open <uri>` is what dispatches a URI. The tmux launcher is written
 * against `tmux new-window` as documented and unit-tested through a scripted
 * spawn; see the extraction plan for what has and has not been proven live.
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import type { TicketId } from "./slice-tracker";

// ─── the seam ─────────────────────────────────────────────────────────────

/**
 * Runs a command and never throws — a launcher decides what a failure means.
 * `out` is stdout and stderr joined, plus the reason when the binary could not
 * be run at all (that is how "tmux is not installed" surfaces).
 */
export type Spawn = (
  cmd: string[],
  cwd?: string,
) => { ok: boolean; out: string };

export type Session = {
  id: TicketId;
  /** The ticket as humans write it (`#3`). Output only. */
  ref: string;
  /** The prepped worktree the session runs in. */
  dir: string;
  /** What starts the session, as argv — `slice-session.sh 3 --self-land`. Every flag is here. */
  cmd: string[];
};

export type Launcher = {
  /** Shown in the dispatcher's banner and in its reports. */
  name: string;
  /**
   * What the launch carries. `"command"`: the launcher runs `cmd` itself, so
   * every flag travels as an argument. `"marker"`: it can open a shell in a
   * directory and nothing more, so the session is started by the autostart
   * hook from a `.slice-autostart` marker carrying the ticket id alone — and
   * slice-session.sh must park its flags in `.slice-flags` for that run.
   */
  starts: "command" | "marker";
  /** How long after `open` a session may exist without `.slice-live` before it "never came up". */
  startingGraceMs: number;
  /** Why this launcher cannot run in the current environment, or `null`. */
  problem(): string | null;
  /**
   * Open one session per entry. Returns the lines to print. Throws when the
   * launch itself failed, with the tool's output — the dispatcher then prints
   * the commands for pasting, which is the one path that cannot fail.
   */
  open(sessions: Session[]): string[];
};

// ─── shared ───────────────────────────────────────────────────────────────

/** A word as a POSIX shell would need it — untouched when it is already safe. */
export const shellWord = (s: string): string =>
  /^[A-Za-z0-9_./=:@%+,-]+$/.test(s) ? s : `'${s.split("'").join(`'\\''`)}'`;

/** argv → one pasteable line. */
export const shellLine = (cmd: string[]): string =>
  cmd.map(shellWord).join(" ");

function realSpawn(cmd: string[], cwd?: string): { ok: boolean; out: string } {
  const [bin, ...args] = cmd;
  const proc = spawnSync(bin as string, args, {
    cwd,
    encoding: "utf8",
    stdio: "pipe",
  });
  return {
    ok: proc.status === 0,
    out: `${proc.stdout ?? ""}${proc.stderr ?? ""}${
      proc.error ? proc.error.message : ""
    }`.trim(),
  };
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

// ─── the autostart hook ───────────────────────────────────────────────────

/** The literal every version of the hook contains, and the marker file it consumes. */
export const AUTOSTART_MARKER = ".slice-autostart";
/** Where the canonical hook text lives, for `init` and for the message below. */
export const AUTOSTART_HOOK_FILE = "scripts/slice-autostart.sh";

export type HookProbe =
  | { installed: true; file: string }
  | { installed: false; why: string };

export type HookProbeOptions = {
  /** `$SHELL` — the login shell, which is what Warp starts unless told otherwise. */
  shell: string | undefined;
  home: string;
  /** For ZDOTDIR and XDG_CONFIG_HOME. */
  env: Record<string, string | undefined>;
};

/**
 * The rc files a shell reads when it starts interactively, most specific
 * first. `null` for a shell this does not know — the caller must then refuse,
 * not guess.
 */
export function rcFilesFor(
  shell: string,
  home: string,
  env: Record<string, string | undefined>,
): string[] | null {
  switch (basename(shell)) {
    case "zsh":
      return [join(env.ZDOTDIR || home, ".zshrc")];
    case "bash":
      // macOS terminals start bash as a LOGIN shell, which reads .bash_profile
      // and not .bashrc — so all three are checked, and the message names them.
      return [".bashrc", ".bash_profile", ".profile"].map((f) => join(home, f));
    case "fish":
      return [
        join(
          env.XDG_CONFIG_HOME || join(home, ".config"),
          "fish",
          "config.fish",
        ),
      ];
    default:
      return null;
  }
}

/**
 * Is the hook installed for the shell a new tab will start?
 *
 * The check is a literal grep for `.slice-autostart` in that shell's rc file,
 * which is what the hook has always been detected by. Every `why` names the
 * file it looked in: the tab path silently degrades to a shell at a prompt
 * when the hook is missing, so the fallback must be able to say what it did
 * not find and where.
 */
export function autostartHook(opts: HookProbeOptions): HookProbe {
  const { shell, home, env } = opts;
  if (!shell) {
    return {
      installed: false,
      why: "cannot tell which shell a new tab starts — $SHELL is unset",
    };
  }
  const files = rcFilesFor(shell, home, env);
  if (!files) {
    return {
      installed: false,
      why: `no autostart hook is shipped for ${basename(
        shell,
      )} ($SHELL) — only bash and zsh can source ${AUTOSTART_HOOK_FILE}`,
    };
  }
  for (const file of files) {
    let text: string;
    try {
      text = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    if (text.includes(AUTOSTART_MARKER)) return { installed: true, file };
  }
  if (basename(shell) === "fish") {
    return {
      installed: false,
      why: `no autostart hook in ${files[0]}, and ${AUTOSTART_HOOK_FILE} is sh syntax fish cannot source — no fish version ships yet`,
    };
  }
  return {
    installed: false,
    why: `no autostart hook in ${files.join(
      " or ",
    )} — paste ${AUTOSTART_HOOK_FILE} there for tabs in this window`,
  };
}

// ─── manual: the default ──────────────────────────────────────────────────

/**
 * Prints the command per session and opens nothing. The default, and a real
 * answer: it is what every terminal falls back to, it cannot fail, and it is
 * the launcher a project has until it configures one.
 *
 * The grace window is long because a human has to paste something; after it
 * lapses the dispatcher prints the command again, which is the right reminder.
 */
export function manual(): Launcher {
  return {
    name: "manual",
    starts: "command",
    startingGraceMs: 10 * 60_000,
    problem: () => null,
    open(sessions) {
      return [
        "open these yourself, each in its own terminal:",
        ...sessions.map((s) => `    ${shellLine(s.cmd)}`),
      ];
    },
  };
}

// ─── warp ─────────────────────────────────────────────────────────────────

export type WarpOptions = {
  /** Scripted in tests; `open <uri>` for real. */
  spawn?: Spawn;
  /** Scripted in tests; `process.env` for real. Reads TERM_PROGRAM, SHELL, ZDOTDIR, XDG_CONFIG_HOME. */
  env?: Record<string, string | undefined>;
  /** Where rc files and `.warp/` live. */
  home?: string;
};

/**
 * Tabs in the current window when the autostart hook is installed; one new
 * window holding a tab per session when it is not. Which path was taken, and
 * why, is in the lines it returns.
 *
 * `starts: "marker"` even though the window path carries the command: the
 * choice is made at launch, after slice-session.sh has already prepped, so
 * the flags are parked either way. On the window path they are also on the
 * command line, and a parked flag only ever turns on what is already on.
 */
export function warp(opts: WarpOptions = {}): Launcher {
  const spawn = opts.spawn ?? realSpawn;
  const env = opts.env ?? process.env;
  const home = opts.home ?? homedir();

  const openUri = (uri: string, what: string): void => {
    const r = spawn(["open", uri]);
    if (!r.ok) throw new Error(`could not open ${what} (${uri}):\n${r.out}`);
  };

  const openAsTabs = (sessions: Session[], hookFile: string): string[] => {
    for (const s of sessions) {
      writeFileSync(join(s.dir, AUTOSTART_MARKER), `${s.id}\n`);
      openUri(
        `warp://action/new_tab?path=${encodeURIComponent(s.dir)}`,
        `a tab for ${s.ref}`,
      );
    }
    return [
      `→ opened ${plural(sessions.length, "tab")} here: ${sessions
        .map((s) => s.ref)
        .join(", ")}`,
      `  (started by the autostart hook in ${hookFile})`,
    ];
  };

  const openAsWindow = (sessions: Session[], why: string): string[] => {
    const label = `slice-${sessions.map((s) => s.id).join("-")}`;
    const dir = join(home, ".warp", "launch_configurations");
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `${label}.yaml`);
    const yaml = [
      "---",
      `name: ${label}`,
      "windows:",
      "  - tabs:",
      ...sessions.flatMap((s) => [
        `      - title: "ticket-${s.id}"`,
        "        layout:",
        `          cwd: ${s.dir}`,
        "          commands:",
        `            - exec: ${shellLine(s.cmd)}`,
      ]),
      "",
    ].join("\n");
    writeFileSync(file, yaml);
    openUri(`warp://launch/${label}`, "a Warp window");
    return [
      `→ opened a window with ${plural(sessions.length, "tab")}: ${sessions
        .map((s) => s.ref)
        .join(", ")}`,
      `  not as tabs here: ${why}`,
      `  wrote ${file} — outside the repo; Warp keeps it, and it is safe to delete once the window is open`,
    ];
  };

  return {
    name: "warp",
    starts: "marker",
    startingGraceMs: 120_000,
    problem() {
      // The sniff that used to SELECT the launcher, kept as a check: a config
      // that names Warp from another terminal would otherwise dispatch URIs
      // nothing answers and report every slice as "never came up".
      if (env.TERM_PROGRAM !== "WarpTerminal") {
        return `slice.config.ts names the warp launcher, but this is not Warp (TERM_PROGRAM=${
          env.TERM_PROGRAM ?? "unset"
        })`;
      }
      return null;
    },
    open(sessions) {
      const hook = autostartHook({ shell: env.SHELL, home, env });
      return hook.installed
        ? openAsTabs(sessions, hook.file)
        : openAsWindow(sessions, hook.why);
    },
  };
}

// ─── tmux ─────────────────────────────────────────────────────────────────

export type TmuxOptions = {
  /** Scripted in tests; the real binary otherwise. */
  spawn?: Spawn;
  /** Reads TMUX, to tell "inside a session" from "a server exists somewhere". */
  env?: Record<string, string | undefined>;
};

/**
 * One tmux window per session, in the current session when run inside tmux
 * and in the most recently used one otherwise. `new-window -c <dir> <cmd>`
 * carries both the directory and the command, so nothing is parked and no
 * hook is involved: `starts: "command"`.
 *
 * `-d` keeps the dispatcher's own window current — a round that opened three
 * windows would otherwise have switched focus three times.
 */
export function tmux(opts: TmuxOptions = {}): Launcher {
  const spawn = opts.spawn ?? realSpawn;
  const env = opts.env ?? process.env;
  return {
    name: "tmux",
    starts: "command",
    startingGraceMs: 60_000,
    problem() {
      const v = spawn(["tmux", "-V"]);
      if (!v.ok) {
        return `slice.config.ts names the tmux launcher, but tmux cannot be run${
          v.out ? `: ${v.out}` : ""
        }`;
      }
      if (!env.TMUX && !spawn(["tmux", "has-session"]).ok) {
        return "slice.config.ts names the tmux launcher, but no tmux server is running — start tmux first, then run this inside or alongside it";
      }
      return null;
    },
    open(sessions) {
      for (const s of sessions) {
        const r = spawn([
          "tmux",
          "new-window",
          "-d",
          "-c",
          s.dir,
          "-n",
          `ticket-${s.id}`,
          shellLine(s.cmd),
        ]);
        if (!r.ok) {
          throw new Error(`tmux new-window for ${s.ref} failed:\n${r.out}`);
        }
      }
      return [
        `→ opened ${plural(sessions.length, "tmux window")}: ${sessions
          .map((s) => s.ref)
          .join(", ")}`,
      ];
    },
  };
}
