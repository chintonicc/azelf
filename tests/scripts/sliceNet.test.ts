import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { isNetworkError } from "@/scripts/slice-net";
import { describe, expect, it } from "vitest";
import { AZELF } from "./fixture";

/**
 * One table, asked of the function and of the command `slice-land.sh` runs.
 * The first half are real messages: `gh`'s and `git`'s, as they were logged or
 * as they read. The second half are what must never be retried: at best it
 * changes nothing, and a rate limit is made worse.
 */
const SAMPLES: [string, boolean][] = [
  ["read tcp 192.168.1.2:52533->140.82.121.6:443: i/o timeout", true],
  ["read tcp 10.0.0.1:1->1.1.1.1:443: read: connection reset by peer", true],
  [
    'Post "https://api.github.com/graphql": net/http: TLS handshake timeout',
    true,
  ],
  ['Post "https://api.github.com/graphql": EOF', true],
  ["unexpected EOF", true],
  ["dial tcp: lookup api.github.com: no such host", true],
  [
    "fatal: unable to access 'https://github.com/a/b.git/': Could not resolve host: github.com",
    true,
  ],
  [
    "ssh: Could not resolve hostname github.com: nodename nor servname provided",
    true,
  ],
  ["dial tcp 140.82.121.4:443: connect: network is unreachable", true],
  ["dial tcp 140.82.121.4:443: connect: connection refused", true],
  ["dial tcp 140.82.121.4:443: connect: can't assign requested address", true],
  [
    "fatal: unable to access 'https://github.com/a/b.git/': Failed to connect to github.com port 443: Can't assign requested address",
    true,
  ],
  ["ssh: connect to host github.com port 22: Operation timed out", true],
  ["ssh: connect to host github.com port 22: Connection timed out", true],
  [
    "LibreSSL SSL_connect: SSL_ERROR_SYSCALL in connection to github.com:443",
    true,
  ],
  ["HTTP 502: Bad Gateway (https://api.github.com/graphql)", true],
  ["HTTP 503: Service Unavailable", true],
  ["HTTP 504: Gateway Timeout", true],
  ["fatal: the remote end hung up unexpectedly", true],
  ["error: RPC failed; curl 56 Recv failure", true],

  ["HTTP 404: Not Found (https://api.github.com/repos/a/b/issues/9)", false],
  ["HTTP 401: Bad credentials", false],
  ["HTTP 500: Server Error", false],
  ["API rate limit exceeded for user ID 1", false],
  ["HTTP 403: API rate limit exceeded", false],
  ["GraphQL: Could not resolve to an Issue with the number of 99.", false],
  ["To get started with GitHub CLI, please run:  gh auth login", false],
  [
    "remote: error: GH006: Protected branch update failed for refs/heads/main.",
    false,
  ],
  ["! [rejected]        main -> main (non-fast-forward)", false],
  ["! [remote rejected] HEAD -> x (permission denied)", false],
  ["not today", false],
  ["the rest thereof, and geoffrey", false],
  ["", false],
];

describe("isNetworkError", () => {
  it.each(SAMPLES)("%s → %s", (text, want) => {
    expect(isNetworkError(text)).toBe(want);
  });

  it("the command the shell asks gives the same answers", () => {
    for (const [text, want] of SAMPLES) {
      const r = spawnSync("bun", [join(AZELF, "scripts", "slice-net.ts")], {
        input: text,
        encoding: "utf8",
      });
      expect([text, r.status]).toEqual([text, want ? 0 : 1]);
    }
  }, 60_000);
});
