import logger from "@/api/lib/logger";
import type { TurnState } from "@/graph/tools/native";
import type { ChatwootClient } from "@/modules/chatwoot/client";
import { withConversationLabels } from "@/modules/chatwoot/labels";
import {
  type CaseInbox,
  openCaseFor,
} from "@/modules/cross-inbox-case/service";
import type { CrossInboxCaseConfig } from "@/modules/cross-inbox-case/settings";

// THE OPERATOR'S LABELS ON THE AGENT'S OWN CLOSE, written by the close and not by the model (see
// modules/agents/resolve-labels.ts). Called right BEFORE the status change on both paths that close
// for resolve_conversation, because Chatwoot reads the CSAT survey rules when the status changes.
// BEST-EFFORT, never throws: a label that could not be written must not keep a handled conversation
// open. The caller reports what came back.
export type ResolveLabelsOutcome =
  | "none"
  | "held"
  | "unchanged"
  | "written"
  | "called_off"
  | "failed";

export interface ResolveLabelsResult {
  outcome: ResolveLabelsOutcome;
  // Configured titles the account does not have: left off, because Chatwoot would store them as a
  // tag no folder lists, and reported to the operator. Same rule as the case labels.
  unknown: string[];
  // What held the labels off: the contact's open case, or `unread` when it could not be checked.
  heldBy?: number | "unread";
  // The label POST went out. A `failed` one may still have landed (a timeout on the answer), so a
  // caller counting effects reads this, not the outcome.
  dispatched?: boolean;
  error?: unknown;
}

export async function applyResolveLabels(input: {
  client: Pick<
    ChatwootClient,
    | "listLabels"
    | "getConversationLabels"
    | "setConversationLabels"
    | "getConversation"
    | "listContactConversations"
  >;
  tenantId: bigint | null | undefined;
  conversationId: number;
  labels: readonly string[];
  stillWanted?: () => Promise<boolean>;
  // The agent's case inbox. A contact still waiting on a case there is not done, and a survey keyed
  // on these labels must not reach them: the labels are held off, the close still happens. A case
  // that cannot be checked holds them too. Null ⇒ no case inbox, nothing is read.
  caseHold?: CaseInbox | null;
}): Promise<ResolveLabelsResult> {
  if (input.labels.length === 0) return { outcome: "none", unknown: [] };
  if (input.caseHold) {
    let heldBy: number | "unread" | null;
    let error: unknown;
    try {
      heldBy = await openCaseFor(
        input.client,
        input.conversationId,
        input.caseHold,
      );
    } catch (err) {
      heldBy = "unread";
      error = err;
    }
    if (heldBy !== null) {
      logger.info(
        `resolve labels held: conv=${input.conversationId} case=${heldBy} inbox=${input.caseHold.targetInboxId}`,
      );
      return {
        outcome: "held",
        unknown: [],
        heldBy,
        ...(error ? { error } : {}),
      };
    }
  }
  let labels = [...input.labels];
  let unknown: string[] = [];
  try {
    const known = new Set(
      (await input.client.listLabels()).map((l) => l.toLowerCase()),
    );
    unknown = labels.filter((l) => !known.has(l));
    labels = labels.filter((l) => known.has(l));
  } catch {
    // NOTE: catalog unread, written as configured: the label is what the survey keys on
  }
  if (labels.length === 0) return { outcome: "none", unknown };
  let dispatched = false;
  try {
    // Inside the conversation's label queue, with set_labels, the follow-up's assignLabels and the
    // observer's verdict: the endpoint replaces the whole set.
    const outcome = await withConversationLabels(
      input.tenantId,
      input.conversationId,
      async (): Promise<ResolveLabelsOutcome> => {
        const current = await input.client.getConversationLabels(
          input.conversationId,
        );
        // The GET is a wait, and a /reset peels the episode's labels off on purpose: a SET carrying
        // the merged list would put them back on a conversation the operator was told was cleared.
        if (input.stillWanted && !(await input.stillWanted()))
          return "called_off";
        const missing = labels.filter((l) => !current.includes(l));
        if (missing.length === 0) return "unchanged";
        dispatched = true;
        await input.client.setConversationLabels(input.conversationId, [
          ...current,
          ...missing,
        ]);
        return "written";
      },
    );
    return { outcome, unknown, dispatched };
  } catch (error) {
    return { outcome: "failed", unknown, dispatched, error };
  }
}

// The case inbox a close checks for a waiting contact: the operator's `crossInboxCase` destination,
// read from the settings and kept apart from the tool's config, which a note-only nudge clears to take
// `open_case_in_inbox` away while `resolve_conversation` still closes. Null ⇒ no destination.
export interface ResolveCaseHold {
  targetInboxId: number;
  targetInstanceId: number | null;
  caseAttributeKey: string;
}

export function resolveCaseHoldFor(
  config: CrossInboxCaseConfig,
): ResolveCaseHold | null {
  if (config.targetInboxId == null) return null;
  return {
    targetInboxId: config.targetInboxId,
    targetInstanceId: config.targetInstanceId,
    caseAttributeKey: config.caseAttributeKey,
  };
}

// The hold as a close on this conversation reads it: an inbox id only names an inbox inside the
// account it was picked from, so on another account's conversation there is none.
export function caseHoldOn(
  hold: ResolveCaseHold | null,
  instanceId: bigint | number,
  contactId: number | null,
): CaseInbox | null {
  if (!hold) return null;
  if (
    hold.targetInstanceId != null &&
    hold.targetInstanceId !== Number(instanceId)
  )
    return null;
  return {
    targetInboxId: hold.targetInboxId,
    caseAttributeKey: hold.caseAttributeKey,
    contactId,
  };
}

// Which labels a DEFERRED close carries. Three things schedule that close, and only the agent's own
// resolve_conversation carries the operator's labels: a case opened in another inbox also closes its
// origin (`crossInboxCase.resolveOrigin`), and that conversation went to the team, so it was not
// resolved by the AI, whichever of the two tools ran first in the turn. The third, the thank-you
// after a close, never sets any.
export function resolveLabelsFor(
  turnState: Pick<
    TurnState,
    "resolveRequested" | "resolveLabels" | "caseClosing"
  >,
): string[] {
  if (!turnState.resolveRequested || turnState.caseClosing) return [];
  return turnState.resolveLabels ?? [];
}
