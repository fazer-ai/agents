import { afterEach, mock } from "bun:test";
import * as dns from "node:dns/promises";

// No test reaches the real resolver. `assertSafeOutboundUrl` resolves a URL's host before any
// request leaves, so a fixture hostname turns a test that stubs `fetch` into one that also waits on
// DNS: locally a few milliseconds, on a CI runner once more than five seconds. Any name this file
// does not answer fails the test that asked: a fixture that has to be reachable is `outboundUrl()`
// from tests/utils/outbound.ts, and a test about resolution passes its own `lookup` to the guard.
const realLookup = dns.lookup;
// A reserved TLD (RFC 2606/6761) never exists, and tests use it on purpose as the unreachable
// server: it answers not-found at once, the same error the resolver gives.
const RESERVED = /\.(example|invalid|test)$/i;
// A host the product itself fixes cannot be moved by a test, so it answers a fixed public address.
const PRODUCT_HOSTS: Record<string, string> = {
  "www.googleapis.com": "142.250.0.10",
};
// The refusal alone is not enough: a turn or a delivery catches it the way it catches a not-found
// answer, and the test passes. So each refused lookup is recorded, and the test that made it fails.
const refused: string[] = [];

async function lookup(host: string, opts?: { all?: boolean }) {
  // The hosts file answers `localhost`, with no network.
  if (host === "localhost") return realLookup(host, opts as never);
  const fixed = PRODUCT_HOSTS[host];
  if (fixed) {
    const answer = { address: fixed, family: 4 };
    return opts?.all ? [answer] : answer;
  }
  if (RESERVED.test(host))
    throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), {
      code: "ENOTFOUND",
      hostname: host,
    });
  refused.push(host);
  throw new Error(`tests: real DNS lookup for "${host}"`);
}

mock.module("node:dns/promises", () => ({
  ...dns,
  lookup,
  default: { ...dns, lookup },
}));

/** Fails the test that asked the real resolver, and starts the next one clean. */
export function failOnRefusedLookups(): void {
  if (refused.length === 0) return;
  const hosts = [...new Set(refused.splice(0))].join(", ");
  throw new Error(
    `tests: this test asked the real resolver for ${hosts}. Use a reserved name (.example, .invalid, .test) for a server that must not exist, outboundUrl() from tests/utils/outbound.ts for one that must be reached, or pass a lookup to assertSafeOutboundUrl.`,
  );
}

afterEach(failOnRefusedLookups);
