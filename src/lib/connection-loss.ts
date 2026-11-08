// Whether a database error is the connection going away (a restart, a crash, a network cut, a
// server not up yet) rather than a fault of the statement or the configuration. Free of the app's
// config and logger, so the boot script can read it before anything else is loaded.

// The SQLSTATEs and socket codes a database restart, crash or network cut produces: expected, and
// repaired by the next connection. 57P01 admin shutdown, 57P02 crash shutdown, 57P03 cannot connect
// now, class 08 connection exceptions.
const CONNECTION_LOSS_CODES = new Set([
  "57P01",
  "57P02",
  "57P03",
  "08000",
  "08001",
  "08003",
  "08004",
  "08006",
  "ECONNREFUSED",
  "ECONNRESET",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ETIMEDOUT",
  "EPIPE",
  "EHOSTUNREACH",
  "ENETUNREACH",
]);

// `pg`'s own texts, which carry no code: a socket that closed without a message from the server, and
// a query on a client whose connection already failed.
const UNEXPECTED_END =
  /Connection terminated unexpectedly|encountered a connection error and is not queryable/i;

export function connectionErrorCode(err: unknown): string | undefined {
  if (typeof err !== "object" || err === null) return undefined;
  const code = (err as { code?: unknown }).code;
  if (typeof code === "string" && code) return code;
  // A connect to a host with several addresses (localhost: ::1 and 127.0.0.1) fails with an
  // AggregateError whose own code is empty; the first inner code is the answer.
  const inner = (err as { errors?: unknown }).errors;
  if (Array.isArray(inner)) {
    for (const e of inner) {
      const c = connectionErrorCode(e);
      if (c) return c;
    }
  }
  return undefined;
}

// The `cause` chain is followed: an error that explains a failed step in its own words is still the
// lost connection when that is what failed.
export function isConnectionLoss(err: unknown, depth = 0): boolean {
  if (typeof err !== "object" || err === null || depth > 4) return false;
  const code = connectionErrorCode(err);
  if (code && CONNECTION_LOSS_CODES.has(code)) return true;
  const message = String((err as { message?: unknown }).message ?? "");
  if (UNEXPECTED_END.test(message)) return true;
  return isConnectionLoss((err as { cause?: unknown }).cause, depth + 1);
}
