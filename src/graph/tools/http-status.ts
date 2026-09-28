// Which HTTP responses an operator-authored tool counts as a RESULT rather than an integration
// failure. Every non-2xx is a `toolFailure` by default (warn, which passes the alert gate), right for
// a broken credential or outage but wrong for lookups where 404 means "no record": a steady stream
// of those turns the alert channel into noise, which coalescing does not damp, and hides a real
// outage. The model-facing text is identical either way; only log level and alert dispatch move. An
// empty list keeps the default, so an existing tool changes nothing until a status is declared.

// The floor is 200, not 100: `fetch` consumes informational responses itself and exposes only the
// final one, so a 1xx never reaches the status this rule inspects. Storing one would promise alert
// suppression that can never happen — the same dead declaration as the redirect statuses below.
const MIN_STATUS = 200;
const MAX_STATUS = 599;

// The five Fetch "redirect statuses". The tool calls `fetch` with `redirect: "error"`, so one of these
// with a `Location` rejects before any status is inspected: declaring it is a promise the runtime
// cannot keep, so it is refused. Switching to `redirect: "manual"` would change every tool's network
// policy and break SSRF vetting (`assertSafeOutboundUrl` checks only the URL the operator wrote).
// Other 3xx (300, 304) are delivered normally and stay declarable.
const FETCH_REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

// A list, not a range or a "treat 4xx as data" switch: a range easily swallows 401 and 403, the
// failures an operator most needs to hear about. 5xx is NOT refused: rarely right, but a per-tool,
// explicit, reversible choice, and some APIs answer 503 for "no data". Normalization is total rather
// than throwing (config arrives from editor, REST and MCP, often as numeric strings); 2xx entries are
// dropped as no-ops, and the result is sorted and deduped so a later diff shows a real change.
export function normalizeExpectedStatuses(raw: unknown): number[] {
  if (!Array.isArray(raw)) return [];
  const out = new Set<number>();
  for (const entry of raw) {
    const n =
      typeof entry === "number"
        ? entry
        : typeof entry === "string" && entry.trim()
          ? Number(entry)
          : Number.NaN;
    if (!Number.isInteger(n)) continue;
    if (n < MIN_STATUS || n > MAX_STATUS) continue;
    if (n >= 200 && n < 300) continue;
    if (FETCH_REDIRECT_STATUSES.has(n)) continue;
    out.add(n);
  }
  return [...out].sort((a, b) => a - b);
}

export function isExpectedResult(
  status: number,
  expected: readonly number[],
): boolean {
  if (status >= 200 && status < 300) return true;
  return expected.includes(status);
}
