// Fixture host for every URL that flows through `assertSafeOutboundUrl`. That guard resolves
// hostnames through `node:dns`, so a real hostname turns a DATABASE test into one that also needs
// working DNS, failing intermittently offline or on a runner without egress. An IP literal takes the
// `isIP()` branch instead: the blocked-range check still runs in full, minus the network call.
// 203.0.113.0/24 is TEST-NET-3 (RFC 5737), reserved for documentation and never routed, so it is
// unambiguously a fixture and in none of the guard's blocked ranges.
const TEST_NET_3 = "203.0.113";

export function outboundUrl(path = "/", host = 10): string {
  return `https://${TEST_NET_3}.${host}${path.startsWith("/") ? path : `/${path}`}`;
}
