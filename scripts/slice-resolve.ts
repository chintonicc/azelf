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

/** What the worktree looks like after the resolver has had its turn. */
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
