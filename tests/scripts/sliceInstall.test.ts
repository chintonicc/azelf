import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  INSTALL_MANIFESTS,
  detectInstall,
  installFor,
  installName,
} from "@/scripts/slice-install";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "azelf-install-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const touch = (f: string) => writeFileSync(join(dir, f), "");

/**
 * The two repos that made `bun install` the wrong default: one without a
 * package.json (bun exits 1 and the prep died), one with package-lock.json
 * (bun wrote an untracked bun.lock and resolved differently from `npm ci`).
 */
describe("the lockfile decides", () => {
  it("installs nothing where there is no package.json, and says so", () => {
    touch("requirements.txt");
    expect(detectInstall(dir, "prep")).toEqual({
      argv: [],
      why: "no package.json — nothing to install",
    });
    expect(detectInstall(dir, "reinstall").argv).toEqual([]);
  });

  it.each([
    ["package-lock.json", ["npm", "ci"]],
    ["pnpm-lock.yaml", ["pnpm", "install", "--frozen-lockfile"]],
    ["yarn.lock", ["yarn", "install", "--frozen-lockfile"]],
  ])("reads %s as %j, the same in both phases", (lock, argv) => {
    touch("package.json");
    touch(lock);
    expect(detectInstall(dir, "prep")).toEqual({ argv, why: lock });
    expect(detectInstall(dir, "reinstall").argv).toEqual(argv);
  });

  /** What the extracted project always ran: plain at prep, frozen after a rebase. */
  it.each(["bun.lock", "bun.lockb"])("keeps bun's two forms for %s", (lock) => {
    touch("package.json");
    touch(lock);
    expect(detectInstall(dir, "prep")).toEqual({
      argv: ["bun", "install"],
      why: lock,
    });
    expect(detectInstall(dir, "reinstall").argv).toEqual([
      "bun",
      "install",
      "--frozen-lockfile",
    ]);
  });

  it("falls back to bun for a package.json with no lockfile — the one tool azelf requires", () => {
    touch("package.json");
    const prep = detectInstall(dir, "prep");
    expect(prep.argv).toEqual(["bun", "install"]);
    expect(prep.why).toContain("without a lockfile");
    // As before: frozen after a rebase, which with no lockfile writes nothing.
    expect(detectInstall(dir, "reinstall").argv).toEqual([
      "bun",
      "install",
      "--frozen-lockfile",
    ]);
  });

  it("prefers bun's lockfile when a checkout carries more than one", () => {
    touch("package.json");
    touch("package-lock.json");
    touch("bun.lock");
    expect(detectInstall(dir, "prep").why).toBe("bun.lock");
  });
});

describe("the config wins", () => {
  it("uses a configured command in both phases, as given", () => {
    touch("package.json");
    touch("bun.lock");
    const configured = ["npm", "ci", "--ignore-scripts"];
    for (const phase of ["prep", "reinstall"] as const) {
      expect(installFor(configured, dir, phase)).toEqual({
        argv: configured,
        why: "install in slice.config.ts",
      });
    }
  });

  it("treats [] as 'install nothing', not as 'decide for me'", () => {
    touch("package.json");
    touch("bun.lock");
    expect(installFor([], dir, "prep")).toEqual({
      argv: [],
      why: "install: [] in slice.config.ts",
    });
  });

  it("hands back a copy, so a caller cannot edit the config's array", () => {
    const configured = ["npm", "ci"];
    installFor(configured, dir, "prep").argv.push("--x");
    expect(configured).toEqual(["npm", "ci"]);
  });
});

describe("what makes an install stale", () => {
  it("names the manifest and every lockfile this module reads", () => {
    expect([...INSTALL_MANIFESTS].sort()).toEqual([
      "bun.lock",
      "bun.lockb",
      "package-lock.json",
      "package.json",
      "pnpm-lock.yaml",
      "yarn.lock",
    ]);
  });

  it("names a command the way a message reads it", () => {
    expect(installName(["npm", "ci"])).toBe("npm ci");
  });
});
