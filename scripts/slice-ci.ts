/**
 * Reading GitHub Actions through `gh`: which runs a commit has, which of them
 * decide, and whether a run that failed ever started.
 *
 * `ciRuns` in slice-gates.ts asks all of it before a land. Everything here
 * only reads: `gh run list`, `gh run view`, and a GET through `gh api`. A run
 * that never started is not a red run, and that is the reason this module
 * exists. On consumer-b's Backend #246 the account's Actions minutes had run
 * out. Every job ended after two seconds without a single step, `ciRuns` read
 * `conclusion: failure` as a red CI, and two slices that were green locally
 * parked as "the gates are red". GitHub's reason was only in the job's
 * annotation, and nobody had read it. `afterLandCi` in slice-run.ts asks the
 * same questions of the base's run after a land.
 *
 * What GitHub returned there, for the record:
 *  - `gh run view <id> --json jobs`: one job, `conclusion: failure`,
 *    `steps: []`, two seconds long. A red run of the same repo has its steps.
 *  - The reason is in neither the run nor the check run's `output`. It is in
 *    `GET repos/<repo>/check-runs/<job id>/annotations` only: one annotation,
 *    level `failure`, path `.github`, "The job was not started because recent
 *    account payments have failed or your spending limit needs to be
 *    increased. …"
 */

import type { Exec } from "./slice-gates";

/** One workflow run, as `gh run list --json` gives it. */
export type CiRun = {
  databaseId: number;
  name: string;
  status: string;
  conclusion: string;
  url: string;
};

/**
 * `owner/repo` for a remote URL on github.com, `host/owner/repo` for any other
 * host (GitHub Enterprise), as `gh -R` takes it. null for a URL with no host,
 * like a local path: there is no GitHub to ask.
 */
export function ghRepoOf(url: string): string | null {
  const bare = url
    .trim()
    .replace(/\/+$/, "")
    .replace(/\.git$/, "");
  // Two forms: a URL with a scheme, and scp's `user@host:path`. Kept apart,
  // because read as the second, `file:///srv/app` is host `file`.
  const m =
    bare.match(
      /^[a-z][a-z0-9+.-]*:\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/(.+)$/i,
    ) ?? bare.match(/^(?:[^@/]+@)?([^/:]+):(?!\/\/)(.+)$/);
  if (!m) return null;
  const [, host, path] = m as unknown as [string, string, string];
  const parts = path.split("/").filter(Boolean);
  if (parts.length < 2) return null;
  const repo = parts.slice(-2).join("/");
  return host.toLowerCase() === "github.com" ? repo : `${host}/${repo}`;
}

/** The last few lines of a command's output, for a failure's detail. */
const tail = (out: string, n = 10): string[] =>
  out
    .split("\n")
    .filter((l) => l.trim())
    .slice(-n);

/**
 * gh's JSON answer, from output that carries stderr too. gh prints its JSON as
 * one line of its own when it is not on a terminal. null when there is none,
 * or it does not parse.
 */
function jsonLine(out: string, opener: "[" | "{"): unknown {
  const line = out.split("\n").find((l) => l.trim().startsWith(opener));
  if (line === undefined) return null;
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

/** The argv for `gh api GET <path>` against the repo's host. */
function ghApi(repo: string, path: string): string[] {
  const parts = repo.split("/");
  // `host/owner/repo`: GitHub Enterprise, which `gh api` reaches through
  // --hostname, not through the path.
  if (parts.length === 3) {
    const [host, owner, name] = parts as [string, string, string];
    return ["gh", "api", "--hostname", host, `repos/${owner}/${name}/${path}`];
  }
  return ["gh", "api", `repos/${repo}/${path}`];
}

/**
 * The argv for listing the runs on `sha`; also what a failure tells a person
 * to run. With `branch`, only the runs of pushes to that branch: the same SHA
 * has runs from `ciRuns`' own branch too, and after a land only the base's
 * own run is the verdict on it.
 */
export function listRunsArgv(
  repo: string,
  sha: string,
  branch?: string,
): string[] {
  return [
    "gh",
    "run",
    "list",
    "-R",
    repo,
    "--commit",
    sha,
    ...(branch ? ["--branch", branch] : []),
  ];
}

/** The runs GitHub has on `sha`, newest 30, or the tail of what gh said instead. */
export function listRuns(
  exec: Exec,
  cwd: string,
  repo: string,
  sha: string,
  branch?: string,
): { runs: CiRun[] } | { error: string[] } {
  const r = exec(
    [
      ...listRunsArgv(repo, sha, branch),
      "--limit",
      "30",
      "--json",
      "databaseId,name,status,conclusion,url",
    ],
    cwd,
  );
  const runs = r.ok ? jsonLine(r.out, "[") : null;
  return Array.isArray(runs)
    ? { runs: runs as CiRun[] }
    : { error: tail(r.out) };
}

/**
 * Each named workflow's newest run among those with an id above `after`, or
 * undefined for a workflow that has none. Run ids grow, so the newest is the
 * highest, and `after` drops the runs an earlier attempt left on the same SHA.
 */
export function newestPerWorkflow(
  runs: CiRun[],
  workflows: string[],
  after: number,
): Map<string, CiRun | undefined> {
  const counted = runs
    .filter((r) => r.databaseId > after)
    .sort((a, b) => b.databaseId - a.databaseId);
  return new Map(
    workflows.map((w) => [w, counted.find((r) => r.name === w)] as const),
  );
}

/**
 * Why a completed run that is not a success never started, in GitHub's words,
 * or null when it did start, which makes it a red run.
 *
 * A run did not start when GitHub could not start it (`startup_failure`), or
 * when none of its jobs ran a single step. A job skipped by its `if:` has no
 * steps either, but a run whose only jobs were skipped is a success and is
 * never asked. The reason is the first `failure` annotation of the first job,
 * which is where GitHub puts a billing block.
 *
 * null too when the jobs cannot be read: a run nobody can tell about is red,
 * as it was before this existed, and costs only the base retry. A failing
 * annotation call does not change the verdict, only its words.
 */
export function whyNotStarted(
  exec: Exec,
  cwd: string,
  repo: string,
  run: CiRun,
): string | null {
  if (run.conclusion === "startup_failure") {
    return "GitHub could not start the workflow (startup_failure) — a workflow file error, or the account";
  }
  const view = exec(
    ["gh", "run", "view", String(run.databaseId), "-R", repo, "--json", "jobs"],
    cwd,
  );
  const answer = view.ok ? jsonLine(view.out, "{") : null;
  const jobs = (answer as { jobs?: unknown } | null)?.jobs;
  if (!Array.isArray(jobs)) return null;
  type Job = { databaseId?: number; steps?: unknown[] };
  if ((jobs as Job[]).some((j) => (j.steps ?? []).length > 0)) return null;

  const first = (jobs as Job[])[0];
  if (first?.databaseId !== undefined) {
    const a = exec(
      ghApi(repo, `check-runs/${first.databaseId}/annotations`),
      cwd,
    );
    const notes = a.ok ? jsonLine(a.out, "[") : null;
    if (Array.isArray(notes)) {
      const said = (
        notes as { annotation_level?: string; message?: string }[]
      ).find((n) => n.annotation_level === "failure" && n.message?.trim());
      if (said?.message) return said.message.trim();
    }
  }
  return run.conclusion === "cancelled"
    ? "it was cancelled before a job started"
    : "no job ran a single step";
}
