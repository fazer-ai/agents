// Image/document extraction provider abstraction (the vision mirror of stt/providers). Each provider
// turns a file (image or PDF) + an instruction into extracted text. Adding a provider = one function
// + one registry entry. The key never lands in the URL or logs.

const VISION_TIMEOUT_MS = 60_000;

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
}

export interface VisionProvider {
  defaultModel: string;
  // Whether the provider can extract from PDFs (all support images). OpenAI chat vision is
  // image-only; Gemini and Anthropic accept PDF documents inline.
  supportsDocuments: boolean;
  extract(req: VisionRequest): Promise<string>;
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

// Shared OpenAI-compatible chat-completions vision call (image_url data URI). Image-only — used by
// both `openai` and `openrouter` (OpenRouter is the same chat-completions shape at a different base
// URL, mirroring src/graph/models.ts's createChatModel).
async function chatCompletionsExtract(
  req: VisionRequest,
  providerName: string,
  defaultBase: string,
): Promise<string> {
  const base = (req.baseURL ?? defaultBase).replace(/\/+$/, "");
  const dataUri = `data:${req.mimeType};base64,${base64(req.bytes)}`;
  const body = {
    model: req.model,
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: req.prompt },
          { type: "image_url", image_url: { url: dataUri } },
        ],
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
    signal: AbortSignal.timeout(VISION_TIMEOUT_MS),
  });
  if (!res.ok) throw new VisionError(providerName, res.status);
  const json = (await res.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  return (json.choices?.[0]?.message?.content ?? "").trim();
}

async function openaiExtract(req: VisionRequest): Promise<string> {
  return chatCompletionsExtract(req, "openai", "https://api.openai.com/v1");
}

async function openrouterExtract(req: VisionRequest): Promise<string> {
  return chatCompletionsExtract(
    req,
    "openrouter",
    "https://openrouter.ai/api/v1",
  );
}

// Self-hosted / third-party OpenAI-compatible vision endpoint (e.g. a Qwen-VL server). The base URL is
// REQUIRED (there is no canonical default); the model id is whatever the endpoint serves. Image-only
// (chat-completions image_url), mirroring the stt `openai-compatible` provider.
async function openaiCompatibleExtract(req: VisionRequest): Promise<string> {
  if (!req.baseURL) throw new VisionError("openai-compatible", 400);
  return chatCompletionsExtract(req, "openai-compatible", req.baseURL);
}

// Google Gemini generateContent with the file inlined as base64. Handles images AND PDFs.
async function geminiExtract(req: VisionRequest): Promise<string> {
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
      signal: AbortSignal.timeout(VISION_TIMEOUT_MS),
    },
  );
  if (!res.ok) throw new VisionError("gemini", res.status);
  const json = (await res.json()) as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
  };
  const parts = json.candidates?.[0]?.content?.parts ?? [];
  return parts
    .map((p) => p.text ?? "")
    .join("")
    .trim();
}

// Anthropic messages API. Images use an `image` content block; PDFs use a `document` block.
async function anthropicExtract(req: VisionRequest): Promise<string> {
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
    signal: AbortSignal.timeout(VISION_TIMEOUT_MS),
  });
  if (!res.ok) throw new VisionError("anthropic", res.status);
  const json = (await res.json()) as {
    content?: Array<{ type?: string; text?: string }>;
  };
  return (json.content ?? [])
    .map((c) => (c.type === "text" ? (c.text ?? "") : ""))
    .join("")
    .trim();
}

const PROVIDERS: Record<string, VisionProvider> = {
  openai: {
    defaultModel: "gpt-4o",
    supportsDocuments: false,
    extract: openaiExtract,
  },
  gemini: {
    defaultModel: "gemini-3.5-flash",
    supportsDocuments: true,
    extract: geminiExtract,
  },
  anthropic: {
    defaultModel: "claude-sonnet-4-6",
    supportsDocuments: true,
    extract: anthropicExtract,
  },
  openrouter: {
    // Vendor-prefixed OpenRouter model id; chat-completions image_url is image-only (same
    // limitation as the openai adapter it reuses), so no PDF support here.
    defaultModel: "openai/gpt-4o",
    supportsDocuments: false,
    extract: openrouterExtract,
  },
  "openai-compatible": {
    // Base URL required + model is whatever the endpoint serves, so no default model. Image-only.
    defaultModel: "",
    supportsDocuments: false,
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
