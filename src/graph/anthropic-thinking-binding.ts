import type { BaseMessage } from "@langchain/core/messages";
import logger from "@/api/lib/logger";

// The Claude 5.5 models bind each signed `thinking` block to the prefix before it (system prompt,
// tools, earlier messages) and refuse a replay under another prefix with a 400 no retry clears, so
// a prompt edit, a tool change or an upgrade would fail every conversation with history. The
// `thinking-binding-controls` beta with `drop_block` drops only the stale blocks instead.
//
// The field needs `thinking.type: "adaptive"`, which the 4.x models refuse, so it goes only to a
// model whose refusal proved it enforces the binding, and that model gets it up front from then on.
// Details in docs/graph.md.

export const THINKING_BINDING_BETA = "thinking-binding-controls-2026-08-01";

type FetchFn = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;
type Body = Record<string, unknown>;

const bindingEnforced = new Set<string>();

/** Whether a 400 body is the API refusing a replayed thinking block under a different prefix. */
export function isThinkingBindingRefusal(
  status: number,
  body: unknown,
): boolean {
  if (status !== 400) return false;
  const message = (body as { error?: { message?: unknown } } | null)?.error
    ?.message;
  return (
    typeof message === "string" &&
    message.includes("`thinking` block") &&
    message.includes("bound to a different conversation")
  );
}

function withDropBlock(body: Body): Body {
  const thinking = (body.thinking ?? {}) as Body;
  return {
    ...body,
    thinking: {
      ...thinking,
      type: thinking.type ?? "adaptive",
      block_binding: { prefix_mismatch_behavior: "drop_block" },
    },
  };
}

/** The request's headers with `beta` added to the ones `anthropic-beta` already names. */
export function addAnthropicBeta(
  headers: RequestInit["headers"],
  beta: string,
): Headers {
  const out = new Headers(headers);
  const betas = (out.get("anthropic-beta") ?? "")
    .split(",")
    .map((b) => b.trim())
    .filter(Boolean);
  if (!betas.includes(beta)) betas.push(beta);
  out.set("anthropic-beta", betas.join(","));
  return out;
}

const dropBlockInit = (init: RequestInit, body: Body): RequestInit => ({
  ...init,
  headers: addAnthropicBeta(init.headers, THINKING_BINDING_BETA),
  body: JSON.stringify(withDropBlock(body)),
});

/** Wraps the Anthropic client's fetch so a replay under a changed prefix drops the stale blocks. */
export function thinkingBindingFetch(
  base: FetchFn = (input, init) => globalThis.fetch(input, init),
): FetchFn {
  return async (input, init) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    if (!/\/messages(\?|$)/.test(url) || typeof init?.body !== "string")
      return base(input, init);
    let body: Body;
    try {
      body = JSON.parse(init.body) as Body;
    } catch {
      return base(input, init);
    }
    const model = typeof body.model === "string" ? body.model : "";
    if (bindingEnforced.has(model))
      return base(input, dropBlockInit(init, body));
    const res = await base(input, init);
    if (res.status !== 400) return res;
    // The body is read once and handed back in a copy: `clone()` is not dependable on every
    // Response implementation the client may be given.
    const text = await res.text();
    let refusal: unknown = null;
    try {
      refusal = JSON.parse(text);
    } catch {}
    if (!isThinkingBindingRefusal(res.status, refusal))
      return new (res.constructor as typeof Response)(text, {
        status: res.status,
        statusText: res.statusText,
        headers: res.headers,
      });
    bindingEnforced.add(model);
    logger.info(
      { model },
      "anthropic: a replayed thinking block is bound to an older prefix; retrying with drop_block",
    );
    return base(input, dropBlockInit(init, body));
  };
}

/** How many replayed thinking blocks the API dropped across the replies of the latest turn. */
export function thinkingDroppedThisTurn(
  messages: readonly BaseMessage[],
): number {
  let count = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (!m) continue;
    if (m.getType() === "human") break;
    const transformations = (m.response_metadata as Body | undefined)
      ?.input_transformations;
    if (!Array.isArray(transformations)) continue;
    for (const t of transformations)
      if ((t as Body | null)?.type === "thinking_dropped") count++;
  }
  return count;
}
