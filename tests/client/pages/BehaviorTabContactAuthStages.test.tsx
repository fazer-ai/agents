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
import {
  BehaviorTab,
  type ContactAuthState,
} from "@/client/pages/agents/BehaviorTab";
import {
  EMPTY_CONTACT_AUTH_CONDITION_FORM,
  EMPTY_CONTACT_AUTH_RULE_FORM,
} from "@/client/pages/agents/contactAuthRuleForm";
import { behaviorTabProps } from "./behaviorTabProps";

// The section decides who the agent serves: a rule first, the endpoint after it when the operator
// asks for both, an optional note on a denial, and the quiet refusal said out loud when the three
// switches line up for it.
//
// Every assertion reduces to a number or a boolean BEFORE expect (a failing expectation holding a
// DOM node serializes a cyclic happy-dom tree and stalls the runner).

const realFetch = globalThis.fetch;
const stubFetch = (async () =>
  new Response(JSON.stringify({ data: [] }), {
    headers: { "content-type": "application/json" },
  })) as unknown as typeof globalThis.fetch;

function renderGate(over: Partial<ContactAuthState>): void {
  const props = behaviorTabProps({});
  render(
    <BehaviorTab
      {...props}
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
const urlField = () => count(/^(Authorization URL|URL de autorização)$/);
const askAfterSwitch = () =>
  count(/^(Ask an external endpoint|Perguntar a um endpoint externo)$/);
const quietHint = () => count(/^(Quiet refusal|Recusa silenciosa)/);
const sectionTitle = () =>
  count(/^(Who this agent serves|Quem este agente atende)$/);
const saveBlocked = () =>
  screen
    .getAllByRole("button", { name: /^(Save|Salvar)$/ })
    .some((b) => (b as HTMLButtonElement).disabled);

const LABEL_RULE = {
  ruleConditions: [
    {
      ...EMPTY_CONTACT_AUTH_CONDITION_FORM,
      ruleKind: "label",
      ruleLabel: "suporte",
    },
  ],
};

describe("the section in the editor", () => {
  beforeAll(() => {
    globalThis.fetch = stubFetch;
  });
  afterEach(() => cleanup());
  afterAll(() => {
    globalThis.fetch = realFetch;
  });

  test("the section is named for what it decides", () => {
    renderGate({});
    expect(sectionTitle() > 0).toBe(true);
  });

  test("a rule with the switch off hides the endpoint, and offers to ask it after", () => {
    renderGate(LABEL_RULE);
    expect(askAfterSwitch() > 0).toBe(true);
    expect(urlField()).toBe(0);
    expect(saveBlocked()).toBe(false);
  });

  test("a rule with the endpoint after it shows the endpoint, and needs its URL", () => {
    renderGate({ ...LABEL_RULE, endpointEnabled: true });
    expect(urlField() > 0).toBe(true);
    expect(saveBlocked()).toBe(true);
  });

  test("the endpoint alone is the switch on with no conditions", () => {
    renderGate({ endpointEnabled: true });
    expect(askAfterSwitch() > 0).toBe(true);
    expect(urlField() > 0).toBe(true);
  });

  test("no message, no note and the handoff on reads as the quiet refusal", () => {
    renderGate({
      ...LABEL_RULE,
      denyMessage: "",
      operatorNoteEnabled: false,
      handoffEnabled: true,
    });
    expect(quietHint() > 0).toBe(true);
  });

  test("any one of the three missing is not the quiet refusal", () => {
    for (const over of [
      {
        denyMessage: "Não atendemos",
        operatorNoteEnabled: false,
        handoffEnabled: true,
      },
      { denyMessage: "", operatorNoteEnabled: true, handoffEnabled: true },
      { denyMessage: "", operatorNoteEnabled: false, handoffEnabled: false },
    ]) {
      renderGate({ ...LABEL_RULE, ...over });
      expect(quietHint()).toBe(0);
      cleanup();
    }
  });
});

// Checked on the source for the reason BehaviorTabContactAuthRule gives: rendering the whole editor
// page pulls auth, theme, toast and a live catalog.
describe("the Behavior save", () => {
  const src = readFileSync(
    "src/client/pages/agents/AgentEditorPage.tsx",
    "utf8",
  );

  test("carries both new fields as the form holds them", () => {
    expect(src.replace(/\s+/g, " ")).toContain(
      "askEndpointAfterRule: contactAuth.endpointEnabled,",
    );
    expect(src).toContain(
      "operatorNoteEnabled: contactAuth.operatorNoteEnabled,",
    );
  });

  test("reads them back as strictly as the runtime does", () => {
    expect(src).toMatch(
      /endpointEnabled: readContactAuthEndpointEnabled\(\s*caRule,\s*ca\.url,\s*ca\.askEndpointAfterRule,\s*\)/,
    );
    expect(src).toContain(
      "operatorNoteEnabled: ca.operatorNoteEnabled !== false,",
    );
  });

  test("the endpoint warnings follow the endpoint stage", () => {
    expect(src).toMatch(
      /contactAuthRuleOnly:\s*contactAuth\.ruleConditions\.length > 0 && !contactAuth\.endpointEnabled,/,
    );
  });
});
