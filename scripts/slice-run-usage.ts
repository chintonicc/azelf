/**
 * The dispatcher's flags, and the usage it prints for `azelf run --help`.
 *
 * A module of its own because it must load without a `slice.config.ts`:
 * slice-run.ts reads the config at import time, so `bin/azelf.ts` answers
 * `azelf run --help` from here without starting it. slice-run.ts answers the
 * same flags from the same text, for when it is run through its shim.
 */

export const USAGE = `usage: azelf run [flags] [ticket…]

  azelf run                  plan, confirm, then run to completion
  azelf run --plan           print the dependency tree and stop
  azelf run 9 10 11 12       an explicit ticket set
  azelf run -y               start without asking to proceed (also --yes)
  azelf run --max 2          cap concurrent sessions
  azelf run --interval 10    seconds between rounds (default 30)
  azelf run --once           one round, then exit
  azelf run --auto           land without waiting for slice-done.sh
  azelf run --no-start       land at a bare prompt instead of starting work
  azelf run --review         review each slice before landing (implied by --auto)
  azelf run --auto --no-review   opt out of the review --auto implies
  azelf run --no-auto-resolve    never let an agent resolve a rebase conflict
  azelf run --gates 12       run the landing gates on slice 12, land nothing
  azelf run --retry 12       retry parked slice 12 in the running dispatcher
  azelf run --sync-edges     write the edges the bodies claim, then stop
  azelf run --help           this (also -h)

Inside a finished slice, run ./scripts/slice-done.sh: the dispatcher then
re-runs the gates, lands it, closes the ticket, and starts whatever that
unblocked. ./scripts/slice-run.ts takes the same flags.`;

/** The flags that take the argument after them. */
export const VALUE_FLAGS = new Set(["--max", "--interval", "--retry"]);

const FLAGS = new Set([
  ...VALUE_FLAGS,
  "-h",
  "--help",
  "-y",
  "--yes",
  "--plan",
  "--once",
  "--auto",
  "--no-start",
  "--review",
  "--no-review",
  "--no-auto-resolve",
  "--gates",
  "--sync-edges",
]);

export const wantsHelp = (argv: string[]): boolean =>
  argv.includes("-h") || argv.includes("--help");

/**
 * The first argument that looks like a flag and is not one, or null. Letting
 * those through is what once turned `--help` into a full plan and a
 * `proceed?`: every flag is read with `includes`, so a misspelt one is simply
 * never asked about. A value flag's argument is skipped, so `--max -1` is
 * left to --max.
 */
export function unknownFlag(argv: string[]): string | null {
  for (const [i, a] of argv.entries()) {
    if (!a.startsWith("-") || FLAGS.has(a)) continue;
    if (VALUE_FLAGS.has(argv[i - 1] ?? "")) continue;
    return a;
  }
  return null;
}
