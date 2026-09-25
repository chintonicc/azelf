import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installedVersion } from "@/scripts/slice-version";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

/** A package root with two scripts, the newer written at `newest`. */
let root: string;
const newest = new Date("2026-09-23T14:31:05Z");
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "azelf-version-")));
  mkdirSync(join(root, "scripts"));
  for (const [f, at] of [
    ["a.ts", new Date("2026-09-01T00:00:00Z")],
    ["b.sh", newest],
  ] as const) {
    writeFileSync(join(root, "scripts", f), "");
    utimesSync(join(root, "scripts", f), at, at);
  }
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("installedVersion", () => {
  it("reads the commit from bun's tag on a git install", () => {
    writeFileSync(join(root, ".bun-tag"), "chintonicc-azelf-a3899a5\n");
    expect(installedVersion(root)).toBe("a3899a5");
  });

  it("falls back to when the newest script was written", () => {
    expect(installedVersion(root)).toBe("scripts of 2026-09-23 14:31:05 UTC");
  });

  it("changes when the install is replaced", () => {
    writeFileSync(join(root, ".bun-tag"), "chintonicc-azelf-a3899a5\n");
    const before = installedVersion(root);
    writeFileSync(join(root, ".bun-tag"), "chintonicc-azelf-6383445\n");
    expect(installedVersion(root)).not.toBe(before);

    rmSync(join(root, ".bun-tag"));
    const untagged = installedVersion(root);
    writeFileSync(join(root, "scripts", "c.ts"), "");
    expect(installedVersion(root)).not.toBe(untagged);
  });

  it("says unknown when there is nothing to read", () => {
    rmSync(join(root, "scripts"), { recursive: true });
    expect(installedVersion(root)).toBe("unknown");
  });
});
