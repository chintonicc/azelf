/**
 * `azelf init` — the install steps a template repo would leave as README
 * bullets people skip.
 *
 * Four of them, and each exists because SKIPPING it fails quietly rather than
 * loudly:
 *
 *  1. The marker patterns, into `.git/info/exclude`. Never `.gitignore` — see
 *     the block text below, and the Phase 1 finding it quotes.
 *  2. Shims in the consumer's `scripts/`, so `./scripts/session-commit.sh` and
 *     the autostart hook keep working by the names everything already uses.
 *  3. A starter `slice.config.ts`, because the loader's first error in a fresh
 *     repo is otherwise "no slice.config.ts found", which says what is missing
 *     and not what to write.
 *  4. The shell hook, printed by default and installed only under `--hook`.
 *
 * EVERYTHING HERE IS IDEMPOTENT AND DELIMITED. Blocks are bounded by markers
 * and rewritten in place; nothing is appended twice. That matters most for the
 * rc file, where the alternative is a user's shell profile growing a copy of
 * this block on every run.
 */

import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { rcFilesFor } from "./slice-launcher";
import { configFor, detect } from "./slice-preset";

/** This package's root — the one place `import.meta.url` is still the right anchor. */
export const packageRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
);

const EXCLUDE_BEGIN = "# ─── azelf: slice tooling markers ───────────────────";
const EXCLUDE_END = "# ─── end azelf ──────────────────────────────────────";

/**
 * The six patterns, and the paragraph explaining where they are NOT.
 *
 * `.gitignore` is hashed RAW by @expo/fingerprint (source reason
 * `bareGitIgnore`), so an entry added there moves an Expo app's runtime version
 * and strands OTA updates for every shipped build until the next production
 * build. Measured in consumer-a: three .gitignore edits in one week, all pure
 * tooling hygiene with zero native effect, each costing a manual
 * revert-publish-restore on the next OTA.
 *
 * `.git/info/exclude` is untracked, not shipped, and not a fingerprint source.
 * Linked worktrees read the COMMON git dir, so one copy covers every slice
 * worktree too. The cost, stated so nobody rediscovers it: a fresh clone does
 * not get these, which is exactly why this is an `init` step.
 */
export const EXCLUDE_BLOCK = `${EXCLUDE_BEGIN}
# Local, generated, per-machine. These belong here and NOT in .gitignore:
# .gitignore is hashed raw by @expo/fingerprint (source reason \`bareGitIgnore\`),
# so every entry added to it moves the app's runtime version and strands OTA
# updates for already-shipped builds until the next production build.
# .git/info/exclude is untracked, not shipped, not a fingerprint source, and is
# read by every linked worktree because they share the common git dir.
# A fresh clone does not get this block — rerun \`azelf init\` there.
.slice-ticket.md
.slice-autostart
.slice-live
.slice-ready-to-land
.slice-flags
.slice-reviews/
${EXCLUDE_END}`;

/**
 * Replace a delimited block, or append it. Returns the new text and whether
 * anything actually changed, so callers can print "already current" instead of
 * claiming a write they did not make.
 */
export function upsertBlock(
  existing: string,
  begin: string,
  end: string,
  block: string,
): { text: string; changed: boolean } {
  const from = existing.indexOf(begin);
  const to = existing.indexOf(end);
  if (from !== -1 && to !== -1 && to > from) {
    // To the end of the LINE the delimiter sits on, not the end of the
    // delimiter string. Both delimiters here are followed by box-drawing rule
    // characters, so cutting at `to + end.length` would leave a row of stray
    // `─` behind on every rewrite — visible, and it accumulates.
    const eol = existing.indexOf("\n", to);
    const before = existing.slice(0, from);
    const after = eol === -1 ? "" : existing.slice(eol + 1);
    const text = `${before}${block}\n${after}`;
    return { text, changed: text !== existing };
  }
  const sep = existing.length === 0 || existing.endsWith("\n") ? "" : "\n";
  return { text: `${existing}${sep}\n${block}\n`, changed: true };
}

/**
 * The branch slices are cut from and land onto.
 *
 * `origin/HEAD` first, because that is what the remote actually calls its
 * default and it survives being read from a worktree on some other branch. The
 * current branch is the fallback, and `main` the last resort — a fresh repo with
 * no commits has neither.
 */
export function defaultBranch(root: string): string {
  const ask = (args: string[]): string | null => {
    const proc = spawnSync("git", ["-C", root, ...args], { encoding: "utf8" });
    const out = proc.status === 0 ? proc.stdout.trim() : "";
    return out.length > 0 ? out : null;
  };
  const remote = ask(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]);
  if (remote) return remote.replace(/^origin\//, "");
  const head = ask(["rev-parse", "--abbrev-ref", "HEAD"]);
  if (head && head !== "HEAD") return head;
  return "main";
}

/** The consumer repo's root, and its git dir — `--git-common-dir` so a worktree resolves to the main tree. */
export function gitPaths(cwd: string): { root: string; commonDir: string } {
  const ask = (arg: string): string => {
    const proc = spawnSync(
      "git",
      ["-C", cwd, "rev-parse", "--path-format=absolute", arg],
      { encoding: "utf8" },
    );
    if (proc.status !== 0) {
      throw new Error(`not a git repository: ${cwd}`);
    }
    return proc.stdout.trim();
  };
  const commonDir = ask("--git-common-dir");
  return { root: dirname(commonDir), commonDir };
}

/**
 * The scripts a consumer calls by name, and how. `source` vs `exec` is not a
 * style choice: slice-config.sh and db-lock-check.sh export variables and
 * define functions into the CALLER's shell, so running them in a subshell
 * would leave the caller with nothing.
 */
export const SHIMS: { name: string; how: "source" | "exec" }[] = [
  { name: "slice-config.sh", how: "source" },
  { name: "db-lock-check.sh", how: "source" },
  { name: "slice-session.sh", how: "exec" },
  { name: "slice-land.sh", how: "exec" },
  { name: "slice-done.sh", how: "exec" },
  { name: "session-commit.sh", how: "exec" },
  { name: "format.sh", how: "exec" },
];

/**
 * A shim body.
 *
 * The package is found by a RULE, not by a recorded path: `$AZELF_DIR` if set,
 * otherwise `node_modules/@chintonicc/azelf` under the repo root, which is where an
 * installed dependency is and is the same string on every machine — so the shim
 * is committable and survives the repo being cloned somewhere else.
 *
 * `fallback` is the absolute path this package was run from, written in only
 * when it is not already reachable by that rule. That is the sibling-checkout
 * case (developing azelf next to its consumer), and it is machine-specific by
 * nature; init says so when it writes one.
 *
 * A missing package is a loud, specific failure rather than
 * `source: no such file`, because these shims sit in the COMMIT path — the one
 * place where an unexplained error costs someone their staged work.
 */
export function shimText(opts: {
  name: string;
  how: "source" | "exec";
  fallback: string | null;
}): string {
  const { name, how, fallback } = opts;
  // `return` in a sourced file, `exit` in an executed one: a sourced shim that
  // called exit would kill the caller's shell.
  const stop = how === "source" ? "return 1" : "exit 1";
  const fb = fallback
    ? `\n[ -d "$_azelf_dir" ] || _azelf_dir=${JSON.stringify(fallback)}`
    : "";
  return `#!/usr/bin/env bash
# Generated by \`azelf init\`. The implementation lives in the azelf package;
# this exists so ./scripts/${name} keeps working by the name every script, doc
# and habit already uses. Regenerate with \`azelf init\` rather than editing.
_azelf_repo="$(cd "$(dirname "\${BASH_SOURCE[0]:-$0}")/.." && pwd -P)"
_azelf_dir="\${AZELF_DIR:-$_azelf_repo/node_modules/@chintonicc/azelf}"${fb}
if [ ! -f "$_azelf_dir/scripts/${name}" ]; then
  echo "error: azelf is not installed — no $_azelf_dir/scripts/${name}" >&2
  echo "       run 'bun install' here, or set AZELF_DIR to the package root." >&2
  ${stop}
fi
${
  how === "source"
    ? `# SOURCED, not executed: the real file defines functions and exports\n# variables into the CALLING shell, which a subshell would discard.\nsource "$_azelf_dir/scripts/${name}"`
    : `# The target's usage and error messages should name the command you TYPED,\n# not a file inside node_modules. \`exec -a\` cannot do this: the shebang line\n# makes bash re-set \`$0\` to the script path it opened, so argv[0] is discarded\n# for an interpreted script. An exported variable survives that.\nexport AZELF_INVOKED_AS="$0"\nexec "$_azelf_dir/scripts/${name}" "$@"`
}
`;
}

export type InitResult = { line: string; changed: boolean };

/**
 * The `/azelf` command as a Codex custom prompt.
 *
 * Same text, two differences that matter. It goes in `~/.codex/prompts/`, which
 * is the USER's home and not the repo — so it is opt-in, behind `--codex`,
 * rather than something init does to a machine on the way past. And the YAML
 * frontmatter is stripped: Claude Code reads it as metadata, and a reader that
 * does not will show it to the model as three lines of noise at the top of
 * every invocation.
 *
 * Unverified on this machine — the Codex CLI was not on PATH when this was
 * written, so the path and the loading behaviour are from Codex's documented
 * layout and not from a run. If `/azelf` does not appear, that is the first
 * thing to check.
 */
export function codexPrompt(home: string): InitResult {
  const body = readFileSync(
    join(packageRoot, "agent", "commands", "azelf.md"),
    "utf8",
  ).replace(/^---\n[\s\S]*?\n---\n/, "");
  const dest = join(home, ".codex", "prompts", "azelf.md");
  if (existsSync(dest)) {
    const current = readFileSync(dest, "utf8");
    if (current === body) return { line: `current  ${dest}`, changed: false };
    if (!current.includes(GENERATED)) {
      return { line: `yours    ${dest} — edited, left alone`, changed: false };
    }
  }
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, body);
  return {
    line: `wrote    ${dest} — restart Codex, then /azelf`,
    changed: true,
  };
}

export function init(opts: {
  cwd: string;
  installHook: boolean;
  installCodex?: boolean;
  home: string;
  env: NodeJS.ProcessEnv;
}): InitResult[] {
  const out: InitResult[] = [];
  const { root, commonDir } = gitPaths(opts.cwd);
  const selfHosted = resolve(root) === resolve(packageRoot);

  // 1. the markers
  const excludePath = join(commonDir, "info", "exclude");
  mkdirSync(dirname(excludePath), { recursive: true });
  const before = existsSync(excludePath)
    ? readFileSync(excludePath, "utf8")
    : "";
  const { text, changed } = upsertBlock(
    before,
    EXCLUDE_BEGIN,
    EXCLUDE_END,
    EXCLUDE_BLOCK,
  );
  if (changed) writeFileSync(excludePath, text);
  out.push({
    line: `${changed ? "wrote" : "current"}  ${relative(
      root,
      excludePath,
    )} — 6 marker patterns`,
    changed,
  });

  // 2. the shims
  if (selfHosted) {
    out.push({
      line: "skipped scripts/ shims — this repo IS the package; a shim here would source itself",
      changed: false,
    });
  } else {
    // Reachable by the rule already? Then the shim needs no absolute path.
    const byRule = resolve(root, "node_modules", "@chintonicc", "azelf");
    const fallback =
      resolve(byRule) === resolve(packageRoot) || existsSync(byRule)
        ? null
        : packageRoot;
    if (fallback) {
      out.push({
        line: `note     azelf is not at node_modules/@chintonicc/azelf; shims fall back to ${fallback}, which is machine-specific`,
        changed: false,
      });
    }
    mkdirSync(join(root, "scripts"), { recursive: true });
    for (const { name, how } of SHIMS) {
      const dest = join(root, "scripts", name);
      const body = shimText({ name, how, fallback });
      const same = existsSync(dest) && readFileSync(dest, "utf8") === body;
      if (!same) {
        writeFileSync(dest, body);
        chmodSync(dest, 0o755);
      }
      out.push({
        line: `${same ? "current" : "wrote"}  scripts/${name} (${how})`,
        changed: !same,
      });
    }
  }

  // 3. a config that already fits this project
  const configPath = join(root, "slice.config.ts");
  if (existsSync(configPath)) {
    out.push({ line: "current  slice.config.ts", changed: false });
  } else {
    const found = detect(root);
    writeFileSync(
      configPath,
      configFor(found, { baseBranch: defaultBranch(root) }),
    );
    out.push({
      line: `wrote    slice.config.ts — detected ${found.stack} / ${
        found.runner
      }, base branch ${defaultBranch(root)}`,
      changed: true,
    });
    for (const n of found.notes)
      out.push({ line: `         ${n}`, changed: false });
  }

  // 4. the agent-facing half
  out.push(...agentFiles(root));

  if (opts.installCodex) out.push(codexPrompt(opts.home));

  // 5. the hook
  out.push(hookStep(opts));
  return out;
}

/**
 * The marker that makes an upgrade safe. init rewrites a file it wrote and
 * leaves alone one you have edited, and the only way to tell them apart is a
 * line in the file itself — the same problem the hook block has, solved the
 * same way. Anything that has lost this line is yours.
 */
export const GENERATED = "generated by `azelf init`";

/**
 * `/azelf` and the slice skill.
 *
 * These are the prompt-shaped half of the workflow and they belong with the
 * code, not in a README: the dispatcher's contract (re-run the gates, never
 * trust a session's word for them) and the session's contract (read the ticket,
 * commit with explicit paths, do NOT mark done on red gates) are the same
 * design decisions the scripts enforce, stated where an agent will read them.
 *
 * Written into the repo rather than a user's home so they are committable and
 * every session in the project gets the same ones.
 */
export function agentFiles(root: string): InitResult[] {
  const files: { from: string[]; to: string[] }[] = [
    {
      from: ["agent", "commands", "azelf.md"],
      to: [".claude", "commands", "azelf.md"],
    },
    {
      from: ["agent", "skills", "slice", "SKILL.md"],
      to: [".claude", "skills", "slice", "SKILL.md"],
    },
  ];
  return files.map(({ from, to }) => {
    const src = join(packageRoot, ...from);
    const dest = join(root, ...to);
    const rel = to.join("/");
    const body = readFileSync(src, "utf8");
    if (existsSync(dest)) {
      const current = readFileSync(dest, "utf8");
      if (current === body) return { line: `current  ${rel}`, changed: false };
      if (!current.includes(GENERATED)) {
        return { line: `yours    ${rel} — edited, left alone`, changed: false };
      }
    }
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, body);
    return { line: `wrote    ${rel}`, changed: true };
  });
}

const HOOK_BEGIN = "# ─── slice autostart";
const HOOK_END = "# ─── end slice autostart";

/**
 * The installable half of scripts/slice-autostart.sh: the delimiters and
 * everything between them. The file continues past the end delimiter with
 * commentary aimed at whoever maintains the block — useful in the package,
 * noise in a user's shell profile.
 */
export function hookBlock(): string {
  const file = readFileSync(
    join(packageRoot, "scripts", "slice-autostart.sh"),
    "utf8",
  );
  const from = file.indexOf(HOOK_BEGIN);
  const to = file.indexOf(HOOK_END);
  if (from === -1 || to === -1) {
    throw new Error(
      "scripts/slice-autostart.sh has lost its delimiters — init cannot tell where the block ends",
    );
  }
  const eol = file.indexOf("\n", to);
  return file.slice(from, eol === -1 ? undefined : eol);
}

/** The version stamped in the hook's first line — see slice-autostart.sh. */
export function hookVersion(block: string): string | null {
  const m = block.match(/# ─── slice autostart (v\d+)/);
  return m ? m[1] : null;
}

export function hookStep(opts: {
  installHook: boolean;
  home: string;
  env: NodeJS.ProcessEnv;
}): InitResult {
  const block = hookBlock();
  const version = hookVersion(block) ?? "v?";

  const shell = opts.env.SHELL ?? "";
  const files = rcFilesFor(shell, opts.home, opts.env);
  if (!files || files.length === 0) {
    return {
      line: `hook     no rc file known for SHELL=${
        shell || "(unset)"
      } — paste the block from scripts/slice-autostart.sh yourself`,
      changed: false,
    };
  }
  const rc = files[0];
  const existing = existsSync(rc) ? readFileSync(rc, "utf8") : "";
  const installed = existing.includes(HOOK_BEGIN);
  const current = installed && existing.includes(`${HOOK_BEGIN} ${version}`);

  if (current)
    return { line: `current  hook ${version} in ${rc}`, changed: false };
  if (!opts.installHook) {
    return {
      line: installed
        ? `hook     ${rc} carries an OLDER block — rerun with --hook to replace it with ${version}`
        : `hook     not installed in ${rc} — rerun with --hook to add ${version}`,
      changed: false,
    };
  }
  // A backup, once, before touching a file this tool does not own.
  if (existing && !existsSync(`${rc}.azelf-bak`)) {
    writeFileSync(`${rc}.azelf-bak`, existing);
  }
  const { text } = upsertBlock(existing, HOOK_BEGIN, HOOK_END, block);
  writeFileSync(rc, text);
  return {
    line: `wrote    hook ${version} into ${rc} (backup: ${rc}.azelf-bak) — open a new tab to load it`,
    changed: true,
  };
}
