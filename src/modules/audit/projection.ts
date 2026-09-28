import { clipText, makeStorable } from "@/lib/text";
import { readableVaultRef } from "@/modules/vault/service";

// The before/after projection of an audit row, bounded so it can be stored.
//
// It lives beside the audit write rather than in a transport because both sides of the trail need
// it: the MCP tools that still build their own projection, and the services that now record their
// own.

const AUDIT_STR_MAX = 4000;

// Bound string sizes in the audit projection (a system prompt can be tens of KB). `before`/`after`
// are jsonb, so an unpaired surrogate or NUL makes Postgres refuse the write after the change already
// committed, losing only the record of who made it: hence `clipText` (the cut cannot make an orphan)
// and `makeStorable` (for one that arrived with an MCP argument). Keys are not repaired, unlike
// `redactSecretsDeep`: every key here is a field name we wrote, a schema argument name, or read back
// from jsonb, which cannot hold an orphan.
export function truncForAudit(v: unknown): unknown {
  if (typeof v === "string") {
    return makeStorable(
      v.length > AUDIT_STR_MAX
        ? `${clipText(v, AUDIT_STR_MAX)}…[truncated]`
        : v,
    );
  }
  if (Array.isArray(v)) return v.map(truncForAudit);
  if (v && typeof v === "object") {
    const o: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v)) {
      // NOTE: `defineProperty`, not assignment. `JSON.parse` yields `__proto__` as an ordinary own
      // property, and assigning to that key invokes the legacy prototype setter instead; Prisma's
      // serialization enumerates inherited properties, so its contents would be written as
      // top-level fields of the audit row. Unlike the repair above, this one is not about what the
      // column refuses: the write succeeds, carrying a field nobody wrote.
      Object.defineProperty(o, k, {
        value: truncForAudit(val),
        writable: true,
        enumerable: true,
        configurable: true,
      });
    }
    return o;
  }
  return v;
}

// The only part of a URL an audit row keeps: its origin. The trail is append-only and outlives the
// record, and the path is where webhook destinations actually put the token (Discord and Slack are
// `…/api/webhooks/<id>/<token>`), so userinfo, query, fragment and path all go, for every caller:
// whether the source column is encrypted says nothing about whether the value is a secret. The row's
// `target` already names the subscription or channel exactly.
export function redactEndpoint(url: string): string {
  try {
    // `u.host` is the host and the port, and it EXCLUDES userinfo — reading it off `URL` is what
    // does the removing.
    const u = new URL(url);
    return `${u.protocol}//${u.host}/…`;
  } catch {
    // Not parseable as a URL, so no part of it can be shown to be safe.
    return "…";
  }
}

// What a stored credential reference contributes to a projection: the ref where it names an entry,
// and a marker where it does not. `readableVaultRef` reads anything but a reference as null, so
// without the marker clearing an unreadable value looks identical on both sides, `projectionMoved`
// sees nothing, and the save that removed a credential writes no row.
export function refForAudit(stored: string | null): {
  ref: string | null;
  opaque: boolean;
} {
  const ref = readableVaultRef(stored);
  return { ref, opaque: stored !== null && ref === null };
}

// The other half of the rule: every mutable column is either projected in a form safe to keep
// forever or listed as undisclosed, never neither (else the edit moves no projection and writes no
// row). An undisclosed column is compared here in memory and the row keeps only a boolean: anything
// derived from it (even an unsalted digest) would be an offline verifier on an append-only table that
// every tenant admin reads. BigInt is stringified because `JSON.stringify` throws on it, and a throw
// here would take the audit row down with its mutation.
function stableJson(v: unknown): string {
  // A column the service did not READ is `undefined` on both sides, which would compare equal on
  // every save and leave that column silently uncovered. `JSON.stringify` renders it as `undefined`
  // (the value, not a string), so the sentinel is what keeps it distinguishable from a stored
  // `null` — and `tests/modules/audit-config-families.test.ts` fails while a name in an
  // `UNDISCLOSED` list is not a key of that module's `select`, so it should never arise.
  if (v === undefined) return "\u0000undefined";
  return JSON.stringify(v, (_k, val) =>
    typeof val === "bigint" ? String(val) : val,
  );
}

export function undisclosedMoved(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  columns: readonly string[],
): boolean {
  return columns.some((c) => stableJson(before[c]) !== stableJson(after[c]));
}

// Put on BOTH sides, like the settings bag's marker: it says a write moved something the row does not
// show. The audit write is gated on `undisclosedMoved` directly, never on this marker moving
// `projectionMoved`: two identical markers move nothing.
export function markUndisclosed<T extends object>(
  projection: T,
): T & { undisclosedChanged: true } {
  return { ...projection, undisclosedChanged: true };
}
