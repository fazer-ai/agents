/// <reference lib="dom" />

import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import {
  BehaviorTab,
  type ContactAuthState,
} from "@/client/pages/agents/BehaviorTab";
import {
  type ContactAuthConditionForm,
  type ContactAuthRuleForm,
  contactAuthRuleInvalid,
  contactAuthRulePayload,
  EMPTY_CONTACT_AUTH_CONDITION_FORM,
  EMPTY_CONTACT_AUTH_RULE_FORM,
  readContactAuthRuleForm,
} from "@/client/pages/agents/contactAuthRuleForm";
import { behaviorTabProps } from "./behaviorTabProps";

// The editor offers the conversation's type and labels as conditions, and `all` / `any` over several.

const c = (
  ruleKind: string,
  patch: Partial<ContactAuthConditionForm> = {},
): ContactAuthConditionForm => ({
  ...EMPTY_CONTACT_AUTH_CONDITION_FORM,
  ruleKind,
  ...patch,
});
// Every assertion reduces to a number or a boolean BEFORE expect (a failing expectation holding a DOM
// node serializes a cyclic happy-dom tree and stalls the runner).

describe("the rule's form state", () => {
  test("a stored combination reads back as rows and saves as the same rule", () => {
    const stored = {
      kind: "all",
      conditions: [
        { kind: "conversation_type", type: "group" },
        { kind: "label", label: "suporte" },
        { kind: "allowlist", phones: ["5511988887777"], identifiers: [] },
        { kind: "attribute", scope: "contact", key: "plano", equals: "ativo" },
      ],
    };
    const form = readContactAuthRuleForm(stored);
    expect(form.ruleMatch).toBe("all");
    expect(form.ruleConditions.map((c) => c.ruleKind)).toEqual([
      "conversation_type",
      "label",
      "allowlist",
      "attribute",
    ]);
    expect(contactAuthRulePayload(form)).toEqual(stored);
  });

  test("a single type or label reads as a list of one and saves back as itself", () => {
    for (const stored of [
      { kind: "conversation_type", type: "individual" },
      { kind: "label", label: "vip" },
    ]) {
      const form = readContactAuthRuleForm(stored);
      expect(form.ruleConditions.length).toBe(1);
      expect(contactAuthRulePayload(form)).toEqual(stored);
    }
  });

  test("the editor refuses exactly what the server refuses", () => {
    const any: ContactAuthRuleForm = {
      ...EMPTY_CONTACT_AUTH_RULE_FORM,
      ruleMatch: "any",
    };
    // No conditions is no rule, which is not a malformed one.
    expect(contactAuthRuleInvalid(any)).toBe(false);
    const row = c("label");
    expect(contactAuthRuleInvalid({ ...any, ruleConditions: [row] })).toBe(
      true,
    );
    expect(
      contactAuthRuleInvalid({
        ...any,
        ruleConditions: [{ ...row, ruleLabel: "vip" }],
      }),
    ).toBe(false);
    expect(
      contactAuthRuleInvalid({
        ...any,
        ruleConditions: [row, c("conversation_type")],
      }),
    ).toBe(true);
  });
});

const realFetch = globalThis.fetch;
// One body every request on this screen can read: the list endpoints read `data`, the attribute
// picker reads `attributes` and `accountCount`.
const stubFetch = (async () =>
  new Response(JSON.stringify({ data: [], attributes: [], accountCount: 1 }), {
    headers: { "content-type": "application/json" },
  })) as unknown as typeof globalThis.fetch;

let current: ContactAuthState;
function renderGate(rule: Partial<ContactAuthRuleForm>): void {
  const props = behaviorTabProps({});
  current = {
    ...props.contactAuth,
    ...EMPTY_CONTACT_AUTH_RULE_FORM,
    ...rule,
    enabled: true,
  };
  function Harness() {
    const [state, setState] = useState(current);
    return (
      <BehaviorTab
        {...props}
        contactAuth={state}
        setContactAuth={(next) => {
          current = typeof next === "function" ? next(current) : next;
          setState(current);
        }}
      />
    );
  }
  render(<Harness />);
}

const count = (re: RegExp) => screen.queryAllByText(re).length;
const urlField = () => count(/^(Authorization URL|URL de autorização)$/);
const typeField = () => count(/^(Conversation type|Tipo de conversa)$/);
const labelField = () => count(/^(Label|Etiqueta)$/);
const rowCount = () => count(/^(Condition|Condição) \d+$/);
const emptyError = () =>
  count(/^(Add at least one condition|Adicione pelo menos uma condição)/);
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

  test("the conversation type is offered and hides the endpoint", () => {
    renderGate({ ruleConditions: [c("conversation_type")] });
    expect(typeField() > 0).toBe(true);
    expect(urlField()).toBe(0);
    expect(saveBlocked()).toBe(false);
  });

  test("an empty label blocks the save", () => {
    renderGate({ ruleConditions: [c("label")] });
    expect(labelField() > 0).toBe(true);
    expect(saveBlocked()).toBe(true);
  });

  test("lists that are each fine but exceed the rule's cap together say why the save is blocked", () => {
    const ids = (from: number, n: number) =>
      Array.from({ length: n }, (_, i) => `id-${from + i}`).join("\n");
    const row = (identifiers: string) =>
      c("allowlist", { ruleIdentifiers: identifiers });
    const tooLong = () =>
      count(
        /^(The lists in this rule hold more than 500 entries in total\.|As listas desta regra somam mais de 500 itens\.)$/,
      );
    renderGate({
      ruleMatch: "any",
      ruleConditions: [row(ids(0, 250)), row(ids(250, 251))],
    });
    expect(saveBlocked()).toBe(true);
    expect(tooLong()).toBe(1);
    cleanup();
    renderGate({
      ruleMatch: "any",
      ruleConditions: [row(ids(0, 250)), row(ids(250, 250))],
    });
    expect(saveBlocked()).toBe(false);
    expect(tooLong()).toBe(0);
  });

  test("the list starts empty, says so, and grows a row per click", () => {
    renderGate({});
    expect(rowCount()).toBe(0);
    expect(emptyError() > 0).toBe(true);
    expect(saveBlocked()).toBe(true);
    const add = () =>
      fireEvent.click(
        screen.getByRole("button", {
          name: /^(Add condition|Adicionar condição)$/,
        }),
      );
    add();
    add();
    expect(rowCount()).toBe(2);
    expect(current.ruleConditions.length).toBe(2);
    // A new row is a conversation type, which needs nothing typed: the rule is valid as it stands.
    expect(contactAuthRuleInvalid(current)).toBe(false);
    expect(saveBlocked()).toBe(false);
    fireEvent.click(
      screen.getAllByRole("button", {
        name: /^(Remove condition|Remover condição)$/,
      })[0] as HTMLElement,
    );
    expect(current.ruleConditions.length).toBe(1);
  });
});
