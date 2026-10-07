/// <reference lib="dom" />

import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";
import {
  BehaviorTab,
  type ContactAuthState,
} from "@/client/pages/agents/BehaviorTab";
import {
  type ContactAuthConditionForm,
  EMPTY_CONTACT_AUTH_CONDITION_FORM,
  EMPTY_CONTACT_AUTH_RULE_FORM,
} from "@/client/pages/agents/contactAuthRuleForm";
import { behaviorTabProps } from "./behaviorTabProps";

// The gate in the editor is two parts: ONE list of conditions of any kind (a single condition is a
// list of one, "all" / "any" only from two on), and ONE switch for the external endpoint (after the
// conditions when there are some, alone when there are none). A watcher gets the conditions only.
//
// Every assertion reduces to a number or a boolean BEFORE expect (a failing expectation holding a
// DOM node serializes a cyclic happy-dom tree and stalls the runner).

const cond = (
  patch: Partial<ContactAuthConditionForm>,
): ContactAuthConditionForm => ({
  ...EMPTY_CONTACT_AUTH_CONDITION_FORM,
  ...patch,
});
const GROUP = cond({ ruleKind: "conversation_type" });
const LABEL = cond({ ruleKind: "label", ruleLabel: "suporte" });

const realFetch = globalThis.fetch;
const stubFetch = (async () =>
  new Response(JSON.stringify({ data: [] }), {
    headers: { "content-type": "application/json" },
  })) as unknown as typeof globalThis.fetch;

function renderGate(
  over: Partial<ContactAuthState>,
  mode: "production" | "monitoring" = "production",
): void {
  const props = behaviorTabProps({});
  render(
    <BehaviorTab
      {...props}
      mode={mode}
      contactAuth={{
        ...props.contactAuth,
        ...EMPTY_CONTACT_AUTH_RULE_FORM,
        ruleConditions: [],
        endpointEnabled: false,
        ...over,
        enabled: true,
      }}
    />,
  );
}

const count = (re: RegExp) => screen.queryAllByText(re).length;
const sourcePicker = () => count(/^(Who decides|Quem decide)$/);
const conditionsField = () => count(/^(Conditions|Condições)$/);
const matchPicker = () =>
  count(
    /^(Let a conversation through when it meets|Deixar passar a conversa que atende)$/,
  );
const addCondition = () => count(/^(Add condition|Adicionar condição)$/);
const endpointSwitch = () =>
  count(/^(Ask an external endpoint|Perguntar a um endpoint externo)$/);
const urlField = () => count(/^(Authorization URL|URL de autorização)$/);
const emptyError = () =>
  count(/^(Add at least one condition|Adicione pelo menos uma condição)/);
const watcherEndpointNotice = () =>
  count(
    /endpoint is not asked, so this gate observes every conversation|não é consultado, então este gate observa todas as conversas/,
  );
const saveBlocked = () =>
  screen
    .getAllByRole("button", { name: /^(Save|Salvar)$/ })
    .some((b) => (b as HTMLButtonElement).disabled);

describe("the gate's section is conditions and one endpoint switch", () => {
  beforeAll(() => {
    globalThis.fetch = stubFetch;
  });
  afterEach(() => cleanup());
  afterAll(() => {
    globalThis.fetch = realFetch;
  });

  test("there is no picker of sources, only the list and the switch", () => {
    renderGate({});
    expect(sourcePicker()).toBe(0);
    expect(conditionsField() > 0).toBe(true);
    // Several controls under one title: a named group, not a label pointing at no control.
    expect(
      screen.queryAllByRole("group", { name: /^(Conditions|Condições)/ })
        .length > 0,
    ).toBe(true);
    expect(addCondition() > 0).toBe(true);
    expect(endpointSwitch() > 0).toBe(true);
  });

  test("all / any is asked only from two conditions on", () => {
    renderGate({ ruleConditions: [GROUP] });
    expect(matchPicker()).toBe(0);
    cleanup();
    renderGate({ ruleConditions: [GROUP, LABEL] });
    expect(matchPicker() > 0).toBe(true);
  });

  test("the endpoint's fields follow its switch, with or without conditions", () => {
    renderGate({ ruleConditions: [GROUP], endpointEnabled: false });
    expect(urlField()).toBe(0);
    expect(saveBlocked()).toBe(false);
    cleanup();
    renderGate({ ruleConditions: [GROUP], endpointEnabled: true });
    expect(urlField() > 0).toBe(true);
    cleanup();
    renderGate({ ruleConditions: [], endpointEnabled: true });
    expect(urlField() > 0).toBe(true);
  });

  test("an enabled gate with no condition and no endpoint cannot be saved, and says why", () => {
    renderGate({ ruleConditions: [], endpointEnabled: false });
    expect(emptyError() > 0).toBe(true);
    expect(saveBlocked()).toBe(true);
  });

  test("a watcher gets the conditions only", () => {
    renderGate({ ruleConditions: [GROUP] }, "monitoring");
    expect(conditionsField() > 0).toBe(true);
    expect(endpointSwitch()).toBe(0);
    expect(urlField()).toBe(0);
  });

  test("a watcher with a stored endpoint-only gate is told it observes everything", () => {
    renderGate(
      { ruleConditions: [], endpointEnabled: true, url: "https://a.test" },
      "monitoring",
    );
    expect(watcherEndpointNotice() > 0).toBe(true);
    expect(urlField()).toBe(0);
    expect(saveBlocked()).toBe(false);
  });

  test("a watcher with nothing to decide cannot be saved", () => {
    renderGate({ ruleConditions: [], endpointEnabled: false }, "monitoring");
    expect(emptyError() > 0).toBe(true);
    expect(saveBlocked()).toBe(true);
  });
});
