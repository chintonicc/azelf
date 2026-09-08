#!/usr/bin/env bun
/**
 * The command line. Two verbs and a passthrough:
 *
 *   azelf init [--hook] [--codex]   install into the repo you are standing in
 *   azelf run  [args…]    the dispatcher (`--plan`, `--auto`, ticket ids…)
 *   azelf hook            print the shell block, for pasting by hand
 *
 * `run` SPAWNS the dispatcher rather than importing it. slice-run.ts is a
 * script, not a library: it reads `process.argv` and does its work at import
 * time under a top-level await. Importing it here would mean rewriting argv
 * underneath it and inheriting its exit path; a spawn keeps both files honest
 * about what they are, and the extra ~30ms is noise next to a `bun install`.
 */

import { spawnSync } from "node:child_process";
import { hookBlock, init, packageRoot } from "../scripts/slice-init";

const argv = process.argv.slice(2);
const verb = argv[0];

const usage = (): never => {
  console.error(
    [
      "usage:",
      "  azelf init [--hook] [--codex]",
      "        markers, shims, a starter config, /azelf and the slice skill",
      "        --hook    install the shell autostart block (backs up your rc file)",
      "        --codex   also install /azelf into ~/.codex/prompts",
      "  azelf run [args…]",
      "        dispatch slices: --plan, --auto, or explicit ticket ids",
      "  azelf hook",
      "        print the shell autostart block, for pasting by hand",
    ].join("\n"),
  );
  process.exit(2);
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
} else if (verb === "run") {
  const proc = spawnSync(
    "bun",
    [`${packageRoot}/scripts/slice-run.ts`, ...argv.slice(1)],
    { stdio: "inherit" },
  );
  process.exit(proc.status ?? 1);
} else if (verb === "hook") {
  console.log(hookBlock());
} else {
  usage();
}
