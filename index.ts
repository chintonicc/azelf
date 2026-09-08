/**
 * The package's public surface: what a consumer's `slice.config.ts` imports.
 *
 *   import { exitCode, baselineDiff, github, warp } from "azelf";
 *
 * Deliberately NOT re-exported here: anything from `scripts/slice-config.ts`
 * at run time. That module's job is to FIND and load the consumer's config, so
 * it awaits `slice.config.ts` at import time — and `slice.config.ts` imports
 * this file. Re-exporting a value from it would close that circle and
 * deadlock the module graph on the consumer's very first import. The one thing
 * taken from it is the `SliceConfig` type, under `export type`, which TypeScript
 * erases before any of that can happen.
 */

export type { Agent, Which } from "./scripts/slice-agent";
export { claude, codex, custom } from "./scripts/slice-agent";

export type { Gate, GateResult } from "./scripts/slice-gates";
export {
  baselineDiff,
  exitCode,
  exitCodeOverFiles,
  runGates,
} from "./scripts/slice-gates";

export type {
  Blocker,
  TicketId,
  TicketInfo,
  TicketState,
  Tracker,
} from "./scripts/slice-tracker";
export { github } from "./scripts/slice-tracker";

export type { Launcher, Session, Spawn } from "./scripts/slice-launcher";
export { manual, tmux, warp } from "./scripts/slice-launcher";

export type { SliceConfig } from "./scripts/slice-config";
