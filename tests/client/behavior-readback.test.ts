import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import {
  type EditorStub,
  lastSavedSettings,
  renderEditor,
  stubEditorApi,
} from "../utils/agent-editor";
import {
  changeTo,
  editEveryBlock,
  otherOption,
  STORED,
  stubWithHours,
} from "../utils/behavior-blocks";

// Every Behavior block the save writes is also read back, on the three paths that set the form from
// an agent: the load, the post-save sync and Discard. Asked through Save, which is enabled only while
// the form differs from the server's copy (agents#1365): a path that left a block off what the server
// holds would leave the tab edited, and Save enabled, with nothing touched.

const realFetch = globalThis.fetch;
afterEach(() => {
  cleanup();
  globalThis.fetch = realFetch;
});

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
  snoozedFollowUp: { enabled: false, signature: false, cadences: [] },
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
  otherInboxes: {
    enabled: false,
    inboxes: [],
    maxConversations: 5,
    lookbackDays: 90,
    fullTranscriptMaxChars: 2000,
  },
};

async function save(stub: EditorStub): Promise<Record<string, unknown>> {
  const before = stub.writes.length;
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(stub.writes.length).toBeGreaterThan(before));
  await waitFor(() => expect(lastSavedSettings(stub)).toBeDefined());
  return lastSavedSettings(stub) as Record<string, unknown>;
}

const saveButton = () => screen.getByRole("button", { name: "Save" });

describe("the Behavior tab reads back everything it writes", () => {
  test("the load: nothing reads as edited, so there is nothing to save", async () => {
    const stub = stubEditorApi({ settings: STORED });
    await renderEditor(stub, "behavior");
    expect(saveButton()).toHaveProperty("disabled", true);
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
    changeTo(
      screen.getByLabelText("Max tool calls / turn") as HTMLInputElement,
      "3",
    );
    await save(stub);
    // A block the sync left as it was in the form would differ from the server's copy now.
    await waitFor(() => expect(saveButton()).toHaveProperty("disabled", true));
  });

  // Discard also resets the shared settings bag and the observability the recording warning reads,
  // and neither has a control here: other tabs' saves move the bag together with the synced agent,
  // and only a server read sets the other, so no edit on this tab can tell them apart.
  test("Discard: every block the tab edits goes back to the stored value", async () => {
    const stub = stubWithHours();
    await renderEditor(stub, "behavior");
    await editEveryBlock();
    expect(screen.queryAllByText("Unsaved changes").length).toBeGreaterThan(0);
    // The agent's discard asks first (agents#1520).
    fireEvent.click(screen.getByRole("button", { name: "Discard" }));
    fireEvent.click(await screen.findByRole("button", { name: "Discard all" }));
    // Nothing left that differs from the server's copy: no mark, no Discard, no Save.
    await waitFor(() =>
      expect(screen.queryAllByText("Unsaved changes").length).toBe(0),
    );
    expect(screen.queryByRole("button", { name: "Discard" })).toBeNull();
    expect(saveButton()).toHaveProperty("disabled", true);
    expect(stub.writes.filter((w) => w.method === "PATCH")).toEqual([]);
  });

  // The Observation block is drawn only for a monitoring agent, so its Discard is asked there.
  test("Discard: the Observation block of a monitoring agent goes back too", async () => {
    const stub = stubEditorApi({ mode: "monitoring", settings: STORED });
    await renderEditor(stub, "behavior");
    const when = screen.getByLabelText("When to classify") as HTMLSelectElement;
    changeTo(when, otherOption(when));
    const read = screen.getByLabelText("Messages read") as HTMLInputElement;
    changeTo(read, String(Number(read.value) + 5));
    expect(saveButton()).toHaveProperty("disabled", false);
    // The agent's discard asks first (agents#1520).
    fireEvent.click(screen.getByRole("button", { name: "Discard" }));
    fireEvent.click(await screen.findByRole("button", { name: "Discard all" }));
    await waitFor(() => expect(saveButton()).toHaveProperty("disabled", true));
  });
});
