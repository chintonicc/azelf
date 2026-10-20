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
 * format.sh, its paths and its options. A named path nothing knows is an
 * error; a named path that was deleted is skipped. `bunx` is a fake on PATH
 * that records its arguments, so "nothing was formatted" can be asserted, and
 * that fails while `bunx-fails` exists, the way biome does when it would
 * change something. While `bunx-says` exists it prints that file to stderr
 * first, where biome prints its diagnostics.
 */
describe("format.sh", () => {
  let c: Consumer;
  let calls: string;
  let says: string;
  const format = (...args: string[]) => formatIn(c.main, ...args);
  const formatIn = (cwd: string, ...args: string[]) =>
    shResult(
      cwd,
      `PATH=${JSON.stringify(join(c.root, "bin"))}:"$PATH" ${JSON.stringify(
        join(AZELF, "scripts", "format.sh"),
      )} ${args.map((a) => JSON.stringify(a)).join(" ")}`,
    );

  beforeEach(() => {
    c = makeConsumer({});
    calls = join(c.root, "bunx-calls");
    says = join(c.root, "bunx-says");
    mkdirSync(join(c.root, "bin"));
    writeFileSync(
      join(c.root, "bin", "bunx"),
      `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> ${JSON.stringify(
        calls,
      )}\n[ ! -e ${JSON.stringify(says)} ] || cat ${JSON.stringify(
        says,
      )} >&2\n[ ! -e ${JSON.stringify(join(c.root, "bunx-fails"))} ]\n`,
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

  /**
   * A slice session ran `format.sh --help`, got "no such path: --help", and
   * could not tell whether a check-only mode existed. Its skill says a gate
   * must not write to the tree, so it ran biome by hand instead.
   */
  describe("options", () => {
    it("--help prints the usage, even outside a repository, and formats nothing", () => {
      const r = formatIn(c.root, "--help");
      expect(r.code).toBe(0);
      expect(r.stdout).toContain("usage: ");
      expect(r.stdout).toContain("--check");
      expect(r.stdout).toContain("-h, --help");
      expect(existsSync(calls)).toBe(false);
    });

    it("--check runs biome without --apply, and passes on its answer", () => {
      const r = format("--check", "a.ts");
      expect(r.code, r.out).toBe(0);
      expect(r.out).toContain(
        "▶ biome check on 1 file(s) (no changes written)",
      );
      expect(readFileSync(calls, "utf8").trim()).toBe(
        "biome check --no-errors-on-unmatched a.ts",
      );

      writeFileSync(join(c.root, "bunx-fails"), "");
      expect(format("--check", "a.ts").code).toBe(1);
    });

    it("reads --check after the paths too", () => {
      const r = format("a.ts", "--check");
      expect(r.code, r.out).toBe(0);
      expect(readFileSync(calls, "utf8")).not.toContain("--apply");
    });

    it("says there is nothing to check, in check mode", () => {
      const r = format("--check");
      expect(r.code).toBe(0);
      expect(r.out).toContain("nothing to check — no changed files.");
    });

    it("refuses an unknown option with the usage, exit 64", () => {
      const r = format("--bogus", "a.ts");
      expect(r.code).toBe(64);
      expect(r.stdout).toBe("");
      expect(r.out).toContain("unknown option: --bogus\nusage: ");
      expect(existsSync(calls)).toBe(false);
    });

    it("takes everything after -- as a path, and hands biome a dash path it can't misread", () => {
      writeFileSync(join(c.main, "-odd.ts"), "x\n");
      const r = format("--", "-odd.ts", "--check");
      // --check after -- is a path, and there is no such file.
      expect(r.code).toBe(1);
      expect(r.out).toContain("error: no such path: --check");

      const ok = format("--", "-odd.ts");
      expect(ok.code, ok.out).toBe(0);
      expect(readFileSync(calls, "utf8").trim()).toBe(
        "biome check --no-errors-on-unmatched --apply ./-odd.ts",
      );
    });
  });

  /**
   * A session on consumer-a's main checkout ran format.sh on nine paths while
   * its sandbox denied writes there. Biome printed "Operation not permitted"
   * eight times and "Fixed 8 file(s)", and exited 0, and so did format.sh.
   * The diagnostics here are the ones biome 1.5.3 prints for that file.
   */
  describe("a file biome could not write", () => {
    const internal = (path: string, why: string) =>
      `${path} internalError/io  INTERNAL  ━━━━━━━━━━━━━━━━━━━━\n\n  × ${why}\n  \n  ! This diagnostic was derived from an internal Biome error. Potential bug, please report it if necessary.\n  \n\n`;

    it("fails the run and names the file, though biome exits 0", () => {
      writeFileSync(
        says,
        internal("a.ts", "Operation not permitted (os error 1)"),
      );
      const r = format("a.ts");
      expect(r.code, r.out).toBe(1);
      expect(r.out).toContain("Operation not permitted (os error 1)");
      expect(r.out).toContain(
        "✗ biome could not write 1 file(s), so they are NOT formatted:\n  a.ts\n",
      );
    });

    it("under --check, says it could not read the file", () => {
      writeFileSync(says, internal("a.ts", "Permission denied (os error 13)"));
      const r = format("--check", "a.ts");
      expect(r.code, r.out).toBe(1);
      expect(r.out).toContain(
        "✗ biome could not read 1 file(s), so they are NOT checked:\n  a.ts\n",
      );
    });

    it("reads the header through biome's colours", () => {
      const e = "\u001b";
      writeFileSync(
        says,
        `${e}[0m\n${e}[0ma.ts${e}[0m${e}[0m ${e}[0m${e}[0minternalError/io${e}[0m${e}[0m ${e}[0m${e}[0m${e}[30m${e}[41m INTERNAL ${e}[0m\n`,
      );
      const r = format("a.ts");
      expect(r.code, r.out).toBe(1);
      expect(r.out).toContain("NOT formatted:\n  a.ts\n");
    });

    it("still passes a file biome has no handler for", () => {
      writeFileSync(join(c.main, "notes.md"), "# notes\n");
      writeFileSync(
        says,
        "notes.md files/missingHandler ━━━━━━━━━━━━━━━━━━━━\n\n  ! Biome doesn't know how to process this file\n  \n\n",
      );
      const r = format("a.ts", "notes.md");
      expect(r.code, r.out).toBe(0);
      expect(r.out).not.toContain("✗");
    });
  });
});
