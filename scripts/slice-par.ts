#!/usr/bin/env bun
/**
 * Runs several commands at once, and answers when all of them have ended.
 *
 * `tryLand` and everything under it are synchronous, and making them async to
 * save a minute per land would be the wrong trade. So the dispatcher makes one
 * blocking call to this, and nothing around that call changes. It knows nothing
 * about what it runs.
 *
 * Takes `{ cwd, timeoutMs, commands: string[][] }` as JSON on stdin. Prints
 * `[{ ok, out, status }]` as one line, in the order of `commands`. `out` is what
 * `run()` gives in slice-run.ts: stdout, then stderr, trimmed, and the reason
 * when there is one. A command that cannot start or runs out of time is a failed
 * answer, and leaves the others alone.
 */

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";

export type ParResult = { ok: boolean; out: string; status: number | null };

/** How long a timed-out command gets to end on SIGTERM, before SIGKILL. */
const KILL_AFTER_MS = 10_000;

/**
 * The line a failed spawn is worth: its first, with its code. An argument list
 * over the limit, a NUL, a missing binary.
 */
export function spawnFailure(e: unknown): string {
  const err = e as NodeJS.ErrnoException;
  const message = (err?.message ?? String(e)).split("\n")[0] ?? "";
  const line =
    err?.code && !message.includes(err.code)
      ? `${err.code}: ${message}`
      : message;
  return line.length > 200 ? `${line.slice(0, 200)}…` : line;
}

function one(
  cmd: string[],
  cwd: string,
  timeoutMs: number,
): Promise<ParResult> {
  return new Promise((resolve) => {
    const [bin, ...args] = cmd;
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(bin as string, args, { cwd, stdio: "pipe" });
    } catch (e) {
      resolve({ ok: false, out: spawnFailure(e), status: null });
      return;
    }
    child.stdin?.end();
    let stdout = "";
    let stderr = "";
    // Decoded by the stream: a character split across two chunks stays whole.
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (d) => {
      stdout += d;
    });
    child.stderr?.on("data", (d) => {
      stderr += d;
    });
    let reason = "";
    let killer: ReturnType<typeof setTimeout> | undefined;
    const timer = setTimeout(() => {
      reason = `timed out after ${Math.round(timeoutMs / 1000)} s`;
      child.kill("SIGTERM");
      killer = setTimeout(() => child.kill("SIGKILL"), KILL_AFTER_MS);
    }, timeoutMs);
    const end = (status: number | null, why: string) => {
      clearTimeout(timer);
      clearTimeout(killer);
      const out = [`${stdout}${stderr}`.trim(), reason || why]
        .filter(Boolean)
        .join("\n");
      resolve({ ok: status === 0 && !reason, out, status });
    };
    child.on("error", (e) => end(null, spawnFailure(e)));
    child.on("close", (code) => end(code, ""));
  });
}

if (import.meta.main) {
  const { cwd, timeoutMs, commands } = JSON.parse(readFileSync(0, "utf8")) as {
    cwd: string;
    timeoutMs: number;
    commands: string[][];
  };
  Promise.all(commands.map((c) => one(c, cwd, timeoutMs))).then((results) => {
    console.log(JSON.stringify(results));
  });
}
