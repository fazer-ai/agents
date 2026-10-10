// What a log line may say about the URL a request named. A URL can carry the route's credential: the
// Chatwoot and inbound webhook receivers are authenticated by the route token in their path,
// and a query string can hold an invite token or an OAuth code. So a path parameter is printed only
// when its NAME is on the list below, an unknown name is masked, and every query value is masked.
// tests/api/request-log-redaction.test.ts sweeps the registered routes for a name missing here.
const PRINTED_PARAMS = new Set([
  "id",
  "agentId",
  "clientId",
  "jti",
  "kind",
  "mediaId",
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

export function loggedUrl(url: string, route: string | null): string {
  const parsed = new URL(url);
  const keys = [...parsed.searchParams.keys()];
  const query = keys.length
    ? `?${keys.map((k) => `${encodeURIComponent(k)}=${REDACTED}`).join("&")}`
    : "";
  return `${parsed.origin}${loggedPath(parsed.pathname, route)}${query}`;
}
