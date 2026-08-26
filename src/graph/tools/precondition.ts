import { ToolMessage } from "@langchain/core/messages";
import {
  type StructuredToolInterface,
  type ToolRunnableConfig,
  tool,
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
  return tool(
    async (input: unknown, config: ToolRunnableConfig) => {
      let met: boolean;
      try {
        met = evaluatePrecondition(cond, await loadState());
      } catch {
        // FAIL CLOSED, the same way the contact-authorization gate does. A precondition exists
        // because running the tool wrongly costs something the operator cannot undo (a conversation
        // handed to a human, a document issued); a state read that failed cannot tell us the cost is
        // safe to pay. The model is told the same sentence either way, so a database blip does not
        // become a customer-visible difference in what the agent says.
        met = false;
      }
      if (met) return inner.invoke(input as never, config);
      onRefused?.({ tool: inner.name, cond });
      const id = config?.toolCall?.id;
      // Without a tool_call in scope (direct invocation, e.g. a unit test) there is no id to answer,
      // so the plain string is the honest degradation — same shape failableTool settled on.
      if (!id) return refusal;
      return new ToolMessage({
        content: refusal,
        tool_call_id: id,
        name: inner.name,
      });
    },
    {
      name: inner.name,
      description: inner.description,
      // The DECLARED schema, unchanged. A guarded tool has to look identical to the model: the point
      // is that the call is refused, not that the tool becomes harder to call correctly.
      schema: inner.schema,
    },
  ) as unknown as StructuredToolInterface;
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
    const cond = preconditions[t.name];
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
