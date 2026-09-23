/**
 * A lock that every process working on one repo can see: the land lock
 * (`slice-land.sh`) and the gate lock (`gatesPass` in slice-run.ts).
 *
 *   bun slice-lock.ts acquire <dir> --pid <n> --label <who> --what <land> [--wait <seconds>]
 *   bun slice-lock.ts release <dir> --pid <n>
 *
 * WHY THIS EXISTS
 * ---------------
 * Two dispatchers ran on one consumer-a checkout for a day. Each landed one
 * slice per round, which serialises its own lands and nobody else's: five of
 * them fast-forwarded one master in one main checkout, and two `git merge`s
 * contending for `index.lock` fail as a git error rather than as the clean
 * "diverged" refusal a parked land knows how to retry. And each ran its gates
 * on top of the other's, at a load average near 30, where a 5-second test
 * timeout parked three green slices that never touched the code under test.
 *
 * THE SHAPE
 * ---------
 * The DB lock's (db-lock.sh): a directory in the common git dir, which every
 * worktree of the repo can already see, with an owner file inside. Three
 * differences, each because these locks are held by processes rather than by
 * branches:
 *
 *  - It is taken WHOLE. The owner file is written into a private directory
 *    first and the directory is renamed into place, so a lock never exists
 *    without its owner. rename(2) of a directory fails onto a non-empty one,
 *    which makes it as atomic as mkdir.
 *  - A holder that is no longer running is taken over, with a line saying so.
 *    "Running" is the pid AND its start time as `ps` reports it, because pids
 *    are reused and a lock left by a crash a day ago would otherwise be held
 *    by whatever process drew that number next.
 *  - Taking it waits. Both callers are about to spend seconds to minutes on
 *    something that must not overlap, and have nothing else to do meanwhile.
 *
 * The takeover moves the dead holder's directory aside before deleting it, and
 * checks that what it moved is the lock it judged dead: two waiters can both
 * see one dead holder, and the slower one would otherwise delete the faster
 * one's fresh lock. What it cannot close is a third process placing a lock in
 * the instant between that move and the move back; that needs a dead holder
 * and three contenders inside a few microseconds, and costs one git error.
 */

import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

export type Owner = {
  pid: number;
  /** `ps -o lstart=` for `pid` when the lock was taken; empty if ps could not say. */
  started: string;
  /** Who holds it, in the caller's words: `ticket/41`, `#31`. */
  label: string;
  /** When it was taken, ISO. */
  since: string;
};

/** When `pid` started, as `ps` prints it, or null when it is not running. */
export function processStart(pid: number): string | null {
  const r = spawnSync("ps", ["-o", "lstart=", "-p", String(pid)], {
    encoding: "utf8",
  });
  const out = (r.stdout ?? "").trim();
  return r.status === 0 && out ? out : null;
}

/**
 * Is the process that took the lock still the one running under its pid?
 * EPERM from `kill 0` is a live process owned by someone else. A start time
 * ps cannot read is not evidence either way, so it does not decide.
 */
export function isRunning(o: Owner): boolean {
  try {
    process.kill(o.pid, 0);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EPERM") return false;
  }
  if (!o.started) return true;
  const now = processStart(o.pid);
  return now === null || now === o.started;
}

/**
 * The owner file, or `null` for a lock without a readable one, or `undefined`
 * when there is no lock at all.
 */
export function readOwner(dir: string): Owner | null | undefined {
  let text: string;
  try {
    text = readFileSync(join(dir, "owner"), "utf8");
  } catch {
    return existsSync(dir) ? null : undefined;
  }
  const field = (k: string) =>
    text.match(new RegExp(`^${k}=(.*)$`, "m"))?.[1] ?? "";
  const pid = Number(field("pid"));
  if (!Number.isInteger(pid) || pid <= 0) return null;
  return {
    pid,
    started: field("started"),
    label: field("label"),
    since: field("since"),
  };
}

const sameOwner = (a: Owner | null | undefined, b: Owner | null | undefined) =>
  a === b || (!!a && !!b && a.pid === b.pid && a.since === b.since);

const format = (o: Owner) =>
  `pid=${o.pid}\nstarted=${o.started}\nlabel=${o.label}\nsince=${o.since}\n`;

/** rename(2), answering false when something is already at `to`. */
function renameOnto(from: string, to: string): boolean {
  try {
    renameSync(from, to);
    return true;
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ENOTEMPTY" || code === "EEXIST") return false;
    throw e;
  }
}

let seq = 0;
const aside = (dir: string, why: string) =>
  `${dir}.${why}-${process.pid}-${Date.now()}-${seq++}`;

export type Attempt =
  | { taken: true; tookOver?: Owner | null }
  | { taken: false; holder: Owner | null };

/** One try, never waiting. */
export function tryTake(dir: string, me: Owner): Attempt {
  const mine = aside(dir, "take");
  mkdirSync(mine);
  writeFileSync(join(mine, "owner"), format(me));
  let tookOver: Owner | null | undefined;
  try {
    // Twice at most: once as found, and once more after moving a dead
    // holder aside.
    for (let i = 0; i < 2; i++) {
      if (renameOnto(mine, dir)) {
        return tookOver === undefined
          ? { taken: true }
          : { taken: true, tookOver };
      }
      const holder = readOwner(dir);
      // Released between the rename and the read: go again.
      if (holder === undefined) continue;
      if (holder && isRunning(holder)) return { taken: false, holder };
      const grave = aside(dir, "gone");
      try {
        renameSync(dir, grave);
      } catch {
        // Someone else moved it first. The next poll sees who won.
        return { taken: false, holder };
      }
      const moved = readOwner(grave);
      if (!sameOwner(moved, holder)) {
        // It changed hands between the read and the move: a live lock. Back
        // it goes, and it is that holder we are waiting for.
        renameOnto(grave, dir);
        return { taken: false, holder: moved ?? null };
      }
      rmSync(grave, { recursive: true, force: true });
      tookOver = holder;
    }
    return { taken: false, holder: readOwner(dir) ?? null };
  } finally {
    rmSync(mine, { recursive: true, force: true });
  }
}

const sleep = (ms: number) =>
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

export type AcquireOptions = {
  pid: number;
  label: string;
  /** How long to wait for a live holder; forever when absent. */
  waitMs?: number;
  pollMs?: number;
  /** Called once per holder waited on. */
  onWait?: (holder: Owner | null) => void;
  /** Called when a holder that is no longer running was replaced. */
  onTakeover?: (gone: Owner | null) => void;
};

/**
 * Take the lock, waiting while someone else holds it. Synchronous, because
 * the dispatcher's gates are: a round that is waiting for another run's
 * gates is blocked exactly as long as it would be running its own.
 */
export function acquire(
  dir: string,
  opts: AcquireOptions,
): { ok: true } | { ok: false; holder: Owner | null } {
  const me: Owner = {
    pid: opts.pid,
    started: processStart(opts.pid) ?? "",
    label: opts.label,
    since: new Date().toISOString(),
  };
  const deadline = Date.now() + (opts.waitMs ?? Number.POSITIVE_INFINITY);
  let told: Owner | null | undefined;
  for (;;) {
    const a = tryTake(dir, me);
    if (a.taken) {
      if (a.tookOver !== undefined) opts.onTakeover?.(a.tookOver);
      return { ok: true };
    }
    if (told === undefined || !sameOwner(told, a.holder)) {
      told = a.holder;
      opts.onWait?.(a.holder);
    }
    if (Date.now() >= deadline) return { ok: false, holder: a.holder };
    sleep(Math.min(opts.pollMs ?? 1000, Math.max(0, deadline - Date.now())));
  }
}

/**
 * Give it back, if `pid` holds it. Moved aside before it is deleted, so a
 * waiter's rename can never land in a half-deleted directory.
 */
export function release(dir: string, pid: number): boolean {
  const o = readOwner(dir);
  if (!o || o.pid !== pid) return false;
  const gone = aside(dir, "released");
  try {
    renameSync(dir, gone);
  } catch {
    return false;
  }
  rmSync(gone, { recursive: true, force: true });
  return true;
}

// ─── the command line, for slice-land.sh ─────────────────────────────────

/** Local wall-clock time, which is what the person reading the line has. */
const clock = (iso: string) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? "?"
    : d.toLocaleTimeString("en-GB", { hour12: false });
};

function cli(argv: string[]): number {
  const [verb, dir] = argv;
  const value = (flag: string) => {
    const i = argv.indexOf(flag);
    return i === -1 ? undefined : argv[i + 1];
  };
  const pid = Number(value("--pid"));
  if (!dir || !Number.isInteger(pid) || pid <= 0) return usage();
  if (verb === "release") {
    release(dir, pid);
    return 0;
  }
  if (verb !== "acquire") return usage();
  const label = value("--label") ?? "?";
  const what = value("--what") ?? "work";
  const wait = value("--wait");
  const waitMs = wait === undefined ? undefined : Number(wait) * 1000;
  if (waitMs !== undefined && !(waitMs >= 0)) return usage();
  const who = (h: Owner | null) =>
    h
      ? `${h.label}'s ${what} (pid ${h.pid}, since ${clock(h.since)})`
      : `an ownerless ${what} lock`;
  const r = acquire(dir, {
    pid,
    label,
    waitMs,
    onWait: (h) => console.log(`  waiting for ${who(h)} …`),
    onTakeover: (h) =>
      console.log(
        h
          ? `  took over the ${what} lock from ${h.label} (pid ${h.pid}) — that process is no longer running`
          : `  took over an ownerless ${what} lock`,
      ),
  });
  if (r.ok) return 0;
  console.error(`error: gave up after ${wait}s waiting for ${who(r.holder)}.`);
  console.error(
    `       once that process has exited its lock is taken over: ${dir}`,
  );
  return 1;
}

function usage(): number {
  console.error(
    "usage: slice-lock.ts acquire <dir> --pid <n> --label <who> --what <what> [--wait <seconds>]",
  );
  console.error("       slice-lock.ts release <dir> --pid <n>");
  return 64;
}

if (import.meta.main) process.exit(cli(process.argv.slice(2)));
