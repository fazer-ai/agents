// Prompt caching for the providers that cache only what the request marks (Anthropic, and Claude
// models behind OpenRouter). The marks go on the request BODY, in a fetch wrapper handed to the SDK,
// because the body is where tools, system and history sit in their final rendered order, which is
// what the cache matches on. Three marks, within the API's 4: the last tool, the last system block
// (tools + system, the prefix the agent's conversations share), and the last cacheable block of the
// last message, which moves forward as the conversation grows.

export const PROMPT_CACHE_MODES = ["auto", "off"] as const;
export type PromptCacheMode = (typeof PROMPT_CACHE_MODES)[number];

// Whether the provider (and, behind OpenRouter, the model) needs explicit marks at all. OpenRouter
// passes `cache_control` through to Anthropic; every other vendor behind it caches on its own or
// not at all, and a mark there is at best ignored.
export function promptCacheApplies(provider: string, model: string): boolean {
  if (provider === "anthropic") return true;
  if (provider === "openrouter")
    return model.toLowerCase().startsWith("anthropic/");
  return false;
}

// The providers on which the fields mean something; the model-config schema refuses them elsewhere.
export const PROVIDERS_WITH_PROMPT_CACHE = ["anthropic", "openrouter"] as const;

// Whether this config's requests are marked. Every mark is the 5-minute one: a 1-hour write bills at
// 2x the input rate against 1.25x, and the usage ledger records cache writes as one count priced at the
// 5-minute rate, so a 1-hour mark would understate spend and the spend ceiling with it.
export function promptCacheEnabled(cfg: {
  provider: string;
  model: string;
  promptCache?: PromptCacheMode;
}): boolean {
  return (
    cfg.promptCache !== "off" && promptCacheApplies(cfg.provider, cfg.model)
  );
}

const MARK = { type: "ephemeral" } as const;

type Block = Record<string, unknown>;

// The call signature of `fetch`, without the static members Bun adds to the global (`preconnect`):
// what the SDKs take as their `fetch` option.
type FetchFn = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

// Block types a mark may sit on. A `thinking` block refuses one, and so does an empty text block.
const MARKABLE = new Set([
  "text",
  "image",
  "document",
  "tool_use",
  "tool_result",
  "image_url",
  "file",
]);

function markable(b: unknown): b is Block {
  if (!b || typeof b !== "object") return false;
  const block = b as Block;
  if (!MARKABLE.has(String(block.type))) return false;
  return !(block.type === "text" && !String(block.text ?? "").trim());
}

// Marks the last markable block of a message's content, turning a plain string into one text block
// (the same bytes the API reads for a string). True when a mark was placed.
function markContent(msg: Block): boolean {
  if (typeof msg.content === "string") {
    if (!msg.content.trim()) return false;
    msg.content = [
      { type: "text", text: msg.content, cache_control: { ...MARK } },
    ];
    return true;
  }
  if (!Array.isArray(msg.content)) return false;
  for (let i = msg.content.length - 1; i >= 0; i--) {
    const b = msg.content[i];
    if (markable(b)) {
      b.cache_control = { ...MARK };
      return true;
    }
  }
  return false;
}

// Every non-empty string content as the one text block it stands for. The mark has to turn the last
// message into blocks, so without this the same message is a string while it is last and a block list
// the turn after, and the prefix the next turn sends no longer matches byte for byte.
function contentAsBlocks(messages: unknown): void {
  if (!Array.isArray(messages)) return;
  for (const m of messages as Block[])
    if (m && typeof m.content === "string" && m.content.trim())
      m.content = [{ type: "text", text: m.content }];
}

function markLastMessage(messages: unknown): void {
  if (!Array.isArray(messages)) return;
  contentAsBlocks(messages);
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i] as Block;
    if (m && m.role !== "system" && markContent(m)) return;
  }
}

// Anthropic messages API body: `tools`, `system` (string or blocks) and `messages`.
export function markAnthropicBody(body: Block): Block {
  if (Array.isArray(body.tools) && body.tools.length > 0) {
    const lastTool = body.tools[body.tools.length - 1] as Block;
    lastTool.cache_control = { ...MARK };
  }
  if (typeof body.system === "string" && body.system.trim()) {
    body.system = [
      {
        type: "text",
        text: body.system,
        cache_control: { ...MARK },
      },
    ];
  } else if (Array.isArray(body.system)) {
    for (let i = body.system.length - 1; i >= 0; i--) {
      const b = body.system[i];
      if (markable(b)) {
        b.cache_control = { ...MARK };
        break;
      }
    }
  }
  markLastMessage(body.messages);
  return body;
}

// Chat-completions body (OpenRouter): the system message carries the prefix mark, the last message
// the conversation one. Tool definitions have no mark in this shape; they render before the system
// message, so the system mark caches them too.
export function markChatCompletionsBody(body: Block): Block {
  if (!Array.isArray(body.messages)) return body;
  for (let i = body.messages.length - 1; i >= 0; i--) {
    const m = body.messages[i] as Block;
    if (m?.role === "system" || m?.role === "developer") {
      markContent(m);
      break;
    }
  }
  markLastMessage(body.messages);
  return body;
}

// A fetch that marks the JSON body of the provider's generation endpoint and sends everything else
// untouched. The underlying fetch is read at call time, so a test (or another wrapper) that swaps
// `globalThis.fetch` is still the one that sends.
export function promptCacheFetch(
  shape: "anthropic" | "chat-completions",
  base: FetchFn = (input, init) => globalThis.fetch(input, init),
): FetchFn {
  const wrapped = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    const endpoint =
      shape === "anthropic"
        ? /\/messages(\?|$)/.test(url)
        : /\/chat\/completions(\?|$)/.test(url);
    if (!endpoint || typeof init?.body !== "string") return base(input, init);
    let body: Block;
    try {
      body = JSON.parse(init.body) as Block;
    } catch {
      return base(input, init);
    }
    if (shape === "anthropic") markAnthropicBody(body);
    else markChatCompletionsBody(body);
    return base(input, { ...init, body: JSON.stringify(body) });
  };
  return wrapped;
}
