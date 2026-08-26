// Image/document extraction provider abstraction (the vision mirror of stt/providers). Each provider
// turns a file (image or PDF) + an instruction into extracted text. Adding a provider = one function
// + one registry entry. The key never lands in the URL or logs.

export type VisionKind = "image" | "document";

export interface VisionRequest {
  bytes: ArrayBuffer;
  mimeType: string; // resolved (image/* or application/pdf)
  kind: VisionKind;
  prompt: string;
  model: string; // already resolved (provider default applied by the caller)
  apiKey: string;
  baseURL: string | null;
  fetchImpl: typeof fetch;
  // This attempt's deadline, decided by the caller (see ./retry). It is per-ATTEMPT and not a
  // constant here on purpose: the caller owns the total, so it can spend what is left of it rather
  // than granting every attempt the whole ceiling.
  timeoutMs: number;
}

// What a vision call cost, in the provider's own numbers. Every one of the three endpoints below
// returns this alongside the text; the contract used to be `Promise<string>`, which made it
// unrepresentable, so it was parsed away and the spend reached no ledger (issue #316). Optional
// because an endpoint may omit the block, and an absent count must not be recorded as zero spend.
export interface VisionUsage {
  promptTokens: number;
  completionTokens: number;
  // Cached input: a discounted SUBSET of promptTokens, never additive. Same contract as
  // `TokenUsage` in graph/usage.ts, because the two paths answer the same question and a reader
  // summing both must not have to know which one wrote the row.
  cachedReadTokens: number;
  cacheCreationTokens: number;
}

export interface VisionResult {
  text: string;
  usage: VisionUsage | null;
}

export interface VisionProvider {
  defaultModel: string;
  extract(req: VisionRequest): Promise<VisionResult>;
}

function num(v: unknown): number {
  const n = Number(v ?? 0);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

// A usage block is only reported when the endpoint actually sent counts. Returning zeros for a
// missing block would write a row saying the call was free.
//
// The cached counters are what separate "carried the pair" from "carried what was billed": a cached
// prompt is charged at a discount, so a row that reports the whole prompt as fresh input overstates
// the spend it exists to measure.
function usageOf(u: {
  prompt: unknown;
  completion: unknown;
  cachedRead?: unknown;
  cacheCreation?: unknown;
  // Whether `prompt` already contains the cached counts. OpenAI and Gemini report a prompt total
  // that includes them; Anthropic reports only what fell outside the cache, and its own docs give
  // the total as cache_read + cache_creation + input_tokens. Reading one like the other undercounts
  // every cached call on that provider, and the row would carry subsets larger than the whole.
  promptExcludesCached?: boolean;
}): VisionUsage | null {
  const cachedReadTokens = num(u.cachedRead);
  const cacheCreationTokens = num(u.cacheCreation);
  const promptTokens = u.promptExcludesCached
    ? num(u.prompt) + cachedReadTokens + cacheCreationTokens
    : num(u.prompt);
  const completionTokens = num(u.completion);
  if (promptTokens === 0 && completionTokens === 0) return null;
  return {
    promptTokens,
    completionTokens,
    cachedReadTokens,
    cacheCreationTokens,
  };
}

export class VisionError extends Error {
  constructor(
    readonly provider: string,
    readonly status: number,
  ) {
    // NOTE: never capture the response body — it carries the extracted content (potential PII).
    super(`vision ${provider} failed with ${status}`);
    this.name = "VisionError";
  }
}

function base64(bytes: ArrayBuffer): string {
  return Buffer.from(bytes).toString("base64");
}

// The file a chat-completions request carries, as the endpoint spells it. An image goes in an
// `image_url` part and a PDF in a `file` part, and the endpoint refuses each in the other's place —
// measured live against gpt-4o (2026-08-26): a PDF sent as `image_url` answers 400 "Invalid MIME
// type. Only image types are supported.", and an image sent as a `file` part answers 400
// "unsupported MIME type 'image/png'". So this is decided per REQUEST, the way anthropicExtract
// already decides between its document and image blocks.
function chatContentPart(req: VisionRequest): Record<string, unknown> {
  if (req.kind !== "document")
    return {
      type: "image_url",
      image_url: { url: `data:${req.mimeType};base64,${base64(req.bytes)}` },
    };
  return {
    type: "file",
    file: {
      // Required: with no `filename` the endpoint reads the part as a file-id reference and answers
      // "Missing required parameter: ... file.file_id". Nothing reads the name back — the type comes
      // from the data URL below — so it is a label, not the attachment's own name (which this layer
      // does not receive).
      filename: "document.pdf",
      // `application/pdf` and not `req.mimeType`: visionKindForMime classifies any `*/pdf` as a
      // document (`application/x-pdf` is served by real uploaders), and this part accepts one
      // spelling, by name — "Expected a base64-encoded data URL with an application/pdf MIME type".
      // The `data:` prefix is required too; without it the endpoint rejects the value by name.
      file_data: `data:application/pdf;base64,${base64(req.bytes)}`,
    },
  };
}

// Shared OpenAI-compatible chat-completions vision call. Used by `openai`, `openrouter` and
// `openai-compatible` (the same chat-completions shape at a different base URL, mirroring
// src/graph/models.ts's createChatModel). Whether a document ever reaches it is decided before the
// call by `visionAcceptsDocuments` (./document-support), per provider AND per endpoint: the three
// share this request shape, and only one of them is known to answer the `file` part.
async function chatCompletionsExtract(
  req: VisionRequest,
  providerName: string,
  defaultBase: string,
): Promise<VisionResult> {
  const base = (req.baseURL ?? defaultBase).replace(/\/+$/, "");
  const body = {
    model: req.model,
    messages: [
      {
        role: "user",
        content: [{ type: "text", text: req.prompt }, chatContentPart(req)],
      },
    ],
  };
  const res = await req.fetchImpl(`${base}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${req.apiKey}`,
    },
    body: JSON.stringify(body),
    redirect: "error",
    signal: AbortSignal.timeout(req.timeoutMs),
  });
  if (!res.ok) throw new VisionError(providerName, res.status);
  const json = (await res.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
    usage?: {
      prompt_tokens?: number;
      completion_tokens?: number;
      prompt_tokens_details?: { cached_tokens?: number };
    };
  };
  return {
    text: (json.choices?.[0]?.message?.content ?? "").trim(),
    usage: usageOf({
      prompt: json.usage?.prompt_tokens,
      completion: json.usage?.completion_tokens,
      // NOTE: `completion_tokens_details.reasoning_tokens` is NOT read here on purpose: OpenAI
      // counts reasoning INSIDE completion_tokens, so adding it would bill the same tokens twice.
      // Gemini is the opposite case, and is handled as such below.
      cachedRead: json.usage?.prompt_tokens_details?.cached_tokens,
    }),
  };
}

async function openaiExtract(req: VisionRequest): Promise<VisionResult> {
  return chatCompletionsExtract(req, "openai", "https://api.openai.com/v1");
}

async function openrouterExtract(req: VisionRequest): Promise<VisionResult> {
  return chatCompletionsExtract(
    req,
    "openrouter",
    "https://openrouter.ai/api/v1",
  );
}

// Self-hosted / third-party OpenAI-compatible vision endpoint (e.g. a Qwen-VL server). The base URL is
// REQUIRED (there is no canonical default); the model id is whatever the endpoint serves. What it
// accepts is the registry's call below, not this function's: the request shape is the same one
// `openai` uses, and only that provider is known to answer it for documents.
async function openaiCompatibleExtract(
  req: VisionRequest,
): Promise<VisionResult> {
  if (!req.baseURL) throw new VisionError("openai-compatible", 400);
  return chatCompletionsExtract(req, "openai-compatible", req.baseURL);
}

// Google Gemini generateContent with the file inlined as base64. Handles images AND PDFs.
async function geminiExtract(req: VisionRequest): Promise<VisionResult> {
  const base = (
    req.baseURL ?? "https://generativelanguage.googleapis.com/v1beta"
  ).replace(/\/+$/, "");
  const body = {
    contents: [
      {
        role: "user",
        parts: [
          { text: req.prompt },
          { inline_data: { mime_type: req.mimeType, data: base64(req.bytes) } },
        ],
      },
    ],
  };
  const res = await req.fetchImpl(
    `${base}/models/${encodeURIComponent(req.model)}:generateContent`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-goog-api-key": req.apiKey,
      },
      body: JSON.stringify(body),
      redirect: "error",
      signal: AbortSignal.timeout(req.timeoutMs),
    },
  );
  if (!res.ok) throw new VisionError("gemini", res.status);
  const json = (await res.json()) as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
    usageMetadata?: {
      promptTokenCount?: number;
      candidatesTokenCount?: number;
      thoughtsTokenCount?: number;
      cachedContentTokenCount?: number;
    };
  };
  const parts = json.candidates?.[0]?.content?.parts ?? [];
  return {
    text: parts
      .map((p) => p.text ?? "")
      .join("")
      .trim(),
    usage: usageOf({
      prompt: json.usageMetadata?.promptTokenCount,
      // Thinking tokens are billed output and are NOT part of candidatesTokenCount: the API
      // reference defines totalTokenCount as "prompt + thoughts + response candidates", so a
      // thinking model's reply would otherwise be recorded at a fraction of what it cost.
      completion:
        num(json.usageMetadata?.candidatesTokenCount) +
        num(json.usageMetadata?.thoughtsTokenCount),
      // promptTokenCount already INCLUDES the cached part ("the total effective prompt size"), so
      // this is the discounted subset and never an addition.
      cachedRead: json.usageMetadata?.cachedContentTokenCount,
    }),
  };
}

// Anthropic messages API. Images use an `image` content block; PDFs use a `document` block.
async function anthropicExtract(req: VisionRequest): Promise<VisionResult> {
  const base = (req.baseURL ?? "https://api.anthropic.com/v1").replace(
    /\/+$/,
    "",
  );
  const source = {
    type: "base64" as const,
    media_type: req.mimeType,
    data: base64(req.bytes),
  };
  const fileBlock =
    req.kind === "document"
      ? { type: "document", source }
      : { type: "image", source };
  const body = {
    model: req.model,
    max_tokens: 2048,
    messages: [
      {
        role: "user",
        content: [fileBlock, { type: "text", text: req.prompt }],
      },
    ],
  };
  const res = await req.fetchImpl(`${base}/messages`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": req.apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify(body),
    redirect: "error",
    signal: AbortSignal.timeout(req.timeoutMs),
  });
  if (!res.ok) throw new VisionError("anthropic", res.status);
  const json = (await res.json()) as {
    content?: Array<{ type?: string; text?: string }>;
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      cache_read_input_tokens?: number;
      cache_creation_input_tokens?: number;
    };
  };
  return {
    text: (json.content ?? [])
      .map((c) => (c.type === "text" ? (c.text ?? "") : ""))
      .join("")
      .trim(),
    usage: usageOf({
      prompt: json.usage?.input_tokens,
      completion: json.usage?.output_tokens,
      cachedRead: json.usage?.cache_read_input_tokens,
      cacheCreation: json.usage?.cache_creation_input_tokens,
      promptExcludesCached: true,
    }),
  };
}

const PROVIDERS: Record<string, VisionProvider> = {
  openai: {
    defaultModel: "gpt-4o",
    extract: openaiExtract,
  },
  gemini: {
    defaultModel: "gemini-3.5-flash",
    extract: geminiExtract,
  },
  anthropic: {
    defaultModel: "claude-sonnet-4-6",
    extract: anthropicExtract,
  },
  openrouter: {
    // Vendor-prefixed OpenRouter model id. A router in front of many vendors, so whether a `file`
    // part is understood depends on the model behind the id — and OpenRouter charges PDF parsing as
    // its own plugin. `./document-support` is where that answer lives, for every provider.
    defaultModel: "openai/gpt-4o",
    extract: openrouterExtract,
  },
  "openai-compatible": {
    // Base URL required + model is whatever the endpoint serves, so no default model.
    defaultModel: "",
    extract: openaiCompatibleExtract,
  },
};

// FROZEN because it is exported and shared: `sort`, `push` and friends mutate in place, so one
// caller tidying this list reorders it for every other holder in the process. A test did exactly
// that (`VISION_PROVIDER_NAMES.sort()`), and the damage landed in an unrelated file that
// compares the published MCP enum against this array. Frozen, that write throws where it is made.
export const VISION_PROVIDER_NAMES = Object.freeze(Object.keys(PROVIDERS));

export function getVisionProvider(name: string): VisionProvider | null {
  return PROVIDERS[name] ?? null;
}

// Image subtypes vision LLMs don't accept as raster input (vector/markup) — treat as unextractable
// instead of sending them to the provider only to be rejected.
const UNSUPPORTED_IMAGE_SUBTYPES = new Set(["svg+xml", "svg"]);

// Classifies a downloaded file's mime into the extraction kind, or null when unextractable.
export function visionKindForMime(mimeType: string | null): VisionKind | null {
  const m = (mimeType ?? "").toLowerCase();
  if (m.startsWith("image/")) {
    const subtype = m.slice("image/".length).split(";")[0]?.trim() ?? "";
    return UNSUPPORTED_IMAGE_SUBTYPES.has(subtype) ? null : "image";
  }
  if (m === "application/pdf" || m.endsWith("/pdf")) return "document";
  return null;
}
