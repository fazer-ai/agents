import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import {
  type EditorStub,
  lastSavedSettings,
  renderEditor,
  stubEditorApi,
} from "../utils/agent-editor";

// Every Behavior block the save writes is also read back, on the three paths that set the form from
// an agent: the load, the post-save sync and Discard. A block missing from them reopens as its
// default, and the next save of any behaviour setting writes that default over the stored value.
// Asked of the whole bag: the save writes every block, so a block added to it and read back nowhere
// comes back as its default and the comparison names it.

const realFetch = globalThis.fetch;
afterEach(() => {
  cleanup();
  globalThis.fetch = realFetch;
});

// A value off the default in every block the Behavior save writes, in the shape the save writes it.
const STORED: Record<string, unknown> = {
  availability: { enabled: true, awayMessage: "Voltamos às 9h." },
  debounce: {
    enabled: true,
    windowSeconds: 25,
    maxMessagesPerBurst: 20,
    maxWindowSeconds: 60,
  },
  stt: {
    enabled: true,
    provider: "openai",
    model: "",
    language: "en",
    credentialRef: null,
    baseURL: null,
  },
  contactAuth: {
    enabled: false,
    rule: null,
    askEndpointAfterRule: false,
    url: null,
    credentialRef: null,
    timeoutMs: 5000,
    noticeCooldownSeconds: 120,
    includeMessageText: false,
    denyMessage: null,
    mode: "perMessage",
    grantTtlSeconds: 86400,
    handoffEnabled: true,
    handoffTeamId: null,
    handoffTeamInstanceId: null,
    operatorNoteEnabled: true,
  },
  tts: {
    mode: "never",
    provider: "openai",
    model: "",
    voice: "",
    credentialRef: null,
    baseURL: null,
    normalize: true,
    normalizeProvider: null,
    normalizeModel: null,
    normalizeCredentialRef: null,
    normalizeBaseURL: null,
    stability: null,
    similarityBoost: null,
    style: null,
    speed: null,
    speakerBoost: null,
    checkMode: null,
    textInstead: false,
    textOverChars: 300,
    textOverListItems: 3,
    textOverNumbers: 3,
    spokenNotice: false,
    spokenNoticeText: null,
    textChoice: false,
    textChoiceNote: null,
  },
  split: { enabled: true, maxChars: 400, typingWpm: 250, maxDelayMs: 8000 },
  signature: {
    enabled: true,
    text: "Alex",
    position: "top",
    frequency: "all",
    separator: "blank",
  },
  serviceWindow: {
    enabled: true,
    windowHours: 24,
    templateName: "lembrete",
    templateLanguage: "pt_BR",
    templateCategory: "UTILITY",
    templateParams: [],
    templateContent: null,
  },
  followUp: {
    enabled: false,
    pauseWhileAppointment: true,
    steps: [{ delayValue: 45, delayUnit: "minutes", instructions: "" }],
  },
  vision: {
    enabled: false,
    provider: "openai",
    model: "",
    credentialRef: null,
    baseURL: null,
    extractionPrompt: null,
    maxOutputTokens: 500,
    reasoningEffort: null,
  },
  limits: {
    maxToolCalls: 7,
    maxHistoryTokens: null,
    retrySilence: true,
    maxTurnsPerHour: 60,
    maxProactivePerDay: 4,
  },
  observability: { logToolValues: true, fullDetailUntil: null },
  memory: {
    compaction: {
      enabled: true,
      provider: null,
      model: null,
      credentialRef: null,
      baseURL: null,
    },
    historyDates: { enabled: false },
  },
  modelFallback: {
    provider: "openai",
    model: "gpt-4o-mini",
    credentialRef: null,
    baseURL: null,
  },
  attributeContext: { conversation: ["plano"], contact: [], task: [] },
  contactFields: { context: ["email"], writable: [] },
  takeover: { onHumanReply: false },
};

// What the save writes for an agent with no settings at all.
const DEFAULTS: Record<string, unknown> = {
  availability: { enabled: false, awayMessage: "" },
  debounce: {
    enabled: true,
    windowSeconds: 15,
    maxMessagesPerBurst: 20,
    maxWindowSeconds: 60,
  },
  stt: {
    enabled: true,
    provider: "openai",
    model: "",
    language: "pt",
    credentialRef: null,
    baseURL: null,
  },
  contactAuth: {
    enabled: false,
    rule: null,
    askEndpointAfterRule: false,
    url: null,
    credentialRef: null,
    timeoutMs: 5000,
    noticeCooldownSeconds: 60,
    includeMessageText: false,
    denyMessage: null,
    mode: "perMessage",
    grantTtlSeconds: 86400,
    handoffEnabled: true,
    handoffTeamId: null,
    handoffTeamInstanceId: null,
    operatorNoteEnabled: true,
  },
  tts: {
    mode: "never",
    provider: "openai",
    model: "",
    voice: "",
    credentialRef: null,
    baseURL: null,
    normalize: true,
    normalizeProvider: null,
    normalizeModel: null,
    normalizeCredentialRef: null,
    normalizeBaseURL: null,
    stability: null,
    similarityBoost: null,
    style: null,
    speed: null,
    speakerBoost: null,
    checkMode: null,
    textInstead: false,
    textOverChars: 450,
    textOverListItems: 3,
    textOverNumbers: 3,
    spokenNotice: false,
    spokenNoticeText: null,
    textChoice: false,
    textChoiceNote: null,
  },
  split: { enabled: true, maxChars: 600, typingWpm: 250, maxDelayMs: 8000 },
  signature: {
    enabled: false,
    text: "",
    position: "top",
    frequency: "all",
    separator: "blank",
  },
  serviceWindow: {
    enabled: true,
    windowHours: 24,
    templateName: null,
    templateLanguage: "pt_BR",
    templateCategory: "UTILITY",
    templateParams: [],
    templateContent: null,
  },
  followUp: {
    enabled: false,
    pauseWhileAppointment: true,
    steps: [{ delayValue: 30, delayUnit: "minutes", instructions: "" }],
  },
  vision: {
    enabled: false,
    provider: "openai",
    model: "",
    credentialRef: null,
    baseURL: null,
    extractionPrompt: null,
    maxOutputTokens: null,
    reasoningEffort: null,
  },
  limits: {
    maxToolCalls: 10,
    maxHistoryTokens: null,
    retrySilence: true,
    maxTurnsPerHour: 60,
    maxProactivePerDay: 10,
  },
  observability: { logToolValues: false, fullDetailUntil: null },
  memory: {
    compaction: {
      enabled: true,
      provider: null,
      model: null,
      credentialRef: null,
      baseURL: null,
    },
    historyDates: { enabled: true },
  },
  modelFallback: {
    provider: null,
    model: null,
    credentialRef: null,
    baseURL: null,
  },
  attributeContext: { conversation: [], contact: [], task: [] },
  contactFields: { context: [], writable: [] },
  takeover: { onHumanReply: true },
};

async function save(stub: EditorStub): Promise<Record<string, unknown>> {
  const before = stub.writes.length;
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(stub.writes.length).toBeGreaterThan(before));
  await waitFor(() => expect(lastSavedSettings(stub)).toBeDefined());
  return lastSavedSettings(stub) as Record<string, unknown>;
}

describe("the Behavior tab reads back everything it writes", () => {
  test("the load: a save right after opening writes back exactly what was stored", async () => {
    const stub = stubEditorApi({ settings: STORED });
    await renderEditor(stub, "behavior");
    expect(await save(stub)).toEqual(STORED);
  });

  test("the post-save sync: the form takes what the server answered, every block", async () => {
    const stub = stubEditorApi({ settings: STORED });
    // The server answers the save with the defaults, as if another writer had reset them.
    stub.override = (method, path) =>
      method === "PATCH" && path.endsWith(`/agents/${stub.agent.id}`)
        ? new Response(
            JSON.stringify({
              agent: {
                ...stub.agent,
                settings: DEFAULTS,
                updatedAt: "2026-01-02T00:00:00.000Z",
              },
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          )
        : undefined;
    await renderEditor(stub, "behavior");
    await save(stub);
    stub.override = undefined;
    stub.agent = { ...stub.agent, updatedAt: "2026-01-02T00:00:00.000Z" };
    expect(await save(stub)).toEqual(DEFAULTS);
  });

  test("Discard: an edit goes back to the stored value", async () => {
    const stub = stubEditorApi({ settings: STORED });
    await renderEditor(stub, "behavior");
    fireEvent.click(
      screen.getByRole("switch", {
        name: /Stop answering when a person replies to the customer/,
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Discard" }));
    expect(await save(stub)).toEqual(STORED);
  });
});
