import { describe, expect, test } from "bun:test";
import {
  assertSettingsClosedValues,
  assertSettingsContactAuthRule,
} from "@/modules/agents/service";
import { BEHAVIOR_PATCH_SHAPE } from "@/modules/agents/settings-schema";

// What the write path answers for a `contactAuth` patch: the schema's own verdict (what MCP checks
// the arguments against, path and message included) and the REST boundary's refusal. The published
// shape is trimmed for `tools/list`, so these pin that a trim never moves what is refused, nor how.

const schema = BEHAVIOR_PATCH_SHAPE.contactAuth.unwrap();

function schemaVerdict(block: unknown): string {
  const r = schema.safeParse(block);
  if (r.success) return "ok";
  return r.error.issues
    .map((i) => `${i.code} ${i.path.join(".")}: ${i.message}`)
    .join(" | ");
}

function restVerdict(block: unknown): string {
  const settings = { contactAuth: block };
  try {
    assertSettingsClosedValues(settings, {});
    assertSettingsContactAuthRule(settings, {});
    return "ok";
  } catch (e) {
    return `${(e as Error).constructor.name}: ${(e as Error).message}`;
  }
}

const label = (l: string) => ({ kind: "label", label: l });
// [case, block, the schema's verdict, the REST boundary's verdict]
const CASES: [string, unknown, string, string][] = [
  [
    "an allowlist",
    { enabled: true, rule: { kind: "allowlist", phones: ["+5511999990000"] } },
    "ok",
    "ok",
  ],
  [
    "an attribute that is set",
    { rule: { kind: "attribute", scope: "contact", key: "plano" } },
    "ok",
    "ok",
  ],
  [
    "an attribute equal to a value",
    {
      rule: {
        kind: "attribute",
        scope: "conversation",
        key: "plano",
        equals: "ouro",
      },
    },
    "ok",
    "ok",
  ],
  [
    "a conversation type",
    { rule: { kind: "conversation_type", type: "group" } },
    "ok",
    "ok",
  ],
  ["a label", { rule: label("Suporte") }, "ok", "ok"],
  [
    "all of two conditions",
    {
      rule: {
        kind: "all",
        conditions: [
          { kind: "conversation_type", type: "group" },
          label("vip"),
        ],
      },
    },
    "ok",
    "ok",
  ],
  [
    "any of one condition",
    { rule: { kind: "any", conditions: [label("vip")] } },
    "ok",
    "ok",
  ],
  ["a cleared rule", { rule: null }, "ok", "ok"],
  [
    "the endpoint asked after the rule",
    {
      rule: label("vip"),
      url: "https://example.com/check",
      askEndpointAfterRule: true,
      operatorNoteEnabled: false,
    },
    "ok",
    "ok",
  ],
  [
    "an unknown kind",
    { rule: { kind: "phone" } },
    "invalid_union rule: Invalid input",
    "InvalidSettingsValueError: settings.contactAuth.rule expects a valid value, got object",
  ],
  [
    "a conversation type outside its choices",
    { rule: { kind: "conversation_type", type: "channel" } },
    "invalid_union rule: Invalid input",
    "InvalidSettingsValueError: settings.contactAuth.rule expects a valid value, got object",
  ],
  [
    "a conversation type without its type",
    { rule: { kind: "conversation_type" } },
    "invalid_union rule: Invalid input",
    "InvalidSettingsValueError: settings.contactAuth.rule expects a valid value, got object",
  ],
  [
    "a blank label",
    { rule: label("   ") },
    "invalid_format rule.label: must not be blank",
    'InvalidSettingsValueError: settings.contactAuth.rule.label expects a value matching /\\S/, got "   "',
  ],
  [
    "a label that is not text",
    { rule: { kind: "label", label: 7 } },
    "invalid_union rule: Invalid input",
    "InvalidSettingsValueError: settings.contactAuth.rule expects a valid value, got object",
  ],
  [
    "an attribute without a key",
    { rule: { kind: "attribute", scope: "contact" } },
    "invalid_union rule: Invalid input",
    "InvalidSettingsValueError: settings.contactAuth.rule expects a valid value, got object",
  ],
  [
    "an attribute on an unknown scope",
    { rule: { kind: "attribute", scope: "inbox", key: "plano" } },
    "invalid_union rule: Invalid input",
    "InvalidSettingsValueError: settings.contactAuth.rule expects a valid value, got object",
  ],
  [
    "a blank equals",
    {
      rule: { kind: "attribute", scope: "contact", key: "plano", equals: " " },
    },
    "invalid_format rule.equals: must not be blank",
    'InvalidSettingsValueError: settings.contactAuth.rule.equals expects a value matching /\\S/, got " "',
  ],
  [
    "a combination holding an unknown kind",
    { rule: { kind: "all", conditions: [{ kind: "phone" }] } },
    "invalid_union rule: Invalid input",
    "InvalidSettingsValueError: settings.contactAuth.rule expects a valid value, got object",
  ],
  [
    "a combination holding a combination",
    {
      rule: {
        kind: "any",
        conditions: [{ kind: "all", conditions: [label("vip")] }],
      },
    },
    "invalid_union rule: Invalid input",
    "InvalidSettingsValueError: settings.contactAuth.rule expects a valid value, got object",
  ],
  [
    "a combination without conditions",
    { rule: { kind: "all" } },
    "invalid_union rule: Invalid input",
    "InvalidSettingsValueError: settings.contactAuth.rule expects a valid value, got object",
  ],
  [
    "a combination whose conditions are not a list",
    { rule: { kind: "any", conditions: label("vip") } },
    "invalid_union rule: Invalid input",
    "InvalidSettingsValueError: settings.contactAuth.rule expects a valid value, got object",
  ],
  [
    "a combination holding something that is not a condition",
    { rule: { kind: "all", conditions: ["vip"] } },
    "invalid_union rule: Invalid input",
    "InvalidSettingsValueError: settings.contactAuth.rule expects a valid value, got object",
  ],
  [
    "a rule that is text",
    { rule: "vip" },
    "invalid_union rule: Invalid input",
    'InvalidSettingsValueError: settings.contactAuth.rule expects a valid value, got "vip"',
  ],
  [
    "an empty allowlist",
    { rule: { kind: "allowlist", phones: [] } },
    "ok",
    "InvalidContactAuthRuleError: settings.contactAuth.rule is not a valid rule",
  ],
  [
    "an empty combination",
    { rule: { kind: "all", conditions: [] } },
    "ok",
    "InvalidContactAuthRuleError: settings.contactAuth.rule is not a valid rule",
  ],
  [
    "eleven conditions",
    {
      rule: {
        kind: "any",
        conditions: Array.from({ length: 11 }, (_, i) => label(`l${i}`)),
      },
    },
    "ok",
    "InvalidContactAuthRuleError: settings.contactAuth.rule is not a valid rule",
  ],
  [
    "a label across two lines",
    { rule: label("a\nb") },
    "ok",
    "InvalidContactAuthRuleError: settings.contactAuth.rule is not a valid rule",
  ],
  [
    "a label over its cap",
    { rule: label("x".repeat(300)) },
    "ok",
    "InvalidContactAuthRuleError: settings.contactAuth.rule is not a valid rule",
  ],
  [
    "a combination holding a malformed condition",
    {
      rule: {
        kind: "all",
        conditions: [{ kind: "conversation_type", type: "channel" }],
      },
    },
    "ok",
    "InvalidContactAuthRuleError: settings.contactAuth.rule is not a valid rule",
  ],
  [
    "askEndpointAfterRule that is not a boolean",
    { askEndpointAfterRule: "yes" },
    "invalid_type askEndpointAfterRule: Invalid input: expected boolean, received string",
    'InvalidSettingsValueError: settings.contactAuth.askEndpointAfterRule expects boolean, got "yes"',
  ],
  [
    "operatorNoteEnabled that is not a boolean",
    { operatorNoteEnabled: 1 },
    "invalid_type operatorNoteEnabled: Invalid input: expected boolean, received number",
    "InvalidSettingsValueError: settings.contactAuth.operatorNoteEnabled expects boolean, got number",
  ],
  [
    "a mode outside its choices",
    { mode: "always" },
    'invalid_value mode: Invalid option: expected one of "perMessage"|"once"',
    'InvalidSettingsValueError: settings.contactAuth.mode expects one of "perMessage", "once", got "always"',
  ],
  [
    "a url that is not text",
    { url: 5 },
    "invalid_type url: Invalid input: expected string, received number",
    "InvalidSettingsValueError: settings.contactAuth.url expects string, got number",
  ],
  [
    "a grant lifetime that is not a number",
    { grantTtlSeconds: "1h" },
    "invalid_type grantTtlSeconds: Invalid input: expected number, received string",
    'InvalidSettingsValueError: settings.contactAuth.grantTtlSeconds expects number, got "1h"',
  ],
  [
    "a team id that is not positive",
    { handoffTeamId: 0 },
    "too_small handoffTeamId: Too small: expected number to be >0",
    "InvalidSettingsValueError: settings.contactAuth.handoffTeamId expects a valid value, got number",
  ],
];

describe("contactAuth writes", () => {
  for (const [name, block, schemaSays, restSays] of CASES) {
    test(name, () => {
      expect(schemaVerdict(block)).toBe(schemaSays);
      expect(restVerdict(block)).toBe(restSays);
    });
  }
});
