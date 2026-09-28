// Resolving the address a request "came from" is a trust decision, not a lookup: every candidate
// header is attacker-controlled unless a proxy we trust overwrote it. Getting it wrong in either
// direction breaks the rate limiters that key on the result — trust a header nobody sanitizes and a
// client picks its own bucket (unlimited attempts, or poisoning someone else's); ignore one a real
// proxy set and EVERY client collapses into a single bucket, which is what this deployment does
// today, since the plugin's default generator reads the TCP peer and every compose file here puts a
// reverse proxy in front. Being wrong toward the shared bucket is a worse limit; being wrong toward
// the header is no limit at all, so the trust is declared rather than guessed.

// Reads the client address from X-Forwarded-For by counting hops, never by trusting header names:
// the entry a proxy APPENDS is the only one our own proxy reliably writes, while `cf-connecting-ip`,
// `x-real-ip` and friends pass verbatim through a proxy that does not manage them, so a client could
// name its own bucket. `hops` is how many proxies sit in front: at 1 the LAST entry is our proxy's (a
// client can prepend, never append); behind Cloudflare it is 2. A chain shorter than `hops` returns
// nothing and the caller falls back to the peer, which over-groups rather than handing a client the
// key. Above 1, every proxy counted must be unreachable except through the one in front of it, or a
// caller skipping one forges a chain of the right length (.env.example, TRUSTED_PROXY_HOPS).
export function extractForwardedIp(
  request: Request,
  hops: number,
): string | undefined {
  const chain = request.headers
    .get("x-forwarded-for")
    ?.split(",")
    .map((hop) => hop.trim())
    .filter(Boolean);
  if (!chain?.length) return undefined;
  const index = chain.length - hops;
  return index >= 0 ? chain[index] : undefined;
}

// `trustProxy` mirrors config.trustProxy, which is explicit on purpose. Deriving it from the peer
// ("is it a private address?") reads as the convenient default and does not hold here:
// docker-compose.prod.yml publishes the app port on every interface unless the operator narrows it,
// so a caller on the same network reaches this process directly — and under Docker's userland proxy
// their connection is SNATed to the bridge gateway, which is indistinguishable from the address a
// real sidecar proxy connects from. In that topology no heuristic can tell the two apart, and
// guessing wrong hands every limiter's key to the caller. So trust is declared by whoever knows the
// deployment, and the compose files that guarantee a proxy declare it themselves.
export function resolveClientIp({
  request,
  peer,
  trustProxy,
  hops,
}: {
  request: Request;
  peer: string | undefined;
  trustProxy: boolean;
  hops: number;
}): string {
  if (trustProxy) {
    const forwarded = extractForwardedIp(request, hops);
    if (forwarded) return forwarded;
  }
  // NOTE: Falls back to the peer rather than to a constant, so a trusted proxy that forgets to
  // forward anything degrades to one bucket per proxy instead of one bucket named "unknown".
  return peer ?? "unknown";
}
