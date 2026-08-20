// Resolving the address a request "came from" is a trust decision, not a lookup: every candidate
// header is attacker-controlled unless a proxy we trust overwrote it. Getting it wrong in either
// direction breaks the rate limiters that key on the result — trust a header nobody sanitizes and a
// client picks its own bucket (unlimited attempts, or poisoning someone else's); ignore one a real
// proxy set and EVERY client collapses into a single bucket, which is what this deployment does
// today, since the plugin's default generator reads the TCP peer and every compose file here puts a
// reverse proxy in front. Being wrong toward the shared bucket is a worse limit; being wrong toward
// the header is no limit at all, so the trust is declared rather than guessed.

// NOTE: Only ONE thing in a request is reliably written by our own proxy: the entry a proxy APPENDS
// to X-Forwarded-For. Everything else is a guess at a name — `cf-connecting-ip`, `x-real-ip` and
// friends are set by SOME proxies, and a proxy that does not manage a header forwards it verbatim,
// so on a generic Traefik/Caddy/nginx deployment a client can send `CF-Connecting-IP: <anything>`
// and, if we prefer it, name its own rate-limit bucket.
//
// So this counts hops instead of trusting names. `hops` is how many proxies sit between the client
// and us: with the usual single proxy the LAST entry is the one it wrote (a client that sends
// `X-Forwarded-For: 1.2.3.4` only turns the list into `1.2.3.4, <real client>`, and can prepend but
// never append). With Cloudflare in front of that proxy the last entry is Cloudflare, so hops is 2.
// A chain shorter than `hops` means the configuration and the topology disagree; that returns
// nothing and the caller falls back to the peer, which over-groups rather than handing a client the
// key.
//
// NOTE: each hop counted moves the read one entry LEFT, and the leftmost entry is the one a client
// can write. At hops 1 that never matters — the entry read is the one our own proxy appended. Above
// 1 it does: a caller who can reach the SECOND proxy directly, skipping the first, sends an
// X-Forwarded-For of their choosing and the proxy that answers appends their peer, producing a chain
// exactly as long as the legitimate path. Nothing in the request tells the two apart, so raising
// `hops` is only safe when every proxy counted is itself unreachable except through the one in front
// of it — the precondition .env.example states for the app port, applied to the whole chain.
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
