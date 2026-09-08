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
 * A LANDED SLICE IS STILL AN OVERLAP
 * ----------------------------------
 * This originally leaned on `A...B` reporting nothing once B had landed, and
 * called that "landed work drops out of the report without anything having to
 * remember it". That was backwards, and consumer-a's first real wave proved it
 * inside one round: #19 and #20 were reported as both editing one file, #20
 * landed, the line vanished — and the next thing that happened was #19 failing
 * to rebase onto exactly that file. The report went quiet at the moment it
 * became actionable, because a land is what MOVES the base branch and forces
 * the rebase it was warning about.
 *
 * So the caller keeps a landed slice's file set for the rest of the run and
 * keeps passing it in; `open` below is what marks which ids are still live.
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

export type FindOverlapsOptions = {
  /**
   * The ids still open. A group in which nobody is still open is dropped —
   * two slices that have BOTH landed are a fact about history, and the base
   * branch already reconciled them.
   *
   * Omit it and nothing is dropped, which is the right reading when the
   * caller is not tracking landings.
   */
  open?: Set<TicketId>;
  /**
   * Files to leave out of the report entirely — see `ignores()`, which is
   * where the warning about what must NOT go in here lives.
   */
  ignore?: (file: string) => boolean;
};

/**
 * A predicate for `FindOverlapsOptions.ignore`, from a list of path patterns.
 *
 * `*` matches within one path segment, `**` matches across segments, and a
 * pattern ending in `/` matches everything beneath that directory. Patterns
 * are matched against the repo-relative paths `git diff --name-only` prints,
 * so they never start with `./` or a slash.
 *
 * WHAT BELONGS HERE: files where two slices touching one path is genuinely
 * uninformative because their edits cannot interact — a lockfile, generated
 * output, a locale catalogue where each slice adds its own keys.
 *
 * WHAT MUST NOT, and this is the trap: an APPEND-ONLY shared file. A changelog,
 * a manual-test document, anything where every slice adds a numbered entry at
 * the end. Those look like the noisiest possible entry in the report — every
 * slice, every wave, the same path — and they are the one file that collides by
 * construction, because two appends at one anchor conflict every time. In
 * consumer-a's first wave the report named four shared files; three were locale
 * catalogues that merged cleanly and the fourth was the manual-test document,
 * which was the only real conflict of the four. Ignoring by how often a path
 * shows up would have hidden precisely the one worth reading.
 */
export function ignores(patterns: string[]): (file: string) => boolean {
  const res = patterns.map((p) => {
    // Split on the wildcards KEEPING them, so every piece is either a wildcard
    // to translate or literal text to escape. Sequential string replaces would
    // be the shorter spelling and the wrong one: `**` has to be consumed before
    // `*`, and any placeholder standing in for it between the two passes can
    // also occur in a real path.
    const body = p
      .split(/(\*\*|\*)/)
      .map((part) => {
        if (part === "**") return ".*";
        if (part === "*") return "[^/]*";
        return part.replace(/[.+^${}()|[\]\\?]/g, "\\$&");
      })
      .join("");
    // A trailing slash means the directory's contents, not the directory.
    return new RegExp(`^${p.endsWith("/") ? `${body}.*` : body}$`);
  });
  return (file: string) => res.some((re) => re.test(file));
}

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
export function findOverlaps(
  changed: Map<TicketId, string[]>,
  opts: FindOverlapsOptions = {},
): Overlap[] {
  const holders = new Map<string, TicketId[]>();
  for (const [id, files] of changed) {
    // Deduped per ticket: one slice listing a file twice is not an overlap
    // with itself, and `git diff --name-only` can repeat a path across a
    // rename pair.
    for (const file of new Set(files)) {
      if (opts.ignore?.(file)) continue;
      const list = holders.get(file);
      if (list) list.push(id);
      else holders.set(file, [id]);
    }
  }

  const groups = new Map<string, Overlap>();
  for (const [file, ids] of holders) {
    if (ids.length < 2) continue;
    const tickets = [...ids].sort(compareIds);
    // Nobody left to steer: both sides are already on the base branch, which
    // reconciled them when the second one rebased.
    if (opts.open && !tickets.some((id) => opts.open?.has(id))) continue;
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
