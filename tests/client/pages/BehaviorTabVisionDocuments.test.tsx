/// <reference lib="dom" />

import { afterAll, afterEach, describe, expect, test } from "bun:test";
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
globalThis.fetch = (async () =>
  new Response(JSON.stringify({ data: [] }), {
    headers: { "content-type": "application/json" },
  })) as unknown as typeof globalThis.fetch;

function renderWithProvider(provider: string): void {
  const noop = () => {};
  const props = {
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
      baseURL: "",
      extractionPrompt: "Leia.",
    },
    setVision: noop,
    visionCredBaseUrl: null,
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
    observability: { logToolValues: false },
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
  } as unknown as React.ComponentProps<typeof BehaviorTab>;
  render(<BehaviorTab {...props} />);
}

// Counts every place the tab says "images only", not just the new hint: the model field carried a
// STATIC sentence naming openai as image-only, which the same change turns into a lie. Whichever
// line says it, an operator on a provider that reads PDFs must not read it.
const warnings = () =>
  screen.queryAllByText(/images only/i).length +
  screen.queryAllByText(/apenas imagens/i).length;

describe("vision provider document support, at the point of choice", () => {
  afterEach(() => cleanup());
  afterAll(() => {
    globalThis.fetch = realFetch;
  });

  test("openrouter is called out as image-only", () => {
    renderWithProvider("openrouter");
    expect(warnings() > 0).toBe(true);
  });

  test("openai-compatible is called out as image-only", () => {
    renderWithProvider("openai-compatible");
    expect(warnings() > 0).toBe(true);
  });

  // The one the issue is about: openai reads PDFs now, so warning about it would be the new lie.
  test("openai carries no such warning", () => {
    renderWithProvider("openai");
    expect(warnings()).toBe(0);
  });

  test("gemini carries no such warning", () => {
    renderWithProvider("gemini");
    expect(warnings()).toBe(0);
  });
});
