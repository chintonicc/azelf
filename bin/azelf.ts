#!/usr/bin/env bun
/**
 * The command line. Two verbs and two passthroughs:
 *
 *   azelf init [--hook] [--codex]   install into the repo you are standing in
 *   azelf run  [args…]    the dispatcher (`--plan`, `--auto`, ticket ids…)
 *   azelf retry <id>      retry a parked slice in the running dispatcher
 *   azelf hook            print the shell block, for pasting by hand
 *
 * `run` and `retry` SPAWN the dispatcher rather than importing it. slice-run.ts is a
 * script, not a library: it reads `process.argv` and does its work at import
 * time under a top-level await. Importing it here would mean rewriting argv
 * underneath it and inheriting its exit path; a spawn keeps both files honest
 * about what they are, and the extra ~30ms is noise next to a `bun install`.
 */

import { spawnSync } from "node:child_process";
import { hookBlock, init, packageRoot } from "../scripts/slice-init";
import { USAGE, wantsHelp } from "../scripts/slice-run-usage";

const argv = process.argv.slice(2);
const verb = argv[0];

const usage = (asked = false): never => {
  // Asked for, it is the answer and goes to stdout; after a mistake it is the
  // error, on stderr, with the exit code that says so.
  (asked ? console.log : console.error)(
    [
      "usage:",
      "  azelf init [--hook] [--codex]",
      "        markers, shims, a starter config, /azelf and the slice skill",
      "        --hook    install the shell autostart block (backs up your rc file)",
      "        --codex   also install /azelf into ~/.codex/prompts",
      "  azelf run [args…]",
      "        dispatch slices: --plan, --auto, or explicit ticket ids",
      "        azelf run --help lists every flag",
      "  azelf retry <ticket>",
      "        retry a parked slice's land in the running dispatcher's next round",
      "  azelf hook",
      "        print the shell autostart block, for pasting by hand",
    ].join("\n"),
  );
  process.exit(asked ? 0 : 2);
};

if (verb === "init") {
  const results = init({
    cwd: process.cwd(),
    installHook: argv.includes("--hook"),
    installCodex: argv.includes("--codex"),
    home: process.env.HOME ?? "",
    env: process.env,
  });
  for (const r of results) console.log(r.line);
  const wrote = results.filter((r) => r.changed).length;
  console.log(
    wrote === 0
      ? "\nnothing to do — this repo is already set up."
      : `\n${wrote} change${
          wrote === 1 ? "" : "s"
        }. Edit slice.config.ts before the first run.`,
  );
} else if (verb === "-h" || verb === "--help") {
  usage(true);
} else if (verb === "run" && wantsHelp(argv.slice(1))) {
  // Here rather than in the dispatcher, which cannot start without a
  // slice.config.ts; the help is for finding out what to put in one.
  console.log(USAGE);
} else if (verb === "run" || verb === "retry") {
  if (verb === "retry" && argv.length !== 2) usage();
  const args =
    verb === "retry" ? ["--retry", argv[1] as string] : argv.slice(1);
  const proc = spawnSync(
    "bun",
    [`${packageRoot}/scripts/slice-run.ts`, ...args],
    { stdio: "inherit" },
  );
  process.exit(proc.status ?? 1);
} else if (verb === "hook") {
  console.log(hookBlock());
} else {
  usage();
}
