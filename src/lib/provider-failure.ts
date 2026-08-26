import logger from "@/api/lib/logger";

// WHAT A PROVIDER FAILURE IS ALLOWED TO SAY, once it leaves the call that made it.
//
// One question decides every field, and it is WHO CHOSE THE VALUE — never what the value looks like.
// The requests these errors answer carry customer content by construction: the model call carries the
// whole conversation, the guardrail the message under review, `stt` the customer's audio, `vision`
// their image, the embedding their question. So anything the SERVER authored may be that content
// coming back — a content-filter refusal or a 400 quoting the offending field is the ordinary case —
// and four operator-facing stores read the message of whatever was thrown:
//
//   execution_logs.errorMessage   the Logs page, `GET /v1/logs`, the `logs` MCP tool
//   alert_deliveries.summary      POSTed to a channel URL the operator configured
//   conversations.last_error      the console's error badge, and the conversation DTO
//   a Chatwoot private note        written into the customer's own conversation
//
// The first two are documented to carry no message text and no PII at all (`docs/logs.md`), and the
// second is the one that LEAVES the installation. `sanitizeErrorMessage` does not help: it redacts
// substrings shaped like SECRETS, and a name, a phone number and a case number are not.
//
// So `message`, `code`, `type` and even `name` are all out as VALUES — the first obviously, the
// middle two because they are vendor identifiers by convention only and this product accepts an
// arbitrary OpenAI-compatible endpoint, the last because it reads like the SDK's class and is a plain
// writable property. A shape test rescues none of them: rejecting prose still admits a bare token,
// and a phone number, a CPF and a first name are all bare tokens.
//
// What is left is a CLOSED vocabulary this module owns:
//
//   "timeout"        — we stopped waiting; nothing from the response decides it
//   "HTTP <nnn>"     — a status the CLIENT parsed into a number, never read out of any text
//   "provider error" — everything else, including a connection that never opened
//
// Coarse on purpose, and still the distinction an operator acts on: 401 the credential, 429 the rate,
// 404 the model id, timeout the endpoint. The vendor's own words are not destroyed, they are moved:
// `asProviderFailure` keeps the original as `cause`, so the process log — which makes no PII promise
// and is not exported by any product surface — still carries the whole thing.

// A status, and only from a NUMBER field. The status is the one thing here the server does choose,
// and it is admissible for a reason that has nothing to do with trusting the server: the client
// parsed it out of the status line into a number, and a number cannot carry a transcript.
//
// Which is also why it is not dug out of the message when the field is absent. An earlier revision
// did that, on the grounds that digits alone could not leak anything — and the digits are not the
// problem, being WRONG is: when there is an HTTP response the client sets the field, and when there
// is none (a connection that never opened) there is no status to find, so a 4xx-shaped number in the
// text is the customer's PIN or their invoice total far more often than it is a transport status.
//
// One predicate over both spellings, rather than one per field: they ask the same question, and a
// rule written twice is a rule the second copy gets wrong. The range and the integer test are what
// keep `HTTP NaN` and `HTTP 429.5` out of a vocabulary this module promises is closed.
function httpStatus(v: unknown): number | null {
  return typeof v === "number" && Number.isInteger(v) && v >= 100 && v <= 599
    ? v
    : null;
}

// WHICH statuses describe the ENDPOINT's momentary state rather than our request. A fact about the
// transport, not a policy: 408/504 the hop's own timeout, 429 the rate, 500/502/503 the overload,
// 529 Anthropic's spelling of it, and 520-524 Cloudflare's — which matter because an
// openai-compatible endpoint is an arbitrary server and a great many of them sit behind that proxy,
// where an origin that is down never gets to answer 503 in the first place. Read off Cloudflare's
// own documentation: 520 "web server returns an unknown error", 521 "web server is down", 522
// "connection timed out", 523 "origin is unreachable", 524 "a timeout occurred".
//
// Its 525 and 526 are deliberately absent, and the line is the same one that keeps 401 out: an SSL
// handshake that failed and an invalid certificate are CONFIGURATION, they answer identically on
// every attempt, and a fallback covering them covers them forever while the broken endpoint is
// never repaired. 530 is absent because it means "see the 1xxx error beside me" and names nothing on
// its own.
//
// Everything else a server answers is about what we SENT (400, 401, 403, 404, 413, 422) and answers
// the same way every time it is asked.
//
// It lives here, and the POLICIES live with their callers, because the two are different questions
// and only the first one is shared. `modules/vision/retry` asks the SAME endpoint again and
// therefore excludes a 401 as pointless; `graph/model-fallback` asks a DIFFERENT one, where a 401
// would be answered — and excludes it anyway, because a fallback that covers a dead primary key
// covers it forever and the operator never learns. Same set, opposite reasons, which is exactly why
// the reasons are not written here.
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

// A PREDICATE over the error's own naming, which is not the thing the header rules out. What is
// forbidden is PUBLISHING a value the server wrote; this only chooses between two constants this
// module owns, so a server that lies about it costs us one of our own words in place of another and
// can smuggle nothing. A caller holding its own AbortSignal has a better reading and passes
// `timedOut` instead: that one owes nothing to the response at all.
//
// Two namings, because one does not cover the SDKs. `AbortSignal.timeout` rejects with a
// DOMException named `TimeoutError`, but both vendor SDKs raise a CLASS instead and leave `name` at
// the default "Error" — measured: `APIConnectionTimeoutError` on the OpenAI and Anthropic clients
// alike, with no numeric status either, so a real timeout was reporting as "provider error" (review
// round 5). Matched by SUFFIX rather than by a list of class names: a list of vendors is the shape
// this whole change exists to stop writing, and a name ending in `TimeoutError` says the same thing
// whoever the next client is. `APIUserAbortError` deliberately does not match — a caller cancelling
// is not the endpoint being slow.
//
// It degrades in the safe direction: an unrecognised timeout reports "provider error", which names
// something true and vaguer, never something false and never anything the server wrote.
function namesATimeout(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return (
    err.name === "AbortError" ||
    err.name.endsWith("TimeoutError") ||
    err.constructor.name.endsWith("TimeoutError")
  );
}

export function providerFailure(err: unknown, timedOut = false): string {
  if (timedOut || namesATimeout(err)) return "timeout";
  // No `instanceof Error` guard of its own: `statusOf` asks that question already, so a second copy
  // here is a clause no input can reach. It had one, and mutation found it dead.
  const status = statusOf(err);
  return status === null ? "provider error" : `HTTP ${status}`;
}

// The error to throw in place of one a provider wrote, at the boundary where the call was made —
// which is the only place provenance is known. Downstream nothing has to change and nothing has to
// remember: the four stores above all read `.message`, and they get this one.
//
// Two things ride along on purpose. `cause` keeps the original for the process log. The numeric
// status is copied onto the wrapper so this is IDEMPOTENT: a caller that reduces again (the
// compaction job does, because it holds a better reading of "it timed out") still reports `HTTP 429`
// rather than degrading it to "provider error" on the second pass.
export function asProviderFailure(err: unknown, timedOut = false): Error {
  // Logged HERE and not at either boundary, because this is the function that performs the
  // replacement and therefore the place where the original stops travelling. Two review rounds found
  // the same defect one lane apart — the model boundary, then the embedding one — which is what a
  // rule kept next to its call sites always produces. `cause` is not a substitute: it only survives
  // for a reader that serializes the chain, and the paths that catch these errors read `.message`
  // (the direct webhook logs printf-style, the playground digs a detail out of the text). Without
  // this line the relocation `docs/logs.md` promises would be a deletion, and a wrong model id or a
  // malformed request would be undiagnosable anywhere.
  logger.warn(
    { err },
    "provider call failed; reporting it without the provider's text",
  );
  const out = new Error(providerFailure(err, timedOut), { cause: err });
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
