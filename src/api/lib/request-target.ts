// What a log line may say about the URL a request named. A URL can carry the route's credential: the
// Chatwoot and inbound webhook receivers are authenticated by the route token in their path,
// and a query string can hold an invite token or an OAuth code. So a path parameter is printed only
// when its NAME is on the list below, an unknown name is masked, and every query value is masked.
// tests/api/request-log-redaction.test.ts sweeps the registered routes for a name missing here.
const PRINTED_PARAMS = new Set([
  "id",
  "agentId",
  "app",
  "clientId",
  "jti",
  "kid",
  "kind",
  "mediaId",
  "passkeyId",
  "threadId",
  "variant",
]);

export const REDACTED = "[redacted]";

// `route` is the matched template (`/api/v1/chatwoot/webhook/:routeToken`), null when nothing
// matched; then no segment is known to be a parameter and the path is printed as sent.
export function loggedPath(pathname: string, route: string | null): string {
  if (!route) return pathname;
  const template = route.split("/");
  return pathname
    .split("/")
    .map((segment, i) => {
      const name = template[i]?.match(/^:([^?]+)\??$/)?.[1];
      return name === undefined || PRINTED_PARAMS.has(name)
        ? segment
        : REDACTED;
    })
    .join("/");
}

// A request can reach the log middleware without a target `new URL` accepts: HTTP/1.1 with an empty
// `Host` header, a malformed absolute-form target a proxy rewrote, or a bare path on a connection
// with no authority. The throw used to escape `onAfterResponse`, and an uncaught throw there ends
// the process instead of the request, so one such request restarted every replica. The target is not
// echoed when it cannot be parsed — a credential can sit in any position — but the matched route is
// a template, so naming it keeps the line worth reading.
export const UNPARSABLE_URL = "[unparsable-url]";

export function loggedUrl(url: string, route: string | null): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return route ? `${UNPARSABLE_URL} ${route}` : UNPARSABLE_URL;
  }
  const keys = [...parsed.searchParams.keys()];
  const query = keys.length
    ? `?${keys.map((k) => `${encodeURIComponent(k)}=${REDACTED}`).join("&")}`
    : "";
  return `${parsed.origin}${loggedPath(parsed.pathname, route)}${query}`;
}
