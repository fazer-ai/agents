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
