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
  applyResolveLabels,
  type ResolveLabelsResult,
} from "@/graph/resolve-labels";
import {
  SKIP_REPLY_ACK,
  SKIP_REPLY_DETAIL_KEY,
  SKIP_REPLY_MARK,
  SKIP_REPLY_REASON_KEY,
  SKIP_REPLY_REASONS,
  SKIP_REPLY_TOOL,
  type SkipReplyReason,
} from "@/graph/silence";
import { SKIP_NOTE_DETAIL_MAX as SKIP_DETAIL_MAX } from "@/graph/skip-handover";
import { failableTool, toolFailure } from "@/graph/tools/failure";
import { withKeyedQueue } from "@/lib/locks";
import { runScopedOn, type TenantContext } from "@/lib/tenancy";
import { clipText } from "@/lib/text";
import { xmlAttr, xmlEscape } from "@/lib/xml";
import {
  ChatwootApiError,
  ChatwootCalledOffError,
  type ChatwootClient,
  type CustomAttributeDef,
} from "@/modules/chatwoot/client";
import {
  type AdditionalContactField,
  type ContactField,
  type ContactFieldsConfig,
  isAdditionalContactField,
} from "@/modules/chatwoot/contact-fields";
import { type KanbanContext, matchKanbanStep } from "@/modules/chatwoot/kanban";
import {
  closeConversationLabelsTail,
  conversationLabelsTail,
  withConversationLabels,
} from "@/modules/chatwoot/labels";
import { literalForChatwoot } from "@/modules/chatwoot/liquid";
import {
  attributesForModel,
  type ChatwootVocab,
} from "@/modules/chatwoot/vocab";
import {
  type ObservedConversation,
  observeBeforeClose,
  recordResolutionOrigin,
} from "@/modules/conversations/record-resolution";
import {
  type CaseInbox,
  type CustomerTextVerdict,
  type OpenCaseResult,
  openCaseInInbox,
} from "@/modules/cross-inbox-case/service";
import {
  type CrossInboxCaseConfig,
  openingAsksMessage,
  subjectAsksSummary,
} from "@/modules/cross-inbox-case/settings";
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

import {
  HANDOFF_DONE_PREFIX,
  HANDOFF_TOOL_NAME,
  OPEN_CASE_HANDED_MARK,
  OPEN_CASE_TOOL_NAME,
  RESOLVE_DONE,
} from "./catalog";
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
  // The operator's labels resolve_conversation asked the deferred close to write, and
  // whether a case opened this turn is what closes the conversation instead: a case means the team
  // has it, so the labels do not go. See graph/resolve-labels.ts resolveLabelsFor.
  resolveLabels?: string[];
  // The case inbox the deferred close checks before writing them (graph/resolve-labels.ts).
  resolveCaseHold?: CaseInbox | null;
  caseClosing?: boolean;
  // resolve_conversation asked for the close: a close the case scheduled and then withdrew leaves it.
  resolveByModel?: boolean;
  // An addition of this turn did not reach its case, so the case schedules no close for the rest of
  // the turn: the origin is the only place those words are.
  caseAdditionLost?: boolean;
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
  // reply. Null when the model supplied none.
  customerMessage: string | null;
  // The conversation left `pending`, so the human queue owns it and the bot is done talking.
  completed: boolean;
  // The model was OFFERED the argument and passed it EMPTY, which is how it says "this case
  // receives no reply at all". Distinct from `customerMessage === null`, which is also
  // what a muted turn and a transfer that threw leave behind: this one is a decision, and the
  // runtime honours it by sending nothing rather than falling back to the model's own next text.
  // Optional because the turn-state shape is spelled out by hand at five call sites that build the
  // toolset, and absent is exactly what it means: nobody declared anything.
  declinedToSpeak?: boolean;
  // `customerMessage` is the operator's hand-over message, set by an output check that handed the
  // conversation over, not a line the model wrote: it keeps Chatwoot's Liquid instead of being escaped.
  lineByOperator?: boolean;
  // THIS turn changed the conversation's owner itself: its transfer, or the nudge's IMMEDIATE close
  // (the reactive turn defers its close past the graph). Two marks, because they answer different
  // things: `ownerChanged` is set when a change LANDED and never cleared, and `ownerChangesInFlight`
  // counts the calls to Chatwoot still out. The calls of one batch run concurrently, so a label's ask
  // can read the mirror the status webhook already moved while the transfer's own call has not
  // returned; and a later call that throws must not erase a change that already landed. The tool
  // boundary's ownership question reads both (`ownerChangedByTurn`): a status the turn wrote is not a
  // person taking over.
  ownerChanged?: boolean;
  ownerChangesInFlight?: number;
}

export function ownerChangedByTurn(state: HandoffTurnState): boolean {
  return state.ownerChanged === true || (state.ownerChangesInFlight ?? 0) > 0;
}

// A transfer made by a caller OUTSIDE this file (the output check's `handoff` verdict on text a tool
// sends), marked like a tool's own status change. Counted in flight while it runs, so a sibling
// call's fence does not read the transfer's own status webhook as a person taking over and skip the
// pinned assignment; `changed` says from its result whether the owner actually changed.
export async function ownTransfer<T>(
  state: HandoffTurnState | undefined,
  transfer: () => Promise<T>,
  changed: (result: T) => boolean,
): Promise<T> {
  if (state) state.ownerChangesInFlight = (state.ownerChangesInFlight ?? 0) + 1;
  try {
    const result = await transfer();
    if (state && changed(result)) state.ownerChanged = true;
    return result;
  } finally {
    if (state)
      state.ownerChangesInFlight = (state.ownerChangesInFlight ?? 1) - 1;
  }
}

// The status change a tool of this turn makes on purpose, marked from before the call so the tool
// boundary's ownership question does not read it as somebody else's.
async function ownStatusChange(
  ctx: { handoffState?: HandoffTurnState },
  write: () => Promise<unknown>,
): Promise<void> {
  const state = ctx.handoffState;
  if (state) state.ownerChangesInFlight = (state.ownerChangesInFlight ?? 0) + 1;
  try {
    await write();
    if (state) state.ownerChanged = true;
  } finally {
    if (state)
      state.ownerChangesInFlight = (state.ownerChangesInFlight ?? 1) - 1;
  }
}

// Whether the handoff supplies this turn's customer-facing text, the ONE question both runtimes
// ask. A transfer that THREW halfway answers false: sendPrivateNote and toggleStatus can throw after
// the model composed a line promising a human, the conversation stays `pending` (still the bot's,
// queued to nobody), and the model's recovery reply after the tool error is what the customer reads.
// A transfer that completed with nothing to say is `handoffDeclaredSilence` below. A TYPE guard, so
// both callers read `customerMessage` as a string with no cast that would outlive deleting the check.
export function handoffAnsweredTheTurn(
  state: HandoffTurnState | undefined,
): state is HandoffTurnState & { customerMessage: string } {
  return !!state && !!state.customerMessage && state.completed;
}

// The other half: a transfer that completed with the argument passed EMPTY. The model cannot reach
// that state by forgetting, so reaching it means it CHOSE silence, and the tool tells it so.
// Delivering its next line anyway (a "Encaminhado para a equipe responsável.") would make that
// sentence false, so there is no fallback to the model's own final text here.
export function handoffDeclaredSilence(
  state: HandoffTurnState | undefined,
): boolean {
  return !!state && state.completed && !!state.declinedToSpeak;
}

// WHAT ACTUALLY REACHED THE CUSTOMER, asked after the sends; `turnDeliveredToCustomer` below is what
// the turn had COMMITTED to mid-turn, all a live indicator can have. THREE sources, because the three
// ways a turn reaches a customer are counted in three units: text in balloons, files in the
// attachment loop, and the slow-tool acknowledgement in neither, since it goes straight out through
// the Chatwoot client. See docs/logs.md on `turnDelivered`.
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

// WHETHER THIS TURN PUT SOMETHING IN FRONT OF THE CUSTOMER, asked of the turn's own state rather than
// of which tools ran, for the marker `skip_reply` leaves on the operator's timeline. The tool's name
// cannot answer it: `handoff_to_human` with a `customerMessage` speaks, and with an empty one nobody
// is spoken to. Neither has been SENT when this is asked (the runtime posts the handoff line and the
// queued files after the graph returns), but the turn has committed to them. `imagesInFlight` and
// `documentsInFlight` count too: the reservation precedes the download, so a batch still downloading
// has already decided to send. See docs/logs.md on `turnDelivered`.
export function turnDeliveredToCustomer(
  turnState: TurnState | undefined,
  handoffState: HandoffTurnState | undefined,
): boolean {
  // NOTE: ASKED FIRST, and the order here is the order of irreversibility. Everything below is a
  // commitment the turn can still walk back — the closing line and the queue have not left when this
  // is asked — and a slow-tool acknowledgement is already on the customer's phone. So it outranks
  // the declared silence, which drops what has NOT gone out and cannot un-send what has.
  if (turnState?.spokeOutsideTheReply) return true;
  // NOTE: The declared silence answers for everything BELOW it: the runtime drops the attachment
  // queue with it, because "this case receives no reply at all" cannot mean "no text, plus the
  // document you queued two hops ago". So a turn that queued a picture AND declared the silence
  // delivers nothing, and asking the queue alone would answer that it did.
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
  // Absent (nudge turns, playground, hand-built ctx) ⇒ resolve_conversation toggles immediately.
  // Only runLoadedTurn passes it.
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
  // Our Conversation row id, for the write-through that keeps the mirrored attribute bags in
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
  // Whether THIS turn's reply goes as a voice note once the stored preference is the given value.
  // Present on the turns that deliver a reply that can be spoken; set_voice_preference
  // then tells the model how the reply it is writing will go out, because the preference it just
  // saved applies to this very reply and a model told "voice note" at the start would otherwise
  // write for the ear a reply that is sent as text, or the reverse.
  replyIsAudioWith?: (voiceReply: boolean | null) => boolean;
  // IANA timezone for the get_current_time utility tool (the agent's BusinessHours.timezone,
  // falling back to DEFAULT_TIMEZONE).
  timezone?: string;
  // The account's labels + custom-attribute definitions (resolved at turn prep, best-effort), so
  // set_labels / set_custom_attribute enumerate KNOWN values in their descriptions instead of
  // letting the model guess. Absent ⇒ the tools fall back to generic descriptions.
  vocab?: ChatwootVocab;
  // WHAT THE MODEL WAS SHOWN, per scope: GROUNDING, not authority. A removal comes from the model
  // naming the label in `remove`; this lets it ask for the canonical value instead of inventing a
  // synonym, and a scope missing here costs a redundant `add` rather than a deletion. Read at turn
  // prep alongside the vocab; the card's set comes with the kanban snapshot, and the `task` scope
  // re-reads the card at write time.
  shownLabels?: {
    conversation?: string[];
    contact?: string[];
    task?: string[];
  };
  // THE CONVERSATION'S LABELS AS THE CALLER JUST READ THEM, with when. Handed over by a caller that
  // read them moments before its writes (the `decisions` tick, whose read and write are one provider
  // call apart): while it is fresh, `set_labels` applies its delta to this set instead of reading
  // again, and leaves here the set it wrote. Absent, or older than `LABELS_READ_FRESH_MS`, the tool
  // reads. The cost is the window: a label another writer puts on in between is not in the set that
  // goes back, so a caller whose model thinks for seconds does not hand this over.
  conversationLabelsRead?: { labels: string[]; at: number };
  // LABELS `set_labels` MAY NEITHER ADD NOR REMOVE. Operator control labels live on the same
  // conversation as the classifier's, and this list keeps the agent from moving one on purpose (the
  // delta already keeps an unnamed label standing). The model still sees them: see applyLabelDelta
  // for why the refusal is reported by name. Comes from `settings.setLabels.protected`; empty or
  // absent ⇒ the tool reaches everything.
  protectedLabels?: string[];
  // THE LABELS resolve_conversation WRITES ITSELF before it closes, from
  // `settings.resolveConversation.assignLabels`; empty or absent ⇒ the close writes none.
  resolveLabels?: string[];
  // Where a contact waiting on a case holds those labels off, on this conversation's account (see
  // graph/resolve-labels.ts). Absent or null ⇒ nothing is checked.
  resolveCaseHold?: CaseInbox | null;
  // THE LABELS `set_labels` MAY ADD, from `settings.setLabels.allowed`; empty or absent
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
  // The contact fields this agent sees and may change (agent.settings.contactFields). update_contact
  // is built only when `writable` names at least one field, and its schema offers only those.
  contactFields?: ContactFieldsConfig;
  // `open_case_in_inbox`: the agent's destination config and the origin conversation's
  // contact, as Chatwoot knows it. Absent, or with no destination inbox, the tool is not built.
  crossInboxCase?: {
    config: CrossInboxCaseConfig;
    // The case's email subject for this conversation, from the operator's template and the model's
    // summary. Absent ⇒ no subject.
    renderSubject?: (summary: string | null) => string | null;
    contactId: number | null;
    // The agent's signature, applied to the opening the customer receives (docs/signature.md).
    sign?: (text: string) => string;
    // The prompt's context variables, for the operator's opening and note templates.
    interpolate?: (template: string) => string;
    // Where the origin's current attendance starts, for `carryAttachments.mode = attendance`.
    attendanceStartedAt?: () => Promise<Date | null>;
  };
  // The turn's OUTPUT guardrail, for customer-facing text a tool sends itself (the opening message of
  // `open_case_in_inbox`). Bound by the runtime that owns the gate, so this file does not import it,
  // and a `handoff` verdict is carried out THERE, through the same transfer the reply's own trip
  // takes. Absent ⇒ this path screens nothing.
  screenCustomerText?: (text: string) => Promise<CustomerTextVerdict>;
  // Per-agent, per-tool operator guidance (keyed by native tool name), appended to that tool's
  // model-facing description so transfer/funnel logic lives WITH the tool instead of buried in the
  // prompt. Populated at turn prep from agent.settings (handoff.instructions / kanban.instructions).
  toolInstructions?: Partial<Record<NativeToolName, string>>;
  // Reports a side effect that failed INSIDE a tool that still returns success to the model
  // (e.g. the handoff happened but the assignment failed). prepare.ts binds this to a flowlog
  // `tool`-stage warn so the failure reaches the Logs page and alert channels; absent
  // (playground/tests) ⇒ the failure stays log-only. NEVER changes the tool's return value.
  onSideEffectError?: SideEffectErrorReporter;
  // CALLED BY A HANDLER THAT RETURNED WITHOUT WRITING, so a counter outside does not read the exit
  // as a write that happened. Two kinds of exit: the caller's fence, asked again inside the handler
  // (after its own read, before its own write), said the run was called off; or there was nothing to
  // write (a scope the conversation does not have, a funnel step that does not exist, a card already
  // in the step asked for, an update with no fields). Reading those as writes costs the retry the
  // observer's tick needs, for an `on_resolve` watcher the only pass it gets. NOT called where
  // something already went out: `handoff_to_human` after its note was filed is not one of these.
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
  // Always ask for a customer-facing reply before the handoff so the persona does not go
  // silent, EXCEPT on a muted turn: the line is RECORDED on `handoffState` for the caller to deliver,
  // and an observation throws its final output away, so the model would be told the customer was
  // answered. The observation still carries a `handoffState` (so `resolve_conversation` sees the
  // transfer), but nothing reads the line back out; the argument goes with the sentence.
  const speaks = !ctx.client?.muted;
  const baseDescription = speaks
    ? `${coreDescription} \`customerMessage\` is REQUIRED: write the reply the customer will read (e.g. that a human will continue). Pass an EMPTY STRING only when this case must receive no reply at all — a formal or legal notice, an automated platform notification, or a customer already being handled by a human elsewhere.`
    : `${coreDescription} This turn does NOT answer the customer, so the transfer is silent to them: there is no message to write and none is sent.`;
  const reasonField = z
    .string()
    .optional()
    .describe("Short private-note summary for the human taking over.");
  // REQUIRED, so a model that forgot and a deliberate silence are different calls. Declared
  // empty, the silence is a decision visible in the tool's own log line (`describeShape` reports
  // `string(0)`; an omitted argument does not appear). A call without it is refused by the schema
  // with a text that NAMES the argument ("at customerMessage") and instructs no silence, so the
  // model's next attempt has both options in front of it.
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
      // NOTE: Transfer-with-summary: a private note for the human BEFORE handing off, gated by the
      // per-agent toggle (default on).
      if (reason && ctx.transferWithSummary !== false) {
        // NOTE: The model's words, escaped for Chatwoot's Liquid.
        await ctx.client.sendPrivateNote(
          ctx.conversationId,
          literalForChatwoot(reason),
        );
        // NOTE: ASKED AGAIN between the note and the status change, only when the note was sent: the
        // graph's ask at the tool boundary came before this wait, and an observation holds no thread
        // claim to keep a `/reset` or a detach out of it. The note stays filed; this stops the pair
        // below (out of `pending`, then assigned), a routing change on an episode the operator was
        // just told was cleared. Same rule `set_labels` applies in its queue and
        // `resolve_conversation` after its read.
        if (ctx.stillWanted && !(await ctx.stillWanted())) {
          return "Did not hand off (the run was called off while the note was in flight); the note was already filed.";
        }
      }
      // NOTE: Set status `open` → the conversation leaves `pending`, so the attribution gate stops the
      // bot and the human queue picks it up.
      await ownStatusChange(ctx, () =>
        ctx.client.toggleStatus(ctx.conversationId, "open"),
      );
      // NOTE: Only here: everything above can throw, and a handoff that did not reach this line has
      // not happened; the assignment below is best-effort, as the conversation is already out of
      // `pending`. The closing line comes from THIS invocation's argument: a model whose first
      // attempt threw calls again, and a successful retry with no line must not deliver the first
      // one's promise. Recorded rather than sent from the tool, so it passes the output guardrail,
      // TTS and the pacing every reply gets; the cost is that the customer reads it just after the
      // transfer instead of just before, which Chatwoot does not show them.
      if (ctx.handoffState) {
        // BOTH fields come from THIS invocation, so a second successful call cannot leave the first
        // one's promise standing next to its own silence: the turn would then be holding a line to
        // deliver and a declaration not to, and whichever the runtime asked about first would win.
        const spoken = customerMessage?.trim() ?? "";
        ctx.handoffState.customerMessage = spoken || null;
        ctx.handoffState.lineByOperator = false;
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
            // NOTE: No match: surface it instead of failing silently — a private note tells the human the
            // intended target, and the conversation falls back to default routing.
            await ctx.client.sendPrivateNote(
              ctx.conversationId,
              `Tentei encaminhar para "${literalForChatwoot(assignTo)}", mas não encontrei um agente ou time com esse nome no Chatwoot. Deixei no roteamento padrão.`,
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
      // WHAT THE MODEL READS AFTER TRANSFERRING, one sentence per case, each a promise the
      // product keeps: the declared silence is enforced by `handoffDeclaredSilence` above, so "no
      // message will be sent" is not advice. None of them tells the model to stay silent: a model
      // obeys that as an instruction. When a line IS supplied, `runtime.ts` blanks the model's own
      // text (the duplicate-reply guard), which does not depend on this sentence.
      const silenceNote = !speaks
        ? " This turn does not answer the customer, so nothing is sent to them."
        : customerMessage?.trim()
          ? " The message you wrote will be delivered to the customer; do not repeat it."
          : " No message will be sent to the customer, as you indicated.";
      return `${HANDOFF_DONE_PREFIX} (status set to open).${assigned}${silenceNote}`;
    },
    {
      // NOTE: From the catalog, because the hand-back decision matches results by this exact name
      // (../handback.ts). Spelled here as a literal, a rename would leave that match silently false.
      name: HANDOFF_TOOL_NAME,
      description: withOperatorNote(
        baseDescription,
        ctx,
        "handoff_to_human",
        targetsXml,
      ),
      // NOTE: The two shapes differ ONLY by `assignTo`, and the shared fields are defined once above:
      // written twice, the `agent_choice` copy could regain `.optional()` with no test noticing,
      // because the test exercises the other shape.
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
      await ctx.client.sendPrivateNote(
        ctx.conversationId,
        literalForChatwoot(content),
      );
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

// Write-through of a just-written attribute into OUR mirrored bag, so the attribute-context block
// reflects it immediately. Chatwoot stays the source of truth (the next webhook event overwrites the
// bag); this closes the window where a proactive nudge, with no inbound event before it, reads a
// stale value, above all on the contact scope (Chatwoot does not deliver contact_updated to bots).
// One `jsonb || jsonb` UPDATE, not a read-modify-write: the tool node runs a turn's
// set_custom_attribute calls CONCURRENTLY, and the statement's row lock keeps two keys on one scope
// from clobbering each other. Best-effort: a failure is logged, never surfaced to the model.
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
  const target =
    scope === "contact" ? ctx.contactDbId : (ctx.conversationDbId ?? null);
  // In the order the writes reached Chatwoot: calls that shared one write return together, and two
  // of them naming the same key would otherwise race here, leaving the mirror on the value Chatwoot
  // did not keep.
  const inOrder = <T>(fn: () => Promise<T>) =>
    target == null
      ? fn()
      : withKeyedQueue(
          `attribute-mirror:${String(tenantId)}:${scope}:${String(target)}`,
          fn,
        );
  try {
    await inOrder(() =>
      runScopedOn(base, sysCtx(tenantId), async (db) => {
        if (scope === "contact") {
          if (ctx.contactDbId == null) return;
          // NOTE: The write-through also ADVANCES the contact's source watermark: an event generated
          // before now carries a pre-write snapshot, and one delivered late but stamped after the last
          // mirrored event would pass upsertContact's compare-and-set and erase this key, which nothing
          // puts back (bots never get contact_updated). GREATEST (NULL-ignoring) never moves it back.
          // `AT TIME ZONE 'UTC'` is load-bearing: the column is TIMESTAMP holding UTC and bare NOW() is
          // timestamptz, so GREATEST would resolve through the unpinned SESSION TimeZone, and under a
          // non-UTC session the stored value reads as hours ahead and the barrier never advances.
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
      }),
    );
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

// What the model is told when the client refused a queued write because the run was called off. A
// sentence, not a tool failure: nothing is broken, the world moved.
const CALLED_OFF_ATTRIBUTE =
  "Could not set the attribute (the run was called off while this write waited its turn).";

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
        // NOTE: ASKED AGAIN, after the lookup and before the write: the graph's ask happens at
        // DISPATCH, and this handler waits on a database read after it. A contact attribute outlives
        // the conversation it was written from, so a value written after a `/reset` (or after the
        // agent was switched off) is one nothing later corrects.
        if (ctx.stillWanted && !(await ctx.stillWanted())) {
          ctx.onNoEffect?.("set_custom_attribute");
          return "Could not set the contact attribute (the run was called off while this write waited).";
        }
        try {
          await ctx.client.setContactCustomAttributes(
            contact.chatwootContactId,
            { [key]: value },
            // NOTE: ASKED ONCE MORE, from inside the client's queue this time. The ask above happens
            // before the call; the write itself waits for a keyed queue and re-reads the bag, and
            // that wait is as much a wait as this handler's own.
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
          // NOTE: The conversation branch has no wait of its own before the call, so this is the ONLY
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

// THE MODEL NAMES THE DELTA: not named, not touched; named in `remove`, removed even if never shown;
// named in `add`, added (a no-op when already there). `guarded` (settings.setLabels.protected) is
// refused in both directions and reported; `allowed` fences additions only, `refuse` naming back
// `refusedOutside` and `accept` reporting `acceptedOutside` (both keys only when a list exists). A
// refused addition of a label not already standing holds the call's removals (`heldRemove`). The
// rules and why each holds: docs/graph.md, "`set_labels`: the model names the delta".
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
  // A REMOVAL IS HELD when the guard or the list refused an addition of the same call that is
  // not already standing: the removal made room for it, and applied alone it leaves a mutually
  // exclusive taxonomy with NO category. Conditioned on the REFUSAL, never on what the write moved,
  // and it holds removals only, never additions. See docs/graph.md, "`set_labels`: the model names
  // the delta".
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

// What a write DID, in the model's own terms, and what the scope holds AFTERWARDS. Reported against
// what was standing, so a second identical call reads "already as requested" rather than a failure
// to retry. The resulting set is stated because `<current_labels>` is built at turn prep and is
// stale from the second call on. A refusal and a held removal are each named: omitted, they read as
// writes that happened. The held sentence states the RULE, not a remedy that would recreate the
// state the hold prevents. See docs/graph.md, "`set_labels`: the model names the delta".
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

// THE MODEL-VISIBLE SET, kept current for the rest of the turn: a `<current_labels>` block frozen at
// turn prep would answer the second call as if the first had not happened. INFORMATIONAL: no write
// is computed from it, so a stale entry costs a redundant `add` rather than a deletion, and a
// protected label stays in it so the model does not invent a name for a value it cannot see.
function recordShown(
  ctx: ToolCtx,
  scope: "conversation" | "contact" | "task",
  next: string[],
): void {
  if (!ctx.shownLabels) ctx.shownLabels = {};
  // NOTE: Through the same projection the description renders, ceiling included.
  ctx.shownLabels[scope] = modelVisibleLabels(next);
}

// WHAT IS ON THE CONVERSATION RIGHT NOW, per scope, as the model sees it. This block and the `add`
// argument's sentence read the SAME `ctx.shownLabels`, and it lives in the tool description rather
// than the system prompt so the two are one value in one place. No write is computed from it; it
// decides whether the model asks for the canonical value or invents a synonym. A scope absent here
// (read failed or never made) renders no element, since an empty one would claim there are none.
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

// The same reading `currentLabelsXml` renders, as one sentence for the ARGUMENT's own description,
// per scope: a second reader written by hand drifts, and a `contact` call shown the conversation's
// labels is an invitation to copy them onto the contact. An absent scope is left OUT rather than
// reported empty, as in the block: "there are none" and "we did not read it" are different claims.
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

// WHICH CALLS ONE TURN MAY DISPATCH TOGETHER, because their tool commits calls that arrive together
// as one write: the conversation's labels (the handler below) and the conversation's attributes
// (`ChatwootClient.setConversationCustomAttributes`). Calls sharing a key reach Chatwoot as one read
// and one write; `null` is a call that stays on its own. A caller that dispatches one call at a time
// (the `decisions` engine) asks this to know which ones to send out side by side.
export function sharedWriteKey(
  tool: string,
  args: Record<string, unknown>,
): string | null {
  const scope = args.scope ?? "conversation";
  if (scope !== "conversation") return null;
  if (tool === "set_labels") return "conversation-labels";
  if (tool === "set_custom_attribute") return "conversation-attributes";
  return null;
}

// One `set_labels` call on the conversation scope that has not been written yet.
interface PendingLabelDelta {
  add: string[];
  remove: string[];
  resolve: (report: string) => void;
  reject: (reason: unknown) => void;
}

// How long a caller's own read of the conversation's labels stands in for the tool's.
const LABELS_READ_FRESH_MS = 10_000;

// The `set_labels` calls one entry of the conversation's label queue will write together. While it
// is the queue's tail, which it stops being when its read comes back, a call of the same turn (the
// tool context is one turn's) joins it instead of queueing behind it.
class LabelBatch {
  readonly deltas: PendingLabelDelta[] = [];
  constructor(readonly ctx: ToolCtx) {}
}

// Sets the labels (tags) on the conversation, the contact, or this conversation's kanban card (scope,
// default 'conversation'). Endpoints, per the chatwoot-pro fork: conversation and contact labels GET
// → { payload: [] }, POST /{conversations|contacts}/{id}/labels { labels } replaces; task labels via
// PATCH /kanban/tasks/{id} { task: { labels } }. The enumerated labels are the account's Label
// titles; task tags may use a separate taggable namespace on the fork, so confirm live before relying
// on the suggestion for task scope. The delta: docs/graph.md, "`set_labels`: the model names the delta".
function setLabelsTool(ctx: ToolCtx) {
  // The account's vocabulary is offered whole: the guard is enforced on the way in, and a
  // whole list is what stops an agent inventing `duvidas-evento` because the canonical value was
  // out of its sight.
  const labelsXml = existingLabelsXml(ctx.vocab?.labels ?? []);
  // 'task' scope is only offered when this conversation actually has a linked card (ctx.kanban).
  const taskScope = !!ctx.kanban;
  const scopeSchema = taskScope
    ? z.enum(["conversation", "contact", "task"])
    : z.enum(["conversation", "contact"]);
  const currentXml = currentLabelsXml(ctx.shownLabels);
  // NAMED UP FRONT, so a refusal is not the model's way of discovering the fence: these are
  // visible, and a model that reads one off `<current_labels>` and decides it belongs elsewhere
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
  // THE OPERATOR'S LIST, named up front for the same reason the guard is: a refusal
  // should not be how the model learns the taxonomy. Under `refuse` it REPLACES the "a label that
  // is not listed is created" sentence below, which would otherwise contradict it.
  const allowedList = [...new Set(ctx.allowedLabels ?? [])].filter(Boolean);
  const allowedMode = ctx.outsideAllowedLabels ?? "refuse";
  const allowed = allowedList.length
    ? { labels: allowedList, mode: allowedMode }
    : undefined;
  // WHOLE, not cut at SHOWN_LABELS_MAX like the other lists: a title the model is never shown
  // is one it cannot pick, and the list is already bounded where it is stored (at most
  // ALLOWED_LABELS_MAX).
  const allowedNamed = allowedList.map((l) => `'${l}'`).join(", ");
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
  // One entry of the conversation's label queue, shared with the observer's verdict and the nudge's
  // own merge: the endpoint replaces the whole set, so an unqueued read-then-POST erases what
  // another writer added between the two. Every call the entry holds is applied to ONE read, one
  // delta after the other in the order the calls were made, and the set they add up to goes out in
  // one POST; each call still answers for its own delta, with the set as it stood after it. Never
  // rejects: each call is answered through its own promise.
  const writeConversationLabels = async (batch: LabelBatch): Promise<void> => {
    // From here on nobody joins: a call that arrives now queues an entry of its own.
    const close = () =>
      closeConversationLabelsTail(ctx.tenantId, ctx.conversationId, batch);
    try {
      const known = ctx.conversationLabelsRead;
      let current: string[];
      if (known && Date.now() - known.at <= LABELS_READ_FRESH_MS) {
        // No request to wait on, so one turn of the event loop instead: the calls dispatched beside
        // this one are still on their way to the queue.
        await new Promise((r) => setImmediate(r));
        current = known.labels;
      } else {
        current = await ctx.client.getConversationLabels(ctx.conversationId);
      }
      close();
      let state = current;
      const outcomes = batch.deltas.map((d) => {
        const outcome = applyLabelDelta(
          d.add,
          d.remove,
          state,
          guarded,
          allowed,
        );
        state = outcome.next;
        return { delta: d, ...outcome };
      });
      const report = (o: (typeof outcomes)[number]) =>
        labelWriteReport(
          "conversation",
          o.added,
          o.removed,
          o.next,
          o.refusedAdd,
          o.refusedRemove,
          o.heldRemove,
          o.refusedOutside,
        );
      const moved = (o: (typeof outcomes)[number]) =>
        o.added.length > 0 || o.removed.length > 0;
      if (!outcomes.some(moved)) {
        // NOTE: Nothing moved: see the sibling scopes.
        recordShown(ctx, "conversation", state);
        for (const o of outcomes) {
          ctx.onNoEffect?.("set_labels");
          o.delta.resolve(report(o));
        }
        return;
      }
      // NOTE: ASKED AGAIN HERE, inside the queue and after the GET, and not only at the tool boundary
      // the graph already fences. Waiting for the queue is a wait like any other: `/reset`
      // peels the episode's labels off in this very queue (webhook.ts), so a call that was
      // wanted when it entered can land on a conversation the operator has just been told was
      // cleared. Only an explicit `false` stops the write: a fence that could not answer is not
      // a withdrawal.
      if (ctx.stillWanted && !(await ctx.stillWanted())) {
        for (const o of outcomes) {
          ctx.onNoEffect?.("set_labels");
          o.delta.resolve(
            "Could not set the labels (the run was called off while this write waited its turn).",
          );
        }
        return;
      }
      // Forgotten before the write: a write that fails leaves nothing known about the set.
      ctx.conversationLabelsRead = undefined;
      const writtenAt = Date.now();
      await ctx.client.setConversationLabels(ctx.conversationId, state);
      if (known) ctx.conversationLabelsRead = { labels: state, at: writtenAt };
      recordShown(ctx, "conversation", state);
      for (const o of outcomes) {
        if (moved(o)) {
          ctx.onLabelsWritten?.(
            describeLabelWrite("conversation", o.added, o.removed, o.next, {
              allowed: allowedList,
              acceptedOutside: o.acceptedOutside,
            }),
          );
        } else {
          ctx.onNoEffect?.("set_labels");
        }
        o.delta.resolve(report(o));
      }
    } catch (err) {
      close();
      // Settling twice is a no-op, so the calls already answered are not disturbed.
      for (const d of batch.deltas) d.reject(err);
    }
  };
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
      // THE RETIRED SHAPE IS REFUSED BY NAME: operator prose written for a complete-list
      // contract makes a model send `{labels: [...]}`, and a strict schema would strip the key and
      // leave an empty delta, so the call would answer "already as requested" for a classification
      // that was never written.
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
        // THE CARD IS READ FRESH, like the other two scopes: one GET by id, since the id is in
        // hand. The turn-prep snapshot would make "not named, not touched" false on this scope. A
        // read that fails REFUSES the write rather than falling back to the snapshot, which would
        // reintroduce the erasure silently; the conversation scope answers an unreadable state the
        // same way.
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
          // NOTE: NOTHING MOVED, so nothing is written: the POST is skipped entirely.
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
        // NOTE: ASKED AGAIN, after the GET and before the write, for the reason the two sibling
        // scopes state: the read is a WAIT, and `/reset` can retire the run while it is in flight.
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
        // NOTE: Kept in step anyway: the snapshot still feeds the description block and anything else in
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
        // NOTE: ASKED AGAIN, after the GET and before the write, the same rule as every handler
        // here that waits before writing. The conversation scope asks inside its queue; this scope
        // has no queue, and the read above is just as much a wait.
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
      // ONE WRITE FOR THE CALLS THAT ARRIVE TOGETHER: a call that finds this turn's own entry at
      // the TAIL of the label queue, its read still out, joins that entry. Only the tail can be
      // joined, so a call is never merged ahead of a writer queued in between.
      return new Promise<string>((resolve, reject) => {
        const mine: PendingLabelDelta = { add, remove, resolve, reject };
        const tail = conversationLabelsTail(ctx.tenantId, ctx.conversationId);
        if (tail instanceof LabelBatch && tail.ctx === ctx) {
          tail.deltas.push(mine);
          return;
        }
        const batch = new LabelBatch(ctx);
        batch.deltas.push(mine);
        void withConversationLabels(
          ctx.tenantId,
          ctx.conversationId,
          () => writeConversationLabels(batch),
          batch,
        );
      });
    },
    {
      name: "set_labels",
      description: withOperatorNote(
        baseDescription + allowedSentence + guardedSentence,
        ctx,
        "set_labels",
        [currentXml, labelsXml].filter(Boolean).join("\n"),
      ),
      // NOTE: LOOSE ON PURPOSE: a call carrying the retired `labels` key has to REACH the handler so it
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

// What the close could not do with the operator's labels goes to the flow log and the alert, never
// to the model, which can do nothing about a label the account lacks or a write that failed.
function reportResolveLabels(ctx: ToolCtx, result: ResolveLabelsResult) {
  if (result.unknown.length > 0) {
    ctx.onSideEffectError?.({
      tool: "resolve_conversation",
      phase: "resolve_labels_unknown",
      detail: { labels: result.unknown },
      err: new Error(
        `resolve labels not in the account: ${result.unknown.join(", ")}`,
      ),
    });
  }
  if (result.outcome === "failed" || result.heldBy === "unread") {
    ctx.onSideEffectError?.({
      tool: "resolve_conversation",
      phase: "resolve_labels",
      err: result.error,
      // NOTE: Labels held back because the contact's open case could not be ruled out are `info`:
      // the conversation closed and the customer was answered, and nobody can act on a contact with
      // that many conversations. A label write that failed stays a `warn`.
      ...(result.outcome !== "failed" ? { level: "info" as const } : {}),
    });
  }
}

function resolveConversationTool(ctx: ToolCtx) {
  const deferred = ctx.turnState !== undefined;
  return tool(
    async () => {
      // NOTE: THE TRANSFER OF THIS TURN ALREADY HAPPENED, so the conversation belongs to the human
      // queue and closing it is not ours to do. The reactive runtime drops a DEFERRED intent after a
      // transfer, but this tool closes IMMEDIATELY whenever no `turnState` was handed down (every
      // proactive turn and every observation), and that close would take the conversation out of
      // the queue the transfer just put it in. Asked before both branches, so the model reads what
      // happened rather than a schedule cancelled out of sight.
      if (ctx.handoffState?.completed) {
        return "Did not resolve: this turn transferred the conversation to a human, so it is theirs to close, not yours.";
      }
      const ts = ctx.turnState;
      if (ts) {
        // NOTE: Deferred: the runtime toggles the status after the final reply is delivered. The
        // wording stays conditional on purpose — the intent is discarded on takeover/supersede,
        // and a flat "resolved" would be a false claim in the checkpointed thread history.
        ts.resolveRequested = true;
        ts.resolveByModel = true;
        ts.resolveLabels = ctx.resolveLabels ?? [];
        ts.resolveCaseHold = ctx.resolveCaseHold ?? null;
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
      // NOTE: ASKED AGAIN HERE, after that read and before the toggle, for the same reason
      // `set_labels` asks again inside its queue: the read above is a WAIT, and the graph's ask at
      // the tool boundary happened before it. A `/reset` peels the episode off in that window, and an
      // observation holds no thread claim to stop one (`runObserve` takes none), so without this the
      // close, which nothing later undoes, lands on a conversation the operator was told was
      // cleared. Only an explicit `false` stops it: a fence that could not answer is not a withdrawal.
      if (ctx.stillWanted && !(await ctx.stillWanted())) {
        ctx.onNoEffect?.("resolve_conversation");
        return "Did not resolve the conversation (the run was called off while this read was in flight).";
      }
      // Before the toggle, for the reason the deferred path writes them before its own: Chatwoot
      // reads the survey rules when the status changes.
      const labelled = await applyResolveLabels({
        client: ctx.client,
        tenantId: ctx.tenantId,
        conversationId: ctx.conversationId,
        // NOTE: Already closed by somebody else (read live above): theirs, not the agent's, so no label.
        labels:
          recordable && observed.status === "resolved"
            ? []
            : (ctx.resolveLabels ?? []),
        stillWanted: ctx.stillWanted,
        caseHold: ctx.resolveCaseHold ?? null,
      });
      reportResolveLabels(ctx, labelled);
      // NOTE: Asked again whatever the labels came to: a held label, an unknown one and the POST are waits
      // too. A label POST that went out may have landed, so only a close that sent none reports no
      // effect.
      if (
        labelled.outcome === "called_off" ||
        (ctx.stillWanted && !(await ctx.stillWanted()))
      ) {
        if (!labelled.dispatched) {
          ctx.onNoEffect?.("resolve_conversation");
        }
        return "Did not resolve the conversation (the run was called off while this read was in flight).";
      }
      await ownStatusChange(ctx, () =>
        ctx.client.toggleStatus(ctx.conversationId, "resolved"),
      );
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
      return RESOLVE_DONE;
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
      // NOTE: Best-effort fleet event (ids only, no PII).
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

const CONTACT_FIELD_SCHEMA: Record<ContactField, z.ZodString> = {
  name: z
    .string()
    .max(120)
    .describe(
      "The customer's own name exactly as they stated or corrected it; never invent a surname.",
    ),
  email: z.string().max(254).describe("The customer's email address."),
  company_name: z.string().max(120).describe("The customer's company."),
  city: z.string().max(120).describe("The customer's city."),
  country: z
    .string()
    .max(120)
    .describe(
      "The country's name as Chatwoot spells it in English (e.g. Brazil, Portugal).",
    ),
  description: z
    .string()
    .max(500)
    .describe("A short note about the customer, in their own terms."),
};

const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE_SHAPE = /^\+?[\d\s().-]+$/;

// One field's value as it is written, or the reason it is refused. Every value has its whitespace
// collapsed; a name must carry a letter and must not be a phone number (the shape a model most
// often mistakes for one), and an email must look like one. The letter test lives here and not in
// the zod schema: `\p{L}` does not survive the JSON Schema some providers are handed.
function contactFieldValue(
  field: ContactField,
  raw: string,
): { value: string } | { refused: string } {
  const value = raw.trim().replace(/\s+/g, " ");
  if (!value) return { refused: `${field} is empty` };
  if (field === "name") {
    if (PHONE_SHAPE.test(value))
      return { refused: "name must not be a phone number" };
    if (!/\p{L}/u.test(value))
      return { refused: "name must contain at least one letter" };
  }
  if (field === "email" && !EMAIL_SHAPE.test(value)) {
    return { refused: "email is not an email address" };
  }
  return { value };
}

// Write-through of the fields just written into OUR mirror, so the contact block of the next turn
// (and a proactive nudge, which has no inbound event before it) reads them at once. Each field's
// source watermark moves to now, never back (GREATEST ignores NULL): Chatwoot does not deliver
// contact_updated to bots, so the next event about this contact may carry a snapshot from before
// the write, and the watermark is what keeps it from undoing it. `AT TIME ZONE 'UTC'` because the
// columns are TIMESTAMP holding UTC (see mirrorAttributeWrite). Best-effort: logged, never surfaced.
async function mirrorContactFieldsWrite(
  ctx: ToolCtx,
  written: Partial<Record<ContactField, string>>,
): Promise<void> {
  if (!ctx.base || ctx.tenantId == null || ctx.contactDbId == null) return;
  const tenantId = ctx.tenantId;
  const contactDbId = ctx.contactDbId;
  const hasName = written.name !== undefined;
  const hasEmail = written.email !== undefined;
  const additional: Partial<Record<AdditionalContactField, string>> = {};
  for (const [field, value] of Object.entries(written) as [
    ContactField,
    string,
  ][]) {
    if (isAdditionalContactField(field)) additional[field] = value;
  }
  const hasAdditional = Object.keys(additional).length > 0;
  const patch = JSON.stringify(additional);
  try {
    await runScopedOn(
      ctx.base,
      sysCtx(tenantId),
      (db) =>
        db.$executeRaw`
        UPDATE contacts SET
          name = CASE WHEN ${hasName} THEN ${written.name ?? null}::text ELSE name END,
          name_at = CASE WHEN ${hasName} THEN GREATEST(name_at, (NOW() AT TIME ZONE 'UTC')) ELSE name_at END,
          email = CASE WHEN ${hasEmail} THEN ${written.email ?? null}::text ELSE email END,
          email_at = CASE WHEN ${hasEmail} THEN GREATEST(email_at, (NOW() AT TIME ZONE 'UTC')) ELSE email_at END,
          additional_attributes = CASE WHEN ${hasAdditional} THEN additional_attributes || ${patch}::jsonb ELSE additional_attributes END,
          additional_attributes_at = CASE WHEN ${hasAdditional} THEN GREATEST(additional_attributes_at, (NOW() AT TIME ZONE 'UTC')) ELSE additional_attributes_at END
        WHERE id = ${contactDbId} AND tenant_id = ${tenantId}
      `,
    );
  } catch (e) {
    logger.warn(
      "contact mirror write-through failed: %s",
      e instanceof Error ? e.message : String(e),
    );
    ctx.onSideEffectError?.({
      tool: "update_contact",
      phase: "mirror_write",
      detail: { fields: Object.keys(written) },
      err: e,
    });
  }
}

// Writes the contact's standard Chatwoot fields the operator made writable for this agent, in one
// PUT. The schema carries only those fields, so a field the operator did not enable cannot even be
// attempted. A write Chatwoot refuses (an email already on another contact of the account is the
// ordinary case) comes back as a tool failure, never as a friendly sentence on an `ok` line.
function updateContactTool(ctx: ToolCtx, writable: ContactField[]) {
  const shape: Partial<Record<ContactField, z.ZodOptional<z.ZodString>>> = {};
  for (const f of writable) shape[f] = CONTACT_FIELD_SCHEMA[f].optional();
  return failableTool(
    async (input: Partial<Record<ContactField, string>>) => {
      const written: Partial<Record<ContactField, string>> = {};
      const refused: string[] = [];
      for (const f of writable) {
        const raw = input[f];
        if (raw === undefined) continue;
        const r = contactFieldValue(f, raw);
        if ("refused" in r) refused.push(r.refused);
        else written[f] = r.value;
      }
      if (refused.length > 0) {
        ctx.onNoEffect?.("update_contact");
        return toolFailure(
          `Nothing was updated: ${refused.join("; ")}. Ask the customer again rather than guessing.`,
        );
      }
      if (Object.keys(written).length === 0) {
        ctx.onNoEffect?.("update_contact");
        return toolFailure(
          `Nothing was updated: pass at least one of ${writable.join(", ")}.`,
        );
      }
      if (!ctx.base || ctx.tenantId == null || ctx.contactDbId == null) {
        ctx.onNoEffect?.("update_contact");
        return "Could not update the contact (no contact in scope).";
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
        ctx.onNoEffect?.("update_contact");
        return "Could not update the contact (contact not linked to Chatwoot).";
      }
      // NOTE: Asked after the lookup and before the write, as set_custom_attribute does: a contact's
      // data outlives the conversation, so a write after a `/reset` is one nothing later corrects.
      if (ctx.stillWanted && !(await ctx.stillWanted())) {
        ctx.onNoEffect?.("update_contact");
        return "Could not update the contact (the run was called off while this write waited).";
      }
      const additional: Partial<Record<AdditionalContactField, string>> = {};
      for (const [f, v] of Object.entries(written) as [
        ContactField,
        string,
      ][]) {
        if (isAdditionalContactField(f)) additional[f] = v;
      }
      try {
        await ctx.client.updateContact(
          contact.chatwootContactId,
          {
            ...(written.name !== undefined ? { name: written.name } : {}),
            ...(written.email !== undefined ? { email: written.email } : {}),
            ...(Object.keys(additional).length > 0
              ? { additional_attributes: additional }
              : {}),
          },
          // NOTE: The fence is asked again inside the contact's queue, since the wait for it is a
          // wait too, and the mirror is written inside it, so two writes reach it in Chatwoot's order.
          {
            stillWanted: ctx.stillWanted,
            afterWrite: () => mirrorContactFieldsWrite(ctx, written),
          },
        );
      } catch (e) {
        if (e instanceof ChatwootCalledOffError) {
          ctx.onNoEffect?.("update_contact");
          return "Could not update the contact (the run was called off while this write waited its turn).";
        }
        if (
          e instanceof ChatwootApiError &&
          e.status >= 400 &&
          e.status < 500
        ) {
          return toolFailure(
            written.email !== undefined && e.status === 422
              ? "Chatwoot refused the update (HTTP 422). The email is most likely already on another contact of this account; tell the customer it could not be saved rather than retrying."
              : `Chatwoot refused the update (HTTP ${e.status}). Nothing was saved.`,
          );
        }
        throw e;
      }
      return `Contact updated: ${Object.keys(written).join(", ")}.`;
    },
    {
      name: "update_contact",
      description: withOperatorNote(
        `Save the customer's own contact details on their Chatwoot contact: ${writable.join(", ")}. Only what the customer explicitly said in this conversation; never invent or complete a value. The current values are in <contact_fields>. Pass only the fields that change.`,
        ctx,
        "update_contact",
      ),
      // NOTE: minProperties reaches the model's JSON schema only; an empty call that slips through is
      // still refused in the body.
      schema: z.object(shape).meta({ minProperties: 1 }),
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
      const saved =
        preference === "default"
          ? "Voice preference reset: replies now mirror what the customer sends (audio→audio, text→text)."
          : `Voice preference saved: the customer prefers ${preference} replies.`;
      if (!ctx.replyIsAudioWith) return saved;
      return `${saved} The reply you are writing now will be sent as ${
        ctx.replyIsAudioWith(value) ? "a voice note" : "a text message"
      }.`;
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
        // NOTE: The customer's last message is itself a reaction → WhatsApp can't react to a reaction, and
        // reacting would target the wrong (penultimate) message. Refuse without calling the API.
        if (latest.isReaction) {
          return "The customer's last message is a reaction (emoji), and you can't react to a reaction. Do not react now.";
        }
        // NOTE: ASKED AGAIN, after the lookup that found the message to react to. A reaction is on the
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

const SKIP_REPLY_DESCRIPTION =
  "Decide NOT to send any reply this turn, then output NO reply text (end your turn). `reason` decides what happens next: `acknowledged` when a reply would add nothing (the customer sent just 'ok', 'obrigado' or an emoji, optionally after react_to_message) and the conversation stays with you; `not_for_us` when this is not a real conversation (an automated report, a payment notice, a newsletter, an unsolicited pitch); `needs_human` when it is a real request you cannot resolve. The last two hand the conversation to the team with a private note, and so does ANY skip on a conversation nobody on our side has answered yet.";

// Deliberately produce NO reply this turn. The agent calls this, then ends without any customer-facing
// text, so the runtime posts nothing (it already skips an empty reply). The call is recorded in the
// conversation timeline (via the tool flow log) as a "decided not to respond" marker, and its REASON
// decides whether the conversation stays with the bot or goes to a person (../silence.ts).
function skipReplyTool(ctx: ToolCtx) {
  // A MUTED turn (an observer) runs no hand-over after it: nothing reads the reason back out of an
  // observation, which throws its final output away. So the promise is not made there, and the way
  // to put a person on the conversation is named instead, the contract `handoff_to_human` already
  // gives the same turn.
  const speaks = !ctx.client?.muted;
  return tool(
    async (
      { reason, detail }: { reason: SkipReplyReason; detail?: string },
      config: ToolRunnableConfig,
    ) => {
      const note = detail?.trim() ? `${reason}: ${detail.trim()}` : reason;
      // The ack is what the MODEL reads: LangGraph calls it again after a tool result, and this
      // sentence is the instruction that makes the turn end quiet.
      const ack = `${SKIP_REPLY_ACK} (${note}). Produce no message now.`;
      // ...and the MARK is what identifies the tool, in `additional_kwargs`, out of reach of
      // any response body. Returned as a whole `ToolMessage` for that, the same
      // direct-tool-output passthrough `failableTool` uses; without a tool_call in scope (a direct
      // invocation with plain args) it degrades to the plain string, as that one does.
      const id = config?.toolCall?.id;
      if (!id) return ack;
      return new ToolMessage({
        content: ack,
        tool_call_id: id,
        name: SKIP_REPLY_TOOL,
        additional_kwargs: {
          [SKIP_REPLY_MARK]: true,
          [SKIP_REPLY_REASON_KEY]: reason,
          ...(detail?.trim()
            ? {
                [SKIP_REPLY_DETAIL_KEY]: clipText(
                  detail.trim(),
                  SKIP_DETAIL_MAX,
                ),
              }
            : {}),
        },
      });
    },
    {
      name: "skip_reply",
      description: speaks
        ? SKIP_REPLY_DESCRIPTION
        : "Record that this turn adds nothing, then output NO text (end your turn). This turn does not answer the customer, and `reason` is only recorded: nothing is handed over by it. To put a person on the conversation, call handoff_to_human.",

      schema: z.object({
        reason: z.enum(SKIP_REPLY_REASONS),
        detail: z
          .string()
          .max(SKIP_DETAIL_MAX)
          .optional()
          .describe(
            'One short sentence for the team about what this is (e.g. "DMARC report from a mail server"). Shown only when the conversation is handed over.',
          ),
      }),
    },
  );
}

// The image half of the shared attachment queue, which is what both send_image ceilings are about.
export function queuedImages(turnState: TurnState): PendingAttachment[] {
  return turnState.pendingAttachments.filter((a) => a.kind === "image");
}

// The model-facing refusal when a turn has already taken all the images it may carry. Same wording
// for the count and the byte budget: from the model's side both mean "not this turn".
function limitReached(): string {
  return `Limite de imagens deste turno atingido (${SEND_IMAGE_MAX_PER_TURN}). Envie as demais em outra mensagem ou responda com o link em texto.`;
}

// Sends an image the agent already has a URL for (a product photo from an HTTP tool, an MCP tool or
// a catalog integration) as a real attachment, instead of pasting a link the customer has to open.
// The URL is MODEL-supplied, so the hosts it may be fetched from are an operator decision that lives
// in the agent's config, never in a tool argument: a prompt injection can write any URL it likes and
// still not reach a host the operator did not list. See modules/images/fetch for the rest of the
// fence (SSRF assertion, no redirects, byte cap on the body, type read from the file's signature).
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
      // Both refusals below are decided BEFORE the fetch. Downloading megabytes over ten
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
      // One model response can carry a batch of tool calls, and the graph's tool-call limit is
      // only re-checked between responses, so the queue needs its own ceiling (every accepted image
      // is held in memory until the turn ends). The slot is taken BEFORE the await: the batch runs
      // concurrently, and a check spanning the download would be read by every call while the queue
      // is still empty. Bytes are enforced after the download, where the size is known. It counts
      // IMAGES, not the queue: a document (one per turn) eating an image slot would change what the
      // operator reads as "images per message".
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
          // A refusal the OPERATOR has to fix (no hosts configured, host not listed) is normal
          // operation for the model — it should answer with a link instead — but it is not normal
          // for the operator, so only the transport failures are marked as integration failures.
          const message = sendImageRefusal(res.reason, res.detail);
          return res.reason === "unreachable" || res.reason === "http_error"
            ? toolFailure(message)
            : message;
        }
        // Re-read the queue and count THIS image in: the batch's other calls may have queued
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

// An addition whose note did not reach the case: withdrawn before it, or the write failed.
function additionLost(r: OpenCaseResult): boolean {
  return (
    (r.kind === "appended" || r.kind === "already_open") &&
    r.additionDelivered === false
  );
}

// What the model reads after `open_case_in_inbox`, one sentence per outcome. The ones that ask for
// something are instructions the model acts on in its reply; none of them tells it to stay silent,
// because the customer still has to hear, on the channel they are on, where their case went.
function openCaseOutcomeText(
  r: OpenCaseResult,
  closing: "scheduled" | "not_here" | null = null,
): string {
  const close =
    closing === "scheduled"
      ? " This conversation will be marked resolved after your reply in this turn is delivered."
      : closing === "not_here"
        ? " This conversation is NOT closed by this tool."
        : "";
  switch (r.kind) {
    case "opened":
    case "continued": {
      const how =
        r.kind === "opened"
          ? `Case opened: conversation #${r.caseId} in the destination inbox.`
          : `The customer already had an open case there, so it was continued: conversation #${r.caseId}. No new opening message was sent.`;
      const partial = r.partial.length
        ? ` Some follow-up writes did not land (${r.partial.join(", ")}); the case itself is open.`
        : "";
      const blocked = r.openingBlocked
        ? " The opening message was refused by the output check and was NOT sent; the case is open without it."
        : r.openingOutsideWindow
          ? " The opening message was NOT sent: that channel only lets the team write first with an approved template, so it was left for the team as a note. Do not say a message was sent to them there."
          : "";
      return `${how}${partial}${blocked} Tell the customer, in your reply here, that their case was opened and the team will contact them there.${close}`;
    }
    case "already_open":
      return additionLost(r)
        ? `This conversation already opened a case that is still open: conversation #${r.caseId}. Nothing new was opened, and what you passed in \`reason\` could NOT be added to that case, so the team does not have it. Do not tell the customer it reached the team; hand off to a human with handoff_to_human so a person sees it.${close}`
        : `This conversation already opened a case that is still open: conversation #${r.caseId}. Nothing new was opened; what you passed in \`reason\` was added to that case as an internal note. Tell the customer their case is already with the team.${close}`;
    case "appended": {
      if (additionLost(r)) {
        return `The customer already has an open case with the team, opened from another conversation: conversation #${r.caseId}. Nothing new was opened, but what you passed in \`reason\` could NOT be added to that case, so the team does not have it. Do not tell the customer it reached the team; hand off to a human with handoff_to_human so a person sees it.${close}`;
      }
      const partial = r.partial.length
        ? ` Some writes did not land (${r.partial.join(", ")}).`
        : "";
      return `The customer already has an open case with the team, opened from another conversation: conversation #${r.caseId}. Nothing new was opened and no message was sent to them there; what you passed in \`reason\` was added to that case as an internal note, and this conversation is now linked to it.${partial} Tell the customer, in your reply here, that what they added reached the team handling their case, and that the answer still comes from there.${close}`;
    }
    case "needs_email":
      return "Nothing was opened: the destination is an email inbox and this contact has no email address. Ask the customer for their email, then call this tool again with `email` set to exactly what they typed.";
    case "needs_phone":
      return "Nothing was opened: the destination needs the contact's phone number, and this contact has none. Hand off to a human instead.";
    case "rejected_email":
      return r.why === "invalid"
        ? "Nothing was opened: that is not a valid email address. Ask the customer to type their email again."
        : "Nothing was opened: `email` must be an address the customer typed in this conversation, and this one is not among their messages. Ask the customer for their email and pass exactly what they typed.";
    case "unsupported_channel":
      return "Nothing was opened: the configured destination inbox cannot start conversations. Hand off to a human instead.";
    case "same_inbox":
      return "Nothing was opened: this conversation is already in the destination inbox, so there is nowhere to move it. If the customer needs the team, hand off to a human instead.";
    case "not_configured":
      return "Nothing was opened: no destination inbox is configured. Hand off to a human instead.";
    case "called_off":
      return "Did not open the case (the run was called off before anything was written).";
    case "handed_by_policy":
      return `Did not open the case: the output check refused the opening message. ${OPEN_CASE_HANDED_MARK} by its policy. Do not call this tool again in this conversation.`;
    case "failed":
      return "";
  }
}

function openCaseInInboxTool(ctx: ToolCtx) {
  const openingTemplate = ctx.crossInboxCase?.config.openingTemplate ?? null;
  const asksMessage = openingAsksMessage(openingTemplate);
  const opening =
    openingTemplate === null
      ? "`customer_message` is the first message the customer receives THERE (for an email inbox, the opening email), so write it as that message."
      : asksMessage
        ? "`customer_message` is your part of the first message the customer receives THERE: it goes inside the team's own opening text, so write only what is specific to this request."
        : "The customer receives the team's fixed opening message THERE; you do not write it.";
  const description =
    `Open the customer's case in the team's other inbox (configured by the operator: you choose WHETHER to open it, never where), without asking the customer to switch channels. Use it when the request has to be handled by the team that works in that inbox. \`reason\` becomes an internal note on the case. ${opening} Call it directly: it reads the contact's email and phone itself, so do not ask the customer for them first. Only when the result says an email is missing, ask for it and call again with exactly the address they typed. Tell the customer here where their case went. When the customer adds something after their case was opened, in this conversation or in a new one, call it again with the addition in \`reason\`: it goes to the open case as a note, and no second case is opened.` +
    (ctx.crossInboxCase?.config.resolveOrigin && ctx.turnState
      ? " Once the case is open, this conversation is closed after your reply is delivered."
      : " This tool does NOT close this conversation; close with resolve_conversation if that is the next step.");
  return failableTool(
    async ({
      reason,
      customer_message,
      email,
      labels,
      handoff_message,
      summary,
    }: {
      reason: string;
      customer_message?: string;
      email?: string;
      labels?: string[];
      handoff_message?: string;
      summary?: string;
    }) => {
      const cic = ctx.crossInboxCase;
      if (!cic) return openCaseOutcomeText({ kind: "not_configured" });
      const result = await openCaseInInbox(ctx.client, {
        config: cic.config,
        originConversationId: ctx.conversationId,
        originContactId: cic.contactId,
        reason: reason.trim(),
        customerMessage: (asksMessage && customer_message?.trim()) || null,
        email: email?.trim() || null,
        labels: (labels ?? [])
          .map((l) => l.trim().toLowerCase())
          .filter((l) => l.length > 0),
        subject: cic.renderSubject?.(summary?.trim() || null) ?? null,
        stillWanted: ctx.stillWanted,
        tenantId: ctx.tenantId,
        screenCustomerMessage: ctx.screenCustomerText,
        signCustomerMessage: cic.sign,
        interpolate: cic.interpolate,
        attendanceStartedAt: cic.attendanceStartedAt,
        // NOTE: The team this agent hands conversations to, when the operator pinned one: the case goes to
        // the same people. `ctx.handoff` is already the effective config, so a pin picked in another
        // account arrives here as `agent_choice` and no team is written. A pinned PERSON is not
        // assigned to the case: whose case it is inside the team stays the team's call.
        caseTeamId:
          ctx.handoff?.mode === "pinned" && !ctx.handoff.targetAgentId
            ? (ctx.handoff.targetTeamId ?? null)
            : null,
      });
      if (result.kind === "called_off") ctx.onNoEffect?.(OPEN_CASE_TOOL_NAME);
      if (result.kind !== "failed") {
        // NOTE: A configured case label the account does not have: the operator's to fix, so it goes to
        // the flow log and the alert, and not to the model, which can do nothing about it.
        if (
          (result.kind === "opened" ||
            result.kind === "continued" ||
            result.kind === "appended") &&
          result.unknownCaseLabels?.length
        ) {
          ctx.onSideEffectError?.({
            tool: OPEN_CASE_TOOL_NAME,
            phase: "case_labels_unknown",
            detail: { caseId: result.caseId, labels: result.unknownCaseLabels },
            err: new Error(
              `case labels not in the account: ${result.unknownCaseLabels.join(", ")}`,
            ),
          });
        }
        if (
          (result.kind === "opened" ||
            result.kind === "continued" ||
            result.kind === "already_open" ||
            result.kind === "appended") &&
          result.partial.length > 0
        ) {
          ctx.onSideEffectError?.({
            tool: OPEN_CASE_TOOL_NAME,
            phase: "follow_up_writes",
            detail: { caseId: result.caseId, failed: result.partial },
            err: new Error(`writes did not land: ${result.partial.join(", ")}`),
          });
        }
        if (
          (result.kind === "opened" ||
            result.kind === "continued" ||
            result.kind === "already_open" ||
            result.kind === "appended") &&
          result.caseOwnerUnread
        ) {
          ctx.onSideEffectError?.({
            tool: OPEN_CASE_TOOL_NAME,
            phase: "case_owner_unread",
            detail: { caseId: result.caseId, at: result.caseOwnerUnread },
            err: new Error(
              result.caseOwnerUnread === "before_clear"
                ? "the case could not be read to settle its owner; nothing was written, so an agent bot on it stays and no team was set"
                : "the case could not be read again before its team write; the bot was cleared and no team was written",
            ),
          });
        }
        // NOTE: What the files step did goes to the flow log, never to the model: the case is open either
        // way, and a count in the result would invite the model to talk about it.
        if (
          (result.kind === "opened" ||
            result.kind === "continued" ||
            result.kind === "already_open" ||
            result.kind === "appended") &&
          result.attachments
        ) {
          const a = result.attachments;
          if (a.carried + a.skipped + a.failed > 0 || a.unread || a.truncated) {
            ctx.onSideEffectError?.({
              tool: OPEN_CASE_TOOL_NAME,
              phase: "case_attachments",
              ...(a.failed > 0 || a.unread || a.truncated
                ? { level: "warn" as const }
                : { status: "ok" as const }),
              detail: {
                caseId: result.caseId,
                carried: a.carried,
                skipped: a.skipped,
                failed: a.failed,
                ...(a.unread ? { unread: a.unread } : {}),
                ...(a.truncated ? { truncated: true } : {}),
              },
              err: new Error(
                a.unread
                  ? `customer files not carried: the ${a.unread === "attendance" ? "attendance boundary" : "case"} could not be read`
                  : `customer files: ${a.carried} carried, ${a.skipped} skipped, ${a.failed} failed${a.truncated ? "; the walk stopped at its page limit, older files were not seen" : ""}`,
              ),
            });
          }
        }
        const caseOpen =
          result.kind === "opened" ||
          result.kind === "continued" ||
          result.kind === "already_open" ||
          result.kind === "appended";
        // THE OPERATOR'S CLOSE RIDES THE SAME DEFERRED PATH `resolve_conversation` USES: after the
        // reply that tells the customer where the case went, and dropped when they write again
        // first. Only with a turn to defer to; a proactive turn has none, and closing immediately
        // there would take the conversation away before anything was said in it.
        let closing: "scheduled" | "not_here" | null = null;
        if (caseOpen) {
          if (additionLost(result) && ctx.turnState) {
            ctx.turnState.caseAdditionLost = true;
          }
          if (
            cic.config.resolveOrigin &&
            ctx.turnState &&
            !ctx.handoffState?.completed &&
            !ctx.turnState.caseAdditionLost
          ) {
            ctx.turnState.resolveRequested = true;
            ctx.turnState.caseClosing = true;
            closing = "scheduled";
          } else {
            closing = "not_here";
            // NOTE: a close an earlier call of this turn scheduled for the case is withdrawn, and one the
            // model asked for with resolve_conversation stands.
            if (ctx.turnState?.caseClosing) {
              ctx.turnState.resolveRequested =
                ctx.turnState.resolveByModel === true;
              ctx.turnState.caseClosing = false;
            }
          }
        }
        return openCaseOutcomeText(result, closing);
      }
      // NOTE: THE FAILURE BRANCH IS A REQUIREMENT, NOT A DETAIL: the customer asked for help, and a case
      // that did not open must not leave them talking to a bot that cannot deliver it. The
      // conversation goes to the human queue (`open`, which also stops the bot here) with a note
      // saying why, and the tool result is marked as a failure so the flow log carries it.
      logger.warn(
        "open_case_in_inbox failed (conv=%s, step=%s): %s",
        String(ctx.conversationId),
        result.step,
        result.error instanceof Error
          ? result.error.message
          : String(result.error),
      );
      let fallback = "";
      try {
        // NOTE: FENCED LIKE handoff_to_human: before the note, and again between the note and the status
        // change, which cannot be undone. A request that failed because the turn was reset or
        // withdrawn must not transfer the conversation the operator just cleared.
        if (ctx.stillWanted && !(await ctx.stillWanted())) {
          ctx.onNoEffect?.(OPEN_CASE_TOOL_NAME);
          return "Did not open the case, and did not hand off (the run was called off).";
        }
        await ctx.client.sendPrivateNote(
          ctx.conversationId,
          `⚠️ Não consegui abrir o caso na outra caixa (etapa: ${result.step}). O cliente está aguardando atendimento aqui. Motivo informado: ${literalForChatwoot(reason.trim())}`,
        );
        if (ctx.stillWanted && !(await ctx.stillWanted())) {
          return "Did not hand off (the run was called off while the note was in flight); the note was already filed.";
        }
        await ownStatusChange(ctx, () =>
          ctx.client.toggleStatus(ctx.conversationId, "open"),
        );
        // NOTE: The customer's line goes through the handoff's own delivery: after the transfer, screened
        // by the output check, and not dropped by the ownership recheck the transfer just tripped,
        // which is what happens to the model's next reply here. Without a line a person still sees
        // the conversation; the customer just reads nothing.
        if (ctx.handoffState) {
          const line = handoff_message?.trim() ?? "";
          ctx.handoffState.customerMessage = line || null;
          ctx.handoffState.lineByOperator = false;
          // NOTE: No line is a SILENT transfer, said so as `handoff_to_human` says it: otherwise the model's
          // next reply could still go out before the status webhook reaches the mirror.
          ctx.handoffState.declinedToSpeak = !line;
          ctx.handoffState.completed = true;
        }
        fallback = handoff_message?.trim()
          ? ` ${OPEN_CASE_HANDED_MARK} instead, with a note saying why. Your handoff_message will be delivered to the customer; do not repeat it.`
          : ` ${OPEN_CASE_HANDED_MARK} instead, with a note saying why. No message will reach the customer here.`;
      } catch (e) {
        ctx.onSideEffectError?.({
          tool: OPEN_CASE_TOOL_NAME,
          phase: "fallback_handoff",
          detail: { step: result.step },
          err: e,
        });
        fallback =
          " Handing the conversation to the human team also failed; call handoff_to_human.";
      }
      return toolFailure(
        `Could not open the case (failed at: ${result.step}).${fallback}`,
      );
    },
    {
      name: OPEN_CASE_TOOL_NAME,
      description: withOperatorNote(description, ctx, OPEN_CASE_TOOL_NAME),
      schema: z.object({
        reason: z
          .string()
          .min(1)
          .describe(
            "Why the case is being opened, for the team (internal note on the case).",
          ),
        ...(asksMessage
          ? {
              customer_message: z
                .string()
                .optional()
                .describe(
                  openingTemplate === null
                    ? "The first message the customer receives in the destination inbox. Omit to open the case without one."
                    : "Your part of the team's opening message in the destination inbox. Omit to open the case without an opening.",
                ),
            }
          : {}),
        email: z
          .string()
          .optional()
          .describe(
            "Leave it out on the first call. Only after a result said an email is missing: the address exactly as the customer typed it in this conversation.",
          ),
        labels: z
          .array(z.string())
          .optional()
          .describe("Labels that categorize the case in the destination."),
        handoff_message: z
          .string()
          .optional()
          .describe(
            "What the customer reads HERE if the case cannot be opened and this conversation goes to a person instead. Always provide it.",
          ),
        ...(subjectAsksSummary(
          ctx.crossInboxCase?.config.subjectTemplate ?? null,
        )
          ? {
              summary: z
                .string()
                .optional()
                .describe(
                  "One line saying what the request is about. It becomes part of the subject of the case's emails, which is what the customer and the team read first.",
                ),
            }
          : {}),
      }),
    },
  );
}

// THE TOOLS A MUTED TURN CANNOT COMPLETE, hidden from it: an observer runs the ordinary toolset, and
// these are customer-facing in their entirety (a reaction the muted transport refuses, an image or a
// case opening that needs delivery gates an observation does not have). Offered anyway they cost a
// model round each and answer with a failure an operator reads as a broken integration. Read off the
// client's own `muted`, the same field `armReminders` asks. A private note is NOT here: it is the one
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
    ...(ctx.crossInboxCase?.config.targetInboxId != null
      ? [openCaseInInboxTool(ctx)]
      : []),
    skipReplyTool(ctx),
    calculatorTool(ctx),
    getCurrentTimeTool(ctx),
  ];
  // MATERIALIZED ONCE, before the filter runs. `allowed` is an `Iterable<string>`, and a
  // one-shot one (a generator, a `Set.values()`) is CONSUMED by the first candidate: every tool
  // after it would then be tested against an empty set and the agent would come up with no tools.
  // Cheaper too: one Set instead of one per candidate.
  const allowSet = allowed ? new Set(allowed) : null;
  const granted = allowSet ? all.filter((t) => allowSet.has(t.name)) : all;
  // update_contact is outside the allowlist: the operator grants it by marking a field
  // writable, so an empty `writable` is the fail-closed state and there is no second switch.
  const writable = ctx.contactFields?.writable ?? [];
  if (writable.length > 0) granted.push(updateContactTool(ctx, writable));
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
    // lying about the one decision it exists to show.
    NATIVE_TOOL_CATEGORY[tl.name as NativeToolName] === "utility" ||
    tl.name === SKIP_REPLY_TOOL
      ? tl
      : simulatedTool(tl),
  );
}
