// One outbound call, bounded in TIME and in MEMORY, for every place that fetches a third party and
// then reads what came back. A timer cleared in the fetch's own `finally` bounds only the response
// HEADERS: the body read after it has no end (a stalled provider holds a tool call forever), and
// `.text()` has no size bound either. So the fetch and the body read share one `try` and one timer,
// the read keeps only a prefix, and callers get the text, never the unread `Response`.
//
// `src/modules/chatwoot/client.ts` bounds time differently (`AbortSignal.timeout()` stays armed
// through the body read) and needs nothing from here.

import { clipText } from "@/lib/text";

// What any single response may leave in memory. Generous on purpose: the model is handed at most
// MODEL_RESPONSE_CHAR_LIMIT (4,000) characters, but a response template addresses fields ANYWHERE
// in the body, so the parse has to see far more of it than the model ever will. A megabyte covers
// the list endpoints operators actually point tools at; past that the body stops being parseable
// as JSON and the raw prefix is what the model gets, which is the behaviour a body with no
// template already has.
export const MAX_OUTBOUND_BODY_CHARS = 1_000_000;

export interface OutboundBody {
  // The prefix that was kept, already capped.
  text: string;
  // How long the WHOLE response was. Not `text.length`: what tells an operator their provider
  // answered with three million characters is the count, and it is the only thing that can.
  chars: number;
}

// OUR bound, not the provider's failure, and the distinction is the message. A stream that errors
// mid-read surfaces as `EncodingError` — the same shape a provider that really broke its stream
// produces — so without a type of our own a timeout reads as the provider's fault to every caller
// that classifies, and to the model as "The operation was aborted.", which says nothing it can act
// on.
export class OutboundTimeoutError extends Error {
  readonly timeoutMs: number;
  constructor(timeoutMs: number, options?: { cause?: unknown }) {
    super(
      `the provider did not answer within ${timeoutMs / 1000}s`,
      options as ErrorOptions,
    );
    this.name = "OutboundTimeoutError";
    this.timeoutMs = timeoutMs;
  }
}

// Read a response body keeping only the first `cap` characters, and counting the rest.
//
// `.text()` would buffer the whole thing before the cap is applied, so a provider answering with a
// few hundred megabytes could take the process down over an endpoint that returns a few thousand
// characters. The count still has to be exact, because "this response was cut" is decided on it,
// so the stream is drained to the end and only the prefix is retained. Draining is what the time
// bound above makes affordable: without it, "to the end" has no end.
export async function readCappedBody(
  res: Response,
  cap: number = MAX_OUTBOUND_BODY_CHARS,
): Promise<OutboundBody> {
  const stream = res.body;
  if (!stream) return { text: "", chars: 0 };
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let kept = "";
  let chars = 0;
  const take = (chunk: string) => {
    chars += chunk.length;
    // Overshoots by at most one chunk, which the clip below trims; the point is the bound, not the
    // exact character.
    if (kept.length < cap) kept += chunk;
  };
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    // Streaming decode: a multi-byte character split across two chunks would otherwise land as a
    // replacement character in the middle of the body a template is read against.
    take(decoder.decode(value, { stream: true }));
  }
  take(decoder.decode());
  // `clipText`, never a bare slice: a JS string is UTF-16 code units, and a cut landing between the
  // two halves of an astral character leaves a lone surrogate that Postgres refuses outright and
  // every screen renders as a replacement character.
  return { text: clipText(kept, cap), chars };
}

export interface FetchBoundedOptions {
  // The whole exchange's budget: headers AND body.
  timeoutMs: number;
  // Defaults to MAX_OUTBOUND_BODY_CHARS.
  cap?: number;
  fetchImpl?: typeof fetch;
}

export interface BoundedResponse {
  // The response, with its body already read. Kept so callers still have `status`, `ok` and the
  // headers; reading it again is neither possible nor needed.
  res: Response;
  body: OutboundBody;
}

// The fetch and the read under ONE timer, here rather than at each call site so no caller can
// bound the headers and forget the body.
async function bounded<T>(
  url: string,
  init: RequestInit,
  opts: { timeoutMs: number; fetchImpl?: typeof fetch },
  read: (res: Response) => Promise<T>,
): Promise<{ res: Response; value: T }> {
  const doFetch = opts.fetchImpl ?? fetch;
  const ctrl = new AbortController();
  // A caller's own signal still cancels: relayed rather than replaced, because the fetch below
  // must carry OUR controller for the timer to be able to cut the body read.
  const outer = init.signal ?? undefined;
  const relay = () => ctrl.abort(outer?.reason);
  outer?.addEventListener("abort", relay);
  if (outer?.aborted) relay();
  // Read in the catch, because the name of the error cannot tell: our abort and a provider that
  // really broke its stream produce the same shape.
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    ctrl.abort();
  }, opts.timeoutMs);
  try {
    const res = await doFetch(url, { ...init, signal: ctrl.signal });
    return { res, value: await read(res) };
  } catch (err) {
    if (timedOut)
      throw new OutboundTimeoutError(opts.timeoutMs, { cause: err });
    throw err;
  } finally {
    clearTimeout(timer);
    outer?.removeEventListener("abort", relay);
  }
}

// A request's own signal and the turn's deadline, COMBINED, never one chosen over the other. Both
// callers sit under a layer that already put its own controller in `init.signal` (the Chatwoot
// client's `AbortSignal.timeout`, or `bounded`'s body-read timer): preferring the caller's drops the
// deadline, and preferring the deadline disarms the timeout that stops a stalled provider. One
// helper because the two wrappers live in different modules.
export function withDeadline(
  own: AbortSignal | null | undefined,
  expiresOn: AbortSignal,
): AbortSignal {
  return own ? AbortSignal.any([own, expiresOn]) : expiresOn;
}

export async function fetchBounded(
  url: string,
  init: RequestInit,
  opts: FetchBoundedOptions,
): Promise<BoundedResponse> {
  const { res, value } = await bounded(url, init, opts, (r) =>
    readCappedBody(r, opts.cap),
  );
  return { res, body: value };
}

// For a call whose whole ANSWER is the status: a best-effort revoke, a ping, a fire-and-forget
// notification. The body is CANCELLED rather than read, because draining one nobody looks at can
// only add latency — a provider that answers its headers and then stalls would hold the caller for
// the entire budget, and this is exactly where that is felt: the Google disconnect awaits its
// revoke before it removes the local tokens.
export async function fetchBoundedNoBody(
  url: string,
  init: RequestInit,
  opts: { timeoutMs: number; fetchImpl?: typeof fetch },
): Promise<Response> {
  const { res } = await bounded(url, init, opts, async (r) => {
    await r.body?.cancel().catch(() => undefined);
    return null;
  });
  return res;
}

export interface OutboundBytes {
  // At most `maxBytes`, and empty when there were more: a download this size is refused, never
  // truncated, because half a file is not a smaller file.
  bytes: Uint8Array;
  tooLarge: boolean;
}

// The binary twin, for a download rather than a payload. `arrayBuffer()` buffers the whole body
// before any size check can refuse it, so a 5 GB file in someone's Drive is 5 GB of resident memory
// on the way to being rejected for being too large.
//
// Reads one byte PAST the limit and stops there: that byte is what tells "exactly at the limit"
// from "over it" without holding the rest, and the stream is cancelled rather than drained because
// nothing will ever look at what follows.
export async function readCappedBytes(
  res: Response,
  maxBytes: number,
): Promise<OutboundBytes> {
  const stream = res.body;
  if (!stream) return { bytes: new Uint8Array(0), tooLarge: false };
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      return { bytes: new Uint8Array(0), tooLarge: true };
    }
  }
  const bytes = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    bytes.set(c, at);
    at += c.byteLength;
  }
  return { bytes, tooLarge: false };
}

export async function fetchBoundedBytes(
  url: string,
  init: RequestInit,
  opts: {
    timeoutMs: number;
    maxBytes: number;
    fetchImpl?: typeof fetch;
    // Asked once the headers are in and BEFORE a byte of the body is read. `false` cancels the
    // stream and returns a null body: a download the status or the declared size already rules out
    // must not be pulled first, or a caller that refuses a 500 MB file spends `maxBytes` and its
    // whole budget discovering what Content-Length said up front.
    readWhen?: (res: Response) => boolean;
  },
): Promise<{ res: Response; body: OutboundBytes | null }> {
  const { res, value } = await bounded(url, init, opts, async (r) => {
    if (opts.readWhen && !opts.readWhen(r)) {
      await r.body?.cancel().catch(() => undefined);
      return null;
    }
    return readCappedBytes(r, opts.maxBytes);
  });
  return { res, body: value };
}
