import {
  type ContactAuthCondition,
  parseContactAuthRule,
} from "@/modules/contact-auth/settings";

// The editor's half of the contact gate's local rule. The lists are ONE TEXT BOX each, one entry per
// line, because that is how an operator pastes a pilot list; the save turns them into the arrays the
// runtime reads, and validity is the runtime's own parse, so the editor can never accept a rule the
// server refuses or the reader drops.

// One condition, as the editor holds it.
export interface ContactAuthConditionForm {
  // "allowlist" | "attribute" | "conversation_type" | "label".
  ruleKind: string;
  rulePhones: string;
  ruleIdentifiers: string;
  ruleScope: string;
  ruleKey: string;
  ruleEquals: string;
  ruleConversationType: string;
  ruleLabel: string;
}

// The rule as the editor holds it: ONE list of conditions of any kind, and how they combine. A single
// condition is a list of one, so the editor has no separate picker per kind; "all" / "any" matters
// (and is shown) only from two conditions on. An empty list is no rule.
export interface ContactAuthRuleForm {
  // "all" | "any".
  ruleMatch: string;
  ruleConditions: ContactAuthConditionForm[];
}

export const EMPTY_CONTACT_AUTH_CONDITION_FORM: ContactAuthConditionForm = {
  ruleKind: "conversation_type",
  rulePhones: "",
  ruleIdentifiers: "",
  ruleScope: "contact",
  ruleKey: "",
  ruleEquals: "",
  ruleConversationType: "group",
  ruleLabel: "",
};

export const EMPTY_CONTACT_AUTH_RULE_FORM: ContactAuthRuleForm = {
  ruleMatch: "all",
  ruleConditions: [],
};

// What a new row starts as.
export function newContactAuthConditionForm(): ContactAuthConditionForm {
  return { ...EMPTY_CONTACT_AUTH_CONDITION_FORM };
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
// runtime does with it too. A plain rule is a list of one; a combination keeps its match.
export function readContactAuthRuleForm(raw: unknown): ContactAuthRuleForm {
  const rule = parseContactAuthRule(raw);
  if (!rule) return { ...EMPTY_CONTACT_AUTH_RULE_FORM, ruleConditions: [] };
  if (rule.kind === "all" || rule.kind === "any") {
    return {
      ruleMatch: rule.kind,
      ruleConditions: rule.conditions.map(conditionForm),
    };
  }
  return { ruleMatch: "all", ruleConditions: [conditionForm(rule)] };
}

// Whether the editor's endpoint switch reads as on for a stored gate. With conditions, it is the
// stored `askEndpointAfterRule` (strict, like the reader): a url left beside a rule with the flag off
// stays unused, and the switch shows it off. With no conditions the endpoint is what decides, so the
// switch is on when there is a url to ask; a gate with neither reads as off, which is also what an
// enabled gate in that state does at runtime (fail-closed `not_configured`), and the save asks for
// one of the two.
export function readContactAuthEndpointEnabled(
  form: ContactAuthRuleForm,
  url: unknown,
  askEndpointAfterRule: unknown,
): boolean {
  if (form.ruleConditions.length > 0) return askEndpointAfterRule === true;
  return typeof url === "string" && url.trim() !== "";
}

// What the save writes for `askEndpointAfterRule`: the switch as shown, except on a monitoring agent.
// Its editor draws no switch, so the value it holds there was inferred from the stored url and never
// chosen; the stored flag is written back as it was, and a later return to production asks the
// endpoint after the conditions only if it already did.
export function contactAuthAskEndpointToSave(
  endpointEnabled: boolean,
  monitoring: boolean,
  stored: unknown,
): boolean {
  return monitoring ? stored === true : endpointEnabled;
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
// over MCP from vanishing on the next unrelated save of this form. One condition saves as that plain
// condition (an `all` / `any` of one means the same and loads back as the same list of one), so the
// round trip is stable; two or more save as the combination.
export function contactAuthRulePayload(
  f: ContactAuthRuleForm,
): Record<string, unknown> | null {
  const rows = f.ruleConditions;
  if (rows.length === 0) return null;
  const [only] = rows;
  // NOTE: An unknown row kind is kept as an empty object rather than dropped, so the parse refuses
  // the whole rule instead of quietly losing a condition.
  if (rows.length === 1 && only) return conditionPayload(only) ?? {};
  return {
    kind: f.ruleMatch === "any" ? "any" : "all",
    conditions: rows.map((c) => conditionPayload(c) ?? {}),
  };
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
