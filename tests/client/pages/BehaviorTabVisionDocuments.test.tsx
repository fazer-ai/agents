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
import { BehaviorTab } from "@/client/pages/agents/BehaviorTab";
import { readTtsFormState } from "@/client/pages/agents/ttsFormState";

// Issue #324, second half: `openai` reads PDFs now, `openrouter` and `openai-compatible` still do
// not, and the operator who picks one of those has no way to learn it except from attachments that
// silently come back unextracted. The warning belongs where the choice is made.
//
// NOTE: every assertion reduces to a number or a boolean BEFORE expect. A failing expectation
// holding a DOM node serializes a cyclic happy-dom tree and stalls the runner.

const realFetch = globalThis.fetch;
const stubFetch = (async () =>
  new Response(JSON.stringify({ data: [] }), {
    headers: { "content-type": "application/json" },
  })) as unknown as typeof globalThis.fetch;

function renderWithProvider(
  provider: string,
  { baseURL = "", credBaseUrl = null as string | null } = {},
): void {
  const noop = () => {};
  const props: React.ComponentProps<typeof BehaviorTab> &
    Record<string, unknown> = {
    agentId: "1",
    hours: [],
    businessHoursId: "",
    setBusinessHoursId: noop,
    awayEnabled: false,
    setAwayEnabled: noop,
    awayMessage: "",
    setAwayMessage: noop,
    followUpHoursId: "",
    setFollowUpHoursId: noop,
    debounce: {
      enabled: false,
      windowSeconds: "8",
      maxMessagesPerBurst: "10",
      maxWindowSeconds: "60",
    },
    setDebounce: noop,
    stt: {
      enabled: false,
      provider: "openai",
      model: "",
      language: "pt",
      credentialRef: "",
      baseURL: "",
    },
    setStt: noop,
    sttCredBaseUrl: null,
    contactAuth: {
      enabled: false,
      url: "",
      credentialRef: "",
      timeoutMs: "5000",
      noticeCooldownSeconds: "60",
      includeMessageText: false,
      denyMessage: "",
      handoffEnabled: false,
      handoffTeamId: "",
      handoffTeamInstanceId: "",
    },
    setContactAuth: noop,
    tts: readTtsFormState(undefined),
    setTts: noop,
    agentModelProvider: "openai",
    agentModelName: "gpt-4o",
    agentModelCredentialRef: "",
    agentModelBaseUrl: "",
    ttsNormalizeCredBaseUrl: null,
    split: {
      enabled: false,
      maxChars: "300",
      typingWpm: "200",
      maxDelayMs: "0",
    },
    setSplit: noop,
    vision: {
      enabled: true,
      provider,
      model: "",
      credentialRef: "",
      baseURL,
      extractionPrompt: "Leia.",
    },
    setVision: noop,
    visionCredBaseUrl: credBaseUrl,
    limits: { maxToolCalls: "10", maxHistoryTokens: "" },
    setLimits: noop,
    memory: {
      compactionEnabled: false,
      provider: "",
      model: "",
      credentialRef: "",
      baseURL: "",
    },
    setMemory: noop,
    memoryCredBaseUrl: null,
    modelFallback: {
      provider: "",
      model: "",
      credentialRef: "",
      baseURL: "",
    },
    setModelFallback: noop,
    modelFallbackCredBaseUrl: null,
    // A SUPERSET of what this tree's component reads, because the two editions do not carry the same
    // props: the observability debug mode (#58/#335) reached the Free repo, where this PR opens,
    // before it reached master, and a bag written against one tree throws on render in the other.
    // The extras are absorbed by the `Record<string, unknown>` half of the annotation.
    //
    // ANNOTATED, NOT CAST, and that is the whole point of the shape above. This bag used to end in
    // `as unknown as React.ComponentProps<typeof BehaviorTab>`, which absorbs the extras by
    // absorbing everything: a prop the component REQUIRES and this bag omits is then invisible to
    // tsc and surfaces as `TypeError: undefined is not an object` inside `render`, in this one file,
    // which is the only place in the suite that renders this tab. Measured: the fallback-provider
    // block (#143) added three required props, the whole suite still type-checked, and these seven
    // tests failed on a component they say nothing about. The intersection keeps the missing-key
    // check that a cast throws away while still tolerating the edition that has extra keys, and it
    // type-checks in BOTH trees (0 errors in each, and removing `modelFallback` reports TS2322).
    observability: {
      logToolValues: false,
      fullDetail: false,
      fullDetailUntil: null,
    },
    savedObservability: {
      logToolValues: false,
      fullDetail: false,
      fullDetailUntil: null,
    },
    langfuseSendContent: false,
    setObservability: noop,
    sendImage: { allowedHosts: "" },
    setSendImage: noop,
    attributeContext: { conversation: [], contact: [], task: [] },
    setAttributeContext: noop,
    serviceWindow: {
      enabled: false,
      windowHours: "24",
      templateName: "",
      templateLanguage: "",
      templateParams: "",
      templateContent: "",
    },
    setServiceWindow: noop,
    followUp: { enabled: false, steps: [], pauseWhileAppointment: false },
    setFollowUp: noop,
    redirectSuppressesFollowUp: false,
    onScheduleSaved: noop,
    dirty: false,
    saving: false,
    onSave: noop,
    onDiscard: noop,
    onOpenPlayground: noop,
  };
  render(<BehaviorTab {...props} />);
}

const warnings = () =>
  screen.queryAllByText(/PDF attachments are skipped/i).length +
  screen.queryAllByText(/anexos em PDF são ignorados/i).length;

// The model field carried a STATIC sentence naming which providers read PDFs, which this change
// turns into a lie. It is counted separately because it is a different failure from a missing
// warning: nothing about it depends on the provider being rendered.
const staleClaims = () =>
  screen.queryAllByText(/reads images only/i).length +
  screen.queryAllByText(/lê apenas imagens/i).length;

describe("vision provider document support, at the point of choice", () => {
  // Installed in `beforeAll` rather than at module scope, and this is not style. `globalThis.fetch`
  // is the whole PROCESS's, and a swap made while the module loads is in force from that moment
  // until this describe finishes — a window that covers whatever else the runner is doing in
  // between. Every DB-backed test in the suite that reaches the network is inside it. Bracketing it
  // to the describe keeps the swap as short as the tests that need it.
  beforeAll(() => {
    globalThis.fetch = stubFetch;
  });
  afterEach(() => cleanup());
  afterAll(() => {
    globalThis.fetch = realFetch;
  });

  test("openrouter is called out as image-only", () => {
    renderWithProvider("openrouter");
    expect(warnings() > 0).toBe(true);
  });

  // The endpoint is what has to be known, and a base URL survives the provider being switched: an
  // agent moved off `openai-compatible` keeps posting to the operator's own server under the name
  // `openai`. The warning has to follow the endpoint, not the name.
  test("openai pointed at someone else's endpoint is called out too", () => {
    renderWithProvider("openai", {
      baseURL: "https://llm.internal.example/v1",
    });
    expect(warnings() > 0).toBe(true);
  });

  // Same thing arriving the other way: a credential can carry its own base URL, and it OUTRANKS the
  // typed field (the field is rendered read-only when it does).
  test("openai on a credential that carries its own endpoint is called out too", () => {
    renderWithProvider("openai", {
      credBaseUrl: "https://llm.internal.example/v1",
    });
    expect(warnings() > 0).toBe(true);
  });

  test("openai spelled out as its own endpoint is not", () => {
    renderWithProvider("openai", { baseURL: "https://api.openai.com/v1" });
    expect(warnings()).toBe(0);
  });

  test("openai-compatible is called out as image-only", () => {
    renderWithProvider("openai-compatible");
    expect(warnings() > 0).toBe(true);
  });

  // The one the issue is about: openai reads PDFs now, so warning about it would be the new lie.
  test("openai carries no such warning", () => {
    renderWithProvider("openai");
    expect(warnings()).toBe(0);
    expect(staleClaims()).toBe(0);
  });

  test("gemini carries no such warning", () => {
    renderWithProvider("gemini");
    expect(warnings()).toBe(0);
    expect(staleClaims()).toBe(0);
  });
});
