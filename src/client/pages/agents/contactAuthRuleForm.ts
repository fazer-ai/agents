import { parseContactAuthRule } from "@/modules/contact-auth/settings";

// The editor's half of the contact gate's local rule (issue #646). The lists are ONE TEXT BOX each,
// one entry per line, because that is how an operator pastes a pilot list; the save turns them into
// the arrays the runtime reads, and validity is the runtime's own parse, so the editor can never
// accept a rule the server refuses or the reader drops.
export interface ContactAuthRuleForm {
  // "" = no rule (the endpoint answers); "allowlist" | "attribute" otherwise.
  ruleKind: string;
  rulePhones: string;
  ruleIdentifiers: string;
  ruleScope: string;
  ruleKey: string;
  ruleEquals: string;
}

export const EMPTY_CONTACT_AUTH_RULE_FORM: ContactAuthRuleForm = {
  ruleKind: "",
  rulePhones: "",
  ruleIdentifiers: "",
  ruleScope: "contact",
  ruleKey: "",
  ruleEquals: "",
};

function lines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l !== "");
}

// From the stored bag. A stored rule the reader would drop reads as no rule, which is what the
// runtime does with it too.
export function readContactAuthRuleForm(raw: unknown): ContactAuthRuleForm {
  const rule = parseContactAuthRule(raw);
  if (!rule) return { ...EMPTY_CONTACT_AUTH_RULE_FORM };
  if (rule.kind === "allowlist") {
    return {
      ...EMPTY_CONTACT_AUTH_RULE_FORM,
      ruleKind: "allowlist",
      rulePhones: rule.phones.join("\n"),
      ruleIdentifiers: rule.identifiers.join("\n"),
    };
  }
  return {
    ...EMPTY_CONTACT_AUTH_RULE_FORM,
    ruleKind: "attribute",
    ruleScope: rule.scope,
    ruleKey: rule.key,
    ruleEquals: rule.equals ?? "",
  };
}

// What the save sends. `null` clears a stored rule; the Behavior save replaces the block wholesale,
// so leaving the key out would ALSO clear it, and saying so explicitly is what keeps a rule written
// over MCP from vanishing on the next unrelated save of this form.
export function contactAuthRulePayload(
  f: ContactAuthRuleForm,
): Record<string, unknown> | null {
  if (f.ruleKind === "allowlist") {
    return {
      kind: "allowlist",
      phones: lines(f.rulePhones),
      identifiers: lines(f.ruleIdentifiers),
    };
  }
  if (f.ruleKind === "attribute") {
    const equals = f.ruleEquals.trim();
    return {
      kind: "attribute",
      scope: f.ruleScope === "conversation" ? "conversation" : "contact",
      key: f.ruleKey.trim(),
      ...(equals ? { equals } : {}),
    };
  }
  return null;
}

// True when the form holds a rule the server would refuse: the same parse, so the two cannot drift.
export function contactAuthRuleInvalid(f: ContactAuthRuleForm): boolean {
  const payload = contactAuthRulePayload(f);
  return payload !== null && parseContactAuthRule(payload) === null;
}
