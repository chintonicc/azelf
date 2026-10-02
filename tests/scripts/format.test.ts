import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AZELF, type Consumer, git, makeConsumer, shResult } from "./fixture";

/**
 * format.sh and paths that are not there. A named path nothing knows is an
 * error; a named path that was deleted is skipped. `bunx` is a fake on PATH
 * that records its arguments, so "nothing was formatted" can be asserted.
 */
describe("format.sh with named paths", () => {
  let c: Consumer;
  let calls: string;
  const format = (...args: string[]) =>
    shResult(
      c.main,
      `PATH=${JSON.stringify(join(c.root, "bin"))}:"$PATH" ${JSON.stringify(
        join(AZELF, "scripts", "format.sh"),
      )} ${args.map((a) => JSON.stringify(a)).join(" ")}`,
    );

  beforeEach(() => {
    c = makeConsumer({});
    calls = join(c.root, "bunx-calls");
    mkdirSync(join(c.root, "bin"));
    writeFileSync(
      join(c.root, "bin", "bunx"),
      `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> ${JSON.stringify(calls)}\n`,
      { mode: 0o755 },
    );
    writeFileSync(join(c.main, "a.ts"), "a\n");
    writeFileSync(join(c.main, "gone.ts"), "gone\n");
    git(c.main, "add", "a.ts", "gone.ts");
    git(c.main, "commit", "-qm", "files");
  });
  afterEach(() => rmSync(c.root, { recursive: true, force: true }));

  it("formats the paths it is given", () => {
    const r = format("a.ts");
    expect(r.ok, r.out).toBe(true);
    expect(readFileSync(calls, "utf8")).toContain("--apply a.ts");
  });

  it("fails on a path that is not there, and formats nothing", () => {
    const r = format("nope.ts");
    expect(r.ok).toBe(false);
    expect(r.out).toContain("error: no such path: nope.ts\n");
    expect(r.out).toContain("Nothing was formatted.");
    expect(existsSync(calls)).toBe(false);
  });

  it("formats nothing when a real path is named beside a missing one", () => {
    const r = format("a.ts", "nope.ts");
    expect(r.ok).toBe(false);
    expect(r.out).toContain("error: no such path: nope.ts");
    expect(existsSync(calls)).toBe(false);
  });

  it("says a list may have been passed unsplit", () => {
    const r = format("a.ts b.ts");
    expect(r.ok).toBe(false);
    expect(r.out).toContain(
      "error: no such path: a.ts b.ts (one argument — was a list passed unsplit?)",
    );
  });

  it("skips a deleted tracked path, and formats the rest", () => {
    rmSync(join(c.main, "gone.ts"));
    const r = format("a.ts", "gone.ts");
    expect(r.ok, r.out).toBe(true);
    expect(readFileSync(calls, "utf8").trim()).toMatch(/--apply a\.ts$/);
  });

  it("says so when every named path is deleted", () => {
    rmSync(join(c.main, "gone.ts"));
    const r = format("gone.ts");
    expect(r.ok).toBe(true);
    expect(r.out).toContain(
      "nothing to format — the 1 named path(s) are deleted.",
    );
    expect(existsSync(calls)).toBe(false);
  });

  it("with no arguments and a clean tree says there is nothing changed", () => {
    const r = format();
    expect(r.ok).toBe(true);
    expect(r.out).toContain("nothing to format — no changed files.");
  });

  it("with no arguments formats what changed, and skips a deletion", () => {
    rmSync(join(c.main, "gone.ts"));
    writeFileSync(join(c.main, "a.ts"), "b\n");
    const r = format();
    expect(r.ok, r.out).toBe(true);
    expect(readFileSync(calls, "utf8").trim()).toMatch(/--apply a\.ts$/);
  });
});
