// The verdict of the gate's local rule, as a pure function of what the mirror holds. The service reads
// the rows and hands the facts in; this decides. A rule always answers allowed or denied: it reads our
// own rows, so there is no timeout, status or credential to fail, and the gate stays fail-closed only
// in the sense that a condition with nothing to read is unmet.
import { evaluatePrecondition } from "@/modules/agents/tool-preconditions";
import {
  type ContactAuthCondition,
  type ContactAuthConversationType,
  type ContactAuthRule,
  phoneDigits,
} from "./settings";

// OUR refusal codes, safe in the flow line: they name WHICH condition refused, never the value it
// compared. `all` reports the first condition that failed; `any` has no single culprit.
export const RULE_NOT_LISTED = "rule_not_listed";
export const RULE_UNMET = "rule_unmet";
export const RULE_CONVERSATION_TYPE = "rule_conversation_type";
export const RULE_LABEL = "rule_label";
export const RULE_NONE_MET = "rule_none_met";

const GROUP_IDENTIFIER_SUFFIX = "@g.us";

export interface RuleFacts {
  phone: string | null;
  identifier: string | null;
  // The mirrored `group_type`; null when no payload ever stated it.
  conversationType: ContactAuthConversationType | null;
  labels: readonly string[];
  conversationAttributes: Record<string, unknown>;
  contactAttributes: Record<string, unknown>;
}

export type RuleVerdict =
  | { outcome: "allowed" }
  | { outcome: "denied"; reason: string };

// A Chatwoot without the field still names a WhatsApp group by its contact: the group's JID.
export function conversationTypeOf(
  f: Pick<RuleFacts, "conversationType" | "identifier">,
): ContactAuthConversationType {
  if (f.conversationType) return f.conversationType;
  return f.identifier?.endsWith(GROUP_IDENTIFIER_SUFFIX)
    ? "group"
    : "individual";
}

// The condition's verdict, and when unmet, its refusal code.
function failedReason(c: ContactAuthCondition, f: RuleFacts): string | null {
  switch (c.kind) {
    case "allowlist": {
      // EXACT digits, never a suffix: a suffix rule is the one where a short entry quietly lets in
      // every number that ends the same way.
      const listed =
        (f.phone !== null && c.phones.includes(phoneDigits(f.phone))) ||
        (f.identifier !== null && c.identifiers.includes(f.identifier));
      return listed ? null : RULE_NOT_LISTED;
    }
    case "conversation_type":
      return conversationTypeOf(f) === c.type ? null : RULE_CONVERSATION_TYPE;
    case "label":
      return f.labels.some((l) => l.toLowerCase() === c.label)
        ? null
        : RULE_LABEL;
    default:
      return evaluatePrecondition(c, {
        conversationAttributes: f.conversationAttributes,
        contactAttributes: f.contactAttributes,
      })
        ? null
        : RULE_UNMET;
  }
}

export function evaluateContactAuthRule(
  rule: ContactAuthRule,
  f: RuleFacts,
): RuleVerdict {
  if (rule.kind === "all") {
    for (const c of rule.conditions) {
      const reason = failedReason(c, f);
      if (reason) return { outcome: "denied", reason };
    }
    return { outcome: "allowed" };
  }
  if (rule.kind === "any") {
    return rule.conditions.some((c) => failedReason(c, f) === null)
      ? { outcome: "allowed" }
      : { outcome: "denied", reason: RULE_NONE_MET };
  }
  const reason = failedReason(rule, f);
  return reason ? { outcome: "denied", reason } : { outcome: "allowed" };
}

function conditionReadsConversation(c: ContactAuthCondition): boolean {
  return (
    c.kind === "conversation_type" ||
    c.kind === "label" ||
    (c.kind === "attribute" && c.scope === "conversation")
  );
}

// Whether the verdict is about the CONVERSATION and not only the contact: two conversations of one
// contact are then two questions, and must not share a single-flight answer.
export function ruleReadsConversation(rule: ContactAuthRule): boolean {
  return rule.kind === "all" || rule.kind === "any"
    ? rule.conditions.some(conditionReadsConversation)
    : conditionReadsConversation(rule);
}
