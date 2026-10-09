/**
 * Holds: a slice worktree someone is working in by hand, which azelf leaves
 * alone until it is released.
 *
 *   bun slice-hold.ts describe <worktree> <ticket>
 *
 * prints one line and exits 0 when the worktree is held, and exits 1 when it
 * is not. slice-land.sh and slice-session.sh ask it; `azelf hold` and
 * `azelf release` take and give one back (`--hold` in slice-run.ts).
 *
 * WHY THIS EXISTS
 * ---------------
 * On consumer-a a slice parked as IRRECONCILABLE was being re-ported by hand:
 * a rebase in progress in its worktree, the resolutions not yet staged. After
 * a crash another session was asked to take over the dispatcher. It read the
 * rebase as a stale leftover, ran `git rebase --abort` and removed the
 * worktree, and the resolutions were gone. Nothing said the worktree was in
 * use, because azelf had no way to say it.
 *
 * THE SHAPE
 * ---------
 * A hold is git's own worktree lock, `git worktree lock --reason "azelf
 * hold: …"`. That makes `git worktree remove` refuse, even with one
 * `--force`, whoever runs it, and `git worktree list` shows it as `locked`.
 * Git has no lock against `git rebase --abort`; that half is a rule in
 * `/azelf`, and the `.slice-hold` note in the worktree is for whoever looks
 * with `ls`.
 *
 * Any lock on a slice worktree counts, not only azelf's: someone who locked
 * one with git by hand meant the same thing. `azelf release` gives back only
 * its own, and names the git command for the rest.
 */

import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { basename, dirname, join } from "node:path";

export const HOLD_PREFIX = "azelf hold: ";

/** The note `azelf hold` leaves in the worktree, for `ls`. */
export const HOLD_NOTE = ".slice-hold";

export type Hold = {
  /** Taken with `azelf hold`, rather than a lock someone put on with git. */
  azelf: boolean;
  /** `azelf hold` only: who, when (ISO) and why, as it was given. */
  by: string;
  since: string;
  why: string;
  /** The lock's reason as git has it; empty for a lock given none. */
  reason: string;
};

/** The lock reason `azelf hold` writes. One line: git lists it as one. */
export function holdReason(by: string, since: string, why: string): string {
  const line = (s: string) => s.replace(/\s+/g, " ").trim();
  return `${HOLD_PREFIX}${line(by)} since ${since}${
    line(why) ? ` — ${line(why)}` : ""
  }`;
}

export function parseHold(reason: string): Hold {
  const m = reason.startsWith(HOLD_PREFIX)
    ? reason
        .slice(HOLD_PREFIX.length)
        .match(/^(.*?) since (\d{4}-\d\d-\d\dT\S+)(?: — (.*))?$/s)
    : null;
  if (!m) return { azelf: false, by: "", since: "", why: "", reason };
  return {
    azelf: true,
    by: m[1] ?? "",
    since: m[2] ?? "",
    why: m[3] ?? "",
    reason,
  };
}

/**
 * A path as git prints a worktree's: resolved. Through the parent when the
 * worktree itself is gone, because git still lists a locked worktree whose
 * directory was deleted, and that is one a release must still find.
 */
export function canonicalPath(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    try {
      return join(realpathSync(dirname(p)), basename(p));
    } catch {
      return p;
    }
  }
}

/**
 * Every locked worktree of the repo at `cwd`, by resolved path; empty when
 * git cannot list them. `-z`, because without it git C-quotes a reason with
 * anything outside ASCII in it, and `—` is.
 */
export function locks(cwd: string): Map<string, Hold> {
  const r = spawnSync("git", ["worktree", "list", "--porcelain", "-z"], {
    cwd,
    encoding: "utf8",
  });
  const found = new Map<string, Hold>();
  if (r.status !== 0) return found;
  let path: string | null = null;
  for (const field of (r.stdout ?? "").split("\0")) {
    if (field === "") path = null;
    else if (field.startsWith("worktree ")) path = field.slice(9);
    else if (path && (field === "locked" || field.startsWith("locked "))) {
      found.set(canonicalPath(path), parseHold(field.slice(7)));
    }
  }
  return found;
}

/** The hold on the worktree at `wt`, or null. */
export const holdOf = (cwd: string, wt: string): Hold | null =>
  locks(cwd).get(canonicalPath(wt)) ?? null;

/** A time of day, with the date in front when it was not today. */
export function when(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "?";
  const time = d.toLocaleTimeString("en-GB", {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
  });
  return d.toDateString() === new Date().toDateString()
    ? time
    : `${d.toLocaleDateString("en-GB", {
        day: "numeric",
        month: "short",
      })} ${time}`;
}

/** `held by … since 14:55 (why)`, or what git's own lock says. */
export function describeHold(h: Hold): string {
  if (!h.azelf) return `locked in git${h.reason ? ` (${h.reason})` : ""}`;
  return `held by ${h.by} since ${when(h.since)}${h.why ? ` (${h.why})` : ""}`;
}

/** What gives it back: `azelf release` for azelf's own, git for the rest. */
export const releaseCommand = (id: string, wt: string, h: Hold): string =>
  h.azelf ? `azelf release ${id}` : `git worktree unlock ${wt}`;

function cli(argv: string[]): number {
  const [verb, wt, id] = argv;
  if (verb !== "describe" || !wt || !id) {
    console.error("usage: slice-hold.ts describe <worktree> <ticket>");
    return 64;
  }
  const h = holdOf(process.cwd(), wt);
  if (!h) return 1;
  console.log(`${describeHold(h)} — ${releaseCommand(id, wt, h)}`);
  return 0;
}

if (import.meta.main) process.exit(cli(process.argv.slice(2)));
