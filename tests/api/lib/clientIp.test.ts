import { describe, expect, test } from "bun:test";
import { extractForwardedIp, resolveClientIp } from "@/api/lib/clientIp";

const requestWith = (headers: Record<string, string>) =>
  new Request("http://localhost/api/v1/agents", { headers });

describe("extractForwardedIp", () => {
  // A proxy APPENDS the peer it saw, so with one trusted hop the last entry is the only one it
  // wrote. Reading the left would let a client prepend whatever it likes and pick its own bucket.
  test("counts hops from the right, ignoring what the client prepended", () => {
    expect(
      extractForwardedIp(
        requestWith({ "x-forwarded-for": "1.2.3.4, 203.0.113.10" }),
        1,
      ),
    ).toBe("203.0.113.10");
  });

  test("two trusted hops read one entry further in", () => {
    expect(
      extractForwardedIp(
        requestWith({ "x-forwarded-for": "203.0.113.10, 198.51.100.1" }),
        2,
      ),
    ).toBe("203.0.113.10");
  });

  // The cost of every hop counted: the read moves one entry LEFT, and the leftmost entry is the slot
  // a client writes. The two chains below are indistinguishable — same length, same index — but the
  // first was built by a CDN and an origin, and the second by a caller who reached the origin
  // DIRECTLY and sent the first entry themselves. Pinned rather than defended because no property of
  // the request separates them: raising hops is safe only when every proxy counted is unreachable
  // except through the one in front of it, which is the precondition .env.example states.
  test("above one hop, the entry read is the slot a client can write", () => {
    const viaCdn = "203.0.113.10, 198.51.100.1";
    const forgedAtTheOrigin = "9.9.9.9, 203.0.113.99";
    expect(
      extractForwardedIp(requestWith({ "x-forwarded-for": viaCdn }), 2),
    ).toBe("203.0.113.10");
    expect(
      extractForwardedIp(
        requestWith({ "x-forwarded-for": forgedAtTheOrigin }),
        2,
      ),
    ).toBe("9.9.9.9");
    // At the shipped hop count the same forgery buys nothing: the entry read is the one our own
    // proxy appended, and the forged prefix is ignored.
    expect(
      extractForwardedIp(
        requestWith({ "x-forwarded-for": forgedAtTheOrigin }),
        1,
      ),
    ).toBe("203.0.113.99");
  });

  // A chain shorter than the configured hops means the config and the topology disagree. Returning
  // nothing makes the caller fall back to the peer, which over-groups; returning the leftmost entry
  // would hand a client the key instead.
  test("a chain shorter than the configured hops yields nothing", () => {
    expect(
      extractForwardedIp(requestWith({ "x-forwarded-for": "203.0.113.10" }), 2),
    ).toBeUndefined();
    expect(extractForwardedIp(requestWith({}), 1)).toBeUndefined();
  });
});

describe("resolveClientIp", () => {
  const client = "203.0.113.10";
  const forwarded = { "x-forwarded-for": `1.2.3.4, ${client}` };

  test("reads the chain only where the deployment declared a proxy", () => {
    expect(
      resolveClientIp({
        request: requestWith(forwarded),
        peer: "172.17.0.1",
        trustProxy: true,
        hops: 1,
      }),
    ).toBe(client);
  });

  // The case that made trust explicit instead of derived from the peer. docker-compose.prod.yml
  // publishes the app port on every interface, and Docker's userland proxy rewrites a direct caller
  // to the same bridge address a sidecar proxy connects from — so a heuristic that trusted a private
  // peer would let anyone who can reach that port name their own bucket, one per request.
  test("an undeclared deployment ignores the chain, whatever the peer looks like", () => {
    for (const peer of [
      "172.17.0.1",
      "192.168.1.50",
      "127.0.0.1",
      "198.51.100.7",
    ]) {
      expect(
        resolveClientIp({
          request: requestWith(forwarded),
          peer,
          trustProxy: false,
          hops: 1,
        }),
      ).toBe(peer);
    }
  });

  // The headers a client can forge on a proxy that does not manage them. Naming any of these is the
  // bypass this module exists to refuse: a caller rotating one would mint a fresh bucket per request.
  test("never reads an address from a header a proxy does not own", () => {
    const forged = requestWith({
      "cf-connecting-ip": "9.9.9.9",
      "x-real-ip": "9.9.9.8",
      "true-client-ip": "9.9.9.7",
    });
    expect(
      resolveClientIp({
        request: forged,
        peer: "172.17.0.1",
        trustProxy: true,
        hops: 1,
      }),
    ).toBe("172.17.0.1");
  });

  // Degrades to one bucket per proxy rather than to a shared constant everyone lands on.
  test("a trusted proxy that forwards nothing falls back to the peer", () => {
    expect(
      resolveClientIp({
        request: requestWith({}),
        peer: "172.17.0.1",
        trustProxy: true,
        hops: 1,
      }),
    ).toBe("172.17.0.1");
    expect(
      resolveClientIp({
        request: requestWith({}),
        peer: undefined,
        trustProxy: true,
        hops: 1,
      }),
    ).toBe("unknown");
  });
});
