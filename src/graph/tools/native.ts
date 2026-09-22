import { ToolMessage } from "@langchain/core/messages";
import type {
  StructuredToolInterface,
  ToolRunnableConfig,
} from "@langchain/core/tools";
import { tool } from "@langchain/core/tools";
import { z } from "zod";
import type { PrismaClient } from "@/../generated/prisma/client";
import logger from "@/api/lib/logger";
import {
  SKIP_REPLY_ACK,
  SKIP_REPLY_MARK,
  SKIP_REPLY_TOOL,
} from "@/graph/silence";
import { failableTool, toolFailure } from "@/graph/tools/failure";
import { runScopedOn, type TenantContext } from "@/lib/tenancy";
import { clipText } from "@/lib/text";
import { xmlAttr, xmlEscape } from "@/lib/xml";
import {
  ChatwootCalledOffError,
  type ChatwootClient,
  type CustomAttributeDef,
} from "@/modules/chatwoot/client";
import { type KanbanContext, matchKanbanStep } from "@/modules/chatwoot/kanban";
import { withConversationLabels } from "@/modules/chatwoot/labels";
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
  flooredLocalParts,
  formatParts,
  formatPartsHuman,
  partsInTimezone,
} from "../time";
import { CalculatorError, evaluateExpression } from "./calculator";
import {
  CUSTOMER_DELIVERY_NATIVE_TOOL_NAMES,
  NATIVE_TOOL_CATEGORY,
  type NativeToolName,
} from "./catalog";
import { modelVisibleLabels, SHOWN_LABELS_MAX } from "./label-view";

// Native Chatwoot tools the agent can call mid-turn, all over the bot token. Each is bound to a
// ToolCtx (the conversation + a ready client); the runtime resolves the per-agent allowlist
// (fail-closed: a tool not in the allowlist is never exposed to the model).

import { HANDOFF_DONE_PREFIX, HANDOFF_TOOL_NAME } from "./catalog";
import type { NoEffectReporter } from "./effect-free";
import { describeLabelWrite, type LabelWriteReporter } from "./label-writes";

export {
  HANDOFF_DONE_PREFIX,
  HANDOFF_TOOL_NAME,
  NATIVE_TOOL_NAMES,
  type NativeToolName,
} from "./catalog";

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
  // A message this turn put in front of the customer from OUTSIDE the reply path, and the one thing
  // here that has already LEFT: the slow-tool acknowledgement ("só um instante"), which `emitAck`
  // (prepare.ts) sends straight through the Chatwoot client. It counts no balloon and queues no
  // attachment, so nothing else in this state knows it happened. Optional for the reason
  // `declinedToSpeak` is: the shape is spelled out by hand at several call sites, and absent means
  // exactly what it says — nobody recorded an ack.
  spokeOutsideTheReply?: boolean;
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
  // The model was OFFERED the argument and passed it EMPTY, which since issue #662 is how it says
  // "this case receives no reply at all". Distinct from `customerMessage === null`, which is also
  // what a muted turn and a transfer that threw leave behind: this one is a decision, and the
  // runtime honours it by sending nothing rather than falling back to the model's own next text.
  // Optional because the turn-state shape is spelled out by hand at five call sites that build the
  // toolset, and absent is exactly what it means: nobody declared anything.
  declinedToSpeak?: boolean;
}

// Whether the handoff supplies this turn's customer-facing text, which is the ONE question both
// runtimes ask. Two conditions and not one, because a transfer that THREW leaves the model's own
// final text as the only thing the customer would get, and that text is still theirs. A transfer
// that SUCCEEDED with nothing to say is a different case since issue #662, and it has its own
// predicate below: the model declared the silence, so there is no fallback to fall back to.
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

// The other half of the same question, and the reason it is a separate one: a transfer that left
// nothing to say used to mean "the model said nothing", and the runtime answered that by letting the
// model's own final text through (the fallback `handoffAnsweredTheTurn` is written around). Since
// issue #662 the model cannot reach that state by forgetting, so reaching it means it CHOSE
// silence, and the tool now tells it so, in as many words. Delivering its next line anyway would
// make that
// sentence false, which is the defect #662 was: measured once in 18 live turns of declared silence,
// on a credit-bureau notice, as `Encaminhado para a equipe responsável.` sent to the customer.
export function handoffDeclaredSilence(
  state: HandoffTurnState | undefined,
): boolean {
  return !!state && state.completed && !!state.declinedToSpeak;
}

// WHAT ACTUALLY REACHED THE CUSTOMER, asked when the turn is over — the other half of the pair, and
// a different question from the one below.
//
// Below is what the turn had COMMITTED to at some instant mid-turn, which is all a live indicator
// can ever have. This one is asked after the sends: the closing line and the queue have either gone
// out or been dropped, and nothing is left to walk back. THREE sources and not one, because the
// three ways a turn reaches a customer are counted in three different units: text in balloons, files
// in the attachment loop, and the slow-tool acknowledgement in neither, since it goes straight out
// through the Chatwoot client (issue #726, review round 3).
export function turnReachedTheCustomer(sent: {
  balloons: number | null;
  attachment: boolean;
  spokeOutsideTheReply?: boolean;
}): boolean {
  return (
    sent.balloons != null ||
    sent.attachment ||
    sent.spokeOutsideTheReply === true
  );
}

// WHETHER THIS TURN PUT SOMETHING IN FRONT OF THE CUSTOMER, asked of the turn's own state rather
// than of what ran. The question exists for one reader — the marker `skip_reply` leaves behind,
// which asserts a silence — and the surface it answers for is the operator's timeline (issue #726).
//
// It is not "which tools were called", and that distinction is the whole of it. `handoff_to_human`
// is the reported case and it answers BOTH ways: with a `customerMessage` the customer reads a line,
// and with the empty one (#662) nobody is spoken to, which is the turn where the silence sentence is
// the only true thing on the screen. Reading the name would pass the first and invert the second.
//
// Neither half has been SENT when this is asked, and both are still the right answer. The runtime is
// the single writer of customer-facing text, so a handoff's line goes out after the graph returns,
// and `send_image` queues bytes the delivery loop posts later. What the turn has done is commit to
// putting something there, and by the time the operator reads the marker it is on the screen.
//
// `imagesInFlight`/`documentsInFlight` are counted alongside the queue for the reason they exist:
// the reservation is taken before the download, so a batch that has not finished downloading yet has
// already decided to send. Reading only the queue would answer "nothing" for the window in between.
export function turnDeliveredToCustomer(
  turnState: TurnState | undefined,
  handoffState: HandoffTurnState | undefined,
): boolean {
  // ASKED FIRST, and the order here is the order of irreversibility. Everything below is a
  // commitment the turn can still walk back — the closing line and the queue have not left when this
  // is asked — and a slow-tool acknowledgement is already on the customer's phone. So it outranks
  // the declared silence, which drops what has NOT gone out and cannot un-send what has.
  if (turnState?.spokeOutsideTheReply) return true;
  // The declared silence answers for everything BELOW it, and it is not only "the closing line is
  // empty": the runtime drops the attachment queue with it, because "this case receives no reply at
  // all" cannot mean "no text, plus the document you queued two hops ago". So a turn that queued a
  // picture AND declared the silence delivers nothing, and asking the queue alone would answer that
  // it did (review round 1).
  if (handoffDeclaredSilence(handoffState)) return false;
  if (handoffAnsweredTheTurn(handoffState)) return true;
  if (!turnState) return false;
  return (
    turnState.pendingAttachments.length > 0 ||
    turnState.imagesInFlight > 0 ||
    turnState.documentsInFlight > 0
  );
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
  // set_labels / set_custom_attribute enumerate KNOWN values in their descriptions instead of
  // letting the model guess. Absent ⇒ the tools fall back to generic descriptions.
  vocab?: ChatwootVocab;
  // WHAT THE MODEL WAS SHOWN, per scope. Under the replace contract (issue #568) this was the only
  // thing that gave `set_labels` the right to REMOVE, because removal happened by omission and
  // "left out" is only meaningful against a list the model actually saw. Since #695 a removal comes
  // from the model naming the label in `remove`, so this is GROUNDING and no longer authority: what
  // it buys is that the model asks for the canonical value instead of inventing a synonym for one
  // it cannot see, and a scope missing here costs a redundant `add` rather than a deletion.
  // Read at turn prep alongside the vocab; the card's set comes free with the kanban snapshot, and
  // the `task` scope re-reads the card at write time (holdout s6).
  shownLabels?: {
    conversation?: string[];
    contact?: string[];
    task?: string[];
  };
  // LABELS `set_labels` MAY NEITHER ADD NOR REMOVE (issue #568 review). Operator control labels
  // live on the same conversation as the classifier's, and this list is what keeps the agent from
  // moving one on purpose — not what keeps it alive, which is now the delta's job. It stopped
  // meaning "and never sees" in #695: see applyLabelDelta for why the refusal is reported by name.
  // Comes from `settings.setLabels.protected`; empty or absent ⇒ the tool reaches everything.
  protectedLabels?: string[];
  // THE LABELS `set_labels` MAY ADD (issue #638), from `settings.setLabels.allowed`; empty or absent
  // ⇒ any title, and one Chatwoot does not have is created there. `outsideAllowedLabels` says what a
  // title outside the list meets: `refuse` (default) or `accept`. See applyLabelDelta.
  allowedLabels?: string[];
  outsideAllowedLabels?: "refuse" | "accept";
  // THE CALLER'S FENCE, asked again by set_labels from inside the conversation's label queue. The
  // graph already asks it at the tool boundary; waiting for that queue is a wait AFTER the ask, and
  // `/reset` clears the episode's labels in this very queue, so a write admitted at the boundary can
  // still land on a conversation the operator has just been told was cleared. Absent ⇒ the write
  // proceeds, which is what every caller that has no fence to offer means.
  stillWanted?: () => Promise<boolean>;
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
  // CALLED BY A HANDLER THAT REFUSED WITHOUT WRITING (review round 36). Every effect-bearing handler
  // asks the caller's fence again inside itself — after its own read, before its own write — and the
  // exits below return a sentence saying the run was called off. Nothing left the process on those,
  // so a counter outside has to be told, or it reads them as writes that happened. NOT called where
  // something already went out: `handoff_to_human` after its note was filed is not one of these.
  //
  // ...AND BY EVERY OTHER EXIT THAT RETURNS BEFORE THE WRITE (review round 39), which is the same
  // fact arriving through a different door: a scope the conversation does not have (no kanban card,
  // no contact mirrored into Chatwoot), a funnel step that does not exist, a card already in the
  // step asked for, an update with no fields. The counter cannot tell those from a write by reading
  // the returned sentence, and reading them as writes costs the retry that the observer's tick
  // needs — for an `on_resolve` watcher, the only pass it will ever get.
  onNoEffect?: NoEffectReporter;
  // Called by `set_labels` after a write that MOVED something, with what moved (label-writes.ts).
  // Threaded beside `onNoEffect` because it is the same kind of fact arriving from the same place:
  // what the call did, told by the handler that knows, rather than parsed out of its sentence.
  onLabelsWritten?: LabelWriteReporter;
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
  //
  // ...EXCEPT ON A MUTED TURN, where the promise would be false (review round 35). The line is
  // RECORDED on `handoffState` for the caller to deliver, and an observation has no caller that
  // delivers: it throws its final output away. So the transfer happens, the customer hears nothing,
  // and the model was told they were answered. A watcher escalating to a human is legitimate;
  // telling it to write a message that goes nowhere is not, and the argument goes with the sentence.
  // (The observation DOES carry a `handoffState` since issue #671, so `resolve_conversation` can see
  // the transfer; what it does not carry is anything that reads the line back out.)
  const speaks = !ctx.client?.muted;
  const baseDescription = speaks
    ? `${coreDescription} \`customerMessage\` is REQUIRED: write the reply the customer will read (e.g. that a human will continue). Pass an EMPTY STRING only when this case must receive no reply at all — a formal or legal notice, an automated platform notification, or a customer already being handled by a human elsewhere.`
    : `${coreDescription} This turn does NOT answer the customer, so the transfer is silent to them: there is no message to write and none is sent.`;
  const reasonField = z
    .string()
    .optional()
    .describe("Short private-note summary for the human taking over.");
  // REQUIRED, and that is the fix for issue #662: an omitted argument and a deliberate silence were
  // the same call, so the customer could be left with nothing by a model that simply forgot, and no
  // record could tell the two apart. Declared empty, the silence is a decision the model made,
  // visible in the tool's own log line (`describeShape` reports `string(0)`, while an omitted
  // argument does not appear at all). Measured: a call without it is refused by the schema with a
  // text that NAMES the argument ("at customerMessage") and instructs no silence, so the model's
  // next attempt has both options in front of it.
  const customerMessageField = speaks
    ? {
        customerMessage: z
          .string()
          .describe(
            "The message the CUSTOMER receives, sent before the transfer (e.g. that a human will continue). Pass an EMPTY STRING only when this case must receive no reply at all (formal/legal notice, automated platform notification, customer already being handled by a human elsewhere).",
          ),
      }
    : {};
  return tool(
    async ({
      reason,
      assignTo,
      customerMessage,
    }: {
      reason?: string;
      assignTo?: string;
      // Required on a speaking turn and absent from the schema on a muted one, so `undefined` here
      // means the muted branch and never a model that forgot (see the schema below).
      customerMessage?: string;
    }) => {
      // Transfer-with-summary: a private note for the human BEFORE handing off, gated by the
      // per-agent toggle (default on).
      if (reason && ctx.transferWithSummary !== false) {
        await ctx.client.sendPrivateNote(ctx.conversationId, reason);
        // ASKED AGAIN, between the note and the status change, and only when the note was actually
        // sent — the third handler in this file that WAITS before writing, and the rule is the same
        // one `set_labels` applies inside its queue and `resolve_conversation` after its read: the
        // graph's ask at the tool boundary happened before this wait, and an observation holds no
        // thread claim to keep a `/reset` or a detach out of it. The note is already filed and stays
        // filed; what this stops is the pair below, which takes the conversation out of `pending`
        // and assigns it — a routing change on an episode the operator was just told was cleared
        // (round 18).
        if (ctx.stillWanted && !(await ctx.stillWanted())) {
          return "Did not hand off (the run was called off while the note was in flight); the note was already filed.";
        }
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
        // BOTH fields come from THIS invocation, so a second successful call cannot leave the first
        // one's promise standing next to its own silence: the turn would then be holding a line to
        // deliver and a declaration not to, and whichever the runtime asked about first would win.
        const spoken = customerMessage?.trim() ?? "";
        ctx.handoffState.customerMessage = spoken || null;
        ctx.handoffState.declinedToSpeak = speaks && !spoken;
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
      // WHAT THE MODEL READS AFTER TRANSFERRING, and it used to read the same sentence in all three
      // cases: "The bot will stay silent now." On the branch where the model had supplied no line
      // that sentence was an INSTRUCTION, and the model obeyed it: the runtime's fallback for a
      // transfer with nothing to say existed precisely so the model's next hop could speak, and the
      // tool was telling it not to. Measured on an email inbox: 2 of 130 turns ended transferred,
      // with a private note filed, and nothing at all for the customer (issue #662). It protected
      // nothing on the other branch either: when a line IS supplied, `runtime.ts` blanks the model's
      // own text, which is the duplicate-reply guard from issue #158, and never depended on this
      // sentence.
      //
      // Each of the three sentences below is a promise the product keeps: the declared silence is
      // enforced by `handoffDeclaredSilence` above, so "no message will be sent" is not advice.
      const silenceNote = !speaks
        ? " This turn does not answer the customer, so nothing is sent to them."
        : customerMessage?.trim()
          ? " The message you wrote will be delivered to the customer; do not repeat it."
          : " No message will be sent to the customer, as you indicated.";
      return `${HANDOFF_DONE_PREFIX} (status set to open).${assigned}${silenceNote}`;
    },
    {
      // From the catalog, because the hand-back decision matches results by this exact name
      // (../handback.ts). Spelled here as a literal, a rename would leave that match silently false.
      name: HANDOFF_TOOL_NAME,
      description: withOperatorNote(
        baseDescription,
        ctx,
        "handoff_to_human",
        targetsXml,
      ),
      // The two shapes differ ONLY by `assignTo`, and the shared fields are defined once above:
      // written twice, a mutation that restored `.optional()` on the `agent_choice` copy survived
      // the whole suite, because the test exercises the other shape (issue #662).
      schema: agentChoice
        ? z.object({
            reason: reasonField,
            ...customerMessageField,
            assignTo: z
              .string()
              .optional()
              .describe(
                "Name of the agent or team to route to; see the tool description for the valid names. Omit to use default routing.",
              ),
          })
        : z.object({ reason: reasonField, ...customerMessageField }),
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
// What the model is told when the client refused a queued write because the run was called off. A
// sentence, not a tool failure: nothing is broken, the world moved.
const CALLED_OFF_ATTRIBUTE =
  "Could not set the attribute (the run was called off while this write waited its turn).";

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
          ctx.onNoEffect?.("set_custom_attribute");
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
          ctx.onNoEffect?.("set_custom_attribute");
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
          ctx.onNoEffect?.("set_custom_attribute");
          return "Could not set the contact attribute (contact not linked to Chatwoot).";
        }
        // ASKED AGAIN, after the lookup and before the write. See the fence rule at the top of this
        // file: the graph's ask happens at DISPATCH, and this handler waits on a database read after
        // it. A contact attribute outlives the conversation it was written from, so a value written
        // after a `/reset` — or after the agent was switched off — is one nothing later corrects.
        if (ctx.stillWanted && !(await ctx.stillWanted())) {
          ctx.onNoEffect?.("set_custom_attribute");
          return "Could not set the contact attribute (the run was called off while this write waited).";
        }
        try {
          await ctx.client.setContactCustomAttributes(
            contact.chatwootContactId,
            { [key]: value },
            // ASKED ONCE MORE, from inside the client's queue this time. The ask above happens
            // before the call; the write itself waits for a keyed queue and re-reads the bag, and
            // that wait is as much a wait as this handler's own (round 25).
            { stillWanted: ctx.stillWanted },
          );
        } catch (e) {
          if (e instanceof ChatwootCalledOffError) {
            ctx.onNoEffect?.("set_custom_attribute");
            return CALLED_OFF_ATTRIBUTE;
          }
          throw e;
        }
        await mirrorAttributeWrite(ctx, "contact", key, value);
        return `Contact attribute ${key} set.`;
      }
      try {
        await ctx.client.setConversationCustomAttributes(
          ctx.conversationId,
          { [key]: value },
          // The conversation branch has no wait of its own before the call, so this is the ONLY
          // fence it gets — and it needs one, because `/reset` clears a conversation's attributes
          // inside exactly the window the queue and the re-read open.
          { stillWanted: ctx.stillWanted },
        );
      } catch (e) {
        if (e instanceof ChatwootCalledOffError) {
          ctx.onNoEffect?.("set_custom_attribute");
          return CALLED_OFF_ATTRIBUTE;
        }
        throw e;
      }
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

// Sets the labels (tags) on the conversation, the contact, or this conversation's kanban card
// (scope, default 'conversation'). Every backing endpoint REPLACES the whole set, and this tool
// used to expose that shape instead of hiding it — the model passed the complete list the scope
// should have. Issue #695 turned that around: the model names `add` and `remove`, and the complete
// list is computed HERE, from a read taken at write time. Adding, removing and swapping are still
// one gesture with one write, so a swap never leaves the scope holding both values or neither; what
// changed is that a label the model did not name is no longer at the mercy of it remembering to
// repeat the label back.
//
// The replacement the endpoint wants is built by applyLabelDelta below.
//
// Shapes confirmed against the chatwoot-pro fork: conversation + contact labels GET → { payload: [] },
// POST /{conversations|contacts}/{id}/labels { labels } replaces (LabelConcern); task labels via PATCH
// /kanban/tasks/{id} { task: { labels } } (update_labels), with the current set read from the card
// snapshot. NOTE: the enumerated labels are the account's Label titles; task tags may use a separate
// taggable namespace on the fork — confirm live before relying on the suggestion for task scope.

// THE MODEL NAMES THE DELTA, so the tool never has to infer one. This replaced a diff against
// what the model was SHOWN (`applyLabelIntent`, issue #695): under a replace contract the complete
// list was the only thing the model could send, removal happened by OMISSION, and the whole defence
// against a concurrent writer was to compare that list with a per-turn snapshot of what the model
// had seen. Naming the delta makes that defence a property instead of a mechanism:
//
//   not named          -> not touched, whoever put it there and whenever;
//   named in `remove`  -> removed, even if the model was never shown it;
//   named in `add`     -> added, even if it is already there (no-op, not an error).
//
// The second line is the one the old contract could not express, and the first is the one it could
// only approximate. A label an operator, an automation, the observer or n8n added between the turn's
// read and this call is now safe for free, and so is one past the 40-label ceiling.
//
// THE GUARD SUBTRACTS FROM BOTH DIRECTIONS and is REPORTED. `settings.setLabels.protected` keeps
// meaning "this tool may neither add nor remove it" — both halves, because a tenant relies on the
// add half to keep one agent's taxonomy out of another agent's reach. What it stops meaning is
// "never sees": under a delta, being shown a label no longer puts it at risk, so protecting and
// hiding come apart. That is the whole point of the change, and hiding is what made a fenced agent
// invent a label it could not see on 2026-09-11.
//
// THE OPERATOR'S LIST, when there is one (issue #638), fences ADDITIONS only. Under `refuse` a title
// outside it is not written and is named back (`refusedOutside`), and it holds the call's removals
// exactly as a guarded addition does, for the same reason: a swap whose new value cannot land must
// not leave the scope without the old one. Under `accept` it is written as before, and
// `acceptedOutside` names what went in outside the list so the trail can COUNT it (never title it:
// those are the model's strings). Removal is not limited: taking off a label the taxonomy never had
// is exactly what an operator cleaning up after the model wants. Both keys are present only when a
// list is, so a caller without one reads the same object it always did.
export function applyLabelDelta(
  add: readonly string[],
  remove: readonly string[],
  current: string[],
  guarded?: string[],
  allowed?: { labels: readonly string[]; mode: "refuse" | "accept" },
): {
  next: string[];
  added: string[];
  removed: string[];
  refusedAdd: string[];
  refusedRemove: string[];
  heldRemove: string[];
  refusedOutside?: string[];
  acceptedOutside?: string[];
} {
  const clean = (xs: readonly string[]): string[] => [
    ...new Set(xs.map((l) => l.trim()).filter(Boolean)),
  ];
  const guard = new Set(clean(guarded ?? []));
  const wantAdd = clean(add);
  const wantRemove = clean(remove);
  const refusedAdd = wantAdd.filter((l) => guard.has(l));
  const refusedRemove = wantRemove.filter((l) => guard.has(l));
  // A REMOVAL IS NOT APPLIED WHEN THE GUARD REFUSED ANY ADDITION OF THE SAME CALL (issue #712).
  // The two halves used to be weighed one by one, so a swap the guard caught on one side landed
  // the other side, and a mutually exclusive taxonomy ended the turn with NO category — the more
  // expensive of the two half-written states, because it destroys a classification instead of
  // adding a second one. The removal was asked for to make room for an addition; when that
  // addition cannot happen, applying the removal alone delivers a state nobody requested.
  //
  // OVER WHAT THE GUARD REFUSED, never over what the write ended up doing. `add: ["a"]` where `a`
  // already stands moves nothing and is still a legitimate request (#695 s14); conditioning on
  // "nothing was added" would let a redundant addition block every removal beside it.
  //
  // REMOVALS ONLY, never additions, and that asymmetry is imposed from outside rather than
  // chosen: #695 sealed s8 (`add: ["cancelamento", "reembolso"]` with `cancelamento` guarded must
  // still write `reembolso`) and s9 (a guarded REMOVE must still let its addition through, so a
  // conversation CAN still end with both categories). Holding the whole call would reverse both.
  // The "both categories" direction is therefore still reachable, on purpose, and #712 says so.
  //
  // A REFUSED ADDITION OF A LABEL ALREADY STANDING DOES NOT HOLD ANYTHING. It asked for nothing:
  // under the delta, naming a present label is a no-op, so there was no exchange for the removal
  // to be in service of. Without this, a model that reaffirms a guarded label it can now SEE —
  // `add: [nova-categoria, agente-off]`, `remove: [categoria-antiga]`, with `agente-off` guarded
  // and on the conversation, which is the real observer's configuration — would hold a swap that
  // completes perfectly well and leave BOTH categories standing, where the same call landed the
  // single correct one before this rule existed. Still conditioned on the guard's REFUSAL and not
  // on the write's outcome: an agent with no guard refuses nothing and holds nothing, whatever its
  // additions end up moving.
  const allowedSet =
    allowed && allowed.labels.length > 0
      ? new Set(clean(allowed.labels))
      : null;
  const refusedOutside =
    allowedSet && allowed?.mode !== "accept"
      ? wantAdd.filter((l) => !guard.has(l) && !allowedSet.has(l))
      : [];
  const hold = [...refusedAdd, ...refusedOutside].some(
    (l) => !current.includes(l),
  );
  const free = wantRemove.filter((l) => !guard.has(l));
  // Named back only when the label is actually standing: reporting a hold on one that was not
  // there would claim an effect the call never had, which is the same lie in the other direction.
  const heldRemove = hold ? free.filter((l) => current.includes(l)) : [];
  const drop = new Set(hold ? [] : free);
  const kept = current.filter((l) => !drop.has(l));
  const next = [
    ...new Set([
      ...kept,
      ...wantAdd.filter((l) => !guard.has(l) && !refusedOutside.includes(l)),
    ]),
  ];
  // What this write DID, read off `next` rather than off the request: naming a label already
  // present, or removing one that is not there, asks for something and moves nothing.
  const added = next.filter((l) => !current.includes(l));
  return {
    next,
    added,
    removed: current.filter((l) => !next.includes(l)),
    refusedAdd,
    refusedRemove,
    heldRemove,
    ...(allowedSet
      ? {
          refusedOutside,
          acceptedOutside: added.filter((l) => !allowedSet.has(l)),
        }
      : {}),
  };
}

// What a write DID, in the model's own terms, and what the scope holds AFTERWARDS. Reports against
// what was standing rather than against what the model asked for: "already as requested" is the
// answer a second identical call has to get, or a model reading its own transcript concludes the
// write did not land and tries again.
//
// THE RESULTING SET IS STATED because this line is the model's only way to learn it. The
// `<current_labels>` block in the description is built once, at turn prep, so from the second call
// onward it describes the past, including the model's own first write.
//
// A REFUSAL IS NAMED, and this is new with the delta contract. While a guarded label was hidden,
// the model could not ask for it, so subtracting it silently had nothing to report to. Now it sees
// the label, will therefore ask, and answering "already as requested" would be a false statement it
// reads back out of its own transcript one call later (issue #695).
//
// A HELD REMOVAL IS NAMED TOO, and separately from a refusal (issue #712). The model wrote that
// label and has no way to guess where it ended up; a report that simply omitted it would read as
// a removal that happened, and the model records this string and decides its next turn from it.
// The sentence states the RULE rather than a remedy on purpose: telling it to "ask again without
// the addition" would hand it the recipe for the very state the hold exists to prevent.
function labelWriteReport(
  where: string,
  added: string[],
  removed: string[],
  next: string[],
  refusedAdd: string[] = [],
  refusedRemove: string[] = [],
  heldRemove: string[] = [],
  refusedOutside: string[] = [],
): string {
  // The report is the THIRD statement about the same list, so it is capped like the other two, and
  // it says how many it left out rather than presenting a partial set as the whole truth.
  const head = next.slice(0, SHOWN_LABELS_MAX);
  const rest = next.length - head.length;
  const quoted = (xs: string[]) => xs.map((l) => `"${l}"`).join(", ");
  const now = next.length
    ? `${quoted(head)}${rest > 0 ? ` (+${rest} more)` : ""}`
    : "(none)";
  const parts: string[] = [];
  if (added.length) parts.push(`added ${quoted(added)}`);
  if (removed.length) parts.push(`removed ${quoted(removed)}`);
  const refused: string[] = [];
  if (refusedAdd.length) refused.push(`cannot be added: ${quoted(refusedAdd)}`);
  if (refusedRemove.length)
    refused.push(`cannot be removed: ${quoted(refusedRemove)}`);
  const tail = refused.length
    ? ` Some labels are managed by another system and ${refused.join("; ")}.`
    : "";
  // Its own sentence, because the reason is different and so is what the model should do next: a
  // guarded label belongs to someone else, a title outside the list does not exist for this agent.
  const outside = refusedOutside.length
    ? ` Not in this agent's list of labels, so not added: ${quoted(refusedOutside)}.`
    : "";
  const held = heldRemove.length
    ? ` ${quoted(heldRemove)} stays: a removal is not applied when the same call tried to add a label that is out of reach.`
    : "";
  if (parts.length === 0)
    return refused.length || refusedOutside.length
      ? `No label on the ${where} changed.${tail}${outside}${held} Now set: ${now}.`
      : `Labels on the ${where} were already as requested. Now set: ${now}.`;
  return `Labels on the ${where}: ${parts.join("; ")}.${tail}${outside}${held} Now set: ${now}.`;
}

// THE MODEL-VISIBLE SET, kept current for the rest of the turn. A turn has as many label writes as
// the model has tool calls, and a `<current_labels>` block frozen at the turn-prep snapshot answers
// the second call as if the first had not happened.
//
// INFORMATIONAL, NOT LOAD-BEARING, which is what changed with the delta contract (issue #695).
// While removal happened by omission, this list WAS the reference every removal was computed
// against, and getting it wrong erased data; now it only tells the model what is there, and a stale
// entry costs a redundant `add` rather than a deletion. The guard is no longer subtracted here
// either: a protected label is shown precisely so the model stops inventing a name for a value it
// could not see.
function recordShown(
  ctx: ToolCtx,
  scope: "conversation" | "contact" | "task",
  next: string[],
): void {
  if (!ctx.shownLabels) ctx.shownLabels = {};
  // Through the same projection the description renders, ceiling included.
  ctx.shownLabels[scope] = modelVisibleLabels(next);
}

// WHAT IS ON THE CONVERSATION RIGHT NOW, per scope, as the model sees it. This block and the `add`
// argument's own sentence read the SAME `ctx.shownLabels`, on purpose: two statements about one
// scope in one turn have to be one value. Rendered in the tool description rather than in the
// system prompt for that reason — one value, one place, no way for the two to describe different
// turns. Since #695 no WRITE is computed from it (the model names the delta), so a stale entry
// costs a redundant `add` rather than a deletion; what it still decides is whether the model asks
// for the canonical value or invents a synonym for one it cannot see.
//
// A scope absent here is a scope whose read failed or was never made, and it renders no element at
// all rather than an empty one: `<conversation/>` would tell the model the conversation has no
// labels, which is a different claim from "we could not find out".
function currentLabelsXml(shown: ToolCtx["shownLabels"]): string {
  if (!shown) return "";
  const els: string[] = [];
  for (const scope of ["conversation", "contact", "task"] as const) {
    const list = shown[scope];
    if (!list) continue;
    els.push(
      list.length === 0
        ? `  <${scope} empty="true"/>`
        : `  <${scope}>${list.map((l) => xmlEscape(l)).join(", ")}</${scope}>`,
    );
  }
  if (els.length === 0) return "";
  return `<current_labels>\n${els.join("\n")}\n</current_labels>`;
}

// The same reading `currentLabelsXml` renders, as one sentence for the ARGUMENT's own description.
// One function for both, because they are two model-facing statements about one fact and a second
// reader written by hand is how they end up describing different turns (review round 35): the
// argument used to name the CONVERSATION's labels whatever scope the call chose, so a `contact` call
// was shown the wrong list — an invitation to copy conversation labels onto a contact.
//
// A scope that is absent is left OUT rather than reported empty, exactly as the block does: "there
// are none" and "we did not read it" are different claims, and only the first belongs to a list.
function shownLabelsSentence(shown: ToolCtx["shownLabels"]): string {
  if (!shown) return "";
  const parts: string[] = [];
  for (const scope of ["conversation", "contact", "task"] as const) {
    const list = shown[scope];
    if (!list) continue;
    parts.push(`${scope}: ${list.length ? list.join(", ") : "(none)"}`);
  }
  return parts.length ? ` Currently set — ${parts.join("; ")}.` : "";
}

function setLabelsTool(ctx: ToolCtx) {
  // THE ACCOUNT'S VOCABULARY IS NO LONGER FILTERED HERE. It used to be, because `<existing_labels>`
  // advertises every label the account has as a value the model may pick, and under the replace
  // contract being offered one was the first half of being able to delete it by omission. Under the
  // delta contract the guard is enforced on the way in, so the suggestion list can be whole — and a
  // whole list is what stops an agent inventing `duvidas-evento` because the canonical value was
  // fenced out of its sight (measured 2026-09-11, issue #695).
  const labelsXml = existingLabelsXml(ctx.vocab?.labels ?? []);
  // 'task' scope is only offered when this conversation actually has a linked card (ctx.kanban).
  const taskScope = !!ctx.kanban;
  const scopeSchema = taskScope
    ? z.enum(["conversation", "contact", "task"])
    : z.enum(["conversation", "contact"]);
  const currentXml = currentLabelsXml(ctx.shownLabels);
  // NAMED UP FRONT, so a refusal is not the model's way of discovering the fence. Now that these
  // are visible, a model that reads one off `<current_labels>` and decides it belongs elsewhere
  // would otherwise spend a call to be told no. Capped like every other model-facing list.
  const guarded = [...new Set(ctx.protectedLabels ?? [])].filter(Boolean);
  const guardedShown = guarded.slice(0, SHOWN_LABELS_MAX);
  const guardedSentence = guardedShown.length
    ? ` These labels are managed by another system and this tool refuses to add or remove them, although you can see them: ${guardedShown
        .map((l) => `'${l}'`)
        .join(
          ", ",
        )}${guarded.length > guardedShown.length ? `, +${guarded.length - guardedShown.length} more` : ""}. Naming one of them in \`add\` when it is not already there also holds the call's \`remove\`, so a swap you cannot complete does not leave the scope empty.`
    : "";
  // THE OPERATOR'S LIST (issue #638), named up front for the same reason the guard is: a refusal
  // should not be how the model learns the taxonomy. Under `refuse` it REPLACES the "a label that
  // is not listed is created" sentence below, which would otherwise contradict it.
  const allowedList = [...new Set(ctx.allowedLabels ?? [])].filter(Boolean);
  const allowedMode = ctx.outsideAllowedLabels ?? "refuse";
  const allowed = allowedList.length
    ? { labels: allowedList, mode: allowedMode }
    : undefined;
  const allowedShown = allowedList.slice(0, SHOWN_LABELS_MAX);
  const allowedNamed = `${allowedShown.map((l) => `'${l}'`).join(", ")}${allowedList.length > allowedShown.length ? `, +${allowedList.length - allowedShown.length} more` : ""}`;
  const allowedSentence = !allowed
    ? ""
    : allowedMode === "accept"
      ? ` The labels this agent is meant to use are: ${allowedNamed}. Add only these; a label outside the list is still written, but avoid it.`
      : ` The only labels you may add are: ${allowedNamed}. A label outside this list is refused and not written; removing any label is still allowed.`;
  const baseDescription = [
    `Add or remove labels (tags) on the conversation, the contact${taskScope ? ", or this conversation's kanban card" : ""}. Use scope to choose (default 'conversation').`,
    "Name ONLY what changes: a label you do not name is left exactly as it is. There is no need to repeat the labels that should stay, and repeating them is not harmless — it is a request to have them, which puts back one somebody has just taken off.",
    "To swap a value, name the old one in `remove` and the new one in `add` in the same call.",
    currentXml &&
      "What is set right now is in `<current_labels>` below; a scope not listed there could not be read.",
    labelsXml &&
      !(allowed && allowedMode === "refuse") &&
      "Prefer an EXISTING label from `<existing_labels>` below; a label that is not listed is created.",
  ]
    .filter(Boolean)
    .join(" ");
  return tool(
    async (
      args: {
        add?: string[];
        remove?: string[];
        scope?: "conversation" | "contact" | "task";
      },
      _config?: ToolRunnableConfig,
    ) => {
      const { add = [], remove = [], scope } = args;
      // THE OLD SHAPE IS REFUSED BY NAME, and this is not defensive programming. Operator prose in
      // five free-text fields still describes the replace contract on every tenant that has not
      // rewritten it, and a model following that prose sends `{labels: [...]}`. A strict schema
      // would strip the key and leave an empty delta, so the call would answer "already as
      // requested" and the model would record a classification that was never written — the most
      // expensive failure this tool can produce (issue #695 holdout s3).
      const legacy = (args as { labels?: unknown }).labels;
      if (Array.isArray(legacy)) {
        ctx.onNoEffect?.("set_labels");
        return "Could not set the labels: this tool no longer takes a complete `labels` list. Name only what changes, with `add` and `remove` — a label you do not name is left as it is.";
      }
      if (add.length === 0 && remove.length === 0) {
        ctx.onNoEffect?.("set_labels");
        return "Could not set the labels (neither `add` nor `remove` named anything).";
      }
      if (scope === "task") {
        if (!ctx.kanban) {
          ctx.onNoEffect?.("set_labels");
          return "Could not set the labels (this conversation has no linked card).";
        }
        // THE CARD IS READ FRESH, like the other two scopes. It used to be the turn-prep snapshot,
        // on the grounds that resolving the card again costs the two or three calls
        // `loadKanbanContext` makes — but that is the cost of resolving the card from the
        // CONVERSATION, and the id is already in hand here, so one GET by id answers it. Under the
        // replace contract the staleness was invisible (the model's list was the write either way);
        // under the delta it would make "not named, not touched" false in exactly one scope, which
        // is the promise the whole change is built on (issue #695 holdout s6).
        //
        // A read that fails REFUSES the write rather than falling back to the snapshot. Falling
        // back would reintroduce the erasure silently, on the one path where nobody is looking,
        // and the conversation scope already answers an unreadable state the same way.
        let cardLabels: string[];
        try {
          const fresh = (await ctx.client.getKanbanTask(ctx.kanban.taskId)) as {
            labels?: unknown;
          } | null;
          cardLabels = Array.isArray(fresh?.labels)
            ? fresh.labels.filter((l): l is string => typeof l === "string")
            : [];
        } catch {
          ctx.onNoEffect?.("set_labels");
          return "Could not set the labels (the card could not be read just now). Try again.";
        }
        const {
          next,
          added,
          removed,
          refusedAdd,
          refusedRemove,
          heldRemove,
          refusedOutside,
          acceptedOutside,
        } = applyLabelDelta(add, remove, cardLabels, guarded, allowed);
        if (added.length === 0 && removed.length === 0) {
          // NOTHING MOVED, so nothing was written: the POST is skipped entirely (review round 37).
          // The dispatch was counted as an effect on the way in, and a call that changed no label
          // is a call the tick may safely run again.
          ctx.onNoEffect?.("set_labels");
          recordShown(ctx, "task", next);
          return labelWriteReport(
            "kanban card",
            added,
            removed,
            next,
            refusedAdd,
            refusedRemove,
            heldRemove,
            refusedOutside,
          );
        }
        // ASKED AGAIN, after the GET and before the write, for the reason the two sibling scopes
        // state above: the read is a WAIT, and `/reset` can retire the run while it is in flight.
        // This scope had no read between the graph's dispatch check and its write until the fresh
        // card read was added here, so the recheck arrives with it.
        if (ctx.stillWanted && !(await ctx.stillWanted())) {
          ctx.onNoEffect?.("set_labels");
          return "Could not set the card labels (the run was called off while this write waited).";
        }
        await ctx.client.setKanbanTaskLabels(ctx.kanban.taskId, next);
        ctx.onLabelsWritten?.(
          describeLabelWrite("task", added, removed, next, {
            allowed: allowedList,
            acceptedOutside,
          }),
        );
        // Kept in step anyway: the snapshot still feeds the description block and anything else in
        // the turn that reads the card, and leaving it behind the write would show the model a set
        // its own call has already moved.
        ctx.kanban.card.labels = [...next];
        recordShown(ctx, "task", next);
        return labelWriteReport(
          "kanban card",
          added,
          removed,
          next,
          refusedAdd,
          refusedRemove,
          heldRemove,
          refusedOutside,
        );
      }
      if (scope === "contact") {
        if (!ctx.base || ctx.tenantId == null || ctx.contactDbId == null) {
          ctx.onNoEffect?.("set_labels");
          return "Could not set the contact labels (no contact in scope).";
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
          ctx.onNoEffect?.("set_labels");
          return "Could not set the contact labels (contact not linked to Chatwoot).";
        }
        const current = await ctx.client.getContactLabels(
          contact.chatwootContactId,
        );
        const {
          next,
          added,
          removed,
          refusedAdd,
          refusedRemove,
          heldRemove,
          refusedOutside,
          acceptedOutside,
        } = applyLabelDelta(add, remove, current, guarded, allowed);
        if (added.length === 0 && removed.length === 0) {
          ctx.onNoEffect?.("set_labels");
          recordShown(ctx, "contact", next);
          return labelWriteReport(
            "contact",
            added,
            removed,
            next,
            refusedAdd,
            refusedRemove,
            heldRemove,
            refusedOutside,
          );
        }
        // ASKED AGAIN, after the GET and before the write — the fourth handler in this file that
        // waits before writing, and the same rule as the other three. The conversation scope asks
        // inside its queue; this scope has no queue, and the read above is just as much a wait.
        if (ctx.stillWanted && !(await ctx.stillWanted())) {
          ctx.onNoEffect?.("set_labels");
          return "Could not set the contact labels (the run was called off while this write waited).";
        }
        await ctx.client.setContactLabels(contact.chatwootContactId, next);
        ctx.onLabelsWritten?.(
          describeLabelWrite("contact", added, removed, next, {
            allowed: allowedList,
            acceptedOutside,
          }),
        );
        recordShown(ctx, "contact", next);
        return labelWriteReport(
          "contact",
          added,
          removed,
          next,
          refusedAdd,
          refusedRemove,
          heldRemove,
          refusedOutside,
        );
      }
      // Inside the conversation's label queue, with the observer's verdict and the nudge's own
      // merge: the endpoint replaces the whole set, so an unqueued read-then-POST here erases what
      // another writer added between the two (issue #477 review, round 3). The queue serialises OUR
      // writers; the delta is what survives the ones it does not reach — and unlike the diff it
      // replaced, it survives them without needing to know what the model was shown.
      return withConversationLabels(
        ctx.tenantId,
        ctx.conversationId,
        async () => {
          const current = await ctx.client.getConversationLabels(
            ctx.conversationId,
          );
          const {
            next,
            added,
            removed,
            refusedAdd,
            refusedRemove,
            heldRemove,
            refusedOutside,
            acceptedOutside,
          } = applyLabelDelta(add, remove, current, guarded, allowed);
          if (added.length === 0 && removed.length === 0) {
            // Nothing moved: see the sibling scopes above.
            ctx.onNoEffect?.("set_labels");
            recordShown(ctx, "conversation", next);
            return labelWriteReport(
              "conversation",
              added,
              removed,
              next,
              refusedAdd,
              refusedRemove,
              heldRemove,
              refusedOutside,
            );
          }
          // ASKED AGAIN HERE, inside the queue and after the GET, and not only at the tool boundary
          // the graph already fences. Waiting for the queue is a wait like any other: `/reset`
          // peels the episode's labels off in this very queue (webhook.ts), so a call that was
          // wanted when it entered can land on a conversation the operator has just been told was
          // cleared. Only an explicit `false` stops the write: a fence that could not answer is not
          // a withdrawal.
          if (ctx.stillWanted && !(await ctx.stillWanted())) {
            ctx.onNoEffect?.("set_labels");
            return "Could not set the labels (the run was called off while this write waited its turn).";
          }
          await ctx.client.setConversationLabels(ctx.conversationId, next);
          ctx.onLabelsWritten?.(
            describeLabelWrite("conversation", added, removed, next, {
              allowed: allowedList,
              acceptedOutside,
            }),
          );
          recordShown(ctx, "conversation", next);
          return labelWriteReport(
            "conversation",
            added,
            removed,
            next,
            refusedAdd,
            refusedRemove,
            heldRemove,
            refusedOutside,
          );
        },
      );
    },
    {
      name: "set_labels",
      description: withOperatorNote(
        baseDescription + allowedSentence + guardedSentence,
        ctx,
        "set_labels",
        [currentXml, labelsXml].filter(Boolean).join("\n"),
      ),
      // LOOSE ON PURPOSE: a call carrying the retired `labels` key has to REACH the handler so it
      // can be refused by name. A strict object strips the key, and the refusal would arrive as
      // "nothing changed" — see the handler.
      schema: z.looseObject({
        add: z
          .array(z.string())
          .optional()
          .describe(
            `Labels to ADD, e.g. ['vip']. Only these are added; everything already on the scope stays.${shownLabelsSentence(
              ctx.shownLabels,
            )}`,
          ),
        remove: z
          .array(z.string())
          .optional()
          .describe(
            "Labels to REMOVE, e.g. ['aguardando-dados']. Only these are removed; a label you do not name here is kept. Removing one that is not set is not an error.",
          ),
        scope: scopeSchema
          .optional()
          .describe(
            `Which labels to change: 'conversation' (default), 'contact'${taskScope ? ", or 'task'" : ""}.`,
          ),
      }),
    },
  );
}

function resolveConversationTool(ctx: ToolCtx) {
  const deferred = ctx.turnState !== undefined;
  return tool(
    async () => {
      // THE TRANSFER OF THIS TURN ALREADY HAPPENED, so the conversation belongs to the human queue
      // and closing it is not ours to do. The reactive runtime has said this since issue #159, but
      // it says it about the DEFERRED intent (`if (handoffState.completed) resolveRequested = false`)
      // and this tool closes IMMEDIATELY whenever no `turnState` was handed down, which is every
      // proactive turn and every observation. Measured on a nudge (issue #671): a transfer declaring
      // silence followed by this tool left `toggleStatus open` then `toggleStatus resolved`, so the
      // customer got nothing by the model's own declaration AND the conversation left the queue the
      // transfer had just put it in. Asked before both branches because the answer is the same in
      // both, and because the model should read what happened rather than a schedule that gets
      // cancelled out of sight.
      if (ctx.handoffState?.completed) {
        return "Did not resolve: this turn transferred the conversation to a human, so it is theirs to close, not yours.";
      }
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
      // ASKED AGAIN HERE, after that read and before the toggle, for the same reason `set_labels`
      // asks again inside its queue: the read above is a WAIT, and the graph's ask at the tool
      // boundary happened before it. A `/reset` peels the episode off in that window, and an
      // observation holds no thread claim to stop one (`runObserve` takes none), so without this the
      // close lands on a conversation the operator has just been told was cleared — and it is a
      // close, which nothing later undoes. Only an explicit `false` stops it: a fence that could not
      // answer is not a withdrawal (round 17).
      if (ctx.stillWanted && !(await ctx.stillWanted())) {
        ctx.onNoEffect?.("resolve_conversation");
        return "Did not resolve the conversation (the run was called off while this read was in flight).";
      }
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
        ctx.onNoEffect?.("kanban_move_card");
        return "This conversation has no linked kanban card, so there is nothing to move.";
      }
      const step = matchKanbanStep(ctx.kanban.steps, targetStep);
      if (!step) {
        ctx.onNoEffect?.("kanban_move_card");
        return `Unknown funnel step "${targetStep}". Available: ${ctx.kanban.steps
          .map((s) => s.name)
          .join(", ")}.`;
      }
      if (step.id === ctx.kanban.currentStepId) {
        ctx.onNoEffect?.("kanban_move_card");
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
        ctx.onNoEffect?.("update_kanban_task");
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
        ctx.onNoEffect?.("update_kanban_task");
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
        ctx.onNoEffect?.("set_voice_preference");
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
        // ASKED AGAIN, after the lookup that found the message to react to. A reaction is on the
        // customer's phone, so this is the same question every customer-facing send asks before it
        // goes out — and the lookup above is a wait after the graph's ask at dispatch.
        if (ctx.stillWanted && !(await ctx.stillWanted())) {
          ctx.onNoEffect?.("react_to_message");
          return "Could not add the reaction (the run was called off while this write waited).";
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
    async ({ reason }: { reason?: string }, config: ToolRunnableConfig) => {
      // The ack is what the MODEL reads — LangGraph calls it again after a tool result, and this
      // sentence is the instruction that makes the turn end quiet.
      const ack = reason
        ? `${SKIP_REPLY_ACK} (${reason}). Produce no message now.`
        : `${SKIP_REPLY_ACK}. Produce no message now.`;
      // ...and the MARK is what identifies the tool, in `additional_kwargs`, out of reach of any
      // response body (round 24). Returned as a whole `ToolMessage` for that, the same
      // direct-tool-output passthrough `failableTool` uses; without a tool_call in scope (a direct
      // invocation with plain args) it degrades to the plain string, as that one does.
      const id = config?.toolCall?.id;
      if (!id) return ack;
      return new ToolMessage({
        content: ack,
        tool_call_id: id,
        name: SKIP_REPLY_TOOL,
        additional_kwargs: { [SKIP_REPLY_MARK]: true },
      });
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
      const now = new Date();
      // One read of the clock, rendered twice from the SAME parts: the sentence and the ISO beside it
      // disagreeing by a minute is the kind of thing a model reads as two different times.
      const when =
        roundToMinutes && roundToMinutes > 0
          ? flooredLocalParts(now, tz, roundToMinutes)
          : partsInTimezone(now, tz);
      const iso = formatParts(when, "YYYY-MM-DD HH:mm");
      return `${formatPartsHuman(when)} (${iso}, ${tz})`;
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

// THE TOOLS A MUTED TURN CANNOT COMPLETE, hidden from it. An observer now runs the ordinary toolset
// (issue #568), and two of those tools are customer-facing in their entirety: a reaction lands on the
// customer's phone — the muted transport refuses that POST, and reaching that refusal is a defect by
// construction — and an image is delivered by the turn's own gates, which an observation does not
// have, so it refuses every call. Offered anyway they cost a model round each and answer with a
// failure an operator reads as a broken integration. Read off the client's own `muted`, the same
// field `armReminders` asks, so the two cannot disagree about what this turn may do.
//
// A private note is NOT here, and that is the same isention the mute itself makes: it is the one
// thing an observer legitimately writes where a person will read it.
const MUTED_CANNOT_COMPLETE = new Set<string>(
  CUSTOMER_DELIVERY_NATIVE_TOOL_NAMES,
);

// allowed = undefined → all native tools; otherwise only the named subset (fail-closed).
// No native tool takes CODE from the model: computation the model must not redo (check digits,
// date arithmetic, parsing) is an operator-authored code tool (tools/code.ts), whose body the
// operator wrote once and whose arguments are the only thing the model supplies.
export function buildNativeTools(
  ctx: ToolCtx,
  allowed?: Iterable<string>,
): StructuredToolInterface[] {
  const all: StructuredToolInterface[] = [
    handoffTool(ctx),
    privateNoteTool(ctx),
    setCustomAttributeTool(ctx),
    setLabelsTool(ctx),
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
  // MATERIALIZED ONCE, before the filter runs. `allowed` is an `Iterable<string>`, and a one-shot
  // one (a generator, a `Set.values()`) is CONSUMED by the first candidate — every tool after it
  // would then be tested against an empty set and the agent would come up with no tools at all
  // (review round 30). Cheaper too: one Set instead of one per candidate.
  const allowSet = allowed ? new Set(allowed) : null;
  const granted = allowSet ? all.filter((t) => allowSet.has(t.name)) : all;
  if (!ctx.client?.muted) return granted;
  return granted.filter((t) => !MUTED_CANNOT_COMPLETE.has(t.name));
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
    // NOTE: `skip_reply` is simulated-by-nature: it performs nothing, and its RETURN is the whole tool —
    // "Produce no message now" is an instruction the model reads and acts on, since LangGraph calls
    // the model again after a tool result. Replacing it with the generic `[simulated]` line makes
    // the playground write a follow-up that production stays silent on, which is the simulation
    // lying about the one decision it exists to show (issue #454, review round 3).
    NATIVE_TOOL_CATEGORY[tl.name as NativeToolName] === "utility" ||
    tl.name === SKIP_REPLY_TOOL
      ? tl
      : simulatedTool(tl),
  );
}
