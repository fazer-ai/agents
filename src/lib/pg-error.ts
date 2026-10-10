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
