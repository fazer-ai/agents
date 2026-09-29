import { OpenAIEmbeddings } from "@langchain/openai";
import {
  isTransientProviderStatus,
  providerFailure,
  statusOf,
  throughProvider,
} from "@/lib/provider-failure";
import { assertSafeOutboundUrl, SsrfError } from "@/lib/ssrf";
import { clipText } from "@/lib/text";

// Embedding wrapper. OpenAI-compatible by default (text-embedding-3-small → 1536 dims, matching
// the knowledge_chunks vector(1536) column). The API key is resolved from the vault by the
// caller (never inlined/logged). Embedding is network I/O and MUST run outside any transaction.

// The vector column width. A model producing a different dimensionality needs a schema migration;
// we guard at insert time rather than silently corrupting the index — and, since a configurable
// endpoint can answer with any model at all, at the network boundary too (`assertWidth`).
export const EMBEDDING_DIM = 1536;

export interface EmbeddingConfig {
  model: string;
  apiKey: string;
  baseURL?: string;
}

// Injectables, trailing and defaulted, rather than fields on `EmbeddingConfig`: that config is built
// from a vault row in `resolveEmbeddingStatus` and has no business carrying a function. Same shape
// `listProviderModels` uses for the same pair, and the SSRF assertion in particular MUST be
// stubbable — it resolves DNS, so a hermetic test cannot reach the real one.
export interface EmbeddingDeps {
  fetchImpl?: typeof fetch;
  assertSafe?: typeof assertSafeOutboundUrl;
  // Told each time a query embedding is about to be asked again, so the search that paid for it can
  // say so on its tool line. The ingest does not report retries anywhere.
  onRetry?: (err: unknown) => void;
  // The query's two deadlines, for a test that cannot wait seconds for a stalled request.
  queryBudget?: QueryBudget;
}

// The INGEST's wait for one request. Nobody is waiting on a reply and a failure is terminal (the
// document lands in FAILED), so a slow endpoint is given its time.
const EMBEDDING_TIMEOUT_MS = 60_000;

// A QUERY IS A CUSTOMER WAITING. `embedQuery` runs inside a live turn's `search_knowledge` (and the
// console and MCP searches). A query embedding answers in well under a second, so an attempt still
// open after a few seconds is a stalled connection, and asking again beats waiting on it.
// `attemptMs` bounds one request; `deadlineMs` bounds the whole search, retries included, and sits
// well under the turn's own deadline (`PRIMARY_TIMEOUT_MS`), so the turn can still answer without it.
export interface QueryBudget {
  attemptMs: number;
  deadlineMs: number;
}
export const QUERY_BUDGET: QueryBudget = {
  attemptMs: 8_000,
  deadlineMs: 20_000,
};

// The same bound `@langchain/openai` applies on the SDK path (`batchSize = 512`). It is here because
// `embedTexts` is handed EVERY chunk of a document at once (`documents.ts`), which has no size cap:
// one unbounded POST is a 400/413 on a self-hosted server, which is precisely the deployment this
// path exists to serve. Sequential rather than langchain's `Promise.all`, for the same reason —
// a single-GPU endpoint is not helped by twenty simultaneous requests.
const COMPATIBLE_BATCH_SIZE = 512;

// `@langchain/openai` retries six times by default; this path does its own retrying instead. An ingest
// failure is terminal (the document lands in FAILED until a manual reindex), so a single 503 must not
// cost it. Three attempts, not six, because `embedQuery` shares this path inside a live turn.
const COMPATIBLE_RETRY_DELAYS_MS = [500, 2000];

// What is worth asking again differs per caller; the transient STATUSES are shared (see
// `provider-failure`). A failure with no status (a reset, or a base URL that never resolves) divides
// them: `embedTexts` is the INGEST, nobody waits and the failure is terminal, so it is asked again;
// `embedQuery` is a live TURN that can proceed without the search, so it is not. A response we could
// not use (wrong count, bad indexes, non-numeric vector) is never retried: it will answer the same.
function isTransient(err: unknown, retryStatusless: boolean): boolean {
  if (err instanceof UnusableResponseError) return false;
  // NO clause for the guard's own refusal, which now runs on every attempt and so lands in here.
  // `SsrfError` extends `AppError` and carries status 400, which `statusOf` already reads and
  // `isTransientProviderStatus` already rejects — a second copy is a branch no input can reach, and
  // mutation found it dead exactly as `provider-failure` records for its own. The outcome is the one
  // we want and it is worth naming: a block is deterministic, and the one case where a second answer
  // WOULD differ is the rebinding this re-check exists to catch, where asking again is asking to be
  // let through on the second reply.
  if (providerFailure(err) === "timeout") return true;
  const status = statusOf(err);
  if (status === null) return retryStatusless;
  return isTransientProviderStatus(status);
}

// A response that arrived and cannot be used. Its own class so the retry policy can tell it from a
// transport failure, which otherwise looks identical: neither carries a status.
class UnusableResponseError extends Error {}

function client(
  cfg: EmbeddingConfig,
  deps: EmbeddingDeps,
  // A query attempt's own cancellation, with LangChain's six retries off so the one loop that
  // retries is ours and the deadline covers it. Absent for the ingest, which keeps the SDK's defaults.
  query?: { signal: AbortSignal },
): OpenAIEmbeddings {
  // LangChain's `embedQuery` takes no signal, so the attempt's reaches the request through the fetch
  // the SDK is given: aborting it closes the request and any error body still being read, which the
  // SDK's own timer stops covering once the headers arrive.
  const baseFetch = deps.fetchImpl ?? fetch;
  const fetchImpl = query
    ? (((url: Parameters<typeof fetch>[0], init?: RequestInit) =>
        baseFetch(url, {
          ...init,
          signal: init?.signal
            ? AbortSignal.any([init.signal, query.signal])
            : query.signal,
        })) as typeof fetch)
    : deps.fetchImpl;
  const configuration = {
    ...(cfg.baseURL ? { baseURL: cfg.baseURL } : {}),
    // Only when injected or wrapped: undefined here would still be a key the SDK sees, and the point
    // is that the ingest keeps the global fetch. It exists so a test can assert what this path SENDS
    // — which is the reason the compatible path below exists at all: with no `encoding_format` of
    // its own the SDK adds `base64`, and a good many self-hosted servers answer that with a 400.
    ...(fetchImpl ? { fetch: fetchImpl } : {}),
  };
  return new OpenAIEmbeddings({
    model: cfg.model,
    apiKey: cfg.apiKey,
    ...(Object.keys(configuration).length ? { configuration } : {}),
    ...(query ? { maxRetries: 0 } : {}),
  });
}

// A non-2xx compatible response as an error with a numeric `status`, because `providerFailure` reads
// the status only from that property, never from the message. The body goes in the message because
// `asProviderFailure` keeps this error as `cause` for the process log, the only place the vendor's
// words survive (`docs/logs.md`). The body may quote customer text, so the operator-facing stores
// read only "HTTP <status>", from the error that replaces this one.
async function providerResponseError(res: Response): Promise<Error> {
  let body = "";
  try {
    // `clipText`, not a bare slice: this is arbitrary text an arbitrary server wrote, and a cut
    // landing between the halves of a surrogate pair leaves a lone surrogate in a value bound for
    // the process log (`tests/lib/astral-cap-sweep.test.ts`).
    body = clipText(await res.text(), 2000);
  } catch {
    // A body that cannot be read costs the log its detail, never the status.
  }
  const message = body
    ? `${res.status} ${body}`
    : `embedding provider failed with ${res.status}`;
  return Object.assign(new Error(message), { status: res.status });
}

async function embedCompatibleBatch(
  texts: string[],
  cfg: EmbeddingConfig & { baseURL: string },
  deps: EmbeddingDeps,
  signal: AbortSignal,
): Promise<number[][]> {
  // Checked BEFORE EVERY FETCH, not once per document: a tenant-controlled hostname can resolve
  // publicly for the check and privately later, and a document is many batches with retries. This
  // narrows the DNS-rebinding window rather than closing it (`fetch` resolves again), like the custom
  // HTTP tool (`graph/tools/http.ts`).
  const url = await compatibleTarget(cfg.baseURL, deps);
  // NOTE: An attempt given up on while the host was being resolved sends nothing: the search has
  // moved on, and a request now would be billed for an answer nobody reads.
  signal.throwIfAborted();
  const fetchImpl = deps.fetchImpl ?? fetch;
  const res = await fetchImpl(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${cfg.apiKey}`,
    },
    body: JSON.stringify({ model: cfg.model, input: texts }),
    redirect: "error",
    signal,
  });
  if (!res.ok) throw await providerResponseError(res);
  // A 2xx whose body is not JSON is a response that ARRIVED and cannot be used, and it has to be
  // said here: `res.json()` rejects with a statusless SyntaxError, indistinguishable from a
  // connection reset, and the ingest's policy would send the same batch twice more.
  //
  // ONLY a syntax failure, though. Reading a body is still transport: the connection can reset or
  // the deadline can fire between the headers and the last byte, and both reject out of this same
  // call. Swallowing those into "unusable" would skip the retry they deserve and make one
  // interruption a terminally FAILED document.
  let json: unknown;
  try {
    json = await res.json();
  } catch (err) {
    if (!(err instanceof SyntaxError)) throw err;
    throw new UnusableResponseError(
      "embedding provider returned a body that is not JSON",
    );
  }
  // The SHAPE is checked before anything is read off it, for the same reason. Valid JSON whose root
  // is `null`, or whose `data` is an object, throws a statusless TypeError on the property access
  // and the spread — which the ingest would then read as transport and pay for twice more, against a
  // provider that already gave its deterministic answer.
  const data =
    typeof json === "object" && json !== null
      ? (json as { data?: unknown }).data
      : undefined;
  if (
    json === null ||
    typeof json !== "object" ||
    (data !== undefined && !Array.isArray(data))
  ) {
    throw new UnusableResponseError(
      "embedding provider returned an unusable response shape",
    );
  }
  const items = [
    ...((data ?? []) as Array<{ index?: unknown; embedding?: unknown } | null>),
  ];
  if (items.length !== texts.length) {
    throw new UnusableResponseError(
      "embedding provider returned the wrong vector count",
    );
  }
  // Two acceptable shapes: NO item carries an index (positional order, as the SDK path reads
  // it), or every one does and they form exactly 0..n-1. A partial set or a non-permutation leaves
  // no order to recover, so it is refused rather than guessed: a guess publishes vectors against the
  // wrong chunks. Only an ABSENT index licenses positional order; `"1"` or `null` is not absent.
  const present = items.filter((i) => i?.index !== undefined);
  if (present.length > 0) {
    const indexes = present.map((i) => i?.index);
    const usable =
      present.length === items.length &&
      indexes.every(
        (n) =>
          typeof n === "number" &&
          Number.isInteger(n) &&
          n >= 0 &&
          n < items.length,
      ) &&
      new Set(indexes).size === indexes.length;
    if (!usable) {
      throw new UnusableResponseError(
        "embedding provider returned an unusable index set",
      );
    }
    items.sort((a, b) => (a?.index as number) - (b?.index as number));
  }
  // Optional chaining throughout, and no separate clause for a `null` ITEM inside `data`: every read
  // above is `i?.`, so a null never reaches a property access, and it arrives here with no
  // `embedding` and is refused by this check. A clause of its own changed only which of two
  // sentences the process log got, and mutation found it dead.
  return items.map((item) => {
    if (
      !Array.isArray(item?.embedding) ||
      !item.embedding.every((value) => typeof value === "number")
    ) {
      throw new UnusableResponseError(
        "embedding provider returned an invalid vector",
      );
    }
    return item.embedding as number[];
  });
}

// Where the compatible request is aimed, resolved once for the whole document rather than per batch.
async function compatibleTarget(
  baseURL: string,
  deps: EmbeddingDeps,
): Promise<string> {
  // Through `URL`, not concatenation: the vault accepts any http(s) URL, and Azure's own spelling
  // carries a query (`…/v1?api-version=2024-02-01`). Appending to that string puts the path INSIDE
  // the query and the POST lands on `/v1`, which a compatible server answers with something that
  // parses far enough to be confusing.
  const endpoint = compatibleEndpoint(baseURL);
  // SSRF guard on the URL the OPERATOR configured, immediately before the fetch, exactly as the
  // openai-compatible branch of `listProviderModels` does. The vault validates `baseUrl` as http(s)
  // syntax and nothing more, so without this a tenant admin turns knowledge ingestion into a POST at
  // any loopback, RFC1918 or metadata address. `allowHttp` for the same reason the models listing
  // allows it: these endpoints are self-hosted and routinely plain http on a private network.
  const safeUrl = await (deps.assertSafe ?? assertSafeOutboundUrl)(endpoint, {
    allowHttp: true,
  });
  return safeUrl.toString();
}

function batchesOf(texts: string[]): string[][] {
  const out: string[][] = [];
  for (let i = 0; i < texts.length; i += COMPATIBLE_BATCH_SIZE) {
    out.push(texts.slice(i, i + COMPATIBLE_BATCH_SIZE));
  }
  return out;
}

// The `/embeddings` sibling of whatever path the operator configured, with the query and fragment
// carried over. A base URL that does not parse is handed to the SSRF guard as it stands, so the
// refusal is the guard's own "invalid URL" rather than a TypeError reduced to "provider error".
function compatibleEndpoint(baseURL: string): string {
  try {
    const u = new URL(baseURL);
    u.pathname = `${u.pathname.replace(/\/+$/, "")}/embeddings`;
    return u.toString();
  } catch {
    return baseURL;
  }
}

// The attempt's deadline over EVERYTHING the attempt awaits: the SSRF host check before the fetch,
// and the error body the OpenAI SDK reads after clearing its own timer. At the deadline the signal is
// aborted, closing the request and any body read, and a host check that answers late sends nothing.
// The abandoned work's rejection is swallowed so it cannot surface as an unhandled one.
async function withinDeadline<T>(
  call: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const work = call(controller.signal);
  work.catch(() => {});
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          const err = Object.assign(new Error("embedding attempt timed out"), {
            name: "TimeoutError",
          });
          controller.abort(err);
          reject(err);
        }, timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

// Each attempt is handed the time it may take. Without a deadline that is the attempt bound alone;
// with one it is whatever the deadline leaves, and an attempt whose pause alone would reach the
// deadline is not started: the last failure is the answer.
async function withTransientRetry<T>(
  call: (signal: AbortSignal) => Promise<T>,
  retryStatusless: boolean,
  budget: { attemptMs: number; deadlineMs?: number },
  onRetry?: (err: unknown) => void,
): Promise<T> {
  const startedAt = Date.now();
  for (let attempt = 0; ; attempt++) {
    const left =
      budget.deadlineMs === undefined
        ? Number.POSITIVE_INFINITY
        : budget.deadlineMs - (Date.now() - startedAt);
    try {
      return await withinDeadline(call, Math.min(budget.attemptMs, left));
    } catch (err) {
      const delay = COMPATIBLE_RETRY_DELAYS_MS[attempt];
      if (delay === undefined || !isTransient(err, retryStatusless)) throw err;
      if (
        budget.deadlineMs !== undefined &&
        Date.now() - startedAt + delay >= budget.deadlineMs
      )
        throw err;
      onRetry?.(err);
      await Bun.sleep(delay);
    }
  }
}

// The column is `vector(1536)` and nothing records which model produced a stored vector, yet the
// vault entry's `baseUrl` decides which model answers, so the width has to be asserted here, where an
// endpoint can be named as the reason (`toVectorLiteral` only catches it inside the publish). Outside
// `throughProvider` because this is our reading, not the server's words. A different model at the
// SAME width (ada-002) still passes: nothing in the response identifies the model reliably.
function assertWidth(vec: number[], cfg: EmbeddingConfig): number[] {
  if (vec.length !== EMBEDDING_DIM) {
    throw new Error(
      `embedding endpoint returned ${vec.length} dimensions for model "${cfg.model}", but the index column is ${EMBEDDING_DIM} wide`,
    );
  }
  return vec;
}

// An SSRF refusal is OURS: nothing was sent, and the operator has a configuration to fix. Left to
// the boundary it is dressed as `HTTP 400` — `SsrfError` extends `AppError`, which carries that
// status, and `providerFailure` reads exactly that field — which tells the operator the endpoint
// answered. Unwrapped from `cause`, where `asProviderFailure` parks the original, so the guard's own
// sentence and its i18n code survive. Same principle as `assertWidth`: what WE concluded is not
// reduced to the vocabulary reserved for what a server wrote.
function unwrapOurOwn(err: unknown): never {
  const cause = (err as { cause?: unknown })?.cause;
  if (cause instanceof SsrfError) throw cause;
  throw err;
}

export async function embedTexts(
  texts: string[],
  cfg: EmbeddingConfig,
  deps: EmbeddingDeps = {},
): Promise<number[][]> {
  if (texts.length === 0) return [];
  const baseURL = cfg.baseURL;
  if (!baseURL) {
    const vectors = await throughProvider(() =>
      client(cfg, deps).embedDocuments(texts),
    );
    return vectors.map((v) => assertWidth(v, cfg));
  }
  const out: number[][] = [];
  // The loop lives HERE rather than inside one `throughProvider`, so the width is asserted after
  // EACH batch: a document past 512 chunks whose first response already proves the endpoint serves a
  // 768-wide model stops there instead of paying for the rest of it. It also keeps `assertWidth`
  // outside the boundary, where its own sentence survives instead of being reduced to the closed
  // vocabulary — which is the whole reason it is not left to `toVectorLiteral`.
  for (const batch of batchesOf(texts)) {
    const vectors = await throughProvider(() =>
      withTransientRetry(
        (signal) =>
          embedCompatibleBatch(batch, { ...cfg, baseURL }, deps, signal),
        true,
        { attemptMs: EMBEDDING_TIMEOUT_MS },
      ),
    ).catch(unwrapOurOwn);
    for (const v of vectors) out.push(assertWidth(v, cfg));
  }
  return out;
}

export async function embedQuery(
  text: string,
  cfg: EmbeddingConfig,
  deps: EmbeddingDeps = {},
): Promise<number[]> {
  const baseURL = cfg.baseURL;
  // One loop for both paths, so the SDK path is held to the same two deadlines; retrying inside
  // LangChain would leave neither ours to set.
  const vector = await throughProvider(() =>
    withTransientRetry(
      async (signal) => {
        if (baseURL) {
          const vectors = await embedCompatibleBatch(
            [text],
            { ...cfg, baseURL },
            deps,
            signal,
          );
          return vectors[0] as number[];
        }
        return client(cfg, deps, { signal }).embedQuery(text);
      },
      false,
      deps.queryBudget ?? QUERY_BUDGET,
      deps.onRetry,
    ),
  ).catch(unwrapOurOwn);
  return assertWidth(vector, cfg);
}
