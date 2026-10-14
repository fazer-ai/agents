// The Postgres SQLSTATE behind an error from a Prisma call through the `pg` adapter, or null. A raw
// query reports it as P2010 with the driver error in `meta.driverAdapterError.cause`; a model call
// carries the driver error as `cause`. Measured for both 57014 (statement timeout) and 55P03 (lock
// timeout).
export function postgresCodeOf(error: unknown): string | null {
  let current: unknown = error;
  for (let depth = 0; current && depth < 5; depth++) {
    const e = current as {
      meta?: { driverAdapterError?: { cause?: { originalCode?: unknown } } };
      cause?: unknown;
      originalCode?: unknown;
      kind?: unknown;
      code?: unknown;
    };
    const fromMeta = e.meta?.driverAdapterError?.cause?.originalCode;
    if (typeof fromMeta === "string") return fromMeta;
    if (typeof e.originalCode === "string") return e.originalCode;
    if (e.kind === "postgres" && typeof e.code === "string") return e.code;
    current = e.cause;
  }
  return null;
}

// Prisma's own transaction errors: P2028 covers both a transaction that never got a connection
// within `maxWait` and one that outlived its `timeout`.
export function isPrismaTransactionError(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === "P2028";
}

// A constraint violation reaches a caller in one of two shapes. Converted by the adapter, it carries
// Prisma's code (P2002 unique, P2003 foreign key). Unconverted, it is a known request error whose
// `code` is the Postgres SQLSTATE (23505, 23503) and whose message is the server's: seen on CI, cause
// not found, and a race handled for one shape would answer 500 for the other. Both are read here,
// and nowhere else (biome-plugins/no-raw-violation-code.grit).
const UNIQUE = new Set(["P2002", "23505"]);
const FOREIGN_KEY = new Set(["P2003", "23503"]);

function violationCode(error: unknown): string | null {
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === "string" && (UNIQUE.has(code) || FOREIGN_KEY.has(code)))
    return code;
  return postgresCodeOf(error);
}

export function isUniqueViolation(error: unknown): boolean {
  const code = violationCode(error);
  return code !== null && UNIQUE.has(code);
}

export function isForeignKeyViolation(error: unknown): boolean {
  const code = violationCode(error);
  return code !== null && FOREIGN_KEY.has(code);
}

// The constraint a violation names, as the index name (`document_templates_tenant_id_name_key`) or
// the columns it covers, comma-joined, or null. Prisma 7 fills neither `meta.target` nor
// `meta.field_name`: converted, the name is the adapter's `constraint`; unconverted, it is the one the
// Postgres message quotes.
export function violatedConstraintOf(error: unknown): string | null {
  let current: unknown = error;
  for (let depth = 0; current && depth < 5; depth++) {
    const e = current as {
      meta?: { driverAdapterError?: { cause?: unknown } };
      constraint?: unknown;
      cause?: unknown;
    };
    const named = constraintName(e.meta?.driverAdapterError?.cause);
    if (named !== null) return named;
    const own = constraintName(e);
    if (own !== null) return own;
    current = e.cause;
  }
  const message = (error as { message?: unknown } | null)?.message;
  if (typeof message !== "string") return null;
  return /constraint "([^"]+)"/.exec(message)?.[1] ?? null;
}

function constraintName(source: unknown): string | null {
  const constraint = (source as { constraint?: unknown } | null)?.constraint;
  if (typeof constraint === "string") return constraint;
  const c = constraint as { index?: unknown; fields?: unknown } | undefined;
  if (typeof c?.index === "string") return c.index;
  if (Array.isArray(c?.fields)) return c.fields.map(String).join(",");
  return null;
}
