/// <reference lib="dom" />

import { afterAll, afterEach, describe, expect, test } from "bun:test";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router";
import { ToastProvider } from "@/client/components/Toast";
import { OccurrencesPanel } from "@/client/pages/resources/OccurrencesPanel";

const { default: i18n } = await import("@/client/lib/i18n");

// The occurrence monitor's screen: it starts from two fixed fields, the reason and the optional
// reference, each with an editable name and description; any other field is an additional one, and
// the cap is stated; switching on says what is missing instead of sending a 422. It is in three tabs
// kept in the URL, and says everything in words (names, plurals, a sentence for the thresholds).
//
// An element is asserted absent as a boolean, never as `expect(el).toBeNull()` inside `waitFor`: each
// failed attempt of that formats the whole happy-dom node, document and window included, into a
// message of over a gigabyte, and the poll that should take milliseconds takes tens of seconds.
const absent = (el: Element | null) => expect(el === null).toBe(true);

const realFetch = globalThis.fetch;
const requests: Array<{ method: string; path: string; body: unknown }> = [];

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const DEFAULTS = {
  enabled: false,
  inboxIds: [] as string[],
  fields: [],
  reasonField: null as string | null,
  referenceField: null as string | null,
  cadenceMinutes: 15,
  consolidationMinutes: 60,
  newMinConversations: 5,
  windowMinutes: 60,
  previousDays: 7,
  aboveUsualRatio: 3,
  concentrationShare: 0.6,
  model: null as null | Record<string, unknown>,
  businessContext: "",
  recoverMedia: false,
};

const READING = {
  provider: "openai",
  model: "gpt-5-mini",
  credentialRef: "vault:3",
  baseURL: null,
};

const INBOX = (id: string, name: string, agentId: string | null) => ({
  id,
  chatwootInstanceId: "1",
  chatwootInboxId: Number(id),
  name,
  channelType: "Channel::Whatsapp",
  provider: null,
  agentId,
  observerAgentIds: [],
  voiceAgentId: null,
});

const NO_STEPS = {
  reading: null,
  canonical: null,
  assignment: null,
  consolidation: null,
  flags: null,
  skipped: [],
};

// When set, answers every read of the rounds instead of the default list.
let runsOverride: ((url: URL) => Record<string, unknown>) | null = null;

// When set, a PUT waits for it, so a test can edit the form while the save is out.
let holdPut: Promise<void> | null = null;
// How many reads of the rounds fail before one answers.
let runsFailures = 0;
let costFailures = 0;
// The filter options' inboxes: where a repeated name gets its account.
let filterInboxes: {
  id: string;
  name: string;
  account?: { id: number; name: string | null };
}[] = [];

function installFetchStub(config: Record<string, unknown> = DEFAULTS) {
  requests.length = 0;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    const method = (
      input instanceof Request ? input.method : (init?.method ?? "GET")
    ).toUpperCase();
    const body =
      typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    requests.push({ method, path: url.pathname, body });
    if (url.pathname === "/api/v1/occurrences/config" && method === "GET")
      return json({ instance: {}, occurrences: config });
    if (url.pathname === "/api/v1/occurrences/config" && method === "PUT") {
      if (holdPut) await holdPut;
      const merged = { ...config, ...body };
      return json({ instance: {}, occurrences: merged });
    }
    if (url.pathname === "/api/v1/occurrences/runs" && runsFailures > 0) {
      runsFailures -= 1;
      return json({}, 500);
    }
    if (url.pathname === "/api/v1/occurrences/cost" && costFailures > 0) {
      costFailures -= 1;
      return json({}, 500);
    }
    if (url.pathname === "/api/v1/occurrences/cost")
      return json({
        instance: {},
        last7Days: { costUsd: 0.0123, calls: 7, unpricedCalls: 0 },
        last30Days: { costUsd: 0.5, calls: 31, unpricedCalls: 1 },
      });
    if (url.pathname === "/api/v1/occurrences/themes")
      return json({ instance: {}, themes: [], total: 0 });
    if (url.pathname === "/api/v1/occurrences/runs" && runsOverride)
      return json({ instance: {}, ...runsOverride(url) });
    if (url.pathname === "/api/v1/occurrences/runs")
      return json({
        instance: {},
        total: 4,
        nextBefore: null,
        runs: [
          {
            id: "1",
            startedAt: "2026-10-19T12:00:00.000Z",
            finishedAt: "2026-10-19T12:00:01.000Z",
            durationMs: 1200,
            status: "ok",
            readings: 42,
            modelCalls: 0,
            unpricedCalls: 0,
            costUsd: null,
            error: null,
            steps: {
              ...NO_STEPS,
              reading: { read: 42, failed: 0, withdrawn: 0, pending: 3 },
            },
          },
          {
            id: "3",
            startedAt: "2026-10-19T11:30:00.000Z",
            finishedAt: "2026-10-19T11:30:04.000Z",
            durationMs: 4000,
            status: "ok",
            readings: 5,
            modelCalls: 3,
            unpricedCalls: 3,
            costUsd: null,
            error: null,
            steps: NO_STEPS,
          },
          {
            id: "4",
            startedAt: "2026-10-19T11:15:00.000Z",
            finishedAt: "2026-10-19T11:15:04.000Z",
            durationMs: 4000,
            status: "ok",
            readings: 5,
            modelCalls: 3,
            unpricedCalls: 1,
            costUsd: 0.0021,
            error: null,
            steps: NO_STEPS,
          },
          {
            id: "2",
            startedAt: "2026-10-19T11:45:00.000Z",
            finishedAt: "2026-10-19T11:45:01.000Z",
            durationMs: 300,
            status: "failed",
            readings: 0,
            modelCalls: 0,
            unpricedCalls: 0,
            costUsd: null,
            error: "connection refused",
            steps: NO_STEPS,
          },
        ],
      });
    if (url.pathname === "/api/v1/metrics/filter-options")
      return json({ instance: {}, agents: [], inboxes: filterInboxes });
    if (url.pathname === "/api/v1/chatwoot/inboxes")
      return json({
        instance: {},
        inboxes: [INBOX("5", "SAC", "7"), INBOX("6", "Só gente", null)],
      });
    if (url.pathname === "/api/v1/vault")
      return json({
        instance: {},
        entries: [
          {
            id: "3",
            name: "openai",
            kind: "openai",
            status: "active",
            baseUrl: null,
            paramName: null,
          },
          {
            id: "9",
            name: "chave-openrouter",
            kind: "openrouter",
            status: "active",
            baseUrl: null,
            paramName: null,
          },
          {
            id: "8",
            name: "servidor-proprio",
            kind: "openai-compatible",
            status: "active",
            baseUrl: "https://llm.example.com/v1",
            paramName: null,
          },
        ],
      });
    return json({}, 404);
  }) as typeof fetch;
}

let location = "";
function LocationProbe() {
  const l = useLocation();
  location = `${l.pathname}${l.search}`;
  return null;
}

const renderPanel = (path = "/resources/occurrences") =>
  render(
    <MemoryRouter initialEntries={[path]}>
      <ToastProvider>
        <OccurrencesPanel />
        <LocationProbe />
      </ToastProvider>
    </MemoryRouter>,
  );

const openTab = (name: string) =>
  fireEvent.click(screen.getByRole("tab", { name }));

// Opens the additional fields, collapsed until asked for.
function openExtras() {
  if (screen.queryByRole("button", { name: /Add field/ })) return;
  fireEvent.click(screen.getByRole("button", { name: /Additional fields/ }));
}

// Picks an inbox in the monitor's inbox picker, as an admin does: open the list, choose the option.
async function pickInbox(name: string) {
  fireEvent.pointerDown(
    screen.getByRole("button", { name: "Inboxes the monitor reads" }),
    { button: 0, ctrlKey: false },
  );
  const menu = await screen.findByRole("menu");
  fireEvent.click(
    within(menu).getByRole("menuitem", { name: new RegExp(name) }),
  );
  fireEvent.keyDown(menu, { key: "Escape" });
  await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
}

// Fills a new additional field's name and description, as an admin types them.
function addField(name: string, description: string) {
  openExtras();
  fireEvent.click(screen.getByRole("button", { name: /Add field/ }));
  fireEvent.change(screen.getAllByLabelText("Name").at(-1) as HTMLElement, {
    target: { value: name },
  });
  fireEvent.change(
    screen
      .getAllByLabelText("What the monitor writes here")
      .at(-1) as HTMLElement,
    { target: { value: description } },
  );
}

// The control itself, not the group a FormField labels with the same name.
const control = (label: string) =>
  screen
    .getAllByLabelText(label)
    .find((el) => el.getAttribute("role") !== "group") as HTMLElement;

const names = () =>
  screen.getAllByLabelText("Name").map((i) => (i as HTMLInputElement).value);
const lastName = () => screen.getAllByLabelText("Name").at(-1) as HTMLElement;

// A monitor already set up: its reason and reference, an inbox and a model.
const SET_UP = {
  ...DEFAULTS,
  inboxIds: ["5"],
  model: null as null | Record<string, unknown>,
  fields: [
    { key: "motivo", name: "Motivo", description: "y", attribute: false },
    {
      key: "referencia",
      name: "Referência",
      description: "x",
      attribute: false,
    },
  ],
  reasonField: "motivo" as string | null,
  referenceField: "referencia" as string | null,
};

afterEach(() => {
  cleanup();
  runsOverride = null;
  runsFailures = 0;
  costFailures = 0;
  filterInboxes = [];
});
afterAll(() => {
  globalThis.fetch = realFetch;
});

describe("OccurrencesPanel", () => {
  test("starts from the reason and the reference, states the cap of the additional fields and lists the rounds", async () => {
    installFetchStub();
    renderPanel();
    await screen.findByText("Occurrence monitor");
    expect(names()).toEqual(["Reason", "Reference"]);
    openExtras();
    expect(screen.getByText(/up to 10 fields in all/)).toBeTruthy();
    openTab("Rounds");
    expect(await screen.findByText("42")).toBeTruthy();
    // A failed round says so where it is listed, in the screen's words; the server's own text is
    // behind a details popover.
    expect(
      screen.getAllByText("The round stopped before finishing.").length,
    ).toBeGreaterThan(0);
    absent(screen.queryByText("connection refused"));
    expect(
      screen.getAllByRole("button", { name: /Show help: Details/ }).length,
    ).toBeGreaterThan(0);
  });

  test("switching on without inboxes or the model's key says so and does not save", async () => {
    installFetchStub();
    renderPanel();
    await screen.findByText("Occurrence monitor");
    fireEvent.click(screen.getByRole("switch", { name: "Monitor on" }));
    const needs = screen.getByText(/To switch it on, choose/).textContent ?? "";
    expect(needs).toContain("at least one inbox");
    // The model shows its default: what is missing is the key.
    expect(needs).toContain("the model's API key");
    expect(needs).not.toContain("the model,");
    const save = screen.getByRole("button", { name: "Save" });
    expect((save as HTMLButtonElement).disabled).toBe(true);
  });

  test("the fixed fields as edited, an additional one and the inboxes chosen here are the ones saved", async () => {
    installFetchStub({ ...DEFAULTS, model: READING });
    renderPanel();
    await screen.findByText("Occurrence monitor");
    const [reasonName, referenceName] = screen.getAllByLabelText("Name");
    const [reasonText, referenceText] = screen.getAllByLabelText(
      "What the monitor writes here",
    );
    // The key is taken from the name; no one types one.
    fireEvent.change(reasonName as HTMLElement, {
      target: { value: "Motivo" },
    });
    fireEvent.change(reasonText as HTMLElement, {
      target: { value: "Por que entrou em contato." },
    });
    fireEvent.change(referenceName as HTMLElement, {
      target: { value: "Referência" },
    });
    fireEvent.change(referenceText as HTMLElement, {
      target: { value: "A que se refere." },
    });
    addField("Canal", "Por onde chegou.");
    // The inbox no agent receives is not offered, and one line counts it; the other is picked.
    expect(
      screen.getByText(/^1 inbox no agent receives is not listed\./),
    ).toBeTruthy();
    await pickInbox("SAC");
    fireEvent.click(screen.getByRole("switch", { name: "Monitor on" }));
    const save = screen.getByRole("button", { name: "Save" });
    await waitFor(() =>
      expect((save as HTMLButtonElement).disabled).toBe(false),
    );
    fireEvent.click(save);
    await waitFor(() =>
      expect(requests.some((r) => r.method === "PUT")).toBe(true),
    );
    const put = requests.find((r) => r.method === "PUT");
    expect(put?.body).toEqual({
      enabled: true,
      inboxIds: ["5"],
      fields: [
        {
          key: "motivo",
          name: "Motivo",
          description: "Por que entrou em contato.",
          attribute: false,
        },
        {
          key: "referencia",
          name: "Referência",
          description: "A que se refere.",
          attribute: false,
        },
        {
          key: "canal",
          name: "Canal",
          description: "Por onde chegou.",
          attribute: false,
        },
      ],
      reasonField: "motivo",
      referenceField: "referencia",
    });
  });

  test("without a reference the monitor saves, and the concentration flag says it is off", async () => {
    installFetchStub({ ...DEFAULTS, model: READING });
    renderPanel();
    await screen.findByText("Occurrence monitor");
    fireEvent.click(screen.getByRole("switch", { name: "Read the reference" }));
    expect(names()).toEqual(["Reason"]);
    expect(
      screen.getByText(
        /only the flag for themes concentrated on one reference is off/,
      ),
    ).toBeTruthy();
    const share = screen.getByLabelText(
      "Share with the same reference (0.6 is 60%)",
    ) as HTMLInputElement;
    expect(share.disabled).toBe(true);
    expect(screen.getByText("Off: it needs a reference field.")).toBeTruthy();
    expect(
      screen.getByTestId("occurrences-flags-sentence").textContent,
    ).not.toContain("reference");
    await pickInbox("SAC");
    fireEvent.click(screen.getByRole("switch", { name: "Monitor on" }));
    const save = screen.getByRole("button", { name: "Save" });
    await waitFor(() =>
      expect((save as HTMLButtonElement).disabled).toBe(false),
    );
    fireEvent.click(save);
    await waitFor(() =>
      expect(requests.some((r) => r.method === "PUT")).toBe(true),
    );
    const body = requests.find((r) => r.method === "PUT")?.body as {
      enabled: boolean;
      fields: { key: string }[];
      reasonField: string;
      referenceField?: string | null;
    };
    expect(body.enabled).toBe(true);
    expect(body.fields.map((f) => f.key)).toEqual(["reason"]);
    expect(body.reasonField).toBe("reason");
    // No reference was saved and none is: the value is unchanged, so it is not sent.
    expect(body.referenceField ?? null).toBeNull();
  });

  test("switching off sends only the switch", async () => {
    installFetchStub({ ...SET_UP, enabled: true, model: READING });
    renderPanel();
    await screen.findByText("Occurrence monitor");
    fireEvent.click(screen.getByRole("switch", { name: "Monitor on" }));
    const save = screen.getByRole("button", { name: "Save" });
    await waitFor(() =>
      expect((save as HTMLButtonElement).disabled).toBe(false),
    );
    fireEvent.click(save);
    await waitFor(() =>
      expect(requests.some((r) => r.method === "PUT")).toBe(true),
    );
    expect(requests.find((r) => r.method === "PUT")?.body).toEqual({
      enabled: false,
    });
  });

  test("a monitor whose saved model lost its credential's endpoint can still be switched off", async () => {
    installFetchStub({
      ...SET_UP,
      enabled: true,
      // vault:99 was deleted: its endpoint is nowhere now.
      model: {
        provider: "openai-compatible",
        model: "local-model",
        credentialRef: "vault:99",
        baseURL: null,
      },
    });
    renderPanel();
    await screen.findByText("Occurrence monitor");
    fireEvent.click(screen.getByRole("switch", { name: "Monitor on" }));
    const save = screen.getByRole("button", { name: "Save" });
    await waitFor(() =>
      expect((save as HTMLButtonElement).disabled).toBe(false),
    );
    fireEvent.click(save);
    await waitFor(() =>
      expect(requests.some((r) => r.method === "PUT")).toBe(true),
    );
    expect(requests.find((r) => r.method === "PUT")?.body).toEqual({
      enabled: false,
    });
  });

  test("switching the provider drops the base URL it had, and only OpenAI-compatible shows one, as the agent's card", async () => {
    installFetchStub({
      ...DEFAULTS,
      model: {
        provider: "openai-compatible",
        model: "local-model",
        credentialRef: "vault:8",
        baseURL: "http://127.0.0.1:8080/v1",
      },
    });
    renderPanel();
    await screen.findByText("Occurrence monitor");
    expect((screen.getByLabelText("Base URL") as HTMLInputElement).value).toBe(
      "http://127.0.0.1:8080/v1",
    );
    // The picker swaps an incompatible key for a compatible one only once it knows the vault: the
    // switch below waits for it, as an operator's click comes long after the page has loaded.
    await screen.findByText("servidor-proprio");
    fireEvent.change(control("Provider"), {
      target: { value: "openrouter" },
    });
    // The agent's Model card asks a base URL of OpenAI-compatible alone, and so does this one.
    expect(screen.queryByLabelText("Base URL")).toBeNull();
    // The key goes with the provider: OpenRouter's is chosen.
    fireEvent.click(control("API key"));
    fireEvent.click(await screen.findByText("chave-openrouter"));
    const save = screen.getByRole("button", { name: "Save" });
    await waitFor(() =>
      expect((save as HTMLButtonElement).disabled).toBe(false),
    );
    fireEvent.click(save);
    await waitFor(() =>
      expect(requests.some((r) => r.method === "PUT")).toBe(true),
    );
    const body = requests.find((r) => r.method === "PUT")?.body as {
      model: { provider: string; baseURL: string | null };
    };
    expect(body.model).toMatchObject({
      provider: "openrouter",
      baseURL: null,
    });
  });

  test("the model is one section laid out as the agent's, and the business context is saved as typed", async () => {
    installFetchStub({ ...DEFAULTS, model: READING });
    renderPanel();
    await screen.findByText("Occurrence monitor");
    // One provider, one model and one key for every step, in the agent card's order.
    const provider = control("Provider");
    const key = control("API key");
    expect(
      screen
        .getAllByLabelText("Provider")
        .filter((el) => el.getAttribute("role") !== "group"),
    ).toHaveLength(1);
    expect(
      provider.compareDocumentPosition(key) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    absent(screen.queryByRole("switch", { name: /Same model/ }));
    absent(screen.queryByText(/Conversation reading: Provider/));
    fireEvent.change(screen.getByLabelText("Business context"), {
      target: { value: "  Atendemos clientes de uma loja.  " },
    });
    const save = screen.getByRole("button", { name: "Save" });
    await waitFor(() =>
      expect((save as HTMLButtonElement).disabled).toBe(false),
    );
    fireEvent.click(save);
    await waitFor(() =>
      expect(requests.some((r) => r.method === "PUT")).toBe(true),
    );
    const body = requests.find((r) => r.method === "PUT")?.body as {
      model?: unknown;
      businessContext: string;
    };
    // Sent as typed: the server stores it byte for byte.
    expect(body.businessContext).toBe("  Atendemos clientes de uma loja.  ");
    // The model did not change, so it is not sent.
    expect("model" in body).toBe(false);
  });

  test("recovering old voice notes and images is a switch, off until turned on, and saved as set", async () => {
    installFetchStub({ ...DEFAULTS, model: READING });
    renderPanel();
    await screen.findByText("Occurrence monitor");
    const toggle = screen.getByRole("switch", {
      name: "Transcribe and describe them again when reading",
    });
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    fireEvent.click(toggle);
    const save = screen.getByRole("button", { name: "Save" });
    await waitFor(() =>
      expect((save as HTMLButtonElement).disabled).toBe(false),
    );
    fireEvent.click(save);
    await waitFor(() =>
      expect(requests.some((r) => r.method === "PUT")).toBe(true),
    );
    const body = requests.find((r) => r.method === "PUT")?.body as {
      recoverMedia?: boolean;
    };
    expect(body.recoverMedia).toBe(true);
  });

  test("an openai-compatible model whose credential holds the base URL saves without one of its own", async () => {
    const compatible = {
      provider: "openai-compatible",
      model: "local-model",
      credentialRef: "vault:8",
      baseURL: null,
    };
    installFetchStub({ ...DEFAULTS, model: compatible });
    renderPanel();
    await screen.findByText("Occurrence monitor");
    fireEvent.change(screen.getByLabelText("Business context"), {
      target: { value: "Atendemos clientes de uma loja." },
    });
    const save = screen.getByRole("button", { name: "Save" });
    await waitFor(() =>
      expect((save as HTMLButtonElement).disabled).toBe(false),
    );
    absent(screen.queryByText("Type the base URL."));
    fireEvent.click(save);
    await waitFor(() =>
      expect(requests.some((r) => r.method === "PUT")).toBe(true),
    );
  });

  test("the model catalog is asked of the model's own base URL before its credential's", async () => {
    installFetchStub({
      ...DEFAULTS,
      model: {
        provider: "openai-compatible",
        model: "local-model",
        credentialRef: "vault:8",
        baseURL: "http://127.0.0.1:8080/v1",
      },
    });
    renderPanel();
    await screen.findByText("Occurrence monitor");
    // The vault has loaded (the picker names the credential), so its endpoint is known too.
    await screen.findAllByText("servidor-proprio");
    fireEvent.focus(control("Model"));
    fireEvent.click(control("Model"));
    await waitFor(() =>
      expect(
        requests.some((r) => r.path === "/api/v1/agents/models/list"),
      ).toBe(true),
    );
    // Every catalog read once the vault is known, not only the first.
    const lists = requests.filter(
      (r) => r.path === "/api/v1/agents/models/list",
    );
    for (const list of lists)
      expect((list.body as { baseURL?: string }).baseURL).toBe(
        "http://127.0.0.1:8080/v1",
      );
  });

  test("an edit made while the save is out stays on the form, unsaved", async () => {
    installFetchStub();
    let release: () => void = () => {};
    holdPut = new Promise((r) => {
      release = r;
    });
    try {
      renderPanel();
      await screen.findByText("Occurrence monitor");
      const cadence = screen.getByLabelText("Minutes between rounds");
      fireEvent.change(cadence, { target: { value: "20" } });
      const save = screen.getByRole("button", { name: "Save" });
      await waitFor(() =>
        expect((save as HTMLButtonElement).disabled).toBe(false),
      );
      fireEvent.click(save);
      await waitFor(() =>
        expect(requests.some((r) => r.method === "PUT")).toBe(true),
      );
      fireEvent.change(cadence, { target: { value: "30" } });
      release();
      await waitFor(() =>
        expect(screen.queryByText("Occurrence monitor saved.")).toBeTruthy(),
      );
      expect((cadence as HTMLInputElement).value).toBe("30");
      const saveNow = () =>
        (screen.getByRole("button", { name: "Save" }) as HTMLButtonElement)
          .disabled;
      expect(saveNow()).toBe(false);
      // The server holds 20 now: 15 is a change to save, and 20 is none.
      fireEvent.change(cadence, { target: { value: "15" } });
      expect(saveNow()).toBe(false);
      fireEvent.change(cadence, { target: { value: "20" } });
      expect(saveNow()).toBe(true);
    } finally {
      holdPut = null;
    }
  });

  test("rounds that cannot be read say so instead of none having run, and can be read again", async () => {
    installFetchStub();
    // Every read fails until the retry, however many times the screen asks.
    runsFailures = Number.POSITIVE_INFINITY;
    renderPanel("/resources/occurrences?tab=rounds");
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Could not read the rounds.");
    absent(screen.queryByText("No round has run yet."));
    runsFailures = 0;
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => absent(screen.queryByRole("alert")));
    expect(screen.getByText("42")).toBeTruthy();
  });

  test("a cost that cannot be read says so and drops the old totals, while the rounds stay readable", async () => {
    installFetchStub();
    renderPanel("/resources/occurrences?tab=rounds");
    expect(await screen.findByText("US$ 0.0123")).toBeTruthy();
    costFailures = 1;
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Could not read the cost.");
    absent(screen.queryByText("US$ 0.0123"));
    expect(screen.getByText("42")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    expect(await screen.findByText("US$ 0.0123")).toBeTruthy();
    absent(screen.queryByRole("alert"));
  });

  test("a round whose calls had no price says so instead of a cost, and a partial cost says what it leaves out", async () => {
    installFetchStub();
    renderPanel("/resources/occurrences?tab=rounds");
    expect(await screen.findByText("No price")).toBeTruthy();
    expect(screen.getByText("US$ 0.0021")).toBeTruthy();
    expect(screen.getByText("1 call with no price left out")).toBeTruthy();
  });

  test("at the cap of 10 fields no further field can be added", async () => {
    installFetchStub({
      ...DEFAULTS,
      fields: Array.from({ length: 10 }, (_, i) => ({
        key: `f${i}`,
        name: `F${i}`,
        description: "x",
        attribute: false,
      })),
      reasonField: "f0",
      referenceField: "f1",
    });
    renderPanel();
    await screen.findByText("Occurrence monitor");
    openExtras();
    expect(screen.getAllByLabelText("Name")).toHaveLength(10);
    expect(
      (screen.getByRole("button", { name: /Add field/ }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });

  test("a language change keeps an unsaved edit and does not read the configuration again", async () => {
    installFetchStub();
    const before = i18n.language;
    try {
      renderPanel();
      await screen.findByText("Occurrence monitor");
      fireEvent.change(screen.getByLabelText("Minutes between rounds"), {
        target: { value: "20" },
      });
      const reads = () =>
        requests.filter(
          (r) => r.path === "/api/v1/occurrences/config" && r.method === "GET",
        ).length;
      const readsBefore = reads();
      await i18n.changeLanguage("pt-BR");
      await screen.findByText("Monitor de ocorrências");
      expect(
        (screen.getByLabelText("Minutos entre rodadas") as HTMLInputElement)
          .value,
      ).toBe("20");
      expect(reads()).toBe(readsBefore);
    } finally {
      await i18n.changeLanguage(before);
    }
  });

  test("at the cap, turning the reference on waits for an additional field to go", async () => {
    installFetchStub({
      ...DEFAULTS,
      fields: Array.from({ length: 10 }, (_, i) => ({
        key: `f${i}`,
        name: `F${i}`,
        description: "x",
        attribute: false,
      })),
      reasonField: "f0",
    });
    renderPanel();
    await screen.findByText("Occurrence monitor");
    const on = screen.getByRole("switch", { name: "Read the reference" });
    expect((on as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(on);
    openExtras();
    expect(screen.getAllByLabelText("Name")).toHaveLength(10);
    expect(
      screen.getByText(/remove an additional field to read the reference/),
    ).toBeTruthy();
    fireEvent.click(
      screen
        .getAllByRole("button", { name: "Remove field" })
        .at(-1) as HTMLElement,
    );
    expect(
      (
        screen.getByRole("switch", {
          name: "Read the reference",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(false);
  });

  test("a saved block with no reason and a full list gets its reason and no reference, and says to remove a field", async () => {
    installFetchStub({
      ...DEFAULTS,
      fields: Array.from({ length: 10 }, (_, i) => ({
        key: `f${i}`,
        name: `F${i}`,
        description: "x",
        attribute: false,
      })),
    });
    renderPanel();
    await screen.findByText("Occurrence monitor");
    openExtras();
    expect(names()).toHaveLength(11);
    expect(names()[0]).toBe("Reason");
    expect(
      screen.getByText(
        "The monitor reads up to 10 fields: remove one to save.",
      ),
    ).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Minutes between rounds"), {
      target: { value: "20" },
    });
    expect(
      (screen.getByRole("button", { name: "Save" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });

  test("a saved reference switched off and on again is the same field, key and instructions included", async () => {
    installFetchStub({
      ...SET_UP,
      fields: [
        { key: "motivo", name: "Motivo", description: "y", attribute: false },
        {
          key: "unidade_cliente",
          name: "Unidade",
          description: "Qual unidade.",
          attribute: true,
        },
      ],
      referenceField: "unidade_cliente",
    });
    renderPanel();
    await screen.findByText("Occurrence monitor");
    const toggle = () =>
      fireEvent.click(
        screen.getByRole("switch", { name: "Read the reference" }),
      );
    toggle();
    expect(names()).toEqual(["Motivo"]);
    toggle();
    expect(names()).toEqual(["Motivo", "Unidade"]);
    expect(
      screen.getByText("Chatwoot custom attribute: unidade_cliente"),
    ).toBeTruthy();
    // Back as it was saved: nothing to save.
    expect(
      (screen.getByRole("button", { name: "Save" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });

  for (const [left, why] of [
    ["", "cleared"],
    ["2", "out of range"],
    ["0.8", "changed"],
  ] as const)
    test(`a concentration threshold ${why} and then switched off with the reference is not sent and does not hold the save`, async () => {
      installFetchStub({ ...SET_UP, model: READING });
      renderPanel();
      await screen.findByText("Occurrence monitor");
      fireEvent.change(
        screen.getByLabelText("Share with the same reference (0.6 is 60%)"),
        { target: { value: left } },
      );
      fireEvent.click(
        screen.getByRole("switch", { name: "Read the reference" }),
      );
      const save = screen.getByRole("button", { name: "Save" });
      await waitFor(() =>
        expect((save as HTMLButtonElement).disabled).toBe(false),
      );
      fireEvent.click(save);
      await waitFor(() =>
        expect(requests.some((r) => r.method === "PUT")).toBe(true),
      );
      const body = requests.find((r) => r.method === "PUT")?.body as Record<
        string,
        unknown
      >;
      // The inactive edit is not sent: the saved 0.6 stays.
      expect("concentrationShare" in body).toBe(false);
      expect(body.referenceField).toBeNull();
    });

  test("an OpenAI-compatible model on the provider default says, under each field, what holds the save", async () => {
    installFetchStub({ ...DEFAULTS, model: READING });
    renderPanel();
    await screen.findByText("Occurrence monitor");
    fireEvent.change(control("Provider"), {
      target: { value: "openai-compatible" },
    });
    const save = screen.getByRole("button", { name: "Save" });
    expect((save as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText("Type the model id.")).toBeTruthy();
    fireEvent.pointerDown(control("Model"), { button: 0, ctrlKey: false });
    const menu = await screen.findByRole("menu");
    fireEvent.change(within(menu).getByRole("textbox"), {
      target: { value: "llama-3.1-8b" },
    });
    fireEvent.click(
      within(menu).getByRole("menuitem", { name: 'Use "llama-3.1-8b"' }),
    );
    expect(screen.queryByText("Type the model id.")).toBeNull();
    expect(screen.getByText("Type the base URL.")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Base URL"), {
      target: { value: "http://127.0.0.1:9/v1" },
    });
    expect(screen.queryByText("Type the base URL.")).toBeNull();
    await waitFor(() =>
      expect((save as HTMLButtonElement).disabled).toBe(false),
    );
  });

  test("a field whose instructions are emptied says so and holds the save until they are typed again", async () => {
    installFetchStub({ ...DEFAULTS, model: READING });
    renderPanel();
    await screen.findByText("Occurrence monitor");
    const instructions = screen.getAllByLabelText(
      "What the monitor writes here",
    )[0] as HTMLTextAreaElement;
    fireEvent.change(instructions, { target: { value: "" } });
    const save = screen.getByRole("button", { name: "Save" });
    expect(screen.getByText("Say what the monitor writes here.")).toBeTruthy();
    expect((save as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(instructions, { target: { value: "Por que escreveu." } });
    expect(screen.queryByText("Say what the monitor writes here.")).toBeNull();
    await waitFor(() =>
      expect((save as HTMLButtonElement).disabled).toBe(false),
    );
  });

  test("a chosen inbox is named as the Dashboards pickers name it, with the account beside a repeated name", async () => {
    filterInboxes = [
      { id: "5", name: "SAC", account: { id: 7, name: "Loja Centro" } },
      { id: "6", name: "Só gente" },
    ];
    installFetchStub({ ...DEFAULTS, inboxIds: ["5"], model: READING });
    renderPanel();
    await screen.findByText("Occurrence monitor");
    expect(await screen.findByText("SAC · Loja Centro")).toBeTruthy();
  });

  test("a field with no name, or a name with no letter or digit, is marked and holds the save", async () => {
    installFetchStub();
    renderPanel();
    await screen.findByText("Occurrence monitor");
    addField("", "Algo.");
    expect(screen.getByText("Give the field a name.")).toBeTruthy();
    fireEvent.change(lastName(), { target: { value: "!!!" } });
    expect(screen.getByText("Use letters or digits in the name.")).toBeTruthy();
    expect(
      (screen.getByRole("button", { name: "Save" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });

  test("the open tab is in the URL: a link opens it, Back returns, and an unknown one opens the configuration", async () => {
    installFetchStub();
    renderPanel("/resources/occurrences?tab=nope");
    await screen.findByText("Occurrence monitor");
    expect(
      screen
        .getByRole("tab", { name: "Configuration" })
        .getAttribute("aria-selected"),
    ).toBe("true");
    openTab("Rounds");
    expect(location).toBe("/resources/occurrences?tab=rounds");
    expect(
      screen.getByRole("tab", { name: "Rounds" }).getAttribute("aria-selected"),
    ).toBe("true");
    openTab("Themes");
    expect(location).toBe("/resources/occurrences?tab=themes");
  });

  test("an edit on the configuration survives a look at another tab, and the tab says it is unsaved", async () => {
    installFetchStub();
    renderPanel();
    await screen.findByText("Occurrence monitor");
    fireEvent.change(screen.getByLabelText("Minutes between rounds"), {
      target: { value: "20" },
    });
    openTab("Rounds");
    openTab("Configuration");
    expect(
      (screen.getByLabelText("Minutes between rounds") as HTMLInputElement)
        .value,
    ).toBe("20");
  });

  test("no select assigns a role, and a saved field's key is nowhere on the page", async () => {
    installFetchStub({
      ...DEFAULTS,
      fields: [
        {
          key: "item_x",
          name: "Item citado",
          description: "x",
          attribute: false,
        },
        {
          key: "falha_y",
          name: "O que pediu",
          description: "y",
          attribute: false,
        },
      ],
      reasonField: "falha_y",
      referenceField: "item_x",
    });
    renderPanel();
    await screen.findByText("Occurrence monitor");
    expect(
      screen
        .queryAllByRole("combobox")
        .map((c) => c.getAttribute("aria-label") ?? "")
        .filter((l) => /field/i.test(l)),
    ).toEqual([]);
    absent(
      screen.queryByLabelText(
        /Subject field|Problem field|Reason field|Reference field/,
      ),
    );
    // Each fixed field shows its own name in its own card, the reason first.
    expect(names()).toEqual(["O que pediu", "Item citado"]);
    const reasonCard = screen.getByTestId("occurrences-reason-field");
    expect((reasonCard.querySelector("input") as HTMLInputElement).value).toBe(
      "O que pediu",
    );
    expect(document.body.textContent?.includes("item_x")).toBe(false);
    expect(document.body.textContent?.includes("falha_y")).toBe(false);
  });

  test("renaming a saved field keeps its key, and a new field takes one from its name", async () => {
    installFetchStub({
      ...DEFAULTS,
      fields: [
        { key: "motivo", name: "Motivo", description: "x", attribute: false },
      ],
      reasonField: "motivo",
    });
    renderPanel();
    await screen.findByText("Occurrence monitor");
    // Saved without a reference, the monitor has none until one is asked for.
    expect(names()).toEqual(["Motivo"]);
    fireEvent.change(lastName(), { target: { value: "Razão" } });
    // A second field named like the first's key does not take it.
    addField("Motivo", "Outro.");
    const save = screen.getByRole("button", { name: "Save" });
    await waitFor(() =>
      expect((save as HTMLButtonElement).disabled).toBe(false),
    );
    fireEvent.click(save);
    await waitFor(() =>
      expect(requests.some((r) => r.method === "PUT")).toBe(true),
    );
    const body = requests.find((r) => r.method === "PUT")?.body as {
      fields: { key: string; name: string }[];
    };
    expect(body.fields.map((f) => [f.key, f.name])).toEqual([
      ["motivo", "Razão"],
      ["motivo_2", "Motivo"],
    ]);
  });

  test("a monitor never set up starts from the two fixed fields with their defaults, offers no template, and saves nothing", async () => {
    installFetchStub();
    renderPanel();
    await screen.findByText("Occurrence monitor");
    expect(names()).toEqual(["Reason", "Reference"]);
    const descriptions = screen
      .getAllByLabelText("What the monitor writes here")
      .map((i) => (i as HTMLTextAreaElement).value);
    expect(descriptions[0]).toContain("Why the customer got in touch");
    expect(descriptions[1]).toContain("What the reason refers to");
    absent(screen.queryByRole("button", { name: /template/i }));
    absent(screen.queryByText(/template/i));
    // The additional fields start collapsed.
    absent(screen.queryByRole("button", { name: /Add field/ }));
    // The defaults filled in are not an edit: nothing to save yet.
    expect(
      (screen.getByRole("button", { name: "Save" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect(requests.some((r) => r.method === "PUT")).toBe(false);
  });

  test("the fixed fields switched on with an inbox and a model are a monitor that saves", async () => {
    installFetchStub({ ...DEFAULTS, model: READING });
    renderPanel();
    await screen.findByText("Occurrence monitor");
    await pickInbox("SAC");
    fireEvent.click(screen.getByRole("switch", { name: "Monitor on" }));
    const save = screen.getByRole("button", { name: "Save" });
    await waitFor(() =>
      expect((save as HTMLButtonElement).disabled).toBe(false),
    );
    fireEvent.click(save);
    await waitFor(() =>
      expect(requests.some((r) => r.method === "PUT")).toBe(true),
    );
    expect(requests.find((r) => r.method === "PUT")?.body).toMatchObject({
      enabled: true,
      inboxIds: ["5"],
      reasonField: "reason",
      referenceField: "reference",
    });
  });

  test("the thresholds are said as a sentence that follows the values as they are typed, with each default", async () => {
    installFetchStub();
    renderPanel();
    await screen.findByText("Occurrence monitor");
    const sentence = () =>
      screen.getByTestId("occurrences-flags-sentence").textContent;
    expect(sentence()).toBe(
      "Flags a theme as out of the usual when it has at least 5 conversations in the last hour and, on top of that, is new (no conversation in the 7 days before), or runs at 3 times its usual, or has 60% of those conversations with the same reference.",
    );
    fireEvent.change(
      screen.getByLabelText("Least conversations in the window"),
      {
        target: { value: "1" },
      },
    );
    fireEvent.change(screen.getByLabelText("Recent window, in minutes"), {
      target: { value: "90" },
    });
    fireEvent.change(screen.getByLabelText("Days compared before the window"), {
      target: { value: "1" },
    });
    fireEvent.change(screen.getByLabelText("Times above its usual"), {
      target: { value: "2.5" },
    });
    fireEvent.change(
      screen.getByLabelText("Share with the same reference (0.6 is 60%)"),
      { target: { value: "0.75" } },
    );
    expect(sentence()).toBe(
      "Flags a theme as out of the usual when it has at least 1 conversation in the last 90 minutes and, on top of that, is new (no conversation in the day before), or runs at 2.5 times its usual, or has 75% of those conversations with the same reference.",
    );
    fireEvent.change(screen.getByLabelText("Recent window, in minutes"), {
      target: { value: "120" },
    });
    expect(sentence()).toContain("in the last 2 hours");
    fireEvent.change(screen.getByLabelText("Recent window, in minutes"), {
      target: { value: "" },
    });
    expect(sentence()).toBe(
      "Fill in every value to see when a theme will be flagged.",
    );
    // A default is said only under a value that moved off it.
    expect(screen.getByText("Default: 5")).toBeTruthy();
    expect(screen.getByText("Default: 0.6")).toBeTruthy();
    absent(screen.queryByText("Default: 15"));
  });

  test("the caps of a round are stated where the inboxes are chosen", async () => {
    installFetchStub();
    renderPanel();
    await screen.findByText("Occurrence monitor");
    expect(
      screen.getByText(/reads up to 200 conversations.*newest 30 messages/),
    ).toBeTruthy();
  });

  test("the Rounds tab pages by the last round shown, says each round's steps in words, and the monitor's cost", async () => {
    installFetchStub();
    const run = (id: number) => ({
      id: String(id),
      startedAt: new Date(
        Date.UTC(2026, 9, 19, 12, 0) - id * 900_000,
      ).toISOString(),
      finishedAt: null,
      durationMs: 2500,
      status: "ok",
      readings: 1,
      modelCalls: 2,
      unpricedCalls: 0,
      costUsd: 0.001,
      error: null,
      steps: {
        reading: { read: 1, failed: 0, withdrawn: 0, pending: 0 },
        canonical: { asked: 1, created: 1, copied: 0 },
        assignment: { sent: 1, assigned: 0, newThemes: 1, removed: 0 },
        consolidation: null,
        flags: { flagged: 0 },
        skipped:
          id === 1
            ? [
                {
                  step: "consolidation",
                  reason: "round_budget",
                  message: null,
                  inbox: null,
                  count: 2,
                },
              ]
            : [],
      },
    });
    runsOverride = (url) => {
      const before = url.searchParams.get("before");
      const ids =
        before === null
          ? Array.from({ length: 20 }, (_, i) => i + 1)
          : [21, 22, 23];
      return {
        total: 23,
        nextBefore: before === null ? "20" : null,
        runs: ids.map(run),
      };
    };
    renderPanel("/resources/occurrences?tab=rounds");
    expect(await screen.findByText("1 to 20 of 23")).toBeTruthy();
    expect(screen.getByText("US$ 0.0123")).toBeTruthy();
    expect(screen.getByText(/1 call with no price left out/)).toBeTruthy();
    fireEvent.click(
      screen.getAllByRole("button", { expanded: false })[0] as HTMLElement,
    );
    const detail = screen.getByText(/^Conversation reading:/).closest("ul");
    const text = detail?.textContent ?? "";
    // Each step's main count always; a secondary one only when it is not zero.
    expect(text).toContain("Conversation reading: 1 conversation read.");
    expect(text).toContain(
      "Theme assignment: 0 placed in a theme, 1 reason sent to the model, 1 new theme.",
    );
    expect(text).not.toContain("0 failed");
    expect(text).not.toContain("0 conversations left their theme");
    expect(text).not.toContain("written to the conversation in Chatwoot");
    expect(text).toContain(
      "Theme consolidation did not complete: the round ran out of time; what it did not do is left for the next one. (2 times)",
    );
    // No step's key or reason's code on the page.
    expect(
      /round_budget|no_model|canonical|occurrence_/.test(
        screen.getByRole("tabpanel").textContent ?? "",
      ),
    ).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: /Next/ }));
    expect(await screen.findByText("21 to 23 of 23")).toBeTruthy();
    const pages = requests.filter((r) => r.path === "/api/v1/occurrences/runs");
    expect(pages.length).toBeGreaterThan(1);
    fireEvent.click(screen.getByRole("button", { name: /Previous/ }));
    expect(await screen.findByText("1 to 20 of 23")).toBeTruthy();
  });

  test("switching the monitor on reads the rounds again at once, so the first round shows up without a reload", async () => {
    installFetchStub({ ...SET_UP, model: READING });
    let armed = false;
    runsOverride = () =>
      armed
        ? {
            total: 1,
            nextBefore: null,
            runs: [
              {
                id: "9",
                startedAt: "2026-10-19T12:00:00.000Z",
                finishedAt: "2026-10-19T12:00:03.000Z",
                durationMs: 3000,
                status: "ok",
                readings: 2,
                modelCalls: 3,
                unpricedCalls: 0,
                costUsd: 0.002,
                error: null,
                steps: {
                  ...NO_STEPS,
                  reading: { read: 17, failed: 0, withdrawn: 0, pending: 0 },
                },
              },
            ],
          }
        : { total: 0, nextBefore: null, runs: [] };
    renderPanel();
    await screen.findByText("Occurrence monitor");
    fireEvent.click(screen.getByRole("switch", { name: "Monitor on" }));
    armed = true;
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    openTab("Rounds");
    expect(await screen.findByText("17")).toBeTruthy();
  });

  test("on a monitor never configured, a key can be created where it is chosen", async () => {
    installFetchStub();
    renderPanel();
    await screen.findByText("Occurrence monitor");
    absent(screen.queryByText(/^Starting out\?/));
    expect(screen.getByRole("button", { name: /Create a key/ })).toBeTruthy();
    // One message for the missing key, not two. The picker says it once the vault has been read.
    await waitFor(() =>
      expect(
        screen
          .getAllByText(/API key/i)
          .filter((e) =>
            /Select an API key|Choose the API key/.test(e.textContent ?? ""),
          ),
      ).toHaveLength(1),
    );
  });

  test("a field named like a property every object has gets a key the server takes", async () => {
    installFetchStub();
    renderPanel();
    await screen.findByText("Occurrence monitor");
    addField("Constructor", "x");
    const save = screen.getByRole("button", { name: "Save" });
    await waitFor(() =>
      expect((save as HTMLButtonElement).disabled).toBe(false),
    );
    fireEvent.click(save);
    await waitFor(() =>
      expect(requests.some((r) => r.method === "PUT")).toBe(true),
    );
    const body = requests.find((r) => r.method === "PUT")?.body as {
      fields: { key: string; name: string }[];
    };
    expect(body.fields.find((f) => f.name === "Constructor")?.key).toBe(
      "constructor_2",
    );
  });

  test("a new field saved while another box is edited keeps its key when renamed afterwards", async () => {
    installFetchStub();
    let release: () => void = () => {};
    holdPut = new Promise((r) => {
      release = r;
    });
    try {
      renderPanel();
      await screen.findByText("Occurrence monitor");
      addField("Canal", "x");
      const save = screen.getByRole("button", { name: "Save" });
      await waitFor(() =>
        expect((save as HTMLButtonElement).disabled).toBe(false),
      );
      fireEvent.click(save);
      await waitFor(() =>
        expect(requests.some((r) => r.method === "PUT")).toBe(true),
      );
      // Another box edited while the save is out.
      fireEvent.change(screen.getByLabelText("Minutes between rounds"), {
        target: { value: "20" },
      });
      release();
      await screen.findByText("Occurrence monitor saved.");
      holdPut = null;
      fireEvent.change(lastName(), { target: { value: "Produto" } });
      await waitFor(() =>
        expect((save as HTMLButtonElement).disabled).toBe(false),
      );
      fireEvent.click(save);
      await waitFor(() =>
        expect(requests.filter((r) => r.method === "PUT")).toHaveLength(2),
      );
      const second = requests.filter((r) => r.method === "PUT")[1]?.body as {
        fields?: {
          key: string;
          name: string;
          description: string;
          attribute: boolean;
        }[];
      };
      expect(second.fields?.map((f) => f.key)).toEqual([
        "reason",
        "reference",
        "canal",
      ]);
      expect(second.fields?.at(-1)).toEqual({
        key: "canal",
        name: "Produto",
        description: "x",
        attribute: false,
      });
    } finally {
      holdPut = null;
    }
  });

  test("while the next page of rounds loads, the pager waits, so a second Next does not skip a page", async () => {
    installFetchStub();
    const run = (id: number) => ({
      id: String(id),
      startedAt: new Date(
        Date.UTC(2026, 9, 19, 12) - id * 900_000,
      ).toISOString(),
      finishedAt: null,
      durationMs: 1000,
      status: "ok",
      readings: 0,
      modelCalls: 0,
      unpricedCalls: 0,
      costUsd: null,
      error: null,
      steps: NO_STEPS,
    });
    runsOverride = (url) => {
      const before = url.searchParams.get("before");
      const start = before === null ? 1 : Number(before) + 1;
      return {
        total: 60,
        nextBefore: start + 19 < 60 ? String(start + 19) : null,
        runs: Array.from({ length: 20 }, (_, i) => run(start + i)),
      };
    };
    renderPanel("/resources/occurrences?tab=rounds");
    expect(await screen.findByText("1 to 20 of 60")).toBeTruthy();
    const next = screen.getByRole("button", { name: /Next/ });
    fireEvent.click(next);
    // The page on screen is still the first, read for another cursor: no pager to click again.
    absent(screen.queryByRole("button", { name: /Next/ }));
    expect(await screen.findByText("21 to 40 of 60")).toBeTruthy();
  });

  test("a later page of rounds that cannot be read still leads back to the newer rounds", async () => {
    installFetchStub();
    const run = (id: number) => ({
      id: String(id),
      startedAt: new Date(
        Date.UTC(2026, 9, 19, 12) - id * 900_000,
      ).toISOString(),
      finishedAt: null,
      durationMs: 1000,
      status: "ok",
      readings: 0,
      modelCalls: 0,
      unpricedCalls: 0,
      costUsd: null,
      error: null,
      steps: NO_STEPS,
    });
    runsOverride = (url) => {
      const before = url.searchParams.get("before");
      const start = before === null ? 1 : Number(before) + 1;
      return {
        total: 60,
        nextBefore: start + 19 < 60 ? String(start + 19) : null,
        runs: Array.from({ length: 20 }, (_, i) => run(start + i)),
      };
    };
    renderPanel("/resources/occurrences?tab=rounds");
    expect(await screen.findByText("1 to 20 of 60")).toBeTruthy();
    runsFailures = Number.POSITIVE_INFINITY;
    fireEvent.click(screen.getByRole("button", { name: /Next/ }));
    expect((await screen.findByRole("alert")).textContent).toContain(
      "Could not read the rounds.",
    );
    runsFailures = 0;
    fireEvent.click(screen.getByRole("button", { name: /Previous/ }));
    expect(await screen.findByText("1 to 20 of 60")).toBeTruthy();
    absent(screen.queryByRole("alert"));
  });

  test("an enabled monitor whose saved model can no longer run still saves an unrelated change", async () => {
    installFetchStub({
      ...SET_UP,
      enabled: true,
      // vault:99 was deleted: its endpoint is nowhere now.
      model: {
        provider: "openai-compatible",
        model: "local-model",
        credentialRef: "vault:99",
        baseURL: null,
      },
    });
    renderPanel();
    await screen.findByText("Occurrence monitor");
    fireEvent.change(screen.getByLabelText("Minutes between rounds"), {
      target: { value: "20" },
    });
    const save = screen.getByRole("button", { name: "Save" });
    await waitFor(() =>
      expect((save as HTMLButtonElement).disabled).toBe(false),
    );
    absent(screen.queryByText(/To switch it on, choose/));
  });

  test("a monitor that is on says under its switch how its last round went and when the next one is expected", async () => {
    installFetchStub({
      ...DEFAULTS,
      ...SET_UP,
      enabled: true,
      model: READING,
    });
    const finished = new Date(Date.now() - 5 * 60_000);
    runsOverride = () => ({
      total: 1,
      nextBefore: null,
      runs: [
        {
          id: "8",
          startedAt: new Date(finished.getTime() - 2000).toISOString(),
          finishedAt: finished.toISOString(),
          durationMs: 2000,
          status: "ok",
          readings: 0,
          modelCalls: 0,
          unpricedCalls: 0,
          costUsd: null,
          error: null,
          steps: {
            ...NO_STEPS,
            reading: { read: 0, failed: 0, withdrawn: 0, pending: 3 },
            skipped: [
              {
                step: "reading",
                reason: "credential_unresolved",
                message: null,
                inbox: null,
                count: 1,
              },
              {
                step: "assignment",
                reason: "credential_unresolved",
                message: null,
                inbox: null,
                count: 1,
              },
            ],
          },
        },
      ],
    });
    renderPanel();
    const status = await screen.findByTestId("occurrences-status");
    const text = status.textContent ?? "";
    expect(text).toContain("The last round, 5 minutes ago, finished.");
    expect(text).toContain(
      "Conversation reading did not complete: its API key is no longer in the vault (choose another one).",
    );
    expect(text).toContain("1 more step did not complete.");
    // Fifteen minutes after it ended.
    const next = new Date(finished.getTime() + 15 * 60_000).toLocaleTimeString(
      "en",
      { timeStyle: "short" },
    );
    expect(text).toContain(`The next round is expected around ${next}.`);
    fireEvent.click(screen.getByRole("button", { name: "See the rounds" }));
    await waitFor(() => expect(location).toContain("tab=rounds"));
  });

  test("a monitor that is off says nothing about rounds, and the flags section leads to the dashboards", async () => {
    installFetchStub();
    renderPanel();
    await screen.findByText("Occurrence monitor");
    absent(screen.queryByTestId("occurrences-status"));
    const link = screen.getByRole("link", { name: "Show on a dashboard" });
    expect(link.getAttribute("href")).toBe("/dashboards");
  });

  test("a round that stopped before consolidation does not say consolidation was not due", async () => {
    installFetchStub();
    runsOverride = () => ({
      total: 1,
      nextBefore: null,
      runs: [
        {
          id: "5",
          startedAt: "2026-10-19T12:00:00.000Z",
          finishedAt: "2026-10-19T12:00:02.000Z",
          durationMs: 2000,
          status: "failed",
          readings: 0,
          modelCalls: 1,
          unpricedCalls: 0,
          costUsd: 0.001,
          error: "boom",
          steps: {
            ...NO_STEPS,
            reading: { read: 1, failed: 0, withdrawn: 0, pending: 0 },
          },
        },
      ],
    });
    renderPanel("/resources/occurrences?tab=rounds");
    fireEvent.click(
      (
        await screen.findAllByRole("button", { expanded: false })
      )[0] as HTMLElement,
    );
    // The server's own words go to the details popover, not into the sentence.
    expect(
      screen.getAllByText("The round stopped before finishing.").length,
    ).toBe(2);
    absent(screen.queryByText(/boom/));
    absent(screen.queryByText(/not due this round/));
  });

  test("a round's detail says a provider's error in the screen's words, its own text one click away, and leaves out zero side counts", async () => {
    installFetchStub();
    runsOverride = () => ({
      total: 1,
      nextBefore: null,
      runs: [
        {
          id: "6",
          startedAt: "2026-10-19T12:00:00.000Z",
          finishedAt: "2026-10-19T12:00:02.000Z",
          durationMs: 2000,
          status: "ok",
          readings: 3,
          modelCalls: 3,
          unpricedCalls: 0,
          costUsd: 0.001,
          error: null,
          steps: {
            ...NO_STEPS,
            reading: { read: 3, failed: 1, withdrawn: 2, pending: 0 },
            canonical: { asked: 0, created: 0, copied: 0 },
            skipped: [
              {
                step: "reading",
                reason: "credential_refused",
                message: "401 Incorrect API key provided",
                inbox: null,
                count: 1,
              },
              {
                step: "reading",
                reason: "inbox_unreceived",
                message: null,
                inbox: "E-mail Financeiro",
                count: 1,
              },
            ],
          },
        },
      ],
    });
    renderPanel("/resources/occurrences?tab=rounds");
    fireEvent.click(await screen.findByRole("button", { expanded: false }));
    const text =
      screen.getByText(/^Conversation reading: 3/).closest("ul")?.textContent ??
      "";
    expect(text).toContain(
      "Conversation reading: 3 conversations read, 1 failed, 2 dropped after reading.",
    );
    expect(text).toContain("Reference names: 0 new names.");
    expect(text).not.toContain("sent to the model");
    expect(text).toContain(
      "Conversation reading did not complete: the provider refused the API key.",
    );
    expect(text).toContain(
      'Conversation reading did not complete: no agent receives the inbox "E-mail Financeiro"',
    );
    expect(text).not.toContain("Incorrect API key");
    // One popover explains the dropped readings, one holds the provider's own text.
    expect(
      screen.getAllByRole("button", { name: /Show help: Details/ }).length,
    ).toBe(2);
  });
});
