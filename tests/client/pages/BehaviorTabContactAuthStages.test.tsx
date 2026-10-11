/// <reference lib="dom" />

import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import en from "@/client/locales/en.json";
import {
  BehaviorTab,
  type ContactAuthState,
} from "@/client/pages/agents/BehaviorTab";
import {
  EMPTY_CONTACT_AUTH_CONDITION_FORM,
  EMPTY_CONTACT_AUTH_RULE_FORM,
} from "@/client/pages/agents/contactAuthRuleForm";
import {
  type EditorStub,
  lastSavedSettings,
  renderEditor,
  stubEditorApi,
} from "../../utils/agent-editor";
import { createTestI18n } from "../../utils/i18n";
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

// The editor around the tab: what the Behavior save writes from these switches, how the load reads
// them back, and which warnings the endpoint stage raises.
describe("the Behavior save", () => {
  afterEach(() => {
    cleanup();
    globalThis.fetch = realFetch;
  });
  const LABEL_STORED = { kind: "label", label: "vip" };

  async function openGate(contactAuth: Record<string, unknown>) {
    const stub = stubEditorApi({ settings: { contactAuth } });
    // The warning's sentence lives only in the catalog.
    await renderEditor(
      stub,
      "behavior",
      createTestI18n("en", { en: { translation: en } }),
    );
    return stub;
  }
  async function saved(stub: EditorStub) {
    const before = stub.writes.length;
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(stub.writes.length).toBeGreaterThan(before));
    const ca = (lastSavedSettings(stub)?.contactAuth ?? {}) as Record<
      string,
      unknown
    >;
    return {
      askEndpointAfterRule: ca.askEndpointAfterRule,
      operatorNoteEnabled: ca.operatorNoteEnabled,
    };
  }

  test("carries both new fields as the form holds them", async () => {
    const stub = await openGate({
      enabled: true,
      rule: LABEL_STORED,
      url: "https://auth.example.com/check",
      askEndpointAfterRule: false,
      operatorNoteEnabled: true,
    });
    fireEvent.click(
      screen.getByRole("switch", { name: /^Ask an external endpoint/ }),
    );
    fireEvent.click(
      screen.getByRole("switch", {
        name: /^Write a private note when a contact is refused/,
      }),
    );
    expect(await saved(stub)).toEqual({
      askEndpointAfterRule: true,
      operatorNoteEnabled: false,
    });
  });

  test("reads them back as strictly as the runtime does", async () => {
    // Only a literal `true` asks the endpoint after a rule, and only a literal `false` silences the
    // note: any other spelling reads the runtime's way, and a save that writes the block (any edit
    // to it) writes that reading. Untouched, the block goes back as stored (agents#1304).
    const lax = await openGate({
      enabled: true,
      rule: LABEL_STORED,
      url: "https://auth.example.com/check",
      askEndpointAfterRule: "true",
      operatorNoteEnabled: "false",
    });
    const ask = screen.getByRole("switch", {
      name: /^Ask an external endpoint/,
    });
    expect(ask.getAttribute("aria-checked")).toBe("false");
    expect(
      screen
        .getByRole("switch", { name: /^Write a private note when a contact/ })
        .getAttribute("aria-checked"),
    ).toBe("true");
    // The edit that makes the save write the block: the note's reading goes with it, strictly.
    fireEvent.click(ask);
    expect(await saved(lax)).toEqual({
      askEndpointAfterRule: true,
      operatorNoteEnabled: true,
    });
    cleanup();
    const strict = await openGate({
      enabled: true,
      rule: LABEL_STORED,
      url: "https://auth.example.com/check",
      askEndpointAfterRule: true,
      operatorNoteEnabled: false,
    });
    // An edit elsewhere in the block, so the save writes it and the strict reading goes back as is.
    fireEvent.change(
      screen.getByDisplayValue("https://auth.example.com/check"),
      {
        target: { value: "https://auth.example.com/check2" },
      },
    );
    expect(await saved(strict)).toEqual({
      askEndpointAfterRule: true,
      operatorNoteEnabled: false,
    });
  });

  test("the endpoint warnings follow the endpoint stage", async () => {
    const NO_URL = /^The authorization check is on but has no endpoint to ask/;
    // A rule alone decides: no endpoint is asked, so a missing URL is not a problem.
    await openGate({ enabled: true, rule: LABEL_STORED, url: null });
    expect(screen.queryAllByText(NO_URL).length).toBe(0);
    // The endpoint asked after the rule needs its URL.
    fireEvent.click(
      screen.getByRole("switch", { name: /^Ask an external endpoint/ }),
    );
    await waitFor(() =>
      expect(screen.queryAllByText(NO_URL).length).toBeGreaterThan(0),
    );
  });
});
