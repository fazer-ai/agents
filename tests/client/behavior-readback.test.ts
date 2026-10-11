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
    enabled: true,
    pauseWhileAppointment: true,
    steps: [{ delayValue: 45, delayUnit: "minutes", instructions: "" }],
  },
  snoozedFollowUp: {
    enabled: true,
    signature: true,
    cadences: [
      {
        label: null,
        steps: [
          {
            delayValue: 2,
            delayUnit: "hours",
            instructions: "Pergunte se o comprovante já saiu.",
          },
        ],
      },
    ],
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
};

// Two schedules to pick between; the agent is bound to the first one for both pickers.
function stubWithHours(): EditorStub {
  const stub = stubEditorApi({ settings: STORED });
  stub.agent = {
    ...stub.agent,
    businessHoursId: "h-1",
    followUpHoursId: "h-1",
  };
  const schedule = (id: string, name: string) => ({
    id,
    name,
    timezone: "America/Sao_Paulo",
    windows: [],
    exceptions: [],
  });
  stub.override = (method, path) =>
    method === "GET" && path === "/api/v1/business-hours"
      ? new Response(
          JSON.stringify({
            businessHours: [
              schedule("h-1", "Comercial"),
              schedule("h-2", "Plantão"),
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        )
      : undefined;
  return stub;
}

function lastPatch(stub: EditorStub): Record<string, unknown> | undefined {
  return [...stub.writes].reverse().find((w) => w.method === "PATCH")?.body;
}

function changeTo(
  el: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement,
  value: string,
) {
  fireEvent.change(el, { target: { value } });
  expect(el.value).toBe(value);
}

function otherOption(select: HTMLSelectElement): string {
  const other = [...select.options].find((o) => o.value !== select.value);
  if (!other) throw new Error("a select with one option cannot be edited");
  return other.value;
}

// The follow-up's schedule is drawn twice when the snoozed follow-up is on (both ladders share it), so
// the first picker of that name is the one edited.
async function pickSchedule(picker: string, name: string) {
  const trigger = screen.getAllByRole("button", { name: picker })[0];
  if (!trigger) throw new Error(`no ${picker} picker on screen`);
  // Radix opens its menu on pointerdown, not on a synthesized click.
  fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false });
  fireEvent.click(
    await screen.findByRole("menuitem", { name: new RegExp(`^${name}`) }),
  );
  await waitFor(() => expect(trigger.textContent).toContain(name));
}

// Moves every Behavior block off STORED through its own control: the schedules, the inputs and
// selects of the blocks with no switch of their own, then every switch on screen. Switches go last
// and bottom-up, since turning one off unmounts what it governs (follow-up steps, the away message).
async function editEveryBlock() {
  await pickSchedule("Business hours", "Plantão");
  await pickSchedule("Allowed schedule", "Plantão");
  changeTo(
    screen.getByLabelText("Out-of-hours message") as HTMLTextAreaElement,
    "Fechado agora.",
  );
  const audio = screen.getByLabelText(
    "When to reply with audio",
  ) as HTMLSelectElement;
  changeTo(audio, otherOption(audio));
  changeTo(
    screen.getByLabelText("Max tool calls / turn") as HTMLInputElement,
    "3",
  );
  // The snoozed default cadence's first step: its delay, a field of the ladder the switches below hide.
  const snoozedDelay = screen
    .getByRole("group", { name: "Wait after the person's message" })
    .querySelector('input[type="number"]') as HTMLInputElement;
  changeTo(snoozedDelay, "5");
  const fallback = screen
    .getAllByLabelText("Provider")
    .find((el) => el.textContent?.includes("No fallback")) as HTMLSelectElement;
  changeTo(fallback, "");
  fireEvent.click(screen.getByRole("button", { name: "Remove" }));
  expect(screen.queryByText("plano")).toBeNull();
  const inContext = screen.getAllByRole("checkbox")[0] as HTMLInputElement;
  const was = inContext.checked;
  fireEvent.click(inContext);
  expect(inContext.checked).toBe(!was);
  // A switch an earlier flip unmounted (a step's exemption, under the pause) has nothing to edit.
  let flipped = 0;
  for (const s of screen.getAllByRole("switch").reverse()) {
    if (!s.isConnected) continue;
    const was = s.getAttribute("aria-checked");
    fireEvent.click(s);
    expect(s.getAttribute("aria-checked")).not.toBe(was);
    flipped += 1;
  }
  // Guards the loop: a render that drew no switch would edit nothing above.
  expect(flipped).toBeGreaterThanOrEqual(14);
}

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

  // Discard also resets the shared settings bag and the observability the recording warning reads,
  // and neither has a control here: other tabs' saves move the bag together with the synced agent,
  // and only a server read sets the other, so no edit on this tab can tell them apart.
  test("Discard: every block the tab edits goes back to the stored value", async () => {
    const stub = stubWithHours();
    await renderEditor(stub, "behavior");
    await editEveryBlock();
    expect(screen.queryAllByText("Unsaved changes").length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole("button", { name: "Discard" }));
    expect(await save(stub)).toEqual(STORED);
    expect(lastPatch(stub)).toMatchObject({
      businessHoursId: "h-1",
      followUpHoursId: "h-1",
    });
  });

  // The Observation block is drawn only for a monitoring agent, so its Discard is asked there, against
  // what a save with no edit writes.
  test("Discard: the Observation block of a monitoring agent goes back too", async () => {
    const stub = stubEditorApi({ mode: "monitoring", settings: STORED });
    await renderEditor(stub, "behavior");
    const before = (await save(stub)).monitoring;
    expect(before).toBeDefined();
    const when = screen.getByLabelText("When to classify") as HTMLSelectElement;
    changeTo(when, otherOption(when));
    const read = screen.getByLabelText("Messages read") as HTMLInputElement;
    changeTo(read, String(Number(read.value) + 5));
    fireEvent.click(screen.getByRole("button", { name: "Discard" }));
    expect((await save(stub)).monitoring).toEqual(before);
  });
});
