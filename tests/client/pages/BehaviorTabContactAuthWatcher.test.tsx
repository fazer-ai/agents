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
  EMPTY_CONTACT_AUTH_CONDITION_FORM,
  EMPTY_CONTACT_AUTH_RULE_FORM,
} from "@/client/pages/agents/contactAuthRuleForm";
import { behaviorTabProps } from "./behaviorTabProps";

// A monitoring agent's gate: the conditions and the endpoint switch are drawn, and the endpoint's
// fields when it is on, with copy saying its answer only decides what is observed; what only makes
// sense when answering a customer (deny message, handoff) stays hidden. Every assertion reduces to a number or a boolean BEFORE
// expect (a failing expectation holding a DOM node serializes a cyclic happy-dom tree).

const realFetch = globalThis.fetch;
const stubFetch = (async () =>
  new Response(JSON.stringify({ data: [] }), {
    headers: { "content-type": "application/json" },
  })) as unknown as typeof globalThis.fetch;

function renderWatcher(over: Partial<ContactAuthState>): void {
  const props = behaviorTabProps({});
  render(
    <BehaviorTab
      {...props}
      mode="monitoring"
      contactAuth={{
        ...props.contactAuth,
        ...EMPTY_CONTACT_AUTH_RULE_FORM,
        ...over,
        enabled: true,
      }}
    />,
  );
}

const count = (re: RegExp) => screen.queryAllByText(re).length;
const sectionShown = () => {
  const el = document.getElementById("contactAuth");
  return el !== null && !el.className.split(/\s+/).includes("hidden");
};
const urlField = () => count(/^(Authorization URL|URL de autorização)$/);
const askAfterSwitch = () =>
  count(/^(Ask an external endpoint|Perguntar a um endpoint externo)$/);
const label = (ruleLabel: string) => ({
  ruleConditions: [
    { ...EMPTY_CONTACT_AUTH_CONDITION_FORM, ruleKind: "label", ruleLabel },
  ],
});
const denyMessage = () =>
  count(/^(Message to a denied contact|Mensagem para contato negado)$/);
const handoff = () =>
  count(
    /^(Open refused conversations for humans|Abrir conversas recusadas para humanos)$/,
  );
const observedHint = () =>
  count(
    /(the rule decides which conversations it observes|a regra decide quais conversas ele observa)/,
  );
const endpointObservedHint = () =>
  count(
    /(only decides which conversations this agent observes|só decide quais conversas este agente observa)/,
  );
const messageTextSwitch = () =>
  count(
    /^(Send the customer's message text|Enviar o texto da mensagem do cliente)$/,
  );
const saveBlocked = () =>
  screen
    .getAllByRole("button", { name: /^(Save|Salvar)$/ })
    .some((b) => (b as HTMLButtonElement).disabled);

describe("the gate in a monitoring agent's editor", () => {
  beforeAll(() => {
    globalThis.fetch = stubFetch;
  });
  afterEach(() => cleanup());
  afterAll(() => {
    globalThis.fetch = realFetch;
  });

  test("is drawn with the conditions and the endpoint switch, and says the rule decides what is observed", () => {
    renderWatcher(label("suporte"));
    expect(sectionShown()).toBe(true);
    expect(observedHint() > 0).toBe(true);
    expect(askAfterSwitch()).toBe(1);
    expect(urlField()).toBe(0);
    expect(denyMessage()).toBe(0);
    expect(handoff()).toBe(0);
    expect(saveBlocked()).toBe(false);
  });

  test("with the endpoint on, its fields are drawn and say its answer only decides what is observed", () => {
    renderWatcher({ endpointEnabled: true, url: "https://a.test" });
    expect(sectionShown()).toBe(true);
    expect(askAfterSwitch()).toBe(1);
    expect(urlField()).toBe(1);
    expect(endpointObservedHint() > 0).toBe(true);
    // The endpoint gets the message text under the responder's contract, when asked to.
    expect(messageTextSwitch()).toBe(1);
    expect(denyMessage()).toBe(0);
    expect(handoff()).toBe(0);
    expect(saveBlocked()).toBe(false);
  });

  test("an endpoint switched on with no url blocks the save, since the url field is on screen", () => {
    renderWatcher({ endpointEnabled: true, url: "" });
    expect(saveBlocked()).toBe(true);
  });

  test("a rule the form cannot read blocks the save, since its fields are on screen", () => {
    renderWatcher(label(""));
    expect(saveBlocked()).toBe(true);
  });
});
