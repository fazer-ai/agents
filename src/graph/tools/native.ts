import type { StructuredToolInterface } from "@langchain/core/tools";
import { tool } from "@langchain/core/tools";
import { z } from "zod";
import type { PrismaClient } from "@/../generated/prisma/client";
import logger from "@/api/lib/logger";
import { failableTool, toolFailure } from "@/graph/tools/failure";
import { runScopedOn, type TenantContext } from "@/lib/tenancy";
import { xmlAttr, xmlEscape } from "@/lib/xml";
import type {
  ChatwootClient,
  CustomAttributeDef,
} from "@/modules/chatwoot/client";
import { type KanbanContext, matchKanbanStep } from "@/modules/chatwoot/kanban";
import {
  attributesForModel,
  type ChatwootVocab,
} from "@/modules/chatwoot/vocab";
import type { HandoffConfig } from "@/modules/handoff/settings";
import {
  type HandoffTargets,
  matchHandoffTarget,
} from "@/modules/handoff/targets";
import { emitOutbound } from "@/modules/webhooks/outbound/service";
import {
  DEFAULT_TIMEZONE,
  formatHumanDateTime,
  formatWithPattern,
  roundDownToMinutes,
} from "../time";
import { CalculatorError, evaluateExpression } from "./calculator";
import {
  NATIVE_TOOL_CATEGORY,
  type NativeToolName,
  UTILITY_NATIVE_TOOL_NAMES,
} from "./catalog";

// Native Chatwoot tools the agent can call mid-turn, all over the bot token. Each is bound to a
// ToolCtx (the conversation + a ready client); the runtime resolves the per-agent allowlist
// (fail-closed: a tool not in the allowlist is never exposed to the model).

export { NATIVE_TOOL_NAMES, type NativeToolName } from "./catalog";

function sysCtx(tenantId: bigint): TenantContext {
  return { tenantId, userId: null, role: "TENANT_ADMIN" };
}

// Mutable per-turn state owned by runLoadedTurn and shared with the tools it builds. Presence
// switches resolve_conversation to DEFERRED mode: the tool records the intent here and the
// runtime applies the actual status toggle only AFTER the final reply is delivered (an
// immediate toggle makes the post-generation recheck read the mirrored "resolved" as a human
// takeover and discard the reply — and the reply would reopen the conversation anyway).
export interface TurnState {
  resolveRequested: boolean;
}

export interface ToolCtx {
  client: ChatwootClient;
  conversationId: number;
  // Absent (nudge turns, playground, hand-built ctx) ⇒ resolve_conversation keeps the legacy
  // immediate toggle. Only runLoadedTurn passes it.
  turnState?: TurnState;
  // Per-agent toggle (default ON when undefined): when false, a handoff posts NO summary note even
  // if the model supplies a reason — the operator opted out of leaving internal summaries.
  transferWithSummary?: boolean;
  // Per-agent handoff targeting (route | pinned | agent_choice). Absent ⇒ route (current behavior).
  handoff?: HandoffConfig;
  // For agent_choice: the live agents/teams (resolved at turn prep), surfaced in the tool description
  // so the model picks a real name, and used to resolve that name → id. Absent ⇒ resolved live at
  // call time (and the description falls back to generic text).
  handoffTargets?: HandoffTargets;
  // For set_voice_preference (a DB write to Contact.voiceReply, RLS-scoped). Absent on paths
  // without a mirrored contact (the tool then no-ops with a message).
  tenantId?: bigint;
  base?: PrismaClient;
  contactDbId?: bigint | null;
  // NOTE: Our Conversation row id, for the write-through that keeps the mirrored attribute bags in
  // step right after set_custom_attribute writes to Chatwoot (see mirrorAttributeWrite). Absent ⇒
  // the write-through is skipped and the mirror catches up on the next webhook event.
  conversationDbId?: bigint | null;
  // The contact's CURRENT stored voice preference (snapshot at turn prep), surfaced in the
  // set_voice_preference description so the model knows the existing value before changing it.
  // true = audio, false = text, null/undefined = not set yet.
  contactVoiceReply?: boolean | null;
  // IANA timezone for the get_current_time utility tool (the agent's BusinessHours.timezone,
  // falling back to DEFAULT_TIMEZONE).
  timezone?: string;
  // The account's labels + custom-attribute definitions (resolved at turn prep, best-effort), so
  // assign_label / set_custom_attribute enumerate KNOWN values in their descriptions instead of
  // letting the model guess. Absent ⇒ the tools fall back to generic descriptions.
  vocab?: ChatwootVocab;
  // This conversation's kanban card context (board + current step + available steps + card snapshot),
  // resolved at turn prep when kanban_move_card is granted. Lets kanban_move_card take a STEP NAME (the
  // model can't know ids), surface the funnel state, and set_custom_attribute target the task. Absent ⇒
  // no linked card / not granted.
  kanban?: KanbanContext;
  // Per-agent, per-tool operator guidance (keyed by native tool name), appended to that tool's
  // model-facing description so transfer/funnel logic lives WITH the tool instead of buried in the
  // prompt. Populated at turn prep from agent.settings (handoff.instructions / kanban.instructions).
  toolInstructions?: Partial<Record<NativeToolName, string>>;
}

// Assembles a tool's final model-facing description in a fixed order: the static capability text,
// then the operator's per-tool guidance (if any), then the dynamic per-turn context as an XML block
// LAST (current state the model acts on). Each part is clearly delimited so the capability is never
// shadowed and the live snapshot reads as a distinct "current state" section at the very end.
function withOperatorNote(
  base: string,
  ctx: ToolCtx,
  name: NativeToolName,
  context?: string,
): string {
  const note = ctx.toolInstructions?.[name]?.trim();
  const parts = [base];
  if (note) parts.push(`Operator guidance: ${note}`);
  if (context?.trim()) parts.push(context.trim());
  return parts.join("\n\n");
}

// Renders the agent_choice routing targets as an XML block (agents then teams, each group capped so a
// large account doesn't bloat the prompt; overflow noted as <more count="N"/>). The <agent>/<team>
// names are the valid values for the `assignTo` arg. Empty ⇒ "" (description falls back to generic).
function handoffTargetsXml(targets: HandoffTargets | undefined): string {
  if (!targets) return "";
  const CAP = 25;
  const render = (tag: "agent" | "team", names: string[]): string[] => {
    const out = names
      .slice(0, CAP)
      .map((n) => `  <${tag}>${xmlEscape(n)}</${tag}>`);
    if (names.length > CAP) out.push(`  <more count="${names.length - CAP}"/>`);
    return out;
  };
  const lines: string[] = [];
  if (targets.agents.length > 0)
    lines.push(
      ...render(
        "agent",
        targets.agents.map((a) => a.name),
      ),
    );
  if (targets.teams.length > 0)
    lines.push(
      ...render(
        "team",
        targets.teams.map((t) => t.name),
      ),
    );
  if (lines.length === 0) return "";
  return `<handoff_targets>\n${lines.join("\n")}\n</handoff_targets>`;
}

function handoffTool(ctx: ToolCtx) {
  const mode = ctx.handoff?.mode ?? "route";
  const agentChoice = mode === "agent_choice";
  // Live target names, surfaced as an XML block at the end of the description so the model routes to a
  // REAL agent/team without the operator having to list them in the prompt. Empty when none were
  // resolved (degrade to generic text + a private note on a miss, never a silent no-op).
  const targetsXml = agentChoice ? handoffTargetsXml(ctx.handoffTargets) : "";
  const coreDescription = agentChoice
    ? targetsXml
      ? "Escalate the conversation to a human agent. Set `assignTo` to one of the agents/teams listed in `<handoff_targets>` below to route there; omit it to fall back to default routing. Optionally include a short summary (posted as a private note)."
      : "Escalate the conversation to a human agent. Optionally include a short summary (posted as a private note) and `assignTo` — the name of the agent or team to route to (use one of the names from your instructions); omit it to fall back to default routing."
    : "Escalate the conversation to a human agent. Optionally include a short summary that is posted as a private note before the handoff. Use when the customer needs human help or asks for it.";
  // Always nudge a customer-facing reply before the handoff so the persona does not go silent on them.
  const baseDescription = `${coreDescription} Before transferring, set \`customerMessage\` to a brief reply to the customer (e.g. that a human will continue) so they are not left without an answer.`;
  return tool(
    async ({
      reason,
      assignTo,
      customerMessage,
    }: {
      reason?: string;
      assignTo?: string;
      customerMessage?: string;
    }) => {
      // Reply to the CUSTOMER first (the persona's closing line) so they are not left in silence once
      // the bot goes quiet after the handoff. Best-effort — a send failure must not block the transfer.
      if (customerMessage?.trim()) {
        try {
          await ctx.client.sendMessage(
            ctx.conversationId,
            customerMessage.trim(),
          );
        } catch (e) {
          logger.warn(
            "handoff customer message failed (conv=%s): %s",
            String(ctx.conversationId),
            e instanceof Error ? e.message : String(e),
          );
        }
      }
      // Transfer-with-summary: a private note for the human BEFORE handing off, gated by the
      // per-agent toggle (default on).
      if (reason && ctx.transferWithSummary !== false) {
        await ctx.client.sendPrivateNote(ctx.conversationId, reason);
      }
      // Set status `open` → the conversation leaves `pending`, so the attribution gate stops the
      // bot and the human queue picks it up.
      await ctx.client.toggleStatus(ctx.conversationId, "open");

      // Optional targeting (best-effort: the handoff already happened, so an assignment failure must
      // not break the turn). In `route` mode nothing is assigned (Chatwoot routes).
      let assigned = "";
      try {
        if (mode === "pinned") {
          if (ctx.handoff?.targetAgentId) {
            await ctx.client.assignToAgent(
              ctx.conversationId,
              ctx.handoff.targetAgentId,
            );
            assigned = " Assigned to the configured agent.";
          } else if (ctx.handoff?.targetTeamId) {
            await ctx.client.assignTeam(
              ctx.conversationId,
              ctx.handoff.targetTeamId,
            );
            assigned = " Assigned to the configured team.";
          }
        } else if (agentChoice && assignTo?.trim()) {
          // Resolve against the list grounded at turn prep; fall back to a live read only if it was
          // not pre-resolved (e.g. the prep-time fetch failed).
          const targets = ctx.handoffTargets ?? {
            agents: await ctx.client.listAgents(),
            teams: await ctx.client.listTeams(),
          };
          const target = matchHandoffTarget(targets, assignTo);
          if (target?.kind === "agent") {
            await ctx.client.assignToAgent(ctx.conversationId, target.id);
            assigned = ` Assigned to ${target.name}.`;
          } else if (target?.kind === "team") {
            await ctx.client.assignTeam(ctx.conversationId, target.id);
            assigned = ` Assigned to team ${target.name}.`;
          } else {
            // No match: surface it instead of failing silently — a private note tells the human the
            // intended target, and the conversation falls back to default routing.
            await ctx.client.sendPrivateNote(
              ctx.conversationId,
              `Tentei encaminhar para "${assignTo}", mas não encontrei um agente ou time com esse nome no Chatwoot. Deixei no roteamento padrão.`,
            );
            assigned = ` No agent/team named "${assignTo}" was found; left for default routing.`;
          }
        }
      } catch (e) {
        logger.warn(
          "handoff assignment failed (conv=%s): %s",
          String(ctx.conversationId),
          e instanceof Error ? e.message : String(e),
        );
      }
      return `Handed off to a human (status set to open).${assigned} The bot will stay silent now.`;
    },
    {
      name: "handoff_to_human",
      description: withOperatorNote(
        baseDescription,
        ctx,
        "handoff_to_human",
        targetsXml,
      ),
      schema: agentChoice
        ? z.object({
            reason: z
              .string()
              .optional()
              .describe(
                "Short private-note summary for the human taking over.",
              ),
            customerMessage: z
              .string()
              .optional()
              .describe(
                "A short message to the CUSTOMER, sent before the transfer (e.g. that a human will continue). Strongly recommended so they are not left without a reply.",
              ),
            assignTo: z
              .string()
              .optional()
              .describe(
                "Name of the agent or team to route to; see the tool description for the valid names. Omit to use default routing.",
              ),
          })
        : z.object({
            reason: z
              .string()
              .optional()
              .describe(
                "Short private-note summary for the human taking over.",
              ),
            customerMessage: z
              .string()
              .optional()
              .describe(
                "A short message to the CUSTOMER, sent before the transfer (e.g. that a human will continue). Strongly recommended so they are not left without a reply.",
              ),
          }),
    },
  );
}

function privateNoteTool(ctx: ToolCtx) {
  return tool(
    async ({ content }: { content: string }) => {
      await ctx.client.sendPrivateNote(ctx.conversationId, content);
      return "Private note posted (visible to agents, not the customer).";
    },
    {
      name: "private_note",
      description:
        "Leave an internal note for the human team (NOT visible to the customer). Use it to record context a human will need later — a special request, a caveat, something to follow up on. To escalate to a human right now, use handoff_to_human instead.",
      schema: z.object({ content: z.string().min(1) }),
    },
  );
}

// Renders one scope's known attribute keys (with allowed values for list types) as XML <attribute>
// elements, capped so a large account never bloats the prompt. `key` mirrors the tool's key arg;
// `values` (list types) enumerates valid values for the value arg.
function attributeElements(defs: CustomAttributeDef[]): string {
  const CAP = 30;
  const els = defs.slice(0, CAP).map((d) => {
    const values =
      d.displayType === "list" && d.values.length > 0
        ? xmlAttr("values", d.values.slice(0, 12).join("|"))
        : "";
    return `    <attribute${xmlAttr("key", d.key)}${values}/>`;
  });
  if (defs.length > CAP) els.push(`    <more count="${defs.length - CAP}"/>`);
  return els.join("\n");
}

// The known attributes per scope as an XML block (containers mirror the `scope` arg). A scope with no
// known keys still emits its (self-closing) container so the model sees the scope exists.
function knownAttributesXml(
  convDefs: CustomAttributeDef[],
  contactDefs: CustomAttributeDef[],
  taskDefs: CustomAttributeDef[] | null,
): string {
  const scope = (tag: string, defs: CustomAttributeDef[]): string => {
    const inner = attributeElements(defs);
    return inner ? `  <${tag}>\n${inner}\n  </${tag}>` : `  <${tag}/>`;
  };
  const blocks = [
    scope("conversation", convDefs),
    scope("contact", contactDefs),
  ];
  if (taskDefs) blocks.push(scope("task", taskDefs));
  return `<known_attributes>\n${blocks.join("\n")}\n</known_attributes>`;
}

// NOTE: Write-through of a just-written attribute into OUR mirrored bag, so the attribute-context
// block (built from the mirror at turn prep) reflects it immediately. Chatwoot is still the source
// of truth: the next webhook event overwrites the bag wholesale. This only closes the window where a
// proactive nudge — which is not preceded by an inbound event — would otherwise read a stale value,
// and it matters most for the contact scope (Chatwoot does not deliver contact_updated to bots).
//
// The merge is a single `jsonb || jsonb` UPDATE rather than a read-modify-write: a turn can emit
// several set_custom_attribute calls and the tool node runs them CONCURRENTLY, so a read-then-write
// would let two calls on the same scope clobber each other's key. Postgres takes the row lock for
// the duration of the statement, so the distinct keys both survive.
// Best-effort: any failure is logged and swallowed, never surfaced to the model.
async function mirrorAttributeWrite(
  ctx: ToolCtx,
  scope: "conversation" | "contact" | "task",
  key: string,
  value: string,
): Promise<void> {
  if (!ctx.base || ctx.tenantId == null) return;
  const base = ctx.base;
  const tenantId = ctx.tenantId;
  const patch = JSON.stringify({ [key]: value });
  try {
    await runScopedOn(base, sysCtx(tenantId), async (db) => {
      if (scope === "contact") {
        if (ctx.contactDbId == null) return;
        // NOTE: The write-through also ADVANCES the contact's source watermark. Chatwoot accepted
        // this key a moment ago, so every event generated before now carries a pre-write snapshot —
        // and one of those, delivered late but still stamped after the last mirrored event, would
        // otherwise pass upsertContact's compare-and-set and replace the whole bag, erasing the key
        // we just wrote. It matters here and not on the conversation scopes because agent bots
        // never get contact_updated, so nothing would put the key back. GREATEST (which ignores
        // NULL) keeps it from moving backwards if Chatwoot's clock runs ahead of ours.
        //
        // `AT TIME ZONE 'UTC'` is load-bearing: the column is TIMESTAMP (no zone) holding UTC, and
        // bare NOW() is timestamptz. Mixing them makes GREATEST resolve through the SESSION
        // TimeZone, which nothing here pins — under a non-UTC session the stored value reads as
        // offset-hours in the future and wins, so the barrier silently never advances.
        await db.$executeRaw`
          UPDATE contacts
          SET custom_attributes = custom_attributes || ${patch}::jsonb,
              custom_attributes_at = GREATEST(
                custom_attributes_at,
                (NOW() AT TIME ZONE 'UTC')
              )
          WHERE id = ${ctx.contactDbId} AND tenant_id = ${tenantId}
        `;
        return;
      }
      if (ctx.conversationDbId == null) return;
      if (scope === "task") {
        await db.$executeRaw`
          UPDATE conversations
          SET kanban_attributes = kanban_attributes || ${patch}::jsonb
          WHERE id = ${ctx.conversationDbId} AND tenant_id = ${tenantId}
        `;
        return;
      }
      await db.$executeRaw`
        UPDATE conversations
        SET custom_attributes = custom_attributes || ${patch}::jsonb
        WHERE id = ${ctx.conversationDbId} AND tenant_id = ${tenantId}
      `;
    });
  } catch (e) {
    logger.warn(
      "attribute mirror write-through failed (scope=%s): %s",
      scope,
      e instanceof Error ? e.message : String(e),
    );
  }
}

// Set a custom attribute on the conversation OR the contact. The valid keys (and list values) of
// each scope are enumerated in the description from the account's definitions (ctx.vocab), so the
// model writes a KNOWN key instead of inventing one. Contact scope resolves the Chatwoot contact id
// from our mirror and merges (the client read-merge-writes so other contact attributes are kept).
function setCustomAttributeTool(ctx: ToolCtx) {
  const convDefs = attributesForModel(ctx.vocab, "conversation_attribute");
  const contactDefs = attributesForModel(ctx.vocab, "contact_attribute");
  const taskDefs = attributesForModel(ctx.vocab, "task_attribute");
  // 'task' scope is only offered when this conversation actually has a linked card (ctx.kanban).
  const taskScope = !!ctx.kanban;
  const scopeSchema = taskScope
    ? z.enum(["conversation", "contact", "task"])
    : z.enum(["conversation", "contact"]);
  const description = ctx.vocab
    ? `Set a custom attribute on the conversation, the contact${taskScope ? ", or this conversation's kanban card" : ""}. Use \`scope\` to choose; the known keys (and allowed values for list types) per scope are listed in \`<known_attributes>\` below.`
    : "Set a custom attribute on the conversation (scope='conversation', default) or the contact (scope='contact').";
  const attributesXml = ctx.vocab
    ? knownAttributesXml(convDefs, contactDefs, taskScope ? taskDefs : null)
    : undefined;
  return tool(
    async ({
      key,
      value,
      scope,
    }: {
      key: string;
      value: string;
      scope?: "conversation" | "contact" | "task";
    }) => {
      if (scope === "task") {
        if (!ctx.kanban) {
          return "Could not set the task attribute (this conversation has no linked card).";
        }
        await ctx.client.setKanbanTaskCustomAttributes(ctx.kanban.taskId, {
          [key]: value,
        });
        await mirrorAttributeWrite(ctx, "task", key, value);
        return `Task attribute ${key} set.`;
      }
      if (scope === "contact") {
        if (!ctx.base || ctx.tenantId == null || ctx.contactDbId == null) {
          return "Could not set the contact attribute (no contact in scope).";
        }
        const tenantId = ctx.tenantId;
        const contactDbId = ctx.contactDbId;
        const contact = await runScopedOn(ctx.base, sysCtx(tenantId), (db) =>
          db.contact.findUnique({
            where: { id: contactDbId },
            select: { chatwootContactId: true },
          }),
        );
        if (!contact?.chatwootContactId) {
          return "Could not set the contact attribute (contact not linked to Chatwoot).";
        }
        await ctx.client.setContactCustomAttributes(contact.chatwootContactId, {
          [key]: value,
        });
        await mirrorAttributeWrite(ctx, "contact", key, value);
        return `Contact attribute ${key} set.`;
      }
      await ctx.client.setConversationCustomAttributes(ctx.conversationId, {
        [key]: value,
      });
      await mirrorAttributeWrite(ctx, "conversation", key, value);
      return `Conversation attribute ${key} set.`;
    },
    {
      name: "set_custom_attribute",
      description: withOperatorNote(
        description,
        ctx,
        "set_custom_attribute",
        attributesXml,
      ),
      schema: z.object({
        key: z.string().min(1),
        value: z.string(),
        scope: scopeSchema
          .optional()
          .describe(
            `Where to store it: 'conversation' (default), 'contact'${taskScope ? ", or 'task'" : ""}.`,
          ),
      }),
    },
  );
}

// The account's existing labels as an XML block (the valid/preferred values for the `label` arg),
// capped so a large account never bloats the prompt. Empty ⇒ "" (no block).
function existingLabelsXml(labels: string[]): string {
  if (labels.length === 0) return "";
  const CAP = 40;
  const els = labels
    .slice(0, CAP)
    .map((l) => `  <label>${xmlEscape(l)}</label>`);
  if (labels.length > CAP) els.push(`  <more count="${labels.length - CAP}"/>`);
  return `<existing_labels>\n${els.join("\n")}\n</existing_labels>`;
}

// Adds a label (tag) to the conversation, the contact, or this conversation's kanban card (scope,
// default 'conversation'). Labels are admin-token only and every backing endpoint REPLACES the whole
// set, so we read the current labels and append (idempotent — a label already present is a no-op).
// Shapes confirmed against the chatwoot-pro fork: conversation + contact labels GET → { payload: [] },
// POST /{conversations|contacts}/{id}/labels { labels } replaces (LabelConcern); task labels via PATCH
// /kanban/tasks/{id} { task: { labels } } (update_labels), with the current set read from the card
// snapshot. NOTE: the enumerated labels are the account's Label titles; task tags may use a separate
// taggable namespace on the fork — confirm live before relying on the suggestion for task scope.
function assignLabelTool(ctx: ToolCtx) {
  const labelsXml = existingLabelsXml(ctx.vocab?.labels ?? []);
  // 'task' scope is only offered when this conversation actually has a linked card (ctx.kanban).
  const taskScope = !!ctx.kanban;
  const scopeSchema = taskScope
    ? z.enum(["conversation", "contact", "task"])
    : z.enum(["conversation", "contact"]);
  const baseDescription = `Add a label (tag) to categorize the conversation, the contact${taskScope ? ", or this conversation's kanban card" : ""}. Use scope to choose (default 'conversation'). Existing labels are kept.${labelsXml ? " Prefer an EXISTING label from `<existing_labels>` below." : ""}`;
  return tool(
    async ({
      label,
      scope,
    }: {
      label: string;
      scope?: "conversation" | "contact" | "task";
    }) => {
      const clean = label.trim();
      if (!clean) return "No label provided.";
      if (scope === "task") {
        if (!ctx.kanban) {
          return "Could not add the label (this conversation has no linked card).";
        }
        const current = ctx.kanban.card.labels;
        if (current.includes(clean)) {
          return `Label "${clean}" was already on the card.`;
        }
        await ctx.client.setKanbanTaskLabels(ctx.kanban.taskId, [
          ...current,
          clean,
        ]);
        return `Label "${clean}" added to the kanban card.`;
      }
      if (scope === "contact") {
        if (!ctx.base || ctx.tenantId == null || ctx.contactDbId == null) {
          return "Could not add the contact label (no contact in scope).";
        }
        const tenantId = ctx.tenantId;
        const contactDbId = ctx.contactDbId;
        const contact = await runScopedOn(ctx.base, sysCtx(tenantId), (db) =>
          db.contact.findUnique({
            where: { id: contactDbId },
            select: { chatwootContactId: true },
          }),
        );
        if (!contact?.chatwootContactId) {
          return "Could not add the contact label (contact not linked to Chatwoot).";
        }
        const current = await ctx.client.getContactLabels(
          contact.chatwootContactId,
        );
        if (current.includes(clean)) {
          return `Label "${clean}" was already on the contact.`;
        }
        await ctx.client.setContactLabels(contact.chatwootContactId, [
          ...current,
          clean,
        ]);
        return `Label "${clean}" added to the contact.`;
      }
      const current = await ctx.client.getConversationLabels(
        ctx.conversationId,
      );
      if (current.includes(clean)) return `Label "${clean}" was already set.`;
      await ctx.client.setConversationLabels(ctx.conversationId, [
        ...current,
        clean,
      ]);
      return `Label "${clean}" added to the conversation.`;
    },
    {
      name: "assign_label",
      description: withOperatorNote(
        baseDescription,
        ctx,
        "assign_label",
        labelsXml,
      ),
      schema: z.object({
        label: z
          .string()
          .min(1)
          .describe("The label/tag to add, e.g. 'vip' or 'orçamento'."),
        scope: scopeSchema
          .optional()
          .describe(
            `Where to add it: 'conversation' (default), 'contact'${taskScope ? ", or 'task'" : ""}.`,
          ),
      }),
    },
  );
}

function resolveConversationTool(ctx: ToolCtx) {
  const deferred = ctx.turnState !== undefined;
  return tool(
    async () => {
      const ts = ctx.turnState;
      if (ts) {
        // Deferred: the runtime toggles the status after the final reply is delivered. The
        // wording stays conditional on purpose — the intent is discarded on takeover/supersede,
        // and a flat "resolved" would be a false claim in the checkpointed thread history.
        ts.resolveRequested = true;
        return "Resolve scheduled: the conversation will be marked resolved after your final reply in this turn is delivered.";
      }
      await ctx.client.toggleStatus(ctx.conversationId, "resolved");
      return "Conversation resolved.";
    },
    {
      name: "resolve_conversation",
      description: deferred
        ? "Mark the conversation as resolved when the customer's request is fully handled. The status change is applied automatically after your final reply this turn is delivered — write any closing confirmation as your normal reply."
        : "Mark the conversation as resolved when the customer's request is fully handled.",
      schema: z.object({}),
    },
  );
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

// THIS card's funnel position as an XML block for kanban_move_card: the current step plus the
// available steps (each step name is a valid value for the `targetStep` arg; the operator's per-step
// note is the element text and cancelled/lost steps carry status="cancelled" — the "dedicated
// funnel-step description" surfaced from Chatwoot itself).
function kanbanMoveContextXml(k: KanbanContext): string {
  const lines: string[] = [`<kanban_card${xmlAttr("board", k.boardName)}>`];
  if (k.currentStepName)
    lines.push(
      `  <current_step>${xmlEscape(k.currentStepName)}</current_step>`,
    );
  if (k.steps.length > 0) {
    lines.push("  <available_steps>");
    for (const s of k.steps) {
      const status = s.cancelled ? ' status="cancelled"' : "";
      lines.push(
        s.description
          ? `    <step${xmlAttr("name", s.name)}${status}>${xmlEscape(s.description)}</step>`
          : `    <step${status}>${xmlEscape(s.name)}</step>`,
      );
    }
    lines.push("  </available_steps>");
  }
  lines.push("</kanban_card>");
  return lines.join("\n");
}

// THIS card's current EDITABLE fields as an XML block for update_kanban_task — the exact set the tool
// can change, with element names mirroring its args (title/description/priority/startDate/dueDate).
// Only fields that are set are emitted, so the model patches just what differs without re-dumping the
// whole card (move grounds on the funnel position, update grounds on these fields; no overlap).
function kanbanCardFieldsXml(k: KanbanContext): string {
  const c = k.card;
  const lines: string[] = [`<current_card${xmlAttr("board", k.boardName)}>`];
  if (c.title) lines.push(`  <title>${xmlEscape(c.title)}</title>`);
  if (c.description)
    lines.push(
      `  <description>${xmlEscape(truncate(c.description, 80))}</description>`,
    );
  if (c.priority) lines.push(`  <priority>${xmlEscape(c.priority)}</priority>`);
  if (c.startDate)
    lines.push(`  <startDate>${xmlEscape(c.startDate)}</startDate>`);
  if (c.dueDate) lines.push(`  <dueDate>${xmlEscape(c.dueDate)}</dueDate>`);
  lines.push("</current_card>");
  return lines.join("\n");
}

// Move THIS conversation's Chatwoot Pro kanban card to another funnel step BY NAME. The card id, the
// board's steps (with the operator's per-step notes), and the card's current data are resolved at turn
// prep (ctx.kanban, confirmed against the Pro fork jbuilders: conversation.kanban_task_id →
// task.board_id/board_step_id/title/value/priority/status/custom_attributes → board steps), so the
// model picks a step name with full funnel context — it never has to know ids. No linked card ⇒ the
// tool says so and does nothing.
function kanbanMoveTool(ctx: ToolCtx) {
  const k = ctx.kanban;
  // Move grounds on the funnel position (current step + available steps), surfaced in the XML block;
  // it deliberately does NOT re-list the card's editable fields — update_kanban_task owns those.
  const baseDescription = k
    ? "Move this conversation's kanban card to another funnel step. Pass the target step's name as `targetStep`, picking one from `<available_steps>` below (the card's board and current step are shown there too)."
    : "Move this conversation's kanban card to another funnel step. This conversation has no linked card, so there is nothing to move.";
  const contextXml = k ? kanbanMoveContextXml(k) : undefined;
  return tool(
    async ({ targetStep }: { targetStep: string }) => {
      if (!ctx.kanban) {
        return "This conversation has no linked kanban card, so there is nothing to move.";
      }
      const step = matchKanbanStep(ctx.kanban.steps, targetStep);
      if (!step) {
        return `Unknown funnel step "${targetStep}". Available: ${ctx.kanban.steps
          .map((s) => s.name)
          .join(", ")}.`;
      }
      if (step.id === ctx.kanban.currentStepId) {
        return `The card is already in "${step.name}".`;
      }
      const taskId = ctx.kanban.taskId;
      await ctx.client.moveKanbanTask(taskId, step.id);
      // Best-effort fleet event (ids only — no PII).
      if (ctx.base && ctx.tenantId != null) {
        const tenantId = ctx.tenantId;
        try {
          await runScopedOn(ctx.base, sysCtx(tenantId), (db) =>
            emitOutbound(db, tenantId, "kanban.card_moved", {
              card_id: String(taskId),
              to_step: String(step.id),
              conversation_id: String(ctx.conversationId),
            }),
          );
        } catch (err) {
          logger.warn(
            "outbound emit failed (event=kanban.card_moved): %s",
            err instanceof Error ? err.message : String(err),
          );
        }
      }
      return `Moved the card to "${step.name}".`;
    },
    {
      name: "kanban_move_card",
      description: withOperatorNote(
        baseDescription,
        ctx,
        "kanban_move_card",
        contextXml,
      ),
      schema: z.object({
        targetStep: z
          .string()
          .min(1)
          .describe("The funnel step to move the card to, by name."),
      }),
    },
  );
}

// Update THIS conversation's Chatwoot Pro kanban card scalar fields (title, description, priority,
// scheduled dates) BY a partial patch. The card id is resolved at turn prep (ctx.kanban.taskId, never
// a tool arg) and the card's current values are surfaced (describeCard) so the model can update only
// what changed. Field set CONFIRMED against the Pro fork chatwoot-pro-main (tasks#update task_params +
// Task::PRIORITIES). Moving steps, labels, attributes and the monetary `value` have their own tools, so
// they are deliberately out of scope here. No linked card ⇒ the tool says so and does nothing.
function updateKanbanTaskTool(ctx: ToolCtx) {
  const k = ctx.kanban;
  const baseDescription = `Update this conversation's kanban card: its title, description, priority (one of urgent/high/medium/low) and/or scheduled dates. Provide ONLY the fields you want to change; the card's current values are shown in \`<current_card>\` below. Dates are ISO 8601 (e.g. "2026-06-20" or "2026-06-20T14:00:00-03:00") and the start date must not be after the due date. To move the card between funnel steps, add a label, set a custom attribute or change the amount, use the dedicated tools instead.`;
  const contextXml = k ? kanbanCardFieldsXml(k) : undefined;
  return tool(
    async (input: {
      title?: string;
      description?: string;
      priority?: "urgent" | "high" | "medium" | "low";
      dueDate?: string;
      startDate?: string;
    }) => {
      if (!ctx.kanban) {
        return "This conversation has no linked kanban card, so there is nothing to update.";
      }
      const fields: {
        title?: string;
        description?: string;
        priority?: "urgent" | "high" | "medium" | "low";
        startDate?: string;
        dueDate?: string;
      } = {};
      if (input.title !== undefined) fields.title = input.title;
      if (input.description !== undefined)
        fields.description = input.description;
      if (input.priority !== undefined) fields.priority = input.priority;
      if (input.startDate !== undefined) fields.startDate = input.startDate;
      if (input.dueDate !== undefined) fields.dueDate = input.dueDate;
      if (Object.keys(fields).length === 0) {
        return "No fields provided. Set at least one of title, description, priority, dueDate or startDate.";
      }
      await ctx.client.updateKanbanTask(ctx.kanban.taskId, fields);
      return `Updated the kanban card (${Object.keys(fields).join(", ")}).`;
    },
    {
      name: "update_kanban_task",
      description: withOperatorNote(
        baseDescription,
        ctx,
        "update_kanban_task",
        contextXml,
      ),
      schema: z.object({
        title: z
          .string()
          .min(1)
          .max(255)
          .optional()
          .describe("New card title."),
        description: z
          .string()
          .max(5000)
          .optional()
          .describe("New card description."),
        priority: z
          .enum(["urgent", "high", "medium", "low"])
          .optional()
          .describe("Card priority."),
        dueDate: z
          .string()
          .optional()
          .describe("Due date, ISO 8601 (date or datetime)."),
        startDate: z
          .string()
          .optional()
          .describe("Start date, ISO 8601 (date or datetime)."),
      }),
    },
  );
}

// Records the customer's audio-vs-text reply preference on the Contact (TTS "preference" mode). A
// DB write (RLS-scoped), not a Chatwoot call — the elegant replacement for the n8n custom attribute.
function setVoicePreferenceTool(ctx: ToolCtx) {
  return tool(
    async ({ preference }: { preference: "audio" | "text" | "default" }) => {
      if (!ctx.base || ctx.tenantId == null || ctx.contactDbId == null) {
        return "Could not record the preference (no contact in scope).";
      }
      const contactId = ctx.contactDbId;
      // "default" clears the preference (null) → the reply mirrors the customer's own format
      // (text→text, audio→audio), which is exactly how `shouldReplyWithAudio` treats null.
      const value =
        preference === "audio" ? true : preference === "text" ? false : null;
      await runScopedOn(ctx.base, sysCtx(ctx.tenantId), (db) =>
        db.contact.updateMany({
          where: { id: contactId },
          data: { voiceReply: value },
        }),
      );
      return preference === "default"
        ? "Voice preference reset: replies now mirror what the customer sends (audio→audio, text→text)."
        : `Voice preference saved: the customer prefers ${preference} replies.`;
    },
    {
      name: "set_voice_preference",
      description: `Record whether THIS customer prefers replies as audio (voice notes), as text, or to RESET to the default (mirror what the customer sent — audio gets audio, text gets text). Call when the customer states a preference (e.g. 'me manda áudio', 'prefiro texto', 'tanto faz'/'pode ser dos dois jeitos' → default). Takes effect only when the agent's reply mode is 'preference'. The customer's current stored preference is shown in \`<current_preference>\` below ("not set" ⇒ replies mirror the customer).\n\n<current_preference>${
        ctx.contactVoiceReply === true
          ? "audio"
          : ctx.contactVoiceReply === false
            ? "text"
            : "not set"
      }</current_preference>`,
      schema: z.object({
        preference: z
          .enum(["audio", "text", "default"])
          .describe(
            "audio = wants voice notes; text = wants text; default = reset to mirroring the customer's own format",
          ),
      }),
    },
  );
}

// React to the customer's last message with an emoji (WhatsApp reaction). Targets the newest incoming
// message automatically (the model can't know message ids). Admin token; the endpoint TOGGLES, so
// reacting with the same emoji again removes it. Pair with skip_reply when a reaction is the whole
// response (e.g. the customer sent just "ok"/👍).
function reactToMessageTool(ctx: ToolCtx) {
  return failableTool(
    async ({ emoji }: { emoji: string }) => {
      const e = emoji.trim();
      if (!e) return "Provide an emoji to react with.";
      try {
        const latest = await ctx.client.getLatestIncomingMessage(
          ctx.conversationId,
        );
        if (latest == null) {
          return "No customer message found to react to.";
        }
        // The customer's last message is itself a reaction → WhatsApp can't react to a reaction, and
        // reacting would target the wrong (penultimate) message. Refuse without calling the API.
        if (latest.isReaction) {
          return "The customer's last message is a reaction (emoji), and you can't react to a reaction. Do not react now.";
        }
        await ctx.client.addMessageReaction(ctx.conversationId, latest.id, e);
        return `Reacted with ${e} to the customer's last message.`;
      } catch {
        return toolFailure("Could not add the reaction.");
      }
    },
    {
      name: "react_to_message",
      description:
        "React to the customer's LAST message with a single emoji (a WhatsApp reaction), instead of (or in addition to) a text reply. Use for lightweight acknowledgements — e.g. the customer sent just 'ok', 'obrigado' or an emoji. Reacting with the same emoji again removes it, so don't re-react if you already reacted recently. Do NOT react when the customer's last message is itself a reaction (you can't react to a reaction — the tool will refuse). To answer with a reaction ALONE (no text), call skip_reply afterwards.",
      schema: z.object({
        emoji: z
          .string()
          .min(1)
          .describe("A single emoji to react with (e.g. 👍, ❤️, 😂)."),
      }),
    },
  );
}

// Deliberately produce NO reply this turn. The agent calls this, then ends without any customer-facing
// text, so the runtime posts nothing (it already skips an empty reply). The call is recorded in the
// conversation timeline (via the tool flow log) as a "decided not to respond" marker.
function skipReplyTool(_ctx: ToolCtx) {
  return tool(
    async ({ reason }: { reason?: string }) => {
      return reason
        ? `Acknowledged: not replying this turn (${reason}). Produce no message now.`
        : "Acknowledged: not replying this turn. Produce no message now.";
    },
    {
      name: "skip_reply",
      description:
        "Decide NOT to send any reply this turn. Use ONLY when a reply would add nothing — e.g. the customer sent just an acknowledgement ('ok', 'blz', 'obrigado') or a bare emoji/reaction, and you've optionally already reacted with react_to_message. After calling this, output NO reply text (end your turn). The decision is recorded in the conversation timeline.",
      schema: z.object({
        reason: z
          .string()
          .optional()
          .describe(
            "Short reason for not replying (e.g. \"customer only sent 'ok'\").",
          ),
      }),
    },
  );
}

// Utility tool: exact arithmetic without a model round-trip. Context-free, so it is also exposed
// in the playground (where there is no conversation to act on).
function calculatorTool(_ctx: ToolCtx) {
  return tool(
    async ({ expression }: { expression: string }) => {
      try {
        const value = evaluateExpression(expression);
        return `${expression} = ${value}`;
      } catch (e) {
        const reason = e instanceof CalculatorError ? e.message : "invalid";
        return `Could not evaluate "${expression}" (${reason}).`;
      }
    },
    {
      name: "calculator",
      description:
        "Evaluate an arithmetic expression exactly (supports + - * / % ^ and parentheses). Use for any math instead of computing it yourself.",
      schema: z.object({
        expression: z
          .string()
          .min(1)
          .describe("Arithmetic expression, e.g. (12.5 * 3) + 2^4."),
      }),
    },
  );
}

// Utility tool: the current date/time in the agent's timezone, optionally floored to a slot (so
// the model can reason about "now" without it being baked into a cached system prompt).
function getCurrentTimeTool(ctx: ToolCtx) {
  return tool(
    async ({ roundToMinutes }: { roundToMinutes?: number }) => {
      const tz = ctx.timezone || DEFAULT_TIMEZONE;
      const now =
        roundToMinutes && roundToMinutes > 0
          ? roundDownToMinutes(new Date(), roundToMinutes)
          : new Date();
      const iso = formatWithPattern(now, tz, "YYYY-MM-DD HH:mm");
      return `${formatHumanDateTime(now, tz)} (${iso}, ${tz})`;
    },
    {
      name: "get_current_time",
      description:
        "Get the current date and time in the agent's timezone. Use when the customer asks about today's date, the current time, or scheduling relative to 'now'.",
      schema: z.object({
        roundToMinutes: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Optionally floor the time to this many minutes, e.g. 30."),
      }),
    },
  );
}

// allowed = undefined → all native tools; otherwise only the named subset (fail-closed).
export function buildNativeTools(
  ctx: ToolCtx,
  allowed?: Iterable<string>,
): StructuredToolInterface[] {
  const all: StructuredToolInterface[] = [
    handoffTool(ctx),
    privateNoteTool(ctx),
    setCustomAttributeTool(ctx),
    assignLabelTool(ctx),
    resolveConversationTool(ctx),
    kanbanMoveTool(ctx),
    updateKanbanTaskTool(ctx),
    setVoicePreferenceTool(ctx),
    reactToMessageTool(ctx),
    skipReplyTool(ctx),
    calculatorTool(ctx),
    getCurrentTimeTool(ctx),
  ];
  if (!allowed) return all;
  const allow = new Set(allowed);
  return all.filter((t) => allow.has(t.name));
}

// Restricts a native allowlist to the UTILITY family (calculator/clock). The playground injects
// this so context-free tools work there while conversation tools (which need a live client) stay
// out. `allowed` undefined ⇒ all utility tools; otherwise the intersection with the agent's set.
export function utilityNativeAllow(allowed?: Iterable<string>): string[] {
  if (!allowed) return [...UTILITY_NATIVE_TOOL_NAMES];
  const set = new Set(allowed);
  return UTILITY_NATIVE_TOOL_NAMES.filter((n) => set.has(n));
}

// Replaces a tool's execution with a no-op that returns a synthetic success — keeps the model-facing
// name/description/schema so the agent can still decide to call it, but nothing happens for real.
function simulatedTool(orig: StructuredToolInterface): StructuredToolInterface {
  return tool(
    async () =>
      `[simulated] '${orig.name}' was called — no real effect in the playground.`,
    { name: orig.name, description: orig.description, schema: orig.schema },
  );
}

// Playground variant of buildNativeTools: the CONVERSATION tools (handoff/resolve/note/…) are
// SIMULATED (no Chatwoot call, no fleet event — kanban_move would otherwise emit a real outbound
// event), so the agent's DECISION to call them is testable. UTILITY tools (calculator/clock) keep
// their real, side-effect-free behavior. `allowed` is the agent's own native allowlist.
export function buildSimulatedNativeTools(
  ctx: ToolCtx,
  allowed?: Iterable<string>,
): StructuredToolInterface[] {
  return buildNativeTools(ctx, allowed).map((tl) =>
    NATIVE_TOOL_CATEGORY[tl.name as NativeToolName] === "utility"
      ? tl
      : simulatedTool(tl),
  );
}
