import type { BaseMessage } from "@langchain/core/messages";
import { redactSecretsDeep, redactSecretsInText, truncate } from "@/lib/redact";
import type { GuardrailAction } from "@/modules/guardrails/settings";

// Builds a sanitized, human-readable execution trace from the graph's final message list, for the
// agent playground (UI + the agent_playground MCP tool). It is a DEBUG view: the sequence of tool
// calls (name + args), tool results (output / error), the KB sources a search grounded on, and any
// intermediate assistant reasoning. The final assistant message (the reply) is excluded — it is
// returned separately as `reply`. Every arg/output passes through the secret redactor; resolved
// credentials never reach here (they live only in request headers at fetch time, not in a message).

export interface TraceSource {
  marker: string; // 1-based display index for the Sources panel (never echoed to the customer)
  chunkId: string;
  kb: string;
  // Ids backing the playground "open the KB / open the exact document" links (absent on legacy traces).
  knowledgeBaseId?: string;
  documentId?: string;
  documentTitle?: string;
  title?: string;
  url?: string;
}

export interface TraceToolCall {
  type: "tool_call";
  id: string | null;
  name: string;
  args: unknown; // redacted
}

export interface TraceToolResult {
  type: "tool_result";
  id: string | null; // tool_call_id, to pair with the originating call
  name: string | null;
  output: string; // redacted + truncated
  isError: boolean;
  sources?: TraceSource[]; // present for search_knowledge (from the ToolMessage artifact)
  // Playground only: the result came from an operator-supplied mock, or a simulated conversation
  // tool (no real effect). Labels surfaced in the trace panel so the operator isn't misled.
  mocked?: boolean;
  simulated?: boolean;
}

// Playground tool-simulation context for labeling results in the trace (which tool names were mocked
// by the operator vs simulated conversation tools). Both optional — production traces pass neither.
export interface TraceLabelOpts {
  mockedNames?: Set<string>;
  simulatedNames?: Set<string>;
}

export interface TraceAssistant {
  type: "assistant";
  text: string;
}

// A pre-turn media pre-processing step (vision = image/document read) that runs BEFORE the graph,
// so it is NOT a model tool call and never lands in the message-derived trace. The playground
// file-turn injects it so the operator sees the read (which provider + the extracted text) in the
// "Execution details", where it would otherwise be invisible.
export interface TraceMedia {
  type: "media";
  pipeline: "vision";
  mediaKind: "image" | "document";
  provider: string;
  model?: string | null;
  output: string; // redacted + truncated
}

// A moderation screening, which runs OUTSIDE the graph on both sides of it and so never lands in
// the message-derived trace either. On the inbox path what the guardrail did is announced as a
// private note on the conversation; the playground is not a conversation, and without this entry a
// template reply is indistinguishable from an agent that answered badly (issue #136). `clean` and
// `unavailable` are here for the reading the reply cannot give on its own: whether a guardrail ran
// at all, which is what makes a misconfigured one visible where it is cheapest to notice.
export interface TraceGuardrail {
  type: "guardrail";
  direction: "input" | "output";
  outcome: "clean" | "unavailable" | "replaced" | "suppressed";
  // The action as it was CARRIED OUT, absent when nothing tripped. `generated` with no replacement
  // in hand sends the template, and this says template (see modules/guardrails/gate.ts).
  action?: GuardrailAction;
  // Both model-written, and present only on a trip. They are the operator's whole explanation of
  // why the reply they are looking at is not the one the agent wrote.
  categories?: string[];
  rationale?: string;
}

export type TraceEntry =
  | TraceToolCall
  | TraceToolResult
  | TraceAssistant
  | TraceMedia
  | TraceGuardrail;

const OUTPUT_MAX = 2000;

function msgType(m: BaseMessage): string {
  const anyM = m as unknown as {
    getType?: () => string;
    _getType?: () => string;
  };
  return anyM.getType?.() ?? anyM._getType?.() ?? "";
}

function contentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((c) =>
        typeof c === "string"
          ? c
          : c && typeof c === "object" && "text" in c
            ? String((c as { text: unknown }).text)
            : "",
      )
      .join("");
  }
  return "";
}

// Pulls the structured KB sources off a search_knowledge ToolMessage `artifact`
// ({ sources: [...] }, attached via responseFormat "content_and_artifact"). Tolerant of shape.
function extractSources(artifact: unknown): TraceSource[] | undefined {
  if (!artifact || typeof artifact !== "object") return undefined;
  const raw = (artifact as { sources?: unknown }).sources;
  if (!Array.isArray(raw)) return undefined;
  const out: TraceSource[] = [];
  for (const r of raw) {
    if (!r || typeof r !== "object") continue;
    const o = r as Record<string, unknown>;
    out.push({
      marker: String(o.marker ?? ""),
      chunkId: String(o.chunkId ?? ""),
      kb: String(o.kb ?? ""),
      ...(o.knowledgeBaseId
        ? { knowledgeBaseId: String(o.knowledgeBaseId) }
        : {}),
      ...(o.documentId ? { documentId: String(o.documentId) } : {}),
      ...(o.documentTitle ? { documentTitle: String(o.documentTitle) } : {}),
      ...(o.title ? { title: String(o.title) } : {}),
      ...(o.url ? { url: String(o.url) } : {}),
    });
  }
  return out.length ? out : undefined;
}

export function buildPlaygroundTrace(
  messages: BaseMessage[],
  labels: TraceLabelOpts = {},
): TraceEntry[] {
  // The checkpointer accumulates the whole thread; restrict to THIS turn — everything after the
  // last turn-opening message. A normal turn opens with the human message we just sent; a follow-up
  // turn opens with the injected nudge SystemMessage. Either way it is the latest human/system
  // message. Then drop the trailing reply (surfaced separately).
  let start = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const ty = msgType(messages[i] as BaseMessage);
    if (ty === "human" || ty === "system") {
      start = i + 1;
      break;
    }
  }
  const turn = messages.slice(start);
  const upto = turn.length > 0 ? turn.slice(0, -1) : [];

  const entries: TraceEntry[] = [];
  for (const m of upto) {
    const type = msgType(m);
    if (type === "ai") {
      const text = contentToText(m.content).trim();
      if (text) {
        entries.push({
          type: "assistant",
          text: redactSecretsInText(truncate(text, OUTPUT_MAX)),
        });
      }
      const calls = (
        m as unknown as {
          tool_calls?: Array<{ name?: string; args?: unknown; id?: string }>;
        }
      ).tool_calls;
      if (Array.isArray(calls)) {
        for (const c of calls) {
          entries.push({
            type: "tool_call",
            id: c.id ?? null,
            name: c.name ?? "tool",
            args: redactSecretsDeep(c.args ?? {}),
          });
        }
      }
    } else if (type === "tool") {
      const tm = m as unknown as {
        tool_call_id?: string;
        name?: string;
        content?: unknown;
        artifact?: unknown;
        status?: string;
      };
      const sources = extractSources(tm.artifact);
      const name = tm.name ?? null;
      const mocked = !!(name && labels.mockedNames?.has(name));
      // A mock takes precedence over the simulated label (the operator's mock overrode the no-op).
      const simulated = !mocked && !!(name && labels.simulatedNames?.has(name));
      entries.push({
        type: "tool_result",
        id: tm.tool_call_id ?? null,
        name,
        output: redactSecretsInText(
          truncate(contentToText(tm.content), OUTPUT_MAX),
        ),
        isError: tm.status === "error",
        ...(sources ? { sources } : {}),
        ...(mocked ? { mocked: true } : {}),
        ...(simulated ? { simulated: true } : {}),
      });
    }
  }
  return entries;
}

// Synthetic trace entry for a pre-turn vision extraction (the playground file-turn runs vision
// before the graph). Redacts + truncates the extracted text the same way the message-derived trace
// does, so a leaked secret in an OCR'd image never reaches the panel raw.
export function buildVisionTraceEntry(args: {
  mediaKind: "image" | "document";
  provider: string;
  model?: string | null;
  text: string;
}): TraceMedia {
  return {
    type: "media",
    pipeline: "vision",
    mediaKind: args.mediaKind,
    provider: args.provider,
    model: args.model ?? null,
    output: redactSecretsInText(truncate(args.text, OUTPUT_MAX)),
  };
}

// Deduped flat list of KB sources referenced across the whole turn (result-level summary so a
// caller does not have to walk the trace to see what grounded the answer).
export function collectTraceSources(trace: TraceEntry[]): TraceSource[] {
  const seen = new Set<string>();
  const out: TraceSource[] = [];
  for (const e of trace) {
    if (e.type !== "tool_result" || !e.sources) continue;
    for (const s of e.sources) {
      // Dedup by document (one doc may contribute several chunks) so each source shows once.
      const key = `${s.knowledgeBaseId ?? s.kb}#${s.documentId ?? s.chunkId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(s);
    }
  }
  return out;
}
