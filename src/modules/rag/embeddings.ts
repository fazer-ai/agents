import { OpenAIEmbeddings } from "@langchain/openai";
import {
  isTransientProviderStatus,
  providerFailure,
  statusOf,
  throughProvider,
} from "@/lib/provider-failure";
import { assertSafeOutboundUrl } from "@/lib/ssrf";
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
}

const EMBEDDING_TIMEOUT_MS = 60_000;

// The same bound `@langchain/openai` applies on the SDK path (`batchSize = 512`). It is here because
// `embedTexts` is handed EVERY chunk of a document at once (`documents.ts`), which has no size cap:
// one unbounded POST is a 400/413 on a self-hosted server, which is precisely the deployment this
// path exists to serve. Sequential rather than langchain's `Promise.all`, for the same reason —
// a single-GPU endpoint is not helped by twenty simultaneous requests.
const COMPATIBLE_BATCH_SIZE = 512;

// WHAT THE SDK PATH WAS ALREADY DOING, AND WHY DROPPING IT COSTS MORE HERE THAN ELSEWHERE.
//
// `@langchain/openai` sets the OpenAI client's own `maxRetries` to 0 and wraps every call in
// `AsyncCaller`, whose default is SIX retries — so this path started out with none where the one it
// replaces had six. And an ingest failure is terminal: the document lands in FAILED and only a
// manual reindex moves it, which is a worse outcome than any single 503 deserves.
//
// Three attempts rather than six, because the same function serves `embedQuery` inside a live turn,
// where every extra attempt is a customer waiting; three with these delays is still strictly more
// patient than the zero this path shipped with, and strictly less than the six a 600s-default SDK
// timeout could stretch out on main today.
const COMPATIBLE_RETRY_DELAYS_MS = [500, 2000];

// WHAT COUNTS AS WORTH ASKING AGAIN, and it is not one answer for both callers — the same split
// `provider-failure` describes, where the set of transient STATUSES is shared and the policy over it
// belongs to the call site.
//
// A failure with no status at all is the case that divides them. `AsyncCaller` retried it (its
// `STATUS_NO_RETRY` list is statuses, so a connection reset falls through to a retry), and it is
// just as often a base URL that will never resolve. `modules/vision/retry` excludes it deliberately,
// because a customer is waiting on that turn and the operator needs a bad endpoint to fail on the
// first attempt. Both readings are right, for different callers:
//
//   embedTexts — the INGEST. Nobody is waiting, and the failure is terminal: the document lands in
//   FAILED and only a manual reindex moves it. A reset costs the document, so it is asked again.
//   embedQuery — a live TURN, where the retry is time a customer spends waiting for a search that
//   the turn can proceed without.
//
// A response we could not use (wrong count, unusable indexes, a vector that is not numbers) is never
// retried on either: the endpoint answered, and it will answer the same way again.
function isTransient(err: unknown, retryStatusless: boolean): boolean {
  if (err instanceof UnusableResponseError) return false;
  if (providerFailure(err) === "timeout") return true;
  const status = statusOf(err);
  if (status === null) return retryStatusless;
  return isTransientProviderStatus(status);
}

// A response that arrived and cannot be used. Its own class so the retry policy can tell it from a
// transport failure, which otherwise looks identical: neither carries a status.
class UnusableResponseError extends Error {}

function client(cfg: EmbeddingConfig, deps: EmbeddingDeps): OpenAIEmbeddings {
  const configuration = {
    ...(cfg.baseURL ? { baseURL: cfg.baseURL } : {}),
    // Only when injected: undefined here would still be a key the SDK sees, and the point is that
    // production keeps the global fetch. It exists so a test can assert what this path SENDS —
    // which is the reason the compatible path below exists at all: with no `encoding_format` of its
    // own the SDK adds `base64`, and a good many self-hosted servers answer that with a 400.
    ...(deps.fetchImpl ? { fetch: deps.fetchImpl } : {}),
  };
  return new OpenAIEmbeddings({
    model: cfg.model,
    apiKey: cfg.apiKey,
    ...(Object.keys(configuration).length ? { configuration } : {}),
  });
}

// The error a non-2xx compatible response becomes, shaped so that BOTH halves of the boundary keep
// working. `providerFailure` takes the status from a numeric `status`/`statusCode` property and
// never parses the message, so a status baked into the text alone is thrown away and every 401, 404
// and 429 reaches the operator as the opaque "provider error". And `asProviderFailure` keeps this
// error as `cause` for the process log, which is where the vendor's own words are RELOCATED to
// rather than deleted (`provider-failure.ts`, `docs/logs.md`) — so the body has to be in here, or a
// wrong model id and a malformed request are undiagnosable anywhere. The SDK path builds its
// message out of the response body for exactly this reason; this one has to do it by hand.
//
// The body may quote what was embedded, which is the customer's question or their document. That is
// precisely why it lives on this error and never on the one that replaces it: the message the four
// operator-facing stores read is "HTTP <status>", authored here.
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
  cfg: EmbeddingConfig,
  url: string,
  fetchImpl: typeof fetch,
): Promise<number[][]> {
  const res = await fetchImpl(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${cfg.apiKey}`,
    },
    body: JSON.stringify({ model: cfg.model, input: texts }),
    redirect: "error",
    signal: AbortSignal.timeout(EMBEDDING_TIMEOUT_MS),
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
    ...((data ?? []) as Array<{ index?: number; embedding?: unknown }>),
  ];
  if (items.length !== texts.length) {
    throw new UnusableResponseError(
      "embedding provider returned the wrong vector count",
    );
  }
  // Two acceptable shapes and nothing between them: NO item carries an index, or every one does and
  // they form exactly 0..n-1.
  //
  // The empty case is the SDK path's own assumption — it reads the array positionally — so response
  // order is the fallback that has always been in use here. A PARTIAL set is not that: one item
  // saying `index: 1` is the provider stating that position is not the order, and reading the array
  // positionally anyway publishes `[b, a]` for `[{index:1,b},{a}]`. And a full set that is not a
  // permutation (a duplicate, a 1.5, a 9 among two inputs) sorts into SOMETHING and sails past the
  // count check above. Neither leaves an order to recover, so both are refused rather than guessed —
  // the cost of guessing is a document published with every vector against the wrong chunk.
  const indexed = items.filter((i) => typeof i.index === "number").length;
  if (indexed > 0) {
    const indexes = items.map((i) => i.index as number);
    const usable =
      indexed === items.length &&
      new Set(indexes).size === indexes.length &&
      indexes.every((n) => Number.isInteger(n) && n >= 0 && n < items.length);
    if (!usable) {
      throw new UnusableResponseError(
        "embedding provider returned an unusable index set",
      );
    }
    items.sort((a, b) => (a.index as number) - (b.index as number));
  }
  return items.map((item) => {
    if (
      !Array.isArray(item.embedding) ||
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

async function withTransientRetry<T>(
  call: () => Promise<T>,
  retryStatusless: boolean,
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await call();
    } catch (err) {
      const delay = COMPATIBLE_RETRY_DELAYS_MS[attempt];
      if (delay === undefined || !isTransient(err, retryStatusless)) throw err;
      await Bun.sleep(delay);
    }
  }
}

// WHY THIS IS CHECKED HERE AND NOT ONLY AT INSERT TIME.
//
// `updateEmbeddingSettings` pins provider, model and baseURL to EMBEDDING_DEFAULTS and honors only
// the credential, because the column is `vector(1536)` and nothing records which model produced a
// stored vector. Carrying the vault entry's `baseUrl` moves the endpoint choice into the one field
// that survives that lock, and the endpoint is what decides which model actually answers. So the
// width stops being guaranteed by construction and has to be asserted.
//
// Outside `throughProvider` on purpose: this is OUR reading of the response, not something the
// server wrote, so it is not reduced to the closed vocabulary. `toVectorLiteral` catches the same
// thing, but only once ingestion is already inside the publish transaction, and it cannot say that
// an endpoint is the reason.
//
// It does NOT close the case of a different model at the SAME width (text-embedding-ada-002 is also
// 1536): nothing in the response identifies the model reliably — llama.cpp answers with the loaded
// file's path — so a same-width swap silently degrades retrieval until flexible embeddings ships.
function assertWidth(vec: number[], cfg: EmbeddingConfig): number[] {
  if (vec.length !== EMBEDDING_DIM) {
    throw new Error(
      `embedding endpoint returned ${vec.length} dimensions for model "${cfg.model}", but the index column is ${EMBEDDING_DIM} wide`,
    );
  }
  return vec;
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
  const url = await throughProvider(() => compatibleTarget(baseURL, deps));
  const fetchImpl = deps.fetchImpl ?? fetch;
  const out: number[][] = [];
  // The loop lives HERE rather than inside one `throughProvider`, so the width is asserted after
  // EACH batch: a document past 512 chunks whose first response already proves the endpoint serves a
  // 768-wide model stops there instead of paying for the rest of it. It also keeps `assertWidth`
  // outside the boundary, where its own sentence survives instead of being reduced to the closed
  // vocabulary — which is the whole reason it is not left to `toVectorLiteral`.
  for (const batch of batchesOf(texts)) {
    const vectors = await throughProvider(() =>
      withTransientRetry(
        () => embedCompatibleBatch(batch, cfg, url, fetchImpl),
        true,
      ),
    );
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
  const vector = await throughProvider(async () => {
    if (baseURL) {
      const url = await compatibleTarget(baseURL, deps);
      const vectors = await withTransientRetry(
        () => embedCompatibleBatch([text], cfg, url, deps.fetchImpl ?? fetch),
        false,
      );
      return vectors[0] as number[];
    }
    return client(cfg, deps).embedQuery(text);
  });
  return assertWidth(vector, cfg);
}
