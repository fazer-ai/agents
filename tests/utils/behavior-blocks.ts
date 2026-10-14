import { expect } from "bun:test";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { type EditorStub, stubEditorApi } from "./agent-editor";

// The Behavior tab with a value off the default in every block, and an edit to every block through
// its own control, for the tests that ask something of all of them at once.

// A value off the default in every block the Behavior save writes, in the shape the save writes it.
export const STORED: Record<string, unknown> = {
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
  otherInboxes: {
    enabled: true,
    inboxes: [{ instanceId: 3, inboxId: 12 }],
    maxConversations: 3,
    lookbackDays: 30,
    fullTranscriptMaxChars: 1500,
  },
};

// Two schedules to pick between; the agent is bound to the first one for both pickers.
export function stubWithHours(): EditorStub {
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

export function changeTo(
  el: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement,
  value: string,
) {
  fireEvent.change(el, { target: { value } });
  expect(el.value).toBe(value);
}

export function otherOption(select: HTMLSelectElement): string {
  const other = [...select.options].find((o) => o.value !== select.value);
  if (!other) throw new Error("a select with one option cannot be edited");
  return other.value;
}

// The follow-up's schedule is drawn twice when the snoozed follow-up is on (both ladders share it), so
// the first picker of that name is the one edited.
export async function pickSchedule(picker: string, name: string) {
  const trigger = screen.getAllByRole("button", { name: picker })[0];
  if (!trigger) throw new Error(`no ${picker} picker on screen`);
  // Radix opens its menu on pointerdown, not on a synthesized click.
  fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false });
  fireEvent.click(
    await screen.findByRole("menuitem", { name: new RegExp(`^${name}`) }),
  );
  await waitFor(() => expect(trigger.textContent).toContain(name));
}

// One edit per control that has no switch of its own, each moving one thing off STORED: the two
// schedules (agent fields, not settings), then one block each.
export const FIELD_EDITS: Array<{
  name: string;
  run: () => Promise<void> | void;
}> = [
  {
    name: "business hours",
    run: () => pickSchedule("Business hours", "Plantão"),
  },
  {
    name: "follow-up schedule",
    run: () => pickSchedule("Allowed schedule", "Plantão"),
  },
  {
    name: "out-of-hours message",
    run: () =>
      changeTo(
        screen.getByLabelText("Out-of-hours message") as HTMLTextAreaElement,
        "Fechado agora.",
      ),
  },
  {
    name: "audio replies",
    run: () => {
      const audio = screen.getByLabelText(
        "When to reply with audio",
      ) as HTMLSelectElement;
      changeTo(audio, otherOption(audio));
    },
  },
  {
    name: "max tool calls",
    run: () =>
      changeTo(
        screen.getByLabelText("Max tool calls / turn") as HTMLInputElement,
        "3",
      ),
  },
  {
    // The snoozed default cadence's first step: its delay, a field of the ladder the switches hide.
    name: "snoozed follow-up delay",
    run: () => {
      const delay = screen
        .getByRole("group", { name: "Wait after the person's message" })
        .querySelector('input[type="number"]') as HTMLInputElement;
      changeTo(delay, "5");
    },
  },
  {
    name: "model fallback",
    run: () => {
      const fallback = screen
        .getAllByLabelText("Provider")
        .find((el) =>
          el.textContent?.includes("No fallback"),
        ) as HTMLSelectElement;
      changeTo(fallback, "");
    },
  },
  {
    // The selected other inbox's chip has a Remove of its own: this one is the context document's.
    name: "context document",
    run: () => {
      const removeDoc = screen
        .getAllByRole("button", { name: "Remove" })
        .find((b) => b.parentElement?.textContent?.includes("plano"));
      fireEvent.click(removeDoc as HTMLElement);
      expect(screen.queryByText("plano")).toBeNull();
    },
  },
  {
    name: "first checkbox",
    run: () => {
      const box = screen.getAllByRole("checkbox")[0] as HTMLInputElement;
      const was = box.checked;
      fireEvent.click(box);
      expect(box.checked).toBe(!was);
    },
  },
];

// Moves every Behavior block off STORED through its own control: the edits above, then every switch
// on screen. Switches go last and bottom-up, since turning one off unmounts what it governs
// (follow-up steps, the away message).
export async function editEveryBlock() {
  for (const edit of FIELD_EDITS) await edit.run();
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
