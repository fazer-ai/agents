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
export function guardedTool(
  inner: StructuredToolInterface,
  cond: ToolPrecondition,
  loadState: () => Promise<PreconditionState>,
  onRefused?: (info: { tool: string; cond: ToolPrecondition }) => void,
): StructuredToolInterface {
  const refusal = unmetPreconditionMessage(inner.name, cond);
  // DELEGATION, not a second tool(). Wrapping the inner tool in another `tool()` and calling
  // `inner.invoke` from inside it starts a CHILD tool run under the outer one's callbacks:
  // ToolFlowLogger and Langfuse then record two runs for one model-issued call, and an integration
  // failure inside the inner tool emits its warn — and its alert — twice. Here the prototype carries
  // name, description and schema unchanged, only `invoke` is shadowed, and a permitted call reaches
  // exactly the run it would have had without any of this.
  const guarded = Object.create(inner) as StructuredToolInterface;
  guarded.invoke = (async (input: unknown, config?: ToolRunnableConfig) => {
    let met: boolean;
    try {
      met = evaluatePrecondition(cond, await loadState());
    } catch {
      // FAIL CLOSED, the same way the contact-authorization gate does. A precondition exists because
      // running the tool wrongly costs something the operator cannot undo (a conversation handed to
      // a human, a document issued); a state read that failed cannot tell us the cost is safe to
      // pay. The model is told the same sentence either way, so a database blip does not become a
      // customer-visible difference in what the agent says.
      met = false;
    }
    if (met) return inner.invoke(input as never, config);
    onRefused?.({ tool: inner.name, cond });
    // ToolNode hands the whole tool call in as the input, so the id is on it; a direct invocation
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
  onRefused?: (info: { tool: string; cond: ToolPrecondition }) => void,
): StructuredToolInterface[] {
  if (Object.keys(preconditions).length === 0) return tools;
  return tools.map((t) => {
    // Own-property only: the map is null-prototype at its source, but this lookup is what a plain
    // object would break — a tool named `toString` would find an inherited function here, and every
    // call to it would be refused by a rule the operator never wrote.
    const cond = Object.hasOwn(preconditions, t.name)
      ? preconditions[t.name]
      : undefined;
    return cond ? guardedTool(t, cond, loadState, onRefused) : t;
  });
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
