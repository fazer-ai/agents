import { clipText, makeStorable } from "@/lib/text";

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

// A URL with every part a credential can hide in removed, for a row that OUTLIVES the record it
// describes. The live read surfaces return these URLs whole to the same tenant admins; the trail is
// append-only, so a token pasted into one once would outlast every correction.
//
// The parts are the repo's own measured line rather than a guess: `carriesCredential`
// (`src/modules/agents/audit-projection.ts`) asks about USERINFO under any scheme and about the
// QUERY and the FRAGMENT under `http(s)`, and it deliberately stops there — a path segment was left
// out because ordinary endpoints and operator prose put content in one. `u.host` excludes userinfo,
// so reading the three parts off `URL` is what does the removing.
//
// `keep: "origin"` drops the path as well, for a URL the repo already treats as a secret at rest: an
// alert channel's is stored encrypted precisely because a Discord webhook carries its token in the
// PATH. A caller whose column is in the clear keeps the path, because the trail is read to tell two
// endpoints on one host apart.
export function redactEndpoint(url: string, keep: "origin" | "path"): string {
  try {
    const u = new URL(url);
    return keep === "origin"
      ? `${u.protocol}//${u.host}/…`
      : `${u.protocol}//${u.host}${u.pathname}`;
  } catch {
    // Not parseable as a URL, so no part of it can be shown to be safe.
    return "…";
  }
}
