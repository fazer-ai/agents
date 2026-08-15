// Which HTTP responses an operator-authored tool counts as a RESULT rather than an integration
// failure.
//
// Since issue #40 every non-2xx returns `toolFailure(...)`, so the tool line is logged at warn with
// `status: error`, and warn + `source: inbox` passes the alert gate. That is the right default: a
// broken credential, a provider outage or a rejected payload used to be logged as a successful call.
//
// It is the wrong default for the declarative lookups operators actually write. A customer lookup
// that answers 404 for "no record", an order query that answers 404 for a mistyped id: both are
// ordinary data, and both now emit a warn on a perfectly healthy turn. Coalescing by
// (channel, stage, level) dampens a burst, not a steady stream, so on a busy inbox that tool turns
// the operator's alert channel into noise — and noise is how a real outage gets missed (issue #59).
//
// The model-facing contract does NOT change: the tool returns the same `HTTP <status>` text with the
// same body either way, so an agent that already handles "not found" keeps working. Only the log
// level and the alert dispatch move.
//
// Empty list = today's behavior, so this is fail-closed: an existing tool changes nothing until an
// operator declares a status.

// The floor is 200, not 100: `fetch` consumes informational responses itself and exposes only the
// final one, so a 1xx never reaches the status this rule inspects. Storing one would promise alert
// suppression that can never happen — the same dead declaration as the redirect statuses below.
const MIN_STATUS = 200;
const MAX_STATUS = 599;

// The five statuses the Fetch standard calls "redirect statuses". The tool calls `fetch` with
// `redirect: "error"`, so one of these arriving with a `Location` rejects the request before any
// status is inspected: declaring it would be a promise the runtime cannot keep, and one that would
// appear to work whenever the provider happened to omit the header. Refused at the door instead, so
// the stored list means the same thing on all three surfaces that show it back.
//
// The alternative — switching the tool to `redirect: "manual"` — is a change to every tool's network
// policy, made for the sake of a status declaration. `redirect: "error"` is also load-bearing for
// SSRF: `assertSafeOutboundUrl` vets the URL the operator wrote, not wherever a provider points
// next. 3xx codes the standard does NOT call redirects (300, 304 and friends) are delivered
// normally, so they stay declarable — 304 for "nothing changed" is a real "no result".
const FETCH_REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

// A list, not a range and not a "treat 4xx as data" switch. A range is one keystroke away from
// swallowing 401 and 403, which are the two failures an operator most needs to hear about, and it
// hides them for exactly the tools that carry a credential. Enumerating is more typing, once, in
// exchange for a declaration that says what it means.
//
// 5xx is deliberately NOT refused. It is almost always the wrong choice, but refusing it buys a
// special case in the validator to protect an operator from a per-tool, explicit, reversible
// decision — and there are real APIs that answer 503 for "temporarily no data". The rule stays one
// sentence: an integer in the HTTP range.
//
// Normalization is total rather than throwing: this runs over config from three transports (editor,
// REST, MCP), a numeric string is what a JSON body often carries, and a 2xx in the list is a no-op
// the operator meant harmlessly (those are already results). Dropping them keeps stored config
// canonical — sorted and deduped — so a later diff shows a real change.
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
