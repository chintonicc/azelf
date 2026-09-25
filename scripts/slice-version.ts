/**
 * Which azelf is installed, read from disk, so a running dispatcher can tell
 * when the install under it changed.
 *
 * The shims resolve to the main checkout's install on purpose: one version
 * per wave. Bumping azelf there during a wave breaks that quietly. The
 * dispatcher already loaded its modules and keeps running the old code,
 * while every session, land and `slice-done.sh` it starts from then on runs
 * the new scripts. That mix is what the warning is for; see slice-run.ts.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** The package this file was loaded from. */
export const ownRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * A short label for the azelf installed at `root`:
 * - the commit, from the `.bun-tag` bun writes into a git install
 *   (`chintonicc-azelf-<sha>`; seen in consumer-a's `node_modules` on
 *   2026-09-24);
 * - failing that, when its newest script was written, which is what a
 *   registry install or a copy changes when it is replaced;
 * - "unknown" when neither can be read, which never reads as a change.
 */
export function installedVersion(root: string = ownRoot): string {
  try {
    const tag = readFileSync(join(root, ".bun-tag"), "utf8").trim();
    if (tag) return tag.slice(tag.lastIndexOf("-") + 1);
  } catch {
    // Not a git install. The scripts' times are next.
  }
  let newest = 0;
  try {
    const dir = join(root, "scripts");
    for (const f of readdirSync(dir)) {
      newest = Math.max(newest, statSync(join(dir, f)).mtimeMs);
    }
  } catch {
    // No scripts to read. That is an answer too.
  }
  if (newest === 0) return "unknown";
  return `scripts of ${new Date(newest)
    .toISOString()
    .slice(0, 19)
    .replace("T", " ")} UTC`;
}
