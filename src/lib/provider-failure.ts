import logger from "@/api/lib/logger";

// WHAT A PROVIDER FAILURE IS ALLOWED TO SAY once it leaves the call (docs/logs.md, the provider
// boundary section): anything the SERVER authored may be customer content, so `message`, `code`,
// `type` and `name` never cross as values (`code`/`type` are only vendor conventions on an arbitrary
// OpenAI-compatible endpoint, `name` is writable). What crosses is a CLOSED vocabulary:
//   "timeout"         we stopped waiting; nothing from the response decides it
//   "HTTP <nnn>"      a status the CLIENT parsed into a number, never read out of any text
//   "provider error"  everything else, including a connection that never opened
// `asProviderFailure` keeps the original as `cause` for the process log, which makes no PII promise.

// A status, and only from a NUMBER field: the client parsed it out of the status line, and a number
// cannot carry a transcript. Never dug out of the message when the field is absent, since then there
// was no HTTP response and a 4xx-shaped number in the text is more likely a PIN or an invoice total.
// The range and integer test keep `HTTP NaN` and `HTTP 429.5` out of the closed vocabulary.
function httpStatus(v: unknown): number | null {
  return typeof v === "number" && Number.isInteger(v) && v >= 100 && v <= 599
    ? v
    : null;
}

// WHICH statuses describe the ENDPOINT's momentary state rather than our request: 408/504 the hop's
// timeout, 429 the rate, 500/502/503 overload, 529 Anthropic's overload, and Cloudflare's 520-524
// (many openai-compatible endpoints sit behind it, where a down origin never answers 503). Cloudflare's
// 525/526 are CONFIGURATION (TLS) and 530 names nothing alone, so they are absent, like 401.
//
// The POLICIES live with their callers, because only this set is shared: `modules/vision/retry` skips
// a 401 because the same endpoint will repeat it, and `graph/model-fallback` skips it because a
// fallback covering a dead primary key hides it forever.
export function isTransientProviderStatus(status: number): boolean {
  return TRANSIENT_PROVIDER_STATUSES.has(status);
}

const TRANSIENT_PROVIDER_STATUSES: ReadonlySet<number> = new Set([
  408, 429, 500, 502, 503, 504, 520, 521, 522, 523, 524, 529,
]);

export function statusOf(err: unknown): number | null {
  if (!(err instanceof Error)) return null;
  const bag = err as unknown as Record<string, unknown>;
  return httpStatus(bag.status) ?? httpStatus(bag.statusCode);
}

// A PREDICATE over the error's own naming, which is allowed: it only chooses between two constants
// this module owns, so a lying server can smuggle nothing. A caller holding its own AbortSignal
// passes `timedOut` instead. Matched by SUFFIX because the OpenAI and Anthropic SDKs raise
// `APIConnectionTimeoutError` with `name` left at "Error" and no status, and a vendor list would
// rot; `APIUserAbortError` does not match, since a caller cancelling is not the endpoint being slow.
// An unrecognised timeout degrades to "provider error": vaguer, never false.
function namesATimeout(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return (
    err.name === "AbortError" ||
    err.name.endsWith("TimeoutError") ||
    err.constructor.name.endsWith("TimeoutError")
  );
}

// A failure already written on a line of its own, labelled with the provider that failed (a
// fallback's), with the class it was written with: an enclosing line labelled with the primary must
// not classify it again, or a dead fallback key is also a cause on the primary that never made the
// call. It records the class as `fallbackFailure` instead (flowlog/alerts.ts reads it).
const reportedElsewhere = new WeakMap<Error, string>();

export function markReportedElsewhere(err: unknown, failure: string): void {
  if (err instanceof Error) reportedElsewhere.set(err, failure);
}

export function reportedFailure(err: unknown): string | null {
  let e: unknown = err;
  for (let depth = 0; e instanceof Error && depth < 5; depth++) {
    const failure = reportedElsewhere.get(e);
    if (failure !== undefined) return failure;
    e = e.cause;
  }
  return null;
}

// The failure class an enclosing line records: its own, or, when a fallback's line already
// classified it, that class under `fallbackFailure`.
export function failureDetail(err: unknown): Record<string, string> {
  const reported = reportedFailure(err);
  return reported === null
    ? { failure: providerFailure(err) }
    : { fallbackFailure: reported };
}

// Whether the provider will answer the same way until a person acts on the account (no credit, a key
// invalid or without access). A predicate over the provider's own error, allowed like `namesATimeout`:
// it only chooses a boolean. Yes for a 401 or 403; a 429 with `insufficient_quota` (any other 429 is a
// rate, Gemini's daily quota included, since it answers like its per-minute limit); a 402 without
// `Retry-After` (with it, OpenRouter's in-flight budget, which clears on its own); and Anthropic's 400
// for a credit balance too low. The full table is in docs/logs.md.
export function failsUntilAccountFixedAt(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const status = statusOf(err);
  const bag = err as unknown as Record<string, unknown>;
  if (status === 401 || status === 403) return true;
  if (status === 429) return errorCode(bag) === "insufficient_quota";
  if (status === 402) return !hasRetryAfter(bag);
  if (status === 400) return /credit balance is too low/i.test(err.message);
  return false;
}

function errorCode(bag: Record<string, unknown>): string | null {
  if (typeof bag.code === "string") return bag.code;
  const inner = bag.error;
  if (typeof inner === "object" && inner !== null) {
    const code = (inner as Record<string, unknown>).code;
    if (typeof code === "string") return code;
  }
  return null;
}

function hasRetryAfter(bag: Record<string, unknown>): boolean {
  for (const source of [
    bag.headers,
    (bag.response as { headers?: unknown })?.headers,
  ]) {
    if (typeof source !== "object" || source === null) continue;
    const get = (source as { get?: unknown }).get;
    const value =
      typeof get === "function"
        ? get.call(source, "retry-after")
        : ((source as Record<string, unknown>)["retry-after"] ??
          (source as Record<string, unknown>)["Retry-After"]);
    if (value !== null && value !== undefined && String(value).trim() !== "")
      return true;
  }
  return false;
}

// Every wrapper `asProviderFailure` built.
const wrappers = new WeakSet<Error>();

// The wrappers `asProviderFailure` built for a failure `failsUntilAccountFixedAt` recognised, read
// downstream by `failsUntilAccountFixed`, where the provider's error is only the wrapper's `cause`.
const accountFailures = new WeakSet<Error>();

// Whether this failure, wherever it surfaced, is one the provider will repeat until the account is
// fixed: a wrapper from `asProviderFailure` that recognised it, found on the error or its causes. Only
// a model call's failure can answer yes, so a Chatwoot 401 keeps its retries.
export function failsUntilAccountFixed(err: unknown): boolean {
  let e: unknown = err;
  for (let depth = 0; e instanceof Error && depth < 5; depth++) {
    if (accountFailures.has(e)) return true;
    e = e.cause;
  }
  return false;
}

// The wrappers `asProviderFailure` built for a timeout: their name is plain "Error" and their message
// is the word, so without this a second reading (`withFlowStage` around a model call) would call a
// timeout a "provider error", and a provider timing out all day would never make a rate.
const timedOutWrappers = new WeakSet<Error>();

export function providerFailure(err: unknown, timedOut = false): string {
  if (
    timedOut ||
    namesATimeout(err) ||
    (err instanceof Error && timedOutWrappers.has(err))
  )
    return "timeout";
  // No `instanceof Error` guard of its own: `statusOf` asks that question already, so a second
  // copy here would be a clause no input can reach.
  const status = statusOf(err);
  return status === null ? "provider error" : `HTTP ${status}`;
}

// The error to throw in place of one a provider wrote, at the boundary where the call was made —
// which is the only place provenance is known. Downstream nothing has to change and nothing has to
// remember: the four stores above all read `.message`, and they get this one.
//
// Three things ride along on purpose. `cause` keeps the original for the process log. A timeout is
// remembered on the wrapper, and the numeric status is copied onto it, so this is IDEMPOTENT: a caller that reduces again (the
// compaction job does, because it holds a better reading of "it timed out") still reports `HTTP 429`
// rather than degrading it to "provider error" on the second pass.
export function asProviderFailure(err: unknown, timedOut = false): Error {
  // NOTE: logged HERE, where the original stops travelling, rather than at each boundary, where a
  // lane gets missed. `cause` is no substitute: the paths that catch these read `.message`. Without
  // this line the relocation `docs/logs.md` promises would be a deletion, and a wrong model id or a
  // malformed request would be undiagnosable anywhere.
  logger.warn(
    { err },
    "provider call failed; reporting it without the provider's text",
  );
  const failure = providerFailure(err, timedOut);
  const out = new Error(failure, { cause: err });
  if (failure === "timeout") timedOutWrappers.add(out);
  // NOTE: a wrapper reduced again keeps its own answer: the provider's code and headers are not
  // copied onto it, so asking the predicate of it would read a 402 with `Retry-After` as one without.
  if (
    wrappers.has(err as Error)
      ? failsUntilAccountFixed(err)
      : failsUntilAccountFixedAt(err)
  )
    accountFailures.add(out);
  wrappers.add(out);
  const status = statusOf(err);
  if (status !== null) {
    (out as unknown as Record<string, unknown>).status = status;
  }
  return out;
}

// The boundary itself, for a call with nothing special to say about its own faults. `runModelCall`
// does not use it: it recognises one fault of its own (an empty completion) and names that before
// falling through to this rule.
export async function throughProvider<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    throw asProviderFailure(err);
  }
}
