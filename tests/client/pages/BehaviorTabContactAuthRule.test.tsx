/// <reference lib="dom" />

import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import { readFileSync } from "node:fs";
import { cleanup, render, screen } from "@testing-library/react";
import { BehaviorTab } from "@/client/pages/agents/BehaviorTab";
import {
  type ContactAuthRuleForm,
  contactAuthRuleInvalid,
  contactAuthRulePayload,
  contactAuthRuleToSave,
  EMPTY_CONTACT_AUTH_RULE_FORM,
  readContactAuthRuleForm,
} from "@/client/pages/agents/contactAuthRuleForm";
import { behaviorTabProps } from "./behaviorTabProps";

// Issue #646: the contact gate can decide from a list or an attribute instead of an endpoint. The
// editor is where that choice is made, and the endpoint's fields are about a request that is then
// never sent.
//
// NOTE: every assertion reduces to a number or a boolean BEFORE expect (a failing expectation holding
// a DOM node serializes a cyclic happy-dom tree and stalls the runner).

describe("the rule's form state", () => {
  test("a stored list reads as one entry per line and saves back as the same rule", () => {
    const form = readContactAuthRuleForm({
      kind: "allowlist",
      phones: ["+55 (11) 98888-7777"],
      identifiers: ["cli-42"],
    });
    expect(form.ruleKind).toBe("allowlist");
    expect(form.rulePhones).toBe("5511988887777");
    expect(contactAuthRulePayload(form)).toEqual({
      kind: "allowlist",
      phones: ["5511988887777"],
      identifiers: ["cli-42"],
    });
  });

  test("blank lines are dropped and an attribute keeps its scope and value", () => {
    const list: ContactAuthRuleForm = {
      ...EMPTY_CONTACT_AUTH_RULE_FORM,
      ruleKind: "allowlist",
      rulePhones: "\n+55 11 98888-7777\n\n",
    };
    expect(contactAuthRulePayload(list)).toEqual({
      kind: "allowlist",
      phones: ["+55 11 98888-7777"],
      identifiers: [],
    });
    const attr = readContactAuthRuleForm({
      kind: "attribute",
      scope: "conversation",
      key: "liberado",
      equals: "sim",
    });
    expect(contactAuthRulePayload(attr)).toEqual({
      kind: "attribute",
      scope: "conversation",
      key: "liberado",
      equals: "sim",
    });
  });

  test("no rule saves as null, which clears a stored one", () => {
    expect(contactAuthRulePayload(EMPTY_CONTACT_AUTH_RULE_FORM)).toBeNull();
    expect(readContactAuthRuleForm(undefined).ruleKind).toBe("");
  });

  test("switching the gate off never sends an invalid draft", () => {
    const emptied = { ...EMPTY_CONTACT_AUTH_RULE_FORM, ruleKind: "allowlist" };
    // Off: the draft the server would refuse is cleared, so the switch-off itself goes through.
    expect(contactAuthRuleToSave(emptied, false)).toBeNull();
    // On: sent as it is, and the save is blocked before it gets there.
    expect(contactAuthRuleToSave(emptied, true)).toEqual({
      kind: "allowlist",
      phones: [],
      identifiers: [],
    });
    // Off with a valid rule: kept, so turning the gate back on later finds it.
    const valid = { ...emptied, rulePhones: "+55 11 98888-7777" };
    expect(contactAuthRuleToSave(valid, false)).toEqual(
      contactAuthRulePayload(valid),
    );
  });

  // Checked on the source for the reason tests/client/contact-auth-ttl-zero.test.ts gives: rendering
  // the whole editor page pulls auth, theme, toast and a live catalog.
  test("and the Behavior save is the one that goes through it", () => {
    const src = readFileSync(
      "src/client/pages/agents/AgentEditorPage.tsx",
      "utf8",
    );
    expect(src).toContain(
      "rule: contactAuthRuleToSave(contactAuth, contactAuth.enabled)",
    );
  });

  test("the editor refuses exactly what the server refuses", () => {
    const base = { ...EMPTY_CONTACT_AUTH_RULE_FORM, ruleKind: "allowlist" };
    expect(contactAuthRuleInvalid(base)).toBe(true);
    expect(contactAuthRuleInvalid({ ...base, rulePhones: "123" })).toBe(true);
    expect(
      contactAuthRuleInvalid({ ...base, rulePhones: "+55 11 98888-7777" }),
    ).toBe(false);
    expect(
      contactAuthRuleInvalid({
        ...EMPTY_CONTACT_AUTH_RULE_FORM,
        ruleKind: "attribute",
      }),
    ).toBe(true);
    expect(contactAuthRuleInvalid(EMPTY_CONTACT_AUTH_RULE_FORM)).toBe(false);
  });
});

const realFetch = globalThis.fetch;
const stubFetch = (async () =>
  new Response(JSON.stringify({ data: [] }), {
    headers: { "content-type": "application/json" },
  })) as unknown as typeof globalThis.fetch;

function renderGate(rule: Partial<ContactAuthRuleForm>): void {
  const props = behaviorTabProps({});
  render(
    <BehaviorTab
      {...props}
      contactAuth={{
        ...props.contactAuth,
        ...EMPTY_CONTACT_AUTH_RULE_FORM,
        ...rule,
        enabled: true,
      }}
    />,
  );
}

const count = (re: RegExp) => screen.queryAllByText(re).length;
const urlField = () => count(/^(Authorization URL|URL de autorização)$/);
const phonesField = () => count(/^(Phones|Telefones)$/);
const keyField = () => count(/^(Attribute key|Chave do atributo)$/);
const listError = () => count(/1 to 500 entries|1 a 500 itens/);
const saveBlocked = () =>
  screen
    .getAllByRole("button", { name: /^(Save|Salvar)$/ })
    .some((b) => (b as HTMLButtonElement).disabled);

describe("the gate's section in the editor", () => {
  beforeAll(() => {
    globalThis.fetch = stubFetch;
  });
  afterEach(() => cleanup());
  afterAll(() => {
    globalThis.fetch = realFetch;
  });

  test("the endpoint is the default, and its URL field is on screen", () => {
    renderGate({});
    expect(urlField() > 0).toBe(true);
    expect(phonesField()).toBe(0);
  });

  test("a list hides the endpoint's fields and shows the list", () => {
    renderGate({ ruleKind: "allowlist", rulePhones: "+55 11 98888-7777" });
    expect(phonesField() > 0).toBe(true);
    expect(urlField()).toBe(0);
    expect(listError()).toBe(0);
    // No URL is needed once a list decides, so an empty one does not block the save.
    expect(saveBlocked()).toBe(false);
  });

  test("without a rule, the missing URL still blocks the save", () => {
    renderGate({});
    expect(saveBlocked()).toBe(true);
  });

  test("an empty list says why it cannot be saved", () => {
    renderGate({ ruleKind: "allowlist" });
    expect(listError() > 0).toBe(true);
    expect(saveBlocked()).toBe(true);
  });

  test("an attribute shows its key field", () => {
    renderGate({ ruleKind: "attribute", ruleKey: "plano" });
    expect(keyField() > 0).toBe(true);
    expect(urlField()).toBe(0);
  });
});
