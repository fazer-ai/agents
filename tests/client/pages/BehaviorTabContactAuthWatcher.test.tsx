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
import { EMPTY_CONTACT_AUTH_RULE_FORM } from "@/client/pages/agents/contactAuthRuleForm";
import { behaviorTabProps } from "./behaviorTabProps";

// A monitoring agent's gate: only the rule runs on the observer path, so the section is drawn with
// the rule alone, says that the rule decides which conversations are observed, and says it when an
// endpoint-only gate does nothing here. Every assertion reduces to a number or a boolean BEFORE
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
  count(/^(Then ask an external endpoint|Depois, perguntar a um endpoint)/);
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
const endpointOnlyWarning = () =>
  count(
    /(an external endpoint is not asked|o endpoint externo não é consultado)/,
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

  test("is drawn with the rule alone and says the rule decides what is observed", () => {
    renderWatcher({ ruleKind: "label", ruleLabel: "suporte" });
    expect(sectionShown()).toBe(true);
    expect(observedHint() > 0).toBe(true);
    expect(urlField()).toBe(0);
    expect(askAfterSwitch()).toBe(0);
    expect(denyMessage()).toBe(0);
    expect(handoff()).toBe(0);
    expect(endpointOnlyWarning()).toBe(0);
    expect(saveBlocked()).toBe(false);
  });

  test("an endpoint-only gate is flagged as doing nothing here, and does not block the save", () => {
    renderWatcher({});
    expect(sectionShown()).toBe(true);
    expect(endpointOnlyWarning() > 0).toBe(true);
    expect(urlField()).toBe(0);
    expect(saveBlocked()).toBe(false);
  });

  test("a rule the form cannot read blocks the save, since its fields are on screen", () => {
    renderWatcher({ ruleKind: "label", ruleLabel: "" });
    expect(saveBlocked()).toBe(true);
  });
});
