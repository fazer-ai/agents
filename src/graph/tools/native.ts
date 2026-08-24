import type { StructuredToolInterface } from "@langchain/core/tools";
import { tool } from "@langchain/core/tools";
import { z } from "zod";
import type { PrismaClient } from "@/../generated/prisma/client";
import logger from "@/api/lib/logger";
import { failableTool, toolFailure } from "@/graph/tools/failure";
import { runScopedOn, type TenantContext } from "@/lib/tenancy";
import { clipText } from "@/lib/text";
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
import {
  type ObservedConversation,
  observeBeforeClose,
  recordResolutionOrigin,
} from "@/modules/conversations/record-resolution";
import type { HandoffConfig } from "@/modules/handoff/settings";
import {
  type HandoffTargets,
  matchHandoffTarget,
} from "@/modules/handoff/targets";
import {
  fetchImageForDelivery,
  type ImageFetchDeps,
  type ImageFetchFailure,
} from "@/modules/images/fetch";
import {
  SEND_IMAGE_DEFAULTS,
  SEND_IMAGE_MAX_CAPTION_CHARS,
  SEND_IMAGE_MAX_PER_TURN,
  SEND_IMAGE_MAX_TURN_BYTES,
  type SendImageConfig,
} from "@/modules/images/settings";
import type { SideEffectErrorReporter } from "@/modules/integrations/toolpacks";
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
  // Files the agent asked to send this turn, loaded and validated but NOT yet delivered. They ride
  // the same post-time pipeline as the reply (ownership recheck, supersede gate, output guardrail),
  // because a tool that posts from inside the graph invocation can message a customer whose turn is
  // then discarded — the same reason resolve_conversation is deferred.
  //
  // ONE queue for every tool that attaches something (send_image, a document tool): the gates a file
  // has to pass to reach a customer are a property of the TURN, not of what the file is, and a second
  // queue would be a second place to remember them.
  pendingAttachments: PendingAttachment[];
  // Downloads accepted but not yet queued. LangGraph's ToolNode runs one response's tool calls with
  // Promise.all, so a batch of send_image calls all reach the ceiling check before any of them has
  // queued anything: without a reservation taken BEFORE the await, every call in the batch reads the
  // same empty queue, passes, and the ceiling means nothing.
  imagesInFlight: number;
  // Documents issued but not yet queued. Same reservation as imagesInFlight and for the same reason,
  // with a ceiling of one: without it a batch of document calls all read an empty queue, all issue a
  // numbered document, and all but one of those rows is discarded unsent.
  documentsInFlight: number;
  // Monotonic ticket, taken before the download for the same reason: the batch runs concurrently, so
  // the queue fills in COMPLETION order and the customer would receive the pictures — and the
  // captions written for them — in whatever order the hosts happened to answer. The order the model
  // asked for is the one that matches the words around them.
  attachmentsSeq: number;
}

// Isolated from TurnState on purpose: reactive turns and proactive nudges share handoff delivery,
// while resolve/image post-actions have different semantics on those two paths.
export interface HandoffTurnState {
  // The closing line the model wants the customer to read before the transfer. RECORDED here, never
  // sent from the tool: the runtime is the single writer of customer-facing text, so this line goes
  // out through the same output guardrail, the same modality choice and the same pacing as any other
  // reply (issue #160). Null when the model supplied none.
  customerMessage: string | null;
  // The conversation left `pending`, so the human queue owns it and the bot is done talking.
  completed: boolean;
}

// Whether the handoff supplies this turn's customer-facing text, which is the ONE question both
// runtimes ask. Two conditions and not one, because a transfer with nothing to say leaves the
// model's own final text as the only thing the customer would get, and that text is still theirs.
//
// A transfer that threw halfway answers false, and has to. sendPrivateNote and toggleStatus are not
// best-effort, so either can throw AFTER the model composed a line promising a human; the
// conversation then stays `pending`, i.e. still the bot's and queued to nobody, and the model gets
// the tool error plus one more step. That recovery reply is what the customer reads instead, and
// the undelivered promise is discarded with the turn that failed to keep it.
// A TYPE guard and not a boolean, so the line it proves is there is typed as being there. Both
// callers read `customerMessage` immediately after asking, and both used to cast it to `string` on
// their own word: a cast is what a compiler accepts INSTEAD of a proof, so the guard could have been
// deleted at either call site and nothing would have complained until a turn with no transfer
// handed a null to the guardrail.
export function handoffAnsweredTheTurn(
  state: HandoffTurnState | undefined,
): state is HandoffTurnState & { customerMessage: string } {
  return !!state && !!state.customerMessage && state.completed;
}

export interface PendingAttachment {
  bytes: ArrayBuffer;
  mime: string;
  fileName: string;
  caption?: string;
  // Position in the model's tool-call order, not in download-completion order.
  order: number;
  // Which tool queued it. Read by the delivery loop for the flow line and for the failure message:
  // an operator reading "send_image failed" about a document goes to check the image host allowlist
  // to debug a PDF we read off our own disk.
  tool: string;
  // Which quota it counts against. A SECOND field rather than a read of `tool`, because the two
  // answer different questions: `tool` says which tool produced this line in the trail, and a
  // tenant-named document tool makes "everything that is not send_image" the wrong way to ask the
  // other one. Reading one bit for two questions is how the next attachment source lands in the
  // image budget without anyone noticing.
  kind: "image" | "document";
  // Text the MODEL wrote that is inside the file itself, joined into the output guardrail alongside
  // the captions. A caption rides along because it is model-written text the customer reads; the
  // values a model put into a document's fields and line-item descriptions are exactly that too, and
  // they reach the customer on paper. Operator-authored block text is NOT here: screening a
  // template the operator wrote is moderating the operator, not the model.
  screenText?: string;
  // The issued document this file IS, when it is one. Carried so delivery can ask the row whether it
  // is still deliverable: an operator can revoke between the tool queueing the bytes and the runtime
  // sending them, and bytes alone cannot answer that.
  documentId?: bigint;
}

export interface ToolCtx {
  client: ChatwootClient;
  conversationId: number;
  // Absent (nudge turns, playground, hand-built ctx) ⇒ resolve_conversation keeps the legacy
  // immediate toggle. Only runLoadedTurn passes it.
  turnState?: TurnState;
  // Present on every real customer-messaging path. A successful handoff customerMessage is terminal:
  // the caller must not also post the model's final assistant text.
  handoffState?: HandoffTurnState;
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
  // The conversation as the turn observed it, for the immediate resolve_conversation path. Absent
  // ⇒ the close is not recorded rather than claimed: see record-resolution.ts rule 2. This is the
  // FALLBACK only: the tool re-reads the live state before closing, because on a nudge turn this
  // snapshot was taken before a model call that can run for a minute.
  observed?: ObservedConversation;
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
  // For send_image: the hosts the operator allows an image to be fetched from. Absent ⇒ none, and
  // the tool refuses every call — the URL is model-supplied, so an unconfigured allowlist must fail
  // closed rather than open.
  sendImage?: SendImageConfig;
  // Injectable for tests (the image download); default real fetch + assertSafeOutboundUrl. Same
  // convention as ToolpackCtx: the SSRF assertion resolves DNS, so a hermetic test has to stub it.
  fetchImpl?: typeof fetch;
  assertSafe?: ImageFetchDeps["assertSafe"];
  // Per-agent, per-tool operator guidance (keyed by native tool name), appended to that tool's
  // model-facing description so transfer/funnel logic lives WITH the tool instead of buried in the
  // prompt. Populated at turn prep from agent.settings (handoff.instructions / kanban.instructions).
  toolInstructions?: Partial<Record<NativeToolName, string>>;
  // NOTE: Reports a side effect that failed INSIDE a tool that still returns success to the model
  // (e.g. the handoff happened but the assignment failed). prepare.ts binds this to a flowlog
  // `tool`-stage warn so the failure reaches the Logs page and alert channels; absent
  // (playground/tests) ⇒ the failure stays log-only. NEVER changes the tool's return value.
  onSideEffectError?: SideEffectErrorReporter;
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
      // Transfer-with-summary: a private note for the human BEFORE handing off, gated by the
      // per-agent toggle (default on).
      if (reason && ctx.transferWithSummary !== false) {
        await ctx.client.sendPrivateNote(ctx.conversationId, reason);
      }
      // Set status `open` → the conversation leaves `pending`, so the attribution gate stops the
      // bot and the human queue picks it up.
      await ctx.client.toggleStatus(ctx.conversationId, "open");
      // Only here: everything above can throw, and a handoff that did not reach this line has not
      // happened. The optional assignment below is best-effort by design — the conversation is
      // already out of `pending`, so a routing miss does not put it back.
      //
      // The closing line is recorded HERE, from THIS invocation's argument, and never above: the
      // caller delivers it, and it must belong to the transfer that actually happened. A model whose
      // first attempt threw is handed the error and calls the tool again, and a second attempt that
      // succeeds with no line of its own would otherwise deliver the first one's promise and
      // suppress the recovery text the model wrote instead.
      //
      // Recorded rather than sent from here: sending it from inside the tool is what put the most
      // rule-bound message of the turn outside the output guardrail, outside TTS and outside the
      // pacing every other reply gets (#160). The cost is ordering — the customer reads it just
      // after the transfer instead of just before, which Chatwoot never shows them.
      if (ctx.handoffState) {
        if (customerMessage?.trim()) {
          ctx.handoffState.customerMessage = customerMessage.trim();
        }
        ctx.handoffState.completed = true;
      }

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
        ctx.onSideEffectError?.({
          tool: "handoff_to_human",
          phase: "assign",
          detail: { mode },
          err: e,
        });
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
    ctx.onSideEffectError?.({
      tool: "set_custom_attribute",
      phase: "mirror_write",
      detail: { scope, key },
      err: e,
    });
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
      // The row id and tenant are absent on hand-built contexts (and the playground never reaches a
      // real Chatwoot), so an unrecordable close is left unattributed rather than guessed at.
      const recordable = ctx.tenantId != null && ctx.conversationDbId != null;
      // BEFORE the toggle, and freshly. This branch runs inside a nudge's model call, which can take
      // a minute, so `ctx.observed` was taken before generation: an operator, an automation rule or
      // `auto_resolve_after` closing meanwhile makes our toggle a silent no-op in Chatwoot, and the
      // stale "open" would credit the agent for their close. After the toggle it is too late — the
      // conversation reads "resolved" either way and the two are indistinguishable.
      const observed = recordable
        ? await observeBeforeClose(
            ctx.client,
            ctx.conversationId,
            ctx.observed ?? { status: "resolved", statusAt: null },
          )
        : { status: "resolved", statusAt: null };
      await ctx.client.toggleStatus(ctx.conversationId, "resolved");
      // NOTE: Same origin as the deferred path in runtime.ts: the agent judged the request handled.
      if (recordable) {
        await recordResolutionOrigin({
          tenantId: ctx.tenantId as bigint,
          conversation: { id: ctx.conversationDbId as bigint },
          origin: "agent",
          observed,
          base: ctx.base,
        });
      }
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
  return s.length > max ? `${clipText(s, max - 1)}…` : s;
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
          ctx.onSideEffectError?.({
            tool: "kanban_move_card",
            phase: "outbound_emit",
            detail: { event: "kanban.card_moved" },
            err,
          });
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

// Sends an image the agent already has a URL for (a product photo from an HTTP tool, an MCP tool or
// a catalog integration) as a real attachment, instead of pasting a link the customer has to open.
//
// The URL is MODEL-supplied, so the hosts it may be fetched from are an operator decision that lives
// in the agent's config, never in a tool argument: a prompt injection can write any URL it likes and
// still not reach a host the operator did not list. See modules/images/fetch for the rest of the
// fence (SSRF assertion, no redirects, byte cap on the body, type read from the file's signature).
// The image half of the shared attachment queue, which is what both send_image ceilings are about.
export function queuedImages(turnState: TurnState): PendingAttachment[] {
  return turnState.pendingAttachments.filter((a) => a.kind === "image");
}

// The model-facing refusal when a turn has already taken all the images it may carry. Same wording
// for the count and the byte budget: from the model's side both mean "not this turn".
function limitReached(): string {
  return `Limite de imagens deste turno atingido (${SEND_IMAGE_MAX_PER_TURN}). Envie as demais em outra mensagem ou responda com o link em texto.`;
}

function sendImageTool(ctx: ToolCtx) {
  const cfg = ctx.sendImage ?? SEND_IMAGE_DEFAULTS;
  const hosts = cfg.allowedHosts;
  const guidance = ctx.toolInstructions?.send_image;
  const description =
    "Send an IMAGE to the customer as an attachment, given its URL. Use it whenever you have the URL of a picture the customer would rather see than read about (a product photo, a plan, a receipt). The URL must come from data you actually received — another tool's result, the knowledge base, the conversation — never one you compose or guess. Optionally include a short caption. Only the hosts listed below can be reached; anything else is refused, so if the image you have is elsewhere, describe it or send the page link as text instead." +
    (guidance ? `\n\n${guidance}` : "") +
    `\n<imagens-permitidas>${
      hosts.length
        ? hosts.map((h) => `\n  <host>${xmlEscape(h)}</host>`).join("")
        : "\n  <nenhum>Nenhum host liberado: a ferramenta vai recusar qualquer URL até o operador configurar a lista.</nenhum>"
    }\n</imagens-permitidas>`;
  return failableTool(
    async ({ url, caption }: { url: string; caption?: string }) => {
      // NOTE: Both refusals below are decided BEFORE the fetch. Downloading megabytes over ten
      // seconds only to throw the result away is work a model can ask for repeatedly, and the DNS
      // lookup alone is a signal leaving the box for a call whose answer is already "no".
      //
      // Queued, not sent: delivery happens after the turn's gates, so a turn that is superseded,
      // taken over or blocked must not have already messaged the customer. Without a turn to queue
      // into (a proactive nudge, where the 24h service window decides the send mode) the tool
      // declines rather than posting behind that gate's back.
      const turnState = ctx.turnState;
      if (!turnState) {
        return "Não é possível enviar imagem neste momento (mensagem proativa). Responda com o link em texto.";
      }
      // One model response can carry a whole batch of tool calls, and the graph's tool-call limit is
      // only re-checked between responses, so the queue needs its own ceiling: every accepted image
      // is held in memory until the turn ends and then uploaded one by one. The slot is taken here,
      // BEFORE the await, because the batch runs concurrently — a check that spans the download
      // would be read by every call while the queue is still empty. Bytes are enforced at the other
      // end, where the real size is known; the count keeps the in-flight total bounded meanwhile.
      // NOTE: counts IMAGES, not the queue. The queue also carries documents, which are our own
      // rendered files bounded by their own rule — one per turn. Letting one eat an image slot would
      // make a ceiling the operator reads as "images per message" mean something else depending on
      // whether a document went out with them.
      const tooManyQueued =
        queuedImages(turnState).length + turnState.imagesInFlight >=
        SEND_IMAGE_MAX_PER_TURN;
      if (tooManyQueued) {
        return limitReached();
      }
      turnState.imagesInFlight++;
      const order = turnState.attachmentsSeq++;
      try {
        const res = await fetchImageForDelivery(url, cfg, {
          fetchImpl: ctx.fetchImpl,
          assertSafe: ctx.assertSafe,
        });
        if (!res.ok) {
          // NOTE: A refusal the OPERATOR has to fix (no hosts configured, host not listed) is normal
          // operation for the model — it should answer with a link instead — but it is not normal
          // for the operator, so only the transport failures are marked as integration failures.
          const message = sendImageRefusal(res.reason, res.detail);
          return res.reason === "unreachable" || res.reason === "http_error"
            ? toolFailure(message)
            : message;
        }
        // NOTE: Re-read the queue and count THIS image in: the batch's other calls may have queued
        // while this one downloaded, and a budget that excludes the candidate lets the last accepted
        // image carry the total past the ceiling. No await between the read and the push, so the
        // pair is atomic.
        const queuedBytes = queuedImages(turnState).reduce(
          (n, i) => n + i.bytes.byteLength,
          0,
        );
        if (queuedBytes + res.bytes.byteLength > SEND_IMAGE_MAX_TURN_BYTES) {
          return limitReached();
        }
        turnState.pendingAttachments.push({
          bytes: res.bytes,
          mime: res.mime,
          fileName: res.fileName,
          caption: caption?.trim() || undefined,
          order,
          tool: "send_image",
          kind: "image",
        });
        // NOTE: No file name here. This string is the tool's OUTPUT, and `ToolFlowLogger` stores tool
        // outputs verbatim in `ExecutionLog.detail` — a name derived from the URL path would put back
        // exactly what the argument sanitizer strips out of that column.
        return "Imagem pronta para envio; ela vai junto com a sua resposta deste turno.";
      } finally {
        turnState.imagesInFlight--;
      }
    },
    {
      name: "send_image",
      description,
      schema: z.object({
        url: z
          .string()
          .min(1)
          .describe(
            "Direct https URL of the image file itself (not the page that shows it). Its host must be one of the allowed ones.",
          ),
        caption: z
          .string()
          .max(SEND_IMAGE_MAX_CAPTION_CHARS)
          .optional()
          .describe(
            "Optional short text delivered with the image, in the customer's language.",
          ),
      }),
    },
  );
}

// Model-facing explanation of a refusal. Each one tells the agent what to do INSTEAD, so a blocked
// image degrades into a useful answer rather than into an apology loop.
function sendImageRefusal(reason: ImageFetchFailure, detail?: string): string {
  switch (reason) {
    case "no_hosts_configured":
      return "Não posso enviar imagens: nenhum host foi liberado para esta configuração. Responda com o link em texto.";
    case "host_not_allowed":
      // NOTE: The rejected host is deliberately NOT echoed. It is a value the model composed — a
      // wildcard allowlist means it picks the subdomain — and this string is the tool's OUTPUT,
      // which `ToolFlowLogger` stores verbatim in `ExecutionLog.detail`. The model already knows
      // which URL it asked for, and the hosts it MAY use are in the tool's own description.
      return "Esse host não está na lista de hosts liberados, então a imagem não foi enviada. Responda com o link em texto.";
    case "invalid_url":
      return "Essa URL não é válida para envio de imagem. Confira o endereço ou responda com o link em texto.";
    case "too_large":
      return "A imagem é grande demais para enviar. Responda com o link em texto.";
    case "not_an_image":
      return "O endereço não devolveu uma imagem (só PNG, JPEG, GIF e WebP são aceitos). Responda com o link em texto.";
    case "http_error":
      return `O servidor da imagem respondeu ${detail ?? "com erro"}. Responda com o link em texto.`;
    default:
      return "Não consegui baixar a imagem agora. Responda com o link em texto.";
  }
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
    sendImageTool(ctx),
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
