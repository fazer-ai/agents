import {
  type ContactAuthCondition,
  parseContactAuthRule,
} from "@/modules/contact-auth/settings";

// The editor's half of the contact gate's local rule. The lists are ONE TEXT BOX each, one entry per
// line, because that is how an operator pastes a pilot list; the save turns them into the arrays the
// runtime reads, and validity is the runtime's own parse, so the editor can never accept a rule the
// server refuses or the reader drops.

// One condition, as the editor holds it. The rule itself is one of these, or (`ruleKind` "all" /
// "any") a list of them in `ruleConditions`: the runtime allows one level, so this is every rule.
export interface ContactAuthConditionForm {
  // "allowlist" | "attribute" | "conversation_type" | "label"; on the rule, also "" (no rule: the
  // endpoint answers), "all" and "any".
  ruleKind: string;
  rulePhones: string;
  ruleIdentifiers: string;
  ruleScope: string;
  ruleKey: string;
  ruleEquals: string;
  ruleConversationType: string;
  ruleLabel: string;
}

export interface ContactAuthRuleForm extends ContactAuthConditionForm {
  ruleConditions: ContactAuthConditionForm[];
}

export const EMPTY_CONTACT_AUTH_CONDITION_FORM: ContactAuthConditionForm = {
  ruleKind: "",
  rulePhones: "",
  ruleIdentifiers: "",
  ruleScope: "contact",
  ruleKey: "",
  ruleEquals: "",
  ruleConversationType: "group",
  ruleLabel: "",
};

export const EMPTY_CONTACT_AUTH_RULE_FORM: ContactAuthRuleForm = {
  ...EMPTY_CONTACT_AUTH_CONDITION_FORM,
  ruleConditions: [],
};

export function isCombinedRuleKind(kind: string): boolean {
  return kind === "all" || kind === "any";
}

// What a new row of a combination starts as.
export function newContactAuthConditionForm(): ContactAuthConditionForm {
  return {
    ...EMPTY_CONTACT_AUTH_CONDITION_FORM,
    ruleKind: "conversation_type",
  };
}

function lines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l !== "");
}

function conditionForm(c: ContactAuthCondition): ContactAuthConditionForm {
  const base = EMPTY_CONTACT_AUTH_CONDITION_FORM;
  switch (c.kind) {
    case "allowlist":
      return {
        ...base,
        ruleKind: "allowlist",
        rulePhones: c.phones.join("\n"),
        ruleIdentifiers: c.identifiers.join("\n"),
      };
    case "conversation_type":
      return {
        ...base,
        ruleKind: "conversation_type",
        ruleConversationType: c.type,
      };
    case "label":
      return { ...base, ruleKind: "label", ruleLabel: c.label };
    default:
      return {
        ...base,
        ruleKind: "attribute",
        ruleScope: c.scope,
        ruleKey: c.key,
        ruleEquals: c.equals ?? "",
      };
  }
}

// From the stored bag. A stored rule the reader would drop reads as no rule, which is what the
// runtime does with it too.
export function readContactAuthRuleForm(raw: unknown): ContactAuthRuleForm {
  const rule = parseContactAuthRule(raw);
  if (!rule) return { ...EMPTY_CONTACT_AUTH_RULE_FORM };
  if (rule.kind === "all" || rule.kind === "any") {
    return {
      ...EMPTY_CONTACT_AUTH_RULE_FORM,
      ruleKind: rule.kind,
      ruleConditions: rule.conditions.map(conditionForm),
    };
  }
  return { ...conditionForm(rule), ruleConditions: [] };
}

function conditionPayload(
  f: ContactAuthConditionForm,
): Record<string, unknown> | null {
  switch (f.ruleKind) {
    case "allowlist":
      return {
        kind: "allowlist",
        phones: lines(f.rulePhones),
        identifiers: lines(f.ruleIdentifiers),
      };
    case "attribute": {
      const equals = f.ruleEquals.trim();
      return {
        kind: "attribute",
        scope: f.ruleScope === "conversation" ? "conversation" : "contact",
        key: f.ruleKey.trim(),
        ...(equals ? { equals } : {}),
      };
    }
    case "conversation_type":
      return {
        kind: "conversation_type",
        type: f.ruleConversationType === "individual" ? "individual" : "group",
      };
    case "label":
      return { kind: "label", label: f.ruleLabel.trim() };
    default:
      return null;
  }
}

// What the save sends. `null` clears a stored rule; the Behavior save replaces the block wholesale,
// so leaving the key out would ALSO clear it, and saying so explicitly is what keeps a rule written
// over MCP from vanishing on the next unrelated save of this form.
export function contactAuthRulePayload(
  f: ContactAuthRuleForm,
): Record<string, unknown> | null {
  if (f.ruleKind === "all" || f.ruleKind === "any") {
    // NOTE: An unknown row kind is kept as an empty object rather than dropped, so the parse refuses
    // the whole rule instead of a combination quietly losing a condition.
    return {
      kind: f.ruleKind,
      conditions: f.ruleConditions.map((c) => conditionPayload(c) ?? {}),
    };
  }
  return conditionPayload(f);
}

// True when the form holds a rule the server would refuse: the same parse, so the two cannot drift.
export function contactAuthRuleInvalid(f: ContactAuthRuleForm): boolean {
  const payload = contactAuthRulePayload(f);
  return payload !== null && parseContactAuthRule(payload) === null;
}

// One condition the server would refuse on its own, for the field-level message on that row.
export function contactAuthConditionInvalid(
  f: ContactAuthConditionForm,
): boolean {
  const payload = conditionPayload(f);
  return payload === null || parseContactAuthRule(payload) === null;
}

// What the Behavior save writes for the rule. With the gate ON an invalid draft is sent as it is, and
// the save is blocked before it gets there. With the gate OFF the rule's controls are hidden and the
// save is open, so an invalid draft (a list emptied, an attribute with no key) would be refused by
// the server and take the switch-off down with it: the gate the operator was turning off would stay
// on. That draft is cleared instead, which is what emptying the list said.
export function contactAuthRuleToSave(
  f: ContactAuthRuleForm,
  enabled: boolean,
): Record<string, unknown> | null {
  if (!enabled && contactAuthRuleInvalid(f)) return null;
  return contactAuthRulePayload(f);
}
