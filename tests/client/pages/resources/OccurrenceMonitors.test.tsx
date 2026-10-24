/// <reference lib="dom" />

import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  jest,
  spyOn,
  test,
} from "bun:test";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import {
  BrowserRouter,
  MemoryRouter,
  useLocation,
  useNavigate,
} from "react-router";
import { ToastProvider } from "@/client/components/Toast";
import { NavGuardProvider } from "@/client/contexts/NavGuardContext";
import { invalidateVault } from "@/client/lib/vaultCache";
import { OccurrencesPanel } from "@/client/pages/resources/OccurrencesPanel";

await import("@/client/lib/i18n");

// The account's monitors: the list says, for each one, whether it is on, what it reads and when it
// last ran; New and Rename take a name and keep a refusal in the form; Duplicate and Delete act from
// the list, Delete after a confirmation on the page that says what goes with it; opening one shows
// its three tabs, and an inbox another monitor also reads says so.

const realFetch = globalThis.fetch;
const requests: Array<{ method: string; path: string; body: unknown }> = [];

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const CONFIG = {
  enabled: false,
  inboxIds: [] as string[],
  fields: [
    { key: "motivo", name: "Motivo", description: "y", attribute: false },
  ],
  reasonField: "motivo",
  referenceField: null,
  cadenceMinutes: 15,
  consolidationMinutes: 60,
  newMinConversations: 5,
  windowMinutes: 60,
  previousDays: 7,
  aboveUsualRatio: 3,
  concentrationShare: 0.6,
  model: {
    provider: "openai",
    model: "gpt-5-mini",
    credentialRef: "vault:3",
    baseURL: null,
  },
  businessContext: "",
  recoverMedia: false,
};

type Monitor = {
  id: string;
  name: string;
  position: number;
  enabled: boolean;
  inboxIds: string[];
  lastRun: null | { startedAt: string; finishedAt: string; status: string };
  openThemes: number;
  runs: number;
};

const INBOX = (id: string, name: string) => ({
  id,
  chatwootInstanceId: "1",
  chatwootInboxId: Number(id),
  name,
  channelType: "Channel::Whatsapp",
  provider: null,
  agentId: "7",
  observerAgentIds: [],
  voiceAgentId: null,
});

let monitors: Monitor[] = [];
// When set, a GET of the list waits for the promise it returns, so a test decides which read lands
// last; `listAnswered` counts the reads that answered.
let listGate: (() => Promise<void> | null) | null = null;
let listAnswered = 0;
// Answers a write instead of the default, so a test can make the server refuse it.
let refuse:
  | ((method: string, path: string) => Response | Promise<Response> | null)
  | null = null;
// Holds the create until the test lets it answer.
let createGate: Promise<void> | null = null;

function installFetchStub() {
  requests.length = 0;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    const method = (
      input instanceof Request ? input.method : (init?.method ?? "GET")
    ).toUpperCase();
    const body =
      typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    const path = url.pathname;
    requests.push({ method, path, body });
    const refused = refuse?.(method, path);
    if (refused) return await refused;
    if (path === "/api/v1/occurrences/monitors" && method === "GET") {
      const snapshot = [...monitors];
      const gate = listGate?.();
      if (gate) await gate;
      listAnswered += 1;
      return json({ instance: {}, monitors: snapshot, max: 10 });
    }
    if (path === "/api/v1/occurrences/monitors" && method === "POST") {
      if (createGate) await createGate;
      const m: Monitor = {
        id: String(100 + monitors.length),
        name: body.name,
        position: monitors.length,
        enabled: false,
        inboxIds: [],
        lastRun: null,
        openThemes: 0,
        runs: 0,
      };
      monitors = [...monitors, m];
      return json({ instance: {}, monitor: m }, 201);
    }
    const one = /^\/api\/v1\/occurrences\/monitors\/(\d+)(\/.*)?$/.exec(path);
    if (one) {
      const [, id, rest = ""] = one;
      const m = monitors.find((x) => x.id === id);
      if (!m) return json({ error: "not found" }, 404);
      if (rest === "" && method === "PATCH") {
        m.name = body.name;
        return json({ instance: {}, monitor: m });
      }
      if (rest === "" && method === "DELETE") {
        monitors = monitors.filter((x) => x.id !== id);
        return json({
          instance: {},
          deleted: true,
          openThemes: m.openThemes,
          runs: m.runs,
        });
      }
      if (rest === "/duplicate" && method === "POST") {
        const copy: Monitor = {
          ...m,
          id: String(200 + monitors.length),
          name: `${m.name} (2)`,
          enabled: false,
          inboxIds: [],
          lastRun: null,
          openThemes: 0,
          runs: 0,
        };
        monitors = [...monitors, copy];
        return json({ instance: {}, monitor: copy }, 201);
      }
      if (rest === "/config" && method === "GET")
        return json({
          instance: {},
          occurrences: { ...CONFIG, enabled: m.enabled, inboxIds: m.inboxIds },
        });
      if (rest === "/config" && method === "PUT")
        return json({
          instance: {},
          occurrences: {
            ...CONFIG,
            enabled: m.enabled,
            inboxIds: m.inboxIds,
            ...body,
          },
        });
      if (rest === "/runs")
        return json({ instance: {}, runs: [], total: 0, nextBefore: null });
      if (rest === "/cost")
        return json({
          instance: {},
          last7Days: { costUsd: 0, calls: 0, unpricedCalls: 0 },
          last30Days: { costUsd: 0, calls: 0, unpricedCalls: 0 },
        });
      if (rest === "/themes")
        return json({ instance: {}, themes: [], total: 0 });
    }
    if (path === "/api/v1/metrics/filter-options")
      return json({ instance: {}, agents: [], inboxes: [] });
    if (path === "/api/v1/chatwoot/inboxes")
      return json({
        instance: {},
        inboxes: [
          INBOX("1", "Compras WhatsApp"),
          INBOX("3", "Produtores WhatsApp"),
        ],
      });
    if (path === "/api/v1/vault")
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
        ],
      });
    return json({}, 404);
  }) as typeof fetch;
}

let location = "";
// A link followed while the page is mounted.
let navigateTo: (to: string) => void = () => {};
function LocationProbe() {
  const l = useLocation();
  location = `${l.pathname}${l.search}`;
  navigateTo = useNavigate();
  return null;
}

const renderPanel = (path = "/resources/occurrences") =>
  render(
    <MemoryRouter initialEntries={[path]}>
      <NavGuardProvider>
        <ToastProvider>
          <OccurrencesPanel />
          <LocationProbe />
        </ToastProvider>
      </NavGuardProvider>
    </MemoryRouter>,
  );

const A: Monitor = {
  id: "1",
  name: "Compradores",
  position: 0,
  enabled: true,
  inboxIds: ["1"],
  lastRun: {
    startedAt: new Date(Date.now() - 5 * 60_000).toISOString(),
    finishedAt: new Date(Date.now() - 4 * 60_000).toISOString(),
    status: "ok",
  },
  openThemes: 4,
  runs: 6,
};
const B: Monitor = {
  id: "2",
  name: "Produtores",
  position: 1,
  enabled: false,
  inboxIds: [],
  lastRun: null,
  openThemes: 0,
  runs: 0,
};

const rowOf = (name: string) =>
  screen.getByText(name).closest("li") as HTMLElement;

// The page guard traps browser Back with a history sentinel kept at module level. A browser's
// history.back() always ends in a popstate; landing it at once keeps one test's leave from being
// taken for the next test's Back, and a cleanup another file left on the way is landed first.
let back: ReturnType<typeof spyOn>;
beforeEach(() => {
  back = spyOn(window.history, "back").mockImplementation(() => {
    window.dispatchEvent(new PopStateEvent("popstate"));
  });
  window.dispatchEvent(new PopStateEvent("popstate"));
});

afterEach(() => {
  back.mockRestore();
  cleanup();
  monitors = [];
  refuse = null;
  listGate = null;
  listAnswered = 0;
  createGate = null;
  // The vault list is cached per process: this file's stub must not answer another file's reads.
  invalidateVault();
});
afterAll(() => {
  globalThis.fetch = realFetch;
});

describe("occurrence monitors", () => {
  test("the list says for each monitor whether it is on, what it reads and when it last ran", async () => {
    monitors = [{ ...A }, { ...B }];
    installFetchStub();
    renderPanel();
    await screen.findByText("Compradores");
    const a = rowOf("Compradores");
    expect(within(a).getByText("on")).toBeTruthy();
    expect(a.textContent).toContain("Compras WhatsApp");
    expect(a.textContent).toContain("last round");
    const b = rowOf("Produtores");
    expect(within(b).getByText("off")).toBeTruthy();
    expect(b.textContent).toContain("no inboxes");
    expect(b.textContent).toContain("no round yet");
  });

  test("inboxes the account could not read are named by number, not called removed, and Retry reads them again", async () => {
    monitors = [{ ...A }];
    let down = true;
    refuse = (method, path) =>
      down && method === "GET" && path === "/api/v1/chatwoot/inboxes"
        ? new Response(JSON.stringify({ error: "chatwoot down" }), {
            status: 502,
            headers: { "Content-Type": "application/json" },
          })
        : null;
    installFetchStub();
    renderPanel();
    await screen.findByText("Compradores");
    const row = () => rowOf("Compradores").textContent ?? "";
    await waitFor(() => expect(row().includes("Inbox 1")).toBe(true));
    expect(row().includes("removed")).toBe(false);
    expect(
      (document.body.textContent ?? "").includes(
        "Could not read the account's inboxes",
      ),
    ).toBe(true);
    down = false;
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(row().includes("Compras WhatsApp")).toBe(true));
    expect(
      (document.body.textContent ?? "").includes(
        "Could not read the account's inboxes",
      ),
    ).toBe(false);
  });

  test("an inbox read that fails on a later refresh says so too, instead of keeping the older names", async () => {
    monitors = [{ ...A }];
    let down = false;
    refuse = (method, path) =>
      down && method === "GET" && path === "/api/v1/chatwoot/inboxes"
        ? new Response(JSON.stringify({ error: "chatwoot down" }), {
            status: 502,
            headers: { "Content-Type": "application/json" },
          })
        : null;
    installFetchStub();
    renderPanel();
    await screen.findByText("Compradores");
    await waitFor(() =>
      expect(
        (rowOf("Compradores").textContent ?? "").includes("Compras WhatsApp"),
      ).toBe(true),
    );
    down = true;
    fireEvent.click(
      within(rowOf("Compradores")).getByRole("button", { name: "Duplicate" }),
    );
    await waitFor(() =>
      expect(
        (document.body.textContent ?? "").includes(
          "Could not read the account's inboxes",
        ),
      ).toBe(true),
    );
    expect((rowOf("Compradores").textContent ?? "").includes("Inbox 1")).toBe(
      true,
    );
  });

  test("New takes a name and the new monitor joins the list", async () => {
    monitors = [{ ...A }];
    installFetchStub();
    renderPanel();
    await screen.findByText("Compradores");
    fireEvent.click(screen.getByRole("button", { name: /New monitor/ }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText("Name"), {
      target: { value: "Linha nova" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Create" }));
    await screen.findByText("Linha nova");
    expect(
      requests.some(
        (r) =>
          r.method === "POST" &&
          r.path === "/api/v1/occurrences/monitors" &&
          (r.body as { name: string }).name === "Linha nova",
      ),
    ).toBe(true);
  });

  test("Enter pressed again while the create is on the wire sends it once", async () => {
    monitors = [{ ...A }];
    let answer: () => void = () => {};
    createGate = new Promise((r) => {
      answer = r;
    });
    installFetchStub();
    renderPanel();
    await screen.findByText("Compradores");
    fireEvent.click(screen.getByRole("button", { name: /New monitor/ }));
    const dialog = await screen.findByRole("dialog");
    const input = within(dialog).getByLabelText("Name");
    fireEvent.change(input, { target: { value: "Linha nova" } });
    const posts = () =>
      requests.filter(
        (r) => r.method === "POST" && r.path === "/api/v1/occurrences/monitors",
      ).length;
    fireEvent.submit(input.closest("form") as HTMLFormElement);
    await waitFor(() => expect(posts()).toBe(1));
    fireEvent.submit(input.closest("form") as HTMLFormElement);
    fireEvent.submit(input.closest("form") as HTMLFormElement);
    answer();
    await waitFor(() =>
      expect(screen.queryAllByText("Linha nova").length > 0).toBe(true),
    );
    expect(posts()).toBe(1);
  });

  test("an 11th monitor refused by the server says why in the form and stays out of the list", async () => {
    monitors = [{ ...A }];
    refuse = (method, path) =>
      method === "POST" && path === "/api/v1/occurrences/monitors"
        ? json({ error: "An account has at most 10 monitors." }, 422)
        : null;
    installFetchStub();
    renderPanel();
    await screen.findByText("Compradores");
    fireEvent.click(screen.getByRole("button", { name: /New monitor/ }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText("Name"), {
      target: { value: "Mais um" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Create" }));
    expect(
      await within(dialog).findByText("An account has at most 10 monitors."),
    ).toBeTruthy();
    expect(screen.queryByRole("dialog")).toBeTruthy();
  });

  test("a refusal that lands after the name was changed stays off the changed name", async () => {
    monitors = [{ ...A }];
    let answer: () => void = () => {};
    const held = new Promise<void>((r) => {
      answer = r;
    });
    refuse = (method, path) =>
      method === "POST" && path === "/api/v1/occurrences/monitors"
        ? held.then(() =>
            json({ error: "A monitor named Compradores already exists." }, 409),
          )
        : null;
    installFetchStub();
    renderPanel();
    await screen.findByText("Compradores");
    fireEvent.click(screen.getByRole("button", { name: /New monitor/ }));
    const dialog = await screen.findByRole("dialog");
    const input = within(dialog).getByLabelText("Name");
    fireEvent.change(input, { target: { value: "Compradores" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Create" }));
    await waitFor(() =>
      expect(
        requests.some(
          (r) =>
            r.method === "POST" && r.path === "/api/v1/occurrences/monitors",
        ),
      ).toBe(true),
    );
    fireEvent.change(input, { target: { value: "Compradores 2" } });
    answer();
    await waitFor(() =>
      expect(
        within(dialog)
          .getByRole("button", { name: "Create" })
          .hasAttribute("disabled"),
      ).toBe(false),
    );
    await act(async () => {});
    expect((dialog.textContent ?? "").includes("already exists")).toBe(false);
  });

  test("Rename sends the new name and the list shows it", async () => {
    monitors = [{ ...A }, { ...B }];
    installFetchStub();
    renderPanel();
    await screen.findByText("Produtores");
    fireEvent.click(
      within(rowOf("Produtores")).getByRole("button", { name: "Rename" }),
    );
    const dialog = await screen.findByRole("dialog");
    const input = within(dialog).getByLabelText("Name") as HTMLInputElement;
    expect(input.value).toBe("Produtores");
    fireEvent.change(input, { target: { value: "Linha do produtor" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Rename" }));
    await screen.findByText("Linha do produtor");
    expect(
      requests.some(
        (r) =>
          r.method === "PATCH" && r.path === "/api/v1/occurrences/monitors/2",
      ),
    ).toBe(true);
  });

  test("Duplicate adds the copy, and a refused duplicate says why on the page", async () => {
    monitors = [{ ...A }];
    installFetchStub();
    renderPanel();
    await screen.findByText("Compradores");
    fireEvent.click(
      within(rowOf("Compradores")).getByRole("button", { name: "Duplicate" }),
    );
    await screen.findByText("Compradores (2)");
    refuse = (method, path) =>
      method === "POST" && path.endsWith("/duplicate")
        ? json({ error: "An account has at most 10 monitors." }, 422)
        : null;
    fireEvent.click(
      within(rowOf("Compradores")).getByRole("button", { name: "Duplicate" }),
    );
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("at most 10 monitors");
  });

  test("two quick duplicates both stay listed, whichever list read lands last", async () => {
    monitors = [{ ...A }];
    installFetchStub();
    renderPanel();
    await screen.findByText("Compradores");
    // The read after the first duplicate is held until the one after the second has landed.
    let release = () => {};
    const held = new Promise<void>((r) => {
      release = r;
    });
    const gates: (Promise<void> | null)[] = [held, null];
    listGate = () => gates.shift() ?? null;
    const dup = () =>
      fireEvent.click(
        within(rowOf("Compradores")).getByRole("button", { name: "Duplicate" }),
      );
    dup();
    await waitFor(() => expect(monitors.length).toBe(2));
    dup();
    await waitFor(() => expect(monitors.length).toBe(3));
    await waitFor(() =>
      expect(screen.getAllByText("Compradores (2)").length).toBe(2),
    );
    const before = listAnswered;
    release();
    await waitFor(() => expect(listAnswered).toBe(before + 1));
    expect(screen.getAllByText("Compradores (2)").length).toBe(2);
  });

  test("going back to the list with an unsaved edit asks first, and Keep editing keeps the edit", async () => {
    monitors = [{ ...A }, { ...B }];
    installFetchStub();
    renderPanel("/resources/occurrences?monitor=2");
    const ctx = await screen.findByLabelText("Business context");
    fireEvent.change(ctx, { target: { value: "rascunho" } });
    fireEvent.click(screen.getByRole("button", { name: /All monitors/ }));
    let dialog = await screen.findByRole("dialog");
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Keep editing" }),
    );
    await waitFor(() =>
      expect(screen.queryByText("Discard changes?") === null).toBe(true),
    );
    expect(
      (screen.getByLabelText("Business context") as HTMLTextAreaElement).value,
    ).toBe("rascunho");
    expect(location).toBe("/resources/occurrences?monitor=2");
    fireEvent.click(screen.getByRole("button", { name: /All monitors/ }));
    dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Discard" }));
    await screen.findByText("Compradores");
    expect(location).toBe("/resources/occurrences");
  });

  test("browser Back with an unsaved edit asks before leaving the monitor", async () => {
    monitors = [{ ...A }, { ...B }];
    installFetchStub();
    renderPanel("/resources/occurrences?monitor=2");
    const ctx = await screen.findByLabelText("Business context");
    fireEvent.change(ctx, { target: { value: "rascunho" } });
    // Back pops the guard's sentinel entry; the guard asks instead of letting the page go.
    await waitFor(() =>
      expect(
        (window.history.state as Record<string, unknown> | null)?.[
          "__unsavedBackGuard"
        ],
      ).toBe(true),
    );
    window.dispatchEvent(new PopStateEvent("popstate"));
    expect((await screen.findByText("Discard changes?")) !== null).toBe(true);
    expect(location).toBe("/resources/occurrences?monitor=2");
  });

  test("a tab change is no history entry: with an unsaved edit, browser Back asks and Discard leaves the monitor, even after tabs seen before the edit", async () => {
    monitors = [{ ...A }, { ...B }];
    installFetchStub();
    // The real browser history this time: Back pops entries, Discard traverses them.
    back.mockRestore();
    const happy = (globalThis as { happyDOM?: { setURL(u: string): void } })
      .happyDOM;
    happy?.setURL("http://localhost/resources/occurrences");
    window.history.replaceState(null, "");
    window.history.pushState({ idx: 1 }, "", "?monitor=2");
    render(
      <BrowserRouter>
        <NavGuardProvider>
          <ToastProvider>
            <OccurrencesPanel />
          </ToastProvider>
        </NavGuardProvider>
      </BrowserRouter>,
    );
    const selected = () =>
      document.querySelector('[role="tab"][aria-selected="true"]')
        ?.textContent ?? "";
    const ctx = await screen.findByLabelText("Business context");
    const entries = window.history.length;
    // Clean: the URL follows the tab in place.
    fireEvent.click(screen.getByRole("tab", { name: "Themes" }));
    await waitFor(() =>
      expect(window.location.search).toBe("?monitor=2&tab=themes"),
    );
    fireEvent.click(screen.getByRole("tab", { name: "Configuration" }));
    await waitFor(() =>
      expect(window.location.search).toBe("?monitor=2&tab=config"),
    );
    expect(window.history.length).toBe(entries);
    fireEvent.change(ctx, { target: { value: "rascunho" } });
    await waitFor(() =>
      expect(
        (window.history.state as Record<string, unknown> | null)?.[
          "__unsavedBackGuard"
        ],
      ).toBe(true),
    );
    fireEvent.click(screen.getByRole("tab", { name: "Rounds" }));
    expect(selected()).toBe("Rounds");
    window.history.back();
    expect((await screen.findByText("Discard changes?")) !== null).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Keep editing" }));
    await waitFor(() =>
      expect(screen.queryByText("Discard changes?") === null).toBe(true),
    );
    expect(selected()).toBe("Rounds");
    expect(
      (screen.getByLabelText("Business context") as HTMLTextAreaElement).value,
    ).toBe("rascunho");
    window.history.back();
    expect((await screen.findByText("Discard changes?")) !== null).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Discard" }));
    await waitFor(() => expect(window.location.search).toBe(""));
    await waitFor(() =>
      expect(screen.queryByLabelText("Business context") === null).toBe(true),
    );
    expect(screen.queryAllByText("Compradores").length > 0).toBe(true);
    // afterEach restores the spy it set; this test already did.
    back = spyOn(window.history, "back");
  });

  test("with an unsaved edit the URL keeps the tab it had, past the guard's wait for its sentinel", async () => {
    monitors = [{ ...A }, { ...B }];
    installFetchStub();
    renderPanel("/resources/occurrences?monitor=2&tab=config");
    const ctx = await screen.findByLabelText("Business context");
    fireEvent.change(ctx, { target: { value: "rascunho" } });
    await waitFor(() =>
      expect(
        (window.history.state as Record<string, unknown> | null)?.[
          "__unsavedBackGuard"
        ],
      ).toBe(true),
    );
    jest.useFakeTimers();
    try {
      fireEvent.click(screen.getByRole("tab", { name: "Rounds" }));
      jest.advanceTimersByTime(5_000);
    } finally {
      jest.useRealTimers();
    }
    await act(async () => {});
    expect(location).toBe("/resources/occurrences?monitor=2&tab=config");
  });

  test("a link to another tab of the open monitor opens it and the URL stays put", async () => {
    monitors = [{ ...A }, { ...B }];
    installFetchStub();
    renderPanel("/resources/occurrences?monitor=2&tab=config");
    await screen.findByLabelText("Business context");
    act(() => navigateTo("/resources/occurrences?monitor=2&tab=rounds"));
    const selected = () =>
      document.querySelector('[role="tab"][aria-selected="true"]')
        ?.textContent ?? "";
    await waitFor(() => expect(selected()).toBe("Rounds"));
    const seen = new Set<string>();
    for (let i = 0; i < 20; i++) {
      await act(async () => {});
      seen.add(location);
    }
    expect([...seen].join(" ")).toBe(
      "/resources/occurrences?monitor=2&tab=rounds",
    );
    expect(selected()).toBe("Rounds");
  });

  test("Discard from All monitors leaves no dead copy of the monitor behind: one Back opens it, the next one leaves it", async () => {
    monitors = [{ ...A }, { ...B }];
    installFetchStub();
    back.mockRestore();
    (globalThis as { happyDOM?: { setURL(u: string): void } }).happyDOM?.setURL(
      "http://localhost/resources/occurrences",
    );
    window.history.replaceState(null, "");
    window.history.pushState({ idx: 1 }, "", "?monitor=2");
    render(
      <BrowserRouter>
        <NavGuardProvider>
          <ToastProvider>
            <OccurrencesPanel />
          </ToastProvider>
        </NavGuardProvider>
      </BrowserRouter>,
    );
    const ctx = await screen.findByLabelText("Business context");
    fireEvent.change(ctx, { target: { value: "rascunho" } });
    await waitFor(() =>
      expect(
        (window.history.state as Record<string, unknown> | null)?.[
          "__unsavedBackGuard"
        ],
      ).toBe(true),
    );
    fireEvent.click(screen.getByRole("button", { name: /All monitors/ }));
    fireEvent.click(
      within(await screen.findByRole("dialog")).getByRole("button", {
        name: "Discard",
      }),
    );
    await waitFor(() => expect(window.location.search).toBe(""));
    await screen.findByText("Compradores");
    window.history.back();
    await waitFor(() => expect(window.location.search).toBe("?monitor=2"));
    await screen.findByLabelText("Business context");
    window.history.back();
    await waitFor(() => expect(window.location.search).toBe(""));
    back = spyOn(window.history, "back");
  });

  test("a monitor with nothing yet says so in the delete confirmation instead of zero counts", async () => {
    monitors = [{ ...B }];
    installFetchStub();
    renderPanel();
    await screen.findByText("Produtores");
    fireEvent.click(
      within(rowOf("Produtores")).getByRole("button", { name: "Delete" }),
    );
    const dialog = await screen.findByRole("dialog");
    expect(dialog.textContent).toContain("no themes or rounds yet");
    expect(dialog.textContent?.includes("0 open themes")).toBe(false);
  });

  test("Delete asks on the page with what goes with it; Cancel keeps the monitor, Delete removes it", async () => {
    monitors = [{ ...A }, { ...B }];
    installFetchStub();
    renderPanel();
    await screen.findByText("Compradores");
    const del = () =>
      fireEvent.click(
        within(rowOf("Compradores")).getByRole("button", { name: "Delete" }),
      );
    del();
    let dialog = await screen.findByRole("dialog");
    expect(dialog.textContent).toContain("4 open themes");
    expect(dialog.textContent).toContain("6 rounds");
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() =>
      expect(screen.queryByRole("dialog") === null).toBe(true),
    );
    expect(requests.some((r) => r.method === "DELETE")).toBe(false);
    expect(screen.getByText("Compradores")).toBeTruthy();
    del();
    dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));
    await waitFor(() =>
      expect(screen.queryByText("Compradores") === null).toBe(true),
    );
    expect(screen.getByText("Produtores")).toBeTruthy();
    expect(
      requests.some(
        (r) =>
          r.method === "DELETE" && r.path === "/api/v1/occurrences/monitors/1",
      ),
    ).toBe(true);
  });

  test("opening a monitor shows its tabs and reads its own configuration, and Back returns to the list", async () => {
    monitors = [{ ...A }, { ...B }];
    installFetchStub();
    renderPanel();
    fireEvent.click(await screen.findByText("Produtores"));
    await screen.findByRole("tab", { name: "Configuration" });
    expect(screen.getByRole("tab", { name: "Themes" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "Rounds" })).toBeTruthy();
    expect(location).toBe("/resources/occurrences?monitor=2");
    await waitFor(() =>
      expect(
        requests.some(
          (r) =>
            r.method === "GET" &&
            r.path === "/api/v1/occurrences/monitors/2/config",
        ),
      ).toBe(true),
    );
    fireEvent.click(screen.getByRole("button", { name: /All monitors/ }));
    await screen.findByText("Compradores");
    expect(location).toBe("/resources/occurrences");
  });

  test("an inbox another monitor also reads says which, and one only this monitor reads does not", async () => {
    monitors = [{ ...A }, { ...B, inboxIds: ["1", "3"] }];
    installFetchStub();
    renderPanel("/resources/occurrences?monitor=2");
    await screen.findByRole("tab", { name: "Configuration" });
    const shared = await screen.findByText("also read by Compradores");
    const chip = shared.closest("span")?.parentElement as HTMLElement;
    expect(chip.textContent).toContain("Compras WhatsApp");
    const other = screen
      .getAllByText("Produtores WhatsApp")
      .map((el) => el.parentElement?.textContent ?? "");
    expect(other.some((t) => t.includes("also read by"))).toBe(false);
  });

  test("a save the server refuses for another monitor's attribute names it on the page", async () => {
    monitors = [{ ...A }, { ...B, inboxIds: ["3"] }];
    refuse = (method, path) =>
      method === "PUT" && path === "/api/v1/occurrences/monitors/2/config"
        ? json(
            {
              error:
                "The monitor Compradores already writes the Chatwoot attribute evento on the inbox Compras WhatsApp.",
            },
            422,
          )
        : null;
    installFetchStub();
    renderPanel("/resources/occurrences?monitor=2");
    await screen.findByRole("tab", { name: "Configuration" });
    const ctx = await screen.findByLabelText("Business context");
    fireEvent.change(ctx, { target: { value: "algo" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Compradores");
  });
});
