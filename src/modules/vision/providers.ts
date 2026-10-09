// Image/document extraction provider abstraction (the vision mirror of stt/providers). Each provider
// turns a file (image or PDF) + an instruction into extracted text. Adding a provider = one function
// + one registry entry. The key never lands in the URL or logs.

import logger from "@/api/lib/logger";
import { clipText } from "@/lib/text";
import { reportedCostFromUsage } from "@/modules/pricing/reported";
import { mediaSubtype, normalizeMediaType } from "./media-conversion";
export type VisionKind = "image" | "document";

import {
  ANTHROPIC_VISION_DEFAULT_MAX_TOKENS,
  type VisionReasoningEffort,
} from "./output-limits";

export {
  ANTHROPIC_VISION_DEFAULT_MAX_TOKENS,
  VISION_MAX_OUTPUT_TOKENS_CAP,
  VISION_REASONING_EFFORTS,
  type VisionReasoningEffort,
} from "./output-limits";

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
  // From `settings.vision`, already validated by the reader. Absent or null = not configured, and the
  // request carries no field for it (anthropic's required `max_tokens` takes its default).
  maxOutputTokens?: number | null;
  reasoningEffort?: VisionReasoningEffort | null;
}

// What a vision call cost, in the provider's own numbers, returned alongside the text by every
// endpoint below. Optional because an endpoint may omit the block, and an absent count must not be
// recorded as zero spend.
export interface VisionUsage {
  promptTokens: number;
  completionTokens: number;
  // Cached input: a discounted SUBSET of promptTokens, never additive. Same contract as
  // `TokenUsage` in graph/usage.ts, because the two paths answer the same question and a reader
  // summing both must not have to know which one wrote the row.
  cachedReadTokens: number;
  cacheCreationTokens: number;
  // What the provider said the call cost, when it did (OpenRouter's `usage.cost`).
  reportedCostUsd?: number | null;
}

export interface VisionResult {
  text: string;
  usage: VisionUsage | null;
  // The provider stopped at the output ceiling (`max_tokens`, `length`, `MAX_TOKENS`): the text is
  // what was read before the cut, and the reply does not say so anywhere else.
  // Absent reads as false, for a provider that has no stop signal to report.
  truncated?: boolean;
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
    // The provider's own `error.message` on a failed response (see readProviderMessage), kept for
    // whoever holds the error object and NEVER put in `.message`: the server chose those words, so
    // they may quote the customer's content, and `.message` reaches execution_logs, alerts and the
    // conversation's private note (docs/logs.md, the provider boundary).
    readonly providerMessage: string | null = null,
  ) {
    const refusal = refusalOf(providerMessage);
    super(
      `vision ${provider} failed with ${status}${refusal ? ` (${refusal})` : ""}`,
    );
    this.name = "VisionError";
  }
}

// The refusals a provider states about the file we sent, named in OUR words. A predicate over the
// provider's text only chooses among these constants, so nothing it wrote crosses into `.message`;
// an unrecognised refusal stays a bare status, and its words are in the process log.
const REFUSALS: ReadonlyArray<readonly [RegExp, string]> = [
  [
    /dimensions? exceeds? max allowed size/i,
    "image dimensions exceed max allowed size",
  ],
  [/image exceeds .*maximum/i, "image bytes exceed max allowed size"],
];

function refusalOf(providerMessage: string | null): string | null {
  if (!providerMessage) return null;
  for (const [pattern, refusal] of REFUSALS)
    if (pattern.test(providerMessage)) return refusal;
  return null;
}

// How much of a failed body is read (the rest is cancelled, so an enormous one costs nothing) and
// how much of the message is kept on the line.
const MAX_ERROR_BODY = 16_384;
const MAX_PROVIDER_MESSAGE = 300;

// The `error.message` every vendor here nests the same way (Anthropic, OpenAI, Gemini). Read off the
// prefix and not only through JSON.parse, because a body cut at the read cap is no longer JSON and
// its message is still the first thing in it. Anything that is not that field is dropped: an HTML
// error page or a proxy's prose says nothing the status does not.
async function readProviderMessage(res: Response): Promise<string | null> {
  try {
    if (!res.body) return null;
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let text = "";
    while (text.length < MAX_ERROR_BODY) {
      const { done, value } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
    }
    await reader.cancel().catch(() => {});
    const raw = /"message"\s*:\s*"((?:[^"\\]|\\.)*)/.exec(text)?.[1];
    if (!raw) return null;
    let message: string;
    try {
      message = JSON.parse(`"${raw}"`) as string;
    } catch {
      message = raw;
    }
    message = message.replace(/\s+/g, " ").trim();
    return message ? clipText(message, MAX_PROVIDER_MESSAGE) : null;
  } catch {
    return null;
  }
}

// The provider's words go to the process log, which makes no PII promise and is the only place a
// refusal outside REFUSALS is explained.
async function failure(provider: string, res: Response): Promise<VisionError> {
  const providerMessage = await readProviderMessage(res);
  if (providerMessage)
    logger.warn(
      { provider, status: res.status, providerMessage },
      "vision provider refused the request",
    );
  return new VisionError(provider, res.status, providerMessage);
}

function base64(bytes: ArrayBuffer): string {
  return Buffer.from(bytes).toString("base64");
}

// The file a chat-completions request carries, as the endpoint spells it. An image goes in an
// `image_url` part and a PDF in a `file` part, and the endpoint answers 400 to each in the other's
// place. So this is decided per REQUEST, the way anthropicExtract decides between its document and
// image blocks.
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
  const body: Record<string, unknown> = {
    model: req.model,
    messages: [
      {
        role: "user",
        content: [{ type: "text", text: req.prompt }, chatContentPart(req)],
      },
    ],
  };
  // NOTE: Each key only when configured, so an agent that set neither sends today's body.
  // OpenAI's own endpoint refuses `max_tokens` on its reasoning models and asks for
  // `max_completion_tokens`; OpenRouter and self-hosted servers are only known to read the older
  // spelling. The call carries no tools, which is what lets chat completions take `reasoning_effort`.
  if (req.maxOutputTokens != null)
    body[providerName === "openai" ? "max_completion_tokens" : "max_tokens"] =
      req.maxOutputTokens;
  if (req.reasoningEffort != null) body.reasoning_effort = req.reasoningEffort;
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
  if (!res.ok) throw await failure(providerName, res);
  const json = (await res.json()) as {
    choices?: Array<{
      message?: { content?: string };
      finish_reason?: string | null;
    }>;
    usage?: {
      prompt_tokens?: number;
      completion_tokens?: number;
      prompt_tokens_details?: { cached_tokens?: number };
    };
  };
  const usage = usageOf({
    prompt: json.usage?.prompt_tokens,
    completion: json.usage?.completion_tokens,
    // NOTE: `completion_tokens_details.reasoning_tokens` is NOT read here on purpose: OpenAI
    // counts reasoning INSIDE completion_tokens, so adding it would bill the same tokens twice.
    // Gemini is the opposite case, and is handled as such below.
    cachedRead: json.usage?.prompt_tokens_details?.cached_tokens,
  });
  const reported = reportedCostFromUsage(providerName, json.usage);
  return {
    text: (json.choices?.[0]?.message?.content ?? "").trim(),
    usage:
      usage && reported != null
        ? { ...usage, reportedCostUsd: reported }
        : usage,
    truncated: json.choices?.[0]?.finish_reason === "length",
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
  const body: Record<string, unknown> = {
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
  // NOTE: `reasoningEffort` is not mapped here: Gemini's thinking levels are a different scale per
  // model family, and a guessed translation would be a setting that silently means something else.
  if (req.maxOutputTokens != null)
    body.generationConfig = { maxOutputTokens: req.maxOutputTokens };
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
  if (!res.ok) throw await failure("gemini", res);
  const json = (await res.json()) as {
    candidates?: Array<{
      content?: { parts?: Array<{ text?: string }> };
      finishReason?: string;
    }>;
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
    truncated: json.candidates?.[0]?.finishReason === "MAX_TOKENS",
  };
}

// The lowest reasoning each Claude family accepts, for `reasoningEffort: "none"`. The API answers 400
// to the wrong spelling, and a refused call leaves the attachment unread, so the family decides:
// Sonnet 5.5 refuses `disabled` and takes `between_tools` (thinking only between tool calls, and a
// vision call has none); Opus 5.5 and Fable 5/5.1 refuse both and cannot turn thinking off at all, so
// they get the lowest effort instead; every other model takes `disabled`.
export function anthropicThinkingOff(model: string): Record<string, unknown> {
  const m = model.toLowerCase();
  if (m.startsWith("claude-sonnet-5-5"))
    return { thinking: { type: "between_tools" } };
  if (m.startsWith("claude-opus-5-5") || m.startsWith("claude-fable-5"))
    return { output_config: { effort: "low" } };
  return { thinking: { type: "disabled" } };
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
  const body: Record<string, unknown> = {
    model: req.model,
    max_tokens: req.maxOutputTokens ?? ANTHROPIC_VISION_DEFAULT_MAX_TOKENS,
    messages: [
      {
        role: "user",
        content: [fileBlock, { type: "text", text: req.prompt }],
      },
    ],
  };
  // NOTE: Current Claude models think adaptively by default, and the effort is what bounds it.
  // `none` is the switch instead of a level, and each model spells "off" differently (see
  // anthropicThinkingOff). Unset sends neither key.
  if (req.reasoningEffort === "none")
    Object.assign(body, anthropicThinkingOff(req.model));
  else if (req.reasoningEffort != null)
    body.output_config = { effort: req.reasoningEffort };
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
  if (!res.ok) throw await failure("anthropic", res);
  const json = (await res.json()) as {
    content?: Array<{ type?: string; text?: string }>;
    stop_reason?: string | null;
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
    truncated: json.stop_reason === "max_tokens",
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
//
// Normalised through `./media-conversion`, the ONE parser: Chatwoot serves whatever content type the
// uploader's server declared, so a parameter (`application/pdf; charset=binary`) must not make a
// document unextractable.
export function visionKindForMime(mimeType: string | null): VisionKind | null {
  const m = normalizeMediaType(mimeType);
  if (m.startsWith("image/")) {
    return UNSUPPORTED_IMAGE_SUBTYPES.has(mediaSubtype(m)) ? null : "image";
  }
  if (m === "application/pdf" || m.endsWith("/pdf")) return "document";
  return null;
}
