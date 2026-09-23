/**
 * Whether an agent's conflict resolution is allowed to land.
 *
 * WHY THIS IS A SEPARATE FILE AND NOT A FEW LINES IN slice-run.ts
 * --------------------------------------------------------------
 * Same split as slice-overlap.ts, for the same reason. Everything here is a
 * decision over facts — no git, no filesystem, no worktree — so it can be
 * tested without a repository, which matters more here than anywhere else in
 * this package: the whole point of these checks is the case where the resolver
 * got it WRONG, and a test that has to first produce a genuinely wrong
 * resolution is a test nobody writes. Reading the facts (running `git status`,
 * looking for `rebase-merge`, opening the changed files) is slice-run.ts's,
 * next to the other git.
 *
 * WHY THERE ARE CHECKS AT ALL
 * ---------------------------
 * Because azelf verifies; it does not take an agent's word for anything. The
 * gates already exist for exactly this reason on the slice's own code, and a
 * resolution is code the slice's author never wrote and nobody watched being
 * written. In consumer-a's first wave a by-hand "keep both sides" resolution of
 * one of these conflicts produced `error TS1005: '}' expected` across ten test
 * files, because git's `=======` had fallen inside a `describe(...)` body — the
 * marker check below is the cheap check that catches that shape before the
 * gates spend a tsc run on it.
 *
 * The gates themselves are check 5 and are not here: `tryLand` runs them
 * immediately afterwards anyway, so a resolution that passes 1–4 is verified by
 * the same run that would have verified the slice. Free, and it means a
 * resolution is held to exactly the standard the code it is fixing was.
 */

/** What the worktree looks like once every stop is resolved and continued. */
export type ResolutionState = {
  /** The base branch's name, for the message when the rebase did not happen. */
  base: string;
  /** Is a rebase still in progress — `rebase-merge` / `rebase-apply` present? */
  rebaseInProgress: boolean;
  /** `git status --porcelain` lines; empty is the only acceptable answer. */
  dirty: string[];
  /** `git merge-base --is-ancestor <base> HEAD` — did the rebase happen at all? */
  rebased: boolean;
  /** Changed files that still contain conflict markers. */
  markerFiles: string[];
};

/**
 * What the worktree looks like after the resolver has had ONE stop of the
 * rebase — before azelf stages its files and continues.
 *
 * The resolver edits and azelf runs the git: a resolver told to finish the
 * rebase itself needed permission to run `git add`, which `acceptEdits` does
 * not grant, and on consumer-a four correct resolutions were thrown away
 * because the rebase was still in progress when the resolver gave up asking.
 * So every stop is checked here first, and only then staged.
 */
export type StopState = {
  /** What the resolver printed. A line starting `IRRECONCILABLE:` is its refusal. */
  output: string;
  /** The files it was given that still hold conflict markers. */
  markerFiles: string[];
  /** Paths it changed or created that it was not given. */
  stray: string[];
};

/** How many paths a failure message names before it stops listing them. */
const SHOWN = 3;

const list = (files: string[]): string =>
  files.length <= SHOWN
    ? files.join(", ")
    : `${files.slice(0, SHOWN).join(", ")} and ${files.length - SHOWN} more`;

/**
 * Why this resolution must be thrown away, or null if it may proceed to the
 * gates.
 *
 * Ordered by how early the resolver gave up, so the message names the FIRST
 * thing that went wrong rather than a downstream symptom: a run that stopped
 * mid-rebase is also dirty and also not rebased, and "it is still mid-rebase"
 * is the sentence that tells you what happened.
 */
export function resolutionProblem(s: ResolutionState): string | null {
  if (s.rebaseInProgress) {
    return "the rebase is still in progress — the resolver stopped part-way through it";
  }
  if (s.dirty.length > 0) {
    return `the worktree is dirty afterwards (${s.dirty.length} path(s)) — a resolution ends in a committed rebase, not in edits left lying about`;
  }
  if (!s.rebased) {
    return `the branch is still not on ${s.base} — the rebase was abandoned rather than resolved`;
  }
  if (s.markerFiles.length > 0) {
    return `conflict markers are still in the tree: ${list(s.markerFiles)}`;
  }
  return null;
}

/**
 * The resolver's own refusal, if it printed one: the text after
 * `IRRECONCILABLE:`. Markdown emphasis around the word is tolerated, because
 * a model asked for a plain line often bolds it anyway.
 */
export function irreconcilable(output: string): string | null {
  const m = output.match(/^[\s>*`_]*IRRECONCILABLE:[*`_]*[ \t]*(.*)$/m);
  if (!m) return null;
  return (m[1] ?? "").replace(/[*`_\s]+$/, "") || "(no reason given)";
}

/**
 * Why this stop's resolution must not be staged, or null if azelf may run
 * `git add` and `rebase --continue` on it.
 *
 * The refusal comes first: a resolver that says the sides cannot coexist has
 * left the markers in place on purpose, and "markers are still there" would
 * name the symptom instead of its answer. Stray edits come last, and are
 * checked at all because nothing else would say it: git's `--continue` over
 * an unrelated unstaged edit fails with "You must edit all merge conflicts",
 * which sends whoever reads it looking at the wrong file.
 */
export function stopProblem(s: StopState): string | null {
  const refusal = irreconcilable(s.output);
  if (refusal !== null) {
    return `the resolver says the two sides cannot coexist: ${refusal}`;
  }
  if (s.markerFiles.length > 0) {
    return `conflict markers are still in ${list(s.markerFiles)}`;
  }
  if (s.stray.length > 0) {
    return `the worktree is dirty outside the conflicted files (${list(
      s.stray,
    )}) — a resolver edits the files it was given and nothing else`;
  }
  return null;
}

/**
 * Does this file still contain git's conflict markers?
 *
 * Deliberately not "does any line start with one of the three". `=======` alone
 * is a markdown H1 underline, and this package's own consumers have exactly
 * that in the shared manual-test document these conflicts keep landing in — so
 * a bare `=======` counts only in a file that also carries an opening or
 * closing marker. `<<<<<<<` and `>>>>>>>` are followed by a space and the
 * branch label, which is what separates them from a line of arrows in prose.
 */
export function hasConflictMarkers(text: string): boolean {
  let sawFence = false;
  let sawMiddle = false;
  for (const line of text.split("\n")) {
    if (/^<<<<<<<(?:\s|$)/.test(line) || /^>>>>>>>(?:\s|$)/.test(line)) {
      sawFence = true;
    } else if (/^=======\s*$/.test(line)) {
      sawMiddle = true;
    }
    if (sawFence && sawMiddle) return true;
  }
  return false;
}

/**
 * Files the slice was changing before the resolution and is not changing after
 * it.
 *
 * REPORTED, NEVER GATED, and the distinction is the point. A legitimate
 * resolution can drop a file: if the base branch already made the same change,
 * the right resolution is to take the base's version and the slice's diff to
 * that file correctly disappears. That is common enough that gating on it would
 * park the resolutions that worked. But a resolver that quietly deleted the
 * slice's work produces exactly this list too, and the two are told apart by a
 * human reading one line — so the line gets printed.
 */
export function droppedFiles(before: string[], after: string[]): string[] {
  const kept = new Set(after);
  return [...new Set(before)].filter((f) => !kept.has(f)).sort();
}
