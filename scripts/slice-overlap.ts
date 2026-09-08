/**
 * Which live slices are editing the same files.
 *
 * WHAT THIS CATCHES, AND WHAT ALREADY CATCHES THE REST
 * ---------------------------------------------------
 * Landing rebases the slice onto the base branch, and a rebase already refuses
 * the hard case: two slices whose edits to one file textually clash. That
 * failure is loud, it happens at land time, and `tryLand` parks the slice and
 * says so.
 *
 * The case nothing catches is the soft one — two agents editing the same
 * component in ways that BOTH APPLY CLEANLY and still disagree. A rebase is
 * happy; the file is now half one design and half another, and the only signal
 * is a review of the second slice by someone who remembers the first. That is
 * what this reports, and it reports it while both slices are still open and
 * cheap to steer.
 *
 * WHY IT IS NOT A PLAN-TIME CHECK
 * -------------------------------
 * Because it cannot be. Nothing knows which files a ticket will touch before
 * its agent writes the code — the ticket names an outcome, not a file list,
 * and guessing from prose is the agent-inference road this tool already
 * declined to take. Once a slice has COMMITS the question stops being a guess
 * and becomes a `git diff --name-only`, which is why this lives in the poll
 * loop and not in the plan.
 *
 * The corollary is a real limitation, stated here rather than discovered: work
 * an agent has not committed yet is invisible. A slice that has been running
 * for twenty minutes without a commit contributes nothing to this, and silence
 * from here therefore means "no overlap in what has been committed", never "no
 * overlap". It warns; it never gates a land.
 *
 * This file is the pure half — set algebra over ticket ids, no git, no I/O —
 * so it can be tested without a repository. Reading the branches and printing
 * the result is slice-run.ts's, next to the other printers.
 */

import { type TicketId, compareIds } from "./slice-tracker";

/**
 * One set of slices and every file all of them changed.
 *
 * Grouped by the SLICES rather than by the file on purpose: the thing a human
 * acts on is "these two are colliding", and a file-per-line report buries that
 * under however many files the collision spans.
 */
export type Overlap = { tickets: TicketId[]; files: string[] };

/**
 * Every file more than one slice has changed, grouped by which slices those
 * are. `changed` maps a ticket id to its changed-file list; ids with no
 * commits belong out of it, or as an empty list — both read the same.
 *
 * Fully ordered — tickets by `compareIds`, files alphabetically, groups by
 * their ticket list — because the caller compares consecutive results to
 * decide whether anything has actually changed since it last printed. Map
 * iteration is insertion order, so without this the same overlap re-read in a
 * different order would look like news.
 */
export function findOverlaps(changed: Map<TicketId, string[]>): Overlap[] {
  const holders = new Map<string, TicketId[]>();
  for (const [id, files] of changed) {
    // Deduped per ticket: one slice listing a file twice is not an overlap
    // with itself, and `git diff --name-only` can repeat a path across a
    // rename pair.
    for (const file of new Set(files)) {
      const list = holders.get(file);
      if (list) list.push(id);
      else holders.set(file, [id]);
    }
  }

  const groups = new Map<string, Overlap>();
  for (const [file, ids] of holders) {
    if (ids.length < 2) continue;
    const tickets = [...ids].sort(compareIds);
    const key = tickets.join(" ");
    const group = groups.get(key);
    if (group) group.files.push(file);
    else groups.set(key, { tickets, files: [file] });
  }

  return [...groups.values()]
    .map((g) => ({ tickets: g.tickets, files: g.files.sort() }))
    .sort((a, b) => {
      const n = Math.min(a.tickets.length, b.tickets.length);
      for (let i = 0; i < n; i += 1) {
        const c = compareIds(
          a.tickets[i] as TicketId,
          b.tickets[i] as TicketId,
        );
        if (c !== 0) return c;
      }
      return a.tickets.length - b.tickets.length;
    });
}
