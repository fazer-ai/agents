import type { AIMessage, BaseMessage } from "@langchain/core/messages";
import logger from "@/api/lib/logger";
import { addAnthropicBeta } from "./anthropic-thinking-binding";

// Sonnet 5.5, Opus 5.5 and the Fable/Mythos 5 models return text written before a tool call (past a
// sentence or two) as a progress-update `thinking` block, empty under the default `display:
// "omitted"`. The customer never sees it, and the model, replayed the whole note, believes it already
// answered. `display: "updates"` makes the block carry a short summary, so a thinking block with
// text means "a note was written and hidden": `hiddenNotesThisTurn` reads that, and nothing ever
// delivers the summary. The option changes visibility only (same thinking, same billing, same cache
// reads across a switch, measured live). Details in docs/graph.md.

export const PROGRESS_UPDATES_BETA = "thinking-display-updates-2026-08-18";

// The models that write these notes AND already run adaptive thinking when the field is omitted, so
// the explicit `type: "adaptive"` the option needs changes nothing else. Opus 4.8 accepts the option
// too, but omitting thinking runs it without any, so sending it there would turn thinking on. Sonnet
// 5, Opus 5 and Haiku 5.5 return that text as `text` (measured live), so there is nothing to see.
// An id outside the list keeps today's request.
const WRITES_PROGRESS_NOTES =
  /^claude-(sonnet-5-5|opus-5-5|fable-5(-[12])?|mythos-5(-[12])?)(-\d{8})?$/;

export function writesProgressNotes(model: string): boolean {
  return WRITES_PROGRESS_NOTES.test(model);
}

// The line the prompt carries for an Anthropic agent, so the reply is written where it is delivered.
export const LAST_MESSAGE_RULE =
  "## Mensagem ao cliente\nO cliente recebe a mensagem que você escreve depois da última chamada de ferramenta do turno. Texto escrito antes de uma chamada de ferramenta não chega a ele: faça primeiro as chamadas de ferramenta e escreva por último, inteira, a mensagem ao cliente.";

type FetchFn = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;
type Body = Record<string, unknown>;

// Models whose API refused the option (the beta gone, or never there for this account), sent
// without it for the life of the process.
const refusedUpdates = new Set<string>();

/** Whether a 400 body is the API refusing `display: "updates"`. */
export function isUpdatesRefusal(status: number, body: unknown): boolean {
  if (status !== 400) return false;
  const message = (body as { error?: { message?: unknown } } | null)?.error
    ?.message;
  return typeof message === "string" && message.includes("display");
}

// Only a request that leaves thinking to the model's default (absent, or adaptive with no display)
// is changed: `between_tools`, `disabled` or a chosen display is someone's decision.
function asksUpdates(body: Body): boolean {
  const model = typeof body.model === "string" ? body.model : "";
  if (!writesProgressNotes(model) || refusedUpdates.has(model)) return false;
  const thinking = body.thinking as Body | undefined;
  if (thinking === undefined) return true;
  return (
    typeof thinking === "object" &&
    thinking !== null &&
    thinking.type === "adaptive" &&
    thinking.display === undefined
  );
}

/** Wraps the Anthropic client's fetch so a model that hides its progress notes returns their summary. */
export function progressNotesFetch(
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
    if (!asksUpdates(body)) return base(input, init);
    const res = await base(input, {
      ...init,
      headers: addAnthropicBeta(init.headers, PROGRESS_UPDATES_BETA),
      body: JSON.stringify({
        ...body,
        thinking: {
          ...((body.thinking as Body | undefined) ?? {}),
          type: "adaptive",
          display: "updates",
        },
      }),
    });
    if (res.status !== 400) return res;
    const text = await res.text();
    let refusal: unknown = null;
    try {
      refusal = JSON.parse(text);
    } catch {}
    if (!isUpdatesRefusal(res.status, refusal))
      return new (res.constructor as typeof Response)(text, {
        status: res.status,
        statusText: res.statusText,
        headers: res.headers,
      });
    refusedUpdates.add(String(body.model));
    logger.warn(
      { model: body.model },
      "anthropic: display=updates was refused; sending this model's requests without it",
    );
    return base(input, init);
  };
}

// The summaries of the notes one assistant message hid: its non-empty `thinking` blocks, when it is an
// Anthropic message that calls a tool. Empty for anything else.
export function hiddenNotesOf(m: BaseMessage): string[] {
  if (m.getType() !== "ai") return [];
  const ai = m as AIMessage;
  if (ai.response_metadata?.model_provider !== "anthropic") return [];
  if ((ai.tool_calls?.length ?? 0) === 0 || !Array.isArray(ai.content))
    return [];
  const notes: string[] = [];
  for (const block of ai.content) {
    const b = block as { type?: unknown; thinking?: unknown };
    if (b?.type !== "thinking" || typeof b.thinking !== "string") continue;
    const note = b.thinking.trim();
    if (note) notes.push(note);
  }
  return notes;
}

/** The summaries of the notes hidden in this turn (since the last human message), oldest first. */
export function hiddenNotesThisTurn(
  messages: readonly BaseMessage[],
): string[] {
  const notes: string[] = [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (!m) continue;
    if (m.getType() === "human") break;
    notes.unshift(...hiddenNotesOf(m));
  }
  return notes;
}

/**
 * The flow-log detail of a turn that hid notes, for measuring how often a reply leans on one ("I sent
 * the link above"). A summary is conversation content, so it is stored only where the agent stores a
 * tool's values (`logToolValues`); otherwise only its size.
 */
export function hiddenNotesDetail(
  notes: readonly string[],
  logValues: boolean,
): Record<string, unknown> {
  return {
    hiddenNotes: notes.length,
    hiddenNoteChars: notes.reduce((n, s) => n + s.length, 0),
    ...(logValues ? { hiddenNoteSummaries: [...notes] } : {}),
  };
}
