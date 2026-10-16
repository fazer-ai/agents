import { createHash, randomUUID } from "node:crypto";
import type { BaseMessage } from "@langchain/core/messages";
import { contentToText } from "@/graph/message-text";
import { msgType } from "@/graph/trace";
import { redactSecretsDeep, scrubbedClip } from "@/lib/redact";
import { assertSafeOutboundUrl, SsrfError } from "@/lib/ssrf";
import { readBodyCapped, underSignal } from "@/modules/contact-auth/check";
import { emitFlowEvent, type FlowContext } from "@/modules/flowlog/service";
import { outboundHeaders } from "@/modules/webhooks/outbound/signing";
import type {
  GuardrailAnnounce,
  GuardrailDecision,
  GuardrailReport,
} from "./gate";
import type { GuardrailsConfig } from "./settings";

// The external check (docs/guardrails-external.md): before a reply to a customer
// message is delivered, the turn is POSTed to an endpoint the operator runs, and its answer decides.
// It runs after the built-in output screening, on the text that would go out, and answers in the
// gate's own vocabulary so the caller applies a block exactly as it applies a trip.

// Same budget as the built-in judges: an answer later than this follows `onFailure`.
export const EXTERNAL_TIMEOUT_MS = 15_000;
// A verdict is a few hundred bytes; an answer past this is not one.
export const EXTERNAL_RESPONSE_MAX_BYTES = 64 * 1024;
// What a `replace` may put in front of a customer, and what a `block` reason may say in a note.
export const EXTERNAL_REPLACE_MAX = 4096;
export const EXTERNAL_REASON_MAX = 500;
// Each tool call's arguments and result, as sent; the endpoint gets the size of what was cut.
export const EXTERNAL_TOOL_VALUE_MAX = 8000;
export const EXTERNAL_TOOL_CALLS_MAX = 50;

export type ExternalDecision = "allow" | "replace" | "block";
// Our own words for why no decision came back, safe to log: we wrote every value.
export type ExternalFailureCause =
  | "timeout"
  | "http_status"
  | "network"
  | "malformed"
  | "unverifiable"
  | "unsafe_url"
  | "secret_not_found";

// What the trace, the note and the log line say about one external check.
export interface ExternalReport {
  decision: ExternalDecision | "failed";
  latencyMs: number;
  // The endpoint's own words on a block, clipped. Operator-written, so it reaches the note.
  reason?: string;
  cause?: ExternalFailureCause;
  status?: number;
}

export interface ExternalToolCall {
  name: string;
  args?: unknown;
  result?: string;
  // Sizes of the values as the turn had them, before any cap, in characters.
  argsSize: number;
  resultSize: number;
  isError: boolean;
}

// The arguments as sent: redacted, and held to the cap as a whole. Past it they travel as their
// serialized text cut to the cap, since a per-string bound alone lets many fields add up.
function boundedArgs(args: unknown): unknown {
  const redacted = redactSecretsDeep(args, 0, EXTERNAL_TOOL_VALUE_MAX);
  const text = JSON.stringify(redacted) ?? "";
  return text.length <= EXTERNAL_TOOL_VALUE_MAX
    ? redacted
    : scrubbedClip(text, EXTERNAL_TOOL_VALUE_MAX);
}

// The turn's tool calls, in the order the model made them, paired with their results. The turn is
// everything after the last human or system message, the same slice the playground trace reads.
export function turnToolCalls(
  messages: BaseMessage[],
  sendValues: boolean,
): ExternalToolCall[] {
  let start = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const ty = msgType(messages[i] as BaseMessage);
    if (ty === "human" || ty === "system") {
      start = i + 1;
      break;
    }
  }
  const turn = messages.slice(start);
  const results = new Map<string, { text: string; isError: boolean }>();
  for (const m of turn) {
    if (msgType(m) !== "tool") continue;
    const tm = m as unknown as {
      tool_call_id?: string;
      content?: unknown;
      status?: string;
    };
    if (tm.tool_call_id)
      results.set(tm.tool_call_id, {
        text: contentToText(tm.content as never),
        isError: tm.status === "error",
      });
  }
  const out: ExternalToolCall[] = [];
  for (const m of turn) {
    if (msgType(m) !== "ai") continue;
    const calls = (
      m as unknown as {
        tool_calls?: Array<{ name?: string; args?: unknown; id?: string }>;
      }
    ).tool_calls;
    for (const c of calls ?? []) {
      if (out.length >= EXTERNAL_TOOL_CALLS_MAX) return out;
      const res = c.id ? results.get(c.id) : undefined;
      const argsText = JSON.stringify(c.args ?? {});
      const resultText = res?.text ?? "";
      out.push({
        name: c.name ?? "tool",
        ...(sendValues
          ? {
              args: boundedArgs(c.args ?? {}),
              result: scrubbedClip(resultText, EXTERNAL_TOOL_VALUE_MAX),
            }
          : {}),
        argsSize: argsText.length,
        resultSize: resultText.length,
        isError: res?.isError ?? false,
      });
    }
  }
  return out;
}

// A file the reply sends with it: what it is and the model-written text the customer reads on it.
export interface ExternalAttachment {
  kind: "image" | "document";
  fileName: string;
  caption?: string;
  // Text the model wrote inside the file (a document's fields), as the built-in screening reads it.
  text?: string;
}

// What the endpoint judges: the reply's text and every file that goes out with it.
export interface ExternalCandidate {
  text: string;
  attachments: ExternalAttachment[];
  model: "primary" | "fallback";
  toolCalls: ExternalToolCall[];
}

// Who and where, from trusted context only.
export interface ExternalContext {
  tenantId: bigint | number;
  agentId: bigint | number;
  // This side's conversation row and Chatwoot's conversation; null in the playground.
  conversationId: bigint | number | null;
  chatwootConversationId: number | null;
  turnId: string;
  // The customer message(s) the turn answers: one, or a debounced burst.
  customerMessage: string;
}

// Bound to the exact text judged, and to the turn: the same reply in another turn is another
// candidate. The endpoint echoes it, which is how an answer is tied to what it was asked about.
export function candidateIdFor(
  turnId: string,
  text: string,
  attachments: ExternalAttachment[] = [],
): string {
  const files = attachments.length ? `\n${JSON.stringify(attachments)}` : "";
  return createHash("sha256")
    .update(`${turnId}\n${text}${files}`)
    .digest("hex");
}

export function buildExternalRequest(
  ctx: ExternalContext,
  candidate: ExternalCandidate,
): Record<string, unknown> {
  return {
    version: 1,
    type: "guardrail.output",
    candidateId: candidateIdFor(
      ctx.turnId,
      candidate.text,
      candidate.attachments,
    ),
    tenantId: String(ctx.tenantId),
    agentId: String(ctx.agentId),
    conversationId:
      ctx.conversationId == null ? null : String(ctx.conversationId),
    chatwootConversationId: ctx.chatwootConversationId,
    turnId: ctx.turnId,
    customerMessage: ctx.customerMessage,
    toolCalls: candidate.toolCalls,
    candidate: {
      text: candidate.text,
      attachments: candidate.attachments,
      model: candidate.model,
    },
  };
}

export type ExternalAnswer =
  | {
      ok: true;
      decision: ExternalDecision;
      text?: string;
      reason?: string;
      status: number;
    }
  | { ok: false; cause: ExternalFailureCause; status?: number };

// The pure half: an answer as a decision, or the reason it is not one.
export function readExternalAnswer(
  status: number,
  body: string | null,
  candidateId: string,
): ExternalAnswer {
  if (status < 200 || status > 299)
    return { ok: false, cause: "http_status", status };
  let parsed: unknown;
  try {
    parsed = body === null ? null : JSON.parse(body);
  } catch {
    return { ok: false, cause: "malformed", status };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    return { ok: false, cause: "malformed", status };
  const a = parsed as Record<string, unknown>;
  if (a.candidateId !== candidateId)
    return { ok: false, cause: "unverifiable", status };
  const reason =
    typeof a.reason === "string" && a.reason.trim()
      ? // Redacted while whole: a cut first could leave a secret's prefix no pattern recognizes.
        scrubbedClip(a.reason.trim(), EXTERNAL_REASON_MAX)
      : undefined;
  if (a.decision === "allow") return { ok: true, decision: "allow", status };
  if (a.decision === "block")
    return {
      ok: true,
      decision: "block",
      status,
      ...(reason ? { reason } : {}),
    };
  if (a.decision === "replace") {
    const text = typeof a.text === "string" ? a.text.trim() : "";
    if (!text || text.length > EXTERNAL_REPLACE_MAX)
      return { ok: false, cause: "malformed", status };
    return {
      ok: true,
      decision: "replace",
      text,
      status,
      ...(reason ? { reason } : {}),
    };
  }
  return { ok: false, cause: "malformed", status };
}

export interface ExternalCallDeps {
  fetchImpl?: typeof fetch;
  assertSafe?: (url: string) => Promise<URL>;
  now?: () => number;
  // The budget, EXTERNAL_TIMEOUT_MS unless a test shortens it.
  timeoutMs?: number;
}

// The network half. Never throws: every failure is an answer with a cause.
export async function askExternal(
  url: string,
  secret: string | null,
  body: Record<string, unknown>,
  deps: ExternalCallDeps = {},
): Promise<ExternalAnswer> {
  const doFetch = deps.fetchImpl ?? fetch;
  const assertSafe =
    deps.assertSafe ?? ((u: string) => assertSafeOutboundUrl(u));
  const ctrl = new AbortController();
  const timer = setTimeout(
    () => ctrl.abort(),
    deps.timeoutMs ?? EXTERNAL_TIMEOUT_MS,
  );
  try {
    // NOTE: under the same deadline as the request: the check resolves DNS and takes no signal.
    try {
      await underSignal(assertSafe(url), ctrl.signal);
    } catch (err) {
      if (ctrl.signal.aborted) return { ok: false, cause: "timeout" };
      return {
        ok: false,
        cause: err instanceof SsrfError ? "unsafe_url" : "network",
      };
    }
    const rawBody = JSON.stringify(body);
    const res = await doFetch(url, {
      method: "POST",
      headers: outboundHeaders({
        contentType: "application/json",
        deliveryId: randomUUID(),
        timestampSeconds: Math.floor((deps.now ?? Date.now)() / 1000),
        rawBody,
        secret,
      }),
      body: rawBody,
      redirect: "error",
      signal: ctrl.signal,
    });
    const text = await readBodyCapped(res, EXTERNAL_RESPONSE_MAX_BYTES);
    return readExternalAnswer(res.status, text, String(body.candidateId));
  } catch (err) {
    const aborted =
      ctrl.signal.aborted ||
      (err instanceof Error && err.name === "AbortError");
    return { ok: false, cause: aborted ? "timeout" : "network" };
  } finally {
    clearTimeout(timer);
  }
}

export interface ExternalCheckParams {
  cfg: GuardrailsConfig;
  ctx: ExternalContext;
  // The resolved signing secret, or null for an unsigned check.
  secret: string | null;
  // The configured vault entry did not resolve: a failure, since a receiver that verifies would
  // refuse the request unsigned.
  secretMissing?: boolean;
  // `observability.logToolValues`: the endpoint's reason, free text that may quote the customer,
  // reaches the flow line only with it on. Otherwise the line keeps its length.
  logValues?: boolean;
  flow: FlowContext;
  announce?: GuardrailAnnounce;
  deps?: ExternalCallDeps;
}

export type ExternalCheck = (
  candidate: ExternalCandidate,
) => Promise<GuardrailDecision>;

// Null when there is nothing to ask: guardrails off, or no endpoint configured.
export function buildExternalCheck(
  p: ExternalCheckParams,
): ExternalCheck | null {
  const gr = p.cfg;
  const url = gr.external.url;
  if (!gr.enabled || !url) return null;
  const out = gr.output;
  const now = p.deps?.now ?? Date.now;
  return async (candidate) => {
    const started = now();
    const body = buildExternalRequest(p.ctx, candidate);
    const answer: ExternalAnswer = p.secretMissing
      ? { ok: false, cause: "secret_not_found" }
      : await askExternal(url, p.secret, body, p.deps);
    const latencyMs = Math.max(0, now() - started);
    let d: GuardrailDecision;
    let r: GuardrailReport;
    if (!answer.ok) {
      const held = gr.onFailure === "hold";
      emitFlowEvent(p.flow, {
        stage: "guardrail",
        status: "error",
        level: "warn",
        detail: {
          direction: "output",
          check: "external",
          outcome: "external_failed",
          cause: answer.cause,
          ...(answer.status ? { httpStatus: answer.status } : {}),
          latencyMs,
          ...(held ? { unchecked: false, held: true } : { unchecked: true }),
        },
      });
      const external: ExternalReport = {
        decision: "failed",
        latencyMs,
        cause: answer.cause,
        ...(answer.status ? { status: answer.status } : {}),
      };
      if (held) {
        d = { kind: "handed-off", reply: out.handoffMessage || null };
        r = {
          direction: "output",
          outcome: "handed-off",
          held: true,
          refused: candidate.text,
          external,
        };
      } else {
        d = { kind: "unavailable", modelRan: true };
        r = { direction: "output", outcome: "unavailable", external };
      }
    } else {
      const external: ExternalReport = {
        decision: answer.decision,
        latencyMs,
        ...(answer.reason ? { reason: answer.reason } : {}),
      };
      // `generated` has no judge that wrote a replacement here, so it sends the template.
      const action =
        answer.decision === "block"
          ? out.action === "generated"
            ? "template"
            : out.action
          : undefined;
      emitFlowEvent(p.flow, {
        stage: "guardrail",
        status: "ok",
        level: answer.decision === "allow" ? "info" : "warn",
        detail: {
          direction: "output",
          check: "external",
          decision: answer.decision,
          latencyMs,
          ...(action ? { action } : {}),
          ...(answer.reason
            ? p.logValues
              ? { endpointReason: answer.reason }
              : { reasonChars: answer.reason.length }
            : {}),
        },
      });
      if (answer.decision === "allow") {
        d = { kind: "clean" };
        r = { direction: "output", outcome: "clean", external };
      } else if (answer.decision === "replace") {
        // The endpoint's text, escaped for Chatwoot like a model's: it is not a template the
        // operator wrote in this console, and it may echo what the customer typed.
        d = {
          kind: "replaced",
          reply: answer.text as string,
          generated: true,
        };
        r = { direction: "output", outcome: "replaced", external };
      } else if (action === "silent") {
        d = { kind: "suppressed" };
        r = { direction: "output", outcome: "suppressed", action, external };
      } else if (action === "handoff") {
        d = { kind: "handed-off", reply: out.handoffMessage || null };
        r = {
          direction: "output",
          outcome: "handed-off",
          action,
          refused: candidate.text,
          external,
        };
      } else {
        d = { kind: "replaced", reply: out.templateMessage };
        r = { direction: "output", outcome: "replaced", action, external };
      }
    }
    await p.announce?.(r);
    return d;
  };
}
