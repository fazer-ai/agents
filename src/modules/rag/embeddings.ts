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
// timeout could stretch out on main today. Only the ENDPOINT's momentary state is retried — the
// predicate is `provider-failure`'s, so a 401 or a 404 answers the same way every time and is not
// asked twice.
const COMPATIBLE_RETRY_DELAYS_MS = [500, 2000];

function isTransient(err: unknown): boolean {
  if (providerFailure(err) === "timeout") return true;
  const status = statusOf(err);
  return status !== null && isTransientProviderStatus(status);
}

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
  const json = (await res.json()) as {
    data?: Array<{ index?: number; embedding?: unknown }>;
  };
  const items = [...(json.data ?? [])];
  // Sort by `index` only when EVERY item carries one. The SDK path reads the array positionally, so
  // response order is the fallback that has always been in use; treating a missing index as 0 would
  // instead collapse every item onto the same key and make the order depend on the sort's tie
  // handling, which is a worse answer than the one we already trusted.
  if (items.every((i) => typeof i.index === "number")) {
    items.sort((a, b) => (a.index as number) - (b.index as number));
  }
  if (items.length !== texts.length) {
    throw new Error("embedding provider returned the wrong vector count");
  }
  return items.map((item) => {
    if (
      !Array.isArray(item.embedding) ||
      !item.embedding.every((value) => typeof value === "number")
    ) {
      throw new Error("embedding provider returned an invalid vector");
    }
    return item.embedding as number[];
  });
}

async function embedCompatible(
  texts: string[],
  cfg: EmbeddingConfig & { baseURL: string },
  deps: EmbeddingDeps,
): Promise<number[][]> {
  // Through `URL`, not concatenation: the vault accepts any http(s) URL, and Azure's own spelling
  // carries a query (`…/v1?api-version=2024-02-01`). Appending to that string puts the path INSIDE
  // the query and the POST lands on `/v1`, which a compatible server answers with something that
  // parses far enough to be confusing.
  const endpoint = compatibleEndpoint(cfg.baseURL);
  // SSRF guard on the URL the OPERATOR configured, immediately before the fetch, exactly as the
  // openai-compatible branch of `listProviderModels` does. The vault validates `baseUrl` as http(s)
  // syntax and nothing more, so without this a tenant admin turns knowledge ingestion into a POST at
  // any loopback, RFC1918 or metadata address. `allowHttp` for the same reason the models listing
  // allows it: these endpoints are self-hosted and routinely plain http on a private network.
  const safeUrl = await (deps.assertSafe ?? assertSafeOutboundUrl)(endpoint, {
    allowHttp: true,
  });
  const url = safeUrl.toString();
  const fetchImpl = deps.fetchImpl ?? fetch;
  const out: number[][] = [];
  for (let i = 0; i < texts.length; i += COMPATIBLE_BATCH_SIZE) {
    const batch = texts.slice(i, i + COMPATIBLE_BATCH_SIZE);
    out.push(
      ...(await withTransientRetry(() =>
        embedCompatibleBatch(batch, cfg, url, fetchImpl),
      )),
    );
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

async function withTransientRetry<T>(call: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await call();
    } catch (err) {
      const delay = COMPATIBLE_RETRY_DELAYS_MS[attempt];
      if (delay === undefined || !isTransient(err)) throw err;
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
  const vectors = await throughProvider(() =>
    cfg.baseURL
      ? embedCompatible(texts, { ...cfg, baseURL: cfg.baseURL }, deps)
      : client(cfg, deps).embedDocuments(texts),
  );
  return vectors.map((v) => assertWidth(v, cfg));
}

export async function embedQuery(
  text: string,
  cfg: EmbeddingConfig,
  deps: EmbeddingDeps = {},
): Promise<number[]> {
  const vector = await throughProvider(async () => {
    if (cfg.baseURL) {
      const vectors = await embedCompatible(
        [text],
        { ...cfg, baseURL: cfg.baseURL },
        deps,
      );
      return vectors[0] as number[];
    }
    return client(cfg, deps).embedQuery(text);
  });
  return assertWidth(vector, cfg);
}
