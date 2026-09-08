import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configFor, detect, execFor, runFor } from "@/scripts/slice-preset";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "azelf-preset-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const pkg = (o: unknown) =>
  writeFileSync(join(dir, "package.json"), JSON.stringify(o));
const touch = (f: string) => writeFileSync(join(dir, f), "");

describe("stack detection", () => {
  it("finds expo", () => {
    pkg({ dependencies: { expo: "~52" } });
    expect(detect(dir).stack).toBe("expo");
  });

  it("finds next", () => {
    pkg({ dependencies: { next: "15" } });
    expect(detect(dir).stack).toBe("nextjs");
  });

  it("falls back to plain typescript", () => {
    pkg({ dependencies: { lodash: "4" } });
    expect(detect(dir).stack).toBe("typescript");
  });

  it("finds python from pyproject.toml", () => {
    touch("pyproject.toml");
    expect(detect(dir).stack).toBe("python");
  });

  it("finds python from requirements.txt", () => {
    touch("requirements.txt");
    expect(detect(dir).stack).toBe("python");
  });

  /**
   * A Python service with a small JS frontend is common; the reverse is rare.
   * Guessing wrong toward Python writes gates that cannot run at all.
   */
  it("prefers the javascript side when both are present, and says so", () => {
    pkg({ dependencies: { next: "15" } });
    touch("pyproject.toml");
    const d = detect(dir);
    expect(d.stack).toBe("nextjs");
    expect(d.notes.join(" ")).toContain("both package.json and Python");
  });

  it("does not report a typescript fallback for a python project", () => {
    touch("pyproject.toml");
    expect(detect(dir).notes.join(" ")).not.toContain("falling back");
  });

  it("survives having no project files at all", () => {
    expect(detect(dir).stack).toBe("typescript");
  });
});

describe("runner detection", () => {
  it.each([
    ["bun.lock", "bun"],
    ["pnpm-lock.yaml", "pnpm"],
    ["yarn.lock", "yarn"],
  ])("reads %s as %s", (lock, runner) => {
    pkg({});
    touch(lock);
    expect(detect(dir).runner).toBe(runner);
  });

  it("defaults to npm with no lockfile", () => {
    pkg({});
    expect(detect(dir).runner).toBe("npm");
  });

  it.each([
    ["uv.lock", "uv"],
    ["poetry.lock", "poetry"],
  ])("reads %s as %s", (lock, runner) => {
    touch("pyproject.toml");
    touch(lock);
    expect(detect(dir).runner).toBe(runner);
  });

  /** Bare pytest and `uv run pytest` are different programs against different deps. */
  it("warns when a python project has no lockfile to run through", () => {
    touch("pyproject.toml");
    expect(detect(dir).notes.join(" ")).toContain("virtualenv");
  });
});

describe("the generated config", () => {
  const gen = () => configFor(detect(dir), { baseBranch: "main" });

  it("uses the detected runner for every gate", () => {
    pkg({
      scripts: { test: "vitest" },
      devDependencies: { "@biomejs/biome": "1" },
    });
    touch("pnpm-lock.yaml");
    const c = gen();
    expect(c).toContain('["pnpm", "run", "test"]');
    expect(c).toContain('["pnpm", "dlx", "tsc", "--noEmit"]');
    expect(c).toContain('["pnpm", "dlx", "biome", "check"');
  });

  it("writes python gates through uv", () => {
    writeFileSync(
      join(dir, "pyproject.toml"),
      '[project]\ndev = ["pytest", "ruff", "mypy"]',
    );
    touch("uv.lock");
    mkdirSync(join(dir, "tests"));
    const c = gen();
    expect(c).toContain('["uv", "run", "pytest"]');
    expect(c).toContain('["uv", "run", "mypy", "."]');
    expect(c).toContain('["uv", "run", "ruff", "check"]');
  });

  /** A gate for a tool that is not installed fails every slice for no reason. */
  it("comments out gates whose tool was not found", () => {
    pkg({});
    const c = gen();
    expect(c).toContain("// no test runner was detected");
    expect(c).toContain("// no linter was found");
  });

  it("provisions expo's generated type declaration, with the reason", () => {
    pkg({ dependencies: { expo: "~52" } });
    const c = gen();
    expect(c).toContain('[".env", "expo-env.d.ts"]');
    expect(c).toContain("phantom typecheck error");
  });

  it("never provisions a virtualenv into a python worktree", () => {
    touch("pyproject.toml");
    const c = gen();
    expect(c).toContain('[".env"]');
    expect(c).not.toContain('.venv"');
  });

  it("carries the base branch it was given", () => {
    pkg({});
    expect(configFor(detect(dir), { baseBranch: "master" })).toContain(
      'baseBranch: "master"',
    );
  });

  it("imports from the scoped package name", () => {
    pkg({});
    expect(gen()).toContain('from "@chintonicc/azelf"');
  });
});

describe("runner command shapes", () => {
  it("knows how each runner executes a bin", () => {
    expect(execFor("bun")).toEqual(["bunx"]);
    expect(execFor("npm")).toEqual(["npx"]);
    expect(execFor("uv")).toEqual(["uv", "run"]);
    expect(execFor("poetry")).toEqual(["poetry", "run"]);
    // pip has no runner prefix: the gate calls the tool directly and relies on
    // the worktree's active virtualenv, which is why detect() warns about it.
    expect(execFor("pip")).toEqual([]);
  });

  it("knows how each runner runs a package script", () => {
    expect(runFor("npm")).toEqual(["npm", "run"]);
    expect(runFor("bun")).toEqual(["bun", "run"]);
  });
});
