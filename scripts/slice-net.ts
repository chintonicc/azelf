/**
 * Is this failure the network, and so worth trying again?
 *
 * On consumer-b one `gh` call ended a start with a stack trace (`i/o timeout`,
 * then `connection reset by peer`), and a minute later five of five passed. A
 * push that could not connect was reported as origin refusing it, undone and
 * parked. Both are the same class, and every place that talks to a remote asks
 * here: the GitHub adapter, `ciRuns`, and `slice-land.sh` through the command
 * at the bottom, so there is one list and it cannot drift.
 *
 * Read from the error text, because that is all `gh` and `git` give. A sign-in
 * problem, a 404 and a rate limit are not on it: trying them again at once
 * changes nothing, and a rate limit is made worse.
 */

import { readFileSync } from "node:fs";

const NETWORK_ERRORS: RegExp[] = [
  /i\/o timeout/i,
  /connection reset/i,
  /connection refused/i,
  /connection timed out/i,
  /operation timed out/i,
  /TLS handshake/i,
  /SSL_ERROR_SYSCALL/i,
  /\bEOF\b/i,
  /no such host/i,
  /could not resolve host/i,
  /failed to connect to/i,
  /network is unreachable/i,
  /can't assign requested address/i,
  /HTTP 50[234]/i,
  /the remote end hung up/i,
  /RPC failed/i,
];

export function isNetworkError(text: string): boolean {
  return NETWORK_ERRORS.some((re) => re.test(text));
}

/**
 * Seconds between tries, for `gh` and for the CI gate. Three retries over half a
 * minute: long enough for a blip, short enough not to be mistaken for a hang.
 */
export const NET_RETRY_SECONDS = [2, 8, 20];

// `slice-net.ts` with the text on stdin exits 0 for a network failure and 1 for
// anything else: the shell's way to ask, and only ever asked after a failure, so
// it costs nothing on the ordinary path.
if (import.meta.main) {
  process.exit(isNetworkError(readFileSync(0, "utf8")) ? 0 : 1);
}
