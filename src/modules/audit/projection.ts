import { clipText, makeStorable } from "@/lib/text";
import { readableVaultRef } from "@/modules/vault/service";

// The before/after projection of an audit row, bounded so it can be stored.
//
// It lives beside the audit write rather than in a transport because both sides of the trail need
// it: the MCP tools that still build their own projection, and the services that now record their
// own.

const AUDIT_STR_MAX = 4000;

// Bound string sizes in the audit projection (a system prompt can be tens of KB).
//
// The same walker `redactSecretsDeep` is, aimed at the same kind of destination: `audit_logs.before`
// and `.after` are `jsonb`, so an unpaired surrogate anywhere in the projection makes Postgres refuse
// the whole write. Here the cost is worse than a lost log line — the change has already committed by
// the time this row is written, so it lands, the tool reports a failure, and the record of who made
// it is the only thing missing. Hence both repairs: `clipText` so the cut cannot manufacture an
// orphan, and `makeStorable` for one that arrived with the value (or for a NUL, which the same
// column refuses just as flatly): a projection carries some
// arguments as the MCP client sent them (`args.name`, `args.title`, `args.content`), and that JSON
// can spell one out.
//
// NOTE: KEYS are not repaired here, and that asymmetry with redactSecretsDeep is deliberate rather
// than an omission. Every key in a projection is a field name we wrote or an argument name taken
// from the tool's own schema; the one bag whose keys are open-ended (`agent.settings`) is read back
// out of a jsonb column, which is the very thing that cannot hold an orphan. The keys the other
// walker repairs come from a model's tool-call arguments and from third parties' response bodies.
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

// The only part of a URL an audit row keeps: its origin.
//
// A row OUTLIVES the record it describes. The live read surfaces return these URLs whole to the same
// tenant admins, but those are deletable and the trail is append-only, so a token pasted into one
// once outlasts every correction.
//
// EVERY other part goes, and the path goes with them. Userinfo, query and fragment are the three
// places a credential hides in the abstract; the path is where it actually turns up, because the
// destinations operators point these at put it there — a Discord incoming webhook is
// `…/api/webhooks/<id>/<token>`, and Slack's is the same shape. This codebase is its own evidence:
// an alert channel's URL is stored ENCRYPTED at rest for exactly that reason, and an outbound
// subscription accepts the same arbitrary HTTPS destination with its column in the clear.
//
// So there is one answer rather than one per caller. Keeping the path for the family whose column
// happens to be readable would be reasoning from where the value is stored to whether it is a
// secret, and the two are unrelated. Identity is not lost by this: the row's `target` names the
// subscription or the channel exactly, and what the origin adds is which host it was pointed at.
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

// One entry of a host allowlist, shown only where it IS one.
//
// The column is `z.string().min(1).max(255)` per entry and nothing more, so what lands in it is
// whatever an operator typed — and the field it sits next to in the editor is the URL, which is
// where a token actually lives. Redacting it costs nothing operationally: the gate that consumes
// the list compares `allowedHosts.includes(url.hostname)` (`src/graph/tools/http.ts`), and
// `url.hostname` never carries a scheme, a port, userinfo, a path or a query. So an entry that is
// not a bare host can never match anything, is always a mistake rather than a configuration, and
// is exactly the shape that carries a secret into a row that outlives the tool.
//
// The test for "bare host" is the gate's own: an entry survives when it is what `URL` would call
// the hostname of itself. That admits `example.com`, `1.2.3.4` and `[::1]`, and refuses
// `example.com/hook/tok`, `user:pass@host`, `host:8080` and `https://host` — the last two being
// dead weight to the gate for the same reason.
export function hostForAudit(entry: string): string {
  try {
    return new URL(`https://${entry}`).hostname === entry ? entry : "…";
  } catch {
    return "…";
  }
}

// What a stored credential reference contributes to a projection: the ref where it names an entry,
// and a marker where it does not.
//
// `readableVaultRef` shows the stored value only where it IS a reference (#438), so a column holding
// anything else reads as null. The marker is what keeps the trail honest once that redaction exists:
// without it, clearing an unreadable value looks identical on both sides of the change,
// `projectionMoved` sees nothing, and the one save that removed a credential writes no row at all.
// Same shape as `secretRefOpaque` on the outbound subscription (#397), which is why it lives here
// rather than being spelled out at each of the three columns that need it.
export function refForAudit(stored: string | null): {
  ref: string | null;
  opaque: boolean;
} {
  const ref = readableVaultRef(stored);
  return { ref, opaque: stored !== null && ref === null };
}

// The other half of the rule: the columns a row may NOT publish, compared but never carried.
//
// The rule is that a mutable column is either projected in a form safe to keep forever, or listed
// here — never left out of both. Left out of both, the column changes and the projection does not,
// `projectionMoved` sees nothing, and the edit writes no row at all. That is not a corner: review
// found it on five columns at once (a tool's headers/body/schemas, an integration's config VALUES
// under unchanged keys, an experiment's variant prompts), and each of those is the ordinary edit its
// family gets.
//
// WHAT THE ROW KEEPS IS A BOOLEAN, and that is the whole point of the shape. These columns are the
// ones a row may not carry — a free-form bag nothing validated, a prompt, a document body — so
// anything DERIVED from them may not be carried either: an unsalted digest of a low-entropy value
// is an offline verifier for it, and `audit_logs` is append-only and readable by every tenant admin
// long after the record itself is deleted. The comparison happens here, in memory, on values that
// are already in hand; only the answer is stored. Same answer #394 reached for the settings bag
// (`src/modules/agents/audit-projection.ts`, `unreadConfigChanged`), for the same reason.
//
// BigInt is stringified on the way in: `JSON.stringify` throws on it, and a column that threw here
// would take the audit row down with the mutation it belongs to.
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

// Put on BOTH sides, like #394's marker: it says a write moved something the row does not show, and
// that is a fact about the change rather than about either end of it. The audit write is gated on
// `undisclosedMoved` directly, never on this marker moving `projectionMoved` — two identical
// markers move nothing, which is exactly why the gate cannot be left to it.
export function markUndisclosed<T extends object>(
  projection: T,
): T & { undisclosedChanged: true } {
  return { ...projection, undisclosedChanged: true };
}
