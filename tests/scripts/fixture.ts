import { execFileSync, spawn, spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { EXCLUDE_BLOCK } from "../../scripts/slice-init";

/**
 * A throwaway consumer checkout the shell scripts can run in for real: a git
 * repo with the shims, a `slice.config.ts`, optionally a bare `origin`, and
 * linked worktrees on `ticket/<n>` branches.
 *
 * Built by hand rather than through `init`, because `init`'s starter config
 * imports the package by name and a temp dir has no node_modules; this one
 * imports it by absolute path. The shims are the same one-liners `init` would
 * write, pointed at this checkout.
 *
 * The tracker is a fake that reads every ticket from `ticketsFile` on every
 * call, so a test can edit or close one while a dispatcher is running
 * (`setTicket`). It records every close into `closeFile` as
 * `<id>\n<comment>` and marks the ticket closed — so a test can read back
 * what a land wrote to the ticket without a network, and `slice-land.sh`'s
 * close step succeeds instead of printing a gh error.
 */
export const AZELF = resolve(__dirname, "..", "..");

export const git = (cwd: string, ...args: string[]): string =>
  execFileSync(
    "git",
    ["-c", "user.email=t@t", "-c", "user.name=t", "-C", cwd, ...args],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  ).trim();

export const sh = (cwd: string, script: string): string =>
  execFileSync("bash", ["-c", `set -euo pipefail\n${script}`], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });

/**
 * Like `sh`, for a script that is allowed to fail: the exit status and both
 * streams joined, in the order a terminal would show them, so a refusal's
 * stderr text can be asserted on next to its stdout.
 */
export const shResult = (
  cwd: string,
  script: string,
): { ok: boolean; out: string } => {
  const r = spawnSync("bash", ["-c", `set -euo pipefail\n${script}`], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return { ok: r.status === 0, out: `${r.stdout}${r.stderr}` };
};

export type Consumer = {
  /** The temp dir everything lives under. */
  root: string;
  /** The main checkout, on `main`. */
  main: string;
  /** Where the fake tracker writes closes. */
  closeFile: string;
  /** Where the fake tracker reads tickets: `{ "<id>": { title?, body?, state? } }`. */
  ticketsFile: string;
  /** Change what the fake tracker answers for one ticket from now on. */
  setTicket: (id: string, patch: FakeTicket) => void;
  /** A linked worktree's path, by ticket number. */
  wt: (n: number) => string;
  /** The DB lock's claim dir and log, in the common git dir. */
  lockDir: string;
  lockLog: string;
};

export type FakeTicket = {
  title?: string;
  body?: string;
  state?: "open" | "closed";
};

export function makeConsumer(opts: {
  lockPaths?: string[];
  /** Ticket numbers to add worktrees for, on `ticket/<n>`. */
  worktrees?: number[];
  /** Add a bare `origin` with `main` pushed — slice-land.sh needs one. */
  remote?: boolean;
  /**
   * The agent's `sessionCommand`, written as `custom({ name: "fake", … })`,
   * so `slice-session.sh` can launch a real process the test controls. Also
   * commits the `package.json` its `bun install` step needs, with
   * `node_modules` ignored so the worktree still removes cleanly.
   */
  agent?: string[];
  /**
   * argv prefixes for the agent's headless `resolve` and `review`; the prompt
   * is appended as the last argument, as `claude -p` takes it. Either one
   * gives the config a fake agent even without `agent`, with `true` as its
   * session command, so a dispatcher run never looks for a real binary.
   */
  resolve?: string[];
  review?: string[];
  /** One landing gate, as `exitCode(gate)`; none when absent. */
  gate?: string[];
  /** What the fake tracker answers for every ticket, or by id. */
  title?: string;
  titles?: Record<string, string>;
  body?: string;
  /** Raw lines added to the config object, e.g. `tabTitle: false,`. */
  configExtra?: string;
}): Consumer {
  // Resolved, because git prints worktree paths canonicalized and macOS's
  // tmpdir is a symlink.
  const root = realpathSync(mkdtempSync(join(tmpdir(), "azelf-fx-")));
  const main = join(root, "repo");
  const closeFile = join(root, "closes.txt");
  const ticketsFile = join(root, "tickets.json");
  const lockPaths = opts.lockPaths ?? [];
  const tickets: Record<string, FakeTicket> = {};
  for (const [id, title] of Object.entries(opts.titles ?? {})) {
    tickets[id] = { title };
  }
  writeFileSync(ticketsFile, JSON.stringify(tickets));

  git(root, "init", "-q", "-b", "main", "repo");
  // Repo-local identity, because the scripts under test run plain `git
  // commit` — the `-c` flags on `git()` above only cover the test's own calls.
  git(main, "config", "user.email", "t@t");
  git(main, "config", "user.name", "t");
  // Plain two-sided conflict hunks whatever the machine's global config says,
  // because the fake resolver below edits them by pattern.
  git(main, "config", "merge.conflictStyle", "merge");
  // The marker excludes `init` writes, so a worktree holding a session's
  // markers still removes cleanly, as it does in a real consumer.
  writeFileSync(join(main, ".git", "info", "exclude"), EXCLUDE_BLOCK);
  mkdirSync(join(main, "scripts"));
  for (const s of ["slice-config.sh", "db-lock-check.sh"]) {
    writeFileSync(
      join(main, "scripts", s),
      `source ${JSON.stringify(join(AZELF, "scripts", s))}\n`,
    );
  }
  for (const s of [
    "slice-done.sh",
    "slice-land.sh",
    "session-commit.sh",
    "db-lock.sh",
    "slice-session.sh",
  ]) {
    writeFileSync(
      join(main, "scripts", s),
      `#!/usr/bin/env bash\nexec ${JSON.stringify(
        join(AZELF, "scripts", s),
      )} "$@"\n`,
      { mode: 0o755 },
    );
  }
  const agent =
    opts.agent || opts.resolve || opts.review
      ? `\n  agent: custom({ name: "fake", sessionCommand: ${JSON.stringify(
          opts.agent ?? ["true"],
        )}${
          opts.resolve
            ? `, resolve: (p) => [...${JSON.stringify(opts.resolve)}, p]`
            : ""
        }${
          opts.review
            ? `, review: (p) => [...${JSON.stringify(opts.review)}, p]`
            : ""
        } }),`
      : "";
  writeFileSync(
    join(main, "slice.config.ts"),
    `import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { custom, exitCode, type SliceConfig, type Tracker } from ${JSON.stringify(
      join(AZELF, "index.ts"),
    )};
const TICKETS = ${JSON.stringify(ticketsFile)};
type Fake = { title?: string; body?: string; state?: "open" | "closed" };
const all = (): Record<string, Fake> => JSON.parse(readFileSync(TICKETS, "utf8"));
const ticket = (id: string) => ({
  title: ${JSON.stringify(opts.title ?? "t")},
  body: ${JSON.stringify(opts.body ?? "")},
  state: "open" as const,
  ...all()[id],
});
const tracker: Tracker = {
  name: "Fake",
  idPattern: "^[0-9]+$",
  refTemplate: "#{n}",
  listReady: () => [],
  get: (id) => {
    const t = ticket(id);
    return { id, title: t.title, state: t.state, labels: ["ready"], url: "" };
  },
  blockers: () => [],
  body: (id) => ticket(id).body,
  close: (id, comment) => {
    appendFileSync(${JSON.stringify(closeFile)}, \`\${id}\\n\${comment}\\n\`);
    const next = all();
    next[id] = { ...next[id], state: "closed" };
    writeFileSync(TICKETS, JSON.stringify(next));
  },
};
export default {
  tracker,
  baseBranch: "main",
  branchPattern: "ticket/{n}",
  worktreeDir: "../{repo}-ticket-{n}",
  readyLabel: "ready",
  exclusiveLockPaths: ${JSON.stringify(lockPaths)},
  provisionCopy: [],
  gates: ${opts.gate ? `[exitCode(${JSON.stringify(opts.gate)})]` : "[]"},
  startPrompt: "x",${agent}${opts.configExtra ? `\n  ${opts.configExtra}` : ""}
} satisfies SliceConfig;
`,
  );
  for (const p of lockPaths) {
    mkdirSync(join(main, p), { recursive: true });
    writeFileSync(join(main, p, ".keep"), "");
  }
  if (opts.agent) {
    writeFileSync(join(main, "package.json"), '{ "name": "fx" }\n');
    writeFileSync(join(main, ".gitignore"), "node_modules/\n");
  }
  git(main, "add", "-A");
  git(main, "commit", "-qm", "init");

  if (opts.remote) {
    git(root, "init", "-q", "--bare", "remote");
    git(main, "remote", "add", "origin", join(root, "remote"));
    git(main, "push", "-q", "-u", "origin", "main");
  }

  const wt = (n: number) => join(root, `repo-ticket-${n}`);
  for (const n of opts.worktrees ?? []) {
    git(main, "worktree", "add", "-q", wt(n), "-b", `ticket/${n}`);
  }
  const setTicket = (id: string, patch: FakeTicket) => {
    const now = JSON.parse(readFileSync(ticketsFile, "utf8"));
    now[id] = { ...now[id], ...patch };
    writeFileSync(ticketsFile, JSON.stringify(now));
  };
  return {
    root,
    main,
    closeFile,
    ticketsFile,
    setTicket,
    wt,
    lockDir: join(main, ".git", "azelf-db.lock"),
    lockLog: join(main, ".git", "azelf-db.log"),
  };
}

const DISPATCHER = join(AZELF, "scripts", "slice-run.ts");

/**
 * The dispatcher's environment: this one, with the repo root pinned to the
 * consumer so nothing inherited from the shell running the tests can point it
 * at another checkout.
 */
const dispatcherEnv = (c: Consumer) => ({
  ...process.env,
  SLICE_REPO_ROOT: c.main,
});

/**
 * One dispatcher run to completion, from the main checkout — `--once` for a
 * single round. Allowed to fail: a run that parks a slice exits 1, and that
 * is often the assertion.
 */
export function runDispatcher(
  c: Consumer,
  args: string[],
): { code: number; out: string } {
  const r = spawnSync("bun", [DISPATCHER, ...args], {
    cwd: c.main,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: dispatcherEnv(c),
  });
  return { code: r.status ?? -1, out: `${r.stdout}${r.stderr}` };
}

export type Dispatcher = {
  /** Everything printed so far, both streams. */
  output: () => string;
  /** Resolves once the output contains this, or rejects on exit or timeout. */
  until: (want: string | RegExp, timeoutMs?: number) => Promise<void>;
  /** The exit code, once it has exited. */
  exited: Promise<number>;
  /** SIGTERM it if it is still running; resolves with the exit code. */
  stop: () => Promise<number>;
};

/**
 * A dispatcher left running in the background, for tests that change
 * something between its rounds: pass `--interval 1` and wait on `until`.
 * Every test that starts one stops it, finished or not.
 */
export function startDispatcher(c: Consumer, args: string[]): Dispatcher {
  const child = spawn("bun", [DISPATCHER, ...args], {
    cwd: c.main,
    stdio: ["ignore", "pipe", "pipe"],
    env: dispatcherEnv(c),
  });
  let out = "";
  child.stdout.on("data", (d) => {
    out += d;
  });
  child.stderr.on("data", (d) => {
    out += d;
  });
  let done = false;
  const exited = new Promise<number>((res) =>
    child.on("close", (code) => {
      done = true;
      res(code ?? -1);
    }),
  );
  const seen = (want: string | RegExp) =>
    typeof want === "string" ? out.includes(want) : want.test(out);
  const until = async (want: string | RegExp, timeoutMs = 20_000) => {
    const deadline = Date.now() + timeoutMs;
    while (!seen(want)) {
      if (done) {
        throw new Error(
          `the dispatcher exited without printing ${want}:\n${out}`,
        );
      }
      if (Date.now() > deadline) {
        throw new Error(`timed out waiting for ${want}:\n${out}`);
      }
      await new Promise((r) => setTimeout(r, 100));
    }
  };
  const stop = () => {
    if (!done) child.kill("SIGTERM");
    return exited;
  };
  return { output: () => out, until, exited, stop };
}
