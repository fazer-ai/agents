import { ToolMessage } from "@langchain/core/messages";
import type {
  StructuredToolInterface,
  ToolRunnableConfig,
} from "@langchain/core/tools";
import type { PrismaClient } from "@/../generated/prisma/client";
import { runScopedOn, type TenantContext } from "@/lib/tenancy";
import type {
  PreconditionState,
  ToolPrecondition,
} from "@/modules/agents/tool-preconditions";
import {
  evaluatePrecondition,
  unmetPreconditionMessage,
} from "@/modules/agents/tool-preconditions";
import type { FlowEvent } from "@/modules/flowlog/service";

function sysCtx(tenantId: bigint): TenantContext {
  return { tenantId, userId: null, role: "TENANT_ADMIN" };
}

// Wraps ONE assembled tool in its operator-declared precondition (issue #101). The wrap happens at
// the single seam where every source's tools meet (prepare.ts, after dropDuplicateToolNames), so
// native, document, HTTP, MCP, toolpack and RAG are all covered by the same six lines rather than by
// six copies of the check.
//
// The refusal reaches the model as a NORMAL tool result, not as a ToolFailure (tools/failure.ts).
// That distinction is the one that file draws and it holds here: a ToolFailure means the integration
// broke and should page an operator, while a precondition doing its job is the system working. The
// flow log still gets a line — via `onRefused` — because an operator does need to see a rule firing,
// just not as an incident.
// Why a REASON rides along with the refusal: the two ways a call gets refused are the same to the
// model and opposite to the operator. A condition that is simply unmet is the rule working, and
// pages nobody. A state read that FAILED refused it without knowing anything about the condition —
// and it refuses EVERY guarded call for as long as it lasts, so an operator whose database is
// timing out would otherwise watch every guarded tool go quiet with `info`/`ok` as the only trace.
export type RefusalReason = "unmet" | "unreadable";

export function guardedTool(
  inner: StructuredToolInterface,
  cond: ToolPrecondition,
  loadState: () => Promise<PreconditionState>,
  onRefused?: (info: {
    tool: string;
    cond: ToolPrecondition;
    reason: RefusalReason;
    err?: unknown;
  }) => void,
): StructuredToolInterface {
  const refusal = unmetPreconditionMessage(inner.name, cond);
  // NOTE: DELEGATION, not a second tool(). Wrapping the inner tool in another `tool()` and calling
  // `inner.invoke` from inside it starts a CHILD tool run under the outer one's callbacks:
  // ToolFlowLogger and Langfuse then record two runs for one model-issued call, and an integration
  // failure inside the inner tool emits its warn — and its alert — twice. Here the prototype carries
  // name, description and schema unchanged, only `invoke` is shadowed, and a permitted call reaches
  // exactly the run it would have had without any of this.
  const guarded = Object.create(inner) as StructuredToolInterface;
  guarded.invoke = (async (input: unknown, config?: ToolRunnableConfig) => {
    let met: boolean;
    let err: unknown;
    let reason: RefusalReason = "unmet";
    try {
      met = evaluatePrecondition(cond, await loadState());
    } catch (e) {
      // NOTE: FAIL CLOSED, the same way the contact-authorization gate does. A precondition exists because
      // running the tool wrongly costs something the operator cannot undo (a conversation handed to
      // a human, a document issued); a state read that failed cannot tell us the cost is safe to
      // pay. The model is told the same sentence either way, so a database blip does not become a
      // customer-visible difference in what the agent says.
      // NOTE: The exception is carried OUT, not swallowed. Failing closed is the right answer to the
      // model and the wrong answer to the operator: the two cases are indistinguishable downstream
      // unless the reason travels with the refusal.
      met = false;
      err = e;
      reason = "unreadable";
    }
    if (met) return inner.invoke(input as never, config);
    onRefused?.({ tool: inner.name, cond, reason, err });
    // NOTE: ToolNode hands the whole tool call in as the input, so the id is on it; a direct invocation
    // with plain args (a unit test) has none, and the plain string is the honest degradation there —
    // the same shape failableTool settled on.
    const id =
      (input as { type?: string; id?: string } | null)?.type === "tool_call"
        ? (input as { id?: string }).id
        : config?.toolCall?.id;
    if (!id) return refusal;
    return new ToolMessage({
      content: refusal,
      tool_call_id: id,
      name: inner.name,
    });
  }) as StructuredToolInterface["invoke"];
  return guarded;
}

// Applies the whole map in one pass. Names with no condition come through untouched and identical,
// so an agent that configured nothing pays exactly nothing — no wrapper, no state read, no change to
// what the provider is sent.
export function applyToolPreconditions(
  tools: StructuredToolInterface[],
  preconditions: Record<string, ToolPrecondition>,
  loadState: () => Promise<PreconditionState>,
  onRefused?: (info: {
    tool: string;
    cond: ToolPrecondition;
    reason: RefusalReason;
    err?: unknown;
  }) => void,
  // NOTE: Names that matched NO assembled tool. Configuring a rule and having it match nothing is the
  // one outcome that looks exactly like protection and is not: the console shows the rule, the tool
  // keeps running, and nothing anywhere says the two are unrelated. It happens for reasons the
  // operator did not do on purpose — the grant was removed, an MCP connection came back from an
  // import under a different id and a different exposed name — so it is reported at assembly, where
  // the whole toolset is finally known, rather than never.
  onUnmatched?: (toolNames: string[]) => void,
): StructuredToolInterface[] {
  const names = Object.keys(preconditions);
  if (names.length === 0) return tools;
  if (onUnmatched) {
    const assembled = new Set(tools.map((t) => t.name));
    const unmatched = names.filter((n) => !assembled.has(n));
    if (unmatched.length > 0) onUnmatched(unmatched);
  }
  return tools.map((t) => {
    // NOTE: Own-property only: the map is null-prototype at its source, but this lookup is what a plain
    // object would break — a tool named `toString` would find an inherited function here, and every
    // call to it would be refused by a rule the operator never wrote.
    const cond = Object.hasOwn(preconditions, t.name)
      ? preconditions[t.name]
      : undefined;
    return cond ? guardedTool(t, cond, loadState, onRefused) : t;
  });
}

// The flow-log line for one refusal, and the LEVEL is the whole point of the function existing
// separately: it is the difference between "the operator's rule fired" and "the database is down",
// and it was the same line for both until round 5 of PR #378.
export function preconditionFlowEvent(info: {
  tool: string;
  cond: ToolPrecondition;
  reason: RefusalReason;
  err?: unknown;
}): FlowEvent {
  const unreadable = info.reason === "unreadable";
  return {
    stage: "tool",
    // NOTE: INFO for an unmet condition, deliberately. A precondition refusing a call is the system
    // working as the operator configured it, and warn/error is what reaches the alert channels: a
    // rule that fires on every third conversation would otherwise page all day. It still has to be
    // VISIBLE, because "the agent never hands off any more" is exactly the report this feature will
    // generate, and the answer has to be one line away in the Logs page.
    //
    // NOTE: WARN when the state could not be READ, and that one IS an incident. The refusal was decided
    // by a failed database read rather than by the rule, it applies to every guarded tool at once,
    // and it lasts as long as the fault does — the definition of what an alert channel is for. The
    // model is told the same sentence either way; only the operator sees the difference.
    level: unreadable ? "warn" : "info",
    status: unreadable ? "error" : "ok",
    detail: {
      tool: info.tool,
      phase: unreadable ? "precondition_unreadable" : "precondition",
      preconditionKind: info.cond.kind,
      // NOTE: The KEY, never the value: an attribute bag holds whatever the operator put in it, and a
      // flow-log detail is PII-free by contract (modules/flowlog).
      preconditionKey: info.cond.key,
      preconditionScope: info.cond.scope,
      // NOTE: The error's CLASS, never its message. A driver error carries the failing query — and, in
      // this codebase's own measured case, the connection string — and this detail is rendered in
      // the console.
      ...(unreadable
        ? { error: info.err instanceof Error ? info.err.name : "unknown" }
        : {}),
    },
  };
}

// The line for a rule that matched no assembled tool. INFO, not warn: it is a static
// misconfiguration, so a warn would page the operator once per turn for as long as it stood — but it
// belongs in the same place they will look when the tool they believed was fenced runs anyway.
export function unmatchedPreconditionEvent(toolNames: string[]): FlowEvent {
  return {
    stage: "tool",
    level: "info",
    status: "ok",
    detail: { phase: "precondition_unmatched", tools: toolNames },
  };
}

// Reads the two mirrored bags, scoped, at the moment a guarded tool is called. It is a bounded read
// of two rows and it happens ONLY on a call to a tool that actually carries a condition, which is
// what makes it affordable: the unbounded jsonb the attribute-context block is careful never to
// project on every turn (prepare.ts) is projected here only when a rule is about to be decided.
export function preconditionStateLoader(args: {
  base: PrismaClient;
  tenantId: bigint;
  conversationDbId: bigint | null;
  contactDbId: bigint | null;
}): () => Promise<PreconditionState> {
  const { base, tenantId, conversationDbId, contactDbId } = args;
  return async () =>
    runScopedOn(base, sysCtx(tenantId), async (db) => {
      const [conv, contact] = await Promise.all([
        conversationDbId == null
          ? null
          : db.conversation.findFirst({
              where: { id: conversationDbId },
              select: { customAttributes: true },
            }),
        contactDbId == null
          ? null
          : db.contact.findFirst({
              where: { id: contactDbId },
              select: { customAttributes: true },
            }),
      ]);
      return {
        conversationAttributes: bagOf(conv?.customAttributes),
        contactAttributes: bagOf(contact?.customAttributes),
      };
    });
}

function bagOf(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
